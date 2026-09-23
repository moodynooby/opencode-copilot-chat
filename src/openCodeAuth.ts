import { ZEN_VENDOR, type ProviderVendor } from "./providerTypes";

export type OpenCodeEndpointKind = "chat-completions" | "messages" | "responses" | "google";

/**
 * Build authentication headers for a provider-specific OpenCode endpoint.
 *
 * OpenCode Zen V2 is a single Console inference gateway and accepts the
 * service-account key as a Bearer token for every API family. Go retains its
 * native per-family headers. Anonymous Zen requests intentionally return no
 * auth headers rather than sending `Bearer undefined`.
 */
export function buildOpenCodeGatewayAuthHeaders(
  endpointKind: OpenCodeEndpointKind,
  apiKey: string | undefined,
  vendor: ProviderVendor,
): Record<string, string> {
  const key = apiKey?.trim();
  if (!key) {
    return {};
  }

  if (vendor === ZEN_VENDOR) {
    return {
      Authorization: `Bearer ${key}`,
    };
  }

  if (endpointKind === "messages") {
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }

  if (endpointKind === "google") {
    return {
      "x-goog-api-key": key,
    };
  }

  return {
    Authorization: `Bearer ${key}`,
  };
}
