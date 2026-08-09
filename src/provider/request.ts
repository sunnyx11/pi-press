import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  Model,
  Provider,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ProviderRequest } from "../types.js";

export type ProviderRequestFailure =
  | { kind: "auth" }
  | { kind: "provider" };

export type ProviderRequestResult =
  | { ok: true; request: ProviderRequest }
  | { ok: false; failure: ProviderRequestFailure };

function withoutNullHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const filtered = Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null);
  return filtered.length > 0 ? Object.fromEntries(filtered) : undefined;
}

function getStreamFn(provider: Provider): StreamFn {
  return (model, context, options) => provider.streamSimple(model, context, options);
}

function createAbortError(): Error {
  const error = new Error("Provider authentication was aborted");
  error.name = "AbortError";
  return error;
}

function waitForAuth<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let aborted = signal.aborted;
    const onAbort = (): void => {
      aborted = true;
      signal.removeEventListener("abort", onAbort);
    };
    if (!aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (callback: () => void): void => {
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    void operation.then(
      (value) => finish(() => aborted ? reject(createAbortError()) : resolve(value)),
      (error: unknown) => finish(() => aborted ? reject(createAbortError()) : reject(error)),
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 解析活动模型的认证和 provider stream，过滤可删除的 header。 */
export async function resolveProviderRequest(
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "getProvider">,
  model: Model<Api>,
  signal?: AbortSignal,
): Promise<ProviderRequestResult> {
  let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
  try {
    const operation = Promise.resolve().then(() => modelRegistry.getApiKeyAndHeaders(model));
    auth = signal ? await waitForAuth(operation, signal) : await operation;
  } catch (error: unknown) {
    if (signal?.aborted && isAbortError(error)) {
      throw error;
    }
    return { ok: false, failure: { kind: "auth" } };
  }
  if (!auth.ok) {
    return { ok: false, failure: { kind: "auth" } };
  }

  const provider = modelRegistry.getProvider(model.provider);
  if (!provider) {
    return { ok: false, failure: { kind: "provider" } };
  }

  const headers = withoutNullHeaders(auth.headers);
  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  return {
    ok: true,
    request: {
      model: requestModel,
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      ...(headers === undefined ? {} : { headers }),
      ...(auth.env === undefined ? {} : { env: auth.env }),
      streamFn: getStreamFn(provider),
    },
  };
}
