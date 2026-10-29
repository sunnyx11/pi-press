import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { type TestContext } from "node:test";
import type {
  CompactOptions,
  ExtensionContext,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { createScenario, makeCompactEvent, waitFor } from "../runtime-fixture.js";
import { makeUserMessage } from "./fixtures.js";

type Scenario = Awaited<ReturnType<typeof createFormalizationScenario>>;

async function createFormalizationScenario(t: TestContext) {
  const scenario = createScenario({ diagnosticsPersistence: "memory" });
  t.after(() => {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  });
  const compactCalls: CompactOptions[] = [];
  const ctx = {
    ...scenario.ctx,
    isIdle: () => true,
    compact: (options?: CompactOptions) => compactCalls.push(options ?? {}),
  } as ExtensionContext;
  scenario.runtime.onTurnEnd(ctx);
  await waitFor(() => scenario.appended.length === 1);
  const projection = await scenario.runtime.onContext({
    type: "context",
    messages: scenario.manager.buildSessionContext().messages,
  }, ctx);
  assert.equal(projection.messages[0]?.role, "compactionSummary");
  scenario.runtime.onAgentSettled(ctx);
  await waitFor(() => compactCalls.length === 1);
  return { ...scenario, ctx, compactCalls };
}

function runtimeState(scenario: Scenario) {
  return scenario.runtime as unknown as {
    pendingFormalization?: unknown;
    checkpointClaim?: unknown;
    virtualApplication?: unknown;
    virtualContextCache: { stats(): unknown };
    formalizationAttemptsByEpoch: Map<string, number>;
  };
}

const cancelledEvent = {
  type: "session_compact_failed",
  reason: "manual",
  aborted: true,
  willRetry: false,
  fromExtension: true,
} satisfies SessionCompactFailedEvent;

async function cancelFormalization(scenario: Scenario, early = false): Promise<void> {
  const controller = new AbortController();
  if (early) {
    controller.abort();
  }
  const result = await scenario.runtime.beforeCompact({
    ...makeCompactEvent(scenario, controller.signal),
    reason: "manual",
  }, scenario.ctx);
  assert.equal(Boolean(result?.compaction), !early);
  controller.abort();
  scenario.runtime.onSessionCompactFailed({ ...cancelledEvent, fromExtension: !early });
  scenario.compactCalls.at(-1)?.onError?.(new Error("Compaction cancelled"));
}

for (const early of [false, true]) {
  test(`internal cancellation ${early ? "before" : "after"} checkpoint reuse preserves virtual state and failure attempts`, async (t) => {
    const scenario = await createFormalizationScenario(t);
    const state = runtimeState(scenario);
    const application = state.virtualApplication;
    const cacheStats = state.virtualContextCache.stats();
    const notifications = [...scenario.notifications];

    await cancelFormalization(scenario, early);

    assert.deepEqual(scenario.notifications, notifications);
    assert.equal(state.pendingFormalization, undefined);
    assert.equal(state.checkpointClaim, undefined);
    assert.equal(state.formalizationAttemptsByEpoch.size, 0);
    assert.equal(state.virtualApplication, application);
    assert.deepEqual(state.virtualContextCache.stats(), cacheStats);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed ?? 0, 0);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_exhausted ?? 0, 0);
    assert.equal(scenario.manager.getBranch().some((entry) => entry.type === "compaction"), false);
    assert.equal(scenario.appended.length, 1);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scenario.compactCalls.length, 1);
    const tail = makeUserMessage("new message after cancellation");
    scenario.manager.appendMessage(tail);
    const projection = await scenario.runtime.onContext({
      type: "context",
      messages: scenario.manager.buildSessionContext().messages,
    }, scenario.ctx);
    assert.equal(projection.messages[0]?.role, "compactionSummary");
    assert.deepEqual(projection.messages.at(-1), tail);
    scenario.runtime.onAgentSettled(scenario.ctx);
    await waitFor(() => scenario.compactCalls.length === 2);
    assert.ok(await scenario.runtime.beforeCompact({
      ...makeCompactEvent(scenario, new AbortController().signal),
      reason: "manual",
    }, scenario.ctx));
    assert.equal(scenario.faux.state.callCount, 1);
  });
}

