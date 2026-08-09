import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionCompactEvent } from "@earendil-works/pi-coding-agent";
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
