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
  softThresholdPercent: number;
  cache?: VirtualContextProjectionCache;
}

export interface VirtualContextProjection {
  messages: AgentMessage[];
  estimatedTokens: number;
  hardLimit: number;
  refreshLimit: number;
  needsRefresh: boolean;
}

type SourceMessage = {
  branchIndex: number;
  message: AgentMessage;
  estimatedTokens: number | undefined;
};

type CheckpointBoundary = {
  snapshotIndex: number;
  firstKeptIndex: number;
  boundarySourceIndex: number;
};

type CachedSourceIndex = {
  sourceMessages: readonly SourceMessage[];
  sourceKeys: readonly string[];
};

export type VirtualContextCacheStats = {
  rebuilds: number;
  incrementallyIndexedEntries: number;
  branchEntries: number;
  sourceMessages: number;
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
  sourceMessage: SourceMessage,
  eventMessage: AgentMessage,
): number | undefined {
  try {
    const sourceTokens = sourceMessage.estimatedTokens ?? estimateTokens(sourceMessage.message);
    const eventTokens = estimateTokens(eventMessage);
    if (!Number.isFinite(sourceTokens) || !Number.isFinite(eventTokens)) {
      return undefined;
    }
    return Math.max(0, eventTokens - sourceTokens);
  } catch {
    return undefined;
  }
}

function estimateMessageTokens(message: AgentMessage): number | undefined {
  try {
    const tokens = estimateTokens(message);
    return Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
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
      messages.push({
        branchIndex,
        message,
        estimatedTokens: estimateMessageTokens(message),
      });
    }
  }
  return messages;
}

/** 缓存分支到 provider 消息的稳定映射，并在分支仅追加时增量扩展索引。 */
export class VirtualContextProjectionCache {
  private branchIds: string[] = [];
  private sourceMessages: SourceMessage[] = [];
  private sourceKeys: string[] = [];
  private tokenTotals: number[] = [0];
  private invalidTokenTotals: number[] = [0];
  private initialized = false;
  private readonly boundaries = new Map<string, CheckpointBoundary>();
  private rebuildCount = 0;
  private incrementalEntryCount = 0;

  clear(): void {
    this.branchIds = [];
    this.sourceMessages = [];
    this.sourceKeys = [];
    this.tokenTotals = [0];
    this.invalidTokenTotals = [0];
    this.initialized = false;
    this.boundaries.clear();
  }

  prepare(branch: readonly SessionEntry[]): CachedSourceIndex | undefined {
    const sharedPrefix =
      branch.length >= this.branchIds.length &&
      this.branchIds.every((id, index) => branch[index]?.id === id);
    const appendedEntries = sharedPrefix ? branch.slice(this.branchIds.length) : [];
    const canExtend =
      this.initialized &&
      sharedPrefix &&
      !appendedEntries.some((entry) => entry.type === "compaction");
    if (!canExtend) {
      this.rebuild(branch);
    } else if (appendedEntries.length > 0) {
      this.extend(appendedEntries, this.branchIds.length);
      this.branchIds.push(...appendedEntries.map((entry) => entry.id));
      this.incrementalEntryCount += appendedEntries.length;
    }
    if (this.sourceKeys.length !== this.sourceMessages.length) {
      return undefined;
    }
    return {
      sourceMessages: this.sourceMessages,
      sourceKeys: this.sourceKeys,
    };
  }

  getBoundary(branch: readonly SessionEntry[], checkpoint: CheckpointData): CheckpointBoundary | undefined {
    const index = this.prepare(branch);
    if (!index) {
      return undefined;
    }
    const cached = this.boundaries.get(checkpoint.checkpointId);
    if (cached) {
      return cached;
    }
    const snapshotIndex = branch.findIndex((entry) => entry.id === checkpoint.snapshotLeafId);
    const firstKeptIndex = branch.findIndex(
      (entry) => entry.id === checkpoint.compaction.firstKeptEntryId,
    );
    if (snapshotIndex < 0 || firstKeptIndex < 0 || firstKeptIndex > snapshotIndex) {
      return undefined;
    }
    const firstKeptSourceIndex = index.sourceMessages.findIndex(
      (source) => source.branchIndex >= firstKeptIndex,
    );
    const boundarySourceIndex = firstKeptSourceIndex < 0
      ? index.sourceMessages.length
      : firstKeptSourceIndex;
    const boundary = { snapshotIndex, firstKeptIndex, boundarySourceIndex };
    this.boundaries.set(checkpoint.checkpointId, boundary);
    return boundary;
  }

