import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { CheckpointData, CompactionPreparation } from "../../src/types.js";
import { estimateCheckpointCapacity } from "../../src/checkpoint/capacity.js";
import {
  createCheckpointPreparationSettings,
  createFormalizationPreparationSettings,
  prepareCompactionFromBranch,
} from "../../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { calculateOriginalTokensBefore } from "../../src/compaction/reuse.js";
import { makeCheckpointData, makePreparation, makeUsage, makeUserMessage } from "./fixtures.js";

function makeUsageAssistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "test",
    model: "model-id",
    usage: makeUsage(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

test("preparation preserves Pi metadata boundary and message selection", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test");
  const firstId = manager.appendMessage(
    makeUserMessage("old history that must be summarized ".repeat(2_000)),
  );
  manager.appendCustomEntry("pi-press.fixture", { state: true });
  const recentId = manager.appendMessage(
    makeUserMessage("recent work that stays ".repeat(2_000)),
  );
  const preparation = prepareCompactionFromBranch(
    manager.getBranch(),
    createCheckpointPreparationSettings(DEFAULT_CONFIG),
  );

  assert.ok(preparation);
  assert.equal(preparation.settings.keepRecentTokens, 10_000);
  assert.equal(preparation.messagesToSummarize.length, 0);
  assert.equal(preparation.turnPrefixMessages.length, 1);
  assert.equal(preparation.turnPrefixMessages[0]?.role, "user");
  assert.equal(preparation.firstKeptEntryId, manager.getBranch()[1]?.id);
  assert.notEqual(preparation.firstKeptEntryId, firstId);
  assert.equal(recentId, manager.getLeafId());
});

test("preparation carries previous summary and file operations into the next compaction", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test-continuous");
  const previousKeptId = manager.appendMessage(makeUserMessage("previous kept context"));
  manager.appendCompaction(
    "previous summary",
    previousKeptId,
    10_000,
    { readFiles: ["previous.ts"], modifiedFiles: ["changed.ts"] },
  );
  manager.appendMessage(makeUserMessage("edit the current file"));
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "current.ts" } }],
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
    toolName: "edit",
    content: [{ type: "text", text: "updated" }],
    details: {},
    isError: false,
    timestamp: Date.now(),
  });
  manager.appendMessage(makeUserMessage("continue the current turn"));
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

  const preparation = prepareCompactionFromBranch(
    manager.getBranch(),
    createCheckpointPreparationSettings(DEFAULT_CONFIG),
  );

  assert.ok(preparation);
  assert.equal(preparation.previousSummary, "previous summary");
  assert.equal(preparation.isSplitTurn, true);
  assert.deepEqual([...preparation.fileOps.read], ["previous.ts"]);
  assert.deepEqual([...preparation.fileOps.edited].sort(), ["changed.ts", "current.ts"]);
  assert.deepEqual([...preparation.fileOps.written], []);
  assert.equal(
    preparation.messagesToSummarize.some((message) => message.role === "toolResult"),
    true,
  );
});

test("preparation uses a checkpoint as the previous summary boundary", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test-incremental");
  manager.appendMessage(makeUserMessage("old history ".repeat(2_000)));
  const parentKeptId = manager.appendMessage(makeUserMessage("parent kept context"));
  const parentSnapshotId = manager.getLeafId();
  assert.ok(parentSnapshotId);
  const parent = makeCheckpointData(manager.getSessionId(), parentSnapshotId, parentKeptId, {
    checkpointId: "checkpoint-parent",
  });
  manager.appendCustomEntry("pi-press.precompaction", parent);
  manager.appendMessage(makeUserMessage("incremental history ".repeat(5_000)));
  manager.appendMessage(makeUserMessage("recent context ".repeat(1_000)));

  const prepareIncremental = prepareCompactionFromBranch as unknown as (
    entries: ReturnType<typeof manager.getBranch>,
    settings: ReturnType<typeof createCheckpointPreparationSettings>,
    parentCheckpoint: CheckpointData,
  ) => CompactionPreparation | undefined;
  const preparation = prepareIncremental(
    manager.getBranch(),
    createCheckpointPreparationSettings(DEFAULT_CONFIG),
    parent,
  );

  assert.ok(preparation);
  assert.equal(preparation.previousSummary, parent.compaction.summary);
  const summarizedMessages = [
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
  assert.equal(
    summarizedMessages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("old history"),
    ),
    false,
  );
  assert.equal(
    summarizedMessages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("parent kept context"),
    ),
    true,
  );
  assert.deepEqual([...preparation.fileOps.read], ["read.ts"]);
  assert.deepEqual([...preparation.fileOps.edited], ["write.ts"]);
});

