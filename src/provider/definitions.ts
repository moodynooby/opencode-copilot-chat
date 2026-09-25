import * as vscode from "vscode";
import {
  appendApiPath,
  ANONYMOUS_ZEN_MODEL_IDS,
  CONFIG_SECTION,
  normalizeApiBaseUrl,
  OPEN_CODE_CLIENT,
  OPEN_CODE_GATEWAY_VERSION,
  SETTING_FREE_ONLY,
  ZEN_TRANSPORT_MODE,
  defaultZenApiBaseUrl,
  type ZenTransportMode,
} from "../config";
import { lookupModelRegistryEntry, type ModelEndpointKind } from "../core/registry";
import { isFreeModel } from "../models/metadata";
import type { ApiMessage } from "../request/types";
import { AGENT_GO_VENDOR, AGENT_ZEN_VENDOR, GO_VENDOR, ZEN_VENDOR, type AllProviderVendor } from "../providerTypes";

export type { ModelEndpointKind } from "../core/registry";

export interface ProviderDefinition {
  vendor: AllProviderVendor;
  displayName: string;
  modelNamePrefix: string;
  /** Model-catalog endpoint. */
  modelsUrl: string;
  chatCompletionsUrl: string;
  messagesUrl: string;
  responsesUrl?: string;
  /** Google Generative AI model base URL, including the provider prefix. */
  googleModelsUrl: string;
  testModelId: string;
  fallbackModels: string[];
  filterModel?: (modelId: string, apiKey?: string) => boolean;
  /** Source-selected Zen transport; omitted for Go. */
  zenTransportMode?: ZenTransportMode;
  /** When true, this provider only serves agent-host models (targetChatSessionType=copilotcli). */
  isAgentVariant?: boolean;
  /** The vendor key for the main (non-agent) provider definition this variant mirrors. */
  baseVendor?: typeof GO_VENDOR | typeof ZEN_VENDOR;
}

let cachedUserAgent: string | undefined;

/**
 * Build the OpenCode-compatible User-Agent string from the extension version.
 *
 * The request is intentionally identified as an OpenCode application so the
 * gateway can apply the same client/session handling as the real OpenCode CLI.
 * The gateway client version is deliberately independent of this extension's
 * package version; the public legacy tier currently requires OpenCode 1.18+.
 */
export function getUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;
  cachedUserAgent = `opencode/latest/${OPEN_CODE_GATEWAY_VERSION}/${OPEN_CODE_CLIENT}`;
  return cachedUserAgent;
}

/**
 * Classify a fetch error as transient (worth retrying) vs. permanent.
 *
 * Defined in `retry.ts` (the shared retry-decision module) and re-exported
 * here so existing importers keep working. See `retry.ts` for the rules and
 * the full implementation.
 */
export { isTransientFetchError } from "../retry";

/** Catalog entries that are not conversational chat models. */
const UNSUPPORTED_ZEN_MODEL_IDS = new Set(["test", "test-novita-dsf4.1"]);

/** Return whether a Zen catalog model can be served by this extension. */
export function isSupportedZenModel(modelId: string): boolean {
  return !UNSUPPORTED_ZEN_MODEL_IDS.has(modelId) && !/^jev-/i.test(modelId);
}

/**
 * Return whether a Zen model can be called without a Console key.
 *
 * The official OpenCode-compatible legacy gateway accepts the `public`
 * sentinel. In legacy mode, supported free models are eligible for anonymous
 * discovery; all except the verified seed model use the request-scoped real
 * read/shell tool bridge. The bridge maps whichever compatible capabilities
 * VS Code supplies, while restricted subagent tool sets retain their other
 * selected tools. The experimental V2 path retains its narrow seed allowlist
 * until its own client policy is verified.
 */
export function isAnonymousZenModel(modelId: string, mode: ZenTransportMode = ZEN_TRANSPORT_MODE): boolean {
  if (!isFreeModel(modelId) || !isSupportedZenModel(modelId)) return false;
  if (mode === "legacy") {
    // The legacy gateway accepts the verified anonymous model directly. Other
    // free models use the request-scoped read/shell compatibility bridge and
    // are still anonymous from the gateway's perspective.
    return true;
  }
  if (lookupModelRegistryEntry(modelId, ZEN_VENDOR).endpointKind !== "chat-completions") return false;
  return ANONYMOUS_ZEN_MODEL_IDS.has(modelId);
}

const ZEN_BRIDGE_TRANSPORT_MODES = new Set<ZenTransportMode>(["legacy", "v2"]);

/**
 * Whether a free Zen model needs the request-scoped real-tool bridge in the selected transport.
 * A restricted subagent request may use a pass-through-only bridge when it has no read/terminal binding.
 */
export function requiresZenToolBridge(modelId: string, mode: ZenTransportMode = ZEN_TRANSPORT_MODE): boolean {
  if (!ZEN_BRIDGE_TRANSPORT_MODES.has(mode)) return false;
  return isFreeModel(modelId) && isSupportedZenModel(modelId) && !ANONYMOUS_ZEN_MODEL_IDS.has(modelId);
}

function zenModelAllowed(modelId: string, apiKey: string | undefined, mode: ZenTransportMode): boolean {
  if (!isSupportedZenModel(modelId)) {
    return false;
  }

  const hasCredential = typeof apiKey === "string" && apiKey.trim().length > 0;
  if (!hasCredential && !isAnonymousZenModel(modelId, mode)) {
    return false;
  }

  const freeOnly = vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>(SETTING_FREE_ONLY, true);
  return !freeOnly || isFreeModel(modelId);
}