  estimateTokensAfter(branch: readonly SessionEntry[], branchIndex: number): number | undefined {
    const index = this.prepare(branch);
    if (!index) {
      return undefined;
    }
    let low = 0;
    let high = index.sourceMessages.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (index.sourceMessages[middle]!.branchIndex <= branchIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const invalidTokens = this.invalidTokenTotals.at(-1)! - this.invalidTokenTotals[low]!;
    if (invalidTokens > 0) {
      return undefined;
    }
    return this.tokenTotals.at(-1)! - this.tokenTotals[low]!;
  }

  stats(): VirtualContextCacheStats {
    return {
      rebuilds: this.rebuildCount,
      incrementallyIndexedEntries: this.incrementalEntryCount,
      branchEntries: this.branchIds.length,
      sourceMessages: this.sourceMessages.length,
    };
  }

  private rebuild(branch: readonly SessionEntry[]): void {
    this.branchIds = branch.map((entry) => entry.id);
    this.sourceMessages = collectSourceMessages(branch);
    this.sourceKeys = [];
    this.tokenTotals = [0];
    this.invalidTokenTotals = [0];
    this.boundaries.clear();
    this.initialized = true;
    for (const source of this.sourceMessages) {
      this.appendSourceMetadata(source);
    }
    this.rebuildCount += 1;
  }

  private extend(entries: readonly SessionEntry[], offset: number): void {
    for (let entryOffset = 0; entryOffset < entries.length; entryOffset += 1) {
      const entry = entries[entryOffset]!;
      for (const message of sessionEntryToContextMessages(entry)) {
        const source = {
          branchIndex: offset + entryOffset,
          message,
          estimatedTokens: estimateMessageTokens(message),
        };
        this.sourceMessages.push(source);
        this.appendSourceMetadata(source);
      }
    }
  }

  private appendSourceMetadata(source: SourceMessage): void {
    const key = messageIdentityKey(source.message);
    if (key !== undefined) {
      this.sourceKeys.push(key);
    }
    const tokens = source.estimatedTokens;
    this.tokenTotals.push(this.tokenTotals.at(-1)! + (tokens ?? 0));
    this.invalidTokenTotals.push(this.invalidTokenTotals.at(-1)! + (tokens === undefined ? 1 : 0));
  }
}

function makeUncachedSourceIndex(branch: readonly SessionEntry[]): CachedSourceIndex | undefined {
  const sourceMessages = collectSourceMessages(branch);
  const sourceKeys = sourceMessages.map((source) => messageIdentityKey(source.message));
  if (sourceKeys.some((key) => key === undefined)) {
    return undefined;
  }
  return { sourceMessages, sourceKeys: sourceKeys as string[] };
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
    softThresholdPercent,
    cache,
  } = input;
  if (
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(summaryReserveTokens) ||
    summaryReserveTokens < 0 ||
    !Number.isFinite(softThresholdPercent) ||
    softThresholdPercent < 0 ||
    softThresholdPercent > 100
  ) {
    return { status: "unavailable" };
  }

  const sourceIndex = cache?.prepare(branch) ?? makeUncachedSourceIndex(branch);
  if (!sourceIndex) {
    return { status: "unavailable" };
  }
  const { sourceMessages, sourceKeys } = sourceIndex;
  let snapshotIndex: number;
  let boundarySourceIndex: number;
  if (cache) {
    const boundary = cache.getBoundary(branch, checkpoint);
    if (!boundary) {
      return { status: "unavailable" };
    }
    snapshotIndex = boundary.snapshotIndex;
    boundarySourceIndex = boundary.boundarySourceIndex;
  } else {
    snapshotIndex = branch.findIndex((entry) => entry.id === checkpoint.snapshotLeafId);
    const firstKeptIndex = branch.findIndex(
      (entry) => entry.id === checkpoint.compaction.firstKeptEntryId,
    );
    if (snapshotIndex < 0 || firstKeptIndex < 0 || firstKeptIndex > snapshotIndex) {
      return { status: "unavailable" };
    }
    const firstKeptSourceIndex = sourceMessages.findIndex(
      (source) => source.branchIndex >= firstKeptIndex,
    );
    boundarySourceIndex = firstKeptSourceIndex < 0
      ? sourceMessages.length
      : firstKeptSourceIndex;
  }
  const eventKeys = eventMessages.map(messageIdentityKey);
  const earliestMatches = findEarliestMatches(sourceKeys, eventKeys);
  const latestMatches = findLatestMatches(sourceKeys, eventKeys);
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
    const tokenGrowth = estimateMessageTokenGrowth(source, eventMessage);
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
    softThresholdPercent,
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
      refreshLimit: capacity.refreshLimit,
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
