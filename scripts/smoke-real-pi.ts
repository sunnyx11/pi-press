import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type {
  SessionEntry,
  SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";

interface ResolveSystemPiOptions {
  projectRoot: string;
  pathValue: string;
  explicitPi?: string;
}

interface PiSdk {
  SessionManager: typeof SessionManagerType;
  estimateTokens: typeof import("@earendil-works/pi-coding-agent").estimateTokens;
  sessionEntryToContextMessages:
    typeof import("@earendil-works/pi-coding-agent").sessionEntryToContextMessages;
}

interface CheckpointData {
  checkpointId: string;
  parentCheckpointId?: string;
  snapshotLeafId: string;
  provenance: { thinkingLevel: string };
  compaction: {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
  };
}

interface TurnTelemetry {
  turn: number;
  realUsageTotalTokens: number;
  piEstimateTokens: number;
}

interface SmokeResult {
  piExecutable: string;
  piVersion: string;
  model: string;
  checkpointId: string;
  checkpointTokensBefore: number;
  tailTokens: number;
  expectedTokensBefore: number;
  actualTokensBefore: number;
  summaryThinkingLevel: string;
  growthMetrics?: {
    windowTokens: number;
    reserveTokens: number;
    softLimit: number;
    hardLimit: number;
    checkpointGenerations: number;
    foregroundWaitObserved: boolean;
    foregroundWaitStatuses: string[];
    foregroundWaitElapsedMs: number;
    turnTelemetry: TurnTelemetry[];
    outcome: "recovered_and_formalized";
  };
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionPath = join(projectRoot, "src", "index.ts");
const executableName = process.platform === "win32" ? "pi.cmd" : "pi";

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(resolve(parent), resolve(child));
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function resolveExecutable(candidate: string): string | undefined {
  try {
    accessSync(candidate, constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/** 解析当前环境中的 Pi，并排除 npm 注入的仓库本地可执行文件。 */
export function resolveSystemPi(options: ResolveSystemPiOptions): string {
  const localModules = join(resolve(options.projectRoot), "node_modules");
  if (options.explicitPi) {
    const explicitPath = resolve(options.explicitPi);
    const explicit = resolveExecutable(explicitPath);
    if (!explicit) {
      throw new Error(`PI_BIN 不可执行：${options.explicitPi}`);
    }
    if (isWithin(localModules, explicitPath) || isWithin(localModules, explicit)) {
      throw new Error(`PI_BIN 禁止指向仓库 node_modules：${options.explicitPi}`);
    }
    return explicit;
  }

  for (const directory of options.pathValue.split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = resolve(directory, executableName);
    if (isWithin(localModules, candidate)) {
      continue;
    }
    const executable = resolveExecutable(candidate);
    if (executable && !isWithin(localModules, executable)) {
      return executable;
    }
  }

  throw new Error("当前环境中没有仓库外部的 Pi 可执行文件；请安装 Pi 或设置 PI_BIN");
}

function readPiVersion(piExecutable: string): string {
  const launch = resolvePiLaunch(piExecutable);
  const result = spawnSync(launch.command, [...launch.args, "--version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Pi 版本读取失败：${result.stderr.trim() || `退出码 ${result.status}`}`);
  }
  const version = result.stdout.trim();
  if (!version) {
    throw new Error("Pi 未返回版本号");
  }
  return version;
}

function findPiPackageRoot(piExecutable: string): string {
  let current = dirname(realpathSync(piExecutable));
  while (true) {
    for (const candidate of [current, join(current, "node_modules", "@earendil-works", "pi-coding-agent")]) {
      let parsed: { name?: unknown };
      try {
        parsed = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: unknown };
      } catch {
        // 检查下一处 npm 包位置。
        continue;
      }
      if (parsed.name === "@earendil-works/pi-coding-agent") {
        const packageRoot = realpathSync(candidate);
        if (isWithin(join(projectRoot, "node_modules"), packageRoot)) {
          throw new Error("真实 Pi 禁止使用仓库 node_modules 中的 SDK");
        }
        return packageRoot;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`无法从 Pi 可执行文件定位 @earendil-works/pi-coding-agent：${piExecutable}`);
}

/** Windows npm shim 使用同一外部安装包声明的 CLI 入口。 */
export function resolvePiLaunch(piExecutable: string): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(piExecutable)) {
    return { command: piExecutable, args: [] };
  }
  const packageRoot = findPiPackageRoot(piExecutable);
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin?: { pi?: unknown };
  };
  if (typeof metadata.bin?.pi !== "string") {
    throw new Error(`外部 Pi 包没有声明 pi CLI：${packageRoot}`);
  }
  const entrypoint = realpathSync(join(packageRoot, metadata.bin.pi));
  if (!isWithin(packageRoot, entrypoint)) {
    throw new Error(`Pi CLI 位于安装包之外：${entrypoint}`);
  }
  return { command: process.execPath, args: [entrypoint] };
}

async function loadPiSdk(piExecutable: string): Promise<PiSdk> {
  const packageRoot = findPiPackageRoot(piExecutable);
  const moduleUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
  return await import(moduleUrl) as PiSdk;
}

export function createSmokeSession(
  cwd: string,
  SessionManager: PiSdk["SessionManager"],
  splitTurn = false,
): string {
  const sessionDirectory = join(cwd, "sessions");
  mkdirSync(sessionDirectory, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDirectory);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: splitTurn
      ? Array.from({ length: 3_500 }, (_, index) =>
        `Deployment record ${index}: service api-${index}, version v2, owner platform, rollback restores v1, validation checks health and logs.\n`,
      ).join("")
      : "Previously discussed deployment details." }],
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The deployment details were recorded." }],
    api: "anthropic-messages",
    provider: "pi-press-smoke",
    model: "seed",
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 110,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  if (splitTurn) {
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: Array.from({ length: 1_000 }, (_, index) =>
        `Current deployment request ${index}: review service api-${index}, verify health before rollout, retain rollback notes and report status.\n`,
      ).join("") }],
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Preserved deployment progress: health checks passed; rollback notes remain available.\n".repeat(600) }],
      api: "anthropic-messages",
      provider: "pi-press-smoke",
      model: "seed",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Pi 未创建冒烟测试 session 文件");
  }
  return sessionFile;
}

