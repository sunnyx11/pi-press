import {
  buildSessionContext,
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  CheckpointCandidate,
  CompactionCapacityEstimate,
  CompactionPreparation,
} from "../types.js";

function sumMessageTokens(messages: ReturnType<typeof buildSessionContext>["messages"]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function makeSummaryEntry(candidate: CheckpointCandidate): CompactionEntry {
  const details = candidate.data.compaction.details;
  return {
    type: "compaction",
    id: `pi-press-capacity-${candidate.data.checkpointId}`,
    parentId: null,
    timestamp: "1970-01-01T00:00:00.000Z",
    summary: candidate.data.compaction.summary,
    firstKeptEntryId: candidate.data.compaction.firstKeptEntryId,
    tokensBefore: candidate.data.compaction.tokensBefore,
    ...(candidate.data.compaction.usage === undefined
      ? {}
      : { usage: candidate.data.compaction.usage }),
    ...(details === undefined ? {} : { details }),
  };
}

/** 根据当前 preparation 模拟复用 checkpoint 后的上下文容量。 */
export function estimateCheckpointCapacity(
  branch: readonly SessionEntry[],
  candidate: CheckpointCandidate,
  preparation: CompactionPreparation,
  contextWindow: number,
  targetPostCompactionPercent: number,
): CompactionCapacityEstimate | undefined {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const currentMessages = buildSessionContext([...branch]).messages;
  const currentMessagesEstimatedTokens = sumMessageTokens(currentMessages);
  const fixedOverhead = Math.max(0, preparation.tokensBefore - currentMessagesEstimatedTokens);
  const summaryMessage = sessionEntryToContextMessages(makeSummaryEntry(candidate))[0];
  if (!summaryMessage) {
    return undefined;
  }

  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === candidate.data.compaction.firstKeptEntryId,
  );
  if (firstKeptIndex < 0) {
    return undefined;
  }
  const keptMessages = branch
    .slice(firstKeptIndex)
    .flatMap((entry) => sessionEntryToContextMessages(entry));
  const summaryEstimatedTokens = estimateTokens(summaryMessage);
  const keptMessagesEstimatedTokens = sumMessageTokens(keptMessages);
  const estimatedTokensAfter =
    fixedOverhead + summaryEstimatedTokens + keptMessagesEstimatedTokens;
  const safetyMargin = Math.max(4096, Math.ceil(contextWindow * 0.02));
  const hardLimit = contextWindow - preparation.settings.reserveTokens - safetyMargin;
  const targetLimit = Math.floor((contextWindow * targetPostCompactionPercent) / 100);
  const acceptLimit = Math.min(hardLimit, targetLimit);

  return {
    currentMessagesEstimatedTokens,
    fixedOverhead,
    summaryEstimatedTokens,
    keptMessagesEstimatedTokens,
    estimatedTokensAfter,
    safetyMargin,
    hardLimit,
    targetLimit,
    acceptLimit,
    accepted: estimatedTokensAfter <= acceptLimit,
  };
}
