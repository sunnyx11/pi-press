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
  snapshotLeafId: string;
  compaction: {
    tokensBefore: number;
  };
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
  const result = spawnSync(piExecutable, ["--version"], {
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
    const packagePath = join(current, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
      if (parsed.name === "@earendil-works/pi-coding-agent") {
        return current;
      }
    } catch {
      // 继续向父目录查找 Pi 包根目录。
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(`无法从 Pi 可执行文件定位 @earendil-works/pi-coding-agent：${piExecutable}`);
}

async function loadPiSdk(piExecutable: string): Promise<PiSdk> {
  const packageRoot = findPiPackageRoot(piExecutable);
  const moduleUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
  return await import(moduleUrl) as PiSdk;
}

function createSmokeSession(
  cwd: string,
  SessionManager: PiSdk["SessionManager"],
): string {
  const sessionDirectory = join(cwd, "sessions");
  mkdirSync(sessionDirectory, { recursive: true });
  const manager = SessionManager.create(cwd, sessionDirectory);
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Previously discussed deployment details." }],
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
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) {
    throw new Error("Pi 未创建冒烟测试 session 文件");
  }
  return sessionFile;
}

function createSmokeConfig(cwd: string): void {
  const configDirectory = join(cwd, ".pi");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "pi-press.json"),
    JSON.stringify({
      precomputeMode: "threshold",
      softThresholdPercent: 0,
      summaryReserveTokens: 1024,
      taskTimeoutMs: 120_000,
      hookWaitTimeoutMs: 5_000,
    }, null, 2),
  );
  writeFileSync(
    join(configDirectory, "settings.json"),
    JSON.stringify({
      compaction: {
        enabled: true,
        reserveTokens: 1024,
        keepRecentTokens: 0,
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
): Promise<SmokeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(piExecutable, [
      "--mode", "rpc",
      "--thinking", "off",
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
    }, 180_000);

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
        model = `${provider}/${modelId}`;
        const history = `${"Historical context for compaction. ".repeat(1_600)}\n` +
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
        }
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

async function main(): Promise<void> {
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
    createSmokeConfig(cwd);
    const sessionFile = createSmokeSession(cwd, sdk.SessionManager);
    const result = await runRpcSmoke(piExecutable, piVersion, cwd, sessionFile, sdk);
    succeeded = true;
    process.stdout.write(`Model: ${result.model}\n`);
    process.stdout.write(`Checkpoint ID: ${result.checkpointId}\n`);
    process.stdout.write(`Checkpoint tokensBefore: ${result.checkpointTokensBefore}\n`);
    process.stdout.write(`Tail tokens: ${result.tailTokens}\n`);
    process.stdout.write(`Expected tokensBefore: ${result.expectedTokensBefore}\n`);
    process.stdout.write(`Formal tokensBefore: ${result.actualTokensBefore}\n`);
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
