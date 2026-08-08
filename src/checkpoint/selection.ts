import { VERSION } from "@earendil-works/pi-coding-agent";
import type {
  CompactionEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_CUSTOM_TYPE,
  PREPARATION_ALGORITHM_VERSION,
  SUMMARY_FORMAT_VERSION,
  type CheckpointCandidate,
} from "../types.js";
import { getCheckpointDataFromEntry, isRecord } from "./schema.js";

/** 返回当前分支中最新正式 compaction 的 entry ID。 */
export function getEpochCompactionId(branch: readonly SessionEntry[]): string | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") {
      return entry.id;
    }
  }
  return null;
}

/** 返回忽略 Pi-press 状态 entry 后的最新 session entry。 */
export function getSnapshotSourceLeafId(branch: readonly SessionEntry[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry && !(entry.type === "custom" && entry.customType.startsWith("pi-press."))) {
      return entry.id;
    }
  }
  return undefined;
}

export function getEntryIndex(branch: readonly SessionEntry[], entryId: string): number {
  return branch.findIndex((entry) => entry.id === entryId);
}

export function isBeforeOrSame(
  branch: readonly SessionEntry[],
  firstEntryId: string,
  secondEntryId: string,
): boolean {
  const firstIndex = getEntryIndex(branch, firstEntryId);
  const secondIndex = getEntryIndex(branch, secondEntryId);
  return firstIndex >= 0 && secondIndex >= 0 && firstIndex <= secondIndex;
}

export function getConsumedCheckpointIds(branch: readonly SessionEntry[]): ReadonlySet<string> {
  const consumed = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "compaction") {
      continue;
    }
    const details = entry.details;
    if (!isRecord(details) || !isRecord(details.piPress)) {
      continue;
    }
    const checkpointId = details.piPress.checkpointId;
    if (typeof checkpointId === "string" && checkpointId.length > 0) {
      consumed.add(checkpointId);
    }
  }
  return consumed;
}

function isCompatibleCheckpoint(
  data: CheckpointCandidate["data"],
  branch: readonly SessionEntry[],
  sessionId: string,
  epochCompactionId: string | null,
  checkpointIndex: number,
): boolean {
  if (
    data.sessionId !== sessionId ||
    data.piVersion !== VERSION ||
    data.algorithmVersion !== PREPARATION_ALGORITHM_VERSION ||
    data.summaryFormatVersion !== SUMMARY_FORMAT_VERSION ||
    data.epochCompactionId !== epochCompactionId
  ) {
    return false;
  }
  const snapshotIndex = getEntryIndex(branch, data.snapshotLeafId);
  const sourceIndex = getEntryIndex(branch, data.snapshotSourceLeafId);
  const firstKeptIndex = getEntryIndex(branch, data.compaction.firstKeptEntryId);
  return (
    snapshotIndex >= 0 &&
    sourceIndex >= 0 &&
    firstKeptIndex >= 0 &&
    sourceIndex <= snapshotIndex &&
    firstKeptIndex <= snapshotIndex &&
    checkpointIndex > snapshotIndex
  );
}

/** 从当前分支中按最新追加顺序返回可候选的 checkpoint。 */
export function findReadyCheckpointCandidates(
  branch: readonly SessionEntry[],
  sessionId: string,
  epochCompactionId: string | null,
  claimedCheckpointId: string | undefined,
): CheckpointCandidate[] {
  const consumed = getConsumedCheckpointIds(branch);
  const candidates: CheckpointCandidate[] = [];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) {
      continue;
    }
    const data = getCheckpointDataFromEntry(entry);
    if (!data) {
      continue;
    }
    if (data.checkpointId === claimedCheckpointId || consumed.has(data.checkpointId)) {
      continue;
    }
    const candidate = { entry, data } satisfies CheckpointCandidate;
    if (isCompatibleCheckpoint(data, branch, sessionId, epochCompactionId, index)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function getCompactionEntryById(
  branch: readonly SessionEntry[],
  entryId: string,
): CompactionEntry | undefined {
  const entry = branch.find((item) => item.id === entryId);
  return entry?.type === "compaction" ? entry : undefined;
}
