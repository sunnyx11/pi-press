import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  checkpointToCompactionSummaryMessage,
  estimateVirtualCheckpointCapacity,
} from "../checkpoint/capacity.js";
import type { CheckpointData } from "../types.js";

export interface VirtualContextProjectionInput {
  branch: readonly SessionEntry[];
  eventMessages: readonly AgentMessage[];
  checkpoint: CheckpointData;
  contextWindow: number;
  summaryReserveTokens: number;
  targetPostCompactionPercent: number;
}

export interface VirtualContextProjection {
  messages: AgentMessage[];
  estimatedTokens: number;
  hardLimit: number;
  targetLimit: number;
  needsRefresh: boolean;
}

type SourceMessage = {
  branchIndex: number;
  message: AgentMessage;
};

function messageKey(message: AgentMessage): string | undefined {
  try {
    const value = JSON.stringify(message);
    return value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

function findEarliestMatches(
  sourceKeys: readonly string[],
  eventKeys: readonly (string | undefined)[],
): number[] | undefined {
  const matches: number[] = [];
  let eventIndex = 0;
  for (const sourceKey of sourceKeys) {
    while (eventIndex < eventKeys.length && eventKeys[eventIndex] !== sourceKey) {
      eventIndex += 1;
    }
    if (eventIndex >= eventKeys.length) {
      return undefined;
    }
    matches.push(eventIndex);
    eventIndex += 1;
  }
  return matches;
}

function findLatestMatches(
  sourceKeys: readonly string[],
  eventKeys: readonly (string | undefined)[],
): number[] | undefined {
  const matches = new Array<number>(sourceKeys.length);
  let eventIndex = eventKeys.length - 1;
  for (let sourceIndex = sourceKeys.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const sourceKey = sourceKeys[sourceIndex];
    while (eventIndex >= 0 && eventKeys[eventIndex] !== sourceKey) {
      eventIndex -= 1;
    }
    if (eventIndex < 0) {
      return undefined;
    }
    matches[sourceIndex] = eventIndex;
    eventIndex -= 1;
  }
  return matches;
}

function collectSourceMessages(branch: readonly SessionEntry[]): SourceMessage[] {
  const activeEntries = buildContextEntries([...branch]);
  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const messages: SourceMessage[] = [];
  for (const entry of activeEntries) {
    const branchIndex = indexById.get(entry.id);
    if (branchIndex === undefined) {
      continue;
    }
    for (const message of sessionEntryToContextMessages(entry)) {
      messages.push({ branchIndex, message });
    }
  }
  return messages;
}

/**
 * 将有效 checkpoint 投影为当前 provider 请求使用的虚拟上下文。
 * 返回 undefined 表示边界无法映射或消息容量超过 hard limit。
 */
export function projectCheckpointToVirtualContext(
  input: VirtualContextProjectionInput,
): VirtualContextProjection | undefined {
  const {
    branch,
    eventMessages,
    checkpoint,
    contextWindow,
    summaryReserveTokens,
    targetPostCompactionPercent,
  } = input;
  if (
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(summaryReserveTokens) ||
    summaryReserveTokens < 0 ||
    !Number.isFinite(targetPostCompactionPercent) ||
    targetPostCompactionPercent < 0 ||
    targetPostCompactionPercent > 100
  ) {
    return undefined;
  }

  const snapshotIndex = branch.findIndex((entry) => entry.id === checkpoint.snapshotLeafId);
  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === checkpoint.compaction.firstKeptEntryId,
  );
  if (snapshotIndex < 0 || firstKeptIndex < 0 || firstKeptIndex > snapshotIndex) {
    return undefined;
  }

  const sourceMessages = collectSourceMessages(branch);
  const firstKeptSourceIndex = sourceMessages.findIndex(
    (source) => source.branchIndex >= firstKeptIndex,
  );
  if (firstKeptSourceIndex < 0 && sourceMessages.some((source) => source.branchIndex >= firstKeptIndex)) {
    return undefined;
  }
  const boundarySourceIndex = firstKeptSourceIndex < 0 ? sourceMessages.length : firstKeptSourceIndex;
  const sourceKeys = sourceMessages
    .map((source) => messageKey(source.message));
  if (sourceKeys.some((key) => key === undefined)) {
    return undefined;
  }
  const eventKeys = eventMessages.map(messageKey);
  const earliestMatches = findEarliestMatches(sourceKeys as string[], eventKeys);
  const latestMatches = findLatestMatches(sourceKeys as string[], eventKeys);
  if (!earliestMatches || !latestMatches) {
    return undefined;
  }

  const boundaryEventIndex = boundarySourceIndex >= sourceMessages.length
    ? (earliestMatches.length === 0 ? 0 : earliestMatches[earliestMatches.length - 1]! + 1)
    : earliestMatches[boundarySourceIndex]!;
  const latestBoundaryEventIndex = boundarySourceIndex >= sourceMessages.length
    ? (latestMatches.length === 0 ? 0 : latestMatches[latestMatches.length - 1]! + 1)
    : latestMatches[boundarySourceIndex]!;
  if (boundaryEventIndex !== latestBoundaryEventIndex) {
    return undefined;
  }

  const matchedSourceByEvent = new Map<number, number>();
  for (let sourceIndex = 0; sourceIndex < earliestMatches.length; sourceIndex += 1) {
    matchedSourceByEvent.set(earliestMatches[sourceIndex]!, sourceIndex);
  }
  const summaryMessage = checkpointToCompactionSummaryMessage(checkpoint);
  if (!summaryMessage) {
    return undefined;
  }

  const messages: AgentMessage[] = [];
  for (let eventIndex = 0; eventIndex < eventMessages.length; eventIndex += 1) {
    if (eventIndex === boundaryEventIndex) {
      messages.push(summaryMessage);
    }
    const sourceIndex = matchedSourceByEvent.get(eventIndex);
    if (sourceIndex !== undefined && sourceIndex < boundarySourceIndex) {
      continue;
    }
    messages.push(eventMessages[eventIndex]!);
  }
  if (boundaryEventIndex === eventMessages.length) {
    messages.push(summaryMessage);
  }

  let lastPreSnapshotEventIndex = -1;
  for (let sourceIndex = 0; sourceIndex < sourceMessages.length; sourceIndex += 1) {
    if (sourceMessages[sourceIndex]!.branchIndex <= snapshotIndex) {
      lastPreSnapshotEventIndex = Math.max(
        lastPreSnapshotEventIndex,
        earliestMatches[sourceIndex]!,
      );
    }
  }
  const tailStart = lastPreSnapshotEventIndex + 1;
  const trailingMessages = eventMessages.slice(tailStart);
  const capacity = estimateVirtualCheckpointCapacity(
    checkpoint,
    trailingMessages,
    contextWindow,
    summaryReserveTokens,
    targetPostCompactionPercent,
  );
  if (!capacity || capacity.estimatedTokens > capacity.hardLimit) {
    return undefined;
  }

  return {
    messages,
    estimatedTokens: capacity.estimatedTokens,
    hardLimit: capacity.hardLimit,
    targetLimit: capacity.targetLimit,
    needsRefresh: capacity.needsRefresh,
  };
}
