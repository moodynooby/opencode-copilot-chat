/**
 * @fileoverview Safe compatibility bridge between selected Copilot tools and
 * the OpenCode tool names required by the public Zen gateway.
 *
 * The bridge never executes a tool. It only translates a real Copilot tool
 * descriptor into an OpenCode-compatible alias and translates the resulting
 * call back to the original Copilot name so VS Code remains the executor.
 */

import * as vscode from "vscode";
import type { ApiMessage } from "../request/types";
import { isRecord } from "../utils";

const READ_ALIAS_NAMES = new Set([
  "read",
  "readfile",
  "read_file",
  "vscode_read_file",
  "copilot_read_file",
  "file_read",
  "read_workspace_file",
]);

const SHELL_ALIAS_NAMES = new Set([
  "shell",
  "bash",
  "terminal",
  "runinterminal",
  "runterminal",
  "runterminalcommand",
  "runinterminalcommand",
  "execute_command",
  "run_command",
  "runcommand",
]);

const OPEN_CODE_READ_TOOL: vscode.LanguageModelChatTool = {
  name: "read",
  description: "Read a file from the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read." },
      offset: { type: "number", description: "Optional zero-based line offset." },
      limit: { type: "number", description: "Optional number of lines to read." },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const OPEN_CODE_SHELL_TOOL: vscode.LanguageModelChatTool = {
  name: "shell",
  description: "Run a shell command in the workspace.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run." },
      workdir: { type: "string", description: "Optional working directory." },
      timeout: { type: "number", description: "Optional timeout in milliseconds." },
      background: { type: "boolean", description: "Whether to run in the background." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

interface ToolBinding {
  officialName: "read" | "shell";
  actual: vscode.LanguageModelChatTool;
}

export interface ZenToolBridge {
  /** Tool descriptors sent to the gateway, including real mapped aliases. */
  readonly tools: vscode.LanguageModelChatTool[];
  /** Map an OpenCode alias name to the actual VS Code tool name. */
  readonly officialToActual: ReadonlyMap<string, string>;
  /** Map an actual VS Code tool name back to its OpenCode alias. */
  readonly actualToOfficial: ReadonlyMap<string, string>;
  /** Rewrite assistant tool-call history before the next upstream request. */
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
  if (!isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties)) {
    return new Set();
  }
  return new Set(Object.keys(tool.inputSchema.properties));
}

function findBinding(
  tools: readonly vscode.LanguageModelChatTool[],
  officialName: "read" | "shell",
  aliases: ReadonlySet<string>,
  requiredProperties: readonly string[],
): ToolBinding | undefined {
  const candidates = tools.filter((tool) => {
    if (!aliases.has(normalizeToolName(tool.name))) {
      return false;
    }
    const properties = schemaProperties(tool);
    return requiredProperties.some((property) => properties.has(property));
  });

  const exact = candidates.find((tool) => tool.name === officialName);
  return exact ? { officialName, actual: exact } : candidates[0] ? { officialName, actual: candidates[0] } : undefined;
}

function hasRequiredProperties(tool: vscode.LanguageModelChatTool, input: Record<string, unknown>): boolean {
  if (!isRecord(tool.inputSchema) || !Array.isArray(tool.inputSchema.required)) {
    return true;
  }
  return tool.inputSchema.required.every((property) => typeof property === "string" && input[property] !== undefined);
}

function translateReadInput(tool: vscode.LanguageModelChatTool, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof input.path !== "string") {
    return undefined;
  }

  const properties = schemaProperties(tool);
  const translated: Record<string, unknown> = {};
  if (properties.has("filePath")) {
    translated.filePath = input.path;
  } else if (properties.has("path")) {
    translated.path = input.path;
  } else {
    return undefined;
  }

  if (typeof input.offset === "number") {
    if (properties.has("startLine")) translated.startLine = input.offset + 1;
    else if (properties.has("lineStart")) translated.lineStart = input.offset + 1;
  }
  if (typeof input.limit === "number" && typeof input.offset === "number") {
    if (properties.has("endLine")) translated.endLine = input.offset + input.limit;
    else if (properties.has("lineEnd")) translated.lineEnd = input.offset + input.limit;
  }

  return hasRequiredProperties(tool, translated) ? translated : undefined;
}

