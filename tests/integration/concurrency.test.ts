import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "../../src/extension-runtime.js";
import { makeUserMessage } from "../unit/fixtures.js";
import {
  createScenario,
  makeCompactEvent,
  waitFor,
  type ResponseFactory,
} from "../runtime-fixture.js";

function delayedResponse(
  delayMs: number,
  onStart?: () => void,
  activity?: { active: number; max: number },
): ResponseFactory {
  return async () => {
    onStart?.();
    if (activity) {
      activity.active += 1;
      activity.max = Math.max(activity.max, activity.active);
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return fauxAssistantMessage("checkpoint summary");
    } finally {
      if (activity) {
        activity.active -= 1;
      }
    }
  };
}

test("background task timeout reports an error notification", async () => {
  const scenario = createScenario(
    { taskTimeoutMs: 20 },
    delayedResponse(120),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const diagnostics = scenario.runtime.getDiagnostics();
    assert.equal(diagnostics.counters.task_failed, 1);
    assert.equal(diagnostics.counters.task_cancelled ?? 0, 0);
    assert.ok(
      scenario.notifications.some(
        (notification) => notification.type === "error" && notification.message.includes("超时"),
      ),
    );
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("timed out provider request prevents a second background request until it settles", async () => {
  const activity = { active: 0, max: 0 };
  const response = delayedResponse(120, undefined, activity);
  const scenario = createScenario({ taskTimeoutMs: 20 }, response);
  scenario.faux.setResponses([response, response]);
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    scenario.runtime.onTurnEnd(scenario.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(scenario.faux.state.callCount, 1);
    assert.equal(activity.max, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("hook waits for an in-flight checkpoint and reuses it", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const scenario = createScenario(
    { hookWaitTimeoutMs: 300 },
    delayedResponse(40, resolveStarted),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await started;

    const result = await scenario.runtime.beforeCompact(
      makeCompactEvent(scenario, new AbortController().signal),
      scenario.ctx,
    );

    assert.ok(result?.compaction);
    assert.equal(scenario.faux.state.callCount, 1);
    assert.equal(scenario.appended.length, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.checkpoint_reused, 1);
  } finally {
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("settled formalization waits for an in-flight refresh and consumes the newest checkpoint", async () => {
  let resolveRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const scenario = createScenario({ softThresholdPercent: 20 });
  scenario.faux.setResponses([
    async () => fauxAssistantMessage("initial checkpoint summary"),
    delayedResponse(40, resolveRefreshStarted),
  ]);
  const compactCalls: Array<{ onComplete?: (result: unknown) => void; onError?: (error: Error) => void }> = [];
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => {
      compactCalls.push(options ?? {});
    },
    getContextUsage: () => ({
      tokens: 10_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 10,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, scenario.ctx);
    for (let index = 0; index < 100; index += 1) {
      scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
    }
    scenario.runtime.onTurnEnd(ctx);
    await refreshStarted;

    scenario.runtime.onAgentSettled(ctx);
    await waitFor(() => compactCalls.length === 1);
    assert.equal(scenario.appended.length, 2);

    const event = {
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "manual" as const,
    };
    const reuse = await scenario.runtime.beforeCompact(event, ctx);
    assert.ok(reuse?.compaction);
    assert.equal(reuse.compaction.summary, "checkpoint summary");
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("overflow waits for an in-flight refresh and reuses only the newer checkpoint", async () => {
  let resolveRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const scenario = createScenario({ softThresholdPercent: 20 });
  scenario.faux.setResponses([
    async () => fauxAssistantMessage("initial checkpoint summary"),
    delayedResponse(40, resolveRefreshStarted),
  ]);
  const ctx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 10_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 10,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, scenario.ctx);
    for (let index = 0; index < 100; index += 1) {
      scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
    }
    scenario.runtime.onTurnEnd(ctx);
    await refreshStarted;

    const result = await scenario.runtime.beforeCompact({
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "overflow",
      willRetry: true,
    }, ctx);

    assert.ok(result?.compaction);
    assert.equal(result.compaction.summary, "checkpoint summary");
    assert.equal(scenario.appended.length, 2);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("overflow falls back to Pi after the refresh task reaches its remaining timeout", async () => {
  let resolveRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const scenario = createScenario({ softThresholdPercent: 20, taskTimeoutMs: 60 });
  scenario.faux.setResponses([
    async () => fauxAssistantMessage("initial checkpoint summary"),
    delayedResponse(150, resolveRefreshStarted),
  ]);
  const ctx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 10_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 10,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, scenario.ctx);
    for (let index = 0; index < 100; index += 1) {
      scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
    }
    scenario.runtime.onTurnEnd(ctx);
    await refreshStarted;

    const startedAt = Date.now();
    const result = await scenario.runtime.beforeCompact({
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "overflow",
      willRetry: true,
    }, ctx);

    assert.equal(result, undefined);
    assert.ok(Date.now() - startedAt >= 30);
    assert.equal(scenario.appended.length, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 160));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("context above the hard limit waits for an in-flight refresh checkpoint", async () => {
  let resolveRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const initialResponse: ResponseFactory = async () => fauxAssistantMessage("initial checkpoint summary");
  const scenario = createScenario({ hookWaitTimeoutMs: 300 });
  scenario.faux.setResponses([
    initialResponse,
    delayedResponse(40, resolveRefreshStarted),
  ]);
  const lowUsageCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 10_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 10,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    const initialContext = await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, scenario.ctx);
    assert.equal(initialContext.messages[0]?.role, "compactionSummary");

    for (let index = 0; index < 140; index += 1) {
      scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
    }
    scenario.runtime.onTurnEnd(lowUsageCtx);
    await refreshStarted;

    const refreshedContext = await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, lowUsageCtx);

    assert.equal(scenario.appended.length, 2);
    assert.equal(refreshedContext.messages[0]?.role, "compactionSummary");
    assert.equal(
      (refreshedContext.messages[0] as { summary?: string }).summary,
      "checkpoint summary",
    );
    assert.equal(scenario.runtime.getDiagnostics().counters.virtual_refresh_waited, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 60));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("context above the hard limit falls back after the refresh wait times out", async () => {
  let resolveRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    resolveRefreshStarted = resolve;
  });
  const initialResponse: ResponseFactory = async () => fauxAssistantMessage("initial checkpoint summary");
  const scenario = createScenario({ hookWaitTimeoutMs: 20 });
  scenario.faux.setResponses([
    initialResponse,
    delayedResponse(100, resolveRefreshStarted),
  ]);
  const lowUsageCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 10_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 10,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, scenario.ctx);

    for (let index = 0; index < 140; index += 1) {
      scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
    }
    scenario.runtime.onTurnEnd(lowUsageCtx);
    await refreshStarted;
    const sourceMessages = scenario.manager.buildSessionContext().messages;

    const contextResult = await scenario.runtime.onContext({
      type: "context",
      messages: sourceMessages,
    }, lowUsageCtx);

    assert.equal(contextResult.messages, sourceMessages);
    assert.equal(scenario.appended.length, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.virtual_refresh_wait_timed_out, 1);
    assert.ok(
      scenario.runtime.getDiagnostics().records.some(
        (record) => record.message.includes("等待后台刷新超时"),
      ),
    );

    await waitFor(() => scenario.appended.length === 2);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 120));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("hook timeout aborts the task before it can append a checkpoint", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const scenario = createScenario(
    { hookWaitTimeoutMs: 20 },
    delayedResponse(120, resolveStarted),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await started;

    const result = await scenario.runtime.beforeCompact(
      makeCompactEvent(scenario, new AbortController().signal),
      scenario.ctx,
    );
    assert.equal(result, undefined);

    await new Promise((resolve) => setTimeout(resolve, 180));
    const diagnostics = scenario.runtime.getDiagnostics();
    assert.equal(scenario.appended.length, 0);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(diagnostics.counters.task_discarded, 1);
    assert.ok(diagnostics.records.some((record) => record.message === "hook_timeout"));
    assert.ok(
      scenario.notifications.some(
        (notification) =>
          notification.type === "warning" &&
          notification.message.includes("等待预压缩结果超时") &&
          notification.message.includes("Pi 原生压缩"),
      ),
    );
  } finally {
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("hook signal cancellation aborts the task and returns native fallback", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const scenario = createScenario(
    { hookWaitTimeoutMs: 300 },
    delayedResponse(120, resolveStarted),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await started;
    const controller = new AbortController();
    const resultPromise = scenario.runtime.beforeCompact(
      makeCompactEvent(scenario, controller.signal),
      scenario.ctx,
    );
    setTimeout(() => controller.abort(), 10);

    const result = await resultPromise;
    assert.equal(result, undefined);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const diagnostics = scenario.runtime.getDiagnostics();
    assert.equal(scenario.appended.length, 0);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(diagnostics.counters.task_discarded, 1);
    assert.ok(diagnostics.records.some((record) => record.message === "hook_aborted"));
  } finally {
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("concurrent compact hooks allow only one waiter", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const scenario = createScenario(
    { hookWaitTimeoutMs: 300 },
    delayedResponse(40, resolveStarted),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await started;
    const firstHook = scenario.runtime.beforeCompact(
      makeCompactEvent(scenario, new AbortController().signal),
      scenario.ctx,
    );
    const secondResult = await scenario.runtime.beforeCompact(
      makeCompactEvent(scenario, new AbortController().signal),
      scenario.ctx,
    );
    const firstResult = await firstHook;

    assert.equal(secondResult, undefined);
    assert.ok(firstResult?.compaction);
    assert.equal(scenario.faux.state.callCount, 1);
  } finally {
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("reloaded module instances share one active background provider request", async () => {
  const firstModule = await import(
    new URL("../../src/extension-runtime.ts?reload=first", import.meta.url).href
  ) as { ExtensionRuntime: typeof ExtensionRuntime };
  const secondModule = await import(
    new URL("../../src/extension-runtime.ts?reload=second", import.meta.url).href
  ) as { ExtensionRuntime: typeof ExtensionRuntime };
  const activity = { active: 0, max: 0 };
  const response = delayedResponse(40, undefined, activity);
  const scenario = createScenario({}, response);
  scenario.faux.setResponses([response, response]);
  const appended: unknown[] = [];
  const createRuntime = (Runtime: typeof ExtensionRuntime): ExtensionRuntime => new Runtime({
    appendEntry: (customType, data) => {
      appended.push(data);
      scenario.manager.appendCustomEntry(customType, data);
    },
  });
  const firstRuntime = createRuntime(firstModule.ExtensionRuntime);
  const secondRuntime = createRuntime(secondModule.ExtensionRuntime);
  firstRuntime.onSessionStart(scenario.ctx);
  secondRuntime.onSessionStart(scenario.ctx);

  try {
    firstRuntime.onTurnEnd(scenario.ctx);
    secondRuntime.onTurnEnd(scenario.ctx);
    await waitFor(() => appended.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(scenario.faux.state.callCount, 1);
    assert.equal(activity.max, 1);
    assert.equal(firstRuntime.getDiagnostics().counters.task_started, 1);
    assert.equal(secondRuntime.getDiagnostics().counters.task_started ?? 0, 0);
    assert.equal(appended.length, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    firstRuntime.onSessionShutdown();
    secondRuntime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("runtime instances share one active background provider request", async () => {
  const activity = { active: 0, max: 0 };
  const response = delayedResponse(40, undefined, activity);
  const scenario = createScenario({}, response);
  scenario.faux.setResponses([response, response]);
  const secondAppended: unknown[] = [];
  const secondRuntime = new ExtensionRuntime({
    appendEntry: (customType, data) => {
      secondAppended.push(data);
      scenario.manager.appendCustomEntry(customType, data);
    },
  });
  secondRuntime.onSessionStart(scenario.ctx);

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    secondRuntime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length + secondAppended.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(scenario.faux.state.callCount, 1);
    assert.equal(activity.max, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.task_started, 1);
    assert.equal(secondRuntime.getDiagnostics().counters.task_started ?? 0, 0);
    assert.equal(scenario.appended.length + secondAppended.length, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    secondRuntime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("concurrent turn_end events issue only one background provider request", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const activity = { active: 0, max: 0 };
  const scenario = createScenario(
    {},
    delayedResponse(60, resolveStarted, activity),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    scenario.runtime.onTurnEnd(scenario.ctx);
    await started;
    await waitFor(() => scenario.appended.length === 1);

    assert.equal(scenario.faux.state.callCount, 1);
    assert.equal(activity.max, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.task_started, 1);
  } finally {
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("formal compaction invalidates an in-flight task before it can append", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const scenario = createScenario(
    {},
    delayedResponse(120, resolveStarted),
  );
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await started;

    scenario.manager.appendCompaction("native summary", scenario.firstEntryId, 90_000);
    const compactionEntry = scenario.manager.getLeafEntry();
    assert.ok(compactionEntry?.type === "compaction");
    scenario.runtime.onSessionCompact({
      type: "session_compact",
      compactionEntry,
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    } satisfies SessionCompactEvent, scenario.ctx);

    await new Promise((resolve) => setTimeout(resolve, 180));
    const diagnostics = scenario.runtime.getDiagnostics();
    assert.equal(scenario.appended.length, 0);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(diagnostics.counters.task_discarded, 1);
  } finally {
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});
