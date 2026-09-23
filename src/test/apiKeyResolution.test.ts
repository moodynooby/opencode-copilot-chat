import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveResponseApiKey } from "../apiKeyResolution.js";

describe("resolveResponseApiKey", () => {
  it("prefers the request's native BYOK configuration", () => {
    assert.equal(resolveResponseApiKey("configured", "registered", "stored"), "configured");
  });

  it("uses the key captured while registering the selected model", () => {
    assert.equal(resolveResponseApiKey(undefined, "registered", "stored"), "registered");
  });

  it("falls back to SecretStorage after an extension-host cold start", () => {
    assert.equal(resolveResponseApiKey(undefined, undefined, "stored"), "stored");
  });

  it("treats blank credentials as missing and trims stored keys", () => {
    assert.equal(resolveResponseApiKey("  ", "registered", "stored"), "registered");
    assert.equal(resolveResponseApiKey(undefined, undefined, "  stored  "), "stored");
    assert.equal(resolveResponseApiKey("  ", "  ", "  "), undefined);
  });
});
