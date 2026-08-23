import {
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionResult,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  CheckpointCandidate,
  CheckpointData,
  CompactionPreparation,
} from "../types.js";

/** 计算 checkpoint 快照原始上下文及其后续 session 消息所代表的 token 数。 */
export function calculateOriginalTokensBefore(
  checkpoint: CheckpointData,
  branch: readonly SessionEntry[],
): number | undefined {
  const snapshotIndex = branch.findIndex(
    (entry) => entry.id === checkpoint.snapshotLeafId,
  );
  if (snapshotIndex < 0) {
    return undefined;
  }

  return branch
    .slice(snapshotIndex + 1)
    .flatMap((entry) => sessionEntryToContextMessages(entry))
    .reduce(
      (total, message) => total + estimateTokens(message),
      checkpoint.compaction.tokensBefore,
    );
}

function getFileList(details: Record<string, unknown> | undefined, key: "readFiles" | "modifiedFiles"): string[] {
  const value = details?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

/** 将已校验 checkpoint 转换为 Pi 可接受的 CompactionResult。 */
export function buildCheckpointCompactionResult(
  candidate: CheckpointCandidate,
  preparation: CompactionPreparation,
): CompactionResult {
  const storedDetails = candidate.data.compaction.details;
  const details: Record<string, unknown> = storedDetails ? { ...storedDetails } : {};
  const readFiles = getFileList(details, "readFiles");
  const modifiedFiles = getFileList(details, "modifiedFiles");
  details.readFiles = readFiles;
  details.modifiedFiles = modifiedFiles;
  details.piPress = {
    version: candidate.data.version,
    piVersion: candidate.data.piVersion,
    algorithmVersion: candidate.data.algorithmVersion,
    checkpointId: candidate.data.checkpointId,
    snapshotLeafId: candidate.data.snapshotLeafId,
  };

  return {
    summary: candidate.data.compaction.summary,
    firstKeptEntryId: candidate.data.compaction.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    ...(candidate.data.compaction.usage === undefined
      ? {}
      : { usage: candidate.data.compaction.usage }),
    details,
  };
}
