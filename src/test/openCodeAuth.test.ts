import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpenCodeGatewayAuthHeaders } from "../openCodeAuth.js";

describe("OpenCode gateway authentication", () => {
  it("uses Bearer auth for every OpenCode Zen API family", () => {
    for (const endpointKind of ["chat-completions", "messages", "responses", "google"] as const) {
      assert.deepEqual(buildOpenCodeGatewayAuthHeaders(endpointKind, "sk-test", "opencodezen", "legacy"), {
        Authorization: "Bearer sk-test",
      });
      assert.deepEqual(buildOpenCodeGatewayAuthHeaders(endpointKind, "sk-test", "opencodezen", "v2"), {
        Authorization: "Bearer sk-test",
      });
    }
  });

  it("uses the official public sentinel only for legacy Zen requests", () => {
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", undefined, "opencodezen", "legacy"), {
      Authorization: "Bearer public",
    });
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", "   ", "opencodezen", "legacy"), {
      Authorization: "Bearer public",
    });
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", undefined, "opencodezen", "v2"), {});
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", "public", "opencodezen", "v2"), {});
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", undefined, "opencodego", "legacy"), {});
  });

  it("keeps the existing Go per-family auth contract", () => {
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("chat-completions", "go-key", "opencodego", "legacy"), {
      Authorization: "Bearer go-key",
    });
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("messages", "go-key", "opencodego", "legacy"), {
      "x-api-key": "go-key",
      "anthropic-version": "2023-06-01",
    });
    assert.deepEqual(buildOpenCodeGatewayAuthHeaders("google", "go-key", "opencodego", "legacy"), {
      "x-goog-api-key": "go-key",
    });
  });
});
