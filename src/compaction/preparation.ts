import {
  buildSessionProjection,
  calculateContextTokens,
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
  ProjectedSessionEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  CheckpointData,
  CompactionPreparation,
  CompactionSettings,
  FileOperations,
  PiPressConfig,
} from "../types.js";
import { isRecord } from "../checkpoint/schema.js";

// 预压缩保留固定近期内容，同时覆盖 snapshot 前的完整消息。
const CHECKPOINT_KEEP_RECENT_TOKENS = 10_000;

function createFileOps(): FileOperations {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall" || !isRecord(block.arguments)) {
      continue;
    }
    const path = block.arguments.path;
    if (typeof path !== "string" || path.length === 0 || typeof block.name !== "string") {
      continue;
    }
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

function isUsableUsage(value: unknown): value is Usage {
  if (!isRecord(value)) {
    return false;
  }
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  return fields.every(
    (field) => typeof value[field] === "number" && Number.isFinite(value[field]),
  ) && calculateContextTokens(value as unknown as Usage) > 0;
}

function getMessageUsage(message: AgentMessage): Usage | undefined {
  if (
    message.role !== "assistant" ||
    message.stopReason === "aborted" ||
    message.stopReason === "error"
  ) {
    return undefined;
  }
  return isUsableUsage(message.usage) ? message.usage : undefined;
}

/** 按当前 Pi 投影语义重建当前上下文 token 数。 */
export function estimateContextTokensFromEntries(entries: readonly SessionEntry[]): number {
  const projection = buildSessionProjection([...entries]);
  const messages = projection.messages;
  let lastUsageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (getMessageUsage(messages[index]!)) {
      lastUsageIndex = index;
      break;
    }
  }

  if (lastUsageIndex >= 0) {
    let projectedMessageIndex = 0;
    let usageEntryId: string | undefined;
    for (const entry of projection.entries) {
      const nextMessageIndex = projectedMessageIndex + entry.messages.length;
      if (lastUsageIndex < nextMessageIndex) {
        usageEntryId = entry.sourceEntry.id;
        break;
      }
      projectedMessageIndex = nextMessageIndex;
    }
    const usageEntryIndex = usageEntryId
      ? entries.findIndex((entry) => entry.id === usageEntryId)
      : -1;
    let latestInvalidatingEntryIndex = -1;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === "context_edit" || entry?.type === "compaction") {
        latestInvalidatingEntryIndex = index;
        break;
      }
    }
    const usage = getMessageUsage(messages[lastUsageIndex]!);
    if (usage && usageEntryIndex > latestInvalidatingEntryIndex) {
      let trailingTokens = 0;
      for (let index = lastUsageIndex + 1; index < messages.length; index += 1) {
        trailingTokens += estimateTokens(messages[index]!);
      }
      return calculateContextTokens(usage) + trailingTokens;
    }
  }

  const currentSystem = getCurrentSystemMessage(messages);
  let tokens = currentSystem ? estimateTokens(currentSystem) : 0;
  for (const message of messages) {
    if (message.role !== "system") {
      tokens += estimateTokens(message);
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function addFileList(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      target.add(item);
    }
  }
}

function addPreviousCompactionFileOps(fileOps: FileOperations, entry: SessionEntry): void {
  if (entry.type !== "compaction" || !isRecord(entry.details)) {
    return;
  }
  addFileList(fileOps.read, entry.details.readFiles);
  addFileList(fileOps.edited, entry.details.modifiedFiles);
}

function addCheckpointFileOps(fileOps: FileOperations, checkpoint: CheckpointData): void {
  const details = checkpoint.compaction.details;
  if (!details) {
    return;
  }
  addFileList(fileOps.read, details.readFiles);
  addFileList(fileOps.edited, details.modifiedFiles);
}

function getMessagesForCompaction(entry: ProjectedSessionEntry): AgentMessage[] {
  if (entry.sourceEntry.type === "compaction") {
    return [];
  }
  return entry.messages.filter((message) => message.role !== "system");
}

function isCutPointMessage(message: AgentMessage): boolean {
  return message.role !== "system" && message.role !== "toolResult";
}

function isTurnStartMessage(message: AgentMessage): boolean {
  return message.role !== "system" && message.role !== "assistant" && message.role !== "toolResult";
}

function isProjectedTurnStart(entry: ProjectedSessionEntry): boolean {
  return entry.sourceEntry.type !== "compaction" && entry.messages.some(isTurnStartMessage);
}

function findProjectedTurnStartIndex(
  entries: readonly ProjectedSessionEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let index = entryIndex; index >= startIndex; index -= 1) {
    if (isProjectedTurnStart(entries[index]!)) {
      return index;
    }
  }
  return -1;
}

