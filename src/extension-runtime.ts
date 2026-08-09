import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import {
  VERSION,
  compact,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { estimateCheckpointCapacity } from "./checkpoint/capacity.js";
import {
  findReadyCheckpointCandidates,
  getConsumedCheckpointIds,
  getEpochCompactionId,
  getEntryIndex,
  getSnapshotSourceLeafId,
  isBeforeOrSame,
} from "./checkpoint/selection.js";
import { isJsonObject, isUsage } from "./checkpoint/schema.js";
import { loadConfig, createSnapshotKey, configFingerprint, DEFAULT_CONFIG } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { buildCheckpointCompactionResult } from "./compaction/reuse.js";
import {
  createPreparationSettings,
  estimateMessagesTokens,
  prepareCompactionFromBranch,
} from "./compaction/preparation.js";
import { resolveProviderRequest } from "./provider/request.js";
import {
  CHECKPOINT_CUSTOM_TYPE,
  PREPARATION_ALGORITHM_VERSION,
  SUMMARY_FORMAT_VERSION,
  type CheckpointCandidate,
  type CheckpointData,
  type CompactionCapacityEstimate,
  type CompactionPreparation,
  type PiPressConfig,
} from "./types.js";

const RETRY_BASE_DELAY_MS = 250;
const MAX_REFRESHES_PER_EPOCH = 1;
const MAX_BACKGROUND_RETRIES = 1;

type SessionManager = ExtensionContext["sessionManager"];
type ModelRegistry = ExtensionContext["modelRegistry"];

type BackgroundTask = {
  id: string;
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
  estimatedTokensAfterAtSnapshot?: number;
  promise?: Promise<void>;
  discarded: boolean;
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
  return `checkpoint ${checkpointId}：预计压缩后 ${capacity.estimatedTokensAfter} tokens，接受上限 ${capacity.acceptLimit} tokens`;
}

function createCheckpointCandidate(data: CheckpointData): CheckpointCandidate {
  return {
    entry: {
      type: "custom",
      id: `pi-press-pending-${data.checkpointId}`,
      parentId: null,
      timestamp: data.createdAt,
      customType: CHECKPOINT_CUSTOM_TYPE,
      data,
    },
    data,
  };
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
  private claimedCheckpointId: string | undefined;
  private hookInFlight = false;
  private readonly attemptsBySnapshotKey = new Map<string, number>();
  private readonly refreshesByEpoch = new Map<string, number>();

  constructor(private readonly pi: Pick<ExtensionAPI, "appendEntry">, diagnostics = new Diagnostics()) {
    this.diagnostics = diagnostics;
  }

  getDiagnostics(): ReturnType<Diagnostics["snapshot"]> {
    return this.diagnostics.snapshot();
  }

  onSessionStart(ctx: ExtensionContext): void {
    this.invalidate("session_start", true);
    this.bindContext(ctx);
    this.loadCurrentConfig(ctx, true);
  }

  onSessionBeforeTree(): void {
    this.invalidate("session_before_tree", true);
  }

  onSessionTree(ctx: ExtensionContext): void {
    this.bindContext(ctx);
    this.loadCurrentConfig(ctx, true);
  }

  onSessionShutdown(): void {
    this.invalidate("session_shutdown", true);
  }

  onSessionCompact(event: SessionCompactEvent, ctx: ExtensionContext): void {
    const checkpointId = getCheckpointIdFromDetails(event.compactionEntry.details);
    if (checkpointId) {
      this.diagnostics.count("checkpoint_consumed");
      this.diagnostics.recordUsage("consumed", event.compactionEntry.usage);
      if (this.claimedCheckpointId === checkpointId) {
        this.claimedCheckpointId = undefined;
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
    const config = this.loadCurrentConfig(ctx, true);
    if (config.precomputeMode === "off") {
      return;
    }
    const usage = ctx.getContextUsage();
    if (
      !usage ||
      usage.tokens === null ||
      usage.percent === null ||
      !Number.isFinite(usage.tokens) ||
      !Number.isFinite(usage.percent)
    ) {
      this.diagnostics.count("threshold_skipped_unknown_usage");
      return;
    }
    if (usage.percent < config.softThresholdPercent) {
      return;
    }
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
    const snapshotKey = createSnapshotKey(
      sessionId,
      epochCompactionId,
      snapshotSourceLeafId,
      config,
    );
    if (this.inFlightTask) {
      return;
    }

    const candidates = findReadyCheckpointCandidates(
      branchEntries,
      sessionId,
      epochCompactionId,
      this.claimedCheckpointId,
    );
    const existingCandidate = candidates[0];
    const epochKey = `${sessionId}:${epochCompactionId ?? "null"}`;
    if (existingCandidate) {
      const refreshCount = this.refreshesByEpoch.get(epochKey) ?? 0;
      if (
        refreshCount >= MAX_REFRESHES_PER_EPOCH ||
        !this.shouldRefresh(existingCandidate, branchEntries, model, config)
      ) {
        return;
      }
      this.refreshesByEpoch.set(epochKey, refreshCount + 1);
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
    });
  }

  async beforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<{ compaction: CompactionResult } | undefined> {
    this.bindContext(ctx);
    const config = this.loadCurrentConfig(ctx, true);
    if (config.precomputeMode === "off" || !this.isSupportedCompaction(event, config)) {
      return undefined;
    }
    if (this.hookInFlight) {
      return undefined;
    }
    this.hookInFlight = true;
    try {
      let result = this.tryReuseCheckpoint(event, ctx, config);
      if (result) {
        return { compaction: result };
      }

      const task = this.findCompatibleTask(ctx);
      if (!task || config.hookWaitTimeoutMs <= 0) {
        return undefined;
      }
      const waitOutcome = await this.waitForTask(task, config.hookWaitTimeoutMs, event.signal);
      if (waitOutcome !== "finished") {
        this.discardTask(task, waitOutcome === "timeout" ? "hook_timeout" : "hook_aborted");
        return undefined;
      }
      if (event.signal.aborted) {
        return undefined;
      }
      result = this.tryReuseCheckpoint(event, ctx, config);
      return result ? { compaction: result } : undefined;
    } finally {
      this.hookInFlight = false;
    }
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

  private reportTaskFailure(message: string): void {
    const failure = describeError(message);
    this.diagnostics.count("task_failed");
    this.diagnostics.record("task", failure);
    this.notifyUser(`pi-press：后台预压缩失败：${failure}`, "error");
  }

  private notifyCheckpointReady(task: BackgroundTask): void {
    const elapsedSeconds = ((Date.now() - task.startedAt) / 1000).toFixed(1);
    const estimatedTokens = task.estimatedTokensAfterAtSnapshot;
    const tokenText = estimatedTokens === undefined
      ? "未知"
      : Math.round(estimatedTokens).toLocaleString("en-US");
    this.notifyUser(
      `pi-press：预压缩成功，耗时 ${elapsedSeconds} 秒，预计压缩后约 ${tokenText} tokens。`,
      "info",
    );
  }

  private loadCurrentConfig(ctx: ExtensionContext, cancelWhenOff: boolean): PiPressConfig {
    const result = loadConfig(ctx.cwd);
    this.currentConfig = result.config;
    for (const message of result.diagnostics) {
      this.diagnostics.record("config", message);
    }
    if (cancelWhenOff && result.config.precomputeMode === "off" && this.inFlightTask) {
      this.discardTask(this.inFlightTask, "config_off");
    }
    return result.config;
  }

  private invalidate(reason: string, clearContext: boolean): void {
    this.runEpoch += 1;
    if (this.inFlightTask) {
      this.discardTask(this.inFlightTask, reason);
    }
    this.claimedCheckpointId = undefined;
    this.attemptsBySnapshotKey.clear();
    this.refreshesByEpoch.clear();
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
      task.runEpoch === this.runEpoch &&
      this.currentSessionId === task.sessionId &&
      this.currentConfig.precomputeMode !== "off"
    );
  }

  private startBackgroundTask(
    input: Omit<BackgroundTask, "id" | "runEpoch" | "controller" | "startedAt" | "discarded">
  ): void {
    const task: BackgroundTask = {
      ...input,
      id: randomUUID(),
      runEpoch: this.runEpoch,
      controller: new AbortController(),
      startedAt: Date.now(),
      discarded: false,
    };
    this.inFlightTask = task;
    this.diagnostics.count("task_started");
    const promise = Promise.resolve().then(() => this.runBackgroundTask(task));
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

  private async runBackgroundTask(task: BackgroundTask): Promise<void> {
    try {
      if (!this.isCurrentTask(task)) {
        return;
      }
      const preparation = prepareCompactionFromBranch(
        task.branchEntries,
        createPreparationSettings(task.config),
      );
      if (!preparation) {
        this.diagnostics.count("task_skipped_no_preparation");
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
      const providerResult = await resolveProviderRequest(registry, task.model);
      if (!this.isCurrentTask(task)) {
        return;
      }
      if (!providerResult.ok) {
        this.diagnostics.count(`provider_${providerResult.failure.kind}_failure`);
        const failure = providerResult.failure.message || `provider ${providerResult.failure.kind} 不可用`;
        this.diagnostics.record("provider", failure);
        this.reportTaskFailure(failure);
        return;
      }

      const retry = {
        enabled: MAX_BACKGROUND_RETRIES > 0,
        maxRetries: MAX_BACKGROUND_RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
      };
      const result = await this.runWithTimeout(
        () => compact(
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
        ),
        task.controller,
        task.config.taskTimeoutMs,
      );
      if (!this.isCurrentTask(task)) {
        this.diagnostics.recordUsage("discarded", result.usage);
        return;
      }
      const appendOutcome = this.appendCheckpoint(task, preparation, result);
      if (appendOutcome !== "appended") {
        this.diagnostics.recordUsage("discarded", result.usage);
        if (appendOutcome === "failed" && this.isCurrentTask(task)) {
          this.reportTaskFailure("压缩结果未通过 checkpoint 校验或追加失败");
        }
        return;
      }
      this.diagnostics.count("checkpoint_ready");
      this.notifyCheckpointReady(task);
    } catch (error: unknown) {
      if (task.discarded || task.controller.signal.aborted || isAbortLike(error)) {
        this.diagnostics.count("task_cancelled");
        return;
      }
      this.reportTaskFailure(describeError(error));
    }
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
    controller: AbortController,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error("Pi-press background task timed out");
        error.name = "TimeoutError";
        reject(error);
      }, timeoutMs);
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
    const candidateData: CheckpointData = {
      version: 3,
      piVersion: VERSION,
      algorithmVersion: PREPARATION_ALGORITHM_VERSION,
      summaryFormatVersion: SUMMARY_FORMAT_VERSION,
      checkpointId: randomUUID(),
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
          provider: task.model.provider,
          id: task.model.id,
          api: task.model.api,
          baseUrl: task.model.baseUrl,
          contextWindow: task.model.contextWindow,
          maxTokens: task.model.maxTokens,
        },
        thinkingLevel: task.thinkingLevel,
        configFingerprint: configFingerprint(task.config),
      },
      createdAt: new Date().toISOString(),
    };
    const candidate = createCheckpointCandidate(candidateData);
    const capacity = estimateCheckpointCapacity(
      task.branchEntries,
      candidate,
      preparation,
      contextWindow,
      task.config.targetPostCompactionPercent,
    );
    if (!capacity) {
      this.diagnostics.count("checkpoint_skipped_capacity_unavailable");
      return "skipped";
    }
    if (!capacity.accepted) {
      this.diagnostics.count("checkpoint_skipped_capacity");
      this.diagnostics.record("capacity", describeCapacityRejection(candidateData.checkpointId, capacity));
      return "skipped";
    }
    candidateData.estimatedTokensAfterAtSnapshot = capacity.estimatedTokensAfter;
    task.estimatedTokensAfterAtSnapshot = capacity.estimatedTokensAfter;

    try {
      this.pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, candidateData);
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
    const trailingMessages = branch
      .slice(snapshotIndex + 1)
      .flatMap((entry) => sessionEntryToContextMessages(entry));
    const trailingTokens = estimateMessagesTokens(trailingMessages);
    const targetLimit = Math.floor(model.contextWindow * config.targetPostCompactionPercent / 100);
    return candidate.data.estimatedTokensAfterAtSnapshot + trailingTokens > targetLimit;
  }

  private isSupportedCompaction(event: SessionBeforeCompactEvent, config: PiPressConfig): boolean {
    if (event.willRetry || event.reason === "overflow") {
      return false;
    }
    if (event.customInstructions !== undefined && event.customInstructions.trim().length > 0) {
      return false;
    }
    if (event.reason === "threshold") {
      return config.precomputeMode !== "off";
    }
    return config.precomputeMode === "threshold-and-manual";
  }

  private tryReuseCheckpoint(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    config: PiPressConfig,
  ): CompactionResult | undefined {
    if (event.signal.aborted) {
      return undefined;
    }
    const branch = ctx.sessionManager.getBranch();
    const sessionId = ctx.sessionManager.getSessionId();
    const epochCompactionId = getEpochCompactionId(branch);
    if (this.claimedCheckpointId) {
      if (!getConsumedCheckpointIds(branch).has(this.claimedCheckpointId)) {
        this.claimedCheckpointId = undefined;
      }
    }
    const candidates = findReadyCheckpointCandidates(
      branch,
      sessionId,
      epochCompactionId,
      this.claimedCheckpointId,
    );
    const model = asModel(ctx.model);
    if (!model) {
      this.diagnostics.count("reuse_skipped_unknown_model");
      return undefined;
    }
    for (const candidate of candidates) {
      const capacity = estimateCheckpointCapacity(
        branch,
        candidate,
        event.preparation,
        model.contextWindow,
        config.targetPostCompactionPercent,
      );
      if (!capacity) {
        this.diagnostics.count("checkpoint_rejected_capacity_unavailable");
        continue;
      }
      if (!capacity.accepted) {
        this.diagnostics.count("checkpoint_rejected_capacity");
        this.diagnostics.record("capacity", describeCapacityRejection(candidate.data.checkpointId, capacity));
        continue;
      }
      this.claimedCheckpointId = candidate.data.checkpointId;
      if (this.inFlightTask && this.inFlightTask.epochCompactionId === epochCompactionId) {
        this.discardTask(this.inFlightTask, "checkpoint_reused");
      }
      this.diagnostics.count("checkpoint_reused");
      return buildCheckpointCompactionResult(candidate, event.preparation);
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
