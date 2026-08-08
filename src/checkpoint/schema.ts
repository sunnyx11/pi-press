import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_VERSION,
  CHECKPOINT_CUSTOM_TYPE,
  PREPARATION_ALGORITHM_VERSION,
  SUMMARY_FORMAT_VERSION,
  type CheckpointData,
  type JsonObject,
  type JsonValue,
} from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, seen));
  }
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    ? Object.entries(value).every(([key, item]) => typeof key === "string" && isJsonValue(item, seen))
    : false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsageCost(value: unknown): value is Usage["cost"] {
  return (
    isRecord(value) &&
    isNonNegativeFinite(value.input) &&
    isNonNegativeFinite(value.output) &&
    isNonNegativeFinite(value.cacheRead) &&
    isNonNegativeFinite(value.cacheWrite) &&
    isNonNegativeFinite(value.total)
  );
}

export function isUsage(value: unknown): value is Usage {
  if (
    !isRecord(value) ||
    !isNonNegativeFinite(value.input) ||
    !isNonNegativeFinite(value.output) ||
    !isNonNegativeFinite(value.cacheRead) ||
    !isNonNegativeFinite(value.cacheWrite) ||
    !isNonNegativeFinite(value.totalTokens) ||
    !isUsageCost(value.cost)
  ) {
    return false;
  }
  return (
    (value.cacheWrite1h === undefined || isNonNegativeFinite(value.cacheWrite1h)) &&
    (value.reasoning === undefined || isNonNegativeFinite(value.reasoning)) &&
    isJsonValue(value)
  );
}

function isFileList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function isCheckpointDetails(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    (value.readFiles === undefined || isFileList(value.readFiles)) &&
    (value.modifiedFiles === undefined || isFileList(value.modifiedFiles))
  );
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.model)) {
    return false;
  }
  const model = value.model;
  return (
    isNonEmptyString(model.provider) &&
    isNonEmptyString(model.id) &&
    isNonEmptyString(model.api) &&
    isNonEmptyString(model.baseUrl) &&
    isNonNegativeFinite(model.contextWindow) &&
    model.contextWindow > 0 &&
    isNonNegativeFinite(model.maxTokens) &&
    model.maxTokens > 0 &&
    isNonEmptyString(value.thinkingLevel) &&
    isNonEmptyString(value.configFingerprint) &&
    isJsonValue(value)
  );
}

/** 校验 checkpoint v3 的持久化数据，不读取 session 文件。 */
export function parseCheckpointData(
  value: unknown,
  versions: {
    piVersion?: string;
    algorithmVersion?: number;
    summaryFormatVersion?: number;
  } = {},
): CheckpointData | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const piVersion = value.piVersion;
  if (
    !isNonEmptyString(piVersion) ||
    (versions.piVersion !== undefined && piVersion !== versions.piVersion)
  ) {
    return undefined;
  }
  if (
    value.version !== CHECKPOINT_VERSION ||
    value.algorithmVersion !== (versions.algorithmVersion ?? PREPARATION_ALGORITHM_VERSION) ||
    value.summaryFormatVersion !== (versions.summaryFormatVersion ?? SUMMARY_FORMAT_VERSION)
  ) {
    return undefined;
  }
  if (
    !isNonEmptyString(value.checkpointId) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.snapshotLeafId) ||
    !isNonEmptyString(value.snapshotSourceLeafId) ||
    !(value.epochCompactionId === null || isNonEmptyString(value.epochCompactionId)) ||
    !isNonEmptyString(value.snapshotKey) ||
    !isNonNegativeFinite(value.estimatedTokensAfterAtSnapshot) ||
    !isNonEmptyString(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isProvenance(value.provenance) ||
    !isRecord(value.compaction) ||
    !isNonEmptyString(value.compaction.summary) ||
    !isNonEmptyString(value.compaction.firstKeptEntryId) ||
    !isNonNegativeFinite(value.compaction.tokensBefore) ||
    (value.compaction.usage !== undefined && !isUsage(value.compaction.usage)) ||
    (value.compaction.details !== undefined && !isCheckpointDetails(value.compaction.details))
  ) {
    return undefined;
  }

  const result: CheckpointData = {
    version: CHECKPOINT_VERSION,
    piVersion,
    algorithmVersion: PREPARATION_ALGORITHM_VERSION,
    summaryFormatVersion: SUMMARY_FORMAT_VERSION,
    checkpointId: value.checkpointId,
    sessionId: value.sessionId,
    snapshotLeafId: value.snapshotLeafId,
    snapshotSourceLeafId: value.snapshotSourceLeafId,
    epochCompactionId: value.epochCompactionId,
    snapshotKey: value.snapshotKey,
    compaction: {
      summary: value.compaction.summary,
      firstKeptEntryId: value.compaction.firstKeptEntryId,
      tokensBefore: value.compaction.tokensBefore,
      ...(value.compaction.usage === undefined ? {} : { usage: value.compaction.usage }),
      ...(value.compaction.details === undefined ? {} : { details: value.compaction.details }),
    },
    estimatedTokensAfterAtSnapshot: value.estimatedTokensAfterAtSnapshot,
    provenance: value.provenance as CheckpointData["provenance"],
    createdAt: value.createdAt,
  };
  return result;
}

export function getCheckpointDataFromEntry(entry: SessionEntry): CheckpointData | undefined {
  if (entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) {
    return undefined;
  }
  return parseCheckpointData(entry.data);
}
