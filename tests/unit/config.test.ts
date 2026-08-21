import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  configFingerprint,
  createSnapshotKey,
  loadConfig,
  loadPiCompactionKeepRecentTokens,
  normalizeConfig,
} from "../../src/config.js";

test("normalizeConfig returns design defaults and reports removed fields", () => {
  const result = normalizeConfig({
    checkpointKeepRecentTokens: 1,
    maxRefreshesPerEpoch: 0,
    maxRetries: 0,
    targetPostCompactionPercent: 50,
  });
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.softThresholdPercent, 80);
  assert.equal(DEFAULT_CONFIG.taskTimeoutMs, 300_000);
  assert.deepEqual(result.diagnostics, ["配置字段 targetPostCompactionPercent 已移除，当前值已忽略"]);
});

test("normalizeConfig falls back per invalid field", () => {
  const result = normalizeConfig({
    softThresholdPercent: 101,
    taskTimeoutMs: 0,
    precomputeMode: "threshold-and-manual",
  });
  assert.equal(result.config.softThresholdPercent, DEFAULT_CONFIG.softThresholdPercent);
  assert.equal(result.config.taskTimeoutMs, DEFAULT_CONFIG.taskTimeoutMs);
  assert.equal(result.config.precomputeMode, "threshold-and-manual");
  assert.equal(result.diagnostics.length, 2);
});

test("normalizeConfig ignores formalization retention because Pi owns it", () => {
  const result = normalizeConfig({ formalizationKeepRecentTokens: 30_000 });

  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.deepEqual(result.diagnostics, []);
});

test("loadConfig merges global config before project overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-config-"));
  const globalDir = join(root, "global", "agent");
  const projectDir = join(root, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });

  try {
    writeFileSync(
      join(globalDir, "pi-press.json"),
      JSON.stringify({ softThresholdPercent: 70 }),
    );
    writeFileSync(
      join(projectDir, ".pi", "pi-press.json"),
      JSON.stringify({ softThresholdPercent: 90 }),
    );

    const result = loadConfig(projectDir, globalDir);

    assert.equal(result.config.softThresholdPercent, 90);
    assert.equal(result.config.hookWaitTimeoutMs, DEFAULT_CONFIG.hookWaitTimeoutMs);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig keeps global values when project JSON is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-config-"));
  const globalDir = join(root, "global", "agent");
  const projectDir = join(root, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });

  try {
    writeFileSync(
      join(globalDir, "pi-press.json"),
      JSON.stringify({ softThresholdPercent: 70, hookWaitTimeoutMs: 777 }),
    );
    writeFileSync(join(projectDir, ".pi", "pi-press.json"), "invalid json");

    const result = loadConfig(projectDir, globalDir);

    assert.equal(result.config.softThresholdPercent, 70);
    assert.equal(result.config.hookWaitTimeoutMs, 777);
    assert.equal(result.diagnostics.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig deduplicates a shared global and project file", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-config-"));
  const projectDir = join(root, "project");
  const configDir = join(projectDir, ".pi");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "pi-press.json");

  try {
    writeFileSync(configPath, "invalid json");
    const result = loadConfig(projectDir, configDir);

    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0] ?? "", /pi-press\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formalization retention comes from Pi settings with Pi defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-press-pi-settings-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });

  try {
    assert.equal(
      loadPiCompactionKeepRecentTokens(projectDir, true, agentDir),
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    );

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: 25_000 } }),
    );
    assert.equal(loadPiCompactionKeepRecentTokens(projectDir, true, agentDir), 25_000);

    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: 30_000 } }),
    );
    assert.equal(loadPiCompactionKeepRecentTokens(projectDir, true, agentDir), 30_000);
    assert.equal(loadPiCompactionKeepRecentTokens(projectDir, false, agentDir), 25_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config fingerprint and snapshot key are deterministic", () => {
  const first = configFingerprint(DEFAULT_CONFIG);
  const second = configFingerprint({ ...DEFAULT_CONFIG });
  assert.equal(first, second);
  assert.match(createSnapshotKey("session", null, "leaf", DEFAULT_CONFIG), /session:null:leaf:0\.84\.1:3:1:/);
});

test("normalizeConfig rejects timeout values above the Node timer limit", () => {
  const result = normalizeConfig({
    taskTimeoutMs: 2_147_483_648,
    hookWaitTimeoutMs: Number.MAX_SAFE_INTEGER,
  });

  assert.equal(result.config.taskTimeoutMs, DEFAULT_CONFIG.taskTimeoutMs);
  assert.equal(result.config.hookWaitTimeoutMs, DEFAULT_CONFIG.hookWaitTimeoutMs);
  assert.equal(result.diagnostics.length, 2);

  const maximum = normalizeConfig({ taskTimeoutMs: 2_147_483_647 });
  assert.equal(maximum.config.taskTimeoutMs, 2_147_483_647);
  assert.deepEqual(maximum.diagnostics, []);
});

test("normalizeConfig rejects a non-object root", () => {
  const result = normalizeConfig([]);
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(result.diagnostics.length, 1);
});
