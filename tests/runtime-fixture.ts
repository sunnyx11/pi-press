import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  DEFAULT_COMPACTION_SETTINGS,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createCheckpointPreparationSettings,
  prepareCompactionFromBranch,
} from "../src/compaction/preparation.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ExtensionRuntime } from "../src/extension-runtime.js";
import type { PiPressConfig } from "../src/types.js";
import { makeUserMessage } from "./unit/fixtures.js";

export type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

export type ResponseFactory = () => Promise<ReturnType<typeof fauxAssistantMessage>>;

export type RuntimeScenario = {
  cwd: string;
  manager: SessionManager;
  faux: ReturnType<typeof fauxProvider>;
  config: PiPressConfig;
  runtime: ExtensionRuntime;
  ctx: ExtensionContext;
  firstEntryId: string;
  recentEntryId: string;
  appended: unknown[];
  notifications: Notification[];
  appendState: {
    notificationCount: number;
  };
};

const defaultResponse: ResponseFactory = async () => fauxAssistantMessage("checkpoint summary");

export function createScenario(
  overrides: Partial<PiPressConfig> = {},
  responseFactory: ResponseFactory = defaultResponse,
  appendEntry?: (customType: string, data: unknown) => void,
): RuntimeScenario {
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-runtime-"));
  mkdirSync(join(cwd, ".pi"));
  const config: PiPressConfig = {
    ...DEFAULT_CONFIG,
    softThresholdPercent: 80,
    summaryReserveTokens: 1,
    taskTimeoutMs: 2_000,
    hookWaitTimeoutMs: 500,
    ...overrides,
  };
  writeFileSync(join(cwd, ".pi", "pi-press.json"), JSON.stringify(config));
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      compaction: { keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens },
    }),
  );

  const manager = SessionManager.inMemory(cwd);
  const firstEntryId = manager.appendMessage(makeUserMessage("old history ".repeat(6_000)));
  const recentEntryId = manager.appendMessage(makeUserMessage("recent context ".repeat(6_000)));
  const faux = fauxProvider({
    api: "openai-responses",
    provider: "test",
    models: [{ id: "model-id", contextWindow: 100_000, maxTokens: 4_096 }],
  });
  faux.setResponses([responseFactory]);
  const model = faux.getModel();
  const appended: unknown[] = [];
  const notifications: Notification[] = [];
  const appendState = { notificationCount: -1 };
  const pi = {
    appendEntry: (customType: string, data: unknown) => {
      appendState.notificationCount = notifications.length;
      if (appendEntry) {
        appendEntry(customType, data);
        return;
      }
      appended.push(data);
      manager.appendCustomEntry(customType, data);
    },
  } as Pick<ExtensionAPI, "appendEntry">;
  const ctx = {
    cwd,
    sessionManager: manager,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true as const }),
      getProvider: () => faux.provider,
    },
    thinkingLevel: "medium",
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push({ message, type });
      },
    },
    getContextUsage: () => ({ tokens: 90_000, contextWindow: model.contextWindow, percent: 90 }),
  } as unknown as ExtensionContext;
  const runtime = new ExtensionRuntime(pi);
  runtime.onSessionStart(ctx);

  return {
    cwd,
    manager,
    faux,
    config,
    runtime,
    ctx,
    firstEntryId,
    recentEntryId,
    appended,
    notifications,
    appendState,
  };
}

export function makeCompactEvent(
  scenario: RuntimeScenario,
  signal: AbortSignal,
): SessionBeforeCompactEvent {
  const preparation = prepareCompactionFromBranch(
    scenario.manager.getBranch(),
    createCheckpointPreparationSettings(scenario.config),
  );
  assert.ok(preparation);
  return {
    type: "session_before_compact",
    preparation,
    branchEntries: scenario.manager.getBranch(),
    reason: "threshold",
    willRetry: false,
    signal,
  } satisfies SessionBeforeCompactEvent;
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not met before timeout");
}
