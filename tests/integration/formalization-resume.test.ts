import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  SessionManager,
  type CompactOptions,
  type ExtensionContext,
  type SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { parseCheckpointData } from "../../src/checkpoint/schema.js";
import { ExtensionRuntime } from "../../src/extension-runtime.js";
import { createScenario, makeCompactEvent, waitFor } from "../runtime-fixture.js";
import { makeAssistantMessage, makeUserMessage } from "../unit/fixtures.js";

test("cancelled formalization resumes from a persisted checkpoint without regenerating the summary", async (t) => {
  const fixture = createScenario({ diagnosticsPersistence: "memory" });
  const manager = SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
  for (const entry of fixture.manager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "user") {
      manager.appendMessage(entry.message);
    }
  }
  manager.appendMessage(makeAssistantMessage("response before precompaction"));
  const compactCalls: CompactOptions[] = [];
  const ctx = {
    ...fixture.ctx,
    sessionManager: manager,
    isIdle: () => true,
    compact: (options?: CompactOptions) => compactCalls.push(options ?? {}),
  } as ExtensionContext;
  const runtime = new ExtensionRuntime({
    appendEntry: (customType, data) => {
      fixture.appended.push(data);
      manager.appendCustomEntry(customType, data);
    },
  });
  const scenario = { ...fixture, manager, runtime, ctx };
  runtime.onSessionStart(ctx);
  let resumedRuntime: ExtensionRuntime | undefined;

  try {
    runtime.onTurnEnd(ctx);
    await waitFor(() => fixture.appended.length === 1);
    const checkpoint = parseCheckpointData(fixture.appended[0]);
    assert.ok(checkpoint);
    await runtime.onContext({
      type: "context",
      messages: manager.buildSessionContext().messages,
    }, ctx);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      runtime.onAgentSettled(ctx);
      await waitFor(() => compactCalls.length === attempt);
      const controller = new AbortController();
      assert.ok(await runtime.beforeCompact({
        ...makeCompactEvent(scenario, controller.signal),
        reason: "manual",
      }, ctx));
      controller.abort();
      const failedEvent = {
        type: "session_compact_failed",
        reason: "manual",
        aborted: true,
        willRetry: false,
        fromExtension: true,
      } satisfies SessionCompactFailedEvent;
      runtime.onSessionCompactFailed(failedEvent);
      compactCalls.at(-1)?.onError?.(new Error("Compaction cancelled"));
    }
    const tail = makeUserMessage("persisted tail after cancellation");
    manager.appendMessage(tail);
    const continued = await runtime.onContext({
      type: "context",
      messages: manager.buildSessionContext().messages,
    }, ctx);
    assert.equal(continued.messages[0]?.role, "compactionSummary");
    assert.deepEqual(continued.messages.at(-1), tail);
    runtime.onSessionShutdown();

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const resumed = SessionManager.open(sessionFile);
    assert.equal(resumed.getSessionId(), manager.getSessionId());
    assert.equal(resumed.getBranch().some((entry) => entry.type === "compaction"), false);
    const storedCheckpoint = resumed.getBranch().find(
      (entry) => entry.type === "custom" && entry.customType === "pi-press.precompaction",
    );
    assert.ok(storedCheckpoint?.type === "custom");
    assert.deepEqual(storedCheckpoint.data, checkpoint);
    resumedRuntime = new ExtensionRuntime({
      appendEntry: () => assert.fail("resume must reuse the persisted checkpoint"),
    });
    const resumedCtx = { ...ctx, sessionManager: resumed } as ExtensionContext;
    resumedRuntime.onSessionStart(resumedCtx);
    compactCalls[1]?.onError?.(new Error("late callback after shutdown"));
    const projection = await resumedRuntime.onContext({
      type: "context",
      messages: resumed.buildSessionContext().messages,
    }, resumedCtx);
    assert.equal(projection.messages[0]?.role, "compactionSummary");
    assert.deepEqual(projection.messages, continued.messages);
    resumedRuntime.onAgentSettled(resumedCtx);
    await waitFor(() => compactCalls.length === 3);
    const reuse = await resumedRuntime.beforeCompact({
      ...makeCompactEvent({ ...scenario, manager: resumed }, new AbortController().signal),
      reason: "manual",
    }, resumedCtx);
    assert.equal(reuse?.compaction.summary, checkpoint.compaction.summary);
    assert.equal(fixture.faux.state.callCount, 1);
    assert.equal(fixture.notifications.some((item) => item.type === "warning"), false);
    resumedRuntime.onSessionShutdown();

    for (const invalidCondition of ["Pi version", "branch", "capacity"] as const) {
      await t.test(`resume rejects an invalid checkpoint: ${invalidCondition}`, async () => {
        const invalidManager = SessionManager.open(sessionFile);
        if (invalidCondition === "capacity") {
          invalidManager.branch(storedCheckpoint.id);
        } else {
          const branchPoint = invalidCondition === "Pi version"
            ? checkpoint.snapshotLeafId
            : manager.getBranch()[0]!.id;
          invalidManager.branch(branchPoint);
          invalidManager.appendCustomEntry("pi-press.precompaction", {
            ...checkpoint,
            ...(invalidCondition === "Pi version" ? { piVersion: "incompatible-version" } : {}),
          });
        }
        const invalidCtx = {
          ...resumedCtx,
          sessionManager: invalidManager,
          model: invalidCondition === "capacity"
            ? { ...resumedCtx.model!, contextWindow: 20_000 }
            : resumedCtx.model,
          getContextUsage: () => undefined,
          compact: () => assert.fail("an invalid checkpoint must not be formalized"),
        } as ExtensionContext;
        const invalidRuntime = new ExtensionRuntime({
          appendEntry: () => assert.fail("validation must not regenerate the summary"),
        });
        try {
          invalidRuntime.onSessionStart(invalidCtx);
          const messages = invalidManager.buildSessionContext().messages;
          const result = await invalidRuntime.onContext({ type: "context", messages }, invalidCtx);
          assert.deepEqual(result.messages, messages);
          invalidRuntime.onAgentSettled(invalidCtx);
          assert.equal(invalidRuntime.getDiagnostics().counters.formalization_started ?? 0, 0);
          assert.equal(fixture.faux.state.callCount, 1);
        } finally {
          invalidRuntime.onSessionShutdown();
        }
      });
    }
  } finally {
    resumedRuntime?.onSessionShutdown();
    runtime.onSessionShutdown();
    fixture.runtime.onSessionShutdown();
    rmSync(fixture.cwd, { recursive: true, force: true });
  }
});
