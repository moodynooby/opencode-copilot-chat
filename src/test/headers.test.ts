import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import Module from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const vscodeMockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vscode-mock-headers-")), "index.js");
fs.writeFileSync(
  vscodeMockPath,
  `"use strict";
class LanguageModelChatToolMode { static Required = "required"; }
module.exports = { LanguageModelChatToolMode, workspace: { workspaceFolders: undefined }, extensions: { getExtension: () => undefined } };
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

let hashRawCacheKey: typeof import("../request/headers.js").hashRawCacheKey;
let buildOpenCodeRequestHeaders: typeof import("../request/headers.js").buildOpenCodeRequestHeaders;

before(async () => {
  const mod = await import("../request/headers.js");
  hashRawCacheKey = mod.hashRawCacheKey;
  buildOpenCodeRequestHeaders = mod.buildOpenCodeRequestHeaders;
});

describe("OpenCode application request identity", () => {
  it("uses the official OpenCode app/session/project header shape", () => {
    const headers = buildOpenCodeRequestHeaders(
      [{ role: "user", content: "hello" }] as never,
      { sessionId: "session-test", requestId: "request-test" } as never,
      "test-model",
    );

    assert.equal(headers["x-opencode-client"], "app");
    assert.equal(headers["x-opencode-session"], "session-test");
    assert.equal(headers["x-opencode-request"], "request-test");
    assert.match(headers["User-Agent"], /^opencode\//);
    assert.match(headers["x-opencode-project"], /^[a-f0-9]{64}$/);
  });
});

describe("hashRawCacheKey", () => {
  it("pins SHA256 for a fixed raw key (regression guard)", () => {
    // Mirrors docs/references/opencode-context-cache-reference.md
    const raw = "testuser@testhost:C:/project";
    const expected = "4f77e704edc190c1872f5ac84f42320d082a4cf4c52bfdacd2634db07de24120";
    assert.equal(hashRawCacheKey(raw), expected);
  });

  it("is stable for backslash vs forward-slash after normalization", () => {
    const canonical = "testuser@testhost:C:/a/b";
    const expected = hashRawCacheKey(canonical);
    assert.equal(expected.length, 64);
    assert.match(expected, /^[a-f0-9]{64}$/);
  });
});