test("preparation uses context-edited model content", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test-context-edits");
  const omittedId = manager.appendMessage(makeUserMessage("OMIT-ME ".repeat(100)));
  manager.appendMessage({
    ...makeUsageAssistant("old answer ".repeat(100)),
    timestamp: 2_000,
  });
  const replacedId = manager.appendMessage({
    ...makeUserMessage("REPLACE-ME ".repeat(100)),
    timestamp: 3_000,
  });
  manager.appendMessage({
    ...makeUsageAssistant("second answer ".repeat(100)),
    timestamp: 4_000,
  });
  manager.appendContextEdit(omittedId, null);
  manager.appendContextEdit(replacedId, { content: "EDITED-CONTENT ".repeat(100) });
  manager.appendMessage({ ...makeUserMessage("keep"), timestamp: 5_000 });
  manager.appendMessage({ ...makeUsageAssistant("suffix"), timestamp: 6_000 });

  const preparation = prepareCompactionFromBranch(
    manager.getBranch(),
    { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
  );

  assert.ok(preparation);
  const serialized = JSON.stringify([
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ]);
  assert.doesNotMatch(serialized, /OMIT-ME|REPLACE-ME/);
  assert.match(serialized, /EDITED-CONTENT/);
});

test("preparation advances recovery omissions without dropping their input", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test-recovery-omission");
  const userId = manager.appendMessage({
    ...makeUserMessage("recovery input ".repeat(100)),
    timestamp: 1_000,
  });
  const attemptId = manager.appendMessage({
    ...makeUsageAssistant("failed attempt"),
    timestamp: 2_000,
  });
  manager.appendContextEdit(attemptId, null);
  manager.appendCustomEntry("bookkeeping", { source: "test" });

  const preparation = prepareCompactionFromBranch(
    manager.getBranch(),
    { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
  );

  assert.ok(preparation);
  assert.equal(preparation.firstKeptEntryId, attemptId);
  assert.equal(preparation.turnPrefixMessages[0]?.role, "user");
  assert.equal(userId === attemptId, false);
});

test("checkpoint and formalization preparation settings use independent retention", () => {
  assert.equal(createCheckpointPreparationSettings(DEFAULT_CONFIG).keepRecentTokens, 10_000);
  assert.equal(createFormalizationPreparationSettings(DEFAULT_CONFIG, 30_000).keepRecentTokens, 30_000);
  assert.equal(
    createCheckpointPreparationSettings(DEFAULT_CONFIG).reserveTokens,
    createFormalizationPreparationSettings(DEFAULT_CONFIG, 30_000).reserveTokens,
  );
});

test("original token count uses context-edited tail messages", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test-edited-tail-tokens");
  const firstId = manager.appendMessage(makeUserMessage("old history"));
  const snapshotId = manager.appendMessage(makeUserMessage("snapshot"));
  const data = makeCheckpointData(manager.getSessionId(), snapshotId, firstId);
  data.compaction.tokensBefore = 1_000;
  manager.appendCustomEntry("pi-press.precompaction", data);
  const tailId = manager.appendMessage(makeUserMessage("ORIGINAL-TAIL ".repeat(1_000)));
  manager.appendContextEdit(tailId, { content: "edited tail" });

  assert.equal(
    calculateOriginalTokensBefore(data, manager.getBranch()),
    data.compaction.tokensBefore + estimateTokens({
      ...makeUserMessage("edited tail"),
      timestamp: manager.buildSessionProjection().messages.at(-1)?.timestamp ?? 0,
    }),
  );

  manager.appendContextEdit(tailId, null);
  assert.equal(
    calculateOriginalTokensBefore(data, manager.getBranch()),
    data.compaction.tokensBefore,
  );
});

test("capacity excludes retained messages omitted by context edits", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test-edited-retained-capacity");
  const oldId = manager.appendMessage(makeUserMessage("old history"));
  const keptId = manager.appendMessage(makeUserMessage("OMITTED-RETAINED ".repeat(1_000)));
  manager.appendContextEdit(keptId, null);
  const snapshotId = manager.getLeafId();
  assert.ok(snapshotId);
  const data = makeCheckpointData(manager.getSessionId(), snapshotId, keptId);
  const preparation = makePreparation(keptId, 100);

  const capacity = estimateCheckpointCapacity(
    manager.getBranch(),
    data,
    preparation,
    100_000,
  );

  assert.ok(capacity);
  assert.equal(capacity.keptMessagesEstimatedTokens, 0);
  assert.notEqual(oldId, keptId);
});

test("capacity estimate includes fixed overhead and rejects an impossible hard limit", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test");
  const firstId = manager.appendMessage(makeUserMessage("history"));
  const snapshotId = manager.appendMessage(makeUserMessage("recent"));
  const data = makeCheckpointData("session", snapshotId, firstId);
  manager.appendCustomEntry("pi-press.precompaction", data);
  const branch = manager.getBranch();
  const preparation = makePreparation(firstId, 100);
  const accepted = estimateCheckpointCapacity(branch, data, preparation, 100_000);
  assert.ok(accepted);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.fixedOverhead, 100 - accepted.currentMessagesEstimatedTokens);

  const rejected = estimateCheckpointCapacity(branch, data, preparation, 100);
  assert.ok(rejected);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.safetyMargin, 4096);
});
