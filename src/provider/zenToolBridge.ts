/**
 * @fileoverview Safe compatibility bridge between selected Copilot tools and
 * the OpenCode tool contracts required by the Zen gateway.
 *
 * The bridge never executes a tool. It replaces a selected read or terminal
 * descriptor with its pinned OpenCode wire contract when a compatible real
 * Copilot binding exists, preserves all other selected tools (including
 * subagents), and maps mapped calls back to the original VS Code tool names so
 * VS Code remains the executor. Missing capabilities are not synthesized.
 */

import * as vscode from "vscode";
import { ZEN_TRANSPORT_MODE, type ZenTransportMode } from "../config";
import { ZenToolBridgeError } from "../errors";
import type { ApiMessage } from "../request/types";
import { isRecord } from "../utils";
import { zenToolProfile, type ZenToolName, type ZenToolProfile } from "./zenToolContracts";

const READ_ALIAS_NAMES = new Set(["read", "readfile", "read_file", "vscodereadfile", "copilotreadfile", "fileread", "readworkspacefile"]);
const ZEN_WIRE_NAMES = new Set<string>(["read", "bash", "shell"]);

const SHELL_ALIAS_NAMES = new Set([
  "shell",
  "bash",
  "terminal",
  "runinterminal",
  "runterminal",
  "runterminalcommand",
  "runinterminalcommand",
  "executecommand",
  "runcommand",
]);

const READ_START_PROPERTIES = ["offset", "startLine", "lineStart"] as const;
const READ_END_PROPERTIES = ["limit", "endLine", "lineEnd"] as const;
const READ_REPRESENTABLE_PROPERTIES = new Set(["filePath", "path", ...READ_START_PROPERTIES, ...READ_END_PROPERTIES]);
/**
 * VS Code's `mode` ("sync" | "async") is the canonical execution-mode switch and
 * replaced the legacy `isBackground` boolean. `background` is OpenCode's spelling
 * of the same intent, so all three are ordered canonical-first when choosing a
 * host target.
 */
const SHELL_BACKGROUND_PROPERTIES = ["mode", "background", "isBackground"] as const;
const SHELL_REPRESENTABLE_PROPERTIES = new Set([
  "command",
  "workdir",
  "cwd",
  "timeout",
  "explanation",
  "goal",
  ...SHELL_BACKGROUND_PROPERTIES,
]);
const READ_STRING_PROPERTIES = new Set(["filePath", "path"]);
const SHELL_STRING_PROPERTIES = new Set(["command", "explanation", "goal", "mode", "workdir", "cwd"]);
const SHELL_BOOLEAN_PROPERTIES = new Set(["background", "isBackground"]);
const DEFAULT_READ_OFFSET = 1;
const DEFAULT_READ_LIMIT = 2000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_COMMAND_DESCRIPTION_LENGTH = 120;

function effectiveReadOffset(profile: ZenToolProfile, value: number): number {
  return profile.zeroReadOffsetUsesDefault && value === 0 ? DEFAULT_READ_OFFSET : value;
}

function effectiveReadLimit(profile: ZenToolProfile, value: number): number {
  const normalized = profile.zeroReadLimitUsesDefault && value === 0 ? DEFAULT_READ_LIMIT : value;
  return profile.maxReadLimit === undefined ? normalized : Math.min(normalized, profile.maxReadLimit);
}

type BridgeCapability = "read" | "shell";
type WireToolName = ZenToolName;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function safeToolName(name: string): string {
  const trimmed = name.trim();
  return /^[a-zA-Z0-9_.:-]{1,64}$/.test(trimmed) ? trimmed : "unknown";
}

function toolBridgeError(name: string, actualName: string | undefined): ZenToolBridgeError {
  const displayName = safeToolName(name);
  const reason = actualName
    ? `the arguments did not match the selected \`${safeToolName(actualName)}\` tool`
    : "the selected tool was not available to this request";
  const message = `OpenCode Zen tool bridge rejected model call '${displayName}': ${reason}.`;
  const userMessage =
    `OpenCode Zen could not safely execute the model's ${displayName} tool call because ${reason}. ` +
    "The rejected call was not executed. Retry the request; do not assume any later tool call ran.";
  return new ZenToolBridgeError(message, userMessage);
}

