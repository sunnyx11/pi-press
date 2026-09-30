import { closeSync, openSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { formatDiagnosticTimestamp } from "../src/diagnostics.js";

interface MigrationRow extends Record<string, unknown> {
  id: number;
  at_ms: number;
  at: string;
}

export interface DiagnosticTimeMigrationResult {
  databasePath: string;
  backupPath: string;
  totalRows: number;
  convertedRows: number;
}

function readRows(database: DatabaseSync): MigrationRow[] {
  return database.prepare("SELECT * FROM diagnostic_events ORDER BY id").all()
    .map((row) => ({ ...row })) as MigrationRow[];
}

/**
 * 在 Pi 写入暂停后转换版本 1 诊断库；backupPath 必须是新的备份文件。
 * 返回文件位置和转换数量，只更新 at；错误时回滚，保留已完成的备份。
 */
export async function migrateDiagnosticTimes(
  databasePath: string,
  backupPath: string,
): Promise<DiagnosticTimeMigrationResult> {
  const location = resolve(databasePath);
  const backupLocation = resolve(backupPath);
  if (location === backupLocation) {
    throw new Error("诊断数据库与备份文件必须使用不同位置");
  }
  if (!statSync(location).isFile()) {
    throw new Error("诊断数据库必须是已有文件");
  }
  const database = new DatabaseSync(location, { timeout: 1_000 });
  let transactionOpen = false;
  try {
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1) {
      throw new Error(`诊断数据库版本 ${String(version)} 不支持时间转换`);
    }
    database.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const before = readRows(database);
    closeSync(openSync(backupLocation, "wx", 0o600));
    // 独立只读连接包含已提交的 WAL 数据；写事务使备份与转换共享同一状态。
    const source = new DatabaseSync(location, { readOnly: true, timeout: 1_000 });
    try {
      await backup(source, backupLocation);
    } finally {
      source.close();
    }
    const saved = new DatabaseSync(backupLocation, { readOnly: true });
    try {
      if (!isDeepStrictEqual(readRows(saved), before)) {
        throw new Error("诊断数据库备份内容校验失败");
      }
    } finally {
      saved.close();
    }
    const expected = before.map((row) => {
      if (!Number.isSafeInteger(row.at_ms)) {
        throw new Error(`诊断记录 ${row.id} 的 at_ms 必须是安全整数`);
      }
      const at = formatDiagnosticTimestamp(row.at_ms);
      if (Date.parse(at) !== row.at_ms) {
        throw new Error(`诊断记录 ${row.id} 的时间转换校验失败`);
      }
      return { ...row, at };
    });
    const update = database.prepare("UPDATE diagnostic_events SET at = ? WHERE id = ?");
    let convertedRows = 0;
    for (let index = 0; index < before.length; index += 1) {
      const row = expected[index]!;
      if (row.at !== before[index]!.at) {
        update.run(row.at, row.id);
        convertedRows += 1;
      }
    }
    if (!isDeepStrictEqual(readRows(database), expected)) {
      throw new Error("诊断数据库转换后记录或字段校验失败");
    }
    database.exec("COMMIT");
    transactionOpen = false;
    return {
      databasePath: location,
      backupPath: backupLocation,
      totalRows: before.length,
      convertedRows,
    };
  } finally {
    try {
      if (transactionOpen) {
        database.exec("ROLLBACK");
      }
    } finally {
      database.close();
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [databaseFlag, databasePath, backupFlag, backupPath] = args;
  if (args.length !== 4 || databaseFlag !== "--database" || backupFlag !== "--backup" ||
      !databasePath || databasePath.startsWith("--") || !backupPath || backupPath.startsWith("--")) {
    throw new Error("用法：npm run diagnostics:migrate-time -- --database <已有数据库> --backup <新备份文件>");
  }
  const result = await migrateDiagnosticTimes(databasePath, backupPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