function findProjectedCutPoint(
  entries: readonly ProjectedSessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): { firstKeptEntryIndex: number; turnStartIndex: number; isSplitTurn: boolean } {
  const cutPoints: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index]!;
    if (entry.sourceEntry.type !== "compaction" && entry.messages.some(isCutPointMessage)) {
      cutPoints.push(index);
    }
  }
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let exceededBudget = false;
  let cutIndex = cutPoints[0]!;
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const messageTokens = entries[index]!.messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      0,
    );
    if (messageTokens === 0) {
      continue;
    }
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      exceededBudget = true;
      cutIndex = cutPoints.find((candidate) => candidate >= index) ?? cutPoints.at(-1)!;
      break;
    }
  }

  const suffix = entries.slice(cutIndex + 1, endIndex);
  const isIntrinsicallyVisible = (entry: ProjectedSessionEntry): boolean =>
    entry.sourceEntry.type !== "context_edit" &&
    sessionEntryToContextMessages(entry.sourceEntry).length > 0;
  const isOmitted = (entry: ProjectedSessionEntry): boolean =>
    isIntrinsicallyVisible(entry) && entry.messages.length === 0;
  const omittedSuffixIds = new Set(
    suffix.filter(isOmitted).map((entry) => entry.sourceEntry.id),
  );
  const hasExternalReplacement = suffix.some(
    (entry) =>
      entry.sourceEntry.type === "context_edit" &&
      entry.sourceEntry.replacement !== null &&
      !omittedSuffixIds.has(entry.sourceEntry.targetId),
  );
  const isRecoveryOmissionSuffix =
    exceededBudget &&
    !hasExternalReplacement &&
    suffix.some(
      (entry) =>
        entry.sourceEntry.type === "message" &&
        entry.sourceEntry.message.role === "assistant" &&
        isOmitted(entry),
    ) &&
    suffix.every(
      (entry) =>
        entry.sourceEntry.type !== "compaction" &&
        (!isIntrinsicallyVisible(entry) || isOmitted(entry)),
    );
  if (isRecoveryOmissionSuffix) {
    cutIndex += 1;
  }

  while (cutIndex > startIndex) {
    const previous = entries[cutIndex - 1]!;
    if (previous.sourceEntry.type === "compaction" || previous.messages.length > 0) {
      break;
    }
    cutIndex -= 1;
  }
  const startsTurn = isProjectedTurnStart(entries[cutIndex]!);
  const turnStartIndex = startsTurn
    ? -1
    : findProjectedTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !startsTurn && turnStartIndex !== -1,
  };
}

/** 构造与当前 Pi 公开 compact API 兼容的压缩准备数据。 */
export function prepareCompactionFromBranch(
  pathEntries: readonly SessionEntry[],
  settings: CompactionSettings,
  parentCheckpoint?: CheckpointData,
): CompactionPreparation | undefined {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1]?.type === "compaction") {
    return undefined;
  }

  const projection = buildSessionProjection([...pathEntries]);
  const projectedEntries = projection.entries;
  const previousCompactionIndex = projectedEntries.findIndex(
    (entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
  );

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (parentCheckpoint) {
    previousSummary = parentCheckpoint.compaction.summary;
    boundaryStart = projectedEntries.findIndex(
      (entry) => entry.sourceEntry.id === parentCheckpoint.compaction.firstKeptEntryId,
    );
    const parentSnapshotIndex = projectedEntries.findIndex(
      (entry) => entry.sourceEntry.id === parentCheckpoint.snapshotLeafId,
    );
    if (boundaryStart < 0 || parentSnapshotIndex < boundaryStart) {
      return undefined;
    }
  } else if (previousCompactionIndex >= 0) {
    const previousCompaction = projectedEntries[previousCompactionIndex]?.sourceEntry;
    if (!previousCompaction || previousCompaction.type !== "compaction") {
      return undefined;
    }
    previousSummary = previousCompaction.summary;
    boundaryStart = previousCompactionIndex + 1;
  }

  const boundaryEnd = projectedEntries.length;
  const tokensBefore = estimateContextTokensFromEntries(pathEntries);
  const cutPoint = findProjectedCutPoint(
    projectedEntries,
    boundaryStart,
    boundaryEnd,
    settings.keepRecentTokens,
  );
  const firstKeptEntry = projectedEntries[cutPoint.firstKeptEntryIndex]?.sourceEntry;
  if (!firstKeptEntry?.id) {
    return undefined;
  }

  const historyEnd = cutPoint.isSplitTurn
    ? cutPoint.turnStartIndex
    : cutPoint.firstKeptEntryIndex;
  if (historyEnd < boundaryStart || (cutPoint.isSplitTurn && cutPoint.turnStartIndex < 0)) {
    return undefined;
  }
  const messagesToSummarize = projectedEntries
    .slice(boundaryStart, historyEnd)
    .flatMap(getMessagesForCompaction);
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? projectedEntries
      .slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
      .flatMap(getMessagesForCompaction)
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return undefined;
  }

  const fileOps = createFileOps();
  if (parentCheckpoint) {
    addCheckpointFileOps(fileOps, parentCheckpoint);
  } else if (previousCompactionIndex >= 0) {
    const previousCompaction = projectedEntries[previousCompactionIndex]?.sourceEntry;
    if (previousCompaction) {
      addPreviousCompactionFileOps(fileOps, previousCompaction);
    }
  }
  for (const message of messagesToSummarize) {
    extractFileOpsFromMessage(message, fileOps);
  }
  for (const message of turnPrefixMessages) {
    extractFileOpsFromMessage(message, fileOps);
  }

  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    ...(previousSummary === undefined ? {} : { previousSummary }),
    fileOps,
    settings,
  };
}

export function createCheckpointPreparationSettings(config: PiPressConfig): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: config.summaryReserveTokens,
    keepRecentTokens: CHECKPOINT_KEEP_RECENT_TOKENS,
  };
}

export function createFormalizationPreparationSettings(
  config: PiPressConfig,
  keepRecentTokens: number,
): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: config.summaryReserveTokens,
    keepRecentTokens,
  };
}
