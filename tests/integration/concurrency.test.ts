import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("critical context waits for an in-flight precompaction task", async () => {
  let resolveStarted!: () => void;
  let resolveResponse!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  const response: ResponseFactory = async () => {
    resolveStarted();
    await responseGate;
    return fauxAssistantMessage("critical checkpoint summary");
  };
  const scenario = createScenario(
    { softThresholdPercent: 60, taskTimeoutMs: 500 },
    response,
  );
  writeFileSync(
    join(scenario.cwd, ".pi", "settings.json"),
    JSON.stringify({
      compaction: {
        keepRecentTokens: 1,
        reserveTokens: 1,
        modelOverrides: {
          "test/model-id": { reserveTokens: 30_000 },
        },
      },
    }),
  );
  const criticalCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 70_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 70,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(criticalCtx);
    await started;

    let settled = false;
    const contextPromise = Promise.resolve(scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, criticalCtx)).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(settled, false);
    resolveResponse();
    const result = await contextPromise;
    assert.equal(result.messages[0]?.role, "compactionSummary");
    assert.equal(
      (result.messages[0] as { summary?: string }).summary,
      "critical checkpoint summary",
    );
    assert.equal(scenario.runtime.getDiagnostics().counters.critical_waited, 1);
  } finally {
    resolveResponse();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("context below the critical threshold does not wait for an in-flight task", async () => {
  let resolveStarted!: () => void;
  let resolveResponse!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  const response: ResponseFactory = async () => {
    resolveStarted();
    await responseGate;
    return fauxAssistantMessage("background checkpoint summary");
  };
  const scenario = createScenario(
    { softThresholdPercent: 60, taskTimeoutMs: 500 },
    response,
  );
  const belowCriticalCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 70_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 70,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(belowCriticalCtx);
    await started;
    const sourceMessages = scenario.manager.buildSessionContext().messages;

    const result = await scenario.runtime.onContext({
      type: "context",
      messages: sourceMessages,
    }, belowCriticalCtx);

    assert.equal(result.messages, sourceMessages);
    assert.equal(scenario.runtime.getDiagnostics().counters.critical_wait_started ?? 0, 0);
  } finally {
    resolveResponse();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("critical context falls back when the task reaches its own timeout", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const scenario = createScenario(
    { softThresholdPercent: 80, taskTimeoutMs: 20 },
    delayedResponse(120, resolveStarted),
  );
  const criticalCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 80_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 80,
    }),
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(criticalCtx);
    await started;
    const sourceMessages = scenario.manager.buildSessionContext().messages;

    const result = await scenario.runtime.onContext({
      type: "context",
      messages: sourceMessages,
    }, criticalCtx);

    assert.equal(result.messages, sourceMessages);
    assert.equal(scenario.appended.length, 0);
    await waitFor(() => Boolean(scenario.runtime.getDiagnostics().counters.task_timed_out));
    assert.equal(scenario.runtime.getDiagnostics().counters.task_timed_out, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 120));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("critical context starts emergency precompaction when no task exists", async () => {
  let resolveStarted!: () => void;
  let resolveResponse!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const responseGate = new Promise<void>((resolve) => {
    resolveResponse = resolve;
  });
  const response: ResponseFactory = async () => {
    resolveStarted();
    await responseGate;
    return fauxAssistantMessage("emergency checkpoint summary");
  };
  const scenario = createScenario(
    { softThresholdPercent: 90, taskTimeoutMs: 500 },
    response,
  );
  const criticalCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: 80_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 80,
    }),
  } as ExtensionContext;

  try {
    let settled = false;
    const contextPromise = Promise.resolve(scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, criticalCtx)).then((result) => {
      settled = true;
      return result;
    });
    const taskStarted = await Promise.race([
      started.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    assert.equal(taskStarted, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(settled, false);
    assert.equal(scenario.faux.state.callCount, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.critical_task_started, 1);

    resolveResponse();
    const result = await contextPromise;
    assert.equal(result.messages[0]?.role, "compactionSummary");
    assert.equal(
      (result.messages[0] as { summary?: string }).summary,
      "emergency checkpoint summary",
    );
    assert.equal(scenario.runtime.getDiagnostics().counters.critical_waited, 1);
  } finally {
    resolveResponse();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
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

test("context edit invalidates an in-flight task before it can append", async () => {
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

    scenario.manager.appendContextEdit(scenario.firstEntryId, { content: "edited history" });
    const sourceMessages = scenario.manager.buildSessionProjection().messages.filter(
      (message) => message.role !== "system",
    );
    const result = await scenario.runtime.onContext({
      type: "context",
      messages: sourceMessages,
    }, scenario.ctx);

    assert.equal(result.messages, sourceMessages);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const diagnostics = scenario.runtime.getDiagnostics();
    assert.equal(scenario.appended.length, 0);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(diagnostics.counters.task_discarded, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
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
