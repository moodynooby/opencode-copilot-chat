#!/usr/bin/env node
/**
 * probe-zen-tools.ts — Live OpenCode Zen tool-contract probe.
 *
 * Sends the same pinned read/terminal descriptors used by the extension and
 * verifies that the selected gateway/model can emit the expected tool call.
 * The probe never executes a returned tool; it only sends a minimal request.
 *
 * Credentials are read from OPENCODE_ZEN_API_KEY, falling back to
 * OPENCODE_API_KEY. Legacy mode may run anonymously when no key is present.
 * V2 mode requires a real Console key.
 *
 * Examples:
 *   OPENCODE_ZEN_API_KEY=... npm run probe-zen-tools -- --mode legacy --model gpt-5.6-luna
 *   OPENCODE_ZEN_API_KEY=... npm run probe-zen-tools -- --mode v2 --model gpt-5.6-luna
 *   OPENCODE_ZEN_API_KEY=... npm run probe-zen-tools -- --mode legacy --model gpt-5.6-luna --compare
 *   npm run probe-zen-tools -- --mode legacy --model gpt-5.6-luna --dry-run
 */

import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { FALLBACK_USER_AGENT, OPEN_CODE_CLIENT, appendApiPath, defaultZenApiBaseUrl, type ZenTransportMode } from "../src/config.js";
import { buildOpenCodeGatewayAuthHeaders } from "../src/openCodeAuth.js";
import { zenToolProfile, type ZenToolProfile } from "../src/provider/zenToolContracts.js";
import { sanitizeToolSchema } from "../src/request/schema.js";

type EndpointKind = "responses" | "chat";
type ProbeMode = ZenTransportMode | "both";
type ToolTarget = "read" | "terminal";
type ProbeVariant = "expected" | "control";

interface CliOptions {
  readonly mode: ProbeMode;
  readonly model: string;
  readonly endpoint: EndpointKind;
  readonly target: ToolTarget | "all";
  readonly compare: boolean;
  readonly yes: boolean;
  readonly allowHttp: boolean;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly json: boolean;
  readonly dryRun: boolean;
}

interface ResponsesWireTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
}

interface ChatWireTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: object;
  };
}

type WireTool = ResponsesWireTool | ChatWireTool;

interface ProbeCall {
  readonly name: string;
  readonly arguments: unknown;
  readonly id?: string;
}

interface ProbeResult {
  readonly mode: ZenTransportMode;
  readonly endpoint: EndpointKind;
  readonly target: ToolTarget;
  readonly variant: ProbeVariant;
  readonly toolName: string;
  readonly status: "pass" | "fail" | "dry-run";
  readonly httpStatus: number;
  readonly durationMs: number;
  readonly calls: Array<{ name: string; argumentKeys: string[]; valid: boolean }>;
  readonly request?: {
    readonly url: string;
    readonly body: Record<string, unknown>;
    readonly headers: Record<string, string>;
  };
  readonly error?: string;
}

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "legacy" },
    model: { type: "string" },
    endpoint: { type: "string", default: "responses" },
    tool: { type: "string", default: "all" },
    compare: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    "allow-http": { type: "boolean", default: false },
    timeout: { type: "string", default: "45000" },
    "max-output-tokens": { type: "string", default: "32" },
    "base-url": { type: "string" },
    json: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
} as const);

