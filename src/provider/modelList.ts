import type * as vscode from "vscode";
import { createHash } from "node:crypto";
import {
  MODEL_LIST_CACHE_KEY_PREFIX,
  MODEL_LIST_CACHE_TTL_MS,
  MODEL_LIST_FETCH_MAX_RETRIES,
  OPEN_CODE_CLIENT,
  MODEL_LIST_FETCH_RETRY_BASE_MS,
  MODEL_LIST_FETCH_TIMEOUT_MS,
} from "../config";
import { getErrorMessage, sleep } from "../utils";
import { getUserAgent, isTransientFetchError, type ModelListEntry, type ModelListResponse, type ProviderDefinition } from "./definitions";
import { auxiliarySessionId } from "../request/headers";
import { resolveBaseVendor } from "../providerTypes";

interface CachedModelSnapshot {
  /** Complete credential-scoped catalog before availability/free-only filtering. */
  ids: string[];
  fetchedAt: number;
}

/**
 * Fetches the live model catalog with retry/backoff and cancellation support,
 * caching each catalog by endpoint and non-secret credential scope.
 */
export class ModelListFetcher {
  private readonly cached = new Map<string, CachedModelSnapshot>();

  constructor(
    private readonly deps: {
      context: vscode.ExtensionContext;
      definition: ProviderDefinition;
      log(message: string): void;
      replaceLiveModelMetadata(models: ModelListEntry[] | undefined): void;
      filterAvailableModels(modelIds: string[], liveModelIds?: ReadonlySet<string>, apiKey?: string): Promise<string[]>;
    },
  ) {}

  async fetch(apiKey?: string, token?: vscode.CancellationToken): Promise<string[]> {
    const credential = apiKey?.trim() || undefined;
    if (token?.isCancellationRequested) return this.fallback(credential);

    // VS Code polls provideLanguageModelChatInformation frequently. Consult the
    // fresh cache before the live request so each poll is local work.
    const cachedFresh = this.loadCached(credential);
    if (cachedFresh) {
      return this.deps.filterAvailableModels(cachedFresh.ids, undefined, credential);
    }

    const headers: Record<string, string> = {
      "User-Agent": getUserAgent(),
      Accept: "application/json",
      "x-opencode-client": OPEN_CODE_CLIENT,
      "x-opencode-session": auxiliarySessionId(this.deps.context),
    };
    if (credential) {
      headers.Authorization = `Bearer ${credential}`;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= MODEL_LIST_FETCH_MAX_RETRIES; attempt++) {
      if (token?.isCancellationRequested) {
        return this.fallback(credential);
      }
      let cancellationLink: { signal: AbortSignal; dispose: () => void } | undefined;
      try {
        const timeoutSignal = AbortSignal.timeout(MODEL_LIST_FETCH_TIMEOUT_MS);
        cancellationLink = token ? this.signalFromToken(token) : undefined;
        const signal = token && cancellationLink ? AbortSignal.any([timeoutSignal, cancellationLink.signal]) : timeoutSignal;

        const response = await fetch(this.deps.definition.modelsUrl, { headers, signal });
        if (!response.ok) {
          throw new Error(`Model list request failed (${String(response.status)}): ${response.statusText}`);
        }
        const data = (await response.json()) as ModelListResponse;
        const catalog = Array.isArray(data.data) ? data.data : undefined;
        if (catalog) {
          this.deps.replaceLiveModelMetadata(catalog);
        }
        const allIds = catalog?.map((model) => model.id).filter((id): id is string => typeof id === "string" && id.length > 0) ?? [];

        // Cache the complete credential-scoped catalog, not the current
        // free-only view. A later setting/key change can then re-filter the
        // same snapshot without waiting for the TTL. An explicit empty catalog
        // is authoritative; only a malformed response uses the bundled list.
        const liveIds = catalog ? new Set(allIds) : undefined;
        const candidateIds = catalog ? allIds : this.deps.definition.fallbackModels;
        const filtered = await this.deps.filterAvailableModels(candidateIds, liveIds, credential);
        const snapshot = { ids: [...candidateIds], fetchedAt: Date.now() };
        const cacheKey = this.cacheKey(credential);
        this.cached.set(cacheKey, snapshot);
        void this.deps.context.globalState.update(cacheKey, snapshot);
        return filtered;
      } catch (error) {
        cancellationLink?.dispose();
        cancellationLink = undefined;
        lastError = error;
        if (token?.isCancellationRequested) {
          return await this.fallback(credential);
        }
        const aborted = typeof DOMException === "function" && error instanceof DOMException && error.name === "AbortError";
        const transient = aborted || isTransientFetchError(error);
        if (!transient || attempt === MODEL_LIST_FETCH_MAX_RETRIES) {
          break;
        }
        const backoff = MODEL_LIST_FETCH_RETRY_BASE_MS * Math.pow(2, attempt);
        this.deps.log(
          `[fetchModels] ${this.deps.definition.displayName}: transient error (attempt ${String(attempt + 1)}/${String(MODEL_LIST_FETCH_MAX_RETRIES + 1)}): ${this.errMsg(error)}. Retrying in ${String(backoff)}ms.`,
        );
        try {
          await sleep(backoff, token);
        } catch {
          return await this.fallback(credential);
        }
      } finally {
        cancellationLink?.dispose();
      }
    }

    const cached = this.loadCached(credential);
    if (cached) {
      this.deps.log(
        `[fetchModels] ${this.deps.definition.displayName}: ${this.errMsg(lastError)}. Using cached model list (${String(cached.ids.length)} models, fetched ${new Date(cached.fetchedAt).toISOString()}).`,
      );
      return this.deps.filterAvailableModels(cached.ids, undefined, credential);
    }
    this.deps.log(
      `[fetchModels] ${this.deps.definition.displayName}: ${this.errMsg(lastError)}. Using bundled model list (${String(this.deps.definition.fallbackModels.length)} models).`,
    );
    return this.deps.filterAvailableModels(this.deps.definition.fallbackModels, undefined, credential);
  }

