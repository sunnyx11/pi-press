import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "../../src/extension-runtime.js";
import {
  createPreparationSettings,
  prepareCompactionFromBranch,
} from "../../src/compaction/preparation.js";

test("threshold turn schedules compact once and hook reuses the checkpoint", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-integration-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "pi-press.json"),
    JSON.stringify({
      softThresholdPercent: 80,
      summaryReserveTokens: 1,
      taskTimeoutMs: 2_000,
      hookWaitTimeoutMs: 500,
    }),
  );

  try {
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({
      role: "user",
      content: "old history ".repeat(2_000),
      timestamp: Date.now(),
    });
    const firstKeptId = manager.appendMessage({
      role: "user",
      content: "recent context ".repeat(2_000),
      timestamp: Date.now(),
    });
    const faux = fauxProvider({
      api: "openai-responses",
      provider: "test",
      models: [{ id: "model-id", contextWindow: 100_000, maxTokens: 4_096 }],
    });
    faux.setResponses([fauxAssistantMessage("checkpoint summary")]);
    const model = faux.getModel();
    const registry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
      getProvider: () => faux.provider,
    };
    const appended: unknown[] = [];
    const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
    const pi = {
      appendEntry: (customType: string, data: unknown) => {
        appended.push(data);
        manager.appendCustomEntry(customType, data);
      },
    } as Pick<ExtensionAPI, "appendEntry">;
    const ctx = {
      cwd,
      sessionManager: manager,
      model,
      modelRegistry: registry,
      thinkingLevel: "medium",
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      },
      getContextUsage: () => ({ tokens: 70_000, contextWindow: model.contextWindow, percent: 90 }),
    } as unknown as ExtensionContext;
    const runtime = new ExtensionRuntime(pi);
    runtime.onSessionStart(ctx);

    const turnStart = performance.now();
    runtime.onTurnEnd(ctx);
    const turnElapsed = performance.now() - turnStart;
    assert.ok(turnElapsed < 100, `turn_end took ${turnElapsed}ms`);

    for (let attempt = 0; attempt < 100 && appended.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(appended.length, 1);
    assert.equal(faux.state.callCount, 1);
    assert.ok(
      notifications.some(
        (item) =>
          item.type === "info" &&
          item.message.includes("预压缩成功") &&
          item.message.includes("耗时") &&
          item.message.includes("预计压缩后约") &&
          item.message.includes("tokens"),
      ),
    );

    const preparation = prepareCompactionFromBranch(
      manager.getBranch(),
      createPreparationSettings({
        precomputeMode: "threshold",
        softThresholdPercent: 80,
        summaryReserveTokens: 1,
        taskTimeoutMs: 2_000,
        hookWaitTimeoutMs: 500,
        targetPostCompactionPercent: 50,
      }),
    );
    assert.ok(preparation);
    const event = {
      type: "session_before_compact",
      preparation,
      branchEntries: manager.getBranch(),
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    } satisfies SessionBeforeCompactEvent;
    const result = await runtime.beforeCompact(event, ctx);
    assert.ok(result?.compaction);
    assert.equal(faux.state.callCount, 1);
    assert.equal(result.compaction.firstKeptEntryId, firstKeptId);
    runtime.onSessionCompact({
      type: "session_compact",
      compactionEntry: {
        type: "compaction",
        id: "compaction-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: result.compaction.summary,
        firstKeptEntryId: result.compaction.firstKeptEntryId,
        tokensBefore: result.compaction.tokensBefore,
        ...(result.compaction.usage === undefined ? {} : { usage: result.compaction.usage }),
        ...(result.compaction.details === undefined ? {} : { details: result.compaction.details }),
      },
      fromExtension: true,
      reason: "threshold",
      willRetry: false,
    } satisfies SessionCompactEvent, ctx);
    assert.ok(notifications.some((item) => item.type === "info" && item.message.includes("压缩成功，已复用")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("capacity-rejected checkpoint is skipped without persistence or error notification", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-capacity-skip-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "pi-press.json"),
    JSON.stringify({
      softThresholdPercent: 80,
      summaryReserveTokens: 1,
      targetPostCompactionPercent: 0,
      taskTimeoutMs: 2_000,
    }),
  );

  try {
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({
      role: "user",
      content: "old history ".repeat(2_000),
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "user",
      content: "recent context ".repeat(2_000),
      timestamp: Date.now(),
    });
    const faux = fauxProvider({
      api: "openai-responses",
      provider: "test",
      models: [{ id: "model-id", contextWindow: 100_000, maxTokens: 4_096 }],
    });
    faux.setResponses([fauxAssistantMessage("checkpoint summary")]);
    const model = faux.getModel();
    const registry = {
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
      getProvider: () => faux.provider,
    };
    const appended: unknown[] = [];
    const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
    const pi = {
      appendEntry: (customType: string, data: unknown) => {
        appended.push(data);
        manager.appendCustomEntry(customType, data);
      },
    } as Pick<ExtensionAPI, "appendEntry">;
    const ctx = {
      cwd,
      sessionManager: manager,
      model,
      modelRegistry: registry,
      thinkingLevel: "medium",
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      },
      getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 90 }),
    } as unknown as ExtensionContext;
    const runtime = new ExtensionRuntime(pi);
    runtime.onSessionStart(ctx);
    runtime.onTurnEnd(ctx);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (runtime.getDiagnostics().counters.checkpoint_skipped_capacity) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const diagnostics = runtime.getDiagnostics();
    assert.equal(faux.state.callCount, 1);
    assert.equal(appended.length, 0);
    assert.equal(diagnostics.counters.checkpoint_skipped_capacity, 1);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(diagnostics.counters.task_failed ?? 0, 0);
    assert.equal(notifications.length, 0);
    assert.ok(diagnostics.records.some((record) => record.kind === "capacity"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
