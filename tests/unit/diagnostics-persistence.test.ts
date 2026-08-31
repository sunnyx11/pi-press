import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Diagnostics } from "../../src/diagnostics.js";
import { makeUsage } from "./fixtures.js";

type TestEvent = {
  id?: number;
  at: string;
  processId: number;
  runtimeId: string;
  category: "counter" | "record" | "usage";
  name: string;
  message?: string;
  sessionId?: string;
  epochCompactionId?: string | null;
  branchLeafId?: string;
  checkpointId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  state?: Record<string, unknown>;
};

type TestStore = {
  readonly location: string;
  append(event: TestEvent): void;
  query(options: { sessionId?: string; limit: number }): TestEvent[];
  prune(): void;
  close(): void;
};

type SqliteModule = {
  SqliteDiagnosticStore: new (options: {
    databasePath: string;
    retentionDays: number;
    maxDatabaseMiB: number;
    now?: () => number;
  }) => TestStore;
};

type PersistentDiagnostics = Diagnostics & {
  configurePersistence(key: string | undefined, createStore?: () => TestStore): void;
  setContextProvider(
    provider: () => {
      sessionId?: string;
      epochCompactionId?: string | null;
      branchLeafId?: string;
      checkpointId?: string;
      state?: Record<string, unknown>;
    },
  ): void;
  count(name: string, metadata?: Partial<TestEvent>): void;
  queryEvents(options: { sessionId?: string; limit: number }): TestEvent[];
  close(): void;
};

