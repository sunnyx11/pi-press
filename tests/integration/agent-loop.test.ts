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
  type ExtensionAPI,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createCheckpointPreparationSettings,
  prepareCompactionFromBranch,
} from "../../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import registerPiPress from "../../src/index.js";
import { waitFor } from "../runtime-fixture.js";
import { makeCheckpointData, makeUsage, makeUserMessage } from "../unit/fixtures.js";

test("public agent session applies virtual context and formalizes it after settlement", async () => {
  const cwd = mkdtempSync(join("/tmp", "pi-press-agent-loop-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "pi-press.json"),
    JSON.stringify({
      precomputeMode: "threshold",
      summaryReserveTokens: 1,
    }),
  );
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: 1,
        keepRecentTokens: 30_000,
      },
    }),
  );

  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const oldId = manager.appendMessage(makeUserMessage("old history"));
  for (let index = 0; index < 5; index += 1) {
    manager.appendMessage(makeUserMessage(`old history ${index} `.repeat(1_000)));
  }
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Thinking-1: decorated history" },
      { type: "text", text: "historical response" },
    ],
    api: "openai-responses",
    provider: "test",
    model: "model-id",
    usage: makeUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  });
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
      return fauxAssistantMessage("first agent response");
    },
    (context) => {
      observedContexts.push(context);
      return fauxAssistantMessage("second agent response");
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
  const stripThinkingLabels = (pi: ExtensionAPI): void => {
    pi.on("context", (event) => {
      for (const message of event.messages) {
        if (message.role !== "assistant") {
          continue;
        }
        for (const block of message.content) {
          if (block.type === "thinking") {
            block.thinking = block.thinking.replace(/^Thinking-1:\s*/, "");
          }
        }
      }
    });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [stripThinkingLabels, registerPiPress],
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
      const compactionEndErrors: string[] = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "compaction_end" && event.errorMessage) {
          compactionEndErrors.push(event.errorMessage);
        }
      });
      assert.ok(oldId);
      try {
        await session.prompt("continue the task");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          manager.getBranch().some((entry) => entry.type === "compaction"),
          false,
        );
        assert.deepEqual(compactionEndErrors, []);

        await session.prompt("additional history ".repeat(8_000));
        await waitFor(
          () => manager.getBranch().some((entry) => entry.type === "compaction"),
        );
      } finally {
        unsubscribe();
      }

      assert.equal(observedContexts.length, 2);
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

test("preparation adapter matches Pi public compaction event for split turns and metadata", async () => {
  const cwd = mkdtempSync(join("/tmp", "pi-press-preparation-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: DEFAULT_CONFIG.summaryReserveTokens,
        keepRecentTokens: 10_000,
      },
    }),
  );

  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendMessage(makeUserMessage("inspect the old file"));
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "old.ts" } }],
    api: "openai-responses",
    provider: "test",
    model: "model-id",
    usage: makeUsage(200),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "old file contents" }],
    details: {},
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendMessage(makeUserMessage("continue with the current task"));
  const metadataId = manager.appendCustomEntry("fixture.metadata", { state: true });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "current progress ".repeat(4_000) }],
    api: "openai-responses",
    provider: "test",
    model: "model-id",
    usage: makeUsage(100),
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const branchBeforeCompaction = manager.getBranch();
  const adapterPreparation = prepareCompactionFromBranch(
    branchBeforeCompaction,
    createCheckpointPreparationSettings(DEFAULT_CONFIG),
  );
  assert.ok(adapterPreparation);

  let publicPreparation: SessionBeforeCompactEvent["preparation"] | undefined;
  const capturePreparation = (pi: ExtensionAPI): void => {
    pi.on("session_before_compact", (event) => {
      publicPreparation = event.preparation;
      return {
        compaction: {
          summary: "captured preparation",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });
  };
  const faux = fauxProvider({
    api: "openai-responses",
    provider: "test",
    models: [{ id: "model-id", contextWindow: 100_000, maxTokens: 4_096 }],
  });
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
    extensionFactories: [capturePreparation],
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
      await session.compact();
      assert.ok(publicPreparation);
      assert.equal(publicPreparation.firstKeptEntryId, metadataId);
      assert.equal(publicPreparation.firstKeptEntryId, adapterPreparation.firstKeptEntryId);
      assert.deepEqual(publicPreparation.messagesToSummarize, adapterPreparation.messagesToSummarize);
      assert.deepEqual(publicPreparation.turnPrefixMessages, adapterPreparation.turnPrefixMessages);
      assert.equal(publicPreparation.isSplitTurn, adapterPreparation.isSplitTurn);
      assert.equal(publicPreparation.tokensBefore, adapterPreparation.tokensBefore);
      assert.equal(publicPreparation.previousSummary, adapterPreparation.previousSummary);
      assert.deepEqual(publicPreparation.settings, adapterPreparation.settings);
      assert.deepEqual(
        {
          read: [...publicPreparation.fileOps.read],
          written: [...publicPreparation.fileOps.written],
          edited: [...publicPreparation.fileOps.edited],
        },
        {
          read: [...adapterPreparation.fileOps.read],
          written: [...adapterPreparation.fileOps.written],
          edited: [...adapterPreparation.fileOps.edited],
        },
      );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
