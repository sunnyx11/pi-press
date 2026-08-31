import type { DiagnosticEvent } from "./diagnostics.js";

export interface DiagnosticsCommandOptions {
  sessionId: string;
  limit: number;
  json: boolean;
}

export type DiagnosticsCommandParseResult =
  | { options: DiagnosticsCommandOptions }
  | { error: string };

export interface DiagnosticsReportOptions {
  databasePath?: string;
  sessionId: string;
  json: boolean;
}

export const DIAGNOSTICS_COMMAND_USAGE =
  "/pi-press-diagnostics [--session <id>] [--last <1-100>] [--json]";

/** 解析诊断命令参数。 */
export function parseDiagnosticsCommand(
  args: string,
  currentSessionId: string,
): DiagnosticsCommandParseResult {
  const tokens = args.trim() ? args.trim().split(/\s+/u) : [];
  let sessionId = currentSessionId;
  let limit = 20;
  let json = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--session") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        return { error: `--session 需要 session ID。用法：${DIAGNOSTICS_COMMAND_USAGE}` };
      }
      sessionId = value;
      index += 1;
      continue;
    }
    if (token === "--last") {
      const value = tokens[index + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return { error: `--last 必须是 1 到 100 的整数。用法：${DIAGNOSTICS_COMMAND_USAGE}` };
      }
      limit = parsed;
      index += 1;
      continue;
    }
    return { error: `未知参数 ${token}。用法：${DIAGNOSTICS_COMMAND_USAGE}` };
  }
  return { options: { sessionId, limit, json } };
}

/** 将诊断事件格式化为终端文本或可复制的 JSON。 */
export function formatDiagnosticsReport(
  events: readonly DiagnosticEvent[],
  options: DiagnosticsReportOptions,
): string {
  if (options.json) {
    return JSON.stringify({
      ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
      sessionId: options.sessionId,
      events,
    }, null, 2);
  }

  const lines = [
    `Pi-press 诊断：session=${options.sessionId}，最近 ${events.length} 条`,
    `数据库：${options.databasePath ?? "内存模式"}`,
  ];
  if (events.length === 0) {
    lines.push("没有匹配的诊断事件。");
    return lines.join("\n");
  }
  for (const event of events) {
    const attributes = [
      event.checkpointId ? `checkpoint=${event.checkpointId}` : undefined,
      event.reason ? `reason=${event.reason}` : undefined,
      event.branchLeafId ? `leaf=${event.branchLeafId}` : undefined,
    ].filter((value): value is string => value !== undefined);
    lines.push(
      `[${event.at}] ${event.name}${attributes.length > 0 ? ` ${attributes.join(" ")}` : ""}`,
    );
  }
  return lines.join("\n");
}