async function loadSqliteModule(): Promise<SqliteModule | undefined> {
  try {
    return await import("../../src/diagnostics-sqlite.js") as SqliteModule;
  } catch (error) {
    if (error instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function databasePath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pi-press-diagnostics-")), `${name}.sqlite3`);
}

function makeEvent(name: string, at: string, overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    at,
    processId: 123,
    runtimeId: "runtime-1",
    category: "counter",
    name,
    sessionId: "session-1",
    epochCompactionId: null,
    branchLeafId: "leaf-1",
    checkpointId: "checkpoint-1",
    reason: "test_reason",
    details: { count: 1 },
    state: { runEpoch: 2, inFlightTask: null },
    ...overrides,
  };
}

test("SQLite diagnostics survive reopening and support session-scoped recent queries", async () => {
  const sqliteModule = await loadSqliteModule();
  assert.ok(sqliteModule, "diagnostics-sqlite module should exist");
  const path = databasePath("persistence");
  const first = new sqliteModule.SqliteDiagnosticStore({
    databasePath: path,
    retentionDays: 30,
    maxDatabaseMiB: 64,
  });
  first.append(makeEvent("older", "2025-01-01T00:00:00.000Z"));
  first.append(makeEvent("other-session", "2025-01-01T00:00:01.000Z", {
    sessionId: "session-2",
  }));
  first.append(makeEvent("newer", "2025-01-01T00:00:02.000Z"));
  first.close();

  const reopened = new sqliteModule.SqliteDiagnosticStore({
    databasePath: path,
    retentionDays: 30,
    maxDatabaseMiB: 64,
    now: () => Date.parse("2025-01-02T00:00:00.000Z"),
  });
  const events = reopened.query({ sessionId: "session-1", limit: 2 });
  reopened.close();

  assert.deepEqual(events.map((event) => event.name), ["newer", "older"]);
  assert.equal(events[0]?.checkpointId, "checkpoint-1");
  assert.deepEqual(events[0]?.details, { count: 1 });
  assert.deepEqual(events[0]?.state, { runEpoch: 2, inFlightTask: null });
});

test("SQLite diagnostics remove events older than the configured retention period", async () => {
  const sqliteModule = await loadSqliteModule();
  assert.ok(sqliteModule, "diagnostics-sqlite module should exist");
  const store = new sqliteModule.SqliteDiagnosticStore({
    databasePath: databasePath("retention"),
    retentionDays: 30,
    maxDatabaseMiB: 64,
    now: () => Date.parse("2025-02-01T00:00:00.000Z"),
  });
  store.append(makeEvent("expired", "2024-12-01T00:00:00.000Z"));
  store.append(makeEvent("retained", "2025-01-15T00:00:00.000Z"));
  store.prune();
  const events = store.query({ limit: 10 });
  store.close();

  assert.deepEqual(events.map((event) => event.name), ["retained"]);
});

test("SQLite diagnostics remove the oldest events when the database exceeds its size limit", async () => {
  const sqliteModule = await loadSqliteModule();
  assert.ok(sqliteModule, "diagnostics-sqlite module should exist");
  const path = databasePath("size-limit");
  const store = new sqliteModule.SqliteDiagnosticStore({
    databasePath: path,
    retentionDays: 30,
    maxDatabaseMiB: 1,
    now: () => Date.parse("2025-02-01T00:00:00.000Z"),
  });
  for (let index = 0; index < 100; index += 1) {
    store.append(makeEvent(`event-${index}`, "2025-01-31T00:00:00.000Z", {
      details: { index, payload: "x".repeat(20_000) },
    }));
  }
  store.prune();
  const events = store.query({ limit: 200 });
  store.close();

  assert.ok(events.length < 100);
  assert.equal(events[0]?.name, "event-99");
  assert.ok(statSync(path).size <= 1024 * 1024);
});

test("Diagnostics persist structured state snapshots without affecting in-memory counters", async () => {
  const sqliteModule = await loadSqliteModule();
  assert.ok(sqliteModule, "diagnostics-sqlite module should exist");
  const store = new sqliteModule.SqliteDiagnosticStore({
    databasePath: databasePath("state"),
    retentionDays: 30,
    maxDatabaseMiB: 64,
  });
  const diagnostics = new Diagnostics() as PersistentDiagnostics;
  assert.equal(typeof diagnostics.configurePersistence, "function");
  assert.equal(typeof diagnostics.setContextProvider, "function");
  assert.equal(typeof diagnostics.queryEvents, "function");
  diagnostics.configurePersistence("sqlite:test", () => store);
  diagnostics.setContextProvider(() => ({
    sessionId: "session-1",
    epochCompactionId: "compaction-1",
    branchLeafId: "leaf-2",
    state: {
      runEpoch: 7,
      inFlightTask: { checkpointId: "checkpoint-1" },
      virtualApplication: null,
    },
  }));

  diagnostics.count("virtual_applied", {
    checkpointId: "checkpoint-1",
    reason: "checkpoint_ready",
    details: { sourceMessageCount: 12, projectedMessageCount: 4 },
  });
  diagnostics.recordUsage("consumed", makeUsage(42));

  const snapshot = diagnostics.snapshot();
  const events = diagnostics.queryEvents({ sessionId: "session-1", limit: 10 });
  diagnostics.close();

  assert.equal(snapshot.counters.virtual_applied, 1);
  const applied = events.find((event) => event.name === "virtual_applied");
  assert.equal(applied?.checkpointId, "checkpoint-1");
  assert.equal(applied?.reason, "checkpoint_ready");
  assert.deepEqual(applied?.details, {
    sourceMessageCount: 12,
    projectedMessageCount: 4,
  });
  assert.deepEqual(applied?.state, {
    runEpoch: 7,
    inFlightTask: { checkpointId: "checkpoint-1" },
    virtualApplication: null,
  });
  const usage = events.find((event) => event.name === "usage_consumed");
  assert.equal(usage?.details?.totalTokens, 42);
});

test("SQLite diagnostics omit in-memory diagnostic messages", async () => {
  const sqliteModule = await loadSqliteModule();
  assert.ok(sqliteModule, "diagnostics-sqlite module should exist");
  const store = new sqliteModule.SqliteDiagnosticStore({
    databasePath: databasePath("message-privacy"),
    retentionDays: 30,
    maxDatabaseMiB: 64,
  });
  const diagnostics = new Diagnostics() as PersistentDiagnostics;
  diagnostics.configurePersistence("sqlite:privacy", () => store);

  diagnostics.record("provider", "full-provider-response-secret");

  const memorySnapshot = diagnostics.snapshot();
  const events = diagnostics.queryEvents({ limit: 10 });
  diagnostics.close();

  assert.match(memorySnapshot.records[0]?.message ?? "", /full-provider-response-secret/);
  assert.equal(events[0]?.message, undefined);
  assert.doesNotMatch(JSON.stringify(events), /full-provider-response-secret/);
});

test("Diagnostics disable a failed store and keep recording in memory", () => {
  const diagnostics = new Diagnostics() as PersistentDiagnostics;
  assert.equal(typeof diagnostics.configurePersistence, "function");
  diagnostics.configurePersistence("failing", () => ({
    location: "failing.sqlite3",
    append: () => {
      throw new Error("database is busy");
    },
    query: () => [],
    prune: () => undefined,
    close: () => undefined,
  }));

  assert.doesNotThrow(() => diagnostics.count("task_started"));
  assert.doesNotThrow(() => diagnostics.count("task_started"));

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.counters.task_started, 2);
  assert.equal(snapshot.records.filter((record) => record.message.includes("诊断持久化")).length, 1);
  assert.equal(
    snapshot.events.filter((event) => event.name === "persistence_disabled").length,
    1,
  );
  assert.equal(
    snapshot.events.find((event) => event.name === "persistence_disabled")?.reason,
    "diagnostic_store_failure",
  );
});