const GROWTH_WINDOW_TOKENS = 100_000;
const GROWTH_RESERVE_TOKENS = 10_000;
const GROWTH_SOFT_PERCENT = 60;
const GROWTH_SAFETY_MARGIN = Math.max(4_096, Math.ceil(GROWTH_WINDOW_TOKENS * 0.02));
const GROWTH_HARD_LIMIT = Math.min(
  Math.floor(GROWTH_WINDOW_TOKENS * 0.85),
  GROWTH_WINDOW_TOKENS - GROWTH_RESERVE_TOKENS - GROWTH_SAFETY_MARGIN,
);
const GROWTH_SOFT_LIMIT = Math.min(
  Math.floor((GROWTH_WINDOW_TOKENS * GROWTH_SOFT_PERCENT) / 100),
  GROWTH_HARD_LIMIT,
);

function buildChineseLogChunk(prefix: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) =>
    `${prefix}第${index + 1}条：集群巡检与容量治理记录，网关延迟正常，存储副本健康，回滚预案已核验通过。`,
  ).join("\n");
}

function buildBurstLogChunk(prefix: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) =>
    `${prefix}#${index + 1} [service=api-gateway-${index} status=healthy latency=12ms replica=ok]`,
  ).join("\n");
}

/** 创建包含连续中文工具结果的增长冒烟测试会话。 */
export function createGrowthSmokeSession(
  cwd: string,
  SessionManager: PiSdk["SessionManager"],
): string {
  const sessionDirectory = join(cwd, "sessions");
  mkdirSync(sessionDirectory, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDirectory);
  const baseTime = Date.now();
  for (let batch = 1; batch <= 2; batch += 1) {
    const toolCallId = `call_cn_${batch}`;
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: `请读取第 ${batch} 批中文集群巡检日志并确认状态。` }],
      timestamp: baseTime + batch * 10,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: toolCallId,
        name: "read_cn_log",
        arguments: { batch },
      }],
      api: "openai-responses",
      provider: "pi-press-smoke",
      model: "seed",
      usage: {
        input: 1_000,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_040,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: baseTime + batch * 10 + 1,
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName: "read_cn_log",
      content: [{ type: "text", text: buildChineseLogChunk(`批次${batch}日志`, 550) }],
      isError: false,
      timestamp: baseTime + batch * 10 + 2,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `第 ${batch} 批中文集群巡检日志已归档。` }],
      api: "openai-responses",
      provider: "pi-press-smoke",
      model: "seed",
      usage: {
        input: 15_000 * batch,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15_000 * batch + 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: baseTime + batch * 10 + 3,
    });
  }
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Pi 未创建增长冒烟测试 session 文件");
  }
  return sessionFile;
}