function usage(): string {
  return `
Live OpenCode Zen tool-contract probe

Usage:
  npm run probe-zen-tools -- --model MODEL [options]

Options:
  --mode legacy|v2|both       Transport profile (default: legacy)
  --model MODEL               Model ID to call (required)
  --endpoint responses|chat   Gateway API shape (default: responses)
  --tool read|terminal|all    Contract(s) to force (default: all)
  --compare                   Also probe the other terminal name
  --yes                       Confirm a multi-request live run
  --base-url URL              Override the selected gateway base URL
  --allow-http                Allow an explicit HTTP base URL
  --timeout MS                Request timeout (default: 45000)
  --max-output-tokens N       Small output budget (default: 32)
  --json                      Emit machine-readable results
  --dry-run                   Print redacted request plans without sending
  -h, --help                  Show this help

Credentials:
  OPENCODE_ZEN_API_KEY        Preferred Zen/Console key
  OPENCODE_API_KEY             Fallback key
  OPENCODE_ZEN_URL             Optional base URL override (HTTPS)

V2 requires a real key. Legacy can use the public anonymous sentinel.
A run with more than one request requires --yes. Returned tool calls are
reported but never executed.
`;
}

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function validateBaseUrl(value: string | undefined, allowHttp: boolean): void {
  if (!value) return;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--base-url/OPENCODE_ZEN_URL must not contain credentials, query parameters, or a fragment.");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new Error("Live probe URLs must use HTTPS. Pass --allow-http only for a trusted local/staging endpoint.");
  }
}

function booleanOption(value: string | boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseMode(value: string | undefined): ProbeMode {
  if (value === undefined || value === "legacy" || value === "v2" || value === "both") return value ?? "legacy";
  throw new Error(`Invalid --mode ${JSON.stringify(value)}; use legacy, v2, or both.`);
}

function parseEndpoint(value: string | undefined): EndpointKind {
  if (value === undefined || value === "responses" || value === "chat") return value ?? "responses";
  throw new Error(`Invalid --endpoint ${JSON.stringify(value)}; use responses or chat.`);
}

function parseTarget(value: string | undefined): ToolTarget | "all" {
  if (value === undefined || value === "all" || value === "read" || value === "terminal") return value ?? "all";
  throw new Error(`Invalid --tool ${JSON.stringify(value)}; use read, terminal, or all.`);
}

function parseBoundedInteger(value: string | undefined, name: string, minimum: number, maximum: number, fallback: number): number {
  const raw = value ?? String(fallback);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid --${name} ${JSON.stringify(raw)}; expected an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return parsed;
}

function readCliOptions(): CliOptions {
  const model = stringOption(args.model);
  if (!model) throw new Error("--model is required. Use --help for examples.");
  const mode = parseMode(stringOption(args.mode));
  const baseUrl = firstNonEmpty(stringOption(args["base-url"]), stringOption(process.env.OPENCODE_ZEN_URL));
  const allowHttp = booleanOption(args["allow-http"], false);
  validateBaseUrl(baseUrl, allowHttp);
  if (mode === "both" && baseUrl) {
    throw new Error("A custom --base-url/OPENCODE_ZEN_URL cannot be shared by legacy and v2; run the modes separately.");
  }
  return {
    mode,
    model,
    endpoint: parseEndpoint(stringOption(args.endpoint)),
    target: parseTarget(stringOption(args.tool)),
    compare: booleanOption(args.compare, false),
    yes: booleanOption(args.yes, false),
    allowHttp,
    timeoutMs: parseBoundedInteger(stringOption(args.timeout), "timeout", 1000, 300_000, 45_000),
    maxOutputTokens: parseBoundedInteger(stringOption(args["max-output-tokens"]), "max-output-tokens", 1, 256, 32),
    baseUrl,
    apiKey: firstNonEmpty(stringOption(process.env.OPENCODE_ZEN_API_KEY), stringOption(process.env.OPENCODE_API_KEY)),
    json: booleanOption(args.json, false),
    dryRun: booleanOption(args["dry-run"], false),
  };
}

function modesFor(mode: ProbeMode): ZenTransportMode[] {
  return mode === "both" ? ["legacy", "v2"] : [mode];
}

function targetsFor(target: CliOptions["target"]): ToolTarget[] {
  return target === "all" ? ["read", "terminal"] : [target];
}

function profileFor(mode: ZenTransportMode): ZenToolProfile {
  return zenToolProfile(mode);
}

function terminalName(mode: ZenTransportMode, variant: ProbeVariant): string {
  if (variant === "expected") return profileFor(mode).shell.name;
  return mode === "legacy" ? "shell" : "bash";
}

// Use the extension's pinned profile objects verbatim; the live probe must
// observe the same descriptors the extension sends, not a newer upstream branch.
function toolsFor(mode: ZenTransportMode, variant: ProbeVariant, endpoint: EndpointKind): WireTool[] {
  const profile = profileFor(mode);
  const tools = [profile.read, { ...profile.shell, name: terminalName(mode, variant) }];
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema),
  }));
  return endpoint === "responses"
    ? definitions.map((tool) => ({ type: "function", ...tool }))
    : definitions.map((tool) => ({ type: "function", function: tool }));
}

