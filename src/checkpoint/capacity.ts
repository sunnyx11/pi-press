import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { MAX_SOFT_THRESHOLD_PERCENT } from "../config.js";
import type {
  CheckpointData,
  CompactionCapacityEstimate,
  CompactionPreparation,
} from "../types.js";

function sumMessageTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function makeSummaryEntry(
  data: CheckpointData,
  timestamp: string,
  systemMessage?: SystemMessage,
): CompactionEntry {
  const details = data.compaction.details;
  return {
    type: "compaction",
    id: `pi-press-capacity-${data.checkpointId}`,
    parentId: null,
    timestamp,
    summary: data.compaction.summary,
    firstKeptEntryId: data.compaction.firstKeptEntryId,
    tokensBefore: data.compaction.tokensBefore,
    ...(systemMessage === undefined ? {} : { systemMessage }),
    ...(data.compaction.usage === undefined
      ? {}
      : { usage: data.compaction.usage }),
    ...(details === undefined ? {} : { details }),
  };
}

export function checkpointToCompactionSummaryMessage(data: CheckpointData): AgentMessage | undefined {
  return sessionEntryToContextMessages(makeSummaryEntry(data, data.createdAt))
    .find((message) => message.role === "compactionSummary");
}

export type VirtualCheckpointCapacityEstimate = {
  estimatedTokens: number;
  hardLimit: number;
  refreshLimit: number;
  needsRefresh: boolean;
};

export type ContextCapacityLimits = {
  safetyMargin: number;
  hardLimit: number;
  refreshLimit: number;
};

/** 计算上下文容量检查共用的安全余量。 */
export function calculateContextSafetyMargin(contextWindow: number): number | undefined {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return Math.max(4_096, Math.ceil(contextWindow * 0.02));
}

/** 计算上下文容量上限与后台刷新阈值。 */
export function calculateContextCapacityLimits(
  contextWindow: number,
  reserveTokens: number,
  softThresholdPercent = MAX_SOFT_THRESHOLD_PERCENT,
): ContextCapacityLimits | undefined {
  const safetyMargin = calculateContextSafetyMargin(contextWindow);
  if (
    safetyMargin === undefined ||
    !Number.isFinite(reserveTokens) ||
    reserveTokens < 0 ||
    !Number.isFinite(softThresholdPercent) ||
    softThresholdPercent < 0 ||
    softThresholdPercent > MAX_SOFT_THRESHOLD_PERCENT
  ) {
    return undefined;
  }
  const hardLimit = Math.min(
    Math.floor((contextWindow * MAX_SOFT_THRESHOLD_PERCENT) / 100),
    contextWindow - reserveTokens - safetyMargin,
  );
  if (!Number.isFinite(hardLimit) || hardLimit <= 0) {
    return undefined;
  }
  const refreshLimit = Math.min(
    Math.floor((contextWindow * softThresholdPercent) / 100),
    hardLimit,
  );
  return {
    safetyMargin,
    hardLimit,
    refreshLimit,
  };
}

/** 计算请求前等待预压缩任务的 token 临界值。 */
export function calculateCriticalWaitTokens(
  contextWindow: number,
  piCompactionReserveTokens: number,
): number | undefined {
  return calculateContextCapacityLimits(contextWindow, piCompactionReserveTokens)?.hardLimit;
}

export function estimateVirtualCheckpointCapacity(
  data: CheckpointData,
  additionalMessages: readonly AgentMessage[],
  contextWindow: number,
  reserveTokens: number,
  softThresholdPercent: number,
  additionalTokens = 0,
): VirtualCheckpointCapacityEstimate | undefined {
  if (!Number.isFinite(additionalTokens) || additionalTokens < 0) {
    return undefined;
  }
  const limits = calculateContextCapacityLimits(
    contextWindow,
    reserveTokens,
    softThresholdPercent,
  );
  if (!limits) {
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
  return {
    estimatedTokens,
    hardLimit: limits.hardLimit,
    refreshLimit: limits.refreshLimit,
    needsRefresh: estimatedTokens >= limits.refreshLimit,
  };
}

/** 根据当前 preparation 模拟复用 checkpoint 后的上下文容量。 */
export function estimateCheckpointCapacity(
  branch: readonly SessionEntry[],
  data: CheckpointData,
  preparation: CompactionPreparation,
  contextWindow: number,
): CompactionCapacityEstimate | undefined {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const projection = buildSessionProjection([...branch]);
  const currentSystem = getCurrentSystemMessage(projection.messages);
  const currentMessages = [
    ...(currentSystem ? [currentSystem] : []),
    ...projection.messages.filter((message) => message.role !== "system"),
  ];
  const currentMessagesEstimatedTokens = sumMessageTokens(currentMessages);
  const fixedOverhead = Math.max(0, preparation.tokensBefore - currentMessagesEstimatedTokens);
  const summaryMessages = sessionEntryToContextMessages(
    makeSummaryEntry(data, "1970-01-01T00:00:00.000Z", currentSystem),
  );
  const summaryMessage = summaryMessages.find((message) => message.role === "compactionSummary");
  if (!summaryMessage) {
    return undefined;
  }

  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === data.compaction.firstKeptEntryId,
  );
  if (firstKeptIndex < 0) {
    return undefined;
  }
  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const keptMessages = projection.entries.flatMap((entry) => {
    const sourceIndex = indexById.get(entry.sourceEntry.id);
    if (sourceIndex === undefined || sourceIndex < firstKeptIndex) {
      return [];
    }
    return entry.messages.filter((message) => message.role !== "system");
  });
  const summaryEstimatedTokens = sumMessageTokens(summaryMessages);
  const keptMessagesEstimatedTokens = sumMessageTokens(keptMessages);
  const estimatedTokensAfter =
    fixedOverhead + summaryEstimatedTokens + keptMessagesEstimatedTokens;
  const reserveTokens = preparation.settings.reserveTokens;
  const safetyMargin = calculateContextSafetyMargin(contextWindow);
  if (safetyMargin === undefined || !Number.isFinite(reserveTokens) || reserveTokens < 0) {
    return undefined;
  }
  const limits = calculateContextCapacityLimits(
    contextWindow,
    reserveTokens,
  );
  const hardLimit = limits
    ? limits.hardLimit
    : Math.min(
      Math.floor((contextWindow * MAX_SOFT_THRESHOLD_PERCENT) / 100),
      contextWindow - reserveTokens - safetyMargin,
    );

  return {
    currentMessagesEstimatedTokens,
    fixedOverhead,
    summaryEstimatedTokens,
    keptMessagesEstimatedTokens,
    estimatedTokensAfter,
    safetyMargin,
    hardLimit,
    accepted: hardLimit > 0 && estimatedTokensAfter <= hardLimit,
  };
}
