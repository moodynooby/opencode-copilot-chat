**Status:** 🟢 Active

# OpenCode Zen Transport Integration

**Topic:** provider / routing / authentication / models / OpenCode / V2
**Updated:** 2026-09-25
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

The gateway-facing tool policy is handled by one request-scoped compatibility bridge. The selected transport chooses the pinned OpenCode profile; the bridge maps compatible read and terminal capabilities when VS Code supplies them, then maps model calls back to the original VS Code tool names so VS Code remains the executor and permission system. A restricted subagent request may therefore use a pass-through-only bridge. The bridge never executes a tool, creates a substitute executor, or silently falls back between profiles.

| Transport                               | OpenCode profile | Model-facing contract                                                                                                            |
| --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Legacy `/zen/v1` (OpenCode v1.18.0)     | `read` + `bash`  | `read.filePath` with optional 1-based `offset`/`limit`; `bash.command` with optional `workdir`/`timeout` and no background field |
| Experimental `/inference` (OpenCode v2) | `read` + `shell` | `read.path` with optional 1-based `offset`/`limit`; `shell.command` with optional `workdir`/`timeout`/`background`               |

The real Copilot variants are the only host differences translated by the bridge: `filePath`/`path`, `offset`/`limit` versus `startLine`/`endLine`, `workdir`/`cwd`, and `mode`/`background`/`isBackground`. Read defaults come from OpenCode (offset `1`, limit `2000`); foreground is the shell default and is always written explicitly rather than left to a host default that could be async. A v1 `background` request is rejected because v1 has no such capability, so v1 always resolves to the host's synchronous mode. Unsupported or ambiguous bindings fail closed, as does a background request against a host that cannot express one. Assistant history is rewritten atomically: a call's name and arguments move to the same profile together; if any selected call cannot be represented, the request is rejected before dispatch rather than sending mixed history.

The pinned OpenCode `read` description also mentions directories, images, and PDFs, while VS Code's current `read_file` implementation is text-focused and directs image reads to `view_image`. The bridge does not synthesize directory/image/PDF executors. Those capabilities remain separate selected passthrough tools; a read request outside the bound host schema is rejected by VS Code. Making the pinned description capability-aware requires a separate upstream-contract decision.

#### Host approval metadata

VS Code's `run_in_terminal` requires `command`, `explanation`, `goal`, and `mode`, and marks `isBackground` as a deprecated alias of `mode`. The bridge models all three spellings of execution mode, resolves them to a single intent, and treats a recorded call carrying both `mode` and a contradicting legacy flag as ambiguous.

`explanation` and `goal` are host-only approval text with no execution semantics. Rather than fabricate intent, the bridge derives them deterministically from the first non-empty line of the exact command it is about to forward, so the text the user approves always matches what runs. Only fields the host actually requires are emitted, and a command with no non-empty line is never forwarded.

All other selected VS Code tools pass through unchanged. This includes `runSubagent`, search/explore subagents, edit, plan, MCP, and future tools, so subagent execution and permission behavior remain owned by VS Code. The bridge does not rename `runSubagent` to OpenCode's separate `task` executor. Missing read/terminal capabilities are not synthesized: a restricted subagent request with only other selected tools uses a pass-through-only bridge, while no-tool requests and ambiguous or unrepresentable recognized bindings fail before network dispatch. Successful results then cross the shared provider serializer: prompt-tsx trees are flattened, text/JSON data is decoded, and unknown structured values are preserved as JSON before the next request. The v2 anonymous catalog still uses its narrow verified seed allowlist; authenticated non-seed free models use the v2 profile and map whichever compatible capabilities are supplied.

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
4. Credential-aware filtering: legacy anonymous callers see supported free conversational models; the request-scoped bridge maps compatible read/terminal capabilities when supplied and preserves restricted subagent tool sets. V2 anonymous callers retain the verified keyless seed set; authenticated non-seed free models use the same capability-aware bridge with the v2 profile, while authenticated callers may also see paid models.

Catalog snapshots are cached by provider, endpoint, transport-specific URL, and a SHA-256 credential scope. This prevents one workspace's model permissions from being reused for another key. The cache prefix is versioned so the transport switch abandons incompatible snapshots.

## Routing

The model registry remains the source of truth:

- GPT, Grok, and Muse → Responses.
- Zen Claude and Qwen → Anthropic Messages.
- Zen Gemini → Google Generative AI.
- Other supported conversational families → Chat Completions.

The active transport supplies the base URL; the registry supplies the API family. Go routing is unchanged.

Responses tool-call `*.done` events are authoritative snapshots, not additional argument fragments. The normalizer replaces any pending name/arguments for that output index, while preserving raw argument-fragment whitespace and ignoring empty completion snapshots that could erase streamed arguments. This preserves gateways such as Muse 1.3 that can emit the complete call only in `response.output_item.done`, without duplicating calls from gateways that send both deltas and done snapshots.

## Live contract probe

`npm run probe-zen-tools` is the opt-in live harness for validating the gateway-facing descriptors. It reads the key from `OPENCODE_ZEN_API_KEY` (or `OPENCODE_API_KEY`), sends the pinned profile to the selected transport, and reports the returned tool name and argument keys without executing the tool. Use `--mode legacy`, `--mode v2`, or `--mode both`; use `--compare` to send the alternate terminal name as a control. `--dry-run` is always offline.

## Verification

The implementation is covered by unit tests for default and V2 URL derivation, provider-aware auth, anonymous filtering, credential-scoped catalog caching, OpenCode identity headers, both pinned tool profiles, one-based range translation, history round-trips, fail-closed host mismatches, restricted subagent subsets, other-tool pass-through, and rich tool-result serialization. `npm run lint` is the required repository gate. A public catalog probe is available, but public free-model Responses requests are rejected by the upstream free-tier policy before tool-schema validation; an authorized key is still required for a live legacy `bash`/`shell` A/B and for authenticated V2 validation. Unavailable catalog entries remain filtered.
