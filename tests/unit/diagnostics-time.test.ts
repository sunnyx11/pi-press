import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Diagnostics, formatDiagnosticTimestamp } from "../../src/diagnostics.js";
import type { DiagnosticEvent, DiagnosticStore } from "../../src/diagnostics.js";
import { SqliteDiagnosticStore } from "../../src/diagnostics-sqlite.js";
import { formatDiagnosticsReport } from "../../src/diagnostics-command.js";
import { makeUsage } from "./fixtures.js";

test("diagnostic timestamps use fixed Beijing time across date boundaries", () => {
  const cases = [
    ["2026-09-30T16:36:22.616Z", "2026-10-01T00:36:22.616+08:00"],
    ["2024-12-31T16:00:00.000Z", "2025-01-01T00:00:00.000+08:00"],
    ["2024-02-28T16:00:00.000Z", "2024-02-29T00:00:00.000+08:00"],
    ["2024-02-29T16:00:00.000Z", "2024-03-01T00:00:00.000+08:00"],
    ["1969-12-31T16:00:00.000Z", "1970-01-01T00:00:00.000+08:00"],
  ];
  for (const [utc, expected] of cases) {
    const atMs = Date.parse(utc!);
    const formatted = formatDiagnosticTimestamp(atMs);
    assert.equal(formatted, expected);
    assert.equal(Date.parse(formatted), atMs);
  }
  assert.throws(() => formatDiagnosticTimestamp(Number.NaN), RangeError);
});

test("all in-memory diagnostic creation and failure paths use Beijing time", () => {
  const diagnostics = new Diagnostics();
  const failingStore: DiagnosticStore = {
    location: "failing.sqlite3",
    append() { throw new Error("database is busy"); },
    query: () => [],
    prune: () => undefined,
    close: () => undefined,
  };
  diagnostics.configurePersistence("failing", () => failingStore);
  const before = Date.now();
  diagnostics.count("task_started");
  diagnostics.record("task", "任务已启动");
  diagnostics.recordUsage("consumed", makeUsage(42));
  const after = Date.now();
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.events.length, 4);
  assert.equal(snapshot.records.length, 2);
  for (const entry of [...snapshot.events, ...snapshot.records]) {
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
    assert.ok(Date.parse(entry.at) >= before && Date.parse(entry.at) <= after);
  }
  assert.equal(snapshot.events[2]?.at, snapshot.records[1]?.at);
  assert.equal(snapshot.counters.task_started, 1);
  assert.equal(snapshot.usageTokens.consumed, 42);
});

test("SQLite normalizes input timezones without changing absolute timestamps or reports", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-time-"));
  const path = join(root, "diagnostics.sqlite3");
  const atMs = Date.parse("2026-09-30T16:36:22.616Z");
  const options = {
    databasePath: path,
    retentionDays: 30,
    maxDatabaseMiB: 64,
    now: () => atMs,
  };
  let store = new SqliteDiagnosticStore(options);
  try {
    const event: DiagnosticEvent = {
      at: "2026-09-30T16:36:22.616Z",
      processId: 123,
      runtimeId: "runtime-1",
      category: "counter",
      name: "task_started",
      sessionId: "session-1",
    };
    store.append(event);
    store.append({ ...event, at: "2026-09-30T12:36:22.616-04:00" });
    store.append({ ...event, at: "2026-10-01T00:36:22.616+08:00" });
    assert.throws(() => store.append({ ...event, at: "invalid" }), /诊断事件时间无效/);
    store.close();
    store = new SqliteDiagnosticStore(options);
    const events = store.query({ sessionId: "session-1", limit: 10 });
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((entry) => entry.at), Array(3).fill("2026-10-01T00:36:22.616+08:00"));
    assert.equal(event.at, "2026-09-30T16:36:22.616Z");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = database.prepare("SELECT at_ms FROM diagnostic_events").all();
      assert.deepEqual(rows.map((row) => row.at_ms), [atMs, atMs, atMs]);
    } finally {
      database.close();
    }
    const reportOptions = { sessionId: "session-1", databasePath: path };
    assert.match(formatDiagnosticsReport(events, { ...reportOptions, json: false }), /2026-10-01T00:36:22\.616\+08:00/);
    const json = JSON.parse(formatDiagnosticsReport(events, { ...reportOptions, json: true })) as { events: DiagnosticEvent[] };
    assert.deepEqual(json.events, events);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
