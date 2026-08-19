import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_VERSION,
  LEGACY_CHECKPOINT_VERSION,
  CHECKPOINT_CUSTOM_TYPE,
  PREPARATION_ALGORITHM_VERSION,
  LEGACY_PREPARATION_ALGORITHM_VERSION,
  SUMMARY_FORMAT_VERSION,
  type CheckpointData,
  type JsonObject,
  type JsonValue,
} from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_JSON_DEPTH = 100;
const MAX_JSON_VALUES = 100_000;

type PendingJsonValue = {
  value: unknown;
  depth: number;
};

export function isJsonValue(value: unknown): value is JsonValue {
  const pending: PendingJsonValue[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    visited += 1;
    if (visited > MAX_JSON_VALUES || current.depth > MAX_JSON_DEPTH) {
      return false;
    }

    const currentValue = current.value;
    if (
      currentValue === null ||
      typeof currentValue === "string" ||
      typeof currentValue === "boolean"
    ) {
      continue;
    }
    if (typeof currentValue === "number") {
      if (!Number.isFinite(currentValue)) {
        return false;
      }
      continue;
    }
    if (typeof currentValue !== "object" || seen.has(currentValue)) {
      return false;
    }
    seen.add(currentValue);

    let children: unknown[];
    try {
      if (Array.isArray(currentValue)) {
        children = currentValue;
      } else {
        const prototype = Object.getPrototypeOf(currentValue);
        if (prototype !== Object.prototype && prototype !== null) {
          return false;
        }
        children = Object.values(currentValue);
      }
    } catch {
      return false;
    }
    if (visited + pending.length + children.length > MAX_JSON_VALUES) {
      return false;
    }
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }

  return true;
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

/** 校验 checkpoint v3/v4 的持久化数据，不读取 session 文件。 */
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
  const supportedVersion =
    (value.version === CHECKPOINT_VERSION && value.algorithmVersion === PREPARATION_ALGORITHM_VERSION) ||
    (value.version === LEGACY_CHECKPOINT_VERSION &&
      value.algorithmVersion === LEGACY_PREPARATION_ALGORITHM_VERSION);
  if (
    !supportedVersion ||
    (versions.algorithmVersion !== undefined && value.algorithmVersion !== versions.algorithmVersion) ||
    value.summaryFormatVersion !== (versions.summaryFormatVersion ?? SUMMARY_FORMAT_VERSION)
  ) {
    return undefined;
  }
  if (
    !isNonEmptyString(value.checkpointId) ||
    (value.parentCheckpointId !== undefined && !isNonEmptyString(value.parentCheckpointId)) ||
    (value.version === LEGACY_CHECKPOINT_VERSION && value.parentCheckpointId !== undefined) ||
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
    version: value.version as CheckpointData["version"],
    piVersion,
    algorithmVersion: value.algorithmVersion as CheckpointData["algorithmVersion"],
    summaryFormatVersion: SUMMARY_FORMAT_VERSION,
    checkpointId: value.checkpointId,
    ...(value.parentCheckpointId === undefined ? {} : { parentCheckpointId: value.parentCheckpointId }),
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
