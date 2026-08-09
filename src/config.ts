import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { PiPressConfig, PrecomputeMode } from "./types.js";

export const DEFAULT_CONFIG: PiPressConfig = {
  precomputeMode: "threshold",
  softThresholdPercent: 80,
  summaryReserveTokens: 16_384,
  taskTimeoutMs: 120_000,
  hookWaitTimeoutMs: 1_000,
  targetPostCompactionPercent: 50,
};

const CONFIG_FILE_NAME = "pi-press.json";

type ConfigKey = keyof PiPressConfig;

const CONFIG_KEYS: readonly ConfigKey[] = [
  "precomputeMode",
  "softThresholdPercent",
  "summaryReserveTokens",
  "taskTimeoutMs",
  "hookWaitTimeoutMs",
  "targetPostCompactionPercent",
];

export interface ConfigLoadResult {
  config: PiPressConfig;
  diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= minimum;
}

function isPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isMode(value: unknown): value is PrecomputeMode {
  return value === "off" || value === "threshold" || value === "threshold-and-manual";
}

function isValidValue(key: ConfigKey, value: unknown): boolean {
  switch (key) {
    case "precomputeMode":
      return isMode(value);
    case "softThresholdPercent":
    case "targetPostCompactionPercent":
      return isPercent(value);
    case "summaryReserveTokens":
      return isIntegerAtLeast(value, 0);
    case "taskTimeoutMs":
    case "hookWaitTimeoutMs":
      return isIntegerAtLeast(value, 1);
  }
}

interface ConfigLayerResult {
  config: Partial<PiPressConfig>;
  diagnostics: string[];
}

function normalizeConfigLayer(raw: unknown): ConfigLayerResult {
  if (!isRecord(raw)) {
    return {
      config: { ...DEFAULT_CONFIG },
      diagnostics: ["配置必须是 JSON 对象"],
    };
  }

  const config: Partial<PiPressConfig> = {};
  const diagnostics: string[] = [];
  for (const key of CONFIG_KEYS) {
    if (!(key in raw)) {
      continue;
    }
    const value = raw[key];
    if (isValidValue(key, value)) {
      config[key] = value as never;
    } else {
      config[key] = DEFAULT_CONFIG[key] as never;
      diagnostics.push(`配置字段 ${key} 无效，已使用默认值`);
    }
  }
  return { config, diagnostics };
}

/** 将未知配置按字段校验为 Pi-press 当前配置。 */
export function normalizeConfig(raw: unknown): ConfigLoadResult {
  const layer = normalizeConfigLayer(raw);
  return {
    config: { ...DEFAULT_CONFIG, ...layer.config },
    diagnostics: layer.diagnostics,
  };
}

function readConfigLayer(configPath: string): ConfigLayerResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { config: {}, diagnostics: [] };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return {
      config: { ...DEFAULT_CONFIG },
      diagnostics: [`无法读取配置文件：${reason}`],
    };
  }
  return normalizeConfigLayer(raw);
}

/** 读取全局和当前项目的 Pi-press 配置；项目字段覆盖全局字段。 */
export function loadConfig(cwd: string, agentDir = getAgentDir()): ConfigLoadResult {
  const config = { ...DEFAULT_CONFIG };
  const diagnostics: string[] = [];
  const seenPaths = new Set<string>();
  const configPaths = [
    join(agentDir, CONFIG_FILE_NAME),
    join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME),
  ];

  for (const configPath of configPaths) {
    const normalizedPath = resolve(configPath);
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);

    const layer = readConfigLayer(configPath);
    Object.assign(config, layer.config);
    diagnostics.push(...layer.diagnostics.map((item) => `${configPath}: ${item}`));
  }

  return { config, diagnostics };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function stableConfigText(config: PiPressConfig): string {
  return JSON.stringify(CONFIG_KEYS.map((key) => [key, config[key]]));
}

/** 返回参与 snapshot key 的配置指纹。 */
export function configFingerprint(config: PiPressConfig): string {
  return createHash("sha256").update(stableConfigText(config)).digest("hex");
}

/** 生成只用于后台去重的 snapshot key。 */
export function createSnapshotKey(
  sessionId: string,
  epochCompactionId: string | null,
  snapshotSourceLeafId: string,
  config: PiPressConfig,
): string {
  return [
    sessionId,
    epochCompactionId ?? "null",
    snapshotSourceLeafId,
    VERSION,
    "1",
    "1",
    configFingerprint(config),
  ].join(":");
}
