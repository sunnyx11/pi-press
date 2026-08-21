import {
  buildContextEntries,
  calculateContextTokens,
  estimateTokens,
  findCutPoint,
  getLastAssistantUsage,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  CheckpointData,
  CompactionPreparation,
  CompactionSettings,
  FileOperations,
  PiPressConfig,
} from "../types.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
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

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return sessionEntryToContextMessages(entry)[0];
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
  if (message.role !== "assistant") {
    return undefined;
  }
  if (message.stopReason === "aborted" || message.stopReason === "error") {
    return undefined;
  }
  return isUsableUsage(message.usage) ? message.usage : undefined;
}

/** 按当前 Pi 公开估算函数重建当前上下文 token 数。 */
export function estimateContextTokensFromEntries(entries: readonly SessionEntry[]): number {
  const activeEntries = buildContextEntries([...entries]);
  const messages = activeEntries.flatMap((entry) => sessionEntryToContextMessages(entry));
  let lastUsageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (getMessageUsage(messages[index]!)) {
      lastUsageIndex = index;
      break;
    }
  }

  if (lastUsageIndex < 0) {
    return estimateMessagesTokens(messages);
  }

  const usage = getLastAssistantUsage(activeEntries);
  if (!usage) {
    return estimateMessagesTokens(messages);
  }
  let trailingTokens = 0;
  for (let index = lastUsageIndex + 1; index < messages.length; index += 1) {
    trailingTokens += estimateTokens(messages[index]!);
  }
  return calculateContextTokens(usage) + trailingTokens;
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

function collectMessages(
  entries: readonly SessionEntry[],
  startIndex: number,
  endIndex: number,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const message = getMessageFromEntry(entry);
    if (message) {
      messages.push(message);
    }
  }
  return messages;
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

  let previousCompactionIndex = -1;
  for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
    if (pathEntries[index]?.type === "compaction") {
      previousCompactionIndex = index;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (parentCheckpoint) {
    previousSummary = parentCheckpoint.compaction.summary;
    boundaryStart = pathEntries.findIndex(
      (entry) => entry.id === parentCheckpoint.compaction.firstKeptEntryId,
    );
    const parentSnapshotIndex = pathEntries.findIndex(
      (entry) => entry.id === parentCheckpoint.snapshotLeafId,
    );
    if (boundaryStart < 0 || parentSnapshotIndex < boundaryStart) {
      return undefined;
    }
  } else if (previousCompactionIndex >= 0) {
    const previousCompaction = pathEntries[previousCompactionIndex];
    if (!previousCompaction || previousCompaction.type !== "compaction") {
      return undefined;
    }
    previousSummary = previousCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (entry) => entry.id === previousCompaction.firstKeptEntryId,
    );
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : previousCompactionIndex + 1;
  }

  const boundaryEnd = pathEntries.length;
  const tokensBefore = estimateContextTokensFromEntries(pathEntries);
  const cutPoint = findCutPoint([...pathEntries], boundaryStart, boundaryEnd, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }

  const turnStartIndex = cutPoint.turnStartIndex ?? -1;
  const historyEnd = cutPoint.isSplitTurn ? turnStartIndex : cutPoint.firstKeptEntryIndex;
  if (historyEnd < boundaryStart || (cutPoint.isSplitTurn && turnStartIndex < 0)) {
    return undefined;
  }
  const messagesToSummarize = collectMessages(pathEntries, boundaryStart, historyEnd);
  const turnPrefixMessages = cutPoint.isSplitTurn
    ? collectMessages(pathEntries, turnStartIndex, cutPoint.firstKeptEntryIndex)
    : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
    return undefined;
  }

  const fileOps = createFileOps();
  if (parentCheckpoint) {
    addCheckpointFileOps(fileOps, parentCheckpoint);
  } else if (previousCompactionIndex >= 0) {
    const previousCompaction = pathEntries[previousCompactionIndex];
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
