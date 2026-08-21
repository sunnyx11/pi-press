import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { parseCheckpointData } from "../../src/checkpoint/schema.js";
import { makeUserMessage } from "../unit/fixtures.js";
import {
  createScenario,
  makeCompactEvent,
  waitFor,
  type ResponseFactory,
} from "../runtime-fixture.js";

function getDeferredFormalization(runtime: ReturnType<typeof createScenario>["runtime"]): unknown {
  return (runtime as unknown as { deferredFormalization?: unknown }).deferredFormalization;
}

function setPiCompactionKeepRecentTokens(
  scenario: ReturnType<typeof createScenario>,
  keepRecentTokens: number,
): void {
  writeFileSync(
    `${scenario.cwd}/.pi/settings.json`,
    JSON.stringify({ compaction: { keepRecentTokens } }),
  );
}

async function createDeferredFormalizationScenario(): Promise<{
  scenario: ReturnType<typeof createScenario>;
  ctx: ExtensionContext;
}> {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  setPiCompactionKeepRecentTokens(scenario, 50_000);
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: () => {
      assert.fail("deferred formalization must not call compact");
    },
  } as ExtensionContext;
  scenario.runtime.onTurnEnd(ctx);
  await waitFor(() => scenario.appended.length === 1);
  await scenario.runtime.onContext({
    type: "context",
    messages: scenario.manager.buildSessionContext().messages,
  }, ctx);
  scenario.runtime.onAgentSettled(ctx);
  await waitFor(() => Boolean(getDeferredFormalization(scenario.runtime)));
  return { scenario, ctx };
}

