import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import type { SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import {
  createScenario,
  makeCompactEvent,
  waitFor,
} from "../runtime-fixture.js";

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

test("capacity-rejected checkpoint shows a warning without persistence", async () => {
  const scenario = createScenario({
    softThresholdPercent: 80,
    summaryReserveTokens: 1,
    targetPostCompactionPercent: 0,
    taskTimeoutMs: 2_000,
  });
  const { appended, ctx, cwd, faux, notifications, runtime } = scenario;

  try {
    runtime.onTurnEnd(ctx);

    await waitFor(
      () => Boolean(runtime.getDiagnostics().counters.checkpoint_skipped_capacity),
    );

    const diagnostics = runtime.getDiagnostics();
    assert.equal(faux.state.callCount, 1);
    assert.equal(appended.length, 0);
    assert.equal(diagnostics.counters.checkpoint_skipped_capacity, 1);
    assert.equal(diagnostics.counters.checkpoint_ready ?? 0, 0);
    assert.equal(diagnostics.counters.task_failed ?? 0, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.type, "warning");
    assert.match(notifications[0]?.message ?? "", /容量不足/);
    assert.ok(diagnostics.records.some((record) => record.kind === "capacity"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
