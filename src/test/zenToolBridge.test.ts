import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import Module from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ZenToolBridgeError } from "../errors.js";

const vscodeMockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vscode-mock-zen-bridge-")), "index.js");
fs.writeFileSync(
  vscodeMockPath,
  `"use strict";
class LanguageModelToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
class LanguageModelChatToolMode { static Required = "required"; }
module.exports = { LanguageModelToolCallPart, LanguageModelChatToolMode };
`,
  "utf-8",
);

type ResolveFilename = (request: string, parent: unknown, ...args: unknown[]) => string;
const moduleResolver = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolveFilename = moduleResolver._resolveFilename;
moduleResolver._resolveFilename = function (request: string, parent: unknown, ...args: unknown[]): string {
  if (request === "vscode") return vscodeMockPath;
  return originalResolveFilename.call(this, request, parent, ...args);
};

type BridgeModule = typeof import("../provider/zenToolBridge.js");
let createZenToolBridge: BridgeModule["createZenToolBridge"];
let buildResponsesRequestBody: typeof import("../request/openai.js").buildResponsesRequestBody;

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
};

before(async () => {
  ({ createZenToolBridge } = await import("../provider/zenToolBridge.js"));
  ({ buildResponsesRequestBody } = await import("../request/openai.js"));
});

const readFile: Tool = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
    },
    required: ["filePath", "startLine", "endLine"],
  },
};

const runInTerminal: Tool = {
  name: "run_in_terminal",
  description: "Run a terminal command",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      workdir: { type: "string" },
      timeout: { type: "integer" },
      isBackground: { type: "boolean" },
    },
    required: ["command"],
  },
};

/**
 * Verbatim schema of VS Code 1.139's built-in `run_in_terminal` tool, copied
 * from `out/vs/workbench/workbench.desktop.main.js`. `mode` is the canonical
 * execution switch, `isBackground` is deprecated, and the approval text
 * `explanation`/`goal` is required. Regression guard for the free-model
 * preflight that rejected every real Agent Mode request.
 */
const vsCodeRunInTerminal: Tool = {
  name: "run_in_terminal",
  description: "Run a terminal command",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run in the terminal." },
      explanation: { type: "string", description: "A one-sentence description of what the command does." },
      goal: { type: "string", description: "A short description of the goal or purpose of the command." },
      mode: { type: "string", enum: ["sync", "async"] },
      isBackground: { type: "boolean" },
      timeout: { type: "number" },
    },
    required: ["command", "explanation", "goal", "mode"],
  },
};

const runSubagent: Tool = {
  name: "runSubagent",
  description: "Run a subagent",
  inputSchema: {
    type: "object",
    properties: { description: { type: "string" }, prompt: { type: "string" } },
    required: ["description", "prompt"],
  },
};

