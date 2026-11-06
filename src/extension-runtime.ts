import { randomUUID } from "node:crypto";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  contentText,
  getCurrentSystemMessage,
  isRetryableAssistantError,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  VERSION,
  buildSessionProjection,
  compact,
  estimateTokens,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ContextEvent,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionCompactFailedEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  calculateContextCapacityLimits,
  calculateCriticalWaitTokens,
  estimateCheckpointCapacity,
} from "./checkpoint/capacity.js";
import {
  findReadyCheckpointCandidates,
  getEpochCompactionId,
  getEntryIndex,
  getSnapshotSourceLeafId,
  isBeforeOrSame,
  isSnapshotProjectionCompatible,
} from "./checkpoint/selection.js";
import { isJsonObject, isUsage, parseCheckpointData } from "./checkpoint/schema.js";
import {
  loadConfig,
  loadPiCompactionKeepRecentTokens,
  loadPiCompactionReserveTokens,
  createSnapshotKey,
  configFingerprint,
  DEFAULT_CONFIG,
} from "./config.js";
import {
  Diagnostics,
  type DiagnosticEvent,
  type DiagnosticEventMetadata,
  type DiagnosticEventQuery,
  type DiagnosticStore,
} from "./diagnostics.js";
import {
  buildCheckpointCompactionResult,
  calculateOriginalTokensBefore,
} from "./compaction/reuse.js";
import {
  estimateAppliedCheckpointBranchTokens,
  tryProjectCheckpointToVirtualContext,
  VirtualContextProjectionCache,
} from "./compaction/virtual-context.js";
import {
  CHECKPOINT_KEEP_RECENT_TOKENS,
  createCheckpointPreparationSettings,
  createFormalizationPreparationSettings,
  estimateMessagesTokens,
  prepareCompactionFromBranch,
} from "./compaction/preparation.js";
import { resolveProviderRequest } from "./provider/request.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  CHECKPOINT_VERSION,
  PREPARATION_ALGORITHM_VERSION,
  SUMMARY_FORMAT_VERSION,
  type CheckpointCandidate,
  type CheckpointData,
  type CompactionCapacityEstimate,
  type CompactionPreparation,
  type JsonObject,
  type PiPressConfig,
} from "./types.js";

const RETRY_BASE_DELAY_MS = 250;
const MAX_BACKGROUND_RETRIES = 1;
const MAX_FORMALIZATION_ATTEMPTS = 2;
const SESSION_TOO_SMALL_ERROR = "Nothing to compact (session too small)";

// Pi reload 会重新创建模块实例；全局 Symbol 让未结束的请求继续占用后台名额。
const SHARED_RUNTIME_STATE_KEY = Symbol.for("pi-press.runtime-state.v1");

type SharedRuntimeState = {
  activeBackgroundOperation?: Promise<void>;
};

const runtimeStateHost = globalThis as typeof globalThis & {
  [SHARED_RUNTIME_STATE_KEY]?: SharedRuntimeState;
};
const sharedRuntimeState = runtimeStateHost[SHARED_RUNTIME_STATE_KEY] ??= {};

type SessionManager = ExtensionContext["sessionManager"];
type ModelRegistry = ExtensionContext["modelRegistry"];

type BackgroundTaskStage = "preparation" | "auth" | "history_summary" | "turn_prefix_summary" | "retry_backoff" | "checkpoint";

type TaskFailureKind =
  | "transient_error"
  | "empty_summary"
  | "invalid_summary"
  | "deterministic_error";

type BackgroundTask = {
  taskId: string;
  stage: BackgroundTaskStage;
  stageStartedAt: number;
  requestCount: number;
  retryCount: number;
  sessionId: string;
  runEpoch: number;
  snapshotLeafId: string;
  snapshotSourceLeafId: string;
  epochCompactionId: string | null;
  snapshotKey: string;
  branchEntries: SessionEntry[];
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  reserveTokens: number;
  config: PiPressConfig;
  controller: AbortController;
  startedAt: number;
  keepRecentTokens?: number;
  firstKeptEntryId?: string;
  parentCheckpoint?: CheckpointData;
  promise?: Promise<void>;
  discarded: boolean;
  failureKind?: TaskFailureKind | undefined;
};

type CheckpointClaim = {
  checkpointId: string;
  signal: AbortSignal;
  abortHandler: () => void;
};

type VirtualApplication = {
  checkpointId: string;
  sessionId: string;
  epochCompactionId: string | null;
  firstAppliedLeafId: string;
  lastAppliedLeafId: string;
  modelKey: string;
  refreshRequested: boolean;
};

type FormalizationSchedule = {
  requestId: string;
  runEpoch: number;
  checkpointId: string;
  sessionId: string;
  epochCompactionId: string | null;
  scheduledLeafId: string;
  ctx: ExtensionContext;
  timer?: NodeJS.Timeout;
};

type PendingFormalization = Omit<FormalizationSchedule, "ctx" | "timer"> & {
  attempt: number;
  compaction?: {
    signal: AbortSignal;
    isCurrent: boolean;
    cancelled: boolean;
  };
};

type DeferredFormalization = {
  checkpointId: string;
  sessionId: string;
  epochCompactionId: string | null;
  checkedLeafId: string;
};

type LastContextEvaluation = {
  runEpoch: number;
  sessionId: string;
  epochCompactionId: string | null;
  leafId: string | null;
  conversationMessages: ContextEvent["messages"];
  conversationEstimatedTokens: number;
  countedSystemTokens: number;
  hardLimit: number;
  refreshLimit: number;
  foregroundAttempted: boolean;
  aborted: boolean;
};

type ForegroundWaitProgressHandle = {
  runEpoch: number;
  closed: boolean;
  timer?: NodeJS.Timeout | undefined;
  refresh: () => void;
  cleanup: () => void;
};

type WaitOutcome = "finished" | "timeout" | "aborted";
type CheckpointAppendOutcome = "appended" | "skipped" | "failed";
type NotificationType = "info" | "warning" | "error";
type Notify = (message: string, type?: NotificationType) => void;

export interface DiagnosticStoreConfiguration {
  retentionDays: number;
  maxDatabaseMiB: number;
}

export type DiagnosticStoreFactory = (
  configuration: DiagnosticStoreConfiguration,
) => DiagnosticStore;

function asModel(model: unknown): Model<Api> | undefined {
  return model as Model<Api> | undefined;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || error.message === "The operation was aborted");
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isSessionTooSmallError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_TOO_SMALL_ERROR;
}

function getCheckpointIdFromDetails(details: unknown): string | undefined {
  if (!isJsonObject(details) || !isJsonObject(details.piPress)) {
    return undefined;
  }
  const checkpointId = details.piPress.checkpointId;
  return typeof checkpointId === "string" && checkpointId.length > 0 ? checkpointId : undefined;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim() || "Unknown error";
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
}

function describeCapacityRejection(checkpointId: string, capacity: CompactionCapacityEstimate): string {
  return `Checkpoint ${checkpointId}: estimated post-compaction size is ${capacity.estimatedTokensAfter} tokens; hard limit is ${capacity.hardLimit} tokens`;
}

function sanitizeProvenanceBaseUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isProjectTrustedContext(ctx: ExtensionContext): boolean {
  return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
}

function hasContextSourceProgressAfter(
  branch: readonly SessionEntry[],
  afterIndex: number,
): boolean {
  for (let index = afterIndex + 1; index < branch.length; index += 1) {
    const entry = branch[index];
    if (!entry) {
      continue;
    }
    if (entry.type === "context_edit" || sessionEntryToContextMessages(entry).length > 0) {
      return true;
    }
  }
  return false;
}

function hasInvalidatingEntryAfterLastAssistant(branch: readonly SessionEntry[]): boolean {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry) {
      continue;
    }
    if (entry.type === "context_edit" || entry.type === "compaction") {
      return true;
    }
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason !== "aborted" &&
      entry.message.stopReason !== "error"
    ) {
      return false;
    }
  }
  return false;
}

function estimateContextMessagesTokens(
  messages: readonly ContextEvent["messages"][number][],
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message);
  }
  return total;
}

