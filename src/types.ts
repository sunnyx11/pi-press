import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
  compact,
  CompactionResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type CompactionPreparation = Parameters<typeof compact>[0];
export type CompactionSettings = CompactionPreparation["settings"];
export type FileOperations = CompactionPreparation["fileOps"];

export const CHECKPOINT_VERSION = 3 as const;
export const PREPARATION_ALGORITHM_VERSION = 1 as const;
export const SUMMARY_FORMAT_VERSION = 1 as const;
export const CHECKPOINT_CUSTOM_TYPE = "pi-press.precompaction" as const;

export type PrecomputeMode = "off" | "threshold" | "threshold-and-manual";

export interface PiPressConfig {
  precomputeMode: PrecomputeMode;
  softThresholdPercent: number;
  summaryReserveTokens: number;
  taskTimeoutMs: number;
  hookWaitTimeoutMs: number;
  targetPostCompactionPercent: number;
  maxRefreshesPerEpoch: number;
  maxRetries: number;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface CheckpointModelProvenance {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
}

export interface CheckpointProvenance {
  model: CheckpointModelProvenance;
  thinkingLevel: string;
  configFingerprint: string;
}

export interface CheckpointCompaction {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details?: JsonObject;
}

export interface CheckpointData {
  version: typeof CHECKPOINT_VERSION;
  piVersion: string;
  algorithmVersion: typeof PREPARATION_ALGORITHM_VERSION;
  summaryFormatVersion: typeof SUMMARY_FORMAT_VERSION;
  checkpointId: string;
  sessionId: string;
  snapshotLeafId: string;
  snapshotSourceLeafId: string;
  epochCompactionId: string | null;
  snapshotKey: string;
  compaction: CheckpointCompaction;
  estimatedTokensAfterAtSnapshot: number;
  provenance: CheckpointProvenance;
  createdAt: string;
}

export interface CheckpointCandidate {
  entry: Extract<SessionEntry, { type: "custom" }>;
  data: CheckpointData;
}

export interface CompactionCapacityEstimate {
  currentMessagesEstimatedTokens: number;
  fixedOverhead: number;
  summaryEstimatedTokens: number;
  keptMessagesEstimatedTokens: number;
  estimatedTokensAfter: number;
  safetyMargin: number;
  hardLimit: number;
  targetLimit: number;
  acceptLimit: number;
  accepted: boolean;
}

export interface ProviderRequest {
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  streamFn: StreamFn;
}

export interface PreparationSnapshot {
  sessionId: string;
  snapshotLeafId: string;
  snapshotSourceLeafId: string;
  epochCompactionId: string | null;
  snapshotKey: string;
  preparation: CompactionPreparation;
  model: Model<Api>;
  thinkingLevel: string;
  providerRequest: ProviderRequest;
  branchEntries: SessionEntry[];
}

export interface StoredCompactionResult extends Omit<CompactionResult, "usage" | "details"> {
  usage?: Usage;
  details?: JsonObject;
}

export interface PiPressCompactionDetails extends JsonObject {
  readFiles: JsonValue;
  modifiedFiles: JsonValue;
  piPress: JsonValue;
}

export type PiCompactionSettings = CompactionSettings;
