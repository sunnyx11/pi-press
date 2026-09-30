import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteDiagnosticStore } from "../../src/diagnostics-sqlite.js";
import { migrateDiagnosticTimes } from "../../scripts/migrate-diagnostics-time.js";

const scriptPath = fileURLToPath(new URL("../../scripts/migrate-diagnostics-time.ts", import.meta.url));
const atMs = Date.parse("2026-09-30T16:36:22.616Z");

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-press-time-migration-"));
  const databasePath = join(root, "diagnostics.sqlite3");
  const backupPath = join(root, "before.sqlite3");
  const store = new SqliteDiagnosticStore({
    databasePath,
    retentionDays: 30,
    maxDatabaseMiB: 64,
    now: () => atMs,
  });
  for (const name of ["first", "blocked", "normalized"]) {
    store.append({
      at: "2026-09-30T16:36:22.616Z",
      processId: 123,
      runtimeId: "runtime-1",
      category: "counter",
      name,
      sessionId: "session-1",
      epochCompactionId: null,
      details: { count: 1 },
      state: { runEpoch: 2 },
    });
  }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA wal_autocheckpoint = 0");
  database.prepare("UPDATE diagnostic_events SET at = ? WHERE name != 'normalized'")
    .run("2026-09-30T16:36:22.616Z");
  database.prepare("UPDATE diagnostic_events SET at = ? WHERE name = 'normalized'")
    .run("2026-10-01T00:36:22.616+08:00");
  return {
    root, databasePath, backupPath, database,
    close() {
      database.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("historical migration backs up WAL data and changes only at, with idempotent reruns", async () => {
  const fixture = createFixture();
  try {
    const before = fixture.database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all();
    assert.ok(existsSync(`${fixture.databasePath}-wal`));
    const result = await migrateDiagnosticTimes(fixture.databasePath, fixture.backupPath);
    assert.deepEqual(result, {
      databasePath: fixture.databasePath,
      backupPath: fixture.backupPath,
      totalRows: 3,
      convertedRows: 2,
    });
    const backup = new DatabaseSync(fixture.backupPath, { readOnly: true });
    try {
      assert.deepEqual(backup.prepare("SELECT * FROM diagnostic_events ORDER BY id").all(), before);
    } finally {
      backup.close();
    }
    const after = fixture.database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all();
    assert.deepEqual(after.map((row) => ({ ...row })), before.map((row) => ({ ...row, at: "2026-10-01T00:36:22.616+08:00" })));
    assert.equal(fixture.database.prepare("PRAGMA user_version").get()?.user_version, 1);
    const rerun = await migrateDiagnosticTimes(fixture.databasePath, join(fixture.root, "rerun.sqlite3"));
    assert.equal(rerun.convertedRows, 0);
    assert.equal(rerun.totalRows, 3);
  } finally {
    fixture.close();
  }
});

test("historical migration uses at_ms as the authoritative timestamp", async () => {
  const fixture = createFixture();
  try {
    fixture.database.prepare("UPDATE diagnostic_events SET at = 'invalid' WHERE name = 'first'").run();
    await migrateDiagnosticTimes(fixture.databasePath, fixture.backupPath);
    const row = fixture.database.prepare("SELECT at, at_ms FROM diagnostic_events WHERE name = 'first'").get();
    assert.equal(row?.at, "2026-10-01T00:36:22.616+08:00");
    assert.equal(row?.at_ms, atMs);
  } finally {
    fixture.close();
  }
});

test("historical migration rolls back a partial conversion and retains the original backup", async () => {
  const fixture = createFixture();
  try {
    fixture.database.exec(`
      CREATE TRIGGER reject_conversion BEFORE UPDATE OF at ON diagnostic_events
      WHEN OLD.name = 'blocked'
      BEGIN SELECT RAISE(ABORT, 'blocked conversion'); END;
    `);
    const before = fixture.database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all();
    await assert.rejects(migrateDiagnosticTimes(fixture.databasePath, fixture.backupPath), /blocked conversion/);
    assert.deepEqual(fixture.database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all(), before);
    const backup = new DatabaseSync(fixture.backupPath, { readOnly: true });
    try {
      assert.deepEqual(backup.prepare("SELECT * FROM diagnostic_events ORDER BY id").all(), before);
    } finally {
      backup.close();
    }
  } finally {
    fixture.close();
  }
});

test("historical migration preserves existing backup files and rejects unsupported schemas", async () => {
  const fixture = createFixture();
  try {
    const before = fixture.database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all();
    writeFileSync(fixture.backupPath, "existing backup");
    await assert.rejects(migrateDiagnosticTimes(fixture.databasePath, fixture.backupPath), /EEXIST/);
    assert.equal(readFileSync(fixture.backupPath, "utf8"), "existing backup");
    await assert.rejects(migrateDiagnosticTimes(fixture.databasePath, fixture.databasePath));
    fixture.database.exec("PRAGMA user_version = 2");
    const unusedBackup = join(fixture.root, "unsupported.sqlite3");
    await assert.rejects(migrateDiagnosticTimes(fixture.databasePath, unusedBackup), /版本/);
    assert.equal(existsSync(unusedBackup), false);
    assert.deepEqual(fixture.database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all(), before);
  } finally {
    fixture.close();
  }
});

test("migration CLI validates arguments and converts an explicit database", () => {
  const missingArguments = spawnSync(process.execPath, ["--import", "tsx", scriptPath], { encoding: "utf8" });
  assert.equal(missingArguments.status, 1);
  assert.match(missingArguments.stderr, /--database.*--backup/);
  const fixture = createFixture();
  try {
    const success = spawnSync(process.execPath, [
      "--import", "tsx", scriptPath,
      "--database", fixture.databasePath,
      "--backup", fixture.backupPath,
    ], { encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).convertedRows, 2);
    const missingPath = join(fixture.root, "missing.sqlite3");
    const failure = spawnSync(process.execPath, [
      "--import", "tsx", scriptPath,
      "--database", missingPath,
      "--backup", join(fixture.root, "unused.sqlite3"),
    ], { encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.equal(existsSync(missingPath), false);
  } finally {
    fixture.close();
  }
});