/** 管理单个扩展实例的 session 状态、后台摘要任务和 checkpoint 复用。 */
export class ExtensionRuntime {
  private readonly diagnostics: Diagnostics;
  private currentSessionManager: SessionManager | undefined;
  private currentModelRegistry: ModelRegistry | undefined;
  private currentSessionId: string | undefined;
  private currentEpochCompactionId: string | null | undefined;
  private currentNotify: Notify | undefined;
  private currentConfig: PiPressConfig = { ...DEFAULT_CONFIG };
  private runEpoch = 0;
  private inFlightTask: BackgroundTask | undefined;
  private checkpointClaim: CheckpointClaim | undefined;
  private hookInFlight = false;
  private readonly attemptsBySnapshotKey = new Map<string, number>();
  private readonly formalizationAttemptsByEpoch = new Map<string, number>();
  private readonly reportedConfigDiagnostics = new Set<string>();
  private removedTargetPercentReported = false;
  private removedSummaryReserveReported = false;
  private virtualApplication: VirtualApplication | undefined;
  private formalizationSchedule: FormalizationSchedule | undefined;
  private pendingFormalization: PendingFormalization | undefined;
  private deferredFormalization: DeferredFormalization | undefined;
  private lastContextEvaluation: LastContextEvaluation | undefined;
  private activeForegroundWait: ForegroundWaitProgressHandle | undefined;
  private readonly virtualContextCache = new VirtualContextProjectionCache();
  private readonly recordedTranscriptDeltas = new Map<string, number>();
  private lastUnpersistedCandidate: { sessionId: string; candidate: CheckpointData } | undefined;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry">,
    diagnostics = new Diagnostics(),
    private readonly diagnosticStoreFactory?: DiagnosticStoreFactory,
  ) {
    this.diagnostics = diagnostics;
    this.diagnostics.setContextProvider(() => this.captureDiagnosticContext());
  }

  getDiagnostics(): ReturnType<Diagnostics["snapshot"]> {
    return this.diagnostics.snapshot();
  }

  queryDiagnosticEvents(options: DiagnosticEventQuery): DiagnosticEvent[] {
    return this.diagnostics.queryEvents(options);
  }

  onSessionStart(ctx: ExtensionContext): void {
    this.invalidate("session_start", true);
    this.bindContext(ctx);
    this.loadCurrentConfig(ctx);
    this.diagnostics.count("session_started");
  }

  onSessionBeforeTree(): void {
    this.diagnostics.count("session_before_tree");
    this.invalidate("session_before_tree", true);
  }

  onSessionTree(ctx: ExtensionContext): void {
    this.bindContext(ctx);
    this.loadCurrentConfig(ctx);
    this.diagnostics.count("session_tree_loaded");
  }

  onSessionShutdown(): void {
    this.diagnostics.count("session_shutdown");
    this.invalidate("session_shutdown", true);
    this.diagnostics.close();
  }

  onContext(
    event: ContextEvent,
    ctx: ExtensionContext,
  ): Pick<ContextEvent, "messages"> | Promise<Pick<ContextEvent, "messages">> {
    try {
      const result = this.applyVirtualContext(event, ctx);
      return result instanceof Promise
        ? result.catch((error: unknown) => this.handleVirtualContextError(event, error))
        : result;
    } catch (error: unknown) {
      return this.handleVirtualContextError(event, error);
    }
  }

  onContextWithSystem(
    event: ContextWithSystemEvent,
    ctx: ExtensionContext,
  ):
    | Pick<ContextWithSystemEvent, "messages">
    | undefined
    | Promise<Pick<ContextWithSystemEvent, "messages"> | undefined> {
    try {
      const result = this.verifyContextWithSystem(event, ctx);
      return result instanceof Promise
        ? result.catch((error: unknown) => {
          this.diagnostics.count("virtual_failed");
          this.diagnostics.record(
            "checkpoint",
            `Full context validation failed: ${describeError(error)}`,
          );
          return undefined;
        })
        : result;
    } catch (error: unknown) {
      this.diagnostics.count("virtual_failed");
      this.diagnostics.record(
        "checkpoint",
        `Full context validation failed: ${describeError(error)}`,
      );
      return undefined;
    }
  }

  private handleVirtualContextError(
    event: ContextEvent,
    error: unknown,
  ): Pick<ContextEvent, "messages"> {
    this.diagnostics.count("virtual_failed");
    this.diagnostics.record(
      "checkpoint",
      `Virtual context processing failed: ${describeError(error)}`,
    );
    return { messages: event.messages };
  }

  private applyVirtualContext(
    event: ContextEvent,
    ctx: ExtensionContext,
    allowWait = true,
  ): Pick<ContextEvent, "messages"> | Promise<Pick<ContextEvent, "messages">> {
    this.bindContext(ctx);
    if (this.currentConfig.precomputeMode === "off") {
      return { messages: event.messages };
    }
    const model = asModel(ctx.model);
    if (!model) {
      this.diagnostics.count("virtual_skipped_unknown_model");
      return { messages: event.messages };
    }

    const branch = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const epochCompactionId = getEpochCompactionId(branch);
    if (this.isFormalizationExhausted(sessionId, epochCompactionId)) {
      return { messages: event.messages };
    }
    const compatibleTaskBeforeCheck = this.findCompatibleTask(ctx);
    const candidates = findReadyCheckpointCandidates(
      branch,
      sessionId,
      epochCompactionId,
      this.checkpointClaim?.checkpointId,
    );
    if (
      this.virtualApplication &&
      (this.virtualApplication.sessionId !== sessionId ||
        this.virtualApplication.epochCompactionId !== epochCompactionId ||
        getEntryIndex(branch, this.virtualApplication.firstAppliedLeafId) < 0 ||
        getEntryIndex(branch, this.virtualApplication.lastAppliedLeafId) < 0)
    ) {
      this.virtualApplication = undefined;
      this.deferredFormalization = undefined;
    }

    const modelKey = `${model.provider}/${model.id}`;
    const deltaKey = `${sessionId}:${modelKey}`;
    const deltaD = this.recordedTranscriptDeltas.get(deltaKey) ?? 0;
    const reserveTokens = loadPiCompactionReserveTokens(
      ctx.cwd,
      isProjectTrustedContext(ctx),
      model,
    );
    const limits = calculateContextCapacityLimits(
      model.contextWindow,
      reserveTokens,
      this.currentConfig.softThresholdPercent,
    );
    const rawEstimate = this.estimateRawCandidateTokens(event.messages, branch, ctx);
    const effectiveRawTokens = rawEstimate.totalTokens + deltaD;
    const rawHardLimitExceeded = limits
      ? effectiveRawTokens > limits.hardLimit
      : effectiveRawTokens > model.contextWindow;
    if (!limits && effectiveRawTokens > model.contextWindow) {
      this.abortContextForCapacityFailure(
        ctx,
        "context_window_exceeded",
        effectiveRawTokens,
      );
      this.recordUnappliedContextEvaluation(
        sessionId,
        epochCompactionId,
        ctx.sessionManager.getLeafId(),
        event.messages,
        rawEstimate,
        limits,
        true,
        true,
      );
      this.diagnostics.count("virtual_skipped");
      return { messages: event.messages };
    }

    let hardLimitExceeded = false;
    let bestFallbackProjection: { messages: ContextEvent["messages"]; tokens: number } | undefined;

    for (const candidate of candidates) {
      const previousApplication = this.virtualApplication;
      const sameApplicationPrefix = Boolean(
        previousApplication &&
        previousApplication.checkpointId === candidate.data.checkpointId &&
        previousApplication.sessionId === sessionId &&
        previousApplication.epochCompactionId === epochCompactionId &&
        previousApplication.modelKey === modelKey &&
        getEntryIndex(branch, previousApplication.firstAppliedLeafId) >= 0,
      );
      const attempt = tryProjectCheckpointToVirtualContext({
        branch,
        eventMessages: event.messages,
        checkpoint: candidate.data,
        contextWindow: model.contextWindow,
        reserveTokens,
        softThresholdPercent: this.currentConfig.softThresholdPercent,
        cache: this.virtualContextCache,
        additionalSystemTokens: rawEstimate.systemTokenAdjustment,
        ...(sameApplicationPrefix
          ? {
            usageBaseline: {
              appliedSinceLeafId: previousApplication!.firstAppliedLeafId,
              appliedModelKey: previousApplication!.modelKey,
              currentModelKey: modelKey,
            },
          }
          : {}),
      });
      if (attempt.status === "hard-limit") {
        hardLimitExceeded = true;
        this.diagnostics.count("virtual_skipped_hard_limit");
        const candidateEffectiveTokens = attempt.estimatedTokens + deltaD;
        if (
          effectiveRawTokens > model.contextWindow &&
          candidateEffectiveTokens <= model.contextWindow
        ) {
          if (!bestFallbackProjection || candidateEffectiveTokens < bestFallbackProjection.tokens) {
            bestFallbackProjection = {
              messages: attempt.projection.messages,
              tokens: candidateEffectiveTokens,
            };
          }
        }
        this.diagnostics.count("virtual_projection_hard_limit", {
          checkpointId: candidate.data.checkpointId,
          reason: "hard_limit_exceeded",
          details: {
            estimatedTokens: attempt.estimatedTokens,
            hardLimit: attempt.hardLimit,
          },
        });
        continue;
      }
      if (attempt.status === "unavailable") {
        this.diagnostics.count("virtual_projection_unavailable", {
          checkpointId: candidate.data.checkpointId,
          reason: attempt.reason,
          details: {
            ...(attempt.sourceMessageCount === undefined
              ? {}
              : { sourceMessageCount: attempt.sourceMessageCount }),
            ...(attempt.eventMessageCount === undefined
              ? {}
              : { eventMessageCount: attempt.eventMessageCount }),
          },
        });
        continue;
      }
      const projection = attempt.projection;
      const candidateEffectiveTokens = projection.estimatedTokens + deltaD;
      if (limits && candidateEffectiveTokens > limits.hardLimit) {
        hardLimitExceeded = true;
        this.diagnostics.count("virtual_skipped_hard_limit");
        if (
          effectiveRawTokens > model.contextWindow &&
          candidateEffectiveTokens <= model.contextWindow
        ) {
          if (!bestFallbackProjection || candidateEffectiveTokens < bestFallbackProjection.tokens) {
            bestFallbackProjection = {
              messages: projection.messages,
              tokens: candidateEffectiveTokens,
            };
          }
        }
        continue;
      }

      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        this.diagnostics.count("virtual_skipped_empty_branch");
        return { messages: event.messages };
      }
      const deferred = this.deferredFormalization;
      if (
        deferred &&
        (deferred.sessionId !== sessionId ||
          deferred.epochCompactionId !== epochCompactionId ||
          deferred.checkpointId !== candidate.data.checkpointId)
      ) {
        this.deferredFormalization = undefined;
      }
      const refreshRequested = projection.needsRefresh || Boolean(
        previousApplication &&
        previousApplication.checkpointId === candidate.data.checkpointId &&
        previousApplication.sessionId === sessionId &&
        previousApplication.epochCompactionId === epochCompactionId &&
        previousApplication.refreshRequested
      );
      this.virtualApplication = {
        checkpointId: candidate.data.checkpointId,
        sessionId,
        epochCompactionId,
        firstAppliedLeafId: sameApplicationPrefix
          ? previousApplication!.firstAppliedLeafId
          : leafId,
        lastAppliedLeafId: leafId,
        modelKey,
        refreshRequested,
      };
      this.lastContextEvaluation = {
        runEpoch: this.runEpoch,
        sessionId,
        epochCompactionId,
        leafId,
        conversationMessages: projection.messages,
        conversationEstimatedTokens: candidateEffectiveTokens,
        countedSystemTokens: rawEstimate.countedSystemTokens,
        hardLimit: projection.hardLimit,
        refreshLimit: projection.refreshLimit,
        foregroundAttempted: !allowWait,
        aborted: false,
      };
      this.diagnostics.count("virtual_applied", {
        checkpointId: candidate.data.checkpointId,
        reason: "checkpoint_ready",
        details: {
          estimatedTokens: projection.estimatedTokens,
          hardLimit: projection.hardLimit,
          refreshLimit: projection.refreshLimit,
          needsRefresh: projection.needsRefresh,
          sourceMessageCount: event.messages.length,
          projectedMessageCount: projection.messages.length,
        },
      });
      if (projection.needsRefresh) {
        this.diagnostics.count("virtual_refresh_needed", {
          checkpointId: candidate.data.checkpointId,
          reason: "refresh_limit_reached",
        });
      }
      return { messages: projection.messages };
    }

    if (this.lastUnpersistedCandidate && this.lastUnpersistedCandidate.sessionId === sessionId) {
      const attempt = tryProjectCheckpointToVirtualContext({
        branch,
        eventMessages: event.messages,
        checkpoint: this.lastUnpersistedCandidate.candidate,
        contextWindow: model.contextWindow,
        reserveTokens,
        softThresholdPercent: this.currentConfig.softThresholdPercent,
        cache: this.virtualContextCache,
        additionalSystemTokens: rawEstimate.systemTokenAdjustment,
      });
      if (attempt.status === "projected" || attempt.status === "hard-limit") {
        const candidateTokens = (attempt.status === "projected"
          ? attempt.projection.estimatedTokens
          : attempt.estimatedTokens) + deltaD;
        if (candidateTokens <= model.contextWindow) {
          if (!bestFallbackProjection || candidateTokens < bestFallbackProjection.tokens) {
            bestFallbackProjection = {
              messages: attempt.projection.messages,
              tokens: candidateTokens,
            };
          }
        }
      }
    }

    const usageInvalidated = hasInvalidatingEntryAfterLastAssistant(branch);
    const usageCritical = !usageInvalidated && this.isCriticalWaitRequired(ctx);

    if (
      hardLimitExceeded &&
      allowWait &&
      !usageCritical &&
      this.currentConfig.hookWaitTimeoutMs > 0
    ) {
      const task = compatibleTaskBeforeCheck ?? this.findCompatibleTask(ctx);
      if (task) {
        return this.waitForVirtualRefresh(
          event,
          ctx,
          task,
          this.currentConfig.hookWaitTimeoutMs,
        );
      }
    }

    if (allowWait && (usageCritical || rawHardLimitExceeded || hardLimitExceeded)) {
      return this.runForegroundCompactionLoop(
        event,
        ctx,
        sessionId,
        epochCompactionId,
        model,
        modelKey,
        reserveTokens,
        limits,
        rawEstimate,
        deltaD,
        compatibleTaskBeforeCheck,
        bestFallbackProjection,
      );
    }

    const bestTokens = bestFallbackProjection
      ? bestFallbackProjection.tokens
      : effectiveRawTokens;

    if (!allowWait && (rawHardLimitExceeded || hardLimitExceeded)) {
      if (hardLimitExceeded) {
        this.diagnostics.count("virtual_skipped_hard_limit");
      }
      if (bestTokens <= model.contextWindow) {
        this.recordUnappliedContextEvaluation(
          sessionId,
          epochCompactionId,
          ctx.sessionManager.getLeafId(),
          event.messages,
          rawEstimate,
          limits,
          true,
          false,
        );
        this.diagnostics.count("virtual_skipped");
        return {
          messages: bestFallbackProjection ? bestFallbackProjection.messages : event.messages,
        };
      }
      this.abortContextForCapacityFailure(
        ctx,
        "still_exceeds_hard_limit",
        bestTokens,
        limits?.hardLimit,
      );
      this.recordUnappliedContextEvaluation(
        sessionId,
        epochCompactionId,
        ctx.sessionManager.getLeafId(),
        event.messages,
        rawEstimate,
        limits,
        true,
        true,
      );
      this.diagnostics.count("virtual_skipped");
      return { messages: event.messages };
    }

    this.recordUnappliedContextEvaluation(
      sessionId,
      epochCompactionId,
      ctx.sessionManager.getLeafId(),
      event.messages,
      rawEstimate,
      limits,
      !allowWait,
      false,
    );
    if (hardLimitExceeded) {
      this.diagnostics.count("virtual_skipped_hard_limit");
    }
    this.diagnostics.count("virtual_skipped");
    return { messages: event.messages };
  }

  private async runForegroundCompactionLoop(
    event: ContextEvent,
    ctx: ExtensionContext,
    sessionId: string,
    epochCompactionId: string | null,
    model: Model<Api>,
    modelKey: string,
    reserveTokens: number,
    limits: ReturnType<typeof calculateContextCapacityLimits>,
    rawEstimate: {
      totalTokens: number;
      countedSystemTokens: number;
      systemTokenAdjustment: number;
    },
    deltaD: number,
    initialTask: BackgroundTask | undefined,
    initialBestFallback: { messages: ContextEvent["messages"]; tokens: number } | undefined,
  ): Promise<Pick<ContextEvent, "messages">> {
    const MAX_FOREGROUND_RETRIES = 3;
    let foregroundRetries = 0;
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + this.currentConfig.taskTimeoutMs;
    const signal = this.getForegroundSignal(ctx);

    let progressTask: BackgroundTask | undefined = initialTask ?? this.findCompatibleTask(ctx);
    const progress = this.startForegroundWaitProgress(
      ctx,
      () => progressTask,
      waitStartedAt,
      () => foregroundRetries,
    );
    let bestFallbackProjection = initialBestFallback;
    let lastFailureReason: string | undefined;

    try {
      while (true) {
        if (signal.aborted) {
          this.diagnostics.count("foreground_wait_aborted");
          if (
            progressTask &&
            progressTask.sessionId === sessionId &&
            progressTask.runEpoch === this.runEpoch
          ) {
            this.discardTask(progressTask, "user_aborted");
          }
          break;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          this.diagnostics.count("critical_wait_timed_out");
          lastFailureReason = "critical_wait_timeout";
          break;
        }

        let task =
          progressTask && !progressTask.discarded && progressTask.runEpoch === this.runEpoch
            ? progressTask
            : this.findCompatibleTask(ctx);

        if (!task) {
          while (this.hasExternalBackgroundOperation()) {
            const slotRemaining = deadline - Date.now();
            if (slotRemaining <= 0) {
              this.diagnostics.count("critical_wait_timed_out");
              lastFailureReason = "external_slot_timeout";
              break;
            }
            const active = sharedRuntimeState.activeBackgroundOperation;
            if (!active) {
              break;
            }
            const slotOutcome = await this.waitForPromiseWithSignal(
              active,
              slotRemaining,
              signal,
            );
            if (slotOutcome === "aborted") {
              this.diagnostics.count("foreground_wait_aborted");
              break;
            }
            if (slotOutcome === "timeout") {
              this.diagnostics.count("critical_wait_timed_out");
              lastFailureReason = "external_slot_timeout";
              break;
            }
          }
          if (signal.aborted || lastFailureReason) {
            break;
          }

          const currentBranch = ctx.sessionManager.getBranch();
          const currentCandidates = findReadyCheckpointCandidates(
            currentBranch,
            sessionId,
            epochCompactionId,
            this.checkpointClaim?.checkpointId,
          );
          const newestCandidate = currentCandidates[0];

          let prep = prepareCompactionFromBranch(
            currentBranch,
            createCheckpointPreparationSettings(reserveTokens),
            newestCandidate?.data,
          );
          let keepTokensToUse = CHECKPOINT_KEEP_RECENT_TOKENS;
          if (!prep && newestCandidate) {
            prep = prepareCompactionFromBranch(
              currentBranch,
              createCheckpointPreparationSettings(reserveTokens, 1),
              newestCandidate.data,
            );
            keepTokensToUse = 1;
          }

          if (!prep) {
            lastFailureReason = "no_compaction_boundary";
            break;
          }

          task = this.startBackgroundTaskIfEligible(ctx, true, {
            force: true,
            keepRecentTokens: keepTokensToUse,
            parentCheckpoint: newestCandidate?.data,
          });
          if (task) {
            this.diagnostics.count("critical_task_started");
          } else {
            lastFailureReason = "critical_task_start_failed";
            break;
          }
        }

        progressTask = task;
        this.diagnostics.count("critical_wait_started");
        const taskTimeout = Math.min(deadline - Date.now(), this.remainingTaskTime(task));
        const waitOutcome = await this.waitForTask(task, taskTimeout, signal);

        if (waitOutcome === "aborted") {
          this.diagnostics.count("foreground_wait_aborted");
          if (task.sessionId === sessionId && task.runEpoch === this.runEpoch) {
            this.discardTask(task, "user_aborted");
          }
          break;
        }

        if (
          waitOutcome === "timeout" ||
          task.failureKind ||
          task.controller.signal.aborted ||
          task.discarded
        ) {
          if (waitOutcome === "timeout") {
            this.diagnostics.count("critical_wait_timed_out");
          }
          progressTask = undefined;
          foregroundRetries += 1;
          if (foregroundRetries > MAX_FOREGROUND_RETRIES) {
            lastFailureReason = "foreground_retries_exhausted";
            break;
          }
          progress.refresh();
          continue;
        }

        if (waitOutcome === "finished") {
          this.diagnostics.count("critical_waited");
          const currentBranch = ctx.sessionManager.getBranch();
          const currentCandidates = findReadyCheckpointCandidates(
            currentBranch,
            sessionId,
            epochCompactionId,
            this.checkpointClaim?.checkpointId,
          );
          let appliedProjection: ContextEvent["messages"] | undefined;

          for (const candidate of currentCandidates) {
            const attempt = tryProjectCheckpointToVirtualContext({
              branch: currentBranch,
              eventMessages: event.messages,
              checkpoint: candidate.data,
              contextWindow: model.contextWindow,
              reserveTokens,
              softThresholdPercent: this.currentConfig.softThresholdPercent,
              cache: this.virtualContextCache,
              additionalSystemTokens: rawEstimate.systemTokenAdjustment,
            });
            if (attempt.status === "projected") {
              const tokens = attempt.projection.estimatedTokens + deltaD;
              if (limits && tokens <= limits.hardLimit) {
                appliedProjection = attempt.projection.messages;
                const leafId = ctx.sessionManager.getLeafId();
                if (leafId) {
                  this.virtualApplication = {
                    checkpointId: candidate.data.checkpointId,
                    sessionId,
                    epochCompactionId,
                    firstAppliedLeafId: leafId,
                    lastAppliedLeafId: leafId,
                    modelKey,
                    refreshRequested: attempt.projection.needsRefresh,
                  };
                  this.lastContextEvaluation = {
                    runEpoch: this.runEpoch,
                    sessionId,
                    epochCompactionId,
                    leafId,
                    conversationMessages: attempt.projection.messages,
                    conversationEstimatedTokens: tokens,
                    countedSystemTokens: rawEstimate.countedSystemTokens,
                    hardLimit: attempt.projection.hardLimit,
                    refreshLimit: attempt.projection.refreshLimit,
                    foregroundAttempted: true,
                    aborted: false,
                  };
                }
                break;
              } else if (tokens <= model.contextWindow) {
                if (!bestFallbackProjection || tokens < bestFallbackProjection.tokens) {
                  bestFallbackProjection = { messages: attempt.projection.messages, tokens };
                }
              }
            } else if (attempt.status === "hard-limit") {
              const tokens = attempt.estimatedTokens + deltaD;
              if (tokens <= model.contextWindow) {
                if (!bestFallbackProjection || tokens < bestFallbackProjection.tokens) {
                  bestFallbackProjection = { messages: attempt.projection.messages, tokens };
                }
              }
            }
          }

          if (appliedProjection) {
            return { messages: appliedProjection };
          }

          if (
            this.lastUnpersistedCandidate &&
            this.lastUnpersistedCandidate.sessionId === sessionId
          ) {
            const attempt = tryProjectCheckpointToVirtualContext({
              branch: currentBranch,
              eventMessages: event.messages,
              checkpoint: this.lastUnpersistedCandidate.candidate,
              contextWindow: model.contextWindow,
              reserveTokens,
              softThresholdPercent: this.currentConfig.softThresholdPercent,
              cache: this.virtualContextCache,
              additionalSystemTokens: rawEstimate.systemTokenAdjustment,
            });
            if (attempt.status === "projected" || attempt.status === "hard-limit") {
              const tokens =
                (attempt.status === "projected"
                  ? attempt.projection.estimatedTokens
                  : attempt.estimatedTokens) + deltaD;
              if (tokens <= model.contextWindow) {
                if (!bestFallbackProjection || tokens < bestFallbackProjection.tokens) {
                  bestFallbackProjection = { messages: attempt.projection.messages, tokens };
                }
              }
            }
          }

          const newestCandidate = currentCandidates[0];
          const canAdvance =
            newestCandidate &&
            this.canAdvanceCompaction(currentBranch, reserveTokens, newestCandidate.data);
          if (canAdvance) {
            progressTask = undefined;
            continue;
          } else {
            break;
          }
        }
      }
    } finally {
      progress.cleanup();
    }

    const bestTokens = bestFallbackProjection
      ? bestFallbackProjection.tokens
      : rawEstimate.totalTokens + deltaD;

    if (bestTokens <= model.contextWindow) {
      if (bestFallbackProjection) {
        return { messages: bestFallbackProjection.messages };
      }
      this.diagnostics.count("virtual_skipped");
      return { messages: event.messages };
    }

    this.abortContextForCapacityFailure(
      ctx,
      lastFailureReason ?? "context_window_exceeded",
      bestTokens,
      limits?.hardLimit,
    );
    this.diagnostics.count("virtual_skipped");
    return { messages: event.messages };
  }

  private canAdvanceCompaction(
    branch: readonly SessionEntry[],
    reserveTokens: number,
    parentCheckpoint: CheckpointData,
  ): boolean {
    const snapshotIndex = getEntryIndex(branch, parentCheckpoint.snapshotLeafId);
    if (snapshotIndex >= 0 && hasContextSourceProgressAfter(branch, snapshotIndex)) {
      const prep = prepareCompactionFromBranch(
        branch,
        createCheckpointPreparationSettings(reserveTokens),
        parentCheckpoint,
      );
      if (prep && (prep.messagesToSummarize.length > 0 || prep.turnPrefixMessages.length > 0)) {
        return true;
      }
    }
    const prepMin = prepareCompactionFromBranch(
      branch,
      createCheckpointPreparationSettings(reserveTokens, 1),
      parentCheckpoint,
    );
    if (
      prepMin &&
      prepMin.firstKeptEntryId !== parentCheckpoint.compaction.firstKeptEntryId &&
      (prepMin.messagesToSummarize.length > 0 || prepMin.turnPrefixMessages.length > 0)
    ) {
      return true;
    }
    return false;
  }

  private estimateRawCandidateTokens(
    eventMessages: ContextEvent["messages"],
    branch: readonly SessionEntry[],
    ctx: ExtensionContext,
  ): {
    totalTokens: number;
    charEstimatedTokens: number;
    countedSystemTokens: number;
    systemTokenAdjustment: number;
  } {
    const conversationTokens = estimateContextMessagesTokens(eventMessages);
    const eventSystemMessages = eventMessages.filter((message) => message.role === "system");
    let countedSystemTokens = estimateContextMessagesTokens(eventSystemMessages);
    let systemTokensIncludedInProjection = countedSystemTokens;
    if (countedSystemTokens === 0) {
      const branchSystemMessage = getCurrentSystemMessage(
        buildSessionProjection([...branch]).messages,
      );
      if (branchSystemMessage) {
        countedSystemTokens = estimateTokens(branchSystemMessage);
        systemTokensIncludedInProjection = countedSystemTokens;
      } else if (typeof ctx.getSystemPrompt === "function") {
        const systemPrompt = ctx.getSystemPrompt();
        if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
          countedSystemTokens = Math.ceil(systemPrompt.length / 4);
        }
      }
    }
    const charEstimatedTokens =
      eventSystemMessages.length > 0
        ? conversationTokens
        : conversationTokens + countedSystemTokens;
    const usage = ctx.getContextUsage();
    const validUsageTokens =
      !hasInvalidatingEntryAfterLastAssistant(branch) &&
      usage?.tokens != null &&
      Number.isFinite(usage.tokens)
        ? usage.tokens
        : 0;
    return {
      totalTokens: Math.max(charEstimatedTokens, validUsageTokens),
      charEstimatedTokens,
      countedSystemTokens,
      systemTokenAdjustment: Math.max(
        0,
        countedSystemTokens - systemTokensIncludedInProjection,
      ),
    };
  }

  private recordUnappliedContextEvaluation(
    sessionId: string,
    epochCompactionId: string | null,
    leafId: string | null,
    conversationMessages: ContextEvent["messages"],
    rawEstimate: {
      totalTokens: number;
      countedSystemTokens: number;
    },
    limits: ReturnType<typeof calculateContextCapacityLimits>,
    foregroundAttempted: boolean,
    aborted: boolean,
  ): void {
    if (!limits) {
      this.lastContextEvaluation = undefined;
      return;
    }
    this.lastContextEvaluation = {
      runEpoch: this.runEpoch,
      sessionId,
      epochCompactionId,
      leafId,
      conversationMessages,
      conversationEstimatedTokens: rawEstimate.totalTokens,
      countedSystemTokens: rawEstimate.countedSystemTokens,
      hardLimit: limits.hardLimit,
      refreshLimit: limits.refreshLimit,
      foregroundAttempted,
      aborted,
    };
  }

  private hasExternalBackgroundOperation(): boolean {
    const active = sharedRuntimeState.activeBackgroundOperation;
    if (!active) {
      return false;
    }
    if (this.inFlightTask && active === this.inFlightTask.promise) {
      return false;
    }
    return true;
  }

  private waitForPromiseWithSignal(
    promise: Promise<void>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WaitOutcome> {
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    if (timeoutMs <= 0) {
      return Promise.resolve("timeout");
    }
    return new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: WaitOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        () => finish("finished"),
        () => finish("finished"),
      );
    });
  }

  private abortContextForCapacityFailure(
    ctx: ExtensionContext,
    reason: string,
    estimatedTokens?: number,
    hardLimit?: number,
  ): void {
    this.diagnostics.count("context_aborted_capacity", {
      reason,
      details: {
        ...(estimatedTokens === undefined ? {} : { estimatedTokens }),
        ...(hardLimit === undefined ? {} : { hardLimit }),
      },
    });
    const message =
      reason === "no_compaction_boundary"
        ? "No valid compaction boundary is available, and the context exceeds the model's context window. Request stopped."
        : reason === "critical_wait_timeout" || reason === "external_slot_timeout"
          ? "Foreground compaction timed out, and the context exceeds the model's context window. Request stopped."
          : reason === "foreground_retries_exhausted"
            ? "Foreground compaction retries were exhausted, and the context exceeds the model's context window. Request stopped."
            : "The context exceeds the model's context window, and summary precomputation is unavailable. Request stopped.";
    this.diagnostics.record("capacity", message);
    this.notifyWarning(message);
    if (typeof ctx.abort === "function") {
      try {
        ctx.abort();
      } catch {
        // 忽略宿主 abort 抛出的异常。
      }
    }
  }

  private verifyContextWithSystem(
    event: ContextWithSystemEvent,
    ctx: ExtensionContext,
  ): Pick<ContextWithSystemEvent, "messages"> | undefined {
    this.bindContext(ctx);
    if (this.currentConfig.precomputeMode === "off") {
      return undefined;
    }
    const model = asModel(ctx.model);
    if (!model) {
      return undefined;
    }
    const branch = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const epochCompactionId = getEpochCompactionId(branch);
    if (this.isFormalizationExhausted(sessionId, epochCompactionId)) {
      return undefined;
    }
    const reserveTokens = loadPiCompactionReserveTokens(
      ctx.cwd,
      isProjectTrustedContext(ctx),
      model,
    );
    const limits = calculateContextCapacityLimits(
      model.contextWindow,
      reserveTokens,
      this.currentConfig.softThresholdPercent,
    );
    if (!limits) {
      return undefined;
    }

    const leafId = ctx.sessionManager.getLeafId();
    const lastEval =
      this.lastContextEvaluation &&
      this.lastContextEvaluation.runEpoch === this.runEpoch &&
      this.lastContextEvaluation.sessionId === sessionId &&
      this.lastContextEvaluation.epochCompactionId === epochCompactionId &&
      this.lastContextEvaluation.leafId === leafId
        ? this.lastContextEvaluation
        : undefined;

    const systemMessages = event.messages.filter((message) => message.role === "system");
    const nonSystemMessages = event.messages.filter((message) => message.role !== "system");
    const systemTokens = estimateContextMessagesTokens(systemMessages);
    const nonSystemTokens = estimateContextMessagesTokens(nonSystemMessages);
    const extraSystemTokens = lastEval
      ? Math.max(0, systemTokens - lastEval.countedSystemTokens)
      : systemTokens;
    const extraNonSystemTokens = lastEval
      ? Math.max(0, nonSystemTokens - lastEval.conversationEstimatedTokens)
      : 0;
    const fullTokens = lastEval
      ? lastEval.conversationEstimatedTokens + extraSystemTokens + extraNonSystemTokens
      : systemTokens + nonSystemTokens;

    const modelKey = `${model.provider}/${model.id}`;
    const deltaKey = `${sessionId}:${modelKey}`;
    const deltaD = extraSystemTokens + extraNonSystemTokens;
    if (deltaD > 0) {
      this.recordedTranscriptDeltas.set(deltaKey, deltaD);
    }

    if (fullTokens >= limits.refreshLimit && this.virtualApplication) {
      this.virtualApplication.refreshRequested = true;
    }

    if (fullTokens > limits.hardLimit) {
      this.diagnostics.count("system_transcript_exceeds_hard_limit", {
        details: {
          fullTokens,
          hardLimit: limits.hardLimit,
          deltaD,
        },
      });
      if (!this.inFlightTask && !this.hasExternalBackgroundOperation()) {
        this.startBackgroundTaskIfEligible(ctx, true);
      }
    }

    return undefined;
  }

  private isCriticalWaitRequired(ctx: ExtensionContext): boolean {
    const usage = ctx.getContextUsage();
    const model = asModel(ctx.model);
    if (
      usage?.tokens == null ||
      !Number.isFinite(usage.tokens) ||
      !model ||
      !Number.isFinite(model.contextWindow) ||
      model.contextWindow <= 0
    ) {
      return false;
    }
    const criticalWaitTokens = calculateCriticalWaitTokens(
      model.contextWindow,
      loadPiCompactionReserveTokens(
        ctx.cwd,
        isProjectTrustedContext(ctx),
        model,
      ),
    );
    return criticalWaitTokens !== undefined && usage.tokens >= criticalWaitTokens;
  }

  private getForegroundSignal(ctx: ExtensionContext): AbortSignal {
    return ctx.signal ?? new AbortController().signal;
  }

  private startForegroundWaitProgress(
    ctx: ExtensionContext,
    getTask: () => BackgroundTask | undefined,
    startedAt: number,
    getRetryCount?: () => number,
  ): ForegroundWaitProgressHandle {
    this.stopForegroundWaitProgress();
    const runEpoch = this.runEpoch;
    const isNonInteractive =
      ctx.mode === "json" || ctx.mode === "print" || ctx.hasUI === false;
    const isRpc = ctx.mode === "rpc";
    const isTui = !isNonInteractive && !isRpc;
    const ui = ctx.ui;

    const formatText = (): string => {
      const task = getTask();
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const retryCount = getRetryCount ? getRetryCount() : 0;
      const retrySuffix =
        retryCount > 0
          ? ` · retry ${retryCount}/3`
          : task && (task.retryCount > 0 || task.stage === "retry_backoff")
            ? ` · retry ${task.retryCount}/${MAX_BACKGROUND_RETRIES}`
            : "";
      return `pi-press: Compacting · ${elapsedSeconds}s elapsed${retrySuffix}`;
    };

    const handle: ForegroundWaitProgressHandle = {
      runEpoch,
      closed: false,
      refresh: () => {
        if (
          handle.closed ||
          this.activeForegroundWait !== handle ||
          handle.runEpoch !== this.runEpoch
        ) {
          return;
        }
        const text = formatText();
        try {
          if (isTui) {
            if (ui && typeof ui.setWorkingMessage === "function") {
              ui.setWorkingMessage(text);
            }
          } else if (isRpc) {
            if (ui && typeof ui.setStatus === "function") {
              ui.setStatus("pi-press", text);
            }
          }
        } catch {
          // 忽略 UI 更新异常。
        }
      },
      cleanup: () => {
        if (handle.closed) {
          return;
        }
        handle.closed = true;
        if (handle.timer) {
          clearInterval(handle.timer);
          handle.timer = undefined;
        }
        if (this.activeForegroundWait === handle) {
          this.activeForegroundWait = undefined;
        }
        if (handle.runEpoch !== this.runEpoch) {
          return;
        }
        try {
          if (isTui) {
            if (ui && typeof ui.setWorkingMessage === "function") {
              ui.setWorkingMessage(undefined);
            }
          } else if (isRpc) {
            if (ui && typeof ui.setStatus === "function") {
              ui.setStatus("pi-press", undefined);
            }
          }
        } catch {
          // 忽略 UI 清理异常。
        }
      },
    };

    this.activeForegroundWait = handle;
    handle.refresh();
    if (!isNonInteractive) {
      handle.timer = setInterval(() => {
        handle.refresh();
      }, 1000);
      handle.timer.unref?.();
    }
    return handle;
  }

  private stopForegroundWaitProgress(): void {
    const active = this.activeForegroundWait;
    if (!active) {
      return;
    }
    active.cleanup();
  }

  private async waitForVirtualRefresh(
    event: ContextEvent,
    ctx: ExtensionContext,
    task: BackgroundTask,
    timeoutMs: number,
  ): Promise<Pick<ContextEvent, "messages">> {
    const signal = this.getForegroundSignal(ctx);
    const progress = this.startForegroundWaitProgress(
      ctx,
      () => task,
      task.startedAt,
    );
    let waitOutcome: WaitOutcome;
    try {
      waitOutcome = await this.waitForTask(task, timeoutMs, signal);
    } finally {
      progress.cleanup();
    }
    if (waitOutcome === "aborted") {
      this.diagnostics.count("foreground_wait_aborted");
      if (
        task.sessionId === ctx.sessionManager.getSessionId() &&
        task.runEpoch === this.runEpoch
      ) {
        this.discardTask(task, "user_aborted");
      }
      this.diagnostics.count("virtual_skipped");
      return { messages: event.messages };
    }
    if (
      waitOutcome === "timeout" ||
      task.runEpoch !== this.runEpoch ||
      task.sessionId !== this.currentSessionId
    ) {
      if (waitOutcome === "timeout") {
        this.diagnostics.count("virtual_refresh_wait_timed_out");
        this.diagnostics.record(
          "capacity",
          "The virtual context exceeds the hard limit. Timed out waiting for a background refresh.",
        );
      }
      this.diagnostics.count("virtual_skipped");
      return { messages: event.messages };
    }

    this.diagnostics.count("virtual_refresh_waited");
    return await this.applyVirtualContext(event, ctx, false);
  }

  onAgentSettled(ctx: ExtensionContext): void {
    this.bindContext(ctx);
    if (
      this.currentConfig.precomputeMode === "off" ||
      !this.virtualApplication ||
      this.pendingFormalization ||
      this.formalizationSchedule
    ) {
      return;
    }
    if (!this.isIdle(ctx)) {
      this.diagnostics.count("formalization_skipped_busy");
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const epochCompactionId = getEpochCompactionId(branch);
    const application = this.virtualApplication;
    if (
      application.sessionId !== sessionId ||
      application.epochCompactionId !== epochCompactionId ||
      getEntryIndex(branch, application.lastAppliedLeafId) < 0
    ) {
      this.virtualApplication = undefined;
      this.deferredFormalization = undefined;
      return;
    }
    const candidates = findReadyCheckpointCandidates(
      branch,
      sessionId,
      epochCompactionId,
      this.checkpointClaim?.checkpointId,
    );
    const applicationCandidate = candidates.find(
      (item) => item.data.checkpointId === application.checkpointId,
    );
    const candidate = candidates[0];
    if (!candidate || !applicationCandidate) {
      this.virtualApplication = undefined;
      this.deferredFormalization = undefined;
      return;
    }

    if (this.isFormalizationExhausted(sessionId, epochCompactionId)) {
      return;
    }
    const scheduledLeafId = ctx.sessionManager.getLeafId();
    if (!scheduledLeafId) {
      return;
    }
    const deferred = this.deferredFormalization;
    if (
      deferred &&
      (deferred.sessionId !== sessionId ||
        deferred.epochCompactionId !== epochCompactionId ||
        deferred.checkpointId !== candidate.data.checkpointId)
    ) {
      this.deferredFormalization = undefined;
    } else if (deferred?.checkedLeafId === scheduledLeafId) {
      return;
    }
    const schedule: FormalizationSchedule = {
      requestId: randomUUID(),
      runEpoch: this.runEpoch,
      checkpointId: candidate.data.checkpointId,
      sessionId,
      epochCompactionId,
      scheduledLeafId,
      ctx,
    };
    this.formalizationSchedule = schedule;
    this.diagnostics.count("formalization_scheduled");
    schedule.timer = setTimeout(() => {
      void this.runFormalization(schedule);
    }, 0);
  }

  onSessionCompact(event: SessionCompactEvent, ctx: ExtensionContext): void {
    const checkpointId = getCheckpointIdFromDetails(event.compactionEntry.details);
    if (checkpointId) {
      const metadata = { checkpointId, reason: "formal_compaction_completed" };
      this.diagnostics.count("checkpoint_consumed", metadata);
      this.diagnostics.recordUsage("consumed", event.compactionEntry.usage, metadata);
      if (this.checkpointClaim?.checkpointId === checkpointId) {
        this.releaseCheckpointClaim(checkpointId);
      }
    }
    this.invalidate("session_compact", false);
    this.recordedTranscriptDeltas.clear();
    this.bindContext(ctx);
    if (this.currentConfig.precomputeMode !== "off") {
      this.notifyUser(
        checkpointId
          ? "pi-press: Compaction completed using a precomputed summary."
          : "pi-press: Compaction completed using Pi's native process.",
        "info",
      );
    }
  }

  onSessionCompactFailed(event: SessionCompactFailedEvent): void {
    const pending = this.pendingFormalization;
    if (
      pending &&
      pending.runEpoch === this.runEpoch &&
      pending.sessionId === this.currentSessionId &&
      pending.epochCompactionId === this.currentEpochCompactionId &&
      event.reason === "manual" &&
      !event.willRetry &&
      event.aborted &&
      pending.compaction?.isCurrent &&
      pending.compaction.signal.aborted
    ) {
      pending.compaction.cancelled = true;
    }
    if (event.fromExtension) {
      this.diagnostics.count("session_compact_failed", {
        ...(event.aborted || this.checkpointClaim === undefined
          ? {}
          : { checkpointId: this.checkpointClaim.checkpointId }),
        reason: "extension_compaction_failed",
      });
      // 取消由所属 signal 释放 claim，迟到的取消事件保留其他操作的领取。
      if (!event.aborted) {
        this.releaseCheckpointClaim();
      }
    }
  }

  onTurnEnd(ctx: ExtensionContext): void {
    this.bindContext(ctx);
    const config = this.loadCurrentConfig(ctx);
    if (config.precomputeMode === "off") {
      return;
    }
    this.startBackgroundTaskIfEligible(ctx, false);
  }

  private startBackgroundTaskIfEligible(
    ctx: ExtensionContext,
    bypassThreshold: boolean,
    options?: {
      force?: boolean;
      keepRecentTokens?: number;
      parentCheckpoint?: CheckpointData | undefined;
    },
  ): BackgroundTask | undefined {
    const config = this.currentConfig;
    const usage = ctx.getContextUsage();
    const usageKnown = Boolean(
      usage &&
      usage.tokens !== null &&
      usage.percent !== null &&
      Number.isFinite(usage.tokens) &&
      Number.isFinite(usage.percent),
    );
    const model = asModel(ctx.model);
    if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) {
      this.diagnostics.count("threshold_skipped_unknown_model");
      return undefined;
    }

    const branchEntries = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const snapshotLeafId = ctx.sessionManager.getLeafId();
    const snapshotSourceLeafId = getSnapshotSourceLeafId(branchEntries);
    if (!snapshotLeafId || !snapshotSourceLeafId) {
      this.diagnostics.count("threshold_skipped_empty_branch");
      return undefined;
    }
    const epochCompactionId = getEpochCompactionId(branchEntries);
    if (this.isFormalizationExhausted(sessionId, epochCompactionId)) {
      return undefined;
    }
    const reserveTokens = loadPiCompactionReserveTokens(
      ctx.cwd,
      isProjectTrustedContext(ctx),
      model,
    );
    const limits = calculateContextCapacityLimits(
      model.contextWindow,
      reserveTokens,
      config.softThresholdPercent,
    );
    const candidates = findReadyCheckpointCandidates(
      branchEntries,
      sessionId,
      epochCompactionId,
      this.checkpointClaim?.checkpointId,
    );
    const virtualCandidate = this.virtualApplication
      ? candidates.find((candidate) => candidate.data.checkpointId === this.virtualApplication?.checkpointId)
      : undefined;
    const virtualRefreshRequested = Boolean(
      virtualCandidate &&
      this.virtualApplication?.checkpointId === virtualCandidate.data.checkpointId &&
      this.virtualApplication.refreshRequested,
    );
    const virtualRefreshNeeded = Boolean(
      virtualCandidate &&
      (virtualRefreshRequested ||
        this.shouldRefresh(
          virtualCandidate,
          branchEntries,
          model,
          config,
          reserveTokens,
          usage?.tokens,
        )),
    );
    if (!bypassThreshold && !virtualRefreshNeeded) {
      if (!usageKnown) {
        this.diagnostics.count("threshold_skipped_unknown_usage");
        return undefined;
      }
      const softReached = limits
        ? usage!.tokens! >= limits.refreshLimit || usage!.percent! >= config.softThresholdPercent
        : usage!.percent! >= config.softThresholdPercent;
      if (!softReached) {
        return undefined;
      }
    }

    const snapshotKey = createSnapshotKey(
      sessionId,
      epochCompactionId,
      snapshotSourceLeafId,
      config,
    );
    if (this.inFlightTask || sharedRuntimeState.activeBackgroundOperation) {
      return undefined;
    }

    const existingCandidate = candidates[0];
    const existingRefreshRequested = Boolean(
      existingCandidate &&
      virtualRefreshRequested &&
      virtualCandidate?.data.checkpointId === existingCandidate.data.checkpointId,
    );
    if (
      !bypassThreshold &&
      !options?.force &&
      existingCandidate &&
      !existingRefreshRequested &&
      !this.shouldRefresh(
        existingCandidate,
        branchEntries,
        model,
        config,
        reserveTokens,
        usage?.tokens,
      )
    ) {
      return undefined;
    }

    const attempts = this.attemptsBySnapshotKey.get(snapshotKey) ?? 0;
    if (!bypassThreshold && !options?.force && attempts > MAX_BACKGROUND_RETRIES) {
      return undefined;
    }
    this.attemptsBySnapshotKey.set(snapshotKey, attempts + 1);
    const parentCheckpoint =
      options?.parentCheckpoint ?? (existingCandidate === undefined ? undefined : existingCandidate.data);
    const task = this.startBackgroundTask({
      sessionId,
      snapshotLeafId,
      snapshotSourceLeafId,
      epochCompactionId,
      snapshotKey,
      branchEntries: [...branchEntries],
      model,
      thinkingLevel: config.summaryThinkingLevel === "inherit"
        ? ctx.thinkingLevel ?? "medium"
        : config.summaryThinkingLevel,
      reserveTokens,
      config,
      ...(options?.keepRecentTokens === undefined ? {} : { keepRecentTokens: options.keepRecentTokens }),
      ...(parentCheckpoint === undefined ? {} : { parentCheckpoint }),
    });
    if (
      task &&
      existingCandidate &&
      this.virtualApplication?.checkpointId === existingCandidate.data.checkpointId
    ) {
      this.virtualApplication.refreshRequested = false;
    }
    return task;
  }

  async beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<{ compaction: CompactionResult } | undefined> {
    this.bindContext(ctx);
    const config = this.loadCurrentConfig(ctx);
    if (this.checkpointClaim && this.checkpointClaim.signal !== event.signal) {
      this.releaseCheckpointClaim();
    }
    const internalFormalization = this.isPendingFormalization(event, ctx);
    const pending = this.pendingFormalization;
    // 失败事件没有 signal；独立于 claim 保存内部请求及最近压缩操作的归属。
    if (pending?.compaction) {
      pending.compaction.isCurrent = pending.compaction.signal === event.signal;
    } else if (internalFormalization && pending) {
      pending.compaction = { signal: event.signal, isCurrent: true, cancelled: false };
    }
    const internalCheckpointId = internalFormalization
      ? pending?.checkpointId
      : undefined;
    if (config.precomputeMode === "off" || !this.isSupportedCompaction(event, config, internalFormalization)) {
      return undefined;
    }
    if (this.hookInFlight) {
      return undefined;
    }
    this.hookInFlight = true;
    const overflowRecovery = event.reason === "overflow" || event.willRetry;
    const overflowBaselineCheckpointId = overflowRecovery
      ? this.virtualApplication?.checkpointId
      : undefined;
    try {
      let result = this.tryReuseCheckpoint(
        event,
        ctx,
        internalCheckpointId,
        overflowBaselineCheckpointId,
      );
      if (result) {
        return { compaction: result };
      }

      const task = this.findCompatibleTask(ctx);
      const waitTimeoutMs = overflowRecovery
        ? (task ? this.remainingTaskTime(task) : 0)
        : config.hookWaitTimeoutMs;
      if (!task || waitTimeoutMs <= 0) {
        return undefined;
      }
      const waitOutcome = await this.waitForTask(task, waitTimeoutMs, event.signal);
      if (waitOutcome !== "finished") {
        if (waitOutcome === "timeout") {
          if (overflowRecovery) {
            this.diagnostics.count("overflow_wait_timed_out");
            this.diagnostics.record("capacity", "Overflow recovery timed out waiting for an incremental checkpoint. Falling back to Pi's native compaction.");
          } else {
            this.diagnostics.count("hook_wait_timed_out");
            this.notifyWarning("Timed out waiting for the precomputed summary. Background task cancelled. Falling back to Pi's native compaction.");
            this.discardTask(task, "hook_timeout");
          }
        } else if (!overflowRecovery) {
          this.discardTask(task, "hook_aborted");
        }
        return undefined;
      }
      if (event.signal.aborted) {
        return undefined;
      }
      result = this.tryReuseCheckpoint(
        event,
        ctx,
        internalCheckpointId,
        overflowBaselineCheckpointId,
      );
      return result ? { compaction: result } : undefined;
    } finally {
      this.hookInFlight = false;
    }
  }

  private isPendingFormalization(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): boolean {
    const pending = this.pendingFormalization;
    if (
      !pending ||
      event.reason !== "manual" ||
      event.willRetry ||
      (pending.compaction !== undefined && pending.compaction.signal !== event.signal) ||
      (event.customInstructions !== undefined && event.customInstructions.trim().length > 0) ||
      pending.runEpoch !== this.runEpoch ||
      pending.sessionId !== ctx.sessionManager.getSessionId()
    ) {
      return false;
    }
    return getEpochCompactionId(ctx.sessionManager.getBranch()) === pending.epochCompactionId;
  }

  private isIdle(ctx: ExtensionContext): boolean {
    try {
      return ctx.isIdle();
    } catch (error: unknown) {
      this.diagnostics.record("lifecycle", `Unable to read the agent's idle state: ${describeError(error)}`);
      return false;
    }
  }

  private isPrecomputeDisabled(): boolean {
    return this.currentConfig.precomputeMode === "off";
  }

  private formalizationEpochKey(sessionId: string, epochCompactionId: string | null): string {
    return `${sessionId}:${epochCompactionId ?? "null"}`;
  }

  private isFormalizationExhausted(
    sessionId: string,
    epochCompactionId: string | null,
  ): boolean {
    const epochKey = this.formalizationEpochKey(sessionId, epochCompactionId);
    return (this.formalizationAttemptsByEpoch.get(epochKey) ?? 0) >= MAX_FORMALIZATION_ATTEMPTS;
  }

  private async runFormalization(schedule: FormalizationSchedule): Promise<void> {
    if (this.formalizationSchedule !== schedule) {
      return;
    }
    this.formalizationSchedule = undefined;
    const ctx = schedule.ctx;
    if (
      schedule.runEpoch !== this.runEpoch ||
      this.currentSessionId !== schedule.sessionId ||
      this.isPrecomputeDisabled() ||
      !this.isIdle(ctx)
    ) {
      this.diagnostics.count("formalization_skipped_stale");
      return;
    }

    const task = this.findCompatibleTask(ctx);
    if (task) {
      const timeoutMs = this.remainingTaskTime(task);
      const waitOutcome = await this.waitForTask(task, timeoutMs, new AbortController().signal);
      if (waitOutcome === "timeout") {
        this.diagnostics.count("formalization_wait_timed_out");
      } else {
        this.diagnostics.count("formalization_waited");
      }
    }

    if (
      schedule.runEpoch !== this.runEpoch ||
      this.currentSessionId !== schedule.sessionId ||
      this.isPrecomputeDisabled() ||
      !this.isIdle(ctx)
    ) {
      this.diagnostics.count("formalization_skipped_stale");
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    const currentEpoch = getEpochCompactionId(branch);
    if (
      currentEpoch !== schedule.epochCompactionId ||
      getEntryIndex(branch, schedule.scheduledLeafId) < 0
    ) {
      this.diagnostics.count("formalization_skipped_stale");
      return;
    }
    const candidates = findReadyCheckpointCandidates(
      branch,
      schedule.sessionId,
      currentEpoch,
      this.checkpointClaim?.checkpointId,
    );
    const application = this.virtualApplication;
    const applicationCandidate = application
      ? candidates.find((item) => item.data.checkpointId === application.checkpointId)
      : undefined;
    const candidate = candidates[0];
    if (!candidate || !applicationCandidate) {
      this.diagnostics.count("formalization_skipped_stale");
      return;
    }

    const checkedLeafId = ctx.sessionManager.getLeafId();
    if (!checkedLeafId) {
      this.diagnostics.count("formalization_skipped_stale");
      return;
    }
    const model = asModel(ctx.model);
    if (!model) {
      this.diagnostics.count("formalization_skipped_unknown_model");
      return;
    }
    const preparation = prepareCompactionFromBranch(
      branch,
      createFormalizationPreparationSettings(
        loadPiCompactionReserveTokens(ctx.cwd, isProjectTrustedContext(ctx), model),
        loadPiCompactionKeepRecentTokens(
          ctx.cwd,
          isProjectTrustedContext(ctx),
          model,
        ),
      ),
    );
    if (!preparation) {
      this.deferredFormalization = {
        checkpointId: candidate.data.checkpointId,
        sessionId: schedule.sessionId,
        epochCompactionId: schedule.epochCompactionId,
        checkedLeafId,
      };
      this.diagnostics.count("formalization_deferred");
      this.diagnostics.record("lifecycle", "The current branch has not reached Pi's compaction boundary. Finalization deferred.");
      return;
    }
    this.deferredFormalization = undefined;

    const epochKey = this.formalizationEpochKey(schedule.sessionId, schedule.epochCompactionId);
    const failureCount = this.formalizationAttemptsByEpoch.get(epochKey) ?? 0;
    if (failureCount >= MAX_FORMALIZATION_ATTEMPTS) {
      return;
    }
    const pending: PendingFormalization = {
      requestId: schedule.requestId,
      runEpoch: schedule.runEpoch,
      checkpointId: candidate.data.checkpointId,
      sessionId: schedule.sessionId,
      epochCompactionId: schedule.epochCompactionId,
      scheduledLeafId: checkedLeafId,
      attempt: failureCount + 1,
    };
    this.pendingFormalization = pending;
    this.diagnostics.count("formalization_started");

    try {
      ctx.compact({
        onComplete: () => this.onFormalizationComplete(pending),
        onError: (error: Error) => this.onFormalizationError(pending, error),
      });
    } catch (error: unknown) {
      this.onFormalizationError(pending, error);
    }
  }

  private onFormalizationComplete(pending: PendingFormalization): void {
    if (this.pendingFormalization?.requestId !== pending.requestId) {
      return;
    }
    this.diagnostics.count("formalization_complete_callback");
  }

  private onFormalizationError(pending: PendingFormalization, error: unknown): void {
    if (
      this.pendingFormalization?.requestId !== pending.requestId ||
      pending.runEpoch !== this.runEpoch
    ) {
      return;
    }
    if (this.checkpointClaim?.signal === pending.compaction?.signal) {
      this.releaseCheckpointClaim(pending.checkpointId);
    }
    this.pendingFormalization = undefined;
    if (pending.compaction?.cancelled) {
      this.diagnostics.count("formalization_cancelled", {
        checkpointId: pending.checkpointId,
        reason: "internal_compaction_aborted",
      });
      return;
    }
    if (isSessionTooSmallError(error)) {
      this.deferredFormalization = {
        checkpointId: pending.checkpointId,
        sessionId: pending.sessionId,
        epochCompactionId: pending.epochCompactionId,
        checkedLeafId: pending.scheduledLeafId,
      };
      this.diagnostics.count("formalization_deferred");
      this.diagnostics.record("lifecycle", "Pi found no content to compact. Finalization deferred.");
      return;
    }

    const epochKey = this.formalizationEpochKey(pending.sessionId, pending.epochCompactionId);
    const failureCount = (this.formalizationAttemptsByEpoch.get(epochKey) ?? 0) + 1;
    this.formalizationAttemptsByEpoch.set(epochKey, failureCount);
    this.diagnostics.count("formalization_failed");
    this.diagnostics.record("lifecycle", `Virtual compaction finalization failed: ${describeError(error)}`);
    if (failureCount >= MAX_FORMALIZATION_ATTEMPTS) {
      if (this.inFlightTask) {
        this.discardTask(this.inFlightTask, "formalization_exhausted");
      }
      this.clearVirtualState();
      this.virtualContextCache.clear();
      this.diagnostics.count("formalization_exhausted");
      this.diagnostics.record(
        "lifecycle",
        "The finalization failure limit was reached. Virtual compaction disabled for the current compaction cycle.",
      );
      this.notifyWarning("Virtual compaction finalization failed repeatedly. Pi will handle subsequent requests.");
      return;
    }
    this.notifyWarning("Failed to finalize virtual compaction. At most one retry will be attempted once the session settles.");
  }

  private cancelFormalizationSchedule(): void {
    const schedule = this.formalizationSchedule;
    if (!schedule) {
      return;
    }
    if (schedule.timer) {
      clearTimeout(schedule.timer);
    }
    this.formalizationSchedule = undefined;
  }

  private clearVirtualState(): void {
    this.virtualApplication = undefined;
    this.cancelFormalizationSchedule();
    this.pendingFormalization = undefined;
    this.deferredFormalization = undefined;
    this.lastContextEvaluation = undefined;
    this.lastUnpersistedCandidate = undefined;
  }

  private captureDiagnosticContext(): DiagnosticEventMetadata {
    let branchLeafId: string | undefined;
    try {
      branchLeafId = this.currentSessionManager?.getLeafId() ?? undefined;
    } catch {
      // 分支读取失败时仍保留其余运行状态。
    }
    const task = this.inFlightTask;
    const application = this.virtualApplication;
    const schedule = this.formalizationSchedule;
    const pending = this.pendingFormalization;
    const deferred = this.deferredFormalization;
    const claim = this.checkpointClaim;
    const cache = this.virtualContextCache.stats();
    const state: JsonObject = {
      runEpoch: this.runEpoch,
      hookInFlight: this.hookInFlight,
      inFlightTask: task
        ? {
          taskId: task.taskId,
          stage: task.stage,
          requestCount: task.requestCount,
          retryCount: task.retryCount,
          sessionId: task.sessionId,
          runEpoch: task.runEpoch,
          snapshotLeafId: task.snapshotLeafId,
          snapshotSourceLeafId: task.snapshotSourceLeafId,
          epochCompactionId: task.epochCompactionId,
          startedAt: task.startedAt,
          discarded: task.discarded,
          firstKeptEntryId: task.firstKeptEntryId ?? null,
          parentCheckpointId: task.parentCheckpoint?.checkpointId ?? null,
        }
        : null,
      checkpointClaim: claim ? { checkpointId: claim.checkpointId } : null,
      virtualApplication: application
        ? {
          checkpointId: application.checkpointId,
          sessionId: application.sessionId,
          epochCompactionId: application.epochCompactionId,
          lastAppliedLeafId: application.lastAppliedLeafId,
          refreshRequested: application.refreshRequested,
        }
        : null,
      formalizationSchedule: schedule
        ? {
          requestId: schedule.requestId,
          runEpoch: schedule.runEpoch,
          checkpointId: schedule.checkpointId,
          sessionId: schedule.sessionId,
          epochCompactionId: schedule.epochCompactionId,
          scheduledLeafId: schedule.scheduledLeafId,
        }
        : null,
      pendingFormalization: pending
        ? {
          requestId: pending.requestId,
          runEpoch: pending.runEpoch,
          checkpointId: pending.checkpointId,
          sessionId: pending.sessionId,
          epochCompactionId: pending.epochCompactionId,
          scheduledLeafId: pending.scheduledLeafId,
          attempt: pending.attempt,
        }
        : null,
      deferredFormalization: deferred
        ? {
          checkpointId: deferred.checkpointId,
          sessionId: deferred.sessionId,
          epochCompactionId: deferred.epochCompactionId,
          checkedLeafId: deferred.checkedLeafId,
        }
        : null,
      attemptsBySnapshotKey: this.attemptsBySnapshotKey.size,
      formalizationEpochs: this.formalizationAttemptsByEpoch.size,
      virtualContextCache: {
        rebuilds: cache.rebuilds,
        incrementallyIndexedEntries: cache.incrementallyIndexedEntries,
        branchEntries: cache.branchEntries,
        sourceMessages: cache.sourceMessages,
      },
      config: {
        precomputeMode: this.currentConfig.precomputeMode,
        softThresholdPercent: this.currentConfig.softThresholdPercent,
        diagnosticsPersistence: this.currentConfig.diagnosticsPersistence,
      },
    };
    return {
      ...(this.currentSessionId === undefined ? {} : { sessionId: this.currentSessionId }),
      ...(this.currentEpochCompactionId === undefined
        ? {}
        : { epochCompactionId: this.currentEpochCompactionId }),
      ...(branchLeafId === undefined ? {} : { branchLeafId }),
      ...(application === undefined ? {} : { checkpointId: application.checkpointId }),
      state,
    };
  }

  private bindContext(ctx: ExtensionContext): void {
    this.currentSessionManager = ctx.sessionManager;
    this.currentModelRegistry = ctx.modelRegistry;
    this.currentSessionId = ctx.sessionManager.getSessionId();
    try {
      this.currentEpochCompactionId = getEpochCompactionId(ctx.sessionManager.getBranch());
    } catch {
      this.currentEpochCompactionId = undefined;
    }
    const ui = ctx.ui;
    this.currentNotify = ui && typeof ui.notify === "function" ? ui.notify.bind(ui) : undefined;
  }

  private notifyUser(message: string, type: NotificationType): void {
    if (!this.currentNotify) {
      return;
    }
    try {
      this.currentNotify(message, type);
    } catch (error: unknown) {
      this.diagnostics.record("lifecycle", `Unable to display the CLI notification: ${describeError(error)}`);
    }
  }

  private notifyWarning(message: string): void {
    this.notifyUser(`pi-press: ${message}`, "warning");
  }

  private reportTaskFailure(message: string, metadata?: DiagnosticEventMetadata): void {
    const failure = describeError(message);
    this.diagnostics.count("task_failed", metadata);
    this.diagnostics.record("task", failure, metadata);
    this.notifyUser(`pi-press: Background summary precomputation failed: ${failure}`, "error");
  }

  private notifyCheckpointReady(task: BackgroundTask): void {
    const elapsedSeconds = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    this.notifyUser(
      `pi-press: Summary precomputation completed in ${elapsedSeconds}s.`,
      "info",
    );
  }

  private loadCurrentConfig(ctx: ExtensionContext): PiPressConfig {
    const result = loadConfig(ctx.cwd);
    this.currentConfig = result.config;
    const storeFactory = this.diagnosticStoreFactory;
    if (result.config.diagnosticsPersistence === "sqlite" && storeFactory) {
      const configuration: DiagnosticStoreConfiguration = {
        retentionDays: result.config.diagnosticsRetentionDays,
        maxDatabaseMiB: result.config.diagnosticsMaxDatabaseMiB,
      };
      this.diagnostics.configurePersistence(
        `sqlite:${configuration.retentionDays}:${configuration.maxDatabaseMiB}`,
        () => storeFactory(configuration),
      );
    } else {
      this.diagnostics.configurePersistence(undefined);
    }
    for (const message of result.diagnostics) {
      const removedTargetPercent = message.includes("targetPostCompactionPercent");
      const removedSummaryReserve = message.includes("summaryReserveTokens");
      if (
        this.reportedConfigDiagnostics.has(message) ||
        (removedTargetPercent && this.removedTargetPercentReported) ||
        (removedSummaryReserve && this.removedSummaryReserveReported)
      ) {
        continue;
      }
      this.reportedConfigDiagnostics.add(message);
      if (removedTargetPercent) {
        this.removedTargetPercentReported = true;
      }
      if (removedSummaryReserve) {
        this.removedSummaryReserveReported = true;
        this.notifyWarning(message);
      }
      this.diagnostics.record("config", message);
    }
    if (result.config.precomputeMode === "off") {
      if (this.inFlightTask) {
        this.discardTask(this.inFlightTask, "config_off");
      }
      this.clearVirtualState();
      this.formalizationAttemptsByEpoch.clear();
    }
    return result.config;
  }

  private claimCheckpoint(checkpointId: string, signal: AbortSignal): void {
    this.releaseCheckpointClaim();
    const abortHandler = (): void => this.releaseCheckpointClaim(checkpointId);
    this.checkpointClaim = { checkpointId, signal, abortHandler };
    signal.addEventListener("abort", abortHandler, { once: true });
    this.diagnostics.count("checkpoint_claimed", { checkpointId });
  }

  private releaseCheckpointClaim(checkpointId?: string): void {
    const claim = this.checkpointClaim;
    if (!claim || (checkpointId !== undefined && claim.checkpointId !== checkpointId)) {
      return;
    }
    claim.signal.removeEventListener("abort", claim.abortHandler);
    this.checkpointClaim = undefined;
    this.diagnostics.count("checkpoint_claim_released", {
      checkpointId: claim.checkpointId,
    });
  }

  private invalidate(reason: string, clearContext: boolean): void {
    this.stopForegroundWaitProgress();
    this.runEpoch += 1;
    if (this.inFlightTask) {
      this.discardTask(this.inFlightTask, reason);
    }
    this.releaseCheckpointClaim();
    this.clearVirtualState();
    this.attemptsBySnapshotKey.clear();
    this.formalizationAttemptsByEpoch.clear();
    this.virtualContextCache.clear();
    this.lastUnpersistedCandidate = undefined;
    if (clearContext) {
      this.currentSessionManager = undefined;
      this.currentModelRegistry = undefined;
      this.currentSessionId = undefined;
      this.currentEpochCompactionId = undefined;
      this.currentNotify = undefined;
      this.recordedTranscriptDeltas.clear();
    }
  }

  private isCurrentTask(task: BackgroundTask): boolean {
    return (
      this.inFlightTask === task &&
      !task.discarded &&
      !task.controller.signal.aborted &&
      task.runEpoch === this.runEpoch &&
      this.currentSessionId === task.sessionId &&
      this.currentConfig.precomputeMode !== "off"
    );
  }

  private taskMetadata(task: BackgroundTask, details: JsonObject = {}): DiagnosticEventMetadata {
    return {
      sessionId: task.sessionId,
      epochCompactionId: task.epochCompactionId,
      branchLeafId: task.snapshotLeafId,
      details: {
        taskId: task.taskId,
        stage: task.stage,
        elapsedMs: Date.now() - task.startedAt,
        stageElapsedMs: Date.now() - task.stageStartedAt,
        requestCount: task.requestCount,
        retryCount: task.retryCount,
        ...details,
      },
    };
  }

  private startBackgroundTask(
    input: Omit<BackgroundTask, "taskId" | "stage" | "stageStartedAt" | "requestCount" | "retryCount" | "runEpoch" | "controller" | "startedAt" | "discarded">
  ): BackgroundTask | undefined {
    if (sharedRuntimeState.activeBackgroundOperation) {
      return undefined;
    }
    const task: BackgroundTask = {
      ...input,
      taskId: randomUUID(),
      stage: "preparation",
      stageStartedAt: Date.now(),
      requestCount: 0,
      retryCount: 0,
      runEpoch: this.runEpoch,
      controller: new AbortController(),
      startedAt: Date.now(),
      discarded: false,
    };
    this.inFlightTask = task;
    this.diagnostics.count("task_started", this.taskMetadata(task, {
      provider: task.model.provider,
      modelId: task.model.id,
      thinkingLevel: task.thinkingLevel,
      taskTimeoutMs: task.config.taskTimeoutMs,
    }));
    const operation = Promise.resolve().then(() => this.generateCheckpoint(task));
    sharedRuntimeState.activeBackgroundOperation = operation;
    const releaseOperation = (outcome: "resolved" | "rejected"): void => {
      this.diagnostics.count("background_operation_settled", this.taskMetadata(task, {
        outcome,
        aborted: task.controller.signal.aborted,
      }));
      if (sharedRuntimeState.activeBackgroundOperation === operation) {
        delete sharedRuntimeState.activeBackgroundOperation;
      }
    };
    void operation.then(() => releaseOperation("resolved"), () => releaseOperation("rejected"));
    const promise = this.runBackgroundTask(task, operation);
    task.promise = promise;
    void promise.then(
      () => this.finishTask(task),
      (error: unknown) => {
        if (!task.discarded && !task.controller.signal.aborted && !isAbortLike(error)) {
          this.reportTaskFailure(describeError(error));
        }
        this.finishTask(task);
      },
    );
    return task;
  }

  private async runBackgroundTask(
    task: BackgroundTask,
    operation: Promise<void>,
  ): Promise<void> {
    try {
      await this.runWithTimeout(() => operation, task);
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        this.diagnostics.count("task_timed_out", this.taskMetadata(task));
        this.reportTaskFailure(`Background summary precomputation timed out (stage: ${task.stage}, requests: ${task.requestCount}, retries: ${task.retryCount})`);
        return;
      }
      if (task.discarded || task.controller.signal.aborted || isAbortLike(error)) {
        this.diagnostics.count("task_cancelled", this.taskMetadata(task));
        return;
      }
      const metadata = this.taskMetadata(task, {
        ...(task.failureKind === undefined ? {} : { failureKind: task.failureKind }),
      });
      if (task.failureKind === "empty_summary" || task.failureKind === "invalid_summary") {
        this.reportTaskFailure("The model returned an empty or invalid summary", metadata);
      } else if (task.failureKind === "transient_error") {
        this.reportTaskFailure("Retries exhausted for transient errors", metadata);
      } else if (task.failureKind === "deterministic_error") {
        this.reportTaskFailure("The model returned a non-retryable error", metadata);
      } else {
        this.reportTaskFailure("Background summary precomputation failed", metadata);
      }
    }
  }

  private async generateCheckpoint(task: BackgroundTask): Promise<void> {
    if (!this.isCurrentTask(task)) {
      return;
    }
    const keepRecentTokens = task.keepRecentTokens ?? CHECKPOINT_KEEP_RECENT_TOKENS;
    const nativePreparation = prepareCompactionFromBranch(
      task.branchEntries,
      createCheckpointPreparationSettings(task.reserveTokens, keepRecentTokens),
      task.parentCheckpoint,
    );
    this.diagnostics.count("task_stage_finished", this.taskMetadata(task, {
      durationMs: Date.now() - task.stageStartedAt,
      prepared: nativePreparation !== undefined,
      ...(nativePreparation ? {
        isSplitTurn: nativePreparation.isSplitTurn,
        historyMessageCount: nativePreparation.messagesToSummarize.length,
        turnPrefixMessageCount: nativePreparation.turnPrefixMessages.length,
        tokensBefore: nativePreparation.tokensBefore,
      } : {}),
    }));
    if (!nativePreparation) {
      const message = "Unable to prepare the current branch for compaction";
      this.diagnostics.count("task_skipped_no_preparation");
      this.diagnostics.record("task", message);
      return;
    }
    let preparation = nativePreparation;
    if (task.parentCheckpoint) {
      const tokensBefore = calculateOriginalTokensBefore(
        task.parentCheckpoint,
        task.branchEntries,
      );
      if (tokensBefore === undefined) {
        this.diagnostics.count("task_skipped_original_tokens_unavailable");
        this.diagnostics.record(
          "checkpoint",
          `Checkpoint ${task.parentCheckpoint.checkpointId}: unable to estimate the original context token count`,
        );
        return;
      }
      preparation = { ...nativePreparation, tokensBefore };
    }
    task.firstKeptEntryId = preparation.firstKeptEntryId;
    if (!this.isCurrentTask(task)) {
      return;
    }

    const registry = this.currentModelRegistry;
    if (!registry) {
      this.diagnostics.count("task_skipped_missing_registry");
      this.reportTaskFailure("The provider registry for the current model is unavailable");
      return;
    }
    task.stage = "auth";
    task.stageStartedAt = Date.now();
    const providerResult = await resolveProviderRequest(
      registry,
      task.model,
      task.controller.signal,
    );
    this.diagnostics.count("task_stage_finished", this.taskMetadata(task, {
      durationMs: Date.now() - task.stageStartedAt,
      ok: providerResult.ok,
    }));
    if (!this.isCurrentTask(task)) {
      return;
    }
    if (!providerResult.ok) {
      this.diagnostics.count(`provider_${providerResult.failure.kind}_failure`);
      const failure = providerResult.failure.kind === "auth"
        ? "Authentication for the active model is unavailable"
        : "The provider for the active model is unavailable";
      this.diagnostics.record("provider", failure);
      this.reportTaskFailure(failure);
      return;
    }

    const retry = {
      get enabled(): boolean {
        return MAX_BACKGROUND_RETRIES - task.retryCount > 0;
      },
      get maxRetries(): number {
        return Math.max(0, MAX_BACKGROUND_RETRIES - task.retryCount);
      },
      baseDelayMs: RETRY_BASE_DELAY_MS,
    };
    let historyFinished = preparation.messagesToSummarize.length === 0;
    const streamFn: StreamFn = async (model, context, options) => {
      if (task.controller.signal.aborted || options?.signal?.aborted) {
        const abortError = new Error("The operation was aborted");
        abortError.name = "AbortError";
        throw abortError;
      }
      if (this.remainingTaskTime(task) <= 0) {
        const timeoutError = new Error("Pi-press background task timed out");
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      task.stage = historyFinished ? "turn_prefix_summary" : "history_summary";
      task.stageStartedAt = Date.now();
      const stage = task.stage;
      const startedAt = task.stageStartedAt;
      const requestIndex = ++task.requestCount;
      this.diagnostics.count("summary_request_started", this.taskMetadata(task, { requestIndex }));
      const settled = (stopReason: string, advanceStage = false): void => {
        this.diagnostics.count("summary_request_settled", this.taskMetadata(task, {
          stage,
          requestIndex,
          durationMs: Date.now() - startedAt,
          stopReason,
          aborted: task.controller.signal.aborted,
        }));
        if (advanceStage) {
          historyFinished = true;
        }
      };
      try {
        const stream = await providerResult.request.streamFn(model, context, options);
        const rawResultPromise = stream.result();
        const validatedResultPromise = rawResultPromise.then(
          (message) => {
            const hasToolCall = message.content.some((block) => block.type === "toolCall");
            const text = contentText(message.content).trim();
            if (message.stopReason === "stop" && !hasToolCall && text.length === 0) {
              task.failureKind = "empty_summary";
              settled("empty_summary", false);
              return {
                ...message,
                stopReason: "error" as const,
                errorMessage: "Empty summary response (server_error)",
              };
            }
            if (message.stopReason === "length" || hasToolCall) {
              task.failureKind = "invalid_summary";
              settled(message.stopReason, false);
              return message;
            }
            if (message.stopReason === "error") {
              task.failureKind = isRetryableAssistantError(message)
                ? "transient_error"
                : "deterministic_error";
              settled(message.stopReason, false);
              return message;
            }
            if (message.stopReason === "stop") {
              task.failureKind = undefined;
              settled("stop", true);
              return message;
            }
            settled(message.stopReason, false);
            return message;
          },
          (error: unknown) => {
            if (!isAbortLike(error) && !isTimeoutError(error)) {
              task.failureKind = "transient_error";
            }
            settled("rejected", false);
            throw error;
          },
        );
        return {
          ...stream,
          result: () => validatedResultPromise,
        } as typeof stream;
      } catch (error: unknown) {
        if (!isAbortLike(error) && !isTimeoutError(error)) {
          task.failureKind = "transient_error";
        }
        settled("rejected", false);
        throw error;
      }
    };
    const request = Promise.resolve().then(() => compact(
      preparation,
      providerResult.request.model,
      providerResult.request.apiKey,
      providerResult.request.headers,
      undefined,
      task.controller.signal,
      task.thinkingLevel,
      streamFn,
      providerResult.request.env,
      retry,
      {
        onRetryScheduled: (attempt, maxRetries, delayMs) => {
          task.retryCount++;
          task.stage = "retry_backoff";
          task.stageStartedAt = Date.now();
          this.activeForegroundWait?.refresh();
          this.diagnostics.count("summary_retry_scheduled", this.taskMetadata(task, {
            attempt, maxRetries, delayMs,
          }));
        },
        onRetryAttemptStart: () => {
          this.diagnostics.count("summary_retry_started", this.taskMetadata(task, {
            durationMs: Date.now() - task.stageStartedAt,
          }));
        },
        onRetryFinished: (success, attempt) => {
          this.diagnostics.count("summary_retry_finished", this.taskMetadata(task, { success, attempt }));
        },
      },
    ));
    const result = await request;
    if (!this.isCurrentTask(task)) {
      this.diagnostics.recordUsage("discarded", result.usage);
      return;
    }
    task.stage = "checkpoint";
    task.stageStartedAt = Date.now();
    const appendOutcome = this.appendCheckpoint(
      task,
      preparation,
      result,
      providerResult.request.model,
    );
    if (appendOutcome !== "appended") {
      this.diagnostics.recordUsage("discarded", result.usage);
      if (appendOutcome === "failed" && this.isCurrentTask(task)) {
        this.reportTaskFailure("The compaction result failed checkpoint validation or could not be appended");
      }
      return;
    }
    this.diagnostics.count("checkpoint_ready", this.taskMetadata(task));
    this.notifyCheckpointReady(task);
  }

  private finishTask(task: BackgroundTask): void {
    if (this.inFlightTask === task) {
      this.inFlightTask = undefined;
      this.diagnostics.count("task_finished", {
        ...this.taskMetadata(task, { snapshotLeafId: task.snapshotLeafId }),
        reason: task.discarded ? "discarded" : "completed",
      });
    }
  }

  private discardTask(task: BackgroundTask, reason: string): void {
    if (this.inFlightTask === task) {
      this.inFlightTask = undefined;
    }
    if (!task.discarded) {
      task.discarded = true;
      const metadata = {
        ...this.taskMetadata(task, { snapshotLeafId: task.snapshotLeafId }),
        reason,
      };
      this.diagnostics.count("task_discarded", metadata);
      this.diagnostics.record("lifecycle", reason, metadata);
      task.controller.abort();
    }
  }

  private async runWithTimeout<T>(
    operation: () => Promise<T>,
    task: BackgroundTask,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (this.inFlightTask === task) {
          this.inFlightTask = undefined;
        }
        task.controller.abort();
        const error = new Error("Pi-press background task timed out");
        error.name = "TimeoutError";
        reject(error);
      }, task.config.taskTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private appendCheckpoint(
    task: BackgroundTask,
    preparation: CompactionPreparation,
    result: CompactionResult,
    requestModel: Model<Api>,
  ): CheckpointAppendOutcome {
    if (!this.isCurrentTask(task)) {
      return "skipped";
    }
    const manager = this.currentSessionManager;
    if (!manager || this.currentSessionId !== task.sessionId) {
      return "skipped";
    }
    const branch = manager.getBranch();
    const currentEpoch = getEpochCompactionId(branch);
    if (
      currentEpoch !== task.epochCompactionId ||
      getEntryIndex(branch, task.snapshotLeafId) < 0 ||
      !isSnapshotProjectionCompatible(branch, task.snapshotLeafId) ||
      !isBeforeOrSame(branch, preparation.firstKeptEntryId, task.snapshotLeafId)
    ) {
      return "skipped";
    }
    if (!result.summary.trim() || !isJsonObject(result.details) && result.details !== undefined) {
      this.diagnostics.count("checkpoint_invalid_result");
      return "failed";
    }
    if (result.usage !== undefined && !isUsage(result.usage)) {
      this.diagnostics.count("checkpoint_invalid_usage");
      return "failed";
    }
    const contextWindow = task.model.contextWindow;
    const provenanceBaseUrl = sanitizeProvenanceBaseUrl(requestModel.baseUrl);
    const candidateData: CheckpointData = {
      version: CHECKPOINT_VERSION,
      piVersion: VERSION,
      algorithmVersion: PREPARATION_ALGORITHM_VERSION,
      summaryFormatVersion: SUMMARY_FORMAT_VERSION,
      checkpointId: randomUUID(),
      ...(task.parentCheckpoint === undefined
        ? {}
        : { parentCheckpointId: task.parentCheckpoint.checkpointId }),
      sessionId: task.sessionId,
      snapshotLeafId: task.snapshotLeafId,
      snapshotSourceLeafId: task.snapshotSourceLeafId,
      epochCompactionId: task.epochCompactionId,
      snapshotKey: task.snapshotKey,
      compaction: {
        summary: result.summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.details === undefined ? {} : { details: result.details }),
      },
      estimatedTokensAfterAtSnapshot: 0,
      provenance: {
        model: {
          provider: requestModel.provider,
          id: requestModel.id,
          api: requestModel.api,
          baseUrl: provenanceBaseUrl ?? "",
          contextWindow: requestModel.contextWindow,
          maxTokens: requestModel.maxTokens,
        },
        thinkingLevel: task.thinkingLevel,
        configFingerprint: configFingerprint(task.config),
      },
      createdAt: new Date().toISOString(),
    };
    const capacity = estimateCheckpointCapacity(
      task.branchEntries,
      candidateData,
      preparation,
      contextWindow,
    );
    if (!capacity) {
      this.diagnostics.count("checkpoint_skipped_capacity_unavailable");
      this.diagnostics.record(
        "capacity",
        `Checkpoint ${candidateData.checkpointId}: unable to estimate the post-compaction context size`,
      );
      this.notifyWarning(
        `Unable to estimate the precomputed context size. Checkpoint ${candidateData.checkpointId} was not saved.`,
      );
      return "skipped";
    }
    candidateData.estimatedTokensAfterAtSnapshot = capacity.estimatedTokensAfter;
    if (!capacity.accepted) {
      const message = describeCapacityRejection(candidateData.checkpointId, capacity);
      this.diagnostics.count("checkpoint_skipped_capacity");
      this.diagnostics.record("capacity", message);
      this.notifyWarning(`The precomputed context exceeds the capacity limit. Result not saved: ${message}.`);
      this.lastUnpersistedCandidate = {
        sessionId: task.sessionId,
        candidate: candidateData,
      };
      return "skipped";
    }
    const checkpointData = parseCheckpointData(candidateData, { piVersion: VERSION });
    if (!checkpointData) {
      this.diagnostics.count("checkpoint_invalid_result");
      return "failed";
    }

    try {
      this.pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, checkpointData);
      this.lastUnpersistedCandidate = undefined;
      this.diagnostics.count("checkpoint_appended", {
        checkpointId: checkpointData.checkpointId,
        reason: "checkpoint_ready",
        details: {
          snapshotLeafId: checkpointData.snapshotLeafId,
          snapshotSourceLeafId: checkpointData.snapshotSourceLeafId,
          tokensBefore: checkpointData.compaction.tokensBefore,
          estimatedTokensAfterAtSnapshot: checkpointData.estimatedTokensAfterAtSnapshot,
        },
      });
      return "appended";
    } catch (error: unknown) {
      this.diagnostics.count("checkpoint_append_failure");
      this.diagnostics.record("checkpoint", error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }

  private shouldRefresh(
    candidate: CheckpointCandidate,
    branch: readonly SessionEntry[],
    model: Model<Api>,
    config: PiPressConfig,
    reserveTokens: number,
    currentUsageTokens?: number | null,
  ): boolean {
    const snapshotIndex = getEntryIndex(branch, candidate.data.snapshotLeafId);
    if (snapshotIndex < 0) {
      return true;
    }
    const currentSourceLeafId = getSnapshotSourceLeafId(branch);
    if (!currentSourceLeafId || currentSourceLeafId === candidate.data.snapshotSourceLeafId) {
      return false;
    }
    if (!hasContextSourceProgressAfter(branch, snapshotIndex)) {
      return false;
    }
    const trailingTokens = this.virtualContextCache.estimateTokensAfter(branch, snapshotIndex) ??
      estimateMessagesTokens(
        branch
          .slice(snapshotIndex + 1)
          .flatMap((entry) => sessionEntryToContextMessages(entry)),
      );
    const limits = calculateContextCapacityLimits(
      model.contextWindow,
      reserveTokens,
      config.softThresholdPercent,
    );
    const refreshLimit = limits
      ? limits.refreshLimit
      : Math.floor((model.contextWindow * config.softThresholdPercent) / 100);
    if (candidate.data.estimatedTokensAfterAtSnapshot + trailingTokens >= refreshLimit) {
      return true;
    }
    const application = this.virtualApplication;
    const modelKey = `${model.provider}/${model.id}`;
    if (
      application &&
      application.checkpointId === candidate.data.checkpointId &&
      application.sessionId === candidate.data.sessionId &&
      application.epochCompactionId === candidate.data.epochCompactionId &&
      application.modelKey === modelKey
    ) {
      const anchoredTokens = estimateAppliedCheckpointBranchTokens(
        branch,
        candidate.data,
        {
          appliedSinceLeafId: application.firstAppliedLeafId,
          appliedModelKey: application.modelKey,
          currentModelKey: modelKey,
        },
        this.virtualContextCache,
      );
      if (anchoredTokens !== undefined) {
        return anchoredTokens >= refreshLimit;
      }
      const firstAppliedIndex = getEntryIndex(branch, application.firstAppliedLeafId);
      if (
        firstAppliedIndex >= 0 &&
        hasContextSourceProgressAfter(branch, Math.max(snapshotIndex, firstAppliedIndex)) &&
        currentUsageTokens != null &&
        Number.isFinite(currentUsageTokens) &&
        currentUsageTokens >= refreshLimit
      ) {
        return true;
      }
    }
    return false;
  }

  private isSupportedCompaction(
    event: SessionBeforeCompactEvent,
    config: PiPressConfig,
    internalFormalization: boolean,
  ): boolean {
    if (event.customInstructions !== undefined && event.customInstructions.trim().length > 0) {
      return false;
    }
    if (event.reason === "overflow" || event.willRetry) {
      return true;
    }
    if (event.reason === "threshold") {
      return config.precomputeMode !== "off";
    }
    return internalFormalization || config.precomputeMode === "threshold-and-manual";
  }

  private tryReuseCheckpoint(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    requiredCheckpointId?: string,
    newerThanCheckpointId?: string,
  ): CompactionResult | undefined {
    if (event.signal.aborted) {
      return undefined;
    }
    const branch = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const epochCompactionId = getEpochCompactionId(branch);
    const candidates = findReadyCheckpointCandidates(
      branch,
      sessionId,
      epochCompactionId,
      this.checkpointClaim?.checkpointId,
    );
    const model = asModel(ctx.model);
    if (!model) {
      this.diagnostics.count("reuse_skipped_unknown_model");
      return undefined;
    }
    const baseline = newerThanCheckpointId === undefined
      ? undefined
      : candidates.find((candidate) => candidate.data.checkpointId === newerThanCheckpointId);
    const baselineSnapshotIndex = baseline
      ? getEntryIndex(branch, baseline.data.snapshotLeafId)
      : undefined;
    if (newerThanCheckpointId !== undefined && baselineSnapshotIndex === undefined) {
      return undefined;
    }
    for (const candidate of candidates) {
      if (requiredCheckpointId !== undefined && candidate.data.checkpointId !== requiredCheckpointId) {
        continue;
      }
      if (
        baselineSnapshotIndex !== undefined &&
        getEntryIndex(branch, candidate.data.snapshotLeafId) <= baselineSnapshotIndex
      ) {
        continue;
      }
      const tokensBefore = calculateOriginalTokensBefore(candidate.data, branch);
      if (tokensBefore === undefined) {
        this.diagnostics.count("checkpoint_rejected_original_tokens_unavailable");
        this.diagnostics.record(
          "checkpoint",
          `Checkpoint ${candidate.data.checkpointId}: unable to estimate the original context token count`,
        );
        continue;
      }
      const preparation = { ...event.preparation, tokensBefore };
      const capacity = estimateCheckpointCapacity(
        branch,
        candidate.data,
        preparation,
        model.contextWindow,
      );
      if (!capacity) {
        this.diagnostics.count("checkpoint_rejected_capacity_unavailable");
        this.diagnostics.record(
          "capacity",
          `Checkpoint ${candidate.data.checkpointId}: unable to estimate the post-compaction context size`,
        );
        this.notifyWarning(
          `Unable to estimate the context size for checkpoint ${candidate.data.checkpointId}. Falling back to Pi's native compaction.`,
        );
        continue;
      }
      if (!capacity.accepted) {
        const message = describeCapacityRejection(candidate.data.checkpointId, capacity);
        this.diagnostics.count("checkpoint_rejected_capacity");
        this.diagnostics.record("capacity", message);
        this.notifyWarning(`The checkpoint exceeds the capacity limit. Falling back to Pi's native compaction: ${message}.`);
        continue;
      }
      const result = buildCheckpointCompactionResult(candidate, preparation);
      this.claimCheckpoint(candidate.data.checkpointId, event.signal);
      if (this.inFlightTask && this.inFlightTask.epochCompactionId === epochCompactionId) {
        this.discardTask(this.inFlightTask, "checkpoint_reused");
      }
      this.diagnostics.count("checkpoint_reused");
      return result;
    }
    return undefined;
  }

  private findCompatibleTask(ctx: ExtensionContext): BackgroundTask | undefined {
    const task = this.inFlightTask;
    if (!task || !task.promise) {
      return undefined;
    }
    const branch = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const epochCompactionId = getEpochCompactionId(branch);
    if (
      task.sessionId !== sessionId ||
      task.epochCompactionId !== epochCompactionId ||
      getEntryIndex(branch, task.snapshotLeafId) < 0 ||
      !isSnapshotProjectionCompatible(branch, task.snapshotLeafId) ||
      (task.firstKeptEntryId !== undefined &&
        !isBeforeOrSame(branch, task.firstKeptEntryId, task.snapshotLeafId)) ||
      task.runEpoch !== this.runEpoch
    ) {
      if (task.runEpoch === this.runEpoch) {
        this.discardTask(task, "snapshot_projection_changed");
      }
      return undefined;
    }
    return task;
  }

  private remainingTaskTime(task: BackgroundTask): number {
    return Math.max(0, task.startedAt + task.config.taskTimeoutMs - Date.now());
  }

  private waitForTask(
    task: BackgroundTask,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WaitOutcome> {
    const promise = task.promise;
    if (!promise) {
      return Promise.resolve("finished");
    }
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise<WaitOutcome>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (outcome: WaitOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => finish("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish("timeout"), timeoutMs);
      void promise.then(
        () => finish("finished"),
        () => finish("finished"),
      );
    });
  }
}
