import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectCheckpointToVirtualContext } from "../../src/compaction/virtual-context.js";
import { makeCheckpointData, makeUserMessage } from "./fixtures.js";

test("virtual context replaces the summarized prefix and preserves the current tail", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-virtual-context");
  const oldId = manager.appendMessage(makeUserMessage("old history"));
  const keptId = manager.appendMessage(makeUserMessage("kept message"));
  const snapshotId = manager.appendMessage(makeUserMessage("snapshot message"));
  manager.appendCustomEntry("pi-press.precompaction", { checkpoint: true });
  manager.appendMessage(makeUserMessage("new tail"));

  const eventMessages = manager.buildSessionContext().messages;
  const originalMessages = structuredClone(eventMessages);
  const data = makeCheckpointData(manager.getSessionId(), snapshotId, keptId, {
    checkpointId: "virtual-checkpoint",
    estimatedTokensAfterAtSnapshot: 100,
    compaction: {
      summary: "compressed history",
      firstKeptEntryId: keptId,
      tokensBefore: 1_000,
    },
  });

  const result = projectCheckpointToVirtualContext({
    branch: manager.getBranch(),
    eventMessages,
    checkpoint: data,
    contextWindow: 100_000,
    summaryReserveTokens: 1,
    targetPostCompactionPercent: 50,
  });

  assert.ok(result);
  assert.equal(result.messages[0]?.role, "compactionSummary");
  assert.equal(
    (result.messages[0] as { summary: string }).summary,
    "compressed history",
  );
  assert.deepEqual(
    result.messages.slice(1).map((message) => message.role === "user" ? message.content : message.role),
    ["kept message", "snapshot message", "new tail"],
  );
  assert.deepEqual(eventMessages, originalMessages);
  assert.notEqual(result.messages, eventMessages);
  assert.equal(oldId.length > 0, true);
});

test("virtual context keeps an unmatched message from another context handler", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-virtual-context-extra");
  const oldId = manager.appendMessage(makeUserMessage("old history"));
  const keptId = manager.appendMessage(makeUserMessage("kept message"));
  const snapshotId = manager.appendMessage(makeUserMessage("snapshot message"));
  manager.appendCustomEntry("pi-press.precompaction", { checkpoint: true });
  manager.appendMessage(makeUserMessage("new tail"));

  const baseMessages = manager.buildSessionContext().messages;
  const injected: AgentMessage = makeUserMessage("injected by another extension");
  const eventMessages = [baseMessages[0]!, injected, ...baseMessages.slice(1)];
  const data = makeCheckpointData(manager.getSessionId(), snapshotId, keptId, {
    checkpointId: "virtual-checkpoint-extra",
    estimatedTokensAfterAtSnapshot: 100,
    compaction: {
      summary: "compressed history",
      firstKeptEntryId: keptId,
      tokensBefore: 1_000,
    },
  });

  const result = projectCheckpointToVirtualContext({
    branch: manager.getBranch(),
    eventMessages,
    checkpoint: data,
    contextWindow: 100_000,
    summaryReserveTokens: 1,
    targetPostCompactionPercent: 50,
  });

  assert.ok(result);
  assert.equal(
    result.messages.some(
      (message) => message.role === "user" && message.content === "injected by another extension",
    ),
    true,
  );
  assert.equal(oldId.length > 0, true);
});

test("virtual context refuses an ambiguous duplicate at the compaction boundary", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-virtual-context-ambiguous");
  manager.appendMessage(makeUserMessage("old history"));
  const keptId = manager.appendMessage(makeUserMessage("kept message"));
  const snapshotId = manager.appendMessage(makeUserMessage("snapshot message"));
  manager.appendCustomEntry("pi-press.precompaction", { checkpoint: true });
  manager.appendMessage(makeUserMessage("new tail"));

  const baseMessages = manager.buildSessionContext().messages;
  const eventMessages = [baseMessages[0]!, baseMessages[1]!, baseMessages[1]!, ...baseMessages.slice(2)];
  const data = makeCheckpointData(manager.getSessionId(), snapshotId, keptId, {
    checkpointId: "virtual-checkpoint-ambiguous",
    estimatedTokensAfterAtSnapshot: 100,
    compaction: {
      summary: "compressed history",
      firstKeptEntryId: keptId,
      tokensBefore: 1_000,
    },
  });

  const result = projectCheckpointToVirtualContext({
    branch: manager.getBranch(),
    eventMessages,
    checkpoint: data,
    contextWindow: 100_000,
    summaryReserveTokens: 1,
    targetPostCompactionPercent: 50,
  });

  assert.equal(result, undefined);
});

test("virtual context returns no projection when the hard limit is exceeded", () => {
  const manager = SessionManager.inMemory("/tmp/pi-press-virtual-context-capacity");
  const oldId = manager.appendMessage(makeUserMessage("old history"));
  const keptId = manager.appendMessage(makeUserMessage("kept message"));
  const snapshotId = manager.appendMessage(makeUserMessage("snapshot message"));
  manager.appendCustomEntry("pi-press.precompaction", { checkpoint: true });
  manager.appendMessage(makeUserMessage("x".repeat(30_000)));

  const data = makeCheckpointData(manager.getSessionId(), snapshotId, keptId, {
    checkpointId: "virtual-checkpoint-capacity",
    estimatedTokensAfterAtSnapshot: 90,
    compaction: {
      summary: "compressed history",
      firstKeptEntryId: keptId,
      tokensBefore: 1_000,
    },
  });

  const result = projectCheckpointToVirtualContext({
    branch: manager.getBranch(),
    eventMessages: manager.buildSessionContext().messages,
    checkpoint: data,
    contextWindow: 10_000,
    summaryReserveTokens: 1,
    targetPostCompactionPercent: 50,
  });

  assert.equal(result, undefined);
  assert.equal(oldId.length > 0, true);
});
