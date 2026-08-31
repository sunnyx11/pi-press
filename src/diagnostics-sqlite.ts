import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  DiagnosticEvent,
  DiagnosticEventQuery,
  DiagnosticStore,
} from "./diagnostics.js";
import type { JsonObject } from "./types.js";

export interface SqliteDiagnosticStoreOptions {
  databasePath: string;
  retentionDays: number;
  maxDatabaseMiB: number;
  now?: () => number;
}

type EventRow = {
  id: number;
  at: string;
  process_id: number;
  runtime_id: string;
  category: DiagnosticEvent["category"];
  name: string;
  message: string | null;
  session_id: string | null;
  epoch_compaction_id: string | null;
  branch_leaf_id: string | null;
  checkpoint_id: string | null;
  reason: string | null;
  details_json: string | null;
  state_json: string | null;
};

type SizeRow = {
  id: number;
  payload_bytes: number;
};

const require = createRequire(import.meta.url);
const SCHEMA_VERSION = 1;
const PRUNE_INTERVAL = 100;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MEBIBYTE = 1024 * 1024;

function loadDatabaseSync(): typeof DatabaseSync {
  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  return sqlite.DatabaseSync;
}

function readPragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row?.[pragma];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`无法读取 SQLite PRAGMA ${pragma}`);
  }
  return value;
}

function parseJsonObject(value: string | null): JsonObject | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("诊断数据库包含无效 JSON 对象");
  }
  return parsed as JsonObject;
}

