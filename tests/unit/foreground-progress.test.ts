import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test, { type TestContext } from "node:test";
import type { ExtensionContext, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { createScenario } from "../runtime-fixture.js";

type ProgressHandle = { refresh(): void; cleanup(): void };
type ProgressRuntime = {
  startForegroundWaitProgress(
    ctx: ExtensionContext,
    getTask: () => { retryCount: number; stage: string } | undefined,
    startedAt: number,
    getRetryCount?: () => number,
  ): ProgressHandle;
};

function createHarness(t: TestContext, mode?: string, hasUI?: boolean) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 10_000 });
  const scenario = createScenario();
  t.after(() => {
    scenario.runtime.onSessionShutdown();
    rmSync(scenario.cwd, { recursive: true, force: true });
  });
  const working: Array<string | undefined> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const ctx = {
    ...scenario.ctx,
    mode,
    hasUI,
    ui: {
      ...scenario.ctx.ui,
      setWorkingMessage: (text?: string) => working.push(text),
      setStatus: (key: string, text?: string) => statuses.push({ key, text }),
    },
  } as unknown as ExtensionContext;
  const progress = scenario.runtime as unknown as ProgressRuntime;
  return { ...scenario, ctx, progress, working, statuses };
}

for (const mode of ["tui", "rpc", "json", "print", undefined]) {
  for (const hasUI of [true, false, undefined]) {
    test(`foreground progress output and timer lifecycle for mode=${mode}, hasUI=${hasUI}`, (t) => {
      const h = createHarness(t, mode, hasUI);
      const handle = h.progress.startForegroundWaitProgress(h.ctx, () => undefined, Date.now());
      const rpc = mode === "rpc";
      const interactive = mode !== "json" && mode !== "print" && hasUI !== false;
      const output = rpc ? h.statuses.map((entry) => entry.text) : h.working;
      assert.deepEqual(output, rpc || interactive ? ["pi-press: Compacting · 0s elapsed"] : []);
      assert.equal(rpc ? h.working.length : h.statuses.length, 0);

      t.mock.timers.tick(1_000);
      const beforeCleanup = rpc ? h.statuses.map((entry) => entry.text) : [...h.working];
      assert.deepEqual(
        beforeCleanup,
        interactive
          ? ["pi-press: Compacting · 0s elapsed", "pi-press: Compacting · 1s elapsed"]
          : rpc ? ["pi-press: Compacting · 0s elapsed"] : [],
      );
      handle.cleanup();
      const expected = [...beforeCleanup, ...(rpc || interactive ? [undefined] : [])];
      t.mock.timers.tick(2_000);
      handle.refresh();
      handle.cleanup();
      assert.deepEqual(rpc ? h.statuses.map((entry) => entry.text) : h.working, expected);
      assert.ok(h.statuses.every((entry) => entry.key === "pi-press"));
    });
  }
}

test("foreground progress keeps background and foreground retry budgets distinct", (t) => {
  const h = createHarness(t, "tui", true);
  const task = { retryCount: 1, stage: "retry_backoff" };
  let retries = 0;
  const handle = h.progress.startForegroundWaitProgress(h.ctx, () => task, Date.now(), () => retries);
  assert.equal(h.working.at(-1), "pi-press: Compacting · 0s elapsed · retry 1/1");
  retries = 1;
  handle.refresh();
  assert.equal(h.working.at(-1), "pi-press: Compacting · 0s elapsed · retry 1/3");
  t.mock.timers.tick(1_000);
  assert.equal(h.working.at(-1), "pi-press: Compacting · 1s elapsed · retry 1/3");
  handle.cleanup();
});

test("late progress refresh and cleanup preserve the newer wait", (t) => {
  const h = createHarness(t, "tui", true);
  const old = h.progress.startForegroundWaitProgress(h.ctx, () => undefined, Date.now());
  t.mock.timers.tick(1_000);
  const current = h.progress.startForegroundWaitProgress(h.ctx, () => undefined, Date.now());
  const expected = [...h.working];
  old.refresh();
  old.cleanup();
  assert.deepEqual(h.working, expected);
  t.mock.timers.tick(1_000);
  assert.equal(h.working.at(-1), "pi-press: Compacting · 1s elapsed");
  current.cleanup();
  const finished = [...h.working];
  t.mock.timers.tick(2_000);
  assert.deepEqual(h.working, finished);
});

for (const lifecycle of ["start", "tree", "shutdown", "compact"] as const) {
  test(`foreground progress stops before ${lifecycle} invalidates the session`, (t) => {
    const h = createHarness(t, "tui", true);
    const old = h.progress.startForegroundWaitProgress(h.ctx, () => undefined, Date.now());
    if (lifecycle === "start") h.runtime.onSessionStart(h.ctx);
    if (lifecycle === "tree") h.runtime.onSessionBeforeTree();
    if (lifecycle === "shutdown") h.runtime.onSessionShutdown();
    if (lifecycle === "compact") {
      h.runtime.onSessionCompact({ compactionEntry: { details: undefined } } as SessionCompactEvent, h.ctx);
    }
    assert.equal(h.working.at(-1), undefined);
    const expected = [...h.working];
    t.mock.timers.tick(2_000);
    old.refresh();
    old.cleanup();
    assert.deepEqual(h.working, expected);
  });
}

for (const mode of ["tui", "rpc"]) {
  test(`foreground progress tolerates missing and throwing ${mode} UI methods`, (t) => {
    const h = createHarness(t, mode, true);
    for (const ui of [undefined, {}, {
      setWorkingMessage: () => { throw new Error("UI unavailable"); },
      setStatus: () => { throw new Error("UI unavailable"); },
    }]) {
      const ctx = { ...h.ctx, ui } as unknown as ExtensionContext;
      const handle = h.progress.startForegroundWaitProgress(ctx, () => undefined, Date.now());
      t.mock.timers.tick(1_000);
      handle.cleanup();
    }
  });
}