function createGrowthHelperExtension(cwd: string): string {
  const helperPath = join(cwd, "growth-window-helper.ts");
  writeFileSync(
    helperPath,
    [
      "export default function growthWindowHelper(pi) {",
      "  const applyWindow = (_event, ctx) => {",
      `    if (ctx.model) { ctx.model.contextWindow = ${GROWTH_WINDOW_TOKENS}; }`,
      "  };",
      '  pi.on("session_start", applyWindow);',
      '  pi.on("before_agent_start", applyWindow);',
      '  pi.on("turn_start", applyWindow);',
      '  pi.on("context", applyWindow);',
      '  pi.on("turn_end", applyWindow);',
      "}",
      "",
    ].join("\n"),
  );
  return helperPath;
}

function createGrowthSmokeConfig(cwd: string, summaryThinkingLevel: string): void {
  const configDirectory = join(cwd, ".pi");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "pi-press.json"),
    JSON.stringify({
      precomputeMode: "threshold",
      softThresholdPercent: GROWTH_SOFT_PERCENT,
      summaryThinkingLevel,
      taskTimeoutMs: 300_000,
      hookWaitTimeoutMs: 90_000,
    }, null, 2),
  );
  writeFileSync(
    join(configDirectory, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: GROWTH_RESERVE_TOKENS,
        keepRecentTokens: 10_000,
      },
    }, null, 2),
  );
}

function createSmokeConfig(cwd: string, splitTurn: boolean, summaryThinkingLevel: string): void {
  const configDirectory = join(cwd, ".pi");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "pi-press.json"),
    JSON.stringify({
      precomputeMode: "threshold",
      softThresholdPercent: 0,
      summaryThinkingLevel,
      taskTimeoutMs: 300_000,
      hookWaitTimeoutMs: 5_000,
    }, null, 2),
  );
  writeFileSync(
    join(configDirectory, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: splitTurn ? 16_384 : 1024,
        keepRecentTokens: splitTurn ? 10_000 : 0,
      },
    }, null, 2),
  );
}

function isCheckpointData(value: unknown): value is CheckpointData {
  if (!value || typeof value !== "object") {
    return false;
  }
  const data = value as Partial<CheckpointData>;
  return typeof data.checkpointId === "string" &&
    typeof data.snapshotLeafId === "string" &&
    Boolean(data.compaction) &&
    typeof data.compaction?.tokensBefore === "number";
}

function getPiPressCheckpointId(entry: SessionEntry): string | undefined {
  if (entry.type !== "compaction" || !entry.details || typeof entry.details !== "object") {
    return undefined;
  }
  const piPress = (entry.details as { piPress?: unknown }).piPress;
  if (!piPress || typeof piPress !== "object") {
    return undefined;
  }
  const checkpointId = (piPress as { checkpointId?: unknown }).checkpointId;
  return typeof checkpointId === "string" ? checkpointId : undefined;
}

function verifyEntries(
  entries: SessionEntry[],
  piExecutable: string,
  piVersion: string,
  model: string,
  sdk: PiSdk,
  splitTurn: boolean,
  expectedThinkingLevel: string,
): SmokeResult {
  const checkpointEntry = [...entries].reverse().find(
    (entry) => entry.type === "custom" &&
      entry.customType === "pi-press.precompaction" &&
      isCheckpointData(entry.data),
  );
  const compactionEntry = [...entries].reverse().find(
    (entry) => entry.type === "compaction" && getPiPressCheckpointId(entry),
  );
  if (!checkpointEntry || checkpointEntry.type !== "custom" ||
      !isCheckpointData(checkpointEntry.data)) {
    throw new Error("真实 Pi session 中缺少有效的 pi-press checkpoint");
  }
  if (!compactionEntry || compactionEntry.type !== "compaction") {
    throw new Error("真实 Pi session 中缺少扩展正式 compaction entry");
  }

  const checkpointData = checkpointEntry.data;
  if (checkpointData.provenance?.thinkingLevel !== expectedThinkingLevel) {
    throw new Error(`摘要 thinking level 不匹配：${checkpointData.provenance?.thinkingLevel}`);
  }
  if (splitTurn && !checkpointData.compaction.summary?.includes("**Turn Context (split turn):**")) {
    throw new Error("大输入冒烟测试没有生成原生 split turn 双摘要");
  }
  const snapshotIndex = entries.findIndex(
    (entry) => entry.id === checkpointData.snapshotLeafId,
  );
  const compactionIndex = entries.findIndex((entry) => entry.id === compactionEntry.id);
  if (snapshotIndex < 0 || compactionIndex <= snapshotIndex) {
    throw new Error("正式 compaction 与 checkpoint 快照边界无效");
  }

  const tailTokens = entries
    .slice(snapshotIndex + 1, compactionIndex)
    .flatMap((entry) => sdk.sessionEntryToContextMessages(entry))
    .reduce((total, message) => total + sdk.estimateTokens(message), 0);
  const checkpointTokensBefore = checkpointData.compaction.tokensBefore;
  const expectedTokensBefore = checkpointTokensBefore + tailTokens;
  if (compactionEntry.tokensBefore !== expectedTokensBefore) {
    throw new Error(
      `tokensBefore 不匹配：期望 ${expectedTokensBefore}，实际 ${compactionEntry.tokensBefore}`,
    );
  }
  if (compactionEntry.fromHook !== true) {
    throw new Error("正式 compaction entry 不是扩展 hook 结果");
  }
  if (getPiPressCheckpointId(compactionEntry) !== checkpointData.checkpointId) {
    throw new Error("正式 compaction entry 与 checkpoint ID 不一致");
  }

  return {
    piExecutable,
    piVersion,
    model,
    checkpointId: checkpointData.checkpointId,
    checkpointTokensBefore,
    tailTokens,
    expectedTokensBefore,
    actualTokensBefore: compactionEntry.tokensBefore,
    summaryThinkingLevel: checkpointData.provenance.thinkingLevel,
  };
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  child.stdin.end();
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  killTimer.unref();
}