function historyBridgeError(name: string, actualName: string | undefined): ZenToolBridgeError {
  const displayName = safeToolName(name);
  const selected = actualName ? `selected \`${safeToolName(actualName)}\` tool` : "selected tool";
  return new ZenToolBridgeError(
    `OpenCode Zen tool bridge could not safely rewrite '${displayName}' history for the ${selected}.`,
    `OpenCode Zen could not safely rewrite the ${displayName} tool-call history for the ${selected}. The request was not sent; start a new conversation and retry.`,
  );
}

interface ToolBinding {
  readonly capability: BridgeCapability;
  readonly wireName: WireToolName;
  readonly actual: vscode.LanguageModelChatTool;
}

export interface ZenToolBridge {
  /** Tool descriptors sent to the gateway, including the selected OpenCode contracts. */
  readonly tools: vscode.LanguageModelChatTool[];
  /** Map an OpenCode wire name to the actual VS Code tool name. */
  readonly officialToActual: ReadonlyMap<string, string>;
  /** Map an actual VS Code tool name back to its OpenCode wire name. */
  readonly actualToOfficial: ReadonlyMap<string, string>;
  /** Rewrite assistant tool-call history atomically, throwing before dispatch on an unsafe selected call. */
  rewriteApiMessages(messages: ApiMessage[]): void;
  /** Translate one model tool call, or return undefined when it is unsafe. */
  mapToolCall(name: string, input: unknown): { name: string; input: object } | undefined;
  /** Wrap VS Code progress so mapped calls are returned under real names. */
  wrapProgress(progress: vscode.Progress<vscode.LanguageModelResponsePart2>): vscode.Progress<vscode.LanguageModelResponsePart2>;
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function schemaProperties(tool: vscode.LanguageModelChatTool): ReadonlySet<string> {
  if (!isObjectRecord(tool.inputSchema) || !isObjectRecord(tool.inputSchema.properties)) {
    return new Set();
  }
  return new Set(Object.keys(tool.inputSchema.properties));
}

function propertySchema(tool: vscode.LanguageModelChatTool, property: string): Record<string, unknown> | undefined {
  if (!isObjectRecord(tool.inputSchema) || !isObjectRecord(tool.inputSchema.properties)) return undefined;
  const schema = tool.inputSchema.properties[property];
  return isObjectRecord(schema) ? schema : undefined;
}

function jsonSchemaTypeAcceptsValue(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  if (typeof type === "string") {
    if (type === "null") return value === null;
    if (type === "string") return typeof value === "string";
    if (type === "boolean") return typeof value === "boolean";
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return isObjectRecord(value);
    return false;
  }
  if (Array.isArray(type)) return type.some((candidate) => jsonSchemaTypeAcceptsValue(candidate, value));
  return false;
}

function schemaAcceptsValue(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.allOf) && !schema.allOf.every((part) => isObjectRecord(part) && schemaAcceptsValue(part, value))) {
    return false;
  }
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (alternatives && !alternatives.some((alternative) => isObjectRecord(alternative) && schemaAcceptsValue(alternative, value))) {
    return false;
  }
  if (!jsonSchemaTypeAcceptsValue(schema.type, value)) return false;

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
  }
  if (Object.hasOwn(schema, "const") && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  return true;
}

function schemaTypeIsCompatible(schema: Record<string, unknown>, property: string): boolean {
  if (Array.isArray(schema.allOf) && !schema.allOf.every((part) => isObjectRecord(part) && schemaTypeIsCompatible(part, property))) {
    return false;
  }
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  if (alternatives) {
    return alternatives.some((alternative) => isObjectRecord(alternative) && schemaTypeIsCompatible(alternative, property));
  }

  const type = schema.type;
  if (type === undefined) return true;
  const expected = SHELL_BOOLEAN_PROPERTIES.has(property)
    ? "boolean"
    : READ_STRING_PROPERTIES.has(property) || SHELL_STRING_PROPERTIES.has(property)
      ? "string"
      : "number";
  if (typeof type === "string") return type === expected || (expected === "number" && type === "integer");
  if (Array.isArray(type)) return type.includes(expected) || (expected === "number" && type.includes("integer"));
  return false;
}