test("repeated internal cancellations keep every formalization opportunity", async (t) => {
  const scenario = await createFormalizationScenario(t);
  const notifications = [...scenario.notifications];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await cancelFormalization(scenario);
    scenario.runtime.onSessionCompactFailed(cancelledEvent);
    scenario.compactCalls.at(-1)?.onError?.(new Error("duplicate callback"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scenario.compactCalls.length, attempt);
    assert.equal(runtimeState(scenario).pendingFormalization, undefined);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed ?? 0, 0);
    assert.deepEqual(scenario.notifications, notifications);
    scenario.runtime.onAgentSettled(scenario.ctx);
    await waitFor(() => scenario.compactCalls.length === attempt + 1);
  }
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_started, 4);
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_exhausted ?? 0, 0);
});

test("cancellation preserves one real failure and the next real failure still exhausts the budget", async (t) => {
  const scenario = await createFormalizationScenario(t);
  scenario.compactCalls[0]?.onError?.(new Error("first real failure"));
  scenario.runtime.onAgentSettled(scenario.ctx);
  await waitFor(() => scenario.compactCalls.length === 2);
  const notifications = [...scenario.notifications];

  await cancelFormalization(scenario);

  assert.deepEqual(scenario.notifications, notifications);
  assert.deepEqual([...runtimeState(scenario).formalizationAttemptsByEpoch.values()], [1]);
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed, 1);
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_exhausted ?? 0, 0);
  scenario.runtime.onAgentSettled(scenario.ctx);
  await waitFor(() => scenario.compactCalls.length === 3);
  scenario.compactCalls[2]?.onError?.(new Error("second real failure"));
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed, 2);
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_exhausted, 1);
  assert.equal(scenario.notifications.filter((item) => item.type === "warning").length, 2);
});

for (const mismatch of ["no hook", "live signal", "non-abort event", "threshold event", "retry event", "different signal"] as const) {
  test(`cancellation without confirmed ownership remains an ordinary failure: ${mismatch}`, async (t) => {
    const scenario = await createFormalizationScenario(t);
    const controller = new AbortController();
    if (mismatch !== "no hook") {
      assert.ok(await scenario.runtime.beforeCompact({
        ...makeCompactEvent(scenario, controller.signal),
        reason: "manual",
      }, scenario.ctx));
    }
    if (mismatch !== "live signal") {
      controller.abort();
    }
    if (mismatch === "different signal") {
      const otherController = new AbortController();
      assert.equal(await scenario.runtime.beforeCompact({
        ...makeCompactEvent(scenario, otherController.signal),
        reason: "manual",
      }, scenario.ctx), undefined);
      otherController.abort();
    }
    const failedEvent = {
      ...cancelledEvent,
      aborted: mismatch !== "non-abort event",
      reason: mismatch === "threshold event" ? "threshold" : "manual",
      willRetry: mismatch === "retry event",
      fromExtension: false,
    } satisfies SessionCompactFailedEvent;
    scenario.runtime.onSessionCompactFailed(failedEvent);
    scenario.compactCalls[0]?.onError?.(new Error("Compaction cancelled"));
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed, 1);
    assert.equal(scenario.notifications.filter((item) => item.type === "warning").length, 1);
  });
}

test("formalization error preserves a checkpoint claim owned by another compaction signal", async (t) => {
  const scenario = await createFormalizationScenario(t);
  const controller = new AbortController();
  assert.ok(await scenario.runtime.beforeCompact({
    ...makeCompactEvent(scenario, controller.signal),
    reason: "manual",
  }, scenario.ctx));
  controller.abort();
  const otherEvent = makeCompactEvent(scenario, new AbortController().signal);
  assert.ok(await scenario.runtime.beforeCompact(otherEvent, scenario.ctx));
  const claim = runtimeState(scenario).checkpointClaim;

  scenario.runtime.onSessionCompactFailed(cancelledEvent);
  scenario.compactCalls[0]?.onError?.(new Error("original request failed"));

  assert.equal(runtimeState(scenario).checkpointClaim, claim);
  assert.equal(await scenario.runtime.beforeCompact(otherEvent, scenario.ctx), undefined);
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed, 1);
});

