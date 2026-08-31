import assert from "node:assert/strict";
import test from "node:test";

type CommandOptions = {
  sessionId: string;
  limit: number;
  json: boolean;
};

type CommandModule = {
  parseDiagnosticsCommand(
    args: string,
    currentSessionId: string,
  ): { options: CommandOptions } | { error: string };
  formatDiagnosticsReport(
    events: Array<Record<string, unknown>>,
    options: {
      databasePath?: string;
      sessionId: string;
      json: boolean;
    },
  ): string;
};

async function loadCommandModule(): Promise<CommandModule | undefined> {
  try {
    return await import("../../src/diagnostics-command.js") as unknown as CommandModule;
  } catch (error) {
    if (error instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

test("diagnostics command defaults to the current session and twenty recent events", async () => {
  const commandModule = await loadCommandModule();
  assert.ok(commandModule, "diagnostics-command module should exist");
  assert.deepEqual(commandModule.parseDiagnosticsCommand("", "session-current"), {
    options: {
      sessionId: "session-current",
      limit: 20,
      json: false,
    },
  });
});

test("diagnostics command accepts a specified session, event limit, and JSON output", async () => {
  const commandModule = await loadCommandModule();
  assert.ok(commandModule, "diagnostics-command module should exist");
  assert.deepEqual(
    commandModule.parseDiagnosticsCommand(
      "--session session-other --last 5 --json",
      "session-current",
    ),
    {
      options: {
        sessionId: "session-other",
        limit: 5,
        json: true,
      },
    },
  );
});

test("diagnostics command rejects unknown, missing, and out-of-range arguments", async () => {
  const commandModule = await loadCommandModule();
  assert.ok(commandModule, "diagnostics-command module should exist");
  const unknown = commandModule.parseDiagnosticsCommand("--unknown", "session");
  const missingSession = commandModule.parseDiagnosticsCommand("--session", "session");
  const outOfRange = commandModule.parseDiagnosticsCommand("--last 101", "session");
  assert.ok("error" in unknown);
  assert.ok("error" in missingSession);
  assert.ok("error" in outOfRange);
  assert.match(unknown.error, /未知参数/);
  assert.match(missingSession.error, /--session/);
  assert.match(outOfRange.error, /1 到 100/);
});

test("diagnostics command formats human-readable and JSON reports", async () => {
  const commandModule = await loadCommandModule();
  assert.ok(commandModule, "diagnostics-command module should exist");
  const events = [{
    id: 3,
    at: "2025-01-01T00:00:00.000Z",
    category: "counter",
    name: "virtual_applied",
    checkpointId: "checkpoint-1",
    reason: "checkpoint_ready",
    sessionId: "session-1",
    state: { runEpoch: 2 },
  }];

  const text = commandModule.formatDiagnosticsReport(events, {
    databasePath: "/agent/pi-press/diagnostics.sqlite3",
    sessionId: "session-1",
    json: false,
  });
  assert.match(text, /session-1/);
  assert.match(text, /virtual_applied/);
  assert.match(text, /checkpoint-1/);

  const json = JSON.parse(commandModule.formatDiagnosticsReport(events, {
    databasePath: "/agent/pi-press/diagnostics.sqlite3",
    sessionId: "session-1",
    json: true,
  })) as Record<string, unknown>;
  assert.equal(json.databasePath, "/agent/pi-press/diagnostics.sqlite3");
  assert.equal(json.sessionId, "session-1");
  assert.deepEqual(json.events, events);
});
