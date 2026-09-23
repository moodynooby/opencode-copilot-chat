import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { installVscodeMock } from "./helpers/goUsageTestUtils.js";

installVscodeMock();

describe("Zen Model Request & Header Parity", () => {
  let buildOpenCodeGatewayAuthHeaders: typeof import("../openCodeAuth.js").buildOpenCodeGatewayAuthHeaders;
  let buildChatCompletionsRequestBody: typeof import("../request/openai.js").buildChatCompletionsRequestBody;
  let buildAnthropicMessagesRequestBody: typeof import("../request/anthropic.js").buildAnthropicMessagesRequestBody;
  let buildOpenCodeRequestHeaders: typeof import("../request/headers.js").buildOpenCodeRequestHeaders;

  before(async () => {
    const authMod = await import("../openCodeAuth.js");
    const openAiMod = await import("../request/openai.js");
    const anthropicMod = await import("../request/anthropic.js");
    const headersMod = await import("../request/headers.js");

    buildOpenCodeGatewayAuthHeaders = authMod.buildOpenCodeGatewayAuthHeaders;
    buildChatCompletionsRequestBody = openAiMod.buildChatCompletionsRequestBody;
    buildAnthropicMessagesRequestBody = anthropicMod.buildAnthropicMessagesRequestBody;
    buildOpenCodeRequestHeaders = headersMod.buildOpenCodeRequestHeaders;
  });

  it("builds correct auth headers for keyless (public) free Zen model calls", () => {
    const headers = buildOpenCodeGatewayAuthHeaders("chat-completions", "public");
    assert.equal(headers.Authorization, "Bearer public");
  });

  it("builds correct auth headers for Anthropic messages Zen calls", () => {
    const headers = buildOpenCodeGatewayAuthHeaders("messages", "public");
    assert.equal(headers["x-api-key"], "public");
    assert.equal(headers["anthropic-version"], "2023-06-01");
  });

  it("builds required OpenCode session and request tracking headers", () => {
    const fakeMessages = [{ role: 1, content: [{ value: "Hello" }] }] as any;
    const reqHeaders = buildOpenCodeRequestHeaders(fakeMessages, {} as any, "mimo-v2.5-free");

    assert.ok(reqHeaders["x-opencode-session"], "should have x-opencode-session header");
    assert.ok(reqHeaders["x-opencode-request"], "should have x-opencode-request header");
    assert.equal(reqHeaders["x-opencode-client"], "vscode-copilot-chat");
    assert.ok(reqHeaders["User-Agent"]);
  });

  it("builds valid chat completions body for free Zen model mimo-v2.5-free", () => {
    const messages = [{ role: "user" as const, content: "test" }];
    const settings = {
      temperature: 0.2,
      thinking: {},
      stripThinkTags: "auto",
    } as any;
    const metadata = { temperature: true } as any;
    const limits = { maxOutputTokens: 2048 } as any;

    const body = buildChatCompletionsRequestBody(
      "mimo-v2.5-free",
      messages,
      {} as any,
      settings,
      metadata,
      limits,
    );

    assert.equal(body.model, "mimo-v2.5-free");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 2048);
  });

  it("builds valid Anthropic messages body for Zen model qwen3.7-plus", () => {
    const messages = [{ role: "user" as const, content: "test" }];
    const settings = {
      temperature: 0.2,
      thinking: {},
      stripThinkTags: "auto",
    } as any;
    const metadata = { temperature: true } as any;
    const limits = { maxOutputTokens: 4096 } as any;

    const body = buildAnthropicMessagesRequestBody(
      "qwen3.7-plus",
      messages,
      {} as any,
      settings,
      metadata,
      limits,
    );

    assert.equal(body.model, "qwen3.7-plus");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 4096);
  });
});
