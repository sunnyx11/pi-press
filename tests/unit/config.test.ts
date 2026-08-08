import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  configFingerprint,
  createSnapshotKey,
  normalizeConfig,
} from "../../src/config.js";

test("normalizeConfig returns design defaults", () => {
  const result = normalizeConfig({});
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.softThresholdPercent, 80);
  assert.deepEqual(result.diagnostics, []);
});

test("normalizeConfig falls back per invalid field", () => {
  const result = normalizeConfig({
    softThresholdPercent: 101,
    taskTimeoutMs: 0,
    maxRetries: 2,
    precomputeMode: "threshold-and-manual",
  });
  assert.equal(result.config.softThresholdPercent, DEFAULT_CONFIG.softThresholdPercent);
  assert.equal(result.config.taskTimeoutMs, DEFAULT_CONFIG.taskTimeoutMs);
  assert.equal(result.config.maxRetries, 2);
  assert.equal(result.config.precomputeMode, "threshold-and-manual");
  assert.equal(result.diagnostics.length, 2);
});

test("config fingerprint and snapshot key are deterministic", () => {
  const first = configFingerprint(DEFAULT_CONFIG);
  const second = configFingerprint({ ...DEFAULT_CONFIG });
  assert.equal(first, second);
  assert.match(createSnapshotKey("session", null, "leaf", DEFAULT_CONFIG), /session:null:leaf:0\.84\.1:1:1:/);
});

test("normalizeConfig rejects a non-object root", () => {
  const result = normalizeConfig([]);
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(result.diagnostics.length, 1);
});
