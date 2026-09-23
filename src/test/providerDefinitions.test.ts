import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import Module from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const vscodeMockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vscode-mock-definitions-")), "index.js");
fs.writeFileSync(
  vscodeMockPath,
  `"use strict"; module.exports = { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };`,
  "utf8",
);

type ResolveFilename = (request: string, parent: unknown, ...args: unknown[]) => string;
const moduleResolver = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolveFilename = moduleResolver._resolveFilename;
moduleResolver._resolveFilename = function (request: string, parent: unknown, ...args: unknown[]): string {
  return request === "vscode" ? vscodeMockPath : originalResolveFilename.call(this, request, parent, ...args);
};

let createProviderDefinitions: typeof import("../provider/definitions.js").createProviderDefinitions;
let isSupportedZenModel: typeof import("../provider/definitions.js").isSupportedZenModel;
let isAnonymousZenModel: typeof import("../provider/definitions.js").isAnonymousZenModel;

before(async () => {
  const definitions = await import("../provider/definitions.js");
  createProviderDefinitions = definitions.createProviderDefinitions;
  isSupportedZenModel = definitions.isSupportedZenModel;
  isAnonymousZenModel = definitions.isAnonymousZenModel;
});

describe("OpenCode V2 provider definitions", () => {
  it("derives all Zen V2 routes from one inference base URL", () => {
    const providers = createProviderDefinitions("https://gateway.example.test/inference");
    const zen = providers.opencodezen;

    assert.equal(zen.modelsUrl, "https://gateway.example.test/inference/v1/models");
    assert.equal(zen.chatCompletionsUrl, "https://gateway.example.test/inference/openai/v1/chat/completions");
    assert.equal(zen.responsesUrl, "https://gateway.example.test/inference/openai/v1/responses");
    assert.equal(zen.messagesUrl, "https://gateway.example.test/inference/anthropic/v1/messages");
    assert.equal(zen.googleModelsUrl, "https://gateway.example.test/inference/google/v1beta/models");
  });

  it("allows the verified anonymous free model but withholds paid models", () => {
    const zen = createProviderDefinitions().opencodezen;
    const filterModel = zen.filterModel;
    assert.ok(filterModel);

    assert.equal(filterModel("space-bunny-free", undefined), true);
    assert.equal(filterModel("big-pickle", undefined), false);
    assert.equal(filterModel("muse-spark-1.3-contributor-free", "service-account-key"), true);
    assert.equal(filterModel("gpt-5.5", undefined), false);
  });

  it("excludes catalog-only System One and test models", () => {
    assert.equal(isSupportedZenModel("space-bunny-free"), true);
    assert.equal(isSupportedZenModel("jev-1.13-free"), false);
    assert.equal(isSupportedZenModel("test-novita-dsf4.1"), false);
  });

  it("only treats verified anonymous Chat Completions models as keyless", () => {
    assert.equal(isAnonymousZenModel("space-bunny-free"), true);
    assert.equal(isAnonymousZenModel("big-pickle"), false);
    assert.equal(isAnonymousZenModel("muse-spark-1.3-contributor-free"), false);
    assert.equal(isAnonymousZenModel("gpt-5.5"), false);
  });
});
