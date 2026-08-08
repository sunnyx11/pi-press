import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import type { CheckpointCandidate, CompactionPreparation } from "../types.js";

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