function rowToEvent(row: EventRow): DiagnosticEvent {
  const details = parseJsonObject(row.details_json);
  const state = parseJsonObject(row.state_json);
  return {
    id: row.id,
    at: row.at,
    processId: row.process_id,
    runtimeId: row.runtime_id,
    category: row.category,
    name: row.name,
    ...(row.message === null ? {} : { message: row.message }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    epochCompactionId: row.epoch_compaction_id,
    ...(row.branch_leaf_id === null ? {} : { branchLeafId: row.branch_leaf_id }),
    ...(row.checkpoint_id === null ? {} : { checkpointId: row.checkpoint_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(details === undefined ? {} : { details }),
    ...(state === undefined ? {} : { state }),
  };
}

/** 返回默认诊断数据库路径。 */
export function getDiagnosticsDatabasePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-press", "diagnostics.sqlite3");
}

/** 使用 Node 内置 SQLite 保存独立于 session JSONL 的结构化诊断事件。 */
export class SqliteDiagnosticStore implements DiagnosticStore {
  readonly location: string;
  private readonly database: DatabaseSync;
  private readonly retentionMs: number;
  private readonly maxDatabaseBytes: number;
  private readonly now: () => number;
  private readonly insertStatement: StatementSync;
  private readonly queryAllStatement: StatementSync;
  private readonly querySessionStatement: StatementSync;
  private writesSincePrune = 0;
  private closed = false;

  constructor(options: SqliteDiagnosticStoreOptions) {
    this.location = resolve(options.databasePath);
    this.retentionMs = options.retentionDays * MILLISECONDS_PER_DAY;
    this.maxDatabaseBytes = options.maxDatabaseMiB * MEBIBYTE;
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(this.location), { recursive: true });
    const Database = loadDatabaseSync();
    this.database = new Database(this.location, { timeout: 25 });
    try {
      this.initialize();
      this.insertStatement = this.database.prepare(`
        INSERT INTO diagnostic_events (
          at_ms,
          at,
          process_id,
          runtime_id,
          category,
          name,
          message,
          session_id,
          epoch_compaction_id,
          branch_leaf_id,
          checkpoint_id,
          reason,
          details_json,
          state_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.queryAllStatement = this.database.prepare(`
        SELECT
          id,
          at,
          process_id,
          runtime_id,
          category,
          name,
          message,
          session_id,
          epoch_compaction_id,
          branch_leaf_id,
          checkpoint_id,
          reason,
          details_json,
          state_json
        FROM diagnostic_events
        ORDER BY id DESC
        LIMIT ?
      `);
      this.querySessionStatement = this.database.prepare(`
        SELECT
          id,
          at,
          process_id,
          runtime_id,
          category,
          name,
          message,
          session_id,
          epoch_compaction_id,
          branch_leaf_id,
          checkpoint_id,
          reason,
          details_json,
          state_json
        FROM diagnostic_events
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      `);
      this.prune();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  append(event: DiagnosticEvent): void {
    const atMs = Date.parse(event.at);
    if (!Number.isFinite(atMs)) {
      throw new Error("诊断事件时间无效");
    }
    this.insertStatement.run(
      atMs,
      event.at,
      event.processId,
      event.runtimeId,
      event.category,
      event.name,
      // 自由文本只保留在内存中，避免未知异常正文进入持久化诊断。
      null,
      event.sessionId ?? null,
      event.epochCompactionId ?? null,
      event.branchLeafId ?? null,
      event.checkpointId ?? null,
      event.reason ?? null,
      event.details === undefined ? null : JSON.stringify(event.details),
      event.state === undefined ? null : JSON.stringify(event.state),
    );
    this.writesSincePrune += 1;
    if (
      this.writesSincePrune >= PRUNE_INTERVAL ||
      this.databaseSizeBytes() > this.maxDatabaseBytes
    ) {
      this.prune();
    }
  }

  query(options: DiagnosticEventQuery): DiagnosticEvent[] {
    const rows = options.sessionId
      ? this.querySessionStatement.all(options.sessionId, options.limit)
      : this.queryAllStatement.all(options.limit);
    return (rows as EventRow[]).map(rowToEvent);
  }

  prune(): void {
    const cutoff = this.now() - this.retentionMs;
    this.database.prepare("DELETE FROM diagnostic_events WHERE at_ms < ?").run(cutoff);
    this.enforceSizeLimit();
    this.writesSincePrune = 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.database.close();
    }
  }

  private initialize(): void {
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 25");
    const version = readPragmaNumber(this.database, "user_version");
    if (version > SCHEMA_VERSION) {
      throw new Error(`诊断数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        id INTEGER PRIMARY KEY,
        at_ms INTEGER NOT NULL,
        at TEXT NOT NULL,
        process_id INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        message TEXT,
        session_id TEXT,
        epoch_compaction_id TEXT,
        branch_leaf_id TEXT,
        checkpoint_id TEXT,
        reason TEXT,
        details_json TEXT,
        state_json TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS diagnostic_events_session_id_id
        ON diagnostic_events (session_id, id DESC);
      CREATE INDEX IF NOT EXISTS diagnostic_events_at_ms
        ON diagnostic_events (at_ms);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  private enforceSizeLimit(): void {
    let currentBytes = this.databaseSizeBytes();
    for (let attempt = 0; currentBytes > this.maxDatabaseBytes && attempt < 5; attempt += 1) {
      const rows = this.database.prepare(`
        SELECT
          id,
          length(CAST(COALESCE(message, '') AS BLOB)) +
          length(CAST(COALESCE(details_json, '') AS BLOB)) +
          length(CAST(COALESCE(state_json, '') AS BLOB)) + 256 AS payload_bytes
        FROM diagnostic_events
        ORDER BY id ASC
      `).all() as SizeRow[];
      if (rows.length <= 1) {
        break;
      }
      const bytesToRemove = Math.max(
        currentBytes - Math.floor(this.maxDatabaseBytes * 0.75),
        1,
      );
      let removedBytes = 0;
      let cutoffId = rows[0]!.id;
      for (const row of rows.slice(0, -1)) {
        removedBytes += row.payload_bytes;
        cutoffId = row.id;
        if (removedBytes >= bytesToRemove) {
          break;
        }
      }
      this.database.prepare(`
        DELETE FROM diagnostic_events
        WHERE id <= ? AND id < (SELECT MAX(id) FROM diagnostic_events)
      `).run(cutoffId);
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.database.exec("VACUUM");
      currentBytes = this.databaseSizeBytes();
    }
  }

  private databaseSizeBytes(): number {
    return readPragmaNumber(this.database, "page_count") *
      readPragmaNumber(this.database, "page_size");
  }
}