/**
 * Derive the host's approval-UI text from the command that will really run.
 * This invents no intent: the text is a literal slice of the exact command
 * VS Code is about to execute, so the user approves what actually runs.
 * Returns undefined for a command with no non-empty line, which is never a
 * safe call to forward.
 */
function describeCommand(command: string): string | undefined {
  const firstLine = command
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) {
    return undefined;
  }
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > MAX_COMMAND_DESCRIPTION_LENGTH ? `${collapsed.slice(0, MAX_COMMAND_DESCRIPTION_LENGTH - 1)}…` : collapsed;
}

function knownInputIsValid(tool: vscode.LanguageModelChatTool, input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([property, value]) => {
    const schema = propertySchema(tool, property);
    return schema === undefined || schemaAcceptsValue(schema, value);
  });
}

function translatedInputIsValid(tool: vscode.LanguageModelChatTool, input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([property, value]) => {
    const schema = propertySchema(tool, property);
    return schema !== undefined && schemaAcceptsValue(schema, value);
  });
}

function requiredProperties(tool: vscode.LanguageModelChatTool): readonly string[] {
  if (!isObjectRecord(tool.inputSchema) || !Array.isArray(tool.inputSchema.required)) {
    return [];
  }
  return tool.inputSchema.required.filter((property): property is string => typeof property === "string");
}

function hasRequiredProperties(tool: vscode.LanguageModelChatTool, input: Record<string, unknown>): boolean {
  return requiredProperties(tool).every((property) => input[property] !== undefined);
}

function bindingIsRepresentable(binding: ToolBinding): boolean {
  const representable = binding.capability === "read" ? READ_REPRESENTABLE_PROPERTIES : SHELL_REPRESENTABLE_PROPERTIES;
  const properties = schemaProperties(binding.actual);
  const required = requiredProperties(binding.actual);
  if (required.some((property) => !representable.has(property))) return false;

  if (binding.capability === "read") {
    const pathProperties = ["filePath", "path"].filter((property) => properties.has(property));
    const startProperties = READ_START_PROPERTIES.filter((property) => properties.has(property));
    const endProperties = READ_END_PROPERTIES.filter((property) => properties.has(property));
    const requiredPathCount = pathProperties.filter((property) => required.includes(property)).length;
    const requiredStartCount = startProperties.filter((property) => required.includes(property)).length;
    const requiredEndCount = endProperties.filter((property) => required.includes(property)).length;
    if (
      (pathProperties.length > 1 && (requiredPathCount > 1 || requiredPathCount === 0)) ||
      (startProperties.length > 1 && (requiredStartCount > 1 || requiredStartCount === 0)) ||
      (endProperties.length > 1 && (requiredEndCount > 1 || requiredEndCount === 0))
    ) {
      return false;
    }
  } else {
    const workdirProperties = ["workdir", "cwd"].filter((property) => properties.has(property));
    const backgroundProperties = SHELL_BACKGROUND_PROPERTIES.filter((property) => properties.has(property));
    const requiredWorkdirCount = workdirProperties.filter((property) => required.includes(property)).length;
    const requiredBackgroundCount = backgroundProperties.filter((property) => required.includes(property)).length;
    if (
      (workdirProperties.length > 1 && (requiredWorkdirCount > 1 || requiredWorkdirCount === 0)) ||
      (backgroundProperties.length > 1 && (requiredBackgroundCount > 1 || requiredBackgroundCount === 0))
    ) {
      return false;
    }
  }

  return [...representable].every((property) => {
    if (!properties.has(property)) return true;
    const schema = propertySchema(binding.actual, property);
    return schema !== undefined && schemaTypeIsCompatible(schema, property);
  });
}

function bindingCandidates(
  tools: readonly vscode.LanguageModelChatTool[],
  capability: BridgeCapability,
): readonly vscode.LanguageModelChatTool[] {
  const aliases = capability === "read" ? READ_ALIAS_NAMES : SHELL_ALIAS_NAMES;
  const anchorProperties = capability === "read" ? ["filePath", "path"] : ["command"];
  return tools.filter((tool) => {
    if (!aliases.has(normalizeToolName(tool.name))) {
      return false;
    }
    const properties = schemaProperties(tool);
    return anchorProperties.some((property) => properties.has(property));
  });
}

