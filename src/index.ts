import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatDiagnosticsReport,
  parseDiagnosticsCommand,
} from "./diagnostics-command.js";
import { Diagnostics } from "./diagnostics.js";
import {
  getDiagnosticsDatabasePath,
  SqliteDiagnosticStore,
} from "./diagnostics-sqlite.js";
import { ExtensionRuntime } from "./extension-runtime.js";

/** 注册 Pi-press 生命周期处理器。 */
export default function registerPiPress(pi: ExtensionAPI): void {
  const runtime = new ExtensionRuntime(
    pi,
    new Diagnostics(),
    (configuration) => new SqliteDiagnosticStore({
      databasePath: getDiagnosticsDatabasePath(),
      retentionDays: configuration.retentionDays,
      maxDatabaseMiB: configuration.maxDatabaseMiB,
    }),
  );

  pi.registerCommand("pi-press-diagnostics", {
    description: "查询 Pi-press 当前或指定 session 的结构化诊断事件",
    handler: async (args, ctx) => {
      const parsed = parseDiagnosticsCommand(args, ctx.sessionManager.getSessionId());
      if ("error" in parsed) {
        ctx.ui.notify(parsed.error, "warning");
        return;
      }
      const events = runtime.queryDiagnosticEvents({
        sessionId: parsed.options.sessionId,
        limit: parsed.options.limit,
      });
      const persistence = runtime.getDiagnostics().persistence;
      const report = formatDiagnosticsReport(events, {
        ...(persistence.location === undefined
          ? {}
          : { databasePath: persistence.location }),
        sessionId: parsed.options.sessionId,
        json: parsed.options.json,
      });
      ctx.ui.notify(report, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => runtime.onSessionStart(ctx));
  pi.on("turn_end", (_event, ctx) => runtime.onTurnEnd(ctx));
  pi.on("context", (event, ctx) => runtime.onContext(event, ctx));
  pi.on("agent_settled", (_event, ctx) => runtime.onAgentSettled(ctx));
  pi.on("session_before_compact", (event, ctx) => runtime.beforeCompact(event, ctx));
  pi.on("session_compact", (event, ctx) => runtime.onSessionCompact(event, ctx));
  pi.on("session_compact_failed", (event) => runtime.onSessionCompactFailed(event));
  pi.on("session_before_tree", () => runtime.onSessionBeforeTree());
  pi.on("session_tree", (_event, ctx) => runtime.onSessionTree(ctx));
  pi.on("session_shutdown", () => runtime.onSessionShutdown());
}
