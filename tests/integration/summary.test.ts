import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseCheckpointData } from "../../src/checkpoint/schema.js";
import { createScenario, waitFor } from "../runtime-fixture.js";
import { makeAssistantMessage, makeUserMessage } from "../unit/fixtures.js";

for (const level of ["low", "inherit", "off"] as const) {
  test(`summary thinking ${level} preserves the main session thinking level`, async () => {
    const scenario = createScenario();
    writeFileSync(join(scenario.cwd, ".pi", "pi-press.json"), JSON.stringify({
      ...scenario.config,
      summaryThinkingLevel: level,
    }));
    const ctx = {
      ...scenario.ctx,
      model: { ...scenario.ctx.model!, reasoning: true },
      thinkingLevel: "xhigh",
    } as ExtensionContext;
    let reasoning: unknown;
    scenario.faux.setResponses([(_context, options) => {
      reasoning = options?.reasoning;
      return fauxAssistantMessage("summary");
    }]);
    try {
      scenario.runtime.onTurnEnd(ctx);
      await waitFor(() => scenario.appended.length === 1);
      const checkpoint = parseCheckpointData(scenario.appended[0]);
      assert.ok(checkpoint);
      assert.equal(reasoning, level === "inherit" ? "xhigh" : level === "off" ? undefined : "low");
      assert.equal(checkpoint.provenance.thinkingLevel, level === "inherit" ? "xhigh" : level);
      assert.equal(ctx.thinkingLevel, "xhigh");
    } finally {
      scenario.runtime.onSessionShutdown();
      rmSync(scenario.cwd, { recursive: true, force: true });
    }
  });
}

function addSplitTurn(scenario: ReturnType<typeof createScenario>): void {
  scenario.manager.appendMessage(makeUserMessage("prefix-input-secret ".repeat(2_000)));
  scenario.manager.appendMessage(makeAssistantMessage("prefix response"));
  scenario.manager.appendMessage(makeAssistantMessage("kept response ".repeat(4_000)));
}

test("split summaries record stages and retry metadata without request content", async () => {
  const scenario = createScenario({ summaryReserveTokens: 16_384 });
  addSplitTurn(scenario);
  scenario.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 provider-response-secret" }),
    fauxAssistantMessage("history-summary-secret"),
    fauxAssistantMessage("prefix-summary-secret"),
  ]);
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.appended.length === 1);
    const events = scenario.runtime.getDiagnostics().events;
    const stages = events.filter((event) => event.name === "task_stage_finished");
    assert.deepEqual(stages.map((event) => event.details?.stage), ["preparation", "auth"]);
    for (const event of stages) {
      assert.equal(typeof event.details?.durationMs, "number");
    }
    const requests = events.filter((event) => event.name === "summary_request_settled");
    assert.deepEqual(requests.map((event) => event.details?.stage), [
      "history_summary", "history_summary", "turn_prefix_summary",
    ]);
    assert.deepEqual(requests.map((event) => event.details?.requestIndex), [1, 2, 3]);
    assert.equal(events.find((event) => event.name === "summary_retry_scheduled")?.details?.retryCount, 1);
    assert.equal(typeof events.find((event) => event.name === "summary_retry_started")?.details?.durationMs, "number");
    assert.equal(events.find((event) => event.name === "summary_retry_finished")?.details?.success, true);
    assert.ok(requests.every((event) => typeof event.details?.durationMs === "number"));
    const taskIds = new Set(requests.map((event) => event.details?.taskId));
    assert.equal(taskIds.size, 1);
    assert.equal(typeof [...taskIds][0], "string");
    assert.doesNotMatch(JSON.stringify(events), /provider-response-secret|prefix-input-secret|history-summary-secret|prefix-summary-secret/);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("timeout cancels retry backoff before a second request starts", async () => {
  const scenario = createScenario({ taskTimeoutMs: 125 });
  let calls = 0;
  scenario.faux.setResponses([() => {
    calls++;
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 transient failure" });
  }]);
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.runtime.getDiagnostics().counters.task_timed_out === 1);
    await waitFor(() => scenario.runtime.getDiagnostics().counters.background_operation_settled === 1);
    const events = scenario.runtime.getDiagnostics().events;
    const timeout = events.find((event) => event.name === "task_timed_out");
    assert.equal(timeout?.details?.stage, "retry_backoff");
    assert.equal(timeout?.details?.requestCount, 1);
    assert.equal(timeout?.details?.retryCount, 1);
    assert.equal(events.find((event) => event.name === "summary_retry_finished")?.details?.success, false);
    assert.equal(calls, 1);
    assert.equal(scenario.appended.length, 0);
  } finally {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});

test("split summaries share a total deadline and record late request settlement", async () => {
  const scenario = createScenario({ taskTimeoutMs: 250, summaryReserveTokens: 16_384 });
  addSplitTurn(scenario);
  let finishPrefix!: () => void;
  const prefixFinished = new Promise<void>((resolve) => { finishPrefix = resolve; });
  scenario.faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fauxAssistantMessage("history summary");
    },
    async () => {
      await prefixFinished;
      return fauxAssistantMessage("prefix summary");
    },
  ]);
  try {
    scenario.runtime.onTurnEnd(scenario.ctx);
    await waitFor(() => scenario.runtime.getDiagnostics().counters.task_timed_out === 1);
    const timeout = scenario.runtime.getDiagnostics().events.find((event) => event.name === "task_timed_out");
    assert.equal(timeout?.details?.stage, "turn_prefix_summary");
    assert.equal(timeout?.details?.requestCount, 2);
    assert.ok(Number(timeout?.details?.elapsedMs) >= 250);
    assert.equal(scenario.appended.length, 0);
    finishPrefix();
    await waitFor(() => scenario.runtime.getDiagnostics().counters.background_operation_settled === 1);
    const events = scenario.runtime.getDiagnostics().events;
    const settled = events.filter((event) => event.name === "summary_request_settled").at(-1);
    assert.equal(settled?.details?.aborted, true);
    assert.equal(settled?.details?.taskId, timeout?.details?.taskId);
    assert.equal(scenario.appended.length, 0);
  } finally {
    finishPrefix();
    scenario.runtime.onSessionShutdown();
    await new Promise((resolve) => setTimeout(resolve, 30));
    rmSync(scenario.cwd, { recursive: true, force: true });
  }
});