function findBinding(
  tools: readonly vscode.LanguageModelChatTool[],
  profile: ZenToolProfile,
  capability: BridgeCapability,
): ToolBinding | undefined {
  const wireName = (capability === "read" ? profile.read.name : profile.shell.name) as ZenToolName;
  const candidates = bindingCandidates(tools, capability);

  // Never guess between multiple real tools. An exact wire-name match is not
  // enough if another plausible tool is also present.
  if (candidates.length !== 1) {
    return undefined;
  }

  const binding: ToolBinding = { capability, wireName, actual: candidates[0] };
  return bindingIsRepresentable(binding) ? binding : undefined;
}

function stringProperty(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" ? value : undefined;
}

function numberProperty(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasInvalidInteger(input: Record<string, unknown>, name: string, minimum = 0): boolean {
  if (input[name] === undefined) return false;
  const value = numberProperty(input, name);
  return value === undefined || !Number.isSafeInteger(value) || value < minimum || value > MAX_SAFE_INTEGER;
}

function hasInvalidString(input: Record<string, unknown>, name: string): boolean {
  return input[name] !== undefined && typeof input[name] !== "string";
}

function hasInvalidBoolean(input: Record<string, unknown>, name: string): boolean {
  return input[name] !== undefined && typeof input[name] !== "boolean";
}

function booleanProperty(input: Record<string, unknown>, name: string): boolean | undefined {
  const value = input[name];
  return typeof value === "boolean" ? value : undefined;
}

function chooseTargetProperty(
  properties: ReadonlySet<string>,
  required: ReadonlySet<string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((property) => required.has(property)) ?? candidates.find((property) => properties.has(property));
}

function consistentString(input: Record<string, unknown>, names: readonly string[]): string | undefined {
  const values = names.map((name) => stringProperty(input, name)).filter((value): value is string => value !== undefined);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function consistentNumber(input: Record<string, unknown>, names: readonly string[]): number | undefined {
  const values = names.map((name) => numberProperty(input, name)).filter((value): value is number => value !== undefined);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function consistentBoolean(input: Record<string, unknown>, names: readonly string[]): boolean | undefined {
  const values = names.map((name) => booleanProperty(input, name)).filter((value): value is boolean => value !== undefined);
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

function normalizeReadWireInput(profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(input) || Object.keys(input).some((key) => ![profile.readPathProperty, "offset", "limit"].includes(key))) {
    return undefined;
  }
  if (hasInvalidInteger(input, "offset") || hasInvalidInteger(input, "limit")) {
    return undefined;
  }
  const path = stringProperty(input, profile.readPathProperty);
  if (path === undefined) return undefined;
  const normalized: Record<string, unknown> = { [profile.readPathProperty]: path };
  const offset = numberProperty(input, "offset");
  const limit = numberProperty(input, "limit");
  if (offset !== undefined) normalized.offset = effectiveReadOffset(profile, offset);
  if (limit !== undefined) normalized.limit = effectiveReadLimit(profile, limit);
  return normalized;
}

function normalizeShellWireInput(profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  const allowedProperties = ["command", "workdir", "timeout", ...(profile.supportsBackgroundShell ? ["background"] : [])];
  if (
    !isObjectRecord(input) ||
    Object.keys(input).some((key) => !allowedProperties.includes(key)) ||
    hasInvalidString(input, "command") ||
    hasInvalidString(input, "workdir") ||
    hasInvalidBoolean(input, "background") ||
    hasInvalidInteger(input, "timeout", profile.supportsBackgroundShell ? 0 : 1)
  ) {
    return undefined;
  }
  const command = stringProperty(input, "command");
  if (command === undefined) return undefined;
  const background = booleanProperty(input, "background");
  if (background !== undefined && !profile.supportsBackgroundShell) return undefined;
  const normalized: Record<string, unknown> = { command };
  const workdir = stringProperty(input, "workdir");
  const timeout = numberProperty(input, "timeout");
  if (workdir !== undefined) normalized.workdir = workdir;
  if (timeout !== undefined) normalized.timeout = timeout;
  if (background !== undefined) normalized.background = background;
  return normalized;
}

function translateReadInput(binding: ToolBinding, profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  const canonical = normalizeReadWireInput(profile, input);
  if (!canonical) return undefined;
  const path = stringProperty(canonical, profile.readPathProperty);
  const offset = numberProperty(canonical, "offset");
  const limit = numberProperty(canonical, "limit");
  if (path === undefined) return undefined;

  const properties = schemaProperties(binding.actual);
  const required = new Set(requiredProperties(binding.actual));
  const requiredPaths = ["filePath", "path"].filter((property) => required.has(property));
  const requiredStarts = READ_START_PROPERTIES.filter((property) => required.has(property));
  const requiredEnds = READ_END_PROPERTIES.filter((property) => required.has(property));
  if (requiredPaths.length > 1 || requiredStarts.length > 1 || requiredEnds.length > 1) {
    return undefined;
  }

  const translated: Record<string, unknown> = {};
  const pathTarget = chooseTargetProperty(properties, required, ["filePath", "path"]);
  if (!pathTarget) {
    return undefined;
  }
  translated[pathTarget] = path;

  const supportsStart = READ_START_PROPERTIES.some((property) => properties.has(property));
  const supportsEnd = READ_END_PROPERTIES.some((property) => properties.has(property));
  const hasRangeInput = offset !== undefined || limit !== undefined;
  if (hasRangeInput && !supportsStart && !supportsEnd) {
    return undefined;
  }

  const normalizedOffset = offset ?? (requiredStarts.length > 0 ? DEFAULT_READ_OFFSET : undefined);
  if (normalizedOffset !== undefined) {
    const startTarget = chooseTargetProperty(properties, required, READ_START_PROPERTIES);
    if (!startTarget) return undefined;
    translated[startTarget] = normalizedOffset;
  }

  const normalizedLimit = limit ?? (requiredEnds.length > 0 ? DEFAULT_READ_LIMIT : undefined);
  if (normalizedLimit !== undefined) {
    const endTarget = chooseTargetProperty(properties, required, READ_END_PROPERTIES);
    if (!endTarget) return undefined;
    if (endTarget === "limit") translated.limit = normalizedLimit;
    else {
      if (normalizedLimit === 0) return undefined;
      translated[endTarget] = (normalizedOffset ?? DEFAULT_READ_OFFSET) + normalizedLimit - 1;
    }
  }

  return hasRequiredProperties(binding.actual, translated) && translatedInputIsValid(binding.actual, translated) ? translated : undefined;
}

function translateShellInput(binding: ToolBinding, profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  const canonical = normalizeShellWireInput(profile, input);
  if (!canonical) return undefined;
  const command = stringProperty(canonical, "command");
  const timeout = numberProperty(canonical, "timeout");
  const workdir = stringProperty(canonical, "workdir");
  const background = booleanProperty(canonical, "background");
  if (command === undefined) return undefined;

  const properties = schemaProperties(binding.actual);
  const required = new Set(requiredProperties(binding.actual));
  const translated: Record<string, unknown> = { command };
  if (workdir !== undefined) {
    const workdirTarget = chooseTargetProperty(properties, required, ["workdir", "cwd"]);
    if (!workdirTarget) return undefined;
    translated[workdirTarget] = workdir;
  }
  if (timeout !== undefined) {
    if (!properties.has("timeout")) return undefined;
    translated.timeout = timeout;
  }

  const backgroundTarget = chooseTargetProperty(properties, required, SHELL_BACKGROUND_PROPERTIES);
  if (backgroundTarget === undefined) {
    // A host with no execution-mode field still accepts foreground calls, but a
    // background request must never be silently downgraded to a foreground run.
    if (background === true) return undefined;
  } else if (background !== undefined || required.has(backgroundTarget)) {
    // OpenCode's shell is foreground by default, so whenever the host has a mode
    // field the resolved value is written explicitly rather than left to a host
    // default that could be async.
    const isBackground = background === true;
    translated[backgroundTarget] = backgroundTarget === "mode" ? (isBackground ? "async" : "sync") : isBackground;
  }

  // `explanation` and `goal` are host-only approval text with no execution
  // semantics. Derive them from the exact command rather than inventing intent.
  if (required.has("explanation") || required.has("goal")) {
    const description = describeCommand(command);
    if (description === undefined) return undefined;
    if (required.has("explanation")) translated.explanation = description;
    if (required.has("goal")) translated.goal = description;
  }

  return hasRequiredProperties(binding.actual, translated) && translatedInputIsValid(binding.actual, translated) ? translated : undefined;
}

function translateHistoryReadInput(binding: ToolBinding, profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(input) || !hasRequiredProperties(binding.actual, input) || !knownInputIsValid(binding.actual, input)) {
    return undefined;
  }
  const required = requiredProperties(binding.actual);
  if (!required.every((property) => READ_REPRESENTABLE_PROPERTIES.has(property))) {
    return undefined;
  }
  const requiredPaths = ["filePath", "path"].filter((property) => required.includes(property));
  const requiredStarts = READ_START_PROPERTIES.filter((property) => required.includes(property));
  const requiredEnds = READ_END_PROPERTIES.filter((property) => required.includes(property));
  if (requiredPaths.length > 1 || requiredStarts.length > 1 || requiredEnds.length > 1) {
    return undefined;
  }
  const numericFields = ["offset", "startLine", "lineStart", "limit", "endLine", "lineEnd"];
  if (numericFields.some((field) => hasInvalidInteger(input, field))) {
    return undefined;
  }
  if (hasInvalidString(input, "filePath") || hasInvalidString(input, "path")) {
    return undefined;
  }

  const hasFilePath = input.filePath !== undefined;
  const hasPath = input.path !== undefined;
  const path = consistentString(input, ["filePath", "path"]);
  if (path === undefined || (hasFilePath && hasPath && stringProperty(input, "filePath") !== stringProperty(input, "path"))) {
    return undefined;
  }

  const translated: Record<string, unknown> = { [profile.readPathProperty]: path };
  const hasOffset = input.offset !== undefined;
  const hasStartLine = input.startLine !== undefined;
  const hasLineStart = input.lineStart !== undefined;
  const rawOffset = consistentNumber(input, ["offset", "startLine", "lineStart"]);
  if ((hasOffset || hasStartLine || hasLineStart) && rawOffset === undefined) {
    return undefined;
  }
  const offset = rawOffset === undefined ? undefined : effectiveReadOffset(profile, rawOffset);

  const hasLimit = input.limit !== undefined;
  const hasEndLine = input.endLine !== undefined;
  const hasLineEnd = input.lineEnd !== undefined;
  if (hasLimit && (hasEndLine || hasLineEnd)) {
    return undefined;
  }
  const rawLimit = hasLimit ? numberProperty(input, "limit") : undefined;
  const limit = rawLimit === undefined ? undefined : effectiveReadLimit(profile, rawLimit);
  const end = consistentNumber(input, ["endLine", "lineEnd"]);
  if (hasLimit && limit === undefined) {
    return undefined;
  }
  if ((hasEndLine || hasLineEnd) && end === undefined) {
    return undefined;
  }
  if (end !== undefined && end < (offset ?? DEFAULT_READ_OFFSET)) {
    return undefined;
  }

  if (offset !== undefined) translated.offset = offset;
  if (limit !== undefined) translated.limit = limit;
  else if (end !== undefined) translated.limit = effectiveReadLimit(profile, end - (offset ?? DEFAULT_READ_OFFSET) + 1);
  return translated;
}

function translateHistoryShellInput(binding: ToolBinding, profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(input) || !hasRequiredProperties(binding.actual, input) || !knownInputIsValid(binding.actual, input)) {
    return undefined;
  }
  const required = requiredProperties(binding.actual);
  if (!required.every((property) => SHELL_REPRESENTABLE_PROPERTIES.has(property))) {
    return undefined;
  }
  const requiredWorkdirs = ["workdir", "cwd"].filter((property) => required.includes(property));
  const requiredBackgrounds = SHELL_BACKGROUND_PROPERTIES.filter((property) => required.includes(property));
  if (requiredWorkdirs.length > 1 || requiredBackgrounds.length > 1) {
    return undefined;
  }
  if (
    hasInvalidString(input, "command") ||
    hasInvalidString(input, "workdir") ||
    hasInvalidString(input, "cwd") ||
    hasInvalidString(input, "mode") ||
    hasInvalidString(input, "explanation") ||
    hasInvalidString(input, "goal") ||
    hasInvalidBoolean(input, "background") ||
    hasInvalidBoolean(input, "isBackground") ||
    hasInvalidInteger(input, "timeout", 0)
  ) {
    return undefined;
  }

  const command = stringProperty(input, "command");
  if (command === undefined) {
    return undefined;
  }
  const translated: Record<string, unknown> = { command };
  const hasWorkdir = input.workdir !== undefined;
  const hasCwd = input.cwd !== undefined;
  const workdir = consistentString(input, ["workdir", "cwd"]);
  if ((hasWorkdir || hasCwd) && workdir === undefined) {
    return undefined;
  }
  const timeout = numberProperty(input, "timeout");
  if (timeout !== undefined) {
    if (!profile.supportsBackgroundShell && timeout < 1) return undefined;
    translated.timeout = timeout;
  }
  const hasBackground = input.background !== undefined;
  const hasIsBackground = input.isBackground !== undefined;
  const hasMode = input.mode !== undefined;
  // `mode` is canonical; the legacy boolean is only a fallback. A recorded call
  // carrying both is ambiguous and is rejected rather than guessed.
  let modeBackground: boolean | undefined;
  if (hasMode) {
    const mode = stringProperty(input, "mode");
    if (mode !== "sync" && mode !== "async") return undefined;
    modeBackground = mode === "async";
  }
  const legacyBackground = consistentBoolean(input, ["background", "isBackground"]);
  if ((hasBackground || hasIsBackground) && legacyBackground === undefined) {
    return undefined;
  }
  if (modeBackground !== undefined && legacyBackground !== undefined && modeBackground !== legacyBackground) {
    return undefined;
  }
  const background = modeBackground ?? legacyBackground;
  if (workdir !== undefined) translated.workdir = workdir;
  if (background !== undefined) {
    if (!profile.supportsBackgroundShell) {
      if (background) return undefined;
    } else {
      translated.background = background;
    }
  }
  return translated;
}

function translateInput(binding: ToolBinding, profile: ZenToolProfile, input: unknown): Record<string, unknown> | undefined {
  return binding.capability === "read" ? translateReadInput(binding, profile, input) : translateShellInput(binding, profile, input);
}

function translateHistoryInput(
  binding: ToolBinding,
  profile: ZenToolProfile,
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return binding.capability === "read"
    ? translateHistoryReadInput(binding, profile, input)
    : translateHistoryShellInput(binding, profile, input);
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (!value.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a bridge for the selected OpenCode contract.
 *
 * A compatible read or terminal tool is replaced by its pinned wire descriptor
 * when present. Missing capabilities are not synthesized: restricted subagent
 * requests retain their other selected tools unchanged. Ambiguous or
 * unrepresentable recognized bindings still fail closed, and a request with no
 * tools returns undefined so the caller can apply its normal preflight policy.
 */
export function createZenToolBridge(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
  mode: ZenTransportMode = ZEN_TRANSPORT_MODE,
): ZenToolBridge | undefined {
  if (!tools?.length) {
    return undefined;
  }

  const profile = zenToolProfile(mode);
  const readCandidates = bindingCandidates(tools, "read");
  const shellCandidates = bindingCandidates(tools, "shell");
  const read = findBinding(tools, profile, "read");
  const shell = findBinding(tools, profile, "shell");
  if (
    (readCandidates.length > 0 && !read) ||
    (shellCandidates.length > 0 && !shell) ||
    (read && shell && read.actual.name === shell.actual.name)
  ) {
    return undefined;
  }

  const bindings = [read, shell].filter((binding): binding is ToolBinding => binding !== undefined);
  const selectedActualNames = new Set(bindings.map((binding) => binding.actual.name));
  const wireNames = new Set<string>(bindings.map((binding) => binding.wireName));
  if (tools.some((tool) => !selectedActualNames.has(tool.name) && wireNames.has(tool.name))) {
    return undefined;
  }

  const officialToActual = new Map<string, string>(bindings.map((binding) => [binding.wireName, binding.actual.name]));
  const actualToOfficial = new Map<string, string>(bindings.map((binding) => [binding.actual.name, binding.wireName]));
  const passthroughNames = new Set(tools.filter((tool) => !selectedActualNames.has(tool.name)).map((tool) => tool.name));
  const bindingByWireName = new Map<string, ToolBinding>(bindings.map((binding) => [binding.wireName, binding]));
  const bindingByActualName = new Map<string, ToolBinding>(bindings.map((binding) => [binding.actual.name, binding]));
  const wireTools = tools.map((tool) => {
    if (read && tool.name === read.actual.name) return profile.read;
    if (shell && tool.name === shell.actual.name) return profile.shell;
    return tool;
  });

  return {
    tools: wireTools,
    officialToActual,
    actualToOfficial,
    rewriteApiMessages(messages) {
      const rewrites: Array<{
        call: { function: { name: string; arguments: string } };
        name: string;
        arguments: string;
      }> = [];
      for (const message of messages) {
        for (const call of message.tool_calls ?? []) {
          const binding = bindingByActualName.get(call.function.name);
          if (binding) {
            const input = parseToolArguments(call.function.arguments);
            const translated = input ? translateHistoryInput(binding, profile, input) : undefined;
            if (!translated) throw historyBridgeError(call.function.name, binding.actual.name);
            rewrites.push({ call, name: binding.wireName, arguments: JSON.stringify(translated) });
            continue;
          }

          // Calls already carrying an active wire name are normalized again so
          // repeated preparation is idempotent and never creates a new mixed
          // name/schema pair. A full bridge still rejects an unavailable profile
          // name; a restricted bridge leaves it untouched so a subagent can
          // carry the parent's context safely.
          const wireBinding = bindingByWireName.get(call.function.name);
          if (!wireBinding) {
            if (bindings.length === 2 && ZEN_WIRE_NAMES.has(call.function.name) && !passthroughNames.has(call.function.name)) {
              throw historyBridgeError(call.function.name, undefined);
            }
            continue;
          }
          const input = parseToolArguments(call.function.arguments);
          const normalized =
            input && wireBinding.capability === "read" ? normalizeReadWireInput(profile, input) : normalizeShellWireInput(profile, input);
          if (!normalized) throw historyBridgeError(call.function.name, undefined);
          rewrites.push({ call, name: call.function.name, arguments: JSON.stringify(normalized) });
        }
      }

      for (const rewrite of rewrites) {
        rewrite.call.function.name = rewrite.name;
        rewrite.call.function.arguments = rewrite.arguments;
      }
    },
    mapToolCall(name, input) {
      const binding = bindingByWireName.get(name);
      if (binding) {
        const translated = translateInput(binding, profile, input);
        return translated ? { name: binding.actual.name, input: translated } : undefined;
      }

      // Subagents and all other VS Code-supplied tools pass through unchanged;
      // OpenCode's `task` executor is intentionally not synthesized here.
      if (passthroughNames.has(name) && isObjectRecord(input)) {
        return { name, input };
      }
      return undefined;
    },
    wrapProgress(progress) {
      return {
        report: (part) => {
          if (part instanceof vscode.LanguageModelToolCallPart) {
            const mapped = this.mapToolCall(part.name, part.input);
            if (!mapped) {
              const inputKeys = isObjectRecord(part.input) ? Object.keys(part.input).sort().join(",") : typeof part.input;
              console.error(`[zen-tool-bridge] rejected ${part.name}; inputKeys=${inputKeys || "<none>"}`);
              const actualName = actualToOfficial.has(part.name) ? part.name : officialToActual.get(part.name);
              throw toolBridgeError(part.name, actualName);
            }
            progress.report(new vscode.LanguageModelToolCallPart(part.callId, mapped.name, mapped.input));
            return;
          }
          progress.report(part);
        },
      };
    },
  };
}

/** Return a request-options copy carrying the bridge's wire descriptors. */
export function withZenToolBridgeTools(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  bridge: ZenToolBridge | undefined,
): vscode.ProvideLanguageModelChatResponseOptions {
  return bridge ? { ...options, tools: bridge.tools } : options;
}
