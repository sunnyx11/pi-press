import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "../../src/extension-runtime.js";
import { makeCheckpointData, makeModel, makePreparation, makeUserMessage } from "./fixtures.js";
import { waitFor, type Notification } from "../runtime-fixture.js";

test("checkpoint claim stays exclusive within one attempt and recovers for a newer attempt", async () => {
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

  const controller = new AbortController();
  const event = {
    type: "session_before_compact",
    preparation: makePreparation(firstId, 100),
    branchEntries: manager.getBranch(),
    reason: "threshold",
    willRetry: false,
    signal: controller.signal,
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
  assert.equal(await runtime.beforeCompact(event, ctx), undefined);

  const nextController = new AbortController();
  const nextEvent = {
    ...event,
    signal: nextController.signal,
  } satisfies SessionBeforeCompactEvent;
  const nextResult = await runtime.beforeCompact(nextEvent, ctx);
  assert.ok(nextResult?.compaction);
  assert.equal(await runtime.beforeCompact(nextEvent, ctx), undefined);

  controller.abort();
  assert.equal(await runtime.beforeCompact(nextEvent, ctx), undefined);
  nextController.abort();
  const highUsageCtx = {
    ...ctx,
    getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 90 }),
  } as ExtensionContext;
  runtime.onTurnEnd(highUsageCtx);
  assert.equal(runtime.getDiagnostics().counters.task_started ?? 0, 0);
});

