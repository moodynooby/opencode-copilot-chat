import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCodeGatewayAuthHeaders } from "../openCodeAuth.js";

describe("OpenCode gateway authentication", () => {
  it("uses Bearer auth for every OpenCode Zen V2 API family", () => {
    for (const endpointKind of ["chat-completions", "messages", "responses", "google"] as const) {
      assert.deepEqual(buildOpenCodeGatewayAuthHeaders(endpointKind, "sk-test", "opencodezen"), {
        Authorization: "Bearer sk-test",
      });
    }
  });

  it("does not fabricate an Authorization header for anonymous Zen requests", () => {
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", undefined, "opencodezen"), {});
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", "   ", "opencodezen"), {});
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", undefined, "opencodego"), {});
  });

  it("keeps the existing Go per-family auth contract", () => {
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", "go-key", "opencodego"), {
      Authorization: "Bearer go-key",
    });
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("messages", "go-key", "opencodego"), {
      "x-api-key": "go-key",
      "anthropic-version": "2023-06-01",
    });
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("google", "go-key", "opencodego"), {
      "x-goog-api-key": "go-key",
    });
  });
});