/** Create an agent-variant provider definition that inherits URLs, models, and filters from a base. */
function providerVariant(
  base: ProviderDefinition,
  agentVendor: typeof AGENT_GO_VENDOR | typeof AGENT_ZEN_VENDOR,
  displayName: string,
): ProviderDefinition {
  return {
    vendor: agentVendor,
    displayName,
    modelNamePrefix: base.modelNamePrefix,
    modelsUrl: base.modelsUrl,
    chatCompletionsUrl: base.chatCompletionsUrl,
    messagesUrl: base.messagesUrl,
    responsesUrl: base.responsesUrl,
    googleModelsUrl: base.googleModelsUrl,
    testModelId: base.testModelId,
    fallbackModels: base.fallbackModels,
    filterModel: base.filterModel,
    zenTransportMode: base.zenTransportMode,
  };
}

const ZEN_V2_FALLBACK_MODELS = [
  "big-pickle",
  "ling-3.0-flash-fin-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "space-bunny-free",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "gemini-3-flash",
  "gemini-3.1-pro",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "glm-5.3",
  "glm-5.3-flash",
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
  "grok-build-0.1",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "muse-spark-1.2",
  "muse-spark-1.3",
  "qwen3.5-plus",
  "qwen3.6-plus",
  "qwen3.8-flash",
];

/** Build provider definitions for the source-selected Zen transport. */
export function createProviderDefinitions(
  zenApiBaseUrl: string = defaultZenApiBaseUrl(),
  zenTransportMode: ZenTransportMode = ZEN_TRANSPORT_MODE,
): Record<ProviderDefinition["vendor"], ProviderDefinition> {
  const go: ProviderDefinition = {
    vendor: GO_VENDOR,
    displayName: "OpenCode Go",
    modelNamePrefix: "OpenCode Go",
    modelsUrl: "https://opencode.ai/zen/go/v1/models",
    chatCompletionsUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    messagesUrl: "https://opencode.ai/zen/go/v1/messages",
    responsesUrl: "https://opencode.ai/zen/go/v1/responses",
    googleModelsUrl: "https://opencode.ai/zen/go/v1/models",
    testModelId: "deepseek-v4-flash",
    fallbackModels: [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "grok-4.6",
      "hy3",
      "hy4-preview",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "longcat-2.0",
      "minimax-m2.7",
      "minimax-m3",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "omen-alpha",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
    ],
  };

  const zenBaseUrl = normalizeApiBaseUrl(zenApiBaseUrl, defaultZenApiBaseUrl(zenTransportMode));
  const zen: ProviderDefinition = {
    vendor: ZEN_VENDOR,
    displayName: "OpenCode Zen",
    modelNamePrefix: "OpenCode Zen",
    modelsUrl: appendApiPath(zenBaseUrl, "v1/models"),
    chatCompletionsUrl: appendApiPath(zenBaseUrl, zenTransportMode === "legacy" ? "v1/chat/completions" : "openai/v1/chat/completions"),
    messagesUrl: appendApiPath(zenBaseUrl, zenTransportMode === "legacy" ? "v1/messages" : "anthropic/v1/messages"),
    responsesUrl: appendApiPath(zenBaseUrl, zenTransportMode === "legacy" ? "v1/responses" : "openai/v1/responses"),
    googleModelsUrl: appendApiPath(zenBaseUrl, zenTransportMode === "legacy" ? "v1/models" : "google/v1beta/models"),
    testModelId: "space-bunny-free",
    fallbackModels: ZEN_V2_FALLBACK_MODELS,
    filterModel: (modelId, apiKey) => zenModelAllowed(modelId, apiKey, zenTransportMode),
    zenTransportMode,
  };

  return {
    [GO_VENDOR]: go,
    [ZEN_VENDOR]: zen,
    [AGENT_GO_VENDOR]: { ...providerVariant(go, AGENT_GO_VENDOR, "OpenCode Go (Agents)"), isAgentVariant: true, baseVendor: GO_VENDOR },
    [AGENT_ZEN_VENDOR]: {
      ...providerVariant(zen, AGENT_ZEN_VENDOR, "OpenCode Zen (Agents)"),
      isAgentVariant: true,
      baseVendor: ZEN_VENDOR,
    },
  };
}

export const PROVIDERS: Record<ProviderDefinition["vendor"], ProviderDefinition> = createProviderDefinitions();

export interface OpenCodeModel extends vscode.LanguageModelChatInformation {
  endpointKind: ModelEndpointKind;
  provider: ProviderDefinition;
  rawModelId?: string;
  isUserSelectable?: boolean;
  configurationSchema?: vscode.LanguageModelConfigurationSchema;
}

export interface ModelListEntry {
  id?: string;
  owned_by?: string;
  status?: string;
  deprecated?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  context_window?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  attachment?: boolean;
  image_input?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

export interface ModelListResponse {
  data?: ModelListEntry[];
}

export interface ConvertedMessageResult {
  messages: ApiMessage[];
  normalizedImageCount: number;
}

/**
 * Reasoning effort levels per model family, sourced from the upstream
 * OpenCode provider transform (anomalyco/opencode, packages/opencode/src/provider/transform.ts):
 *
 *   WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
 *   OPENAI_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"]
 *
 * For @ai-sdk/openai-compatible (Mimo, and most models routed through
 * chat-completions): the default is WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"].
 * DeepSeek V4 on openai-compatible additionally adds "max" → ["low", "medium", "high", "max"].
 */
export interface LanguageModelConfiguration {
  apiKey?: unknown;
}

export type ConfiguredLanguageModelInfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: LanguageModelConfiguration;
};

export type ConfiguredLanguageModelResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  configuration?: LanguageModelConfiguration;
};