test("context returns original messages and records a diagnostic when projection fails", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime-context-error");
  manager.appendMessage(makeUserMessage("current context"));
  const messages = manager.buildSessionContext().messages;
  const failingManager = new Proxy(manager, {
    get(target, property) {
      if (property === "getBranch") {
        return () => {
          throw new Error("branch unavailable");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const model = makeModel();
  const ctx = {
    cwd: "/tmp/pi-press-runtime-context-error",
    sessionManager: failingManager,
    model,
    modelRegistry: {},
    thinkingLevel: "medium",
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
  runtime.onSessionStart(ctx);

  const result = runtime.onContext({ type: "context", messages }, ctx);

  assert.equal(result.messages, messages);
  assert.equal(runtime.getDiagnostics().counters.virtual_failed, 1);
  assert.match(
    runtime.getDiagnostics().records.at(-1)?.message ?? "",
    /branch unavailable/,
  );
});

test("capacity-rejected ready checkpoint shows a fallback warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-runtime-reuse-capacity-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "pi-press.json"),
    JSON.stringify({ targetPostCompactionPercent: 0 }),
  );

  try {
    const manager = SessionManager.inMemory(cwd);
    const firstId = manager.appendMessage(makeUserMessage("old history"));
    const snapshotId = manager.appendMessage(makeUserMessage("recent work"));
    manager.appendCustomEntry(
      "pi-press.precompaction",
      makeCheckpointData(manager.getSessionId(), snapshotId, firstId),
    );
    const model = makeModel();
    const notifications: Notification[] = [];
    const ctx = {
      cwd,
      sessionManager: manager,
      model,
      modelRegistry: {},
      thinkingLevel: "medium",
      ui: {
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      },
    } as unknown as ExtensionContext;
    const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
    runtime.onSessionStart(ctx);

    const result = await runtime.beforeCompact({
      type: "session_before_compact",
      preparation: makePreparation(firstId, 100),
      branchEntries: manager.getBranch(),
      reason: "threshold",
      willRetry: false,
      signal: new AbortController().signal,
    }, ctx);

    assert.equal(result, undefined);
    assert.equal(runtime.getDiagnostics().counters.checkpoint_rejected_capacity, 1);
    assert.ok(
      notifications.some(
        (notification) =>
          notification.type === "warning" &&
          notification.message.includes("容量不足") &&
          notification.message.includes("Pi 原生压缩"),
      ),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

test("timed out authentication remains occupied across runtime instances until it settles", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-runtime-auth-timeout-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "pi-press.json"),
    JSON.stringify({ taskTimeoutMs: 20, summaryReserveTokens: 1 }),
  );

  try {
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage(makeUserMessage("history ".repeat(12_000)));
    manager.appendMessage(makeUserMessage("recent ".repeat(12_000)));
    const model = makeModel();
    const notifications: Notification[] = [];
    let authLookups = 0;
    let resolveAuth!: () => void;
    const auth = new Promise<{ ok: false; error: string }>((resolve) => {
      resolveAuth = () => resolve({ ok: false, error: "authentication unavailable" });
    });
    const ctx = {
      cwd,
      sessionManager: manager,
      model,
      modelRegistry: {
        getApiKeyAndHeaders: () => {
          authLookups += 1;
          return auth;
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
    const nextRuntime = new ExtensionRuntime({ appendEntry: () => undefined });
    runtime.onSessionStart(ctx);
    nextRuntime.onSessionStart(ctx);
    try {
      runtime.onTurnEnd(ctx);

      await waitFor(() => Boolean(runtime.getDiagnostics().counters.task_failed));

      assert.equal(runtime.getDiagnostics().counters.task_failed, 1);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0]?.message ?? "", /超时/);

      nextRuntime.onTurnEnd(ctx);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(nextRuntime.getDiagnostics().counters.task_started ?? 0, 0);
      assert.equal(authLookups, 1);

      resolveAuth();
      await new Promise((resolve) => setTimeout(resolve, 0));
      nextRuntime.onTurnEnd(ctx);
      await waitFor(() => authLookups === 2);
      assert.equal(nextRuntime.getDiagnostics().counters.task_started, 1);
    } finally {
      resolveAuth();
      runtime.onSessionShutdown();
      nextRuntime.onSessionShutdown();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("persisted refresh checkpoint prevents another refresh after restore", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime-refresh");
  const firstId = manager.appendMessage(makeUserMessage("old history"));
  const firstSnapshotId = manager.appendMessage(makeUserMessage("first snapshot"));
  manager.appendCustomEntry(
    "pi-press.precompaction",
    makeCheckpointData(manager.getSessionId(), firstSnapshotId, firstId, {
      checkpointId: "checkpoint-initial",
    }),
  );
  const refreshSnapshotId = manager.appendMessage(makeUserMessage("refresh snapshot"));
  manager.appendCustomEntry(
    "pi-press.precompaction",
    makeCheckpointData(manager.getSessionId(), refreshSnapshotId, firstId, {
      checkpointId: "checkpoint-refresh",
    }),
  );
  manager.appendMessage(makeUserMessage("trailing context ".repeat(15_000)));

  const model = makeModel();
  const ctx = {
    cwd: "/tmp/pi-press-runtime-refresh",
    sessionManager: manager,
    model,
    modelRegistry: {},
    thinkingLevel: "medium",
    getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 90 }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime({ appendEntry: () => undefined });
  runtime.onSessionStart(ctx);
  runtime.onTurnEnd(ctx);

  assert.equal(runtime.getDiagnostics().counters.task_started ?? 0, 0);
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

test("single oversized turn silently skips unavailable preparation", async () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-runtime-no-preparation");
  manager.appendMessage(makeUserMessage("x".repeat(100_000)));
  const model = makeModel();
  let authLookups = 0;
  const notifications: Notification[] = [];
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

  await waitFor(
    () => Boolean(runtime.getDiagnostics().counters.task_skipped_no_preparation),
  );

  const diagnostics = runtime.getDiagnostics();
  assert.equal(diagnostics.counters.task_skipped_no_preparation, 1);
  assert.equal(diagnostics.counters.task_failed ?? 0, 0);
  assert.equal(authLookups, 0);
  assert.deepEqual(notifications, []);
});

test("authentication failure is shown as a CLI error notification", async () => {
  const manager = SessionManager.inMemory(`/tmp/pi-press-runtime-failure-${process.pid}`);
  manager.appendMessage(makeUserMessage("history ".repeat(12_000)));
  manager.appendMessage(makeUserMessage("recent ".repeat(12_000)));
  const model = makeModel();
  const notifications: Notification[] = [];
  const ctx = {
    cwd: `/tmp/pi-press-runtime-failure-${process.pid}`,
    sessionManager: manager,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: false as const,
        error: "provider test 不可用，密钥 sk-review-secret",
      }),
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

  await waitFor(() => notifications.length > 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.match(notifications[0]?.message ?? "", /后台预压缩失败/);
  assert.doesNotMatch(
    JSON.stringify({ notifications, records: runtime.getDiagnostics().records }),
    /sk-review-secret/,
  );
  assert.equal(runtime.getDiagnostics().counters.task_failed, 1);
});