function translateShellInput(tool: vscode.LanguageModelChatTool, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof input.command !== "string") {
    return undefined;
  }

  const properties = schemaProperties(tool);
  const translated: Record<string, unknown> = { command: input.command };
  if (input.workdir !== undefined) {
    if (!properties.has("workdir") || typeof input.workdir !== "string") return undefined;
    translated.workdir = input.workdir;
  }
  if (input.timeout !== undefined) {
    if (!properties.has("timeout") || typeof input.timeout !== "number") return undefined;
    translated.timeout = input.timeout;
  }
  if (input.background !== undefined) {
    if (typeof input.background !== "boolean") return undefined;
    if (properties.has("background")) translated.background = input.background;
    else if (properties.has("isBackground")) translated.isBackground = input.background;
    else return undefined;
  }
  if (properties.has("explanation") && translated.explanation === undefined) {
    translated.explanation = "Requested by the selected OpenCode model.";
  }
  if (properties.has("justification") && translated.justification === undefined) {
    translated.justification = "Requested by the selected OpenCode model.";
  }

  return hasRequiredProperties(tool, translated) ? translated : undefined;
}

function translateInput(
  tool: vscode.LanguageModelChatTool,
  officialName: "read" | "shell",
  input: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return officialName === "read" ? translateReadInput(tool, input) : translateShellInput(tool, input);
}

/**
 * Create a bridge only when both required OpenCode aliases have real Copilot
 * tools with compatible command/path inputs. Missing or ambiguous tools fail
 * closed instead of creating declarations that VS Code cannot execute.
 */
export function createZenToolBridge(tools: readonly vscode.LanguageModelChatTool[] | undefined): ZenToolBridge | undefined {
  if (!tools?.length) {
    return undefined;
  }

  const read = findBinding(tools, "read", READ_ALIAS_NAMES, ["filePath", "path"]);
  const shell = findBinding(tools, "shell", SHELL_ALIAS_NAMES, ["command"]);
  if (!read || !shell) {
    return undefined;
  }

  const bindings = [read, shell];
  const officialToActual = new Map<string, string>(bindings.map((binding) => [binding.officialName, binding.actual.name]));
  const actualToOfficial = new Map<string, string>(bindings.map((binding) => [binding.actual.name, binding.officialName]));
  const actualNames = new Set(tools.map((tool) => tool.name));
  const wireTools = [...tools];
  if (!actualNames.has("read")) wireTools.push(OPEN_CODE_READ_TOOL);
  if (!actualNames.has("shell")) wireTools.push(OPEN_CODE_SHELL_TOOL);

  const bindingByOfficialName = new Map(bindings.map((binding) => [binding.officialName, binding.actual]));

  return {
    tools: wireTools,
    officialToActual,
    actualToOfficial,
    rewriteApiMessages(messages) {
      for (const message of messages) {
        for (const call of message.tool_calls ?? []) {
          const officialName = actualToOfficial.get(call.function.name);
          if (officialName) {
            call.function.name = officialName;
          }
        }
      }
    },
    mapToolCall(name, input) {
      const actualName = officialToActual.get(name);
      if (!actualName) {
        return actualNames.has(name) && isRecord(input) ? { name, input } : undefined;
      }
      const officialName = name as "read" | "shell";
      const actualTool = bindingByOfficialName.get(officialName);
      if (!actualTool) {
        return undefined;
      }
      const translated = translateInput(actualTool, officialName, input);
      return translated ? { name: actualName, input: translated } : undefined;
    },
    wrapProgress(progress) {
      return {
        report: (part) => {
          if (part instanceof vscode.LanguageModelToolCallPart) {
            const mapped = this.mapToolCall(part.name, part.input);
            if (!mapped) {
              throw new Error(
                `OpenCode Zen tool bridge cannot safely translate ${part.name}; the model call did not match a selected VS Code tool and its input schema.`,
              );
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
