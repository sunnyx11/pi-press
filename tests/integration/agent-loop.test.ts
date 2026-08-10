import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import registerPiPress from "../../src/index.js";
import { makeCheckpointData, makeUserMessage } from "../unit/fixtures.js";

test("public agent session applies virtual context and formalizes it after settlement", async () => {
  const cwd = mkdtempSync(join("/tmp", "pi-press-agent-loop-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "pi-press.json"),
    JSON.stringify({ precomputeMode: "threshold", summaryReserveTokens: 1 }),
  );

  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const oldId = manager.appendMessage(makeUserMessage("old history"));
  for (let index = 0; index < 40; index += 1) {
    manager.appendMessage(makeUserMessage(`old history ${index} `.repeat(1_000)));
  }
  const keptId = manager.appendMessage(makeUserMessage("kept history"));
  const snapshotId = manager.appendMessage(makeUserMessage("snapshot history"));
  const faux = fauxProvider({
    api: "openai-responses",
    provider: "test",
    models: [{ id: "model-id", contextWindow: 100_000, maxTokens: 4_096 }],
  });
  const observedContexts: Context[] = [];
  faux.setResponses([
    (context) => {
      observedContexts.push(context);
      return fauxAssistantMessage("agent response");
    },
  ]);
  const checkpoint = makeCheckpointData(manager.getSessionId(), snapshotId, keptId, {
    checkpointId: "agent-loop-checkpoint",
    estimatedTokensAfterAtSnapshot: 100,
    compaction: {
      summary: "virtual summary",
      firstKeptEntryId: keptId,
      tokensBefore: 1_000,
    },
  });
  manager.appendCustomEntry("pi-press.precompaction", checkpoint);

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [registerPiPress],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  try {
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: manager,
      model: faux.getModel(),
      thinkingLevel: "off",
      noTools: "all",
    });

    try {
      assert.ok(oldId);
      await session.prompt("continue the task");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        manager.getBranch().some((entry) => entry.type === "compaction"),
        `entries=${JSON.stringify(manager.getBranch().map((entry) => entry.type))} contexts=${observedContexts.length}`,
      );

      assert.equal(observedContexts.length, 1);
      const requestMessages = observedContexts[0]?.messages ?? [];
      assert.equal(requestMessages[0]?.role, "user");
      const firstText = requestMessages[0]?.content;
      assert.ok(Array.isArray(firstText));
      assert.match(firstText[0]?.type === "text" ? firstText[0].text : "", /virtual summary/);
      assert.equal(
        requestMessages.some(
          (message) => message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === "text" && block.text === "old history"),
        ),
        false,
      );
      assert.equal(
        manager.getBranch().some(
          (entry) => entry.type === "compaction" &&
            entry.details &&
            typeof entry.details === "object" &&
            "piPress" in entry.details &&
            (entry.details as { piPress?: { checkpointId?: string } }).piPress?.checkpointId ===
              "agent-loop-checkpoint",
        ),
        true,
      );
      assert.equal(session.state.messages[0]?.role, "compactionSummary");
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      const reloaded = SessionManager.open(sessionFile);
      assert.equal(reloaded.getSessionId(), manager.getSessionId());
      assert.equal(reloaded.buildSessionContext().messages[0]?.role, "compactionSummary");
      assert.equal(
        reloaded.getBranch().some(
          (entry) => entry.type === "compaction" &&
            entry.details &&
            typeof entry.details === "object" &&
            "piPress" in entry.details &&
            (entry.details as { piPress?: { checkpointId?: string } }).piPress?.checkpointId ===
              "agent-loop-checkpoint",
        ),
        true,
      );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