function runRpcSmoke(
  piExecutable: string,
  piVersion: string,
  cwd: string,
  sessionFile: string,
  sdk: PiSdk,
  splitTurn: boolean,
  summaryThinkingLevel: string,
  explicitModel?: string,
): Promise<SmokeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const launch = resolvePiLaunch(piExecutable);
    const mainThinkingLevel = splitTurn ? "xhigh" : "off";
    const child = spawn(launch.command, [
      ...launch.args,
      "--mode", "rpc",
      ...(explicitModel ? ["--model", explicitModel] : []),
      "--thinking", mainThinkingLevel,
      "--no-tools",
      "--no-extensions",
      "--extension", extensionPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
      "--session", sessionFile,
    ], { cwd, stdio: ["pipe", "pipe", "pipe"] });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    let stderr = "";
    let model = "";
    let projectedPromptSent = false;
    let entriesRequested = false;
    const eventTrace: string[] = [];
    let outcome: { result?: SmokeResult; error?: Error } | undefined;

    const timeout = setTimeout(() => {
      const trace = eventTrace.length > 0 ? `\nRPC events: ${eventTrace.join(", ")}` : "";
      finish({
        error: new Error(`等待真实 Pi 正式 compaction 超时${stderr ? `：${stderr}` : ""}${trace}`),
      });
    }, 420_000);

    const finish = (nextOutcome: { result?: SmokeResult; error?: Error }): void => {
      if (outcome) {
        return;
      }
      outcome = nextOutcome;
      clearTimeout(timeout);
      stopChild(child);
    };

    const send = (command: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    };

    const handleRecord = (record: Record<string, unknown>): void => {
      const eventId = typeof record.id === "string" ? `:${record.id}` : "";
      eventTrace.push(`${String(record.type ?? "unknown")}${eventId}`);
      if (eventTrace.length > 80) {
        eventTrace.shift();
      }

      if (record.type === "response" && record.id === "state") {
        if (record.success !== true || !record.data || typeof record.data !== "object") {
          finish({ error: new Error("无法读取真实 Pi 当前状态") });
          return;
        }
        const stateModel = (record.data as { model?: unknown }).model;
        if (!stateModel || typeof stateModel !== "object") {
          finish({ error: new Error("真实 Pi 当前配置没有可用模型") });
          return;
        }
        const provider = (stateModel as { provider?: unknown }).provider;
        const modelId = (stateModel as { id?: unknown }).id;
        if (typeof provider !== "string" || typeof modelId !== "string") {
          finish({ error: new Error("真实 Pi 当前模型信息不完整") });
          return;
        }
        const thinkingLevel = (record.data as { thinkingLevel?: unknown }).thinkingLevel;
        if (thinkingLevel !== mainThinkingLevel) {
          finish({ error: new Error(`主会话 thinking level 不匹配：${String(thinkingLevel)}`) });
          return;
        }
        model = `${provider}/${modelId}`;
        process.stdout.write(`Model: ${model}\nMain thinking: ${thinkingLevel}\n`);
        const history = (splitTurn ? "" : `${"Historical context for compaction. ".repeat(1_600)}\n`) +
          "Reply exactly FIRST_OK and nothing else.";
        send({ id: "initial-prompt", type: "prompt", message: history });
        return;
      }

      if (record.type === "extension_ui_request" && record.method === "notify") {
        const params = record.params;
        const nestedMessage = params && typeof params === "object"
          ? (params as { message?: unknown }).message
          : undefined;
        const message = typeof record.message === "string" ? record.message : nestedMessage;
        if (!projectedPromptSent && typeof message === "string" && message.includes("预压缩成功")) {
          projectedPromptSent = true;
          send({
            id: "projected-prompt",
            type: "prompt",
            message: "Reply exactly PROJECTED_OK and nothing else.",
            streamingBehavior: "followUp",
          });
        } else if (typeof message === "string" && message.includes("预压缩失败")) {
          finish({ error: new Error(`真实 Pi 后台预压缩失败：${message}`) });
        }
        return;
      }

      if (record.type === "auto_retry_end" && record.success === false) {
        const finalError = typeof record.finalError === "string" ? record.finalError : "未知 provider 错误";
        finish({ error: new Error(`真实 Pi provider 请求重试耗尽：${finalError}`) });
        return;
      }

      if (record.type === "compaction_end" && !entriesRequested) {
        entriesRequested = true;
        setTimeout(() => send({ id: "entries", type: "get_entries" }), 50);
        return;
      }

      if (record.type === "response" && record.id === "entries") {
        if (record.success !== true || !record.data || typeof record.data !== "object") {
          finish({ error: new Error("真实 Pi 无法返回 session entries") });
          return;
        }
        const entries = (record.data as { entries?: unknown }).entries;
        if (!Array.isArray(entries)) {
          finish({ error: new Error("真实 Pi 返回的 session entries 无效") });
          return;
        }
        try {
          finish({
            result: verifyEntries(
              entries as SessionEntry[],
              piExecutable,
              piVersion,
              model,
              sdk,
              splitTurn,
              summaryThinkingLevel === "inherit" ? mainThinkingLevel : summaryThinkingLevel,
            ),
          });
        } catch (error: unknown) {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
        }
        return;
      }

      if (record.type === "extension_error") {
        const message = typeof record.message === "string" ? record.message : "未知扩展错误";
        finish({ error: new Error(`真实 Pi 扩展错误：${message}`) });
      }
    };

    const consumeStdout = (text: string): void => {
      stdoutBuffer += text;
      while (true) {
        const lineEnd = stdoutBuffer.indexOf("\n");
        if (lineEnd < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
        if (!line) {
          continue;
        }
        try {
          const record = JSON.parse(line) as unknown;
          if (record && typeof record === "object" && !Array.isArray(record)) {
            handleRecord(record as Record<string, unknown>);
          }
        } catch {
          stderr += `非 JSON RPC 输出：${line.slice(0, 300)}\n`;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => finish({ error }));
    child.on("exit", (code, signal) => {
      if (!outcome) {
        rejectPromise(new Error(
          `真实 Pi 提前退出：code=${String(code)} signal=${String(signal)}${stderr ? `\n${stderr}` : ""}`,
        ));
        return;
      }
      if (outcome.error) {
        rejectPromise(outcome.error);
      } else if (outcome.result) {
        resolvePromise(outcome.result);
      } else {
        rejectPromise(new Error("真实 Pi 冒烟测试没有结果"));
      }
    });

    send({ id: "state", type: "get_state" });
  });
}

