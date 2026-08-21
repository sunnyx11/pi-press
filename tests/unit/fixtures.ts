import type { Api, Message, Model, Usage } from "@earendil-works/pi-ai";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionPreparation } from "../../src/types.js";
import {
  CHECKPOINT_VERSION,
  PREPARATION_ALGORITHM_VERSION,
  SUMMARY_FORMAT_VERSION,
  type CheckpointData,
} from "../../src/types.js";

export function makeUsage(totalTokens = 100): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function makeUserMessage(text: string): Message {
  return { role: "user", content: text, timestamp: Date.now() };
}

export function makeAssistantMessage(text: string, usage = makeUsage()): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "model-id",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function makeModel(contextWindow = 100_000): Model<Api> {
  return {
    id: "model-id",
    name: "Test model",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: 4096,
  };
}

export function makePreparation(firstKeptEntryId: string, tokensBefore = 100): CompactionPreparation {
  return {
    firstKeptEntryId,
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore,
    fileOps: {
      read: new Set<string>(),
      written: new Set<string>(),
      edited: new Set<string>(),
    },
    settings: {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 20_000,
    },
  };
}

export function makeCheckpointData(
  sessionId: string,
  snapshotLeafId: string,
  firstKeptEntryId: string,
  overrides: Partial<CheckpointData> = {},
): CheckpointData {
  return {
    version: CHECKPOINT_VERSION,
    piVersion: VERSION,
    algorithmVersion: PREPARATION_ALGORITHM_VERSION,
    summaryFormatVersion: SUMMARY_FORMAT_VERSION,
    checkpointId: "checkpoint-1",
    sessionId,
    snapshotLeafId,
    snapshotSourceLeafId: snapshotLeafId,
    epochCompactionId: null,
    snapshotKey: `session:null:source:${VERSION}:${PREPARATION_ALGORITHM_VERSION}:${SUMMARY_FORMAT_VERSION}:fingerprint`,
    compaction: {
      summary: "A valid summary",
      firstKeptEntryId,
      tokensBefore: 100,
      usage: makeUsage(),
      details: {
        readFiles: ["read.ts"],
        modifiedFiles: ["write.ts"],
      },
    },
    estimatedTokensAfterAtSnapshot: 100,
    provenance: {
      model: {
        provider: "test",
        id: "model-id",
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
        contextWindow: 100_000,
        maxTokens: 4096,
      },
      thinkingLevel: "medium",
      configFingerprint: "fingerprint",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeMessageEntry(id: string, parentId: string | null, message: Message): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message,
  };
}
