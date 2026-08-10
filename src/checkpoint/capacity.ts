import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  CheckpointData,
  CompactionCapacityEstimate,
  CompactionPreparation,
} from "../types.js";

function sumMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function makeSummaryEntry(data: CheckpointData, timestamp: string): CompactionEntry {
  const details = data.compaction.details;
  return {
    type: "compaction",
    id: `pi-press-capacity-${data.checkpointId}`,
    parentId: null,
    timestamp,
    summary: data.compaction.summary,
    firstKeptEntryId: data.compaction.firstKeptEntryId,
    tokensBefore: data.compaction.tokensBefore,
    ...(data.compaction.usage === undefined
      ? {}
      : { usage: data.compaction.usage }),
    ...(details === undefined ? {} : { details }),
  };
}

export function checkpointToCompactionSummaryMessage(data: CheckpointData): AgentMessage | undefined {
  return sessionEntryToContextMessages(makeSummaryEntry(data, data.createdAt))[0];
}

export type VirtualCheckpointCapacityEstimate = {
  estimatedTokens: number;
  hardLimit: number;
  targetLimit: number;
  needsRefresh: boolean;
};

export function estimateVirtualCheckpointCapacity(
  data: CheckpointData,
  additionalMessages: readonly AgentMessage[],
  contextWindow: number,
  summaryReserveTokens: number,
  targetPostCompactionPercent: number,
  additionalTokens = 0,
): VirtualCheckpointCapacityEstimate | undefined {
  if (
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(summaryReserveTokens) ||
    summaryReserveTokens < 0 ||
    !Number.isFinite(targetPostCompactionPercent) ||
    targetPostCompactionPercent < 0 ||
    targetPostCompactionPercent > 100 ||
    !Number.isFinite(additionalTokens) ||
    additionalTokens < 0
  ) {
    return undefined;
  }
  const summaryMessage = checkpointToCompactionSummaryMessage(data);
  if (!summaryMessage) {
    return undefined;
  }
  const estimatedTokens =
    data.estimatedTokensAfterAtSnapshot +
    sumMessageTokens(additionalMessages) +
    additionalTokens;
  const safetyMargin = Math.max(4096, Math.ceil(contextWindow * 0.02));
  const hardLimit = contextWindow - summaryReserveTokens - safetyMargin;
  const targetLimit = Math.floor((contextWindow * targetPostCompactionPercent) / 100);
  return {
    estimatedTokens,
    hardLimit,
    targetLimit,
    needsRefresh: estimatedTokens > targetLimit,
  };
}

/** 根据当前 preparation 模拟复用 checkpoint 后的上下文容量。 */
export function estimateCheckpointCapacity(
  branch: readonly SessionEntry[],
  data: CheckpointData,
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
  const summaryMessage = sessionEntryToContextMessages(
    makeSummaryEntry(data, "1970-01-01T00:00:00.000Z"),
  )[0];
  if (!summaryMessage) {
    return undefined;
  }

  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === data.compaction.firstKeptEntryId,
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
