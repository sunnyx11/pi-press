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
  | { kind: "auth"; message: string }
  | { kind: "provider"; message: string };

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

/** 解析活动模型的认证和 provider stream，过滤可删除的 header。 */
export async function resolveProviderRequest(
  modelRegistry: Pick<ModelRegistry, "getApiKeyAndHeaders" | "getProvider">,
  model: Model<Api>,
): Promise<ProviderRequestResult> {
  let auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;
  try {
    auth = await modelRegistry.getApiKeyAndHeaders(model);
  } catch (error: unknown) {
    return {
      ok: false,
      failure: {
        kind: "auth",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!auth.ok) {
    return { ok: false, failure: { kind: "auth", message: auth.error } };
  }

  const provider = modelRegistry.getProvider(model.provider);
  if (!provider) {
    return {
      ok: false,
      failure: { kind: "provider", message: `找不到 provider ${model.provider}` },
    };
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
