import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { CheckpointData, CompactionPreparation } from "../../src/types.js";
import { estimateCheckpointCapacity } from "../../src/checkpoint/capacity.js";
import { createPreparationSettings, prepareCompactionFromBranch } from "../../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { makeCheckpointData, makePreparation, makeUsage, makeUserMessage } from "./fixtures.js";

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
    createPreparationSettings(DEFAULT_CONFIG),
  );

  assert.ok(preparation);
  assert.equal(preparation.settings.keepRecentTokens, 2_000);
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
    content: [{ type: "text", text: "current progress ".repeat(1_000) }],
    api: "openai-responses",
    provider: "test",
    model: "model-id",
    usage: makeUsage(100),
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const preparation = prepareCompactionFromBranch(
    manager.getBranch(),
    createPreparationSettings(DEFAULT_CONFIG),
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
  manager.appendMessage(makeUserMessage("incremental history ".repeat(2_000)));
  manager.appendMessage(makeUserMessage("recent context ".repeat(1_000)));

  const prepareIncremental = prepareCompactionFromBranch as unknown as (
    entries: ReturnType<typeof manager.getBranch>,
    settings: ReturnType<typeof createPreparationSettings>,
    parentCheckpoint: CheckpointData,
  ) => CompactionPreparation | undefined;
  const preparation = prepareIncremental(
    manager.getBranch(),
    createPreparationSettings(DEFAULT_CONFIG),
    parent,
  );

  assert.ok(preparation);
  assert.equal(preparation.previousSummary, parent.compaction.summary);
  assert.equal(
    preparation.messagesToSummarize.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("old history"),
    ),
    false,
  );
  assert.equal(
    preparation.messagesToSummarize.some(
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
