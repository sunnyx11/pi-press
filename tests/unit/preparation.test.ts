import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { estimateCheckpointCapacity } from "../../src/checkpoint/capacity.js";
import { createPreparationSettings, prepareCompactionFromBranch } from "../../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { CheckpointCandidate } from "../../src/types.js";
import { makeCheckpointData, makePreparation, makeUserMessage } from "./fixtures.js";

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

test("capacity estimate includes fixed overhead and rejects an impossible limit", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-test");
  const firstId = manager.appendMessage(makeUserMessage("history"));
  const snapshotId = manager.appendMessage(makeUserMessage("recent"));
  const data = makeCheckpointData("session", snapshotId, firstId);
  const checkpointEntry = manager.appendCustomEntry("pi-press.precompaction", data);
  const branch = manager.getBranch();
  const candidate: CheckpointCandidate = {
    entry: branch.find((entry) => entry.id === checkpointEntry) as Extract<typeof branch[number], { type: "custom" }>,
    data,
  };
  const preparation = makePreparation(firstId, 100);
  const accepted = estimateCheckpointCapacity(branch, candidate, preparation, 100_000, 50);
  assert.ok(accepted);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.fixedOverhead, 100 - accepted.currentMessagesEstimatedTokens);

  const rejected = estimateCheckpointCapacity(branch, candidate, preparation, 100, 50);
  assert.ok(rejected);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.safetyMargin, 4096);
});
