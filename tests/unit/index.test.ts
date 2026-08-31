import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import registerPiPress from "../../src/index.js";

type RegisteredCommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

test("extension registers and runs the pi-press diagnostics command", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, RegisteredCommandOptions>();
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, definition: RegisteredCommandOptions) => {
      commands.set(name, definition);
    },
    appendEntry: () => undefined,
  } as unknown as ExtensionAPI;

  registerPiPress(pi);

  const command = commands.get("pi-press-diagnostics");
  assert.ok(command);
  assert.match(command.description ?? "", /诊断/);
  assert.equal(typeof command.handler, "function");

  const ctx = {
    sessionManager: { getSessionId: () => "session-current" },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionCommandContext;
  await command.handler("--json", ctx);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "info");
  const report = JSON.parse(notifications[0]?.message ?? "") as Record<string, unknown>;
  assert.equal(report.sessionId, "session-current");
  assert.deepEqual(report.events, []);
});
