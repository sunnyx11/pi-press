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

test("provider authentication cancellation waits for the underlying operation to settle", async () => {
  const controller = new AbortController();
  let resolveAuth!: () => void;
  const auth = new Promise<{ ok: true }>((resolve) => {
    resolveAuth = () => resolve({ ok: true });
  });
  const registry = {
    getApiKeyAndHeaders: () => auth,
    getProvider: () => undefined,
  };

  const result = resolveProviderRequest(registry, makeModel(), controller.signal);
  let resultSettled = false;
  void result.then(
    () => {
      resultSettled = true;
    },
    () => {
      resultSettled = true;
    },
  );
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resultSettled, false);

  resolveAuth();
  await assert.rejects(
    result,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("provider AbortError remains an auth failure while the task signal is active", async () => {
  const controller = new AbortController();
  const registry = {
    getApiKeyAndHeaders: async () => {
      const error = new Error("credential helper aborted");
      error.name = "AbortError";
      throw error;
    },
    getProvider: () => undefined,
  };

  const result = await resolveProviderRequest(registry, makeModel(), controller.signal);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failure.kind, "auth");
  }
});

test("provider authentication failure does not expose the original error", async () => {
  const registry = {
    getApiKeyAndHeaders: async () => ({
      ok: false as const,
      error: "credential failed: sk-review-secret",
    }),
    getProvider: () => undefined,
  };
  const result = await resolveProviderRequest(registry, makeModel());
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.failure.kind, "auth");
  assert.doesNotMatch(JSON.stringify(result), /sk-review-secret/);
});