function endpointUrl(mode: ZenTransportMode, endpoint: EndpointKind, baseUrl: string | undefined): string {
  const base = (baseUrl ?? defaultZenApiBaseUrl(mode)).replace(/\/+$/, "");
  const route =
    endpoint === "responses"
      ? mode === "legacy"
        ? "v1/responses"
        : "openai/v1/responses"
      : mode === "legacy"
        ? "v1/chat/completions"
        : "openai/v1/chat/completions";
  return appendApiPath(base, route);
}

function toolChoice(endpoint: EndpointKind, name: string): Record<string, unknown> {
  return endpoint === "responses" ? { type: "function", name } : { type: "function", function: { name } };
}

function promptFor(mode: ZenTransportMode, target: ToolTarget, name: string): string {
  const readInstruction =
    mode === "legacy"
      ? `Call the read tool with filePath="/tmp/zen-tool-probe.txt", offset=1, and limit=1.`
      : `Call the read tool with path="/tmp/zen-tool-probe.txt", offset=1, and limit=1.`;
  const terminalInstruction =
    mode === "legacy"
      ? `Call the ${name} tool with command="printf zen-tool-probe" and timeout=1000.`
      : `Call the ${name} tool with command="printf zen-tool-probe", timeout=1000, and background=false.`;
  const instruction = target === "read" ? readInstruction : terminalInstruction;
  return `This is a live tool-contract probe. Call exactly one function named ${name}; do not answer with text. ${instruction}`;
}

function stableProjectKey(mode: ZenTransportMode, model: string): string {
  return createHash("sha256").update(`zen-tool-probe:${mode}:${model}`).digest("hex");
}

function requestBody(
  options: CliOptions,
  mode: ZenTransportMode,
  target: ToolTarget,
  variant: ProbeVariant,
  toolName: string,
): Record<string, unknown> {
  const tools = toolsFor(mode, variant, options.endpoint);
  const common = {
    model: options.model,
    stream: false,
    tools,
    tool_choice: toolChoice(options.endpoint, toolName),
    prompt_cache_key: stableProjectKey(mode, options.model),
  };
  if (options.endpoint === "responses") {
    return {
      ...common,
      input: promptFor(mode, target, toolName),
      max_output_tokens: options.maxOutputTokens,
      truncation: "auto",
    };
  }
  return {
    ...common,
    messages: [{ role: "user", content: promptFor(mode, target, toolName) }],
    max_tokens: options.maxOutputTokens,
  };
}

