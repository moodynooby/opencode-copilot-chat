**Status:** 🟢 Active

# OpenCode V2 Zen Inference Integration

**Topic:** provider / routing / authentication / models / OpenCode V2
**Updated:** 2026-09-24
**Tags:** #provider #routing #authentication #models #opencode #v2 #byok
**Supersedes:** -

---

## Overview

This fork's OpenCode Zen provider is a standalone client for the OpenCode V2 Console inference API. It is independent of the legacy `/zen/v1` gateway and does not silently fall back to that API. OpenCode Go remains a separate provider with its existing contract.

The model catalog is fetched dynamically from:

```text
GET https://opencode.ai/inference/v1/models
```

The bundled model list is only an offline fallback. Catalog-only System One and test entries are filtered because this extension exposes conversational Language Model Chat models, not the System One API.

## V2 endpoint contract

| API family              | Endpoint                                                        |
| ----------------------- | --------------------------------------------------------------- |
| OpenAI Chat Completions | `/inference/openai/v1/chat/completions`                         |
| OpenAI Responses        | `/inference/openai/v1/responses`                                |
| Anthropic Messages      | `/inference/anthropic/v1/messages`                              |
| Google Gemini           | `/inference/google/v1beta/models/<model>:streamGenerateContent` |

`opencodezen.apiBaseUrl` defaults to `https://opencode.ai/inference`; all four routes are derived from it.

## Authentication and identity

Paid Zen inference uses a Console service-account key:

```http
Authorization: Bearer <service-account-key>
```

The same Bearer header is used for OpenAI, Anthropic, and Google V2 routes. `space-bunny-free` is currently verified for anonymous Chat Completions access. Other free models, including free models routed through Responses, Google, or Anthropic, require a key. Anonymous requests never send `Bearer undefined`. Paid and endpoint-restricted free models are hidden without a key and rejected before dispatch if a key disappears after discovery.

Requests use the official OpenCode client header shape:

- `User-Agent: opencode/<version>`
- `x-opencode-client: app`
- `x-opencode-session: <stable-session-id>`
- `x-opencode-request: <request-id>`
- `x-opencode-project: <stable-project-cache-key>`

Go keeps its existing provider-specific authentication headers.

## Model discovery

`ModelListFetcher` reads the live V2 catalog and applies, in order:

1. Unsupported catalog-entry filtering (`jev-*`, `test`, and `test-novita-dsf4.1`).
2. Availability/deprecation filtering.
3. `freeOnly` filtering.
4. Credential-aware filtering: anonymous callers see the verified keyless model set only; authenticated callers may see paid and other free models.

Catalog snapshots are cached by provider, endpoint, and a SHA-256 credential scope. This prevents one workspace's model permissions from being reused for another key. The cache prefix and metadata revision are versioned so the V2 migration abandons legacy snapshots.

## Routing

The model registry remains the source of truth:

- GPT, Grok, and Muse → Responses.
- Zen Claude and Qwen → Anthropic Messages.
- Zen Gemini → Google Generative AI.
- Other supported conversational families → Chat Completions.

Google uses a dedicated model-base URL because the V2 catalog URL and Gemini route no longer share the legacy `/models` base.

## Verification

The implementation is covered by unit tests for URL derivation, routing, provider-aware auth, anonymous filtering, credential-scoped catalog caching, and OpenCode identity headers. `npm run lint` is the required repository gate; live validation should cover one free anonymous request and one authenticated request per transport family.
