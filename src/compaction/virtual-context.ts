import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  estimateTokens,
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

function messageIdentityKey(message: AgentMessage): string | undefined {
  if (!Number.isFinite(message.timestamp)) {
    return undefined;
  }
  switch (message.role) {
    case "user":
    case "assistant":
      return JSON.stringify([message.role, message.timestamp]);
    case "toolResult":
      return JSON.stringify([
        message.role,
        message.timestamp,
        message.toolCallId,
        message.toolName,
      ]);
    case "bashExecution":
      return JSON.stringify([message.role, message.timestamp, message.command]);
    case "custom":
      return JSON.stringify([message.role, message.timestamp, message.customType]);
    case "branchSummary":
      return JSON.stringify([message.role, message.timestamp, message.fromId]);
    case "compactionSummary":
      return JSON.stringify([message.role, message.timestamp, message.tokensBefore]);
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

function estimateMessageTokenGrowth(
  sourceMessage: AgentMessage,
  eventMessage: AgentMessage,
): number | undefined {
  try {
    const sourceTokens = estimateTokens(sourceMessage);
    const eventTokens = estimateTokens(eventMessage);
    if (!Number.isFinite(sourceTokens) || !Number.isFinite(eventTokens)) {
      return undefined;
    }
    return Math.max(0, eventTokens - sourceTokens);
  } catch {
    return undefined;
  }
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

export type VirtualContextProjectionAttempt =
  | { status: "projected"; projection: VirtualContextProjection }
  | { status: "unavailable" }
  | { status: "hard-limit" };

/**
 * 将有效 checkpoint 投影为当前 provider 请求使用的虚拟上下文，并保留容量拒绝原因。
 */
export function tryProjectCheckpointToVirtualContext(
  input: VirtualContextProjectionInput,
): VirtualContextProjectionAttempt {
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
    return { status: "unavailable" };
  }

  const snapshotIndex = branch.findIndex((entry) => entry.id === checkpoint.snapshotLeafId);
  const firstKeptIndex = branch.findIndex(
    (entry) => entry.id === checkpoint.compaction.firstKeptEntryId,
  );
  if (snapshotIndex < 0 || firstKeptIndex < 0 || firstKeptIndex > snapshotIndex) {
    return { status: "unavailable" };
  }

  const sourceMessages = collectSourceMessages(branch);
  const firstKeptSourceIndex = sourceMessages.findIndex(
    (source) => source.branchIndex >= firstKeptIndex,
  );
  if (firstKeptSourceIndex < 0 && sourceMessages.some((source) => source.branchIndex >= firstKeptIndex)) {
    return { status: "unavailable" };
  }
  const boundarySourceIndex = firstKeptSourceIndex < 0 ? sourceMessages.length : firstKeptSourceIndex;
  const sourceKeys = sourceMessages
    .map((source) => messageIdentityKey(source.message));
  if (sourceKeys.some((key) => key === undefined)) {
    return { status: "unavailable" };
  }
  const eventKeys = eventMessages.map(messageIdentityKey);
  const earliestMatches = findEarliestMatches(sourceKeys as string[], eventKeys);
  const latestMatches = findLatestMatches(sourceKeys as string[], eventKeys);
  if (
    !earliestMatches ||
    !latestMatches ||
    earliestMatches.some((match, index) => match !== latestMatches[index])
  ) {
    return { status: "unavailable" };
  }

  const boundaryEventIndex = boundarySourceIndex >= sourceMessages.length
    ? (earliestMatches.length === 0 ? 0 : earliestMatches[earliestMatches.length - 1]! + 1)
    : earliestMatches[boundarySourceIndex]!;

  const matchedSourceByEvent = new Map<number, number>();
  for (let sourceIndex = 0; sourceIndex < earliestMatches.length; sourceIndex += 1) {
    matchedSourceByEvent.set(earliestMatches[sourceIndex]!, sourceIndex);
  }
  const summaryMessage = checkpointToCompactionSummaryMessage(checkpoint);
  if (!summaryMessage) {
    return { status: "unavailable" };
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

  let transformedTokenGrowth = 0;
  for (let sourceIndex = boundarySourceIndex; sourceIndex < sourceMessages.length; sourceIndex += 1) {
    const source = sourceMessages[sourceIndex]!;
    if (source.branchIndex > snapshotIndex) {
      break;
    }
    const eventMessage = eventMessages[earliestMatches[sourceIndex]!];
    if (!eventMessage) {
      return { status: "unavailable" };
    }
    const tokenGrowth = estimateMessageTokenGrowth(source.message, eventMessage);
    if (tokenGrowth === undefined) {
      return { status: "unavailable" };
    }
    transformedTokenGrowth += tokenGrowth;
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
  const additionalMessages = [
    ...eventMessages
      .slice(0, tailStart)
      .filter((_message, eventIndex) => !matchedSourceByEvent.has(eventIndex)),
    ...eventMessages.slice(tailStart),
  ];
  const capacity = estimateVirtualCheckpointCapacity(
    checkpoint,
    additionalMessages,
    contextWindow,
    summaryReserveTokens,
    targetPostCompactionPercent,
    transformedTokenGrowth,
  );
  if (!capacity) {
    return { status: "unavailable" };
  }
  if (capacity.estimatedTokens > capacity.hardLimit) {
    return { status: "hard-limit" };
  }

  return {
    status: "projected",
    projection: {
      messages,
      estimatedTokens: capacity.estimatedTokens,
      hardLimit: capacity.hardLimit,
      targetLimit: capacity.targetLimit,
      needsRefresh: capacity.needsRefresh,
    },
  };
}

/**
 * 将有效 checkpoint 投影为当前 provider 请求使用的虚拟上下文。
 * 返回 undefined 表示边界无法映射或消息容量超过 hard limit。
 */
export function projectCheckpointToVirtualContext(
  input: VirtualContextProjectionInput,
): VirtualContextProjection | undefined {
  const attempt = tryProjectCheckpointToVirtualContext(input);
  return attempt.status === "projected" ? attempt.projection : undefined;
}