test("a cancellation event without pending formalization preserves the existing failure count", async (t) => {
  const scenario = await createFormalizationScenario(t);
  scenario.compactCalls[0]?.onError?.(new Error("real failure"));
  const notifications = [...scenario.notifications];
  scenario.runtime.onSessionCompactFailed(cancelledEvent);
  assert.deepEqual([...runtimeState(scenario).formalizationAttemptsByEpoch.values()], [1]);
  assert.deepEqual(scenario.notifications, notifications);
});

test("late cancellation events and callbacks preserve the next pending request and claim", async (t) => {
  const scenario = await createFormalizationScenario(t);
  const oldCallbacks = scenario.compactCalls[0];
  await cancelFormalization(scenario);
  scenario.runtime.onAgentSettled(scenario.ctx);
  await waitFor(() => scenario.compactCalls.length === 2);
  const result = await scenario.runtime.beforeCompact({
    ...makeCompactEvent(scenario, new AbortController().signal),
    reason: "manual",
  }, scenario.ctx);
  assert.ok(result?.compaction);
  const pending = runtimeState(scenario).pendingFormalization;
  const claim = runtimeState(scenario).checkpointClaim;
  const notifications = [...scenario.notifications];

  scenario.runtime.onSessionCompactFailed(cancelledEvent);
  oldCallbacks?.onError?.(new Error("late failure"));
  oldCallbacks?.onComplete?.(result.compaction);

  assert.equal(runtimeState(scenario).pendingFormalization, pending);
  assert.equal(runtimeState(scenario).checkpointClaim, claim);
  assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed ?? 0, 0);
  assert.deepEqual(scenario.notifications, notifications);
});

for (const lifecycle of ["shutdown", "tree", "success"] as const) {
  test(`late cancellation callbacks after ${lifecycle} preserve lifecycle state`, async (t) => {
    const scenario = await createFormalizationScenario(t);
    const controller = new AbortController();
    const result = await scenario.runtime.beforeCompact({
      ...makeCompactEvent(scenario, controller.signal),
      reason: "manual",
    }, scenario.ctx);
    assert.ok(result?.compaction);
    if (lifecycle === "success") {
      const id = scenario.manager.appendCompaction(
        result.compaction.summary,
        result.compaction.firstKeptEntryId,
        result.compaction.tokensBefore,
        result.compaction.details,
      );
      const compactionEntry = scenario.manager.getEntry(id);
      assert.ok(compactionEntry?.type === "compaction");
      scenario.runtime.onSessionCompact({
        type: "session_compact",
        compactionEntry,
        reason: "manual",
        willRetry: false,
        fromExtension: true,
      }, scenario.ctx);
    } else {
      controller.abort();
      scenario.runtime.onSessionCompactFailed(cancelledEvent);
      if (lifecycle === "shutdown") {
        scenario.runtime.onSessionShutdown();
      } else {
        scenario.runtime.onSessionBeforeTree();
      }
      scenario.runtime.onSessionStart(scenario.ctx);
      await scenario.runtime.onContext({
        type: "context",
        messages: scenario.manager.buildSessionContext().messages,
      }, scenario.ctx);
      scenario.runtime.onAgentSettled(scenario.ctx);
      await waitFor(() => scenario.compactCalls.length === 2);
    }
    const pending = runtimeState(scenario).pendingFormalization;
    const notifications = [...scenario.notifications];
    controller.abort();
    scenario.runtime.onSessionCompactFailed(cancelledEvent);
    scenario.compactCalls[0]?.onError?.(new Error("late cancellation"));
    scenario.compactCalls[0]?.onComplete?.(result.compaction);
    assert.equal(runtimeState(scenario).pendingFormalization, pending);
    assert.equal(scenario.runtime.getDiagnostics().counters.formalization_failed ?? 0, 0);
    assert.deepEqual(scenario.notifications, notifications);
    assert.equal(scenario.manager.getBranch().some((entry) => entry.type === "compaction"), lifecycle === "success");
  });
}