  /** Bundle cancellation semantics from a VS Code token into an AbortSignal. */
  private signalFromToken(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    let subscription: vscode.Disposable | undefined;
    if (token.isCancellationRequested) {
      controller.abort();
    } else {
      subscription = token.onCancellationRequested(() => {
        controller.abort();
      });
    }
    return {
      signal: controller.signal,
      dispose: () => {
        subscription?.dispose();
        subscription = undefined;
      },
    };
  }

  private errMsg(error: unknown): string {
    const message = getErrorMessage(error);
    const cause = (error as { cause?: { code?: string; name?: string; message?: string } } | null | undefined)?.cause;
    return cause?.code ? `${message} [${cause.code}]` : message;
  }

  /** Resolve the model list when the live fetch is cancelled or unavailable. */
  fallback(apiKey?: string): Promise<string[]> {
    const credential = apiKey?.trim() || undefined;
    const cached = this.loadCached(credential);
    if (cached) {
      return this.deps.filterAvailableModels(cached.ids, undefined, credential);
    }
    return this.deps.filterAvailableModels(this.deps.definition.fallbackModels, undefined, credential);
  }

  /** Drop one credential scope's cached snapshot. */
  invalidate(apiKey?: string): void {
    const cacheKey = this.cacheKey(apiKey?.trim() || undefined);
    this.cached.delete(cacheKey);
    void this.deps.context.globalState.update(cacheKey, undefined);
  }

  private cacheKey(apiKey?: string): string {
    const credential = apiKey?.trim() || undefined;
    const credentialScope = credential ? createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 16) : "anonymous";
    return `${MODEL_LIST_CACHE_KEY_PREFIX}::${resolveBaseVendor(this.deps.definition.vendor)}::${this.deps.definition.modelsUrl}::${credentialScope}`;
  }

  private loadCached(apiKey?: string): CachedModelSnapshot | undefined {
    const cacheKey = this.cacheKey(apiKey);
    const inMemory = this.cached.get(cacheKey);
    if (inMemory && Date.now() - inMemory.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
      return inMemory;
    }
    const stored = this.deps.context.globalState.get<CachedModelSnapshot>(cacheKey);
    if (stored && Array.isArray(stored.ids) && typeof stored.fetchedAt === "number") {
      if (Date.now() - stored.fetchedAt < MODEL_LIST_CACHE_TTL_MS) {
        this.cached.set(cacheKey, stored);
        return stored;
      }
    }
    return undefined;
  }
}
