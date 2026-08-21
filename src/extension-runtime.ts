import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  VERSION,
  compact,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ContextEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { estimateCheckpointCapacity } from "./checkpoint/capacity.js";
import {
  findReadyCheckpointCandidates,
  getEpochCompactionId,
  getEntryIndex,
  getSnapshotSourceLeafId,
  isBeforeOrSame,
} from "./checkpoint/selection.js";
import { isJsonObject, isUsage, parseCheckpointData } from "./checkpoint/schema.js";
import {
  loadConfig,
  loadPiCompactionKeepRecentTokens,
  createSnapshotKey,
  configFingerprint,
  DEFAULT_CONFIG,
} from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { buildCheckpointCompactionResult } from "./compaction/reuse.js";
import {
  tryProjectCheckpointToVirtualContext,
  VirtualContextProjectionCache,
} from "./compaction/virtual-context.js";
import {
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

type BackgroundTask = {
  sessionId: string;
  runEpoch: number;
  snapshotLeafId: string;
  snapshotSourceLeafId: string;
  epochCompactionId: string | null;
  snapshotKey: string;
  branchEntries: SessionEntry[];
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  config: PiPressConfig;
  controller: AbortController;
  startedAt: number;
  firstKeptEntryId?: string;
  parentCheckpoint?: CheckpointData;
  promise?: Promise<void>;
  discarded: boolean;
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
  lastAppliedLeafId: string;
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
};

type DeferredFormalization = {
  checkpointId: string;
  sessionId: string;
  epochCompactionId: string | null;
  checkedLeafId: string;
};

type WaitOutcome = "finished" | "timeout" | "aborted";
type CheckpointAppendOutcome = "appended" | "skipped" | "failed";
type NotificationType = "info" | "warning" | "error";
type Notify = (message: string, type?: NotificationType) => void;

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
  const normalized = message.trim() || "未知错误";
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}...`;
}

function describeCapacityRejection(checkpointId: string, capacity: CompactionCapacityEstimate): string {
  return `checkpoint ${checkpointId}：预计压缩后 ${capacity.estimatedTokensAfter} tokens，hard limit ${capacity.hardLimit} tokens`;
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

/** 管理单个扩展实例的 session 状态、后台摘要任务和 checkpoint 复用。 */
export class ExtensionRuntime {
  private readonly diagnostics: Diagnostics;
  private currentSessionManager: SessionManager | undefined;
  private currentModelRegistry: ModelRegistry | undefined;
  private currentSessionId: string | undefined;
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
  private virtualApplication: VirtualApplication | undefined;
  private formalizationSchedule: FormalizationSchedule | undefined;
  private pendingFormalization: PendingFormalization | undefined;
  private deferredFormalization: DeferredFormalization | undefined;
  private readonly virtualContextCache = new VirtualContextProjectionCache();

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">, diagnostics = new Diagnostics()) {
    this.diagnostics = diagnostics;
  }

  getDiagnostics(): ReturnType<Diagnostics["snapshot"]> {
    return this.diagnostics.snapshot();
  }

  onSessionStart(ctx: ExtensionContext): void {
    this.invalidate("session_start", true);
    this.bindContext(ctx);
    this.loadCurrentConfig(ctx);
  }

  onSessionBeforeTree(): void {
    this.invalidate("session_before_tree", true);
  }

  onSessionTree(ctx: ExtensionContext): void {
    this.bindContext(ctx);
    this.loadCurrentConfig(ctx);
  }

  onSessionShutdown(): void {
    this.invalidate("session_shutdown", true);
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

  private handleVirtualContextError(
    event: ContextEvent,
    error: unknown,
  ): Pick<ContextEvent, "messages"> {
    this.diagnostics.count("virtual_failed");
    this.diagnostics.record(
      "checkpoint",
      `虚拟上下文处理失败：${describeError(error)}`,
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
        getEntryIndex(branch, this.virtualApplication.lastAppliedLeafId) < 0)
    ) {
      this.virtualApplication = undefined;
      this.deferredFormalization = undefined;
    }

    let hardLimitExceeded = false;
    for (const candidate of candidates) {
      const attempt = tryProjectCheckpointToVirtualContext({
        branch,
        eventMessages: event.messages,
        checkpoint: candidate.data,
        contextWindow: model.contextWindow,
        summaryReserveTokens: this.currentConfig.summaryReserveTokens,
        softThresholdPercent: this.currentConfig.softThresholdPercent,
        cache: this.virtualContextCache,
      });
      if (attempt.status === "hard-limit") {
        hardLimitExceeded = true;
        continue;
      }
      if (attempt.status === "unavailable") {
        continue;
      }
      const projection = attempt.projection;
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
      const previousApplication = this.virtualApplication;
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
        lastAppliedLeafId: leafId,
        refreshRequested,
      };
      this.diagnostics.count("virtual_applied");
      if (projection.needsRefresh) {
        this.diagnostics.count("virtual_refresh_needed");
      }
      return { messages: projection.messages };
    }

    if (hardLimitExceeded && allowWait && this.currentConfig.hookWaitTimeoutMs > 0) {
      const task = this.findCompatibleTask(ctx);
      if (task) {
        return this.waitForVirtualRefresh(
          event,
          ctx,
          task,
          this.currentConfig.hookWaitTimeoutMs,
        );
      }
    }
    if (hardLimitExceeded) {
      this.diagnostics.count("virtual_skipped_hard_limit");
    }
    this.diagnostics.count("virtual_skipped");
    return { messages: event.messages };
  }

  private async waitForVirtualRefresh(
    event: ContextEvent,
    ctx: ExtensionContext,
    task: BackgroundTask,
    timeoutMs: number,
  ): Promise<Pick<ContextEvent, "messages">> {
    const waitOutcome = await this.waitForTask(
      task,
      timeoutMs,
      new AbortController().signal,
    );
    if (
      waitOutcome === "timeout" ||
      task.runEpoch !== this.runEpoch ||
      task.sessionId !== this.currentSessionId
    ) {
      if (waitOutcome === "timeout") {
        this.diagnostics.count("virtual_refresh_wait_timed_out");
        this.diagnostics.record(
          "capacity",
          "虚拟上下文超过 hard limit，等待后台刷新超时。",
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

    const epochKey = this.formalizationEpochKey(sessionId, epochCompactionId);
    if ((this.formalizationAttemptsByEpoch.get(epochKey) ?? 0) >= MAX_FORMALIZATION_ATTEMPTS) {
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
      this.diagnostics.count("checkpoint_consumed");
      this.diagnostics.recordUsage("consumed", event.compactionEntry.usage);
      if (this.checkpointClaim?.checkpointId === checkpointId) {
        this.releaseCheckpointClaim(checkpointId);
      }
    }
    this.invalidate("session_compact", false);
    this.bindContext(ctx);
    if (this.currentConfig.precomputeMode !== "off") {
      this.notifyUser(
        checkpointId
          ? "pi-press：压缩成功，已复用预压缩结果。"
          : "pi-press：压缩成功，使用 Pi 原生流程。",
        "info",
      );
    }
  }

  onTurnEnd(ctx: ExtensionContext): void {
    this.bindContext(ctx);
    const config = this.loadCurrentConfig(ctx);
    if (config.precomputeMode === "off") {
      return;
    }
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
      return;
    }

    const branchEntries = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const snapshotLeafId = ctx.sessionManager.getLeafId();
    const snapshotSourceLeafId = getSnapshotSourceLeafId(branchEntries);
    if (!snapshotLeafId || !snapshotSourceLeafId) {
      this.diagnostics.count("threshold_skipped_empty_branch");
      return;
    }
    const epochCompactionId = getEpochCompactionId(branchEntries);
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
      (virtualRefreshRequested || this.shouldRefresh(virtualCandidate, branchEntries, model, config)),
    );
    if (!virtualRefreshNeeded) {
      if (!usageKnown) {
        this.diagnostics.count("threshold_skipped_unknown_usage");
        return;
      }
      if (usage!.percent! < config.softThresholdPercent) {
        return;
      }
    }

    const snapshotKey = createSnapshotKey(
      sessionId,
      epochCompactionId,
      snapshotSourceLeafId,
      config,
    );
    if (this.inFlightTask || sharedRuntimeState.activeBackgroundOperation) {
      return;
    }

    const existingCandidate = candidates[0];
    const existingRefreshRequested = Boolean(
      existingCandidate &&
      virtualRefreshRequested &&
      virtualCandidate?.data.checkpointId === existingCandidate.data.checkpointId,
    );
    if (
      existingCandidate &&
      !existingRefreshRequested &&
      !this.shouldRefresh(existingCandidate, branchEntries, model, config)
    ) {
      return;
    }

    const attempts = this.attemptsBySnapshotKey.get(snapshotKey) ?? 0;
    if (attempts > MAX_BACKGROUND_RETRIES) {
      return;
    }
    this.attemptsBySnapshotKey.set(snapshotKey, attempts + 1);
    this.startBackgroundTask({
      sessionId,
      snapshotLeafId,
      snapshotSourceLeafId,
      epochCompactionId,
      snapshotKey,
      branchEntries: [...branchEntries],
      model,
      thinkingLevel: ctx.thinkingLevel ?? "medium",
      config,
      ...(existingCandidate === undefined ? {} : { parentCheckpoint: existingCandidate.data }),
    });
    if (
      existingCandidate &&
      this.virtualApplication?.checkpointId === existingCandidate.data.checkpointId
    ) {
      this.virtualApplication.refreshRequested = false;
    }
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
    const internalCheckpointId = internalFormalization
      ? this.pendingFormalization?.checkpointId
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
            this.diagnostics.record("capacity", "overflow 等待增量 checkpoint 超时，交由 Pi 原生压缩处理。");
          } else {
            this.diagnostics.count("hook_wait_timed_out");
            this.notifyWarning("正式压缩等待预压缩结果超时，已取消后台任务并回退 Pi 原生压缩。");
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
      this.diagnostics.record("lifecycle", `无法读取 agent 空闲状态：${describeError(error)}`);
      return false;
    }
  }

  private isPrecomputeDisabled(): boolean {
    return this.currentConfig.precomputeMode === "off";
  }

  private formalizationEpochKey(sessionId: string, epochCompactionId: string | null): string {
    return `${sessionId}:${epochCompactionId ?? "null"}`;
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
    const preparation = prepareCompactionFromBranch(
      branch,
      createFormalizationPreparationSettings(
        this.currentConfig,
        loadPiCompactionKeepRecentTokens(ctx.cwd, ctx.isProjectTrusted()),
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
      this.diagnostics.record("lifecycle", "当前分支尚未达到 Pi 正式压缩边界，正式化已延期。");
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
    if (this.pendingFormalization?.requestId !== pending.requestId) {
      return;
    }
    this.releaseCheckpointClaim(pending.checkpointId);
    this.pendingFormalization = undefined;
    if (isSessionTooSmallError(error)) {
      this.deferredFormalization = {
        checkpointId: pending.checkpointId,
        sessionId: pending.sessionId,
        epochCompactionId: pending.epochCompactionId,
        checkedLeafId: pending.scheduledLeafId,
      };
      this.diagnostics.count("formalization_deferred");
      this.diagnostics.record("lifecycle", "Pi 未找到可压缩内容，正式化已延期。");
      return;
    }

    const epochKey = this.formalizationEpochKey(pending.sessionId, pending.epochCompactionId);
    const failureCount = (this.formalizationAttemptsByEpoch.get(epochKey) ?? 0) + 1;
    this.formalizationAttemptsByEpoch.set(epochKey, failureCount);
    this.diagnostics.count("formalization_failed");
    this.diagnostics.record("lifecycle", `正式化失败：${describeError(error)}`);
    this.notifyWarning("虚拟压缩正式化失败，后续 settled 状态最多再试一次。");
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
  }

  private bindContext(ctx: ExtensionContext): void {
    this.currentSessionManager = ctx.sessionManager;
    this.currentModelRegistry = ctx.modelRegistry;
    this.currentSessionId = ctx.sessionManager.getSessionId();
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
      this.diagnostics.record("lifecycle", `无法显示 CLI 通知：${describeError(error)}`);
    }
  }

  private notifyWarning(message: string): void {
    this.notifyUser(`pi-press：${message}`, "warning");
  }

  private reportTaskFailure(message: string): void {
    const failure = describeError(message);
    this.diagnostics.count("task_failed");
    this.diagnostics.record("task", failure);
    this.notifyUser(`pi-press：后台预压缩失败：${failure}`, "error");
  }

  private notifyCheckpointReady(task: BackgroundTask): void {
    const elapsedSeconds = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    this.notifyUser(
      `pi-press：预压缩成功，耗时 ${elapsedSeconds} 秒。`,
      "info",
    );
  }

  private loadCurrentConfig(ctx: ExtensionContext): PiPressConfig {
    const result = loadConfig(ctx.cwd);
    this.currentConfig = result.config;
    for (const message of result.diagnostics) {
      const removedTargetPercent = message.includes("targetPostCompactionPercent");
      if (
        this.reportedConfigDiagnostics.has(message) ||
        (removedTargetPercent && this.removedTargetPercentReported)
      ) {
        continue;
      }
      this.reportedConfigDiagnostics.add(message);
      if (removedTargetPercent) {
        this.removedTargetPercentReported = true;
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
  }

  private releaseCheckpointClaim(checkpointId?: string): void {
    const claim = this.checkpointClaim;
    if (!claim || (checkpointId !== undefined && claim.checkpointId !== checkpointId)) {
      return;
    }
    claim.signal.removeEventListener("abort", claim.abortHandler);
    this.checkpointClaim = undefined;
  }

  private invalidate(reason: string, clearContext: boolean): void {
    this.runEpoch += 1;
    if (this.inFlightTask) {
      this.discardTask(this.inFlightTask, reason);
    }
    this.releaseCheckpointClaim();
    this.clearVirtualState();
    this.attemptsBySnapshotKey.clear();
    this.formalizationAttemptsByEpoch.clear();
    this.virtualContextCache.clear();
    if (clearContext) {
      this.currentSessionManager = undefined;
      this.currentModelRegistry = undefined;
      this.currentSessionId = undefined;
      this.currentNotify = undefined;
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

  private startBackgroundTask(
    input: Omit<BackgroundTask, "runEpoch" | "controller" | "startedAt" | "discarded">
  ): void {
    if (sharedRuntimeState.activeBackgroundOperation) {
      return;
    }
    const task: BackgroundTask = {
      ...input,
      runEpoch: this.runEpoch,
      controller: new AbortController(),
      startedAt: Date.now(),
      discarded: false,
    };
    this.inFlightTask = task;
    this.diagnostics.count("task_started");
    const operation = Promise.resolve().then(() => this.generateCheckpoint(task));
    sharedRuntimeState.activeBackgroundOperation = operation;
    const releaseOperation = (): void => {
      if (sharedRuntimeState.activeBackgroundOperation === operation) {
        delete sharedRuntimeState.activeBackgroundOperation;
      }
    };
    void operation.then(releaseOperation, releaseOperation);
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
  }

  private async runBackgroundTask(
    task: BackgroundTask,
    operation: Promise<void>,
  ): Promise<void> {
    try {
      await this.runWithTimeout(() => operation, task);
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        this.diagnostics.count("task_timed_out");
        this.reportTaskFailure("后台预压缩超时");
        return;
      }
      if (task.discarded || task.controller.signal.aborted || isAbortLike(error)) {
        this.diagnostics.count("task_cancelled");
        return;
      }
      this.reportTaskFailure("后台预压缩执行失败");
    }
  }

  private async generateCheckpoint(task: BackgroundTask): Promise<void> {
    if (!this.isCurrentTask(task)) {
      return;
    }
    const preparation = prepareCompactionFromBranch(
      task.branchEntries,
      createCheckpointPreparationSettings(task.config),
      task.parentCheckpoint,
    );
    if (!preparation) {
      const message = "当前分支无法构造可用 preparation";
      this.diagnostics.count("task_skipped_no_preparation");
      this.diagnostics.record("task", message);
      return;
    }
    task.firstKeptEntryId = preparation.firstKeptEntryId;
    if (!this.isCurrentTask(task)) {
      return;
    }

    const registry = this.currentModelRegistry;
    if (!registry) {
      this.diagnostics.count("task_skipped_missing_registry");
      this.reportTaskFailure("缺少当前模型的 provider 注册表");
      return;
    }
    const providerResult = await resolveProviderRequest(
      registry,
      task.model,
      task.controller.signal,
    );
    if (!this.isCurrentTask(task)) {
      return;
    }
    if (!providerResult.ok) {
      this.diagnostics.count(`provider_${providerResult.failure.kind}_failure`);
      const failure = providerResult.failure.kind === "auth"
        ? "活动模型认证不可用"
        : "活动模型 provider 不可用";
      this.diagnostics.record("provider", failure);
      this.reportTaskFailure(failure);
      return;
    }

    const retry = {
      enabled: MAX_BACKGROUND_RETRIES > 0,
      maxRetries: MAX_BACKGROUND_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
    };
    const request = Promise.resolve().then(() => compact(
      preparation,
      providerResult.request.model,
      providerResult.request.apiKey,
      providerResult.request.headers,
      undefined,
      task.controller.signal,
      task.thinkingLevel,
      providerResult.request.streamFn,
      providerResult.request.env,
      retry,
    ));
    const result = await request;
    if (!this.isCurrentTask(task)) {
      this.diagnostics.recordUsage("discarded", result.usage);
      return;
    }
    const appendOutcome = this.appendCheckpoint(
      task,
      preparation,
      result,
      providerResult.request.model,
    );
    if (appendOutcome !== "appended") {
      this.diagnostics.recordUsage("discarded", result.usage);
      if (appendOutcome === "failed" && this.isCurrentTask(task)) {
        this.reportTaskFailure("压缩结果未通过 checkpoint 校验或追加失败");
      }
      return;
    }
    this.diagnostics.count("checkpoint_ready");
    this.notifyCheckpointReady(task);
  }

  private finishTask(task: BackgroundTask): void {
    if (this.inFlightTask === task) {
      this.inFlightTask = undefined;
    }
  }

  private discardTask(task: BackgroundTask, reason: string): void {
    if (this.inFlightTask === task) {
      this.inFlightTask = undefined;
    }
    if (!task.discarded) {
      task.discarded = true;
      this.diagnostics.count("task_discarded");
      this.diagnostics.record("lifecycle", reason);
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
        `checkpoint ${candidateData.checkpointId}：无法计算预计压缩后容量`,
      );
      this.notifyWarning(
        `后台预压缩容量无法计算，未持久化 checkpoint ${candidateData.checkpointId}。`,
      );
      return "skipped";
    }
    if (!capacity.accepted) {
      const message = describeCapacityRejection(candidateData.checkpointId, capacity);
      this.diagnostics.count("checkpoint_skipped_capacity");
      this.diagnostics.record("capacity", message);
      this.notifyWarning(`后台预压缩容量不足，未持久化结果：${message}。`);
      return "skipped";
    }
    candidateData.estimatedTokensAfterAtSnapshot = capacity.estimatedTokensAfter;
    const checkpointData = parseCheckpointData(candidateData, { piVersion: VERSION });
    if (!checkpointData) {
      this.diagnostics.count("checkpoint_invalid_result");
      return "failed";
    }

    try {
      this.pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, checkpointData);
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
  ): boolean {
    const snapshotIndex = getEntryIndex(branch, candidate.data.snapshotLeafId);
    if (snapshotIndex < 0) {
      return true;
    }
    const trailingTokens = this.virtualContextCache.estimateTokensAfter(branch, snapshotIndex) ??
      estimateMessagesTokens(
        branch
          .slice(snapshotIndex + 1)
          .flatMap((entry) => sessionEntryToContextMessages(entry)),
      );
    const refreshLimit = Math.floor(model.contextWindow * config.softThresholdPercent / 100);
    return candidate.data.estimatedTokensAfterAtSnapshot + trailingTokens >= refreshLimit;
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
      const capacity = estimateCheckpointCapacity(
        branch,
        candidate.data,
        event.preparation,
        model.contextWindow,
      );
      if (!capacity) {
        this.diagnostics.count("checkpoint_rejected_capacity_unavailable");
        this.diagnostics.record(
          "capacity",
          `checkpoint ${candidate.data.checkpointId}：无法计算预计压缩后容量`,
        );
        this.notifyWarning(
          `checkpoint ${candidate.data.checkpointId} 容量无法计算，已回退 Pi 原生压缩。`,
        );
        continue;
      }
      if (!capacity.accepted) {
        const message = describeCapacityRejection(candidate.data.checkpointId, capacity);
        this.diagnostics.count("checkpoint_rejected_capacity");
        this.diagnostics.record("capacity", message);
        this.notifyWarning(`checkpoint 容量不足，已回退 Pi 原生压缩：${message}。`);
        continue;
      }
      const result = buildCheckpointCompactionResult(candidate, event.preparation);
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
      (task.firstKeptEntryId !== undefined &&
        !isBeforeOrSame(branch, task.firstKeptEntryId, task.snapshotLeafId)) ||
      task.runEpoch !== this.runEpoch
    ) {
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
