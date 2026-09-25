import * as vscode from "vscode";
import {
  MESSAGE_NAME_TOKEN_OVERHEAD,
  MESSAGE_TOKEN_OVERHEAD,
  TOOL_CALL_TOKEN_OVERHEAD,
  TOOL_RESULT_TOKEN_OVERHEAD,
  IMAGE_TOKEN_ESTIMATE,
} from "../config";
import { estimateTokenCount } from "../tokenEstimate";
import { isInternalDataPart } from "../chatParts";
import { isRecord } from "../utils";

/** Extract the visible text of a chat message (all parts joined). */
export function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

/** Token estimate for a whole chat message (role/name overhead + content). */
export function estimateChatMessageTokenCount(message: vscode.LanguageModelChatRequestMessage): number {
  const role = typeof message.role === "string" ? message.role : String(message.role);
  const name = typeof message.name === "string" ? message.name : "";
  const contentTokens = message.content.map(partToTokenCount).reduce((total, count) => total + count, 0);

  return (
    MESSAGE_TOKEN_OVERHEAD + estimateTokenCount(role) + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokenCount(name) : 0) + contentTokens
  );
}

/** Token estimate for a single response part. */
export function partToTokenCount(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTokenCount(part.value);
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const contentTokens = part.content.map(partToTokenCount).reduce((total, count) => total + count, 0);
    return TOOL_RESULT_TOKEN_OVERHEAD + estimateTokenCount(part.callId) + contentTokens;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return (
      TOOL_CALL_TOKEN_OVERHEAD + estimateTokenCount(part.callId) + estimateTokenCount(part.name) + estimateStructuredTokenCount(part.input)
    );
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return isInternalDataPart(part) ? 0 : estimateDataPartTokenCount(part);
  }

  if (part instanceof vscode.LanguageModelPromptTsxPart) {
    return estimateTokenCount(partToText(part));
  }

  if (typeof vscode.LanguageModelThinkingPart === "function" && part instanceof vscode.LanguageModelThinkingPart) {
    return 0;
  }

  return estimateTokenCount(partToText(part));
}

/** Token estimate for an arbitrary structured value (JSON-serialized). */
export function estimateStructuredTokenCount(value: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

/** Token estimate for a data part, matching the text actually serialized for non-image data. */
export function estimateDataPartTokenCount(part: vscode.LanguageModelDataPart): number {
  if (part.mimeType.startsWith("image/")) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  return estimateTokenCount(partToText(part));
}

const PROMPT_TSX_PIECE_NODE = 1;
const PROMPT_TSX_TEXT_NODE = 2;
const PROMPT_TSX_OPAQUE_NODE = 3;
const PROMPT_TSX_IMAGE_NODE = 3;
const PROMPT_TSX_DOCUMENT_NODE = 4;

function isTextualMimeType(mimeType: string): boolean {
  const mediaType = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json") || mediaType.endsWith("+xml");
}

function binaryDataPlaceholder(mimeType: string, byteLength: number): string {
  return `[Binary tool result omitted: ${mimeType || "unknown MIME type"} (${String(byteLength)} bytes)]`;
}

function structuredValueText(value: unknown): string {
  if (value === undefined) return "[Unsupported tool result: undefined]";
  if (typeof value === "symbol" || typeof value === "function") return `[Unsupported tool result: ${typeof value}]`;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Uint8Array) return binaryDataPlaceholder("application/octet-stream", value.byteLength);
  if (value instanceof Error) return value.message;
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "[Unserializable structured tool result]";
  } catch {
    return "[Unserializable structured tool result]";
  }
}

/**
 * Flatten prompt-tsx's stable transfer tree into the text a non-prompt-tsx
 * provider can consume. The first text leaf of a nested piece inherits
 * prompt-tsx's implicit `IfNotTextSibling` line break; image and document
 * pieces are leaves, so their children are intentionally not traversed.
 */
function promptTsxPartText(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.node)) return "[Malformed PromptTsx tool result]";
  const chunks: string[] = [];

  const append = (text: string, lineBreakBefore: boolean): void => {
    if (!text) return;
    if (lineBreakBefore && chunks.length > 0 && chunks.at(-1)?.endsWith("\n") !== true) chunks.push("\n");
    chunks.push(text);
  };
  const visit = (node: unknown, childIndex: number, isTextSibling: boolean): boolean => {
    if (!isRecord(node)) return false;
    if (node.type === PROMPT_TSX_TEXT_NODE && typeof node.text === "string") {
      append(node.text, node.lineBreakBefore === true || (childIndex === 0 && !isTextSibling));
      return true;
    }
    if (node.type === PROMPT_TSX_OPAQUE_NODE) {
      append(structuredValueText(node.value), false);
      return false;
    }
    if (node.ctor === PROMPT_TSX_IMAGE_NODE) {
      append("[Image embedded in PromptTsx tool result omitted]", false);
      return false;
    }
    if (node.ctor === PROMPT_TSX_DOCUMENT_NODE) {
      const mediaType = isRecord(node.props) && typeof node.props.mediaType === "string" ? node.props.mediaType : "unknown";
      append(`[Document embedded in PromptTsx tool result omitted: ${mediaType}]`, false);
      return false;
    }
    if (Array.isArray(node.children)) {
      let siblingIsText = isTextSibling;
      for (const [index, child] of node.children.entries()) {
        siblingIsText = visit(child, index, siblingIsText);
        if (isRecord(child) && child.type === PROMPT_TSX_PIECE_NODE) siblingIsText = false;
      }
    }
    return false;
  };

  visit(value.node, 0, false);
  return chunks.join("") || "[PromptTsx tool result contained no renderable text]";
}

/** Plain-text serialization of a response part (internal data and thinking parts → ""). */
export function partToText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelPromptTsxPart) {
    return promptTsxPartText(part.value);
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    if (isInternalDataPart(part)) return "";
    if (isTextualMimeType(part.mimeType)) return new TextDecoder().decode(part.data);
    return binaryDataPlaceholder(part.mimeType, part.data.byteLength);
  }

  if (typeof vscode.LanguageModelThinkingPart === "function" && part instanceof vscode.LanguageModelThinkingPart) {
    return "";
  }

  return structuredValueText(part);
}