const grepSearch: Tool = {
  name: "grep_search",
  description: "Search the workspace",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const terminalLike: Tool = {
  name: "shell",
  description: "A user tool whose name resembles a terminal alias",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

function vscodeModule(): typeof import("vscode") {
  return (Module as unknown as { _load: (request: string, parent: unknown) => typeof import("vscode") })._load("vscode", module);
}

function toolByName(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  return tool;
}

describe("Zen tool bridge", () => {
  it("uses the pinned OpenCode v1 contract and preserves unrelated tools", () => {
    const subagent = runSubagent;
    const search = grepSearch;
    const bridge = createZenToolBridge([readFile, runInTerminal, subagent, search], "legacy");
    assert.ok(bridge);

    assert.deepEqual(
      bridge.tools.map((tool) => tool.name),
      ["read", "bash", "runSubagent", "grep_search"],
    );
    assert.equal(bridge.officialToActual.get("read"), "read_file");
    assert.equal(bridge.officialToActual.get("bash"), "run_in_terminal");
    assert.strictEqual(toolByName(bridge.tools as unknown as Tool[], "runSubagent"), subagent);
    assert.strictEqual(toolByName(bridge.tools as unknown as Tool[], "grep_search"), search);

    const wireRead = toolByName(bridge.tools as unknown as Tool[], "read");
    const wireShell = toolByName(bridge.tools as unknown as Tool[], "bash");
    const v1ReadProperties = (wireRead.inputSchema as { properties: Record<string, { type: string }> }).properties;
    const v1ShellProperties = (wireShell.inputSchema as { properties: Record<string, { type: string }> }).properties;
    assert.deepEqual((wireRead.inputSchema as { required: string[] }).required, ["filePath"]);
    assert.deepEqual((wireShell.inputSchema as { required: string[] }).required, ["command"]);
    assert.equal(v1ReadProperties.filePath.type, "string");
    assert.equal(v1ReadProperties.offset.type, "integer");
    assert.equal("path" in v1ReadProperties, false);
    assert.equal("background" in v1ShellProperties, false);
  });

  it("uses the pinned OpenCode v2 contract", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "v2");
    assert.ok(bridge);

    assert.deepEqual(
      bridge.tools.map((tool) => tool.name),
      ["read", "shell"],
    );
    const wireRead = toolByName(bridge.tools as unknown as Tool[], "read");
    const wireShell = toolByName(bridge.tools as unknown as Tool[], "shell");
    const v2ReadSchema = wireRead.inputSchema as {
      additionalProperties: boolean;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    const v2ShellSchema = wireShell.inputSchema as {
      additionalProperties: boolean;
      properties: Record<string, { type: string }>;
      required: string[];
    };
    assert.deepEqual(v2ReadSchema.required, ["path"]);
    assert.deepEqual(v2ShellSchema.required, ["command"]);
    assert.equal(v2ReadSchema.additionalProperties, false);
    assert.equal(v2ShellSchema.additionalProperties, false);
    assert.equal(v2ReadSchema.properties.offset.type, "integer");
    assert.equal("background" in v2ShellSchema.properties, true);
    assert.equal(bridge.officialToActual.get("shell"), "run_in_terminal");
  });

  it("maps v1 read ranges with OpenCode one-based semantics and defaults", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "legacy");
    assert.ok(bridge);

    assert.deepEqual(bridge.mapToolCall("read", { filePath: "/repo/a.ts", offset: 5, limit: 2 }), {
      name: "read_file",
      input: { filePath: "/repo/a.ts", startLine: 5, endLine: 6 },
    });
    assert.deepEqual(bridge.mapToolCall("read", { filePath: "/repo/a.ts" }), {
      name: "read_file",
      input: { filePath: "/repo/a.ts", startLine: 1, endLine: 2000 },
    });
    assert.equal(bridge.mapToolCall("read", { filePath: "/repo/a.ts", offset: 0, limit: 0 }), undefined);
    assert.equal(bridge.mapToolCall("read", { filePath: 42 }), undefined);
  });

  it("maps v2 read and shell capabilities to the real host tool", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "v2");
    assert.ok(bridge);

    assert.deepEqual(bridge.mapToolCall("read", { path: "/repo/a.ts", offset: 5, limit: 2 }), {
      name: "read_file",
      input: { filePath: "/repo/a.ts", startLine: 5, endLine: 6 },
    });
    assert.deepEqual(bridge.mapToolCall("read", { path: "/repo/a.ts", offset: 0, limit: 0 }), {
      name: "read_file",
      input: { filePath: "/repo/a.ts", startLine: 1, endLine: 2000 },
    });
    assert.deepEqual(bridge.mapToolCall("read", { path: "/repo/a.ts", offset: 1, limit: 5000 }), {
      name: "read_file",
      input: { filePath: "/repo/a.ts", startLine: 1, endLine: 2000 },
    });
    assert.deepEqual(bridge.mapToolCall("shell", { command: "npm test", workdir: "/repo", background: true }), {
      name: "run_in_terminal",
      input: { command: "npm test", workdir: "/repo", isBackground: true },
    });
  });

  it("does not invent v1 background or host-only review arguments", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "legacy");
    assert.ok(bridge);

    assert.deepEqual(bridge.mapToolCall("bash", { command: "git status", workdir: "/repo" }), {
      name: "run_in_terminal",
      input: { command: "git status", workdir: "/repo" },
    });
    // The v1 wire contract has no background field, so a background request is
    // still rejected rather than silently downgraded to a foreground run.
    assert.equal(bridge.mapToolCall("bash", { command: "git status", background: true }), undefined);

    // A host that requires approval text gets it derived from the command.
    const terminalWithRequiredMetadata: Tool = {
      ...runInTerminal,
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, explanation: { type: "string" } },
        required: ["command", "explanation"],
      },
    };
    const metadataBridge = createZenToolBridge([readFile, terminalWithRequiredMetadata], "legacy");
    assert.ok(metadataBridge);
    assert.deepEqual(metadataBridge.mapToolCall("bash", { command: "npm   run build" }), {
      name: "run_in_terminal",
      input: { command: "npm   run build", explanation: "npm run build" },
    });
    // A command with no non-empty line is never a safe call to forward.
    assert.equal(metadataBridge.mapToolCall("bash", { command: "  \n  " }), undefined);
  });

  it("binds the real VS Code run_in_terminal schema and derives its required host fields", () => {
    const bridge = createZenToolBridge([readFile, vsCodeRunInTerminal], "legacy");
    assert.ok(bridge, "the shipped VS Code terminal schema must bind");

    // Foreground is the default, so `mode` is written explicitly as "sync".
    assert.deepEqual(bridge.mapToolCall("bash", { command: "git status", timeout: 30_000 }), {
      name: "run_in_terminal",
      input: {
        command: "git status",
        timeout: 30_000,
        mode: "sync",
        explanation: "git status",
        goal: "git status",
      },
    });

    // Approval text is a literal slice of the real command, never invented.
    assert.deepEqual(bridge.mapToolCall("bash", { command: "\n  npm test\nnpm run build" }), {
      name: "run_in_terminal",
      input: {
        command: "\n  npm test\nnpm run build",
        mode: "sync",
        explanation: "npm test",
        goal: "npm test",
      },
    });

    // The real tool has no workdir/cwd, so a requested working directory is
    // rejected rather than silently run in the wrong directory.
    assert.equal(bridge.mapToolCall("bash", { command: "git status", workdir: "/repo" }), undefined);
  });

  it("maps v2 background onto the canonical mode field and keeps isBackground as fallback", () => {
    const bridge = createZenToolBridge([readFile, vsCodeRunInTerminal], "v2");
    assert.ok(bridge);

    assert.deepEqual(bridge.mapToolCall("shell", { command: "npm run dev", background: true }), {
      name: "run_in_terminal",
      input: {
        command: "npm run dev",
        mode: "async",
        explanation: "npm run dev",
        goal: "npm run dev",
      },
    });
    assert.deepEqual(bridge.mapToolCall("shell", { command: "npm test", background: false }), {
      name: "run_in_terminal",
      input: { command: "npm test", mode: "sync", explanation: "npm test", goal: "npm test" },
    });
  });

  it("fails closed when the host cannot express a requested background run", () => {
    const foregroundOnly: Tool = {
      ...vsCodeRunInTerminal,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          explanation: { type: "string" },
          goal: { type: "string" },
          mode: { type: "string", enum: ["sync"] },
        },
        required: ["command", "explanation", "goal", "mode"],
      },
    };
    const bridge = createZenToolBridge([readFile, foregroundOnly], "v2");
    assert.ok(bridge);

    // A sync-only host cannot honor mode="async", so the call is rejected
    // instead of being downgraded to a foreground run.
    assert.equal(bridge.mapToolCall("shell", { command: "npm run dev", background: true }), undefined);
    assert.ok(bridge.mapToolCall("shell", { command: "npm test" }) !== undefined);
  });

  it("rewrites recorded history calls that carry mode and approval text", () => {
    const bridge = createZenToolBridge([readFile, vsCodeRunInTerminal], "legacy");
    assert.ok(bridge);
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-terminal",
            type: "function" as const,
            function: {
              name: "run_in_terminal",
              arguments: JSON.stringify({
                command: "npm run dev",
                explanation: "start the dev server",
                goal: "start the dev server",
                mode: "async",
              }),
            },
          },
        ],
      },
    ];

    assert.throws(() => {
      bridge.rewriteApiMessages(messages);
    }, ZenToolBridgeError);

    const asyncMessages = JSON.parse(JSON.stringify(messages)) as typeof messages;
    asyncMessages[0].tool_calls[0].function.arguments = JSON.stringify({
      command: "npm run dev",
      explanation: "start the dev server",
      goal: "start the dev server",
      mode: "sync",
    });
    bridge.rewriteApiMessages(asyncMessages);
    const rewritten = JSON.parse(asyncMessages[0].tool_calls[0].function.arguments) as Record<string, unknown>;
    assert.deepEqual(rewritten, { command: "npm run dev" });
  });

  it("passes subagents and other selected tools through unchanged", () => {
    const subagentInput = { description: "Inspect", prompt: "Read the project" };
    const bridge = createZenToolBridge([readFile, runInTerminal, runSubagent, grepSearch, terminalLike], "legacy");
    assert.ok(bridge);

    assert.deepEqual(bridge.mapToolCall("runSubagent", subagentInput), {
      name: "runSubagent",
      input: subagentInput,
    });
    assert.deepEqual(bridge.mapToolCall("grep_search", { query: "zenToolBridge" }), {
      name: "grep_search",
      input: { query: "zenToolBridge" },
    });
    assert.deepEqual(bridge.mapToolCall("shell", { query: "keep me" }), {
      name: "shell",
      input: { query: "keep me" },
    });
    assert.equal(bridge.mapToolCall("read_file", { filePath: "/repo/a.ts" }), undefined);
    assert.equal(bridge.mapToolCall("run_in_terminal", { command: "git status", isBackground: true }), undefined);
    const history = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-terminal-like",
            type: "function" as const,
            function: { name: "shell", arguments: JSON.stringify({ query: "keep me" }) },
          },
        ],
      },
    ];
    bridge.rewriteApiMessages(history);
    assert.equal(history[0]?.tool_calls?.[0]?.function.name, "shell");

    const reported: Array<{ callId: string; name: string; input: unknown }> = [];
    const wrapped = bridge.wrapProgress({ report: (part) => reported.push(part as { callId: string; name: string; input: unknown }) });
    const vscode = vscodeModule();
    wrapped.report(new vscode.LanguageModelToolCallPart("call-subagent", "runSubagent", subagentInput));
    wrapped.report(new vscode.LanguageModelToolCallPart("call-read", "read", { filePath: "/repo/a.ts" }));
    assert.deepEqual(
      reported.map(({ callId, name }) => ({ callId, name })),
      [
        { callId: "call-subagent", name: "runSubagent" },
        { callId: "call-read", name: "read_file" },
      ],
    );
  });

  it("rewrites only selected history and remains idempotent", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal, runSubagent], "legacy");
    assert.ok(bridge);
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-read",
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ filePath: "/repo/a.ts", startLine: 5, endLine: 6 }) },
          },
          {
            id: "call-subagent",
            type: "function" as const,
            function: { name: "runSubagent", arguments: JSON.stringify({ description: "Inspect", prompt: "Read" }) },
          },
        ],
      },
    ];

    bridge.rewriteApiMessages(messages);
    bridge.rewriteApiMessages(messages);
    assert.equal(messages[0]?.tool_calls?.[0]?.function.name, "read");
    assert.deepEqual(JSON.parse(messages[0]?.tool_calls?.[0]?.function.arguments ?? "{}"), {
      filePath: "/repo/a.ts",
      offset: 5,
      limit: 2,
    });
    assert.equal(messages[0]?.tool_calls?.[1]?.function.name, "runSubagent");
    assert.deepEqual(JSON.parse(messages[0]?.tool_calls?.[1]?.function.arguments ?? "{}"), {
      description: "Inspect",
      prompt: "Read",
    });
  });

  it("fails atomically when selected history cannot use the active profile", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "legacy");
    assert.ok(bridge);
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-valid",
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ filePath: "/repo/a.ts", startLine: 5, endLine: 6 }) },
          },
          {
            id: "call-invalid",
            type: "function" as const,
            function: { name: "read", arguments: JSON.stringify({ path: "/repo/old-v2.ts" }) },
          },
        ],
      },
    ];
    const original = structuredClone(messages);

    assert.throws(
      () => {
        bridge.rewriteApiMessages(messages);
      },
      (error: unknown) => error instanceof ZenToolBridgeError && /request was not sent/.test(error.userMessage),
    );
    assert.deepEqual(messages, original);
  });

  it("round-trips v2 history into its path contract", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "v2");
    assert.ok(bridge);
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-v2-read",
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ filePath: "/repo/a.ts", startLine: 5, endLine: 6 }) },
          },
        ],
      },
    ];

    bridge.rewriteApiMessages(messages);
    assert.equal(messages[0]?.tool_calls?.[0]?.function.name, "read");
    assert.deepEqual(JSON.parse(messages[0]?.tool_calls?.[0]?.function.arguments ?? "{}"), {
      path: "/repo/a.ts",
      offset: 5,
      limit: 2,
    });
  });

  it("sends the v1 wire contract in the Responses request body", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "legacy");
    assert.ok(bridge);
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call-wire",
            type: "function" as const,
            function: { name: "read_file", arguments: JSON.stringify({ filePath: "/repo/file.ts", startLine: 1, endLine: 240 }) },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "call-wire", content: "file contents" },
      { role: "user" as const, content: "Continue" },
    ];
    bridge.rewriteApiMessages(messages);

    const body = buildResponsesRequestBody(
      "muse-spark-1.2-contributor-free",
      messages,
      { tools: bridge.tools } as never,
      { temperature: 0, thinking: {} } as never,
      {} as never,
      { maxOutputTokens: 4096 } as never,
    );
    const input = body.input as Array<Record<string, unknown>>;
    const functionCall = input.find((item) => item.type === "function_call");
    assert.ok(functionCall);
    assert.equal(functionCall.name, "read");
    assert.deepEqual(JSON.parse(String(functionCall.arguments)), { filePath: "/repo/file.ts", offset: 1, limit: 240 });
    assert.deepEqual(
      (body.tools as Array<{ name: string }>).map((tool) => tool.name),
      ["bash", "read"],
    );
  });

  it("fails closed for missing, ambiguous, or unrepresentable bindings", () => {
    assert.equal(createZenToolBridge([readFile], "legacy"), undefined);
    assert.equal(createZenToolBridge([runInTerminal], "legacy"), undefined);
    assert.equal(createZenToolBridge([readFile, { ...readFile, name: "read_file_copy" }], "legacy"), undefined);

    const wrongReadType: Tool = {
      ...readFile,
      inputSchema: { type: "object", properties: { filePath: { type: "number" } }, required: ["filePath"] },
    };
    assert.equal(createZenToolBridge([wrongReadType, runInTerminal], "legacy"), undefined);

    const wrongOptionalRange: Tool = {
      ...readFile,
      inputSchema: {
        type: "object",
        properties: { filePath: { type: "string" }, startLine: { type: "string" }, endLine: { type: "integer" } },
        required: ["filePath"],
      },
    };
    assert.equal(createZenToolBridge([wrongOptionalRange, runInTerminal], "legacy"), undefined);

    const ambiguousTerminal: Tool = {
      ...runInTerminal,
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, background: { type: "boolean" }, isBackground: { type: "boolean" } },
        required: ["command", "background", "isBackground"],
      },
    };
    assert.equal(createZenToolBridge([readFile, ambiguousTerminal], "legacy"), undefined);

    const composedTerminal: Tool = {
      ...runInTerminal,
      inputSchema: {
        type: "object",
        properties: { command: { allOf: [{ type: "number" }] } },
        required: ["command"],
      },
    };
    assert.equal(createZenToolBridge([readFile, composedTerminal], "legacy"), undefined);
    assert.equal(
      createZenToolBridge(
        [readFile, runInTerminal, { name: "bash", description: "duplicate", inputSchema: runInTerminal.inputSchema }],
        "legacy",
      ),
      undefined,
    );
  });

  it("rejects malformed mapped calls without leaking their arguments", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal], "legacy");
    assert.ok(bridge);
    const wrapped = bridge.wrapProgress({ report: () => undefined });
    const vscode = vscodeModule();

    assert.throws(
      () => {
        wrapped.report(new vscode.LanguageModelToolCallPart("call-3", "read", { secret: "do-not-log" }));
      },
      (error: unknown) => {
        assert.ok(error instanceof ZenToolBridgeError);
        assert.match(error.userMessage, /read_file/);
        assert.match(error.userMessage, /rejected call was not executed/);
        assert.doesNotMatch(error.userMessage, /do-not-log/);
        assert.doesNotMatch(error.userMessage, /Start a new Agent Mode request/);
        return true;
      },
    );
    assert.throws(
      () => {
        wrapped.report(new vscode.LanguageModelToolCallPart("call-4", "read_file", { filePath: "/repo/a.ts" }));
      },
      (error: unknown) => error instanceof ZenToolBridgeError && /read_file/.test(error.userMessage),
    );
  });
});
