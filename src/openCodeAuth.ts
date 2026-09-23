import { ZEN_TRANSPORT_MODE, type ZenTransportMode } from "./config";
import { ZEN_VENDOR, type ProviderVendor } from "./providerTypes";

export type OpenCodeEndpointKind = "chat-completions" | "messages" | "responses" | "google";

/**
 * Build authentication headers for a provider-specific OpenCode endpoint.
 *
 * The official OpenCode-compatible legacy Zen gateway uses the literal
 * `public` bearer sentinel when no credential is configured. The experimental
 * V2 Console gateway does not accept that sentinel; it must remain keyless
 * (or receive a real service-account key). Go retains its native per-family
 * headers.
 */
export function buildOpenCodeGatewayAuthHeaders(
  endpointKind: OpenCodeEndpointKind,
  apiKey: string | undefined,
  vendor: ProviderVendor,
  zenTransportMode: ZenTransportMode = ZEN_TRANSPORT_MODE,
): Record<string, string> {
  const key = apiKey?.trim();
  if (!key || (vendor === ZEN_VENDOR && zenTransportMode === "v2" && key.toLowerCase() === "public")) {
    if (vendor === ZEN_VENDOR && zenTransportMode === "legacy") {
      return { Authorization: "Bearer public" };
    }
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
