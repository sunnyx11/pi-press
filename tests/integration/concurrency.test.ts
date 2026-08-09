import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type Api, type Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "../../src/extension-runtime.js";
import { createPreparationSettings, prepareCompactionFromBranch } from "../../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { PiPressConfig } from "../../src/types.js";
import { makeModel, makeUserMessage } from "../unit/fixtures.js";

type Notification = { message: string; type: "info" | "warning" | "error" | undefined };
type ResponseFactory = () => Promise<ReturnType<typeof fauxAssistantMessage>>;

type Scenario = {
  cwd: string;
  manager: SessionManager;
  model: Model<Api>;
  faux: ReturnType<typeof fauxProvider>;
  config: PiPressConfig;
  runtime: ExtensionRuntime;
  ctx: ExtensionContext;
  firstKeptId: string;
  appended: unknown[];
  notifications: Notification[];
};

function createScenario(overrides: Partial<PiPressConfig>, responseFactory: ResponseFactory): Scenario {
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-concurrency-"));
  mkdirSync(join(cwd, ".pi"));
  const config: PiPressConfig = {
    ...DEFAULT_CONFIG,
    softThresholdPercent: 80,
    summaryReserveTokens: 1,
    taskTimeoutMs: 2_000,
    hookWaitTimeoutMs: 500,
    ...overrides,
  };
  writeFileSync(join(cwd, ".pi", "pi-press.json"), JSON.stringify(config));

  const manager = SessionManager.inMemory(cwd);
  const firstKeptId = manager.appendMessage(makeUserMessage("old history ".repeat(2_000)));
  manager.appendMessage(makeUserMessage("recent context ".repeat(2_000)));
  const faux = fauxProvider({
    api: "openai-responses",
    provider: "test",
    models: [{ id: "model-id", contextWindow: 100_000, maxTokens: 4_096 }],
  });
  faux.setResponses([responseFactory]);
  const model = makeModel();
  const appended: unknown[] = [];
  const notifications: Notification[] = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appended.push(data);
      manager.appendCustomEntry(customType, data);
    },
  } as Pick<ExtensionAPI, "appendEntry">;
  const ctx = {
    cwd,
    sessionManager: manager,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
      getProvider: () => faux.provider,
    },
    thinkingLevel: "medium",
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 90 }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime(pi);
  runtime.onSessionStart(ctx);
  return { cwd, manager, model, faux, config, runtime, ctx, firstKeptId, appended, notifications };
}

function makeCompactEvent(scenario: Scenario, signal: AbortSignal): SessionBeforeCompactEvent {
  const preparation = prepareCompactionFromBranch(
    scenario.manager.getBranch(),
    createPreparationSettings(scenario.config),
  );
  assert.ok(preparation);
  return {
    type: "session_before_compact",
    preparation,
    branchEntries: scenario.manager.getBranch(),
    reason: "threshold",
    willRetry: false,
    signal,
  } satisfies SessionBeforeCompactEvent;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}

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

    scenario.manager.appendCompaction("native summary", scenario.firstKeptId, 90_000);
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