function runGrowthRpcSmoke(
  piExecutable: string,
  piVersion: string,
  cwd: string,
  sessionFile: string,
  helperExtensionPath: string,
  sdk: PiSdk,
  summaryThinkingLevel: string,
  explicitModel?: string,
): Promise<SmokeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const launch = resolvePiLaunch(piExecutable);
    const mainThinkingLevel = "off";
    const child = spawn(launch.command, [
      ...launch.args,
      "--mode", "rpc",
      ...(explicitModel ? ["--model", explicitModel] : []),
      "--thinking", mainThinkingLevel,
      "--no-tools",
      "--no-extensions",
      "--extension", helperExtensionPath,
      "--extension", extensionPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--approve",
      "--session", sessionFile,
    ], { cwd, stdio: ["pipe", "pipe", "pipe"] });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    let stderr = "";
    let model = "";
    let turn2Sent = false;
    let turn3Sent = false;
    let entriesRequested = false;
    let assistantTurnCount = 0;
    let waitStartedAt: number | undefined;
    let waitElapsedMs = 0;
    const foregroundWaitStatuses: string[] = [];
    const eventTrace: string[] = [];
    let outcome: { result?: SmokeResult; error?: Error } | undefined;

    const timeout = setTimeout(() => {
      const trace = eventTrace.length > 0 ? `\nRPC events: ${eventTrace.join(", ")}` : "";
      finish({
        error: new Error(`等待真实 Pi 连续中文增长测试超时${stderr ? `：${stderr}` : ""}${trace}`),
      });
    }, 480_000);

    const finish = (nextOutcome: { result?: SmokeResult; error?: Error }): void => {
      if (outcome) {
        return;
      }
      outcome = nextOutcome;
      clearTimeout(timeout);
      stopChild(child);
    };

    const send = (command: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    };

    const handleRecord = (record: Record<string, unknown>): void => {
      const eventId = typeof record.id === "string" ? `:${record.id}` : "";
      eventTrace.push(`${String(record.type ?? "unknown")}${eventId}`);
      if (eventTrace.length > 120) {
        eventTrace.shift();
      }

      if (record.type === "response" && record.id === "state") {
        if (record.success !== true || !record.data || typeof record.data !== "object") {
          finish({ error: new Error("无法读取真实 Pi 当前状态") });
          return;
        }
        const stateModel = (record.data as { model?: unknown }).model;
        if (!stateModel || typeof stateModel !== "object") {
          finish({ error: new Error("真实 Pi 当前配置没有可用模型") });
          return;
        }
        const provider = (stateModel as { provider?: unknown }).provider;
        const modelId = (stateModel as { id?: unknown }).id;
        if (typeof provider !== "string" || typeof modelId !== "string") {
          finish({ error: new Error("真实 Pi 当前模型信息不完整") });
          return;
        }
        model = `${provider}/${modelId}`;
        process.stdout.write(`Model: ${model}\nMain thinking: ${mainThinkingLevel}\n`);
        send({
          id: "growth-turn-1",
          type: "prompt",
          message: `${buildChineseLogChunk("第一轮巡检补充", 450)}\nReply exactly GROWTH_1_OK and nothing else.`,
        });
        return;
      }

      if (record.type === "extension_ui_request" && record.method === "setStatus") {
        const statusText = typeof record.statusText === "string"
          ? record.statusText
          : (record.params && typeof record.params === "object"
            ? (record.params as { text?: unknown; statusText?: unknown }).statusText ??
              (record.params as { text?: unknown }).text
            : undefined);
        if (typeof statusText === "string" && statusText.includes("pi-press 正在压缩")) {
          if (waitStartedAt === undefined) {
            waitStartedAt = Date.now();
          }
          foregroundWaitStatuses.push(statusText);
        } else if (statusText === undefined && waitStartedAt !== undefined && waitElapsedMs === 0) {
          waitElapsedMs = Date.now() - waitStartedAt;
        }
        return;
      }

      if (record.type === "extension_ui_request" && record.method === "notify") {
        const params = record.params;
        const nestedMessage = params && typeof params === "object"
          ? (params as { message?: unknown }).message
          : undefined;
        const message = typeof record.message === "string" ? record.message : nestedMessage;
        if (!turn2Sent && typeof message === "string" && message.includes("预压缩成功")) {
          turn2Sent = true;
          send({
            id: "growth-turn-2",
            type: "prompt",
            message: `${buildChineseLogChunk("第二轮中文增量日志", 1_150)}\nReply exactly GROWTH_2_OK and nothing else.`,
            streamingBehavior: "followUp",
          });
        } else if (typeof message === "string" && message.includes("预压缩失败")) {
          finish({ error: new Error(`真实 Pi 增长测试预压缩失败：${message}`) });
        }
        return;
      }

      if (record.type === "auto_retry_end" && record.success === false) {
        const finalError = typeof record.finalError === "string" ? record.finalError : "未知 provider 错误";
        finish({ error: new Error(`真实 Pi provider 请求重试耗尽：${finalError}`) });
        return;
      }

      if (record.type === "message_start" && turn2Sent && !turn3Sent) {
        const msg = record.message as { role?: unknown } | undefined;
        if (msg?.role === "assistant" && assistantTurnCount >= 1) {
          turn3Sent = true;
          send({
            id: "growth-turn-3",
            type: "prompt",
            message: `${buildBurstLogChunk("第三轮超限峰值日志", 1_350)}\nReply exactly GROWTH_3_OK and nothing else.`,
            streamingBehavior: "followUp",
          });
        }
        return;
      }

      if (record.type === "turn_end") {
        assistantTurnCount += 1;
        return;
      }

      if (record.type === "compaction_end" && turn3Sent && !entriesRequested) {
        entriesRequested = true;
        if (waitStartedAt !== undefined && waitElapsedMs === 0) {
          waitElapsedMs = Date.now() - waitStartedAt;
        }
        setTimeout(() => send({ id: "entries", type: "get_entries" }), 80);
        return;
      }

      if (record.type === "response" && record.id === "entries") {
        if (record.success !== true || !record.data || typeof record.data !== "object") {
          finish({ error: new Error("真实 Pi 无法返回 session entries") });
          return;
        }
        const entries = (record.data as { entries?: unknown }).entries;
        if (!Array.isArray(entries)) {
          finish({ error: new Error("真实 Pi 返回的 session entries 无效") });
          return;
        }
        try {
          const typedEntries = entries as SessionEntry[];
          const baseResult = verifyEntries(
            typedEntries,
            piExecutable,
            piVersion,
            model,
            sdk,
            false,
            summaryThinkingLevel === "inherit" ? mainThinkingLevel : summaryThinkingLevel,
          );
          const checkpoints = typedEntries.filter(
            (entry): entry is SessionEntry & { type: "custom"; data: CheckpointData } =>
              entry.type === "custom" &&
              entry.customType === "pi-press.precompaction" &&
              isCheckpointData(entry.data),
          );
          if (checkpoints.length < 2) {
            throw new Error(`连续中文增长测试未触发多代刷新：实际代数 ${checkpoints.length}`);
          }
          const latestCheckpoint = checkpoints[checkpoints.length - 1]!.data;
          if (!latestCheckpoint.parentCheckpointId) {
            throw new Error("连续中文增长测试的最新 checkpoint 缺少 parentCheckpointId");
          }
          if (foregroundWaitStatuses.length === 0) {
            throw new Error("连续中文增长测试未观察到超限前台等待状态更新");
          }
          const liveAssistants = typedEntries.filter(
            (entry): entry is SessionEntry & { type: "message" } =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              entry.message.provider !== "pi-press-smoke",
          );
          const turnTelemetry: TurnTelemetry[] = liveAssistants.map((entry, index) => {
            const assistantMsg = entry.message as {
              usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
            };
            const usage = assistantMsg.usage;
            const realUsageTotalTokens = usage?.totalTokens ??
              ((usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0));
            const entryIndex = typedEntries.findIndex((candidate) => candidate.id === entry.id);
            const activeCheckpoint = [...typedEntries.slice(0, entryIndex)]
              .reverse()
              .find(
                (candidate): candidate is SessionEntry & { type: "custom"; data: CheckpointData } =>
                  candidate.type === "custom" &&
                  candidate.customType === "pi-press.precompaction" &&
                  isCheckpointData(candidate.data),
              );
            const keptStartIndex = activeCheckpoint
              ? typedEntries.findIndex(
                (candidate) => candidate.id === activeCheckpoint.data.compaction.firstKeptEntryId,
              )
              : 0;
            const summaryChars = activeCheckpoint ? activeCheckpoint.data.compaction.summary.length : 0;
            const keptAndTailTokens = typedEntries
              .slice(Math.max(0, keptStartIndex), entryIndex + 1)
              .flatMap((candidate) => sdk.sessionEntryToContextMessages(candidate))
              .reduce((total, message) => total + sdk.estimateTokens(message), 0);
            return {
              turn: index + 1,
              realUsageTotalTokens,
              piEstimateTokens: Math.ceil(summaryChars / 4) + keptAndTailTokens,
            };
          });
          finish({
            result: {
              ...baseResult,
              growthMetrics: {
                windowTokens: GROWTH_WINDOW_TOKENS,
                reserveTokens: GROWTH_RESERVE_TOKENS,
                softLimit: GROWTH_SOFT_LIMIT,
                hardLimit: GROWTH_HARD_LIMIT,
                checkpointGenerations: checkpoints.length,
                foregroundWaitObserved: foregroundWaitStatuses.length > 0,
                foregroundWaitStatuses,
                foregroundWaitElapsedMs: waitElapsedMs,
                turnTelemetry,
                outcome: "recovered_and_formalized",
              },
            },
          });
        } catch (error: unknown) {
          finish({ error: error instanceof Error ? error : new Error(String(error)) });
        }
        return;
      }

      if (record.type === "extension_error") {
        const message = typeof record.message === "string" ? record.message : "未知扩展错误";
        finish({ error: new Error(`真实 Pi 扩展错误：${message}`) });
      }
    };

    const consumeStdout = (text: string): void => {
      stdoutBuffer += text;
      while (true) {
        const lineEnd = stdoutBuffer.indexOf("\n");
        if (lineEnd < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
        if (!line) {
          continue;
        }
        try {
          const record = JSON.parse(line) as unknown;
          if (record && typeof record === "object" && !Array.isArray(record)) {
            handleRecord(record as Record<string, unknown>);
          }
        } catch {
          stderr += `非 JSON RPC 输出：${line.slice(0, 300)}\n`;
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => finish({ error }));
    child.on("exit", (code, signal) => {
      if (!outcome) {
        rejectPromise(new Error(
          `真实 Pi 提前退出：code=${String(code)} signal=${String(signal)}${stderr ? `\n${stderr}` : ""}`,
        ));
        return;
      }
      if (outcome.error) {
        rejectPromise(outcome.error);
      } else if (outcome.result) {
        resolvePromise(outcome.result);
      } else {
        rejectPromise(new Error("真实 Pi 增长冒烟测试没有结果"));
      }
    });

    send({ id: "state", type: "get_state" });
  });
}

