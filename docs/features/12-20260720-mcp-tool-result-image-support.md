**Status:** 🟢 Active

# Rich Tool Results — Text, Structured Data, and Images

**Topic:** vision / tool-calling / streaming / provider / mcp
**Updated:** 2026-09-25
**Tags:** #vision #tool-calling #streaming #provider #mcp
**Issues:** [#77](https://github.com/ltmoerdani/opencode-copilot-chat/issues/77)
**Released:** `Unreleased` (post-`0.4.1`)

---

## Overview

Extension-side support for serializing every supported `LanguageModelToolResultPart` content shape for the next model turn. Current VS Code tools return prompt-tsx transfer trees, textual or JSON data parts, images, and future structured values. MCP tools such as `chrome-devtools-mcp` and `playwright-mcp` use image data parts for screenshots.

Before the original image fix, screenshots were silently dropped and the model received an empty tool result. A later VS Code 1.139 audit found the same loss for successful `read_file` results because they are `LanguageModelPromptTsxPart` values rather than plain text; subagent and other integrations may use the same rich result shapes. The shared serializer now flattens prompt-tsx text, decodes text/JSON data, preserves unknown structured values as JSON, and emits explicit placeholders for unsupported binary data. Images continue through the normalized multimodal path below.

---

## Architecture

```text
VS Code tool returns content
  ├─ LanguageModelTextPart
  ├─ LanguageModelPromptTsxPart (current read_file / subagent shape)
  ├─ LanguageModelDataPart (text, JSON, image, or binary)
  └─ unknown future structured value
  ↓
convertMessage() walks LanguageModelToolResultPart.content:
  • text / prompt-tsx / text+JSON data → rendered text in toolTextParts
  • unknown structured value           → JSON text
  • unsupported binary                 → explicit omission placeholder
  • image DataPart                     → OpenAiContentPart image_url
                                            (subject to MAX_TOOL_RESULT_IMAGE_BYTES = 1 MB)
  ↓
Tool message content:
  • string                         if no images are present
  • OpenAiContentPart[] multimodal if ≥1 image is present
  ↓
Per-transport builder converts to native shape:
  • chat-completions: passes the array through as-is
  • Anthropic messages: tool_result.content becomes string | AnthropicContentBlock[]
  • Google Gemini: functionResponse.response gains parts:[{text},{inlineData}]
  • Responses API: image replaced with placeholder note (API limit: string only)
```

---

## Configuration

No settings, no toggle. If a model reports `imageInput: true` (i.e. it is in
`VISION_CAPABLE_MODELS` or `models.dev` says it supports vision), nested tool
result images are forwarded automatically. If the model is text-only, the
existing **vision proxy** (see
[`docs/features/11-20260715-vision-proxy.md`](11-20260715-vision-proxy.md))
handles it.

---

## Size Guard

```ts
const MAX_TOOL_RESULT_IMAGE_BYTES = 1_000_000; // 1 MB raw bytes
```

Single images larger than 1 MB are replaced with an inline placeholder note so
the request payload stays bounded. Typical MCP screenshots are 50–300 KB; the
cap exists to prevent agent loops that re-capture full-page screenshots from
producing multi-MB payloads that get rejected upstream with
`400 Upstream request failed`.

The placeholder text is:

> `[Image attachment omitted: N bytes exceeds the 1000000-byte limit for tool
results. Ask the tool to produce a smaller screenshot or save it to a file.]`

---

## Per-Transport Behavior

| Transport               | Image in tool result                                          | Notes                                                  |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| OpenAI chat-completions | ✅ Native — array content forwarded as-is                     | Used by Kimi, Mimo, GLM, DeepSeek, Grok on OpenCode Go |
| Anthropic messages      | ✅ Native — `tool_result.content: AnthropicContentBlock[]`    | Used by MiniMax M2.5/M2.7, Qwen3.5/3.6/3.7-max         |
| Google Gemini           | ✅ Native — `functionResponse.response.parts: [{inlineData}]` | Used by Gemini family (when available on OpenCode)     |
| OpenAI Responses API    | ❌ API limit — replaced with placeholder note                 | `function_call_output.output` is string-only           |

---

## Code Locations

| Concern                                      | Location                                      |
| -------------------------------------------- | --------------------------------------------- |
| VS Code tool-result conversion               | `src/provider/messages.ts` `convertMessage()` |
| PromptTsx/data/structured text serialization | `src/provider/tokens.ts` `partToText()`       |
| PromptTsx token estimation                   | `src/provider/tokens.ts` `partToTokenCount()` |
| `MAX_TOOL_RESULT_IMAGE_BYTES` constant       | `src/config.ts`                               |
| Anthropic tool result content                | `src/request/anthropic.ts`                    |
| Responses API tool output                    | `src/responsesRequest.ts`                     |
| Google tool response content                 | `src/request/google.ts`                       |

---

## Verification

- `npm test` — 525/525 pass, including PromptTsx/text/JSON/unknown tool-result serialization
- Manual test with `chrome-devtools-mcp` + Kimi K2.7 Code on OpenCode Go:
  model successfully read and described the returned screenshot

See [`docs/issues/34-20260720-mcp-tool-result-image-dropped.md`](../issues/34-20260720-mcp-tool-result-image-dropped.md)
for the full investigation, timeline, and follow-up bugs uncovered during
manual testing.

---

## Limitations

1. **Responses API has no image support in tool output.** Images are replaced
   with an actionable placeholder.
2. **PromptTsx image/document nodes are represented by placeholders.** The
   current built-in `read_file` result is a text tree, and subagent integrations
   may use the same shape. Future rich media nodes are not expanded
   into provider-specific image/document blocks by this serializer.
3. **History image trimming is bounded, not unlimited.** The per-image raw-byte
   guard remains, and older conversation images are replaced beyond
   `MAX_HISTORY_IMAGES_KEPT = 2`.
4. **Top-level image size capping is resolved.** Top-level and tool-result
   images run through the normalizer in `src/provider/messages.ts`; the raw
   `MAX_TOOL_RESULT_IMAGE_BYTES` guard still applies after normalization. See
   [`docs/features/13-20260803-image-normalization.md`](13-20260803-image-normalization.md).

---

## Related Docs

- [`docs/features/01-20260514-vision-image-input.md`](01-20260514-vision-image-input.md) — top-level image attachments
- [`docs/features/11-20260715-vision-proxy.md`](11-20260715-vision-proxy.md) — proxy for text-only models
- [`docs/features/13-20260803-image-normalization.md`](13-20260803-image-normalization.md) — image normalizer (resized/re-encoded before size guard, supersedes raw-byte-only guard)
- [`docs/issues/34-20260720-mcp-tool-result-image-dropped.md`](../issues/34-20260720-mcp-tool-result-image-dropped.md) — root-cause + fix writeup
- [`docs/issues/38-20260725-top-level-image-size-guard.md`](../issues/38-20260725-top-level-image-size-guard.md) — ⚠️ Deprecated, superseded by #94 normalizer
