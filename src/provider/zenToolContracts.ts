/**
 * @fileoverview Pinned OpenCode tool contracts used by the Zen compatibility bridge.
 *
 * The legacy profile mirrors OpenCode v1.18.0. The v2 profile mirrors the
 * OpenCode v2 built-in read and shell tools. Keep these contracts separate:
 * the legacy and v2 Zen endpoints intentionally use different model-facing
 * parameter names and shell capabilities. The field shapes are copied from
 * OpenCode v1.18.0 `tool/read.ts` + `tool/shell/prompt.ts` and the pinned v2
 * checkout (`917d904`) `core/src/tool/plugin/{read,shell}.ts`; do not infer
 * aliases from model IDs or silently switch to a newer upstream contract.
 */

import type * as vscode from "vscode";
import type { ZenTransportMode } from "../config";

export type ZenToolName = "read" | "bash" | "shell";

export interface ZenToolProfile {
  readonly read: vscode.LanguageModelChatTool;
  readonly shell: vscode.LanguageModelChatTool;
  readonly readPathProperty: "filePath" | "path";
  readonly zeroReadOffsetUsesDefault: boolean;
  readonly zeroReadLimitUsesDefault: boolean;
  readonly maxReadLimit: number | undefined;
  readonly supportsBackgroundShell: boolean;
}

const V1_READ_DESCRIPTION = [
  "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.",
  "",
  "Usage:",
  "- The filePath parameter should be an absolute path.",
  "- By default, this tool returns up to 2000 lines from the start of the file.",
  "- The offset parameter is the line number to start from (1-indexed).",
  "- To read later sections, call this tool again with a larger offset.",
  "- Use the grep tool to find specific content in large files or files with long lines.",
  "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.",
  '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n". For directories, entries are returned one per line (without line numbers) with a trailing `/` for subdirectories.',
  "- Any line longer than 2000 characters is truncated.",
  "- Call this tool in parallel when you know there are multiple files you want to read.",
  "- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.",
  "- This tool can read image files and PDFs and return them as file attachments.",
].join("\n");

const V2_READ_DESCRIPTION =
  "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.";

const V1_READ_SCHEMA = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "The absolute path to the file or directory to read" },
    offset: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "The line number to start reading from (1-indexed)",
    },
    limit: {
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: "The maximum number of lines to read (defaults to 2000)",
    },
  },
  required: ["filePath"],
} as const;

const V2_READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "File or directory to read" },
    offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
    limit: {
      type: "integer",
      minimum: 0,
      description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

// OpenCode v1 renders the rest of this description from the runtime OS and
// selected shell. Keep the stable model-facing prefix here rather than
// inventing a platform/shell value in the extension.
const V1_SHELL_DESCRIPTION =
  "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.";

const V2_SHELL_DESCRIPTION = [
  "Execute a shell command and return its output.",
  "Quote file paths containing spaces or special characters.",
  "Prefer dedicated tools over shell commands when possible.",
  "When output is large, the full result is saved to a file and a truncated preview is returned.",
  "Rely on automatic truncation unless filtering the output is more useful.",
  "Commands accept an optional timeout, background commands have no timeout by default.",
  "Background commands return immediately, and you will be notified when they complete.",
].join(" ");

const V1_SHELL_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to execute" },
    timeout: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Optional timeout in milliseconds" },
    workdir: {
      type: "string",
      description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
    },
  },
  required: ["command"],
} as const;

const V2_SHELL_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command string to execute" },
    workdir: {
      type: "string",
      description:
        "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
    },
    timeout: {
      type: "integer",
      minimum: 0,
      description:
        "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
    },
    background: {
      type: "boolean",
      description:
        "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

/** OpenCode tool contracts keyed by the extension's source-selected transport. */
export const ZEN_TOOL_PROFILES: Readonly<Record<ZenTransportMode, ZenToolProfile>> = {
  legacy: {
    read: { name: "read", description: V1_READ_DESCRIPTION, inputSchema: V1_READ_SCHEMA },
    shell: { name: "bash", description: V1_SHELL_DESCRIPTION, inputSchema: V1_SHELL_SCHEMA },
    readPathProperty: "filePath",
    zeroReadOffsetUsesDefault: true,
    zeroReadLimitUsesDefault: false,
    maxReadLimit: undefined,
    supportsBackgroundShell: false,
  },
  v2: {
    read: { name: "read", description: V2_READ_DESCRIPTION, inputSchema: V2_READ_SCHEMA },
    shell: { name: "shell", description: V2_SHELL_DESCRIPTION, inputSchema: V2_SHELL_SCHEMA },
    readPathProperty: "path",
    zeroReadOffsetUsesDefault: true,
    zeroReadLimitUsesDefault: true,
    maxReadLimit: 2000,
    supportsBackgroundShell: true,
  },
};

/** Return the pinned OpenCode contract for a transport mode. */
export function zenToolProfile(mode: ZenTransportMode): ZenToolProfile {
  return ZEN_TOOL_PROFILES[mode];
}
