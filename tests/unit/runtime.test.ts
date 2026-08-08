import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "../../src/extension-runtime.js";
import { makeCheckpointData, makeModel, makePreparation, makeUserMessage } from "./fixtures.js";

test("ready checkpoint is reused without a second provider request", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime");
  const firstId = manager.appendMessage(makeUserMessage("old history"));
  const snapshotId = manager.appendMessage(makeUserMessage("recent work"));
  const data = makeCheckpointData(manager.getSessionId(), snapshotId, firstId, {
    checkpointId: "checkpoint-runtime",
  });
  manager.appendCustomEntry("pi-press.precompaction", data);

  const appended: unknown[] = [];
  const pi = {
    appendEntry: (_customType: string, value: unknown) => appended.push(value),
  } as Pick<ExtensionAPI, "appendEntry">;
  const model = makeModel();
  const ctx = {
    cwd: "/tmp/pi-press-runtime",
    sessionManager: manager,
    model,
    modelRegistry: {},
    thinkingLevel: "medium",
    getContextUsage: () => ({ tokens: 70_000, contextWindow: model.contextWindow, percent: 70 }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime(pi);
  runtime.onSessionStart(ctx);

  const event = {
    type: "session_before_compact",
    preparation: makePreparation(firstId, 100),
    branchEntries: manager.getBranch(),
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  } satisfies SessionBeforeCompactEvent;
  const result = await runtime.beforeCompact(event, ctx);

  assert.ok(result?.compaction);
  assert.equal(result.compaction.tokensBefore, 100);
  assert.equal(result.compaction.summary, data.compaction.summary);
  assert.equal(appended.length, 0);
  assert.deepEqual((result.compaction.details as Record<string, unknown>).readFiles, ["read.ts"]);
  assert.equal(
    ((result.compaction.details as Record<string, unknown>).piPress as Record<string, unknown>).checkpointId,
    "checkpoint-runtime",
  );
});

test("unsupported compaction reasons fall back to Pi", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime");
  manager.appendMessage(makeUserMessage("history"));
  const model = makeModel();
  const ctx = {
    cwd: "/tmp/pi-press-runtime",
    sessionManager: manager,
    model,
    modelRegistry: {},
    thinkingLevel: "medium",
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
  runtime.onSessionStart(ctx);
  const baseEvent = {
    type: "session_before_compact" as const,
    preparation: makePreparation(manager.getLeafId() ?? "entry", 100),
    branchEntries: manager.getBranch(),
    willRetry: false,
    signal: new AbortController().signal,
  };
  assert.equal(
    await runtime.beforeCompact({ ...baseEvent, reason: "overflow" }, ctx),
    undefined,
  );
  assert.equal(
    await runtime.beforeCompact({ ...baseEvent, reason: "threshold", customInstructions: "focus" }, ctx),
    undefined,
  );
});

test("unknown context usage does not schedule a task", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime");
  manager.appendMessage(makeUserMessage("history"));
  const model = makeModel();
  const ctx = {
    cwd: "/tmp/pi-press-runtime",
    sessionManager: manager,
    model,
    modelRegistry: {},
    thinkingLevel: "medium",
    getContextUsage: () => ({ tokens: null, contextWindow: model.contextWindow, percent: null }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
  runtime.onSessionStart(ctx);
  runtime.onTurnEnd(ctx);
  assert.equal(runtime.getDiagnostics().counters.threshold_skipped_unknown_usage, 1);
});

test("single oversized turn skips without provider lookup or error notification", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime-no-preparation");
  manager.appendMessage(makeUserMessage("x".repeat(100_000)));
  const model = makeModel();
  let authLookups = 0;
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
  const ctx = {
    cwd: "/tmp/pi-press-runtime-no-preparation",
    sessionManager: manager,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        authLookups += 1;
        return { ok: false as const, error: "provider lookup should be skipped" };
      },
      getProvider: () => undefined,
    },
    thinkingLevel: "medium",
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 90 }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
  runtime.onSessionStart(ctx);
  runtime.onTurnEnd(ctx);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.getDiagnostics().counters.task_skipped_no_preparation) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const diagnostics = runtime.getDiagnostics();
  assert.equal(diagnostics.counters.task_skipped_no_preparation, 1);
  assert.equal(diagnostics.counters.task_failed ?? 0, 0);
  assert.equal(authLookups, 0);
  assert.equal(notifications.length, 0);
});

test("background failure is shown as a CLI error notification", async () => {
  const manager = SessionManager.inMemory(`/tmp/pi-press-runtime-failure-${process.pid}`);
  manager.appendMessage(makeUserMessage("history ".repeat(12_000)));
  manager.appendMessage(makeUserMessage("recent ".repeat(12_000)));
  const model = makeModel();
  const notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }> = [];
  const ctx = {
    cwd: `/tmp/pi-press-runtime-failure-${process.pid}`,
    sessionManager: manager,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "provider test 不可用" }),
      getProvider: () => undefined,
    },
    thinkingLevel: "medium",
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
    getContextUsage: () => ({ tokens: 70_000, contextWindow: model.contextWindow, percent: 90 }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
  runtime.onSessionStart(ctx);
  runtime.onTurnEnd(ctx);

  for (let attempt = 0; attempt < 100 && notifications.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /后台预压缩失败/);
  assert.equal(runtime.getDiagnostics().counters.task_failed, 1);
});
