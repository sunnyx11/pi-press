import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import registerPiPress from "../../src/index.js";
import { createScenario, waitFor, type Notification } from "../runtime-fixture.js";
import { makeAssistantMessage, makeCheckpointData, makeUserMessage } from "../unit/fixtures.js";

for (const cancelBeforeReuse of [false, true]) {
  test(`public Pi cancellation ${cancelBeforeReuse ? "before" : "after"} checkpoint reuse stays silent and preserves the next settled run`, () => runCancellation(cancelBeforeReuse));
}

async function runCancellation(cancelBeforeReuse: boolean): Promise<void> {
  const fixture = createScenario({ diagnosticsPersistence: "memory" });
  const agentDir = join(fixture.cwd, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(fixture.cwd, ".pi", "settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1 },
  }));
  const manager = SessionManager.create(fixture.cwd, join(fixture.cwd, "sessions"));
  manager.appendMessage(makeUserMessage("old history ".repeat(6_000)));
  const keptId = manager.appendMessage(makeUserMessage("kept history"));
  const snapshotId = manager.appendMessage(makeAssistantMessage("response before checkpoint"));
  const checkpoint = makeCheckpointData(manager.getSessionId(), snapshotId, keptId, {
    checkpointId: "host-cancellation-checkpoint",
  });
  manager.appendCustomEntry("pi-press.precompaction", checkpoint);
  fixture.faux.setResponses([
    () => fauxAssistantMessage("response before cancellation"),
    () => fauxAssistantMessage("response after cancellation"),
  ]);
  let session: AgentSession | undefined;
  let cancelNextCompaction = true;
  const cancelFirstCompaction = (pi: ExtensionAPI): void => {
    pi.on("session_before_compact", (event) => {
      if (cancelNextCompaction) {
        cancelNextCompaction = false;
        session!.abortCompaction();
        assert.equal(event.signal.aborted, true);
      }
    });
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(fixture.faux.provider);
  const settingsManager = SettingsManager.create(fixture.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: fixture.cwd,
    agentDir,
    settingsManager,
    extensionFactories: cancelBeforeReuse
      ? [cancelFirstCompaction, registerPiPress]
      : [registerPiPress, cancelFirstCompaction],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const notifications: Notification[] = [];
  const compactionOutcomes: boolean[] = [];

  try {
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: fixture.cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: manager,
      model: fixture.faux.getModel(),
      thinkingLevel: "off",
      noTools: "all",
    }));
    await session.bindExtensions({
      uiContext: {
        notify: (message: string, type?: Notification["type"]) => {
          notifications.push({ message, type });
        },
      } as unknown as ExtensionUIContext,
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionOutcomes.push(event.aborted);
      }
    });
    try {
      await session.prompt("continue before cancellation");
      await waitFor(() => compactionOutcomes.length === 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(compactionOutcomes, [true]);
      assert.equal(notifications.length, 0);
      assert.equal(manager.getBranch().some((entry) => entry.type === "compaction"), false);

      await session.prompt("continue after cancellation");
      await waitFor(() => manager.getBranch().some((entry) => entry.type === "compaction"));
      const formalEntry = manager.getBranch().find((entry) => entry.type === "compaction");
      assert.ok(formalEntry?.type === "compaction");
      assert.equal(formalEntry.summary, checkpoint.compaction.summary);
      assert.equal(
        (formalEntry.details as { piPress: { checkpointId: string } }).piPress.checkpointId,
        checkpoint.checkpointId,
      );
      assert.deepEqual(compactionOutcomes, [true, false]);
      assert.equal(notifications.some((item) => item.type === "warning"), false);
      assert.equal(fixture.faux.state.callCount, 2);
    } finally {
      unsubscribe();
    }
  } finally {
    session?.dispose();
    fixture.runtime.onSessionShutdown();
    rmSync(fixture.cwd, { recursive: true, force: true });
  }
}