function requestHeaders(options: CliOptions, mode: ZenTransportMode): Record<string, string> {
  const sessionId = `ses_${randomBytes(13).toString("hex")}`;
  const requestId = `msg_${randomBytes(13).toString("hex")}`;
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const parentId = randomBytes(8).toString("hex");
  const endpointKind = options.endpoint === "responses" ? "responses" : "chat-completions";
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...buildOpenCodeGatewayAuthHeaders(endpointKind, options.apiKey, "opencodezen", mode),
    "User-Agent": FALLBACK_USER_AGENT,
    "x-opencode-client": OPEN_CODE_CLIENT,
    "x-opencode-session": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    "x-opencode-request": requestId,
    "x-opencode-project": stableProjectKey(mode, options.model),
    b3: `${traceId}-${spanId}-1-${parentId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function redactedHeaders(headers: Record<string, string>, secret: string | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      name.toLowerCase() === "authorization" || Boolean(secret && value.includes(secret)) ? "<redacted>" : value,
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const events = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line.length > 0 && line !== "[DONE]")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    return events;
  }
}

function addCall(value: unknown, calls: ProbeCall[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) addCall(item, calls, seen);
    return;
  }
  if (!isRecord(value)) return;

  if (value.type === "function_call" && typeof value.name === "string") {
    const id = typeof value.call_id === "string" ? value.call_id : typeof value.id === "string" ? value.id : undefined;
    const key = `${id ?? ""}|${value.name}|${JSON.stringify(value.arguments ?? null)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({ name: value.name, arguments: decodeArguments(value.arguments), ...(id ? { id } : {}) });
    }
  }

  if (isRecord(value.function) && typeof value.function.name === "string") {
    const name = value.function.name;
    const id = typeof value.id === "string" ? value.id : undefined;
    const key = `${id ?? ""}|${name}|${JSON.stringify(value.function.arguments ?? null)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({ name, arguments: decodeArguments(value.function.arguments), ...(id ? { id } : {}) });
    }
  }

  for (const child of Object.values(value)) addCall(child, calls, seen);
}

function decodeArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function extractCalls(payload: unknown): ProbeCall[] {
  const calls: ProbeCall[] = [];
  addCall(payload, calls, new Set());
  return calls;
}

function argumentKeys(argumentsValue: unknown): string[] {
  return isRecord(argumentsValue) ? Object.keys(argumentsValue).sort() : [];
}

function validateCall(mode: ZenTransportMode, target: ToolTarget, call: ProbeCall): string | undefined {
  if (!isRecord(call.arguments)) return "arguments are not an object";
  if (target === "read") {
    const pathKey = mode === "legacy" ? "filePath" : "path";
    if (typeof call.arguments[pathKey] !== "string") return `${pathKey} is missing or not a string`;
    for (const key of ["offset", "limit"]) {
      const value = call.arguments[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) return `${key} is invalid`;
    }
    return undefined;
  }
  if (typeof call.arguments.command !== "string") return "command is missing or not a string";
  if (call.arguments.workdir !== undefined && typeof call.arguments.workdir !== "string") return "workdir is not a string";
  if (
    call.arguments.timeout !== undefined &&
    (!Number.isSafeInteger(call.arguments.timeout) || (call.arguments.timeout as number) < (mode === "legacy" ? 1 : 0))
  ) {
    return "timeout is invalid";
  }
  if (mode === "legacy" && call.arguments.background !== undefined) return "legacy background is unsupported";
  if (mode === "v2" && call.arguments.background !== undefined && typeof call.arguments.background !== "boolean") {
    return "background is not a boolean";
  }
  return undefined;
}

function errorMessage(payload: unknown, text: string): string | undefined {
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof payload.message === "string") return payload.message;
  }
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
}

function safeMessage(value: string | undefined, secret: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = secret ? value.split(secret).join("<redacted>") : value;
  return redacted.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function summarizeCalls(calls: ProbeCall[], mode: ZenTransportMode, target: ToolTarget): ProbeResult["calls"] {
  return calls.map((call) => ({
    name: call.name,
    argumentKeys: argumentKeys(call.arguments),
    valid: validateCall(mode, target, call) === undefined,
  }));
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe(options: CliOptions, mode: ZenTransportMode, target: ToolTarget, variant: ProbeVariant): Promise<ProbeResult> {
  const name = target === "read" ? profileFor(mode).read.name : terminalName(mode, variant);
  const url = endpointUrl(mode, options.endpoint, options.baseUrl);
  const body = requestBody(options, mode, target, variant, name);
  const headers = requestHeaders(options, mode);
  if (options.dryRun) {
    return {
      mode,
      endpoint: options.endpoint,
      target,
      variant,
      toolName: name,
      status: "dry-run",
      httpStatus: 0,
      durationMs: 0,
      calls: [],
      request: { url, body, headers: redactedHeaders(headers, options.apiKey) },
    };
  }

  const started = Date.now();
  try {
    const response = await fetchText(url, headers, body, options.timeoutMs);
    const payload = parsePayload(response.text);
    const calls = extractCalls(payload);
    const matching = calls.filter((call) => call.name === name);
    const validMatch = matching.find((call) => validateCall(mode, target, call) === undefined);
    const firstMatch = matching.at(0);
    const validationError =
      validMatch !== undefined
        ? undefined
        : firstMatch === undefined
          ? `no tool call named ${name} was returned`
          : (validateCall(mode, target, firstMatch) ?? "tool call arguments were invalid");
    const error =
      response.status < 200 || response.status >= 300
        ? `HTTP ${String(response.status)}: ${safeMessage(errorMessage(payload, response.text), options.apiKey) ?? "request failed"}`
        : validationError;
    return {
      mode,
      endpoint: options.endpoint,
      target,
      variant,
      toolName: name,
      status: error ? "fail" : "pass",
      httpStatus: response.status,
      durationMs: Date.now() - started,
      calls: summarizeCalls(calls, mode, target),
      ...(error ? { error } : {}),
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? `timeout after ${String(options.timeoutMs)}ms` : String(error);
    return {
      mode,
      endpoint: options.endpoint,
      target,
      variant,
      toolName: name,
      status: "fail",
      httpStatus: 0,
      durationMs: Date.now() - started,
      calls: [],
      error: safeMessage(message, options.apiKey) ?? "request failed",
    };
  }
}

function printHuman(results: ProbeResult[], options: CliOptions): void {
  for (const result of results) {
    const label = `${result.mode}/${result.endpoint}/${result.target}/${result.variant}`;
    if (result.status === "dry-run") {
      console.log(
        `DRY-RUN ${label}: ${result.request?.url ?? endpointUrl(result.mode, result.endpoint, options.baseUrl)} tool=${result.toolName}`,
      );
      if (result.request) console.log(JSON.stringify({ body: result.request.body, headers: result.request.headers }, null, 2));
      continue;
    }
    const calls = result.calls.length > 0 ? result.calls.map((call) => `${call.name}{${call.argumentKeys.join(",")}}`).join(", ") : "none";
    const suffix = result.error ? ` — ${result.error}` : "";
    console.log(
      `${result.status === "pass" ? "PASS" : "FAIL"} ${label} HTTP=${String(result.httpStatus)} ${String(result.durationMs)}ms calls=${calls}${suffix}`,
    );
  }
}

async function main(): Promise<void> {
  if (booleanOption(args.help, false)) {
    console.log(usage());
    return;
  }
  const options = readCliOptions();
  const modes = modesFor(options.mode);
  const targets = targetsFor(options.target);
  const controlCount = options.compare && targets.includes("terminal") ? modes.length : 0;
  const plannedRequests = modes.length * targets.length + controlCount;
  if (!options.dryRun && modes.includes("v2") && (!options.apiKey || options.apiKey.toLowerCase() === "public")) {
    throw new Error("V2 live probing requires OPENCODE_ZEN_API_KEY (the public sentinel is not accepted by the V2 gateway).");
  }
  console.error(`Planned live requests: ${String(plannedRequests)}${options.dryRun ? " (dry-run; none will be sent)" : ""}.`);
  if (!options.dryRun && plannedRequests > 1 && !options.yes) {
    console.error("Refusing a multi-request live run without --yes; re-run with --yes after checking model/quota cost.");
    process.exitCode = 2;
    return;
  }

  const results: ProbeResult[] = [];
  for (const mode of modes) {
    for (const target of targets) {
      results.push(await runProbe(options, mode, target, "expected"));
      if (options.compare && target === "terminal") results.push(await runProbe(options, mode, target, "control"));
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ probes: results }, null, 2));
  } else {
    printHuman(results, options);
  }
  if (results.some((result) => result.status === "fail")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
