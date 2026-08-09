import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "./extension-runtime.js";

/** 注册 Pi-press 生命周期处理器。 */
export default function registerPiPress(pi: ExtensionAPI): void {
  const runtime = new ExtensionRuntime(pi);

  pi.on("session_start", (_event, ctx) => runtime.onSessionStart(ctx));
  pi.on("turn_end", (_event, ctx) => runtime.onTurnEnd(ctx));
  pi.on("session_before_compact", (event, ctx) => runtime.beforeCompact(event, ctx));
  pi.on("session_compact", (event, ctx) => runtime.onSessionCompact(event, ctx));
  pi.on("session_before_tree", () => runtime.onSessionBeforeTree());
  pi.on("session_tree", (_event, ctx) => runtime.onSessionTree(ctx));
  pi.on("session_shutdown", () => runtime.onSessionShutdown());
}
