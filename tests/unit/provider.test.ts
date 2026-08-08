import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { resolveProviderRequest } from "../../src/provider/request.js";
import { makeModel } from "./fixtures.js";

test("provider request keeps endpoint/env and removes null headers", async () => {
  const provider = {
    id: "test",
    name: "Test provider",
    auth: {} as Provider["auth"],
    getModels: () => [],
    stream: () => ({}) as never,
    streamSimple: () => ({}) as never,
  } satisfies Provider;
  const registry = {
    getApiKeyAndHeaders: async () => ({
      ok: true as const,
      apiKey: "secret",
      headers: { "x-keep": "yes", "x-remove": null },
      baseUrl: "https://override.test/v1",
      env: { TEST_REGION: "local" },
    }),
    getProvider: () => provider,
  };
  const result = await resolveProviderRequest(registry, makeModel());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.request.apiKey, "secret");
  assert.equal(result.request.model.baseUrl, "https://override.test/v1");
  assert.deepEqual(result.request.headers, { "x-keep": "yes" });
  assert.deepEqual(result.request.env, { TEST_REGION: "local" });
});

test("provider authentication failure is explicit", async () => {
  const registry = {
    getApiKeyAndHeaders: async () => ({ ok: false as const, error: "missing" }),
    getProvider: () => undefined,
  };
  const result = await resolveProviderRequest(registry, makeModel());
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.failure.kind, "auth");
});
