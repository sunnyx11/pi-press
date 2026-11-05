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

test("raw context exceeding hard limit without checkpoint or usage stats enters foreground precompaction", async () => {
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
    return fauxAssistantMessage("raw overflow emergency summary");
  };
  const scenario = createScenario({ taskTimeoutMs: 500 }, response);
  // Grow raw branch messages past the 85% hard limit (79,520 tokens on 100k window)
  // while getContextUsage() is unknown.
  for (let index = 0; index < 60; index += 1) {
    scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
  }
  const unknownUsageCtx = {
    ...scenario.ctx,
    getContextUsage: () => ({
      tokens: null,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: null,
    }),
  } as ExtensionContext;

  try {
    const contextPromise = Promise.resolve(scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, unknownUsageCtx));

    const taskStarted = await Promise.race([
      started.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(taskStarted, true);
    assert.equal(scenario.runtime.getDiagnostics().counters.critical_task_started, 1);
    resolveResponse();

    const result = await contextPromise;
    assert.equal(result.messages[0]?.role, "compactionSummary");
    assert.equal(
      (result.messages[0] as { summary?: string }).summary,
      "raw overflow emergency summary",
    );
    assert.equal(scenario.runtime.getDiagnostics().counters.critical_waited, 1);
  } finally {
    resolveResponse();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("uncompactable oversized context sends when within contextWindow and aborts via ctx.abort only when exceeding contextWindow", async () => {
  // Part 1: 90,000 tokens (> hardLimit 79,520, <= contextWindow 100,000) sends without aborting.
  const withinWindow = createScenario({ taskTimeoutMs: 500 });
  withinWindow.manager.branch(withinWindow.firstEntryId);
  withinWindow.manager.appendContextEdit(withinWindow.firstEntryId, { content: "x".repeat(360_000) });
  let withinWindowAborted = 0;
  const withinWindowCtx = {
    ...withinWindow.ctx,
    abort: () => {
      withinWindowAborted += 1;
    },
    getContextUsage: () => undefined,
  } as ExtensionContext;

  // Part 2: 110,000 tokens (> contextWindow 100,000) aborts via ctx.abort.
  const overWindow = createScenario({ taskTimeoutMs: 500 });
  overWindow.manager.branch(overWindow.firstEntryId);
  overWindow.manager.appendContextEdit(overWindow.firstEntryId, { content: "x".repeat(440_000) });
  let overWindowAborted = 0;
  const overWindowCtx = {
    ...overWindow.ctx,
    abort: () => {
      overWindowAborted += 1;
    },
    getContextUsage: () => undefined,
  } as ExtensionContext;

  try {
    const withinWindowMessages = withinWindow.manager.buildSessionProjection().messages.filter(
      (message) => message.role !== "system",
    );
    const withinResult = await withinWindow.runtime.onContext({
      type: "context",
      messages: withinWindowMessages,
    }, withinWindowCtx);
    assert.equal(withinResult.messages, withinWindowMessages);
    assert.equal(withinWindowAborted, 0);
    assert.equal(withinWindow.runtime.getDiagnostics().counters.context_aborted_capacity ?? 0, 0);

    const overWindowMessages = overWindow.manager.buildSessionProjection().messages.filter(
      (message) => message.role !== "system",
    );
    const overResult = await overWindow.runtime.onContext({
      type: "context",
      messages: overWindowMessages,
    }, overWindowCtx);
    assert.equal(overResult.messages, overWindowMessages);
    assert.equal(overWindowAborted, 1);
    assert.equal(overWindow.runtime.getDiagnostics().counters.context_aborted_capacity, 1);
  } finally {
    withinWindow.runtime.onSessionShutdown();
    overWindow.runtime.onSessionShutdown();
    rmSync(withinWindow.cwd, { recursive: true, force: true });
    rmSync(overWindow.cwd, { recursive: true, force: true });
  }
});

test("context_with_system exceeding hard limit sends without aborting and records delta D so next context precompacts", async () => {
  const scenario = createScenario(
    { taskTimeoutMs: 500 },
    async () => fauxAssistantMessage("summary triggered by recorded delta D"),
  );
  let aborted = 0;
  const ctx = {
    ...scenario.ctx,
    abort: () => {
      aborted += 1;
    },
    getContextUsage: () => ({
      tokens: 40_500,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 40.5,
    }),
  } as ExtensionContext;

  try {
    const conversationMessages = scenario.manager.buildSessionContext().messages;
    const contextResult = await scenario.runtime.onContext({
      type: "context",
      messages: conversationMessages,
    }, ctx);
    assert.equal(contextResult.messages, conversationMessages);
    assert.equal(aborted, 0);

    // 45,000-token system prompt makes fullTokens = 40,500 + 45,000 = 85,500 > H (79,520).
    // Request 1 proceeds without aborting and records D = 45,000.
    const largeSystemMessage = {
      role: "system" as const,
      content: "S".repeat(180_000),
      timestamp: Date.now(),
    };
    const systemResult = await scenario.runtime.onContextWithSystem({
      type: "context_with_system",
      messages: [largeSystemMessage, ...contextResult.messages],
    }, ctx);
    assert.equal(systemResult, undefined);
    assert.equal(aborted, 0);
    assert.equal(scenario.runtime.getDiagnostics().counters.context_aborted_capacity ?? 0, 0);

    // Request 2 in the same session + model adds D (45,000) to E (40,500) -> 85,500 > H,
    // so onContext waits in foreground and returns the projected summary (~22,505 + 45,000 = 67,505 <= H).
    const nextResult = await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);
    assert.equal(aborted, 0);
    assert.equal(nextResult.messages[0]?.role, "compactionSummary");
    assert.equal(
      (nextResult.messages[0] as { summary?: string }).summary,
      "summary triggered by recorded delta D",
    );
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("critical context waits for external background slot to free before starting emergency task", async () => {
  let resolveFirstResponse!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    resolveFirstResponse = resolve;
  });
  let callCount = 0;
  const response: ResponseFactory = async () => {
    callCount += 1;
    if (callCount === 1) {
      await firstGate;
      return fauxAssistantMessage("first session background summary");
    }
    return fauxAssistantMessage("second session emergency summary");
  };
  const first = createScenario({ taskTimeoutMs: 500 }, response);
  const second = createScenario({ taskTimeoutMs: 500 }, response);

  try {
    first.runtime.onTurnEnd(first.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondCriticalCtx = {
      ...second.ctx,
      getContextUsage: () => ({
        tokens: 80_000,
        contextWindow: second.ctx.model!.contextWindow,
        percent: 80,
      }),
    } as ExtensionContext;

    const contextPromise = Promise.resolve(second.runtime.onContext({
      type: "context",
      messages: second.manager.buildSessionContext().messages,
    }, secondCriticalCtx));

    // Release the first session's background slot so the second session can start its emergency task.
    setTimeout(() => {
      resolveFirstResponse();
    }, 30);

    const result = await contextPromise;
    assert.equal(result.messages[0]?.role, "compactionSummary");
    assert.equal(
      (result.messages[0] as { summary?: string }).summary,
      "second session emergency summary",
    );
    assert.equal(second.runtime.getDiagnostics().counters.critical_task_started, 1);
  } finally {
    resolveFirstResponse();
    first.runtime.onSessionShutdown();
    second.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(first.cwd, { recursive: true, force: true });
    rmSync(second.cwd, { recursive: true, force: true });
  }
});

test("foreground wait updates TUI working message and status timer and cleans up on completion", async () => {
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
    return fauxAssistantMessage("foreground timer summary");
  };
  const scenario = createScenario({ taskTimeoutMs: 500 }, response);
  const workingMessages: Array<string | undefined> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const tuiCtx = {
    ...scenario.ctx,
    mode: "tui" as const,
    hasUI: true,
    ui: {
      ...scenario.ctx.ui,
      setWorkingMessage: (message?: string) => {
        workingMessages.push(message);
      },
      setStatus: (key: string, text: string | undefined) => {
        statuses.push({ key, text });
      },
    },
    getContextUsage: () => ({
      tokens: 80_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 80,
    }),
  } as unknown as ExtensionContext;

  try {
    const contextPromise = Promise.resolve(scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, tuiCtx));

    await Promise.race([
      started,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    assert.ok(
      workingMessages.some((msg) => typeof msg === "string" && msg.includes("pi-press 正在压缩 · 已等待")),
    );
    assert.ok(
      statuses.some(
        (entry) =>
          entry.key === "pi-press" &&
          typeof entry.text === "string" &&
          entry.text.includes("pi-press 正在压缩 · 已等待"),
      ),
    );

    resolveResponse();
    await contextPromise;

    assert.equal(workingMessages.at(-1), undefined);
    assert.equal(statuses.at(-1)?.text, undefined);
  } finally {
    resolveResponse();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("pressing Esc during foreground wait aborts current session compatible task but never aborts another session task", async () => {
  let resolveOwnStarted!: () => void;
  let resolveOwnResponse!: () => void;
  const ownStarted = new Promise<void>((resolve) => {
    resolveOwnStarted = resolve;
  });
  const ownGate = new Promise<void>((resolve) => {
    resolveOwnResponse = resolve;
  });
  const ownScenario = createScenario({ taskTimeoutMs: 500 }, async () => {
    resolveOwnStarted();
    await ownGate;
    return fauxAssistantMessage("own session summary");
  });
  const ownAbortController = new AbortController();
  const workingMessages: Array<string | undefined> = [];
  const ownCtx = {
    ...ownScenario.ctx,
    mode: "tui" as const,
    hasUI: true,
    signal: ownAbortController.signal,
    ui: {
      ...ownScenario.ctx.ui,
      setWorkingMessage: (message?: string) => {
        workingMessages.push(message);
      },
      setStatus: () => {},
    },
    getContextUsage: () => ({
      tokens: 80_000,
      contextWindow: ownScenario.ctx.model!.contextWindow,
      percent: 80,
    }),
  } as unknown as ExtensionContext;

  let resolveOtherResponse!: () => void;
  const otherGate = new Promise<void>((resolve) => {
    resolveOtherResponse = resolve;
  });
  const otherScenario = createScenario({ taskTimeoutMs: 500 }, async () => {
    await otherGate;
    return fauxAssistantMessage("other session summary");
  });
  const secondScenario = createScenario({ taskTimeoutMs: 500 });
  const secondAbortController = new AbortController();
  const secondCtx = {
    ...secondScenario.ctx,
    signal: secondAbortController.signal,
    getContextUsage: () => ({
      tokens: 80_000,
      contextWindow: secondScenario.ctx.model!.contextWindow,
      percent: 80,
    }),
  } as unknown as ExtensionContext;

  try {
    // Part 1: Esc on own session aborts own compatible task and cleans up UI.
    const ownContextPromise = Promise.resolve(ownScenario.runtime.onContext({
      type: "context",
      messages: ownScenario.manager.buildSessionContext().messages,
    }, ownCtx));
    await Promise.race([
      ownStarted,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    ownAbortController.abort();
    await ownContextPromise;
    assert.equal(ownScenario.runtime.getDiagnostics().counters.foreground_wait_aborted, 1);
    assert.equal(ownScenario.runtime.getDiagnostics().counters.task_discarded, 1);
    assert.equal(workingMessages.at(-1), undefined);
    resolveOwnResponse();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ownScenario.appended.length, 0);

    // Part 2: Esc while waiting for another session's background slot exits wait without aborting the other session's task.
    otherScenario.runtime.onTurnEnd(otherScenario.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondContextPromise = Promise.resolve(secondScenario.runtime.onContext({
      type: "context",
      messages: secondScenario.manager.buildSessionContext().messages,
    }, secondCtx));
    await new Promise((resolve) => setTimeout(resolve, 20));
    secondAbortController.abort();
    await secondContextPromise;
    assert.equal(secondScenario.runtime.getDiagnostics().counters.foreground_wait_aborted, 1);
    assert.equal(otherScenario.runtime.getDiagnostics().counters.task_discarded ?? 0, 0);

    resolveOtherResponse();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(otherScenario.appended.length, 1);
  } finally {
    resolveOwnResponse();
    resolveOtherResponse();
    ownScenario.runtime.onSessionShutdown();
    otherScenario.runtime.onSessionShutdown();
    secondScenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(ownScenario.cwd, { recursive: true, force: true });
    rmSync(otherScenario.cwd, { recursive: true, force: true });
    rmSync(secondScenario.cwd, { recursive: true, force: true });
  }
});

test("retained giant tool result sends compressed projection when within contextWindow and aborts only when exceeding contextWindow", async () => {
  // Part 1: 85,000-token tool result ("G".repeat(340_000)) -> compressed ~86k (> H 79,520, <= W 100,000) sends compressed projection.
  const withinWindow = createScenario({ taskTimeoutMs: 500 });
  withinWindow.faux.setResponses([
    () => fauxAssistantMessage("history summary before 85k tool result"),
    () => fauxAssistantMessage("turn prefix summary before 85k tool result"),
  ]);
  withinWindow.manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-giant-85k",
        name: "read",
        arguments: { path: "giant-85k.txt" },
      },
    ],
    api: "openai-responses",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  withinWindow.manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-giant-85k",
    toolName: "read",
    content: [{ type: "text", text: "G".repeat(340_000) }],
    isError: false,
    timestamp: Date.now(),
  });

  let withinAborted = 0;
  const withinCtx = {
    ...withinWindow.ctx,
    abort: () => {
      withinAborted += 1;
    },
  } as unknown as ExtensionContext;

  // Part 2: 110,000-token tool result ("G".repeat(440_000)) -> compressed ~111k (> W 100,000) aborts via ctx.abort.
  const overWindow = createScenario({ taskTimeoutMs: 500 });
  overWindow.faux.setResponses([
    () => fauxAssistantMessage("history summary before 110k tool result"),
    () => fauxAssistantMessage("turn prefix summary before 110k tool result"),
  ]);
  overWindow.manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-giant-110k",
        name: "read",
        arguments: { path: "giant-110k.txt" },
      },
    ],
    api: "openai-responses",
    provider: "faux",
    model: "faux-1",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  overWindow.manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-giant-110k",
    toolName: "read",
    content: [{ type: "text", text: "G".repeat(440_000) }],
    isError: false,
    timestamp: Date.now(),
  });

  let overAborted = 0;
  const overCtx = {
    ...overWindow.ctx,
    abort: () => {
      overAborted += 1;
    },
  } as unknown as ExtensionContext;

  try {
    const withinResult = await withinWindow.runtime.onContext({
      type: "context",
      messages: withinWindow.manager.buildSessionContext().messages,
    }, withinCtx);
    assert.equal(withinAborted, 0);
    assert.equal(withinResult.messages[0]?.role, "compactionSummary");
    assert.equal(withinWindow.runtime.getDiagnostics().counters.context_aborted_capacity ?? 0, 0);

    await overWindow.runtime.onContext({
      type: "context",
      messages: overWindow.manager.buildSessionContext().messages,
    }, overCtx);
    assert.equal(overAborted, 1);
    assert.equal(overWindow.runtime.getDiagnostics().counters.context_aborted_capacity, 1);
  } finally {
    withinWindow.runtime.onSessionShutdown();
    overWindow.runtime.onSessionShutdown();
    rmSync(withinWindow.cwd, { recursive: true, force: true });
    rmSync(overWindow.cwd, { recursive: true, force: true });
  }
});

test("foreground compaction loops for a second round when in-flight checkpoint at earlier leaf still exceeds hard limit", async () => {
  let resolveFirstStarted!: () => void;
  let resolveFirstGate!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    resolveFirstGate = resolve;
  });
  let callIndex = 0;
  const scenario = createScenario({ taskTimeoutMs: 500 }, async () => {
    callIndex += 1;
    if (callIndex === 1) {
      resolveFirstStarted();
      await firstGate;
      return fauxAssistantMessage("round 1 checkpoint at earlier leaf");
    }
    return fauxAssistantMessage("round 2 checkpoint at latest leaf");
  });
  scenario.faux.setResponses([
    async () => {
      callIndex += 1;
      resolveFirstStarted();
      await firstGate;
      return fauxAssistantMessage("round 1 checkpoint at earlier leaf");
    },
    async () => {
      callIndex += 1;
      return fauxAssistantMessage("round 2 checkpoint at latest leaf");
    },
  ]);

  try {
    // Start task 1 at the initial branch leaf.
    scenario.runtime.onTurnEnd(scenario.ctx);
    await firstStarted;

    // Append 65k tokens of new turns after task 1's snapshot leaf, plus a small final turn,
    // so that after task 1 finishes, its projection (~22.5k + 65k = 87.5k > H 79,520) still exceeds H,
    // while compacting again at the new leaf brings it well below H (~1k <= H).
    scenario.manager.appendMessage(makeUserMessage("M".repeat(260_000)));
    scenario.manager.appendMessage(makeUserMessage("final short turn"));

    let aborted = 0;
    const ctx = {
      ...scenario.ctx,
      abort: () => {
        aborted += 1;
      },
    } as unknown as ExtensionContext;

    const contextPromise = Promise.resolve(scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx));

    resolveFirstGate();
    const result = await contextPromise;

    assert.equal(aborted, 0);
    assert.equal(scenario.appended.length, 2);
    assert.equal(result.messages[0]?.role, "compactionSummary");
    assert.equal(
      (result.messages[0] as { summary?: string }).summary,
      "round 2 checkpoint at latest leaf",
    );
  } finally {
    resolveFirstGate();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("foreground compaction retries up to 3 times on task failure before falling back by contextWindow rule", async () => {
  let attempts = 0;
  const scenario = createScenario({ taskTimeoutMs: 500 });
  scenario.faux.setResponses([
    async () => {
      attempts += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "auth failure 1" });
    },
    async () => {
      attempts += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "auth failure 2" });
    },
    async () => {
      attempts += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "auth failure 3" });
    },
    async () => {
      attempts += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "auth failure 4" });
    },
    async () => {
      attempts += 1;
      return fauxAssistantMessage("should not reach 5th attempt");
    },
  ]);

  let aborted = 0;
  const criticalWithinWindowCtx = {
    ...scenario.ctx,
    abort: () => {
      aborted += 1;
    },
    getContextUsage: () => ({
      tokens: 85_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 85,
    }),
  } as unknown as ExtensionContext;

  try {
    const sourceMessages = scenario.manager.buildSessionContext().messages;
    const result = await scenario.runtime.onContext({
      type: "context",
      messages: sourceMessages,
    }, criticalWithinWindowCtx);

    // 1 initial attempt + 3 retries = 4 total attempts, then falls back to sending because 85,000 <= W (100,000).
    assert.equal(attempts, 4);
    assert.equal(aborted, 0);
    assert.equal(result.messages, sourceMessages);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("model window overflow aborts when the hard limit is unavailable", async () => {
  const scenario = createScenario({ taskTimeoutMs: 100 });
  writeFileSync(
    join(scenario.cwd, ".pi", "settings.json"),
    JSON.stringify({
      compaction: {
        keepRecentTokens: 10_000,
        reserveTokens: 100_000,
      },
    }),
  );
  scenario.manager.appendContextEdit(scenario.firstEntryId, { content: "x".repeat(500_000) });
  let aborted = 0;
  const ctx = {
    ...scenario.ctx,
    abort: () => {
      aborted += 1;
    },
    getContextUsage: () => undefined,
  } as unknown as ExtensionContext;

  try {
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionProjection().messages.filter(
        (message) => message.role !== "system",
      ),
    }, ctx);
    assert.equal(aborted, 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("foreground compaction retries provider stream rejections", async () => {
  const scenario = createScenario({ taskTimeoutMs: 500 });
  const originalProvider = scenario.faux.provider;
  let attempts = 0;
  const streamSimple = ((...args: Parameters<typeof originalProvider.streamSimple>) => {
    attempts += 1;
    if (attempts <= 4) {
      return Promise.reject(new Error(`transient provider failure ${attempts}`));
    }
    return originalProvider.streamSimple(...args);
  }) as unknown as typeof originalProvider.streamSimple;
  const provider = { ...originalProvider, streamSimple };
  const ctx = {
    ...scenario.ctx,
    modelRegistry: {
      ...scenario.ctx.modelRegistry,
      getProvider: () => provider,
    },
    abort: () => undefined,
    getContextUsage: () => ({
      tokens: 85_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 85,
    }),
  } as unknown as ExtensionContext;

  try {
    const sourceMessages = scenario.manager.buildSessionContext().messages;
    const result = await scenario.runtime.onContext({
      type: "context",
      messages: sourceMessages,
    }, ctx);
    assert.equal(attempts, 4);
    assert.equal(result.messages, sourceMessages);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("external rejected background operations do not create unhandled rejections while foreground waits", async () => {
  const first = createScenario({ taskTimeoutMs: 500 });
  const second = createScenario({ taskTimeoutMs: 500 });
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const originalProvider = first.faux.provider;
  const rejectingStreamSimple = ((..._args: Parameters<typeof originalProvider.streamSimple>) =>
    firstGate.then(() => {
      throw new Error("external provider failure");
    })) as unknown as typeof originalProvider.streamSimple;
  const rejectingProvider = { ...originalProvider, streamSimple: rejectingStreamSimple };
  const firstCtx = {
    ...first.ctx,
    modelRegistry: {
      ...first.ctx.modelRegistry,
      getProvider: () => rejectingProvider,
    },
  } as unknown as ExtensionContext;
  const secondCtx = {
    ...second.ctx,
    getContextUsage: () => ({
      tokens: 90_000,
      contextWindow: second.ctx.model!.contextWindow,
      percent: 90,
    }),
  } as unknown as ExtensionContext;
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    first.runtime.onTurnEnd(firstCtx);
    await waitFor(() => first.runtime.getDiagnostics().counters.summary_request_started === 1);
    const contextPromise = second.runtime.onContext({
      type: "context",
      messages: second.manager.buildSessionContext().messages,
    }, secondCtx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst?.();
    await contextPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
  } finally {
    releaseFirst?.();
    process.off("unhandledRejection", onUnhandledRejection);
    first.runtime.onSessionShutdown();
    second.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(first.cwd, { recursive: true, force: true });
    rmSync(second.cwd, { recursive: true, force: true });
  }
});

test("foreground projection records the context evaluation used by the next system transcript", async () => {
  const systemPrompt = "S".repeat(200_000);
  const scenario = createScenario({ taskTimeoutMs: 500 });
  const initialCtx = {
    ...scenario.ctx,
    getSystemPrompt: () => systemPrompt,
    getContextUsage: () => ({
      tokens: 90_000,
      contextWindow: scenario.ctx.model!.contextWindow,
      percent: 90,
    }),
  } as unknown as ExtensionContext;

  try {
    const initial = await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, initialCtx);
    const systemMessage = {
      role: "system" as const,
      content: systemPrompt,
      timestamp: Date.now(),
    };
    await scenario.runtime.onContextWithSystem({
      type: "context_with_system",
      messages: [systemMessage, ...initial.messages],
    }, initialCtx);
    const hardLimitSkipsBeforeNextContext =
      scenario.runtime.getDiagnostics().counters.virtual_skipped_hard_limit ?? 0;

    const next = await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, {
      ...initialCtx,
      getContextUsage: () => ({
        tokens: 10_000,
        contextWindow: scenario.ctx.model!.contextWindow,
        percent: 10,
      }),
    } as unknown as ExtensionContext);

    assert.equal(
      scenario.runtime.getDiagnostics().counters.virtual_skipped_hard_limit ?? 0,
      hardLimitSkipsBeforeNextContext,
    );
    assert.ok(next.messages.length > 0);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});