async function main(): Promise<void> {
  const scenario = process.env.PI_SMOKE_SCENARIO ?? "basic";
  const summaryThinkingLevel = process.env.PI_SMOKE_SUMMARY_THINKING ?? "low";
  if (!["basic", "split", "growth"].includes(scenario) || !["low", "inherit"].includes(summaryThinkingLevel)) {
    throw new Error("PI_SMOKE_SCENARIO 允许 basic、split 或 growth；PI_SMOKE_SUMMARY_THINKING 允许 low 或 inherit");
  }
  const splitTurn = scenario === "split";
  const piExecutable = resolveSystemPi({
    projectRoot,
    pathValue: process.env.PATH ?? "",
    ...(process.env.PI_BIN ? { explicitPi: process.env.PI_BIN } : {}),
  });
  const piVersion = readPiVersion(piExecutable);
  const sdk = await loadPiSdk(piExecutable);
  const cwd = mkdtempSync(join(tmpdir(), "pi-press-real-smoke-"));
  let succeeded = false;

  process.stdout.write(`Pi executable: ${piExecutable}\n`);
  process.stdout.write(`Pi version: ${piVersion}\n`);
  process.stdout.write("真实 Pi 冒烟测试将调用当前配置的 provider。\n");

  try {
    const explicitModel = process.env.PI_SMOKE_MODEL;
    process.stdout.write(`Scenario: ${scenario}\nSummary setting: ${summaryThinkingLevel}\n`);
    const startedAt = Date.now();
    let result: SmokeResult;
    if (scenario === "growth") {
      createGrowthSmokeConfig(cwd, summaryThinkingLevel);
      const sessionFile = createGrowthSmokeSession(cwd, sdk.SessionManager);
      const helperPath = createGrowthHelperExtension(cwd);
      result = await runGrowthRpcSmoke(
        piExecutable,
        piVersion,
        cwd,
        sessionFile,
        helperPath,
        sdk,
        summaryThinkingLevel,
        explicitModel,
      );
    } else {
      createSmokeConfig(cwd, splitTurn, summaryThinkingLevel);
      const sessionFile = createSmokeSession(cwd, sdk.SessionManager, splitTurn);
      result = await runRpcSmoke(
        piExecutable,
        piVersion,
        cwd,
        sessionFile,
        sdk,
        splitTurn,
        summaryThinkingLevel,
        explicitModel,
      );
    }
    succeeded = true;
    process.stdout.write(`Elapsed ms: ${Date.now() - startedAt}\n`);
    process.stdout.write(`Summary thinking: ${result.summaryThinkingLevel}\n`);
    process.stdout.write(`Checkpoint ID: ${result.checkpointId}\n`);
    process.stdout.write(`Checkpoint tokensBefore: ${result.checkpointTokensBefore}\n`);
    process.stdout.write(`Tail tokens: ${result.tailTokens}\n`);
    process.stdout.write(`Expected tokensBefore: ${result.expectedTokensBefore}\n`);
    process.stdout.write(`Formal tokensBefore: ${result.actualTokensBefore}\n`);
    if (result.growthMetrics) {
      process.stdout.write(
        `Capacity limits: W=${result.growthMetrics.windowTokens} R=${result.growthMetrics.reserveTokens} Q=${result.growthMetrics.softLimit} H=${result.growthMetrics.hardLimit}\n`,
      );
      process.stdout.write(`Checkpoint generations: ${result.growthMetrics.checkpointGenerations}\n`);
      process.stdout.write(`Foreground wait observed: ${String(result.growthMetrics.foregroundWaitObserved)}\n`);
      process.stdout.write(`Foreground wait elapsed ms: ${result.growthMetrics.foregroundWaitElapsedMs}\n`);
      process.stdout.write(`Foreground wait statuses: ${result.growthMetrics.foregroundWaitStatuses.join(" | ")}\n`);
      process.stdout.write(`Turn telemetry: ${JSON.stringify(result.growthMetrics.turnTelemetry)}\n`);
      process.stdout.write(`Growth outcome: ${result.growthMetrics.outcome}\n`);
    }
    process.stdout.write("Result: PASS\n");
  } finally {
    if (succeeded || process.env.PI_SMOKE_KEEP_TEMP !== "1") {
      rmSync(cwd, { recursive: true, force: true });
    } else {
      process.stderr.write(`已保留失败现场：${cwd}\n`);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
