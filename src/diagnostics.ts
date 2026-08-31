import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { JsonObject } from "./types.js";

export type DiagnosticKind =
  | "config"
  | "checkpoint"
  | "task"
  | "provider"
  | "capacity"
  | "lifecycle";

export type DiagnosticEventCategory = "counter" | "record" | "usage";

export interface DiagnosticRecord {
  kind: DiagnosticKind;
  message: string;
  at: string;
}

export interface DiagnosticEventMetadata {
  sessionId?: string;
  epochCompactionId?: string | null;
  branchLeafId?: string;
  checkpointId?: string;
  reason?: string;
  details?: JsonObject;
  state?: JsonObject;
}

export interface DiagnosticEvent extends DiagnosticEventMetadata {
  id?: number;
  at: string;
  processId: number;
  runtimeId: string;
  category: DiagnosticEventCategory;
  name: string;
  message?: string;
}

export interface DiagnosticEventQuery {
  sessionId?: string;
  limit: number;
}

export interface DiagnosticStore {
  readonly location: string;
  append(event: DiagnosticEvent): void;
  query(options: DiagnosticEventQuery): DiagnosticEvent[];
  prune(): void;
  close(): void;
}

export interface DiagnosticPersistenceSnapshot {
  enabled: boolean;
  location?: string;
  failure?: string;
}

export interface DiagnosticSnapshot {
  records: readonly DiagnosticRecord[];
  events: readonly DiagnosticEvent[];
  counters: Readonly<Record<string, number>>;
  usageTokens: {
    consumed: number;
    discarded: number;
  };
  persistence: DiagnosticPersistenceSnapshot;
}

type DiagnosticContextProvider = () => DiagnosticEventMetadata;

const MAX_RECORDS = 100;
const MAX_MEMORY_EVENTS = 200;
const MAX_MESSAGE_LENGTH = 500;

function describePersistenceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "未知错误";
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
}

function normalizeMessage(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
}

/** 保存 Pi-press 运行期诊断和 usage 分类；可选存入独立诊断数据库。 */
export class Diagnostics {
  private readonly runtimeId = randomUUID();
  private readonly records: DiagnosticRecord[] = [];
  private readonly events: DiagnosticEvent[] = [];
  private readonly counters = new Map<string, number>();
  private consumedTokens = 0;
  private discardedTokens = 0;
  private contextProvider: DiagnosticContextProvider | undefined;
  private persistenceKey: string | undefined;
  private store: DiagnosticStore | undefined;
  private persistenceFailure: string | undefined;

  setContextProvider(provider: DiagnosticContextProvider): void {
    this.contextProvider = provider;
  }

  configurePersistence(
    key: string | undefined,
    createStore?: () => DiagnosticStore,
  ): void {
    if (key === this.persistenceKey) {
      return;
    }
    this.closeStore();
    this.persistenceKey = key;
    this.persistenceFailure = undefined;
    if (!key || !createStore) {
      return;
    }
    try {
      this.store = createStore();
    } catch (error) {
      this.disableStore(error);
    }
  }

  record(
    kind: DiagnosticKind,
    message: string,
    metadata: DiagnosticEventMetadata = {},
  ): void {
    const at = new Date().toISOString();
    const normalizedMessage = normalizeMessage(message);
    this.pushRecord({ kind, message: normalizedMessage, at });
    this.appendEvent(this.createEvent(
      "record",
      `${kind}_record`,
      at,
      metadata,
      normalizedMessage,
    ));
  }

  count(name: string, metadata: DiagnosticEventMetadata = {}): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
    const at = new Date().toISOString();
    this.appendEvent(this.createEvent("counter", name, at, metadata));
  }

  recordUsage(
    kind: "consumed" | "discarded",
    usage: Usage | undefined,
    metadata: DiagnosticEventMetadata = {},
  ): void {
    const totalTokens = usage?.totalTokens;
    if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0) {
      return;
    }
    if (kind === "consumed") {
      this.consumedTokens += totalTokens;
    } else {
      this.discardedTokens += totalTokens;
    }
    const at = new Date().toISOString();
    this.appendEvent(this.createEvent("usage", `usage_${kind}`, at, {
      ...metadata,
      details: {
        ...metadata.details,
        totalTokens,
      },
    }));
  }

  queryEvents(options: DiagnosticEventQuery): DiagnosticEvent[] {
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit)));
    if (this.store) {
      try {
        return this.store.query({ ...options, limit });
      } catch (error) {
        this.disableStore(error);
      }
    }
    return this.events
      .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
      .slice(-limit)
      .reverse();
  }

  close(): void {
    this.closeStore();
    this.persistenceKey = undefined;
  }

  snapshot(): DiagnosticSnapshot {
    return {
      records: [...this.records],
      events: [...this.events],
      counters: Object.fromEntries(this.counters),
      usageTokens: {
        consumed: this.consumedTokens,
        discarded: this.discardedTokens,
      },
      persistence: {
        enabled: this.store !== undefined,
        ...(this.store ? { location: this.store.location } : {}),
        ...(this.persistenceFailure ? { failure: this.persistenceFailure } : {}),
      },
    };
  }

  private createEvent(
    category: DiagnosticEventCategory,
    name: string,
    at: string,
    metadata: DiagnosticEventMetadata,
    message?: string,
  ): DiagnosticEvent {
    let context: DiagnosticEventMetadata = {};
    try {
      context = this.contextProvider?.() ?? {};
    } catch {
      // 状态快照失败时仍保留当前诊断事件。
    }
    return {
      at,
      processId: process.pid,
      runtimeId: this.runtimeId,
      category,
      name,
      ...context,
      ...metadata,
      ...(message === undefined ? {} : { message }),
    };
  }

  private appendEvent(event: DiagnosticEvent): void {
    this.pushMemoryEvent(event);
    if (!this.store) {
      return;
    }
    try {
      this.store.append(event);
    } catch (error) {
      this.disableStore(error);
    }
  }

  private pushMemoryEvent(event: DiagnosticEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_MEMORY_EVENTS) {
      this.events.shift();
    }
  }

  private pushRecord(record: DiagnosticRecord): void {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.shift();
    }
  }

  private disableStore(error: unknown): void {
    const failure = describePersistenceError(error);
    this.closeStore();
    if (this.persistenceFailure) {
      return;
    }
    this.persistenceFailure = failure;
    const at = new Date().toISOString();
    const message = `诊断持久化已停用：${failure}`;
    this.pushRecord({ kind: "lifecycle", message, at });
    this.pushMemoryEvent(this.createEvent(
      "record",
      "persistence_disabled",
      at,
      { reason: "diagnostic_store_failure" },
      message,
    ));
  }

  private closeStore(): void {
    const store = this.store;
    this.store = undefined;
    if (!store) {
      return;
    }
    try {
      store.close();
    } catch {
      // 关闭诊断数据库失败不得影响 Pi 生命周期。
    }
  }
}
