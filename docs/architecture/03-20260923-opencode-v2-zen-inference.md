**Status:** 🟢 Active

# OpenCode Zen Transport Integration

**Topic:** provider / routing / authentication / models / OpenCode / V2
**Updated:** 2026-09-24
**Tags:** #provider #routing #authentication #models #opencode #v2 #byok
**Supersedes:** -

---

## Overview

OpenCode Zen follows the current OpenCode client flow by default. The default transport is the official OpenCode-compatible `/zen/v1` gateway, including its `public` no-key sentinel. The newer Console V2 transport remains implemented as an experimental, source-only path; it is not selected by a user setting and there is no automatic fallback between transports.

OpenCode Go remains a separate provider with its existing contract.

The model catalog is fetched dynamically from the active transport. The bundled model list is only an offline fallback. Catalog-only System One and test entries are filtered because this extension exposes conversational Language Model Chat models, not the System One API.

## Transport modes

`ZEN_TRANSPORT_MODE` in `src/config.ts` is the single source-level selector:

```ts
export const ZEN_TRANSPORT_MODE: ZenTransportMode = "legacy";
```

Change that literal to `"v2"` in a source patch to experiment with the alternate transport. This is intentionally not a VS Code setting yet.

### Default legacy/OpenCode-compatible transport

| API family              | Endpoint                                       |
| ----------------------- | ---------------------------------------------- |
| Model catalog           | `/zen/v1/models`                               |
| OpenAI Chat Completions | `/zen/v1/chat/completions`                     |
| OpenAI Responses        | `/zen/v1/responses`                            |
| Anthropic Messages      | `/zen/v1/messages`                             |
| Google Gemini           | `/zen/v1/models/<model>:streamGenerateContent` |

A configured service-account key is sent as `Authorization: Bearer <key>`. With no key, the extension sends the official public sentinel:

```http
Authorization: Bearer public
```

The current gateway applies a client/tool policy to public free models. The default legacy transport now handles that policy with a request-scoped compatibility bridge: when the request contains real Copilot read-file and terminal tools, the provider adds OpenCode-compatible `read` and `shell` descriptors, maps calls back to the original VS Code tool names, and preserves the normal VS Code execution/permission loop. It does not add dummy tools or invoke private tools. Requests without both real tools fail closed before dispatch. The experimental V2 path retains the narrow seed allowlist until its own client policy is verified.

### Experimental V2 Console transport

| API family              | Endpoint                                                        |
| ----------------------- | --------------------------------------------------------------- |
| Model catalog           | `/inference/v1/models`                                          |
| OpenAI Chat Completions | `/inference/openai/v1/chat/completions`                         |
| OpenAI Responses        | `/inference/openai/v1/responses`                                |
| Anthropic Messages      | `/inference/anthropic/v1/messages`                              |
| Google Gemini           | `/inference/google/v1beta/models/<model>:streamGenerateContent` |

V2 uses a real Console service-account key for authenticated requests and does not accept the legacy `public` sentinel. `opencodezen.apiBaseUrl` is read only when the source selector is changed to `"v2"`; its default remains the V2 base URL for that experimental path.

## Authentication and identity

Zen requests use the official OpenCode header shape:

- `User-Agent: opencode/latest/1.18.0/app` (the public gateway's minimum supported client identity)
- `x-opencode-client: app`
- `x-opencode-session: ses_<id>`
- `x-session-affinity` and `x-session-id` matching the session
- `x-opencode-request: msg_<id>`
- `x-opencode-project: <stable-project-cache-key>`

The gateway version is deliberately separate from the extension package version. Go keeps its existing provider-specific authentication headers.

## Model discovery

`ModelListFetcher` reads the live catalog for the active transport and applies, in order:

1. Unsupported catalog-entry filtering (`jev-*`, `test`, and `test-novita-dsf4.1`).
2. Availability/deprecation filtering.
3. `freeOnly` filtering.
4. Credential-aware filtering: legacy anonymous callers see supported free conversational models; the request-scoped bridge gates non-seed models on real read/terminal tools. V2 anonymous callers retain the verified keyless seed set; authenticated callers may see paid and other free models.

Catalog snapshots are cached by provider, endpoint, transport-specific URL, and a SHA-256 credential scope. This prevents one workspace's model permissions from being reused for another key. The cache prefix is versioned so the transport switch abandons incompatible snapshots.

## Routing

The model registry remains the source of truth:

- GPT, Grok, and Muse → Responses.
- Zen Claude and Qwen → Anthropic Messages.
- Zen Gemini → Google Generative AI.
- Other supported conversational families → Chat Completions.

The active transport supplies the base URL; the registry supplies the API family. Go routing is unchanged.

Responses tool-call `*.done` events are authoritative snapshots, not additional argument fragments. The normalizer replaces any pending name/arguments for that output index. This preserves gateways such as Muse 1.3 that can emit the complete call only in `response.output_item.done`, without duplicating calls from gateways that send both deltas and done snapshots.

## Verification

The implementation is covered by unit tests for default and V2 URL derivation, provider-aware auth, anonymous filtering, credential-scoped catalog caching, OpenCode identity headers, and the real-tool bridge. `npm run lint` is the required repository gate. Live validation covers the catalog and streaming request path with the bridge's real read/shell aliases; unavailable catalog entries remain filtered.
