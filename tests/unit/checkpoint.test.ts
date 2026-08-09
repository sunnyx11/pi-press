import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  findReadyCheckpointCandidates,
  getConsumedCheckpointIds,
  getEpochCompactionId,
  getSnapshotSourceLeafId,
} from "../../src/checkpoint/selection.js";
import { parseCheckpointData } from "../../src/checkpoint/schema.js";
import { makeCheckpointData, makeMessageEntry, makeUserMessage } from "./fixtures.js";

function makeBranch(): { branch: SessionEntry[]; data: ReturnType<typeof makeCheckpointData> } {
  const first = makeMessageEntry("entry-1", null, makeUserMessage("old history"));
  const snapshot = makeMessageEntry("entry-2", "entry-1", makeUserMessage("recent work"));
  const data = makeCheckpointData("session", snapshot.id, first.id);
  const checkpoint: SessionEntry = {
    type: "custom",
    id: "entry-3",
    parentId: snapshot.id,
    timestamp: "2026-01-01T00:00:03.000Z",
    customType: "pi-press.precompaction",
    data,
  };
  return { branch: [first, snapshot, checkpoint], data };
}

test("checkpoint schema accepts v3 and rejects unsupported or malformed data", () => {
  const { branch, data } = makeBranch();
  assert.deepEqual(parseCheckpointData(data)?.checkpointId, "checkpoint-1");
  assert.equal(parseCheckpointData({ ...data, version: 2 }), undefined);
  assert.equal(parseCheckpointData({ ...data, compaction: { ...data.compaction, summary: "" } }), undefined);
  assert.equal(parseCheckpointData({ ...data, estimatedTokensAfterAtSnapshot: Number.NaN }), undefined);
  assert.ok(parseCheckpointData(data, { piVersion: "0.84.1" }));
  assert.ok(branch.length > 0);
});

test("checkpoint schema rejects excessive nesting without throwing", () => {
  const { data } = makeBranch();
  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 20_000; depth += 1) {
    nested = { nested };
  }
  const value = {
    ...data,
    compaction: {
      ...data.compaction,
      details: { nested },
    },
  };

  let parsed: ReturnType<typeof parseCheckpointData>;
  assert.doesNotThrow(() => {
    parsed = parseCheckpointData(value);
  });
  assert.equal(parsed, undefined);
});

test("selection requires current session, epoch and branch ancestry", () => {
  const { branch, data } = makeBranch();
  const candidates = findReadyCheckpointCandidates(branch, "session", null, undefined);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.data.checkpointId, data.checkpointId);
  assert.equal(findReadyCheckpointCandidates(branch, "other", null, undefined).length, 0);
  assert.equal(findReadyCheckpointCandidates(branch, "session", "compaction-1", undefined).length, 0);
  assert.equal(findReadyCheckpointCandidates(branch, "session", null, data.checkpointId).length, 0);
});

test("formal compaction details mark a checkpoint as consumed", () => {
  const { branch, data } = makeBranch();
  const compaction: SessionEntry = {
    type: "compaction",
    id: "entry-4",
    parentId: "entry-3",
    timestamp: "2026-01-01T00:00:04.000Z",
    summary: "formal summary",
    firstKeptEntryId: "entry-1",
    tokensBefore: 100,
    details: { piPress: { checkpointId: data.checkpointId } },
  };
  const nextBranch = [...branch, compaction];
  assert.deepEqual([...getConsumedCheckpointIds(nextBranch)], [data.checkpointId]);
  assert.equal(findReadyCheckpointCandidates(nextBranch, "session", "entry-4", undefined).length, 0);
  assert.equal(getEpochCompactionId(nextBranch), "entry-4");
  assert.equal(getSnapshotSourceLeafId(nextBranch), "entry-4");
});