test("threshold turn schedules compact once and hook reuses the checkpoint", async () => {
  const scenario = createScenario({
    softThresholdPercent: 80,
    summaryReserveTokens: 1,
    taskTimeoutMs: 2_000,
    hookWaitTimeoutMs: 500,
  });
  const {
    appendState,
    appended,
    ctx,
    cwd,
    faux,
    notifications,
    recentEntryId,
    runtime,
  } = scenario;

  try {
    const turnStart = performance.now();
    runtime.onTurnEnd(ctx);
    const turnElapsed = performance.now() - turnStart;
    assert.ok(turnElapsed < 100, `turn_end took ${turnElapsed}ms`);

    await waitFor(() => appended.length === 1);
    assert.equal(appended.length, 1);
    assert.equal(appendState.notificationCount, 0);
    assert.equal(faux.state.callCount, 1);
    assert.ok(
      notifications.some(
        (item) =>
          item.type === "info" &&
          /^pi-press：预压缩成功，耗时 \d+\.\d 秒。$/.test(item.message),
      ),
    );

    const event = makeCompactEvent(scenario, new AbortController().signal);
    const result = await runtime.beforeCompact(event, ctx);
    assert.ok(result?.compaction);
    assert.equal(faux.state.callCount, 1);
    assert.equal(result.compaction.firstKeptEntryId, recentEntryId);
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

test("context applies a ready checkpoint and settled formalization runs after the handler returns", async () => {
  const scenario = createScenario({
    softThresholdPercent: 50,
    summaryReserveTokens: 1,
  });
  const compactCalls: Array<{ onComplete?: (result: unknown) => void; onError?: (error: Error) => void }> = [];
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => {
      compactCalls.push(options ?? {});
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    const eventMessages = scenario.manager.buildSessionContext().messages;
    const contextResult = await scenario.runtime.onContext({
      type: "context",
      messages: eventMessages,
    }, ctx);

    assert.ok(contextResult?.messages);
    assert.equal(contextResult.messages[0]?.role, "compactionSummary");
    assert.equal(scenario.runtime.getDiagnostics().counters.virtual_applied, 1);

    scenario.runtime.onTurnEnd(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(scenario.appended.length, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.task_started, 1);

    scenario.runtime.onAgentSettled(ctx);
    scenario.runtime.onAgentSettled(ctx);
    assert.equal(compactCalls.length, 0);
    await waitFor(() => compactCalls.length === 1);

    const manualEvent = {
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "manual" as const,
    };
    const reuse = await scenario.runtime.beforeCompact(manualEvent, ctx);
    assert.ok(reuse?.compaction);
    assert.equal(reuse.compaction.summary, "checkpoint summary");
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("formalization defers until a new leaf makes native preparation available", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  setPiCompactionKeepRecentTokens(scenario, 50_000);
  let compactCalls = 0;
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: () => {
      compactCalls += 1;
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);

    scenario.runtime.onAgentSettled(ctx);
    await waitFor(() => scenario.runtime.getDiagnostics().counters.formalization_deferred === 1);
    scenario.runtime.onAgentSettled(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(compactCalls, 0);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_deferred, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed ?? 0, 0);
    assert.equal(scenario.notifications.some((item) => item.type === "warning"), false);

    scenario.manager.appendMessage(makeUserMessage("new history ".repeat(20_000)));
    scenario.runtime.onAgentSettled(ctx);
    await waitFor(() => compactCalls === 1);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("session too small callback remains deferred without consuming failure attempts", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  let compactCalls = 0;
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: { onError?: (error: Error) => void }) => {
      compactCalls += 1;
      options?.onError?.(new Error("Nothing to compact (session too small)"));
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);

    for (let index = 1; index <= 3; index += 1) {
      scenario.runtime.onAgentSettled(ctx);
      await waitFor(() => compactCalls === index);
      scenario.runtime.onAgentSettled(ctx);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(compactCalls, index);
      if (index < 3) {
        scenario.manager.appendMessage(makeUserMessage(`new leaf ${index}`));
      }
    }

    const diagnostics = scenario.runtime.getDiagnostics();
    assert.equal(diagnostics.counters.formalization_deferred, 3);
    assert.equal(diagnostics.counters.formalization_failed ?? 0, 0);
    assert.equal(scenario.notifications.some((item) => item.type === "warning"), false);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("settled formalization does not start while the agent is busy", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  let compactCalls = 0;
  const ctx = {
    ...scenario.ctx,
    isIdle: () => false,
    compact: () => {
      compactCalls += 1;
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);
    scenario.runtime.onAgentSettled(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(compactCalls, 0);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("native compaction cancels delayed formalization", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  const compactCalls: unknown[] = [];
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: unknown) => {
      compactCalls.push(options);
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);
    scenario.runtime.onAgentSettled(ctx);

    const compactionEntryId = scenario.manager.appendCompaction(
      "native summary",
      scenario.firstEntryId,
      90_000,
    );
    const compactionEntry = scenario.manager.getEntry(compactionEntryId);
    assert.ok(compactionEntry?.type === "compaction");
    scenario.runtime.onSessionCompact({
      type: "session_compact",
      compactionEntry,
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    }, ctx);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(compactCalls.length, 0);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("formalization failure allows one retry and then stops", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  let compactCalls = 0;
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: { onError?: (error: Error) => void }) => {
      compactCalls += 1;
      options?.onError?.(new Error("simulated formalization failure"));
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);

    scenario.runtime.onAgentSettled(ctx);
    await waitFor(() => compactCalls === 1);
    scenario.runtime.onAgentSettled(ctx);
    await waitFor(() => compactCalls === 2);
    scenario.runtime.onAgentSettled(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(compactCalls, 2);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed, 2);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_started, 2);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("formalization failure after checkpoint reuse releases the claim for one retry", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  const compactCalls: Array<{ onError?: (error: Error) => void }> = [];
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: { onError?: (error: Error) => void }) => {
      compactCalls.push(options ?? {});
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);

    scenario.runtime.onAgentSettled(ctx);
    await waitFor(() => compactCalls.length === 1);
    const manualEvent = {
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "manual" as const,
    };
    assert.ok(await scenario.runtime.beforeCompact(manualEvent, ctx));

    compactCalls[0]?.onError?.(new Error("simulated persistence failure"));
    scenario.runtime.onAgentSettled(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(compactCalls.length, 2);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed, 1);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_started, 2);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("branch switching cancels a scheduled formalization", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  let compactCalls = 0;
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: () => {
      compactCalls += 1;
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);
    scenario.runtime.onAgentSettled(ctx);
    scenario.runtime.onSessionBeforeTree();
    scenario.manager.branch(scenario.firstEntryId);
    scenario.runtime.onSessionTree(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(compactCalls, 0);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("session shutdown cancels a scheduled formalization", async () => {
  const scenario = createScenario({ summaryReserveTokens: 1 });
  let compactCalls = 0;
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: () => {
      compactCalls += 1;
    },
  } as ExtensionContext;

  try {
    scenario.runtime.onTurnEnd(ctx);
    await waitFor(() => scenario.appended.length === 1);
    scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);
    scenario.runtime.onAgentSettled(ctx);
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(compactCalls, 0);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("native compaction clears deferred formalization", async () => {
  const { scenario, ctx } = await createDeferredFormalizationScenario();

  try {
    const compactionEntryId = scenario.manager.appendCompaction(
      "native summary",
      scenario.firstEntryId,
      90_000,
    );
    const compactionEntry = scenario.manager.getEntry(compactionEntryId);
    assert.ok(compactionEntry?.type === "compaction");
    scenario.runtime.onSessionCompact({
      type: "session_compact",
      compactionEntry,
      fromExtension: false,
      reason: "threshold",
      willRetry: false,
    }, ctx);

    assert.equal(getDeferredFormalization(scenario.runtime), undefined);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("a newly applied checkpoint clears deferred formalization", async () => {
  const { scenario, ctx } = await createDeferredFormalizationScenario();

  try {
    const parent = parseCheckpointData(scenario.appended[0]);
    assert.ok(parent);
    const snapshotLeafId = scenario.manager.appendMessage(makeUserMessage("new checkpoint history"));
    scenario.manager.appendCustomEntry("pi-press.precompaction", {
      ...parent,
      checkpointId: "refreshed-checkpoint",
      parentCheckpointId: parent.checkpointId,
      snapshotLeafId,
      snapshotSourceLeafId: snapshotLeafId,
      snapshotKey: "refreshed-snapshot",
      createdAt: new Date().toISOString(),
    });
    await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, ctx);

    assert.equal(getDeferredFormalization(scenario.runtime), undefined);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("branch switching clears deferred formalization", async () => {
  const { scenario } = await createDeferredFormalizationScenario();

  try {
    scenario.runtime.onSessionBeforeTree();
    assert.equal(getDeferredFormalization(scenario.runtime), undefined);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("session shutdown clears deferred formalization", async () => {
  const { scenario } = await createDeferredFormalizationScenario();

  try {
    scenario.runtime.onSessionShutdown();
    assert.equal(getDeferredFormalization(scenario.runtime), undefined);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("precomputeMode off clears deferred formalization", async () => {
  const { scenario, ctx } = await createDeferredFormalizationScenario();

  try {
    writeFileSync(
      `${scenario.cwd}/.pi/pi-press.json`,
      JSON.stringify({ ...scenario.config, precomputeMode: "off" }),
    );
    scenario.runtime.onTurnEnd(ctx);
    assert.equal(getDeferredFormalization(scenario.runtime), undefined);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("virtual context can refresh a checkpoint three times in one compaction epoch", async () => {
  const scenario = createScenario({
    softThresholdPercent: 20,
    summaryReserveTokens: 1,
  });
  scenario.faux.setResponses([
    async () => fauxAssistantMessage("first checkpoint summary"),
    async () => fauxAssistantMessage("second checkpoint summary"),
    async () => fauxAssistantMessage("third checkpoint summary"),
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
    for (let generation = 2; generation <= 3; generation += 1) {
      await scenario.runtime.onContext({
        type: "context",
        messages: scenario.manager.buildSessionContext().messages,
      }, scenario.ctx);
      for (let index = 0; index < 100; index += 1) {
        scenario.manager.appendMessage(makeUserMessage("x".repeat(3_000)));
      }
      scenario.runtime.onTurnEnd(lowUsageCtx);
      await waitFor(() => scenario.appended.length === generation);
    }

    const checkpoints = scenario.appended.map((value) => parseCheckpointData(value));
    assert.ok(checkpoints[0]);
    assert.ok(checkpoints[1]);
    assert.ok(checkpoints[2]);
    assert.equal(checkpoints[0].parentCheckpointId, undefined);
    assert.equal(checkpoints[1].parentCheckpointId, checkpoints[0].checkpointId);
    assert.equal(checkpoints[2].parentCheckpointId, checkpoints[1].checkpointId);
    assert.equal(checkpoints[2].compaction.summary, "third checkpoint summary");
    assert.equal(scenario.runtime.getDiagnostics().counters.task_started, 3);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("virtual context refresh request from an injected message survives until turn_end", async () => {
  const scenario = createScenario({
    softThresholdPercent: 20,
    summaryReserveTokens: 1,
  });
  const response: ResponseFactory = async () => fauxAssistantMessage("refreshed checkpoint summary");
  scenario.faux.setResponses([response, response]);
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
    const baseMessages = scenario.manager.buildSessionContext().messages;
    const injectedMessage = {
      ...makeUserMessage("x".repeat(60_000)),
      timestamp: Date.now() + 10_000,
    };
    const contextResult = await scenario.runtime.onContext({
      type: "context",
      messages: [baseMessages[0]!, injectedMessage, ...baseMessages.slice(1)],
    }, scenario.ctx);

    assert.equal(
      contextResult.messages.some((message) => message.role === "compactionSummary"),
      true,
    );
    assert.equal(
      contextResult.messages.some(
        (message) => message.role === "user" && message.content === injectedMessage.content,
      ),
      true,
    );
    assert.equal(scenario.runtime.getDiagnostics().counters.virtual_refresh_needed, 1);

    scenario.manager.appendMessage(injectedMessage);
    scenario.runtime.onTurnEnd(lowUsageCtx);
    await waitFor(() => scenario.appended.length === 2);
    assert.equal(scenario.runtime.getDiagnostics().counters.task_started, 2);

    scenario.runtime.onTurnEnd(lowUsageCtx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(scenario.appended.length, 2);
    assert.equal(scenario.runtime.getDiagnostics().counters.task_started, 2);
  } finally {
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("threshold mode keeps user manual compaction on the native path", async () => {
  const scenario = createScenario({ precomputeMode: "threshold", summaryReserveTokens: 1 });

  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    const manualEvent = {
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "manual" as const,
    };
    assert.equal(await scenario.runtime.beforeCompact(manualEvent, scenario.ctx), undefined);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("checkpoint append failure reports an error without a success notification", async () => {
  const scenario = createScenario(
    { summaryReserveTokens: 1, taskTimeoutMs: 2_000 },
    undefined,
    () => {
      throw new Error("simulated persistence failure");
    },
  );
  const { ctx, cwd, notifications, runtime } = scenario;

  try {
    runtime.onTurnEnd(ctx);

    await waitFor(
      () => Boolean(runtime.getDiagnostics().counters.checkpoint_append_failure),
    );

    const diagnostics = runtime.getDiagnostics();
    assert.equal(diagnostics.counters.checkpoint_append_failure, 1);
    assert.equal(diagnostics.counters.task_failed, 1);
    assert.ok(
      notifications.some(
        (notification) =>
          notification.type === "error" && notification.message.includes("追加失败"),
      ),
    );
    assert.equal(
      notifications.some(
        (notification) =>
          notification.type === "info" && notification.message.includes("预压缩成功"),
      ),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkpoint provenance records the sanitized resolved endpoint", async () => {
  const scenario = createScenario();
  const { appended, ctx, cwd, runtime } = scenario;
  const registry = ctx.modelRegistry as unknown as {
    getApiKeyAndHeaders: () => Promise<{
      ok: true;
      baseUrl: string;
    }>;
  };
  registry.getApiKeyAndHeaders = async () => ({
    ok: true,
    baseUrl: "https://user:password@override.test/v1?apiKey=sk-url-secret#credential",
  });

  try {
    runtime.onTurnEnd(ctx);
    await waitFor(() => appended.length === 1);

    const checkpoint = parseCheckpointData(appended[0]);
    assert.ok(checkpoint);
    assert.equal(checkpoint.provenance.model.baseUrl, "https://override.test/v1");
    assert.doesNotMatch(JSON.stringify(checkpoint.provenance), /user|password|sk-url-secret|credential/);
  } finally {
    runtime.onSessionShutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid checkpoint data is rejected by the full schema before persistence", async () => {
  const scenario = createScenario();
  const { appended, ctx, cwd, notifications, runtime } = scenario;
  const model = ctx.model as { baseUrl: string };
  model.baseUrl = "";

  try {
    runtime.onTurnEnd(ctx);
    await waitFor(() => {
      const counters = runtime.getDiagnostics().counters;
      return Boolean(
        counters.checkpoint_invalid_result ||
        counters.checkpoint_ready ||
        counters.task_failed
      );
    });

    const diagnostics = runtime.getDiagnostics();
    assert.equal(diagnostics.counters.checkpoint_invalid_result, 1);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(appended.length, 0);
    assert.ok(
      notifications.some(
        (notification) =>
          notification.type === "error" && notification.message.includes("checkpoint 校验"),
      ),
    );
  } finally {
    runtime.onSessionShutdown();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checkpoint above the refresh threshold is persisted for immediate use", async () => {
  const scenario = createScenario({
    softThresholdPercent: 0,
    summaryReserveTokens: 1,
    taskTimeoutMs: 2_000,
  });
  const { appended, ctx, cwd, faux, runtime } = scenario;

  try {
    runtime.onTurnEnd(ctx);
    await waitFor(() => appended.length === 1);

    const diagnostics = runtime.getDiagnostics();
    assert.equal(faux.state.callCount, 1);
    assert.equal(diagnostics.counters.checkpoint_ready, 1);
    assert.equal(diagnostics.counters.checkpoint_skipped_capacity ?? 0, 0);
    assert.equal(diagnostics.counters.task_failed ?? 0, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
