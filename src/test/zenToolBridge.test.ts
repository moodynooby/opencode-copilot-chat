import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import Module from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const vscodeMockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vscode-mock-zen-bridge-")), "index.js");
fs.writeFileSync(
  vscodeMockPath,
  `"use strict";
class LanguageModelToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
module.exports = { LanguageModelToolCallPart };
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

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
};

before(async () => {
  ({ createZenToolBridge } = await import("../provider/zenToolBridge.js"));
});

const readFile: Tool = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { filePath: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } },
    required: ["filePath"],
  },
};

const runInTerminal: Tool = {
  name: "run_in_terminal",
  description: "Run a terminal command",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" }, isBackground: { type: "boolean" } },
    required: ["command"],
  },
};

describe("Zen tool bridge", () => {
  it("adds only aliases backed by real Copilot tools", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal]);
    assert.ok(bridge);
    assert.deepEqual(
      bridge.tools.map((tool) => tool.name),
      ["read_file", "run_in_terminal", "read", "shell"],
    );
    assert.equal(bridge.officialToActual.get("read"), "read_file");
    assert.equal(bridge.officialToActual.get("shell"), "run_in_terminal");
  });

  it("fails closed when a real read or terminal tool is absent", () => {
    assert.equal(createZenToolBridge([readFile]), undefined);
    assert.equal(createZenToolBridge([runInTerminal]), undefined);
    assert.equal(createZenToolBridge([]), undefined);
  });

  it("translates read and shell inputs in both directions", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal]);
    assert.ok(bridge);
    assert.deepEqual(bridge.mapToolCall("read", { path: "/repo/a.ts", offset: 4, limit: 2 }), {
      name: "read_file",
      input: { filePath: "/repo/a.ts", startLine: 5, endLine: 6 },
    });
    assert.deepEqual(bridge.mapToolCall("shell", { command: "npm test", background: true }), {
      name: "run_in_terminal",
      input: { command: "npm test", isBackground: true },
    });
    assert.equal(bridge.mapToolCall("read", { path: 42 }), undefined);
    assert.equal(bridge.mapToolCall("edit", { path: "/repo/a.ts" }), undefined);
  });

  it("reverse-maps assistant history before the next request", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal]);
    assert.ok(bridge);
    const messages = [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
      },
    ];
    bridge.rewriteApiMessages(messages);
    assert.equal(messages[0]?.tool_calls?.[0]?.function.name, "read");
  });

  it("fails closed when a model call does not match the selected tool schema", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal]);
    assert.ok(bridge);
    const wrapped = bridge.wrapProgress({
      report: () => {
        // The malformed call must fail before reaching progress.
      },
    });
    const vscode = (Module as unknown as { _load: (request: string, parent: unknown) => typeof import("vscode") })._load("vscode", module);
    assert.throws(() => {
      wrapped.report(new vscode.LanguageModelToolCallPart("call-3", "read", {}));
    }, /did not match a selected VS Code tool and its input schema/);
  });

  it("returns mapped calls to VS Code while preserving call IDs", () => {
    const bridge = createZenToolBridge([readFile, runInTerminal]);
    assert.ok(bridge);
    const reported: Array<{ callId: string; name: string; input: unknown }> = [];
    const progress = { report: (part: unknown) => reported.push(part as { callId: string; name: string; input: unknown }) };
    const wrapped = bridge.wrapProgress(progress);
    const vscode = (Module as unknown as { _load: (request: string, parent: unknown) => typeof import("vscode") })._load("vscode", module);
    wrapped.report(new vscode.LanguageModelToolCallPart("call-2", "read", { path: "/repo/b.ts" }));
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.callId, "call-2");
    assert.equal(reported[0]?.name, "read_file");
    assert.deepEqual(reported[0]?.input, { filePath: "/repo/b.ts" });
  });
});
