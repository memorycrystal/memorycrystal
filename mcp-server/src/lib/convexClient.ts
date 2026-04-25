import { AsyncLocalStorage } from "node:async_hooks";
import { ConvexHttpClient } from "convex/browser";

type McpRequestContext = {
  apiKey?: string;
  authToken?: string;
  sdkClient?: ConvexHttpClient;
};

const requestContext = new AsyncLocalStorage<McpRequestContext>();

function getRequestContext() {
  return requestContext.getStore();
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

export function createMcpRequestContext(bearerToken?: string | null): McpRequestContext {
  const token = bearerToken?.trim();
  if (!token) return {};

  if (looksLikeJwt(token)) {
    return { authToken: token };
  }

  return { apiKey: token };
}

export function runWithMcpRequestContext<T>(context: McpRequestContext, callback: () => T): T {
  return requestContext.run(context, callback);
}

/**
 * True when the current request — or the process env — has an API key configured.
 * Tool handlers use this to decide whether to call the HTTP API (which carries the
 * API key header) instead of the Convex SDK client (which only understands JWTs).
 * Previously each tool checked only `process.env.MEMORY_CRYSTAL_API_KEY`, which
 * worked for stdio mode but skipped the per-request API key delivered via SSE
 * Authorization headers — routing those requests through an unauthenticated
 * SDK client that threw "Unauthenticated" downstream.
 */
export function hasApiKeyAuth(): boolean {
  return Boolean(
    getRequestContext()?.apiKey ||
    process.env.MEMORY_CRYSTAL_API_KEY ||
    process.env.CRYSTAL_API_KEY,
  );
}

// Cached client for no-context (stdio) mode. Safe to cache because stdio is
// single-user per process; there is no per-request identity to isolate.
let cachedNoContextClient: ConvexHttpClient | null = null;

export const getConvexClient = (): ConvexHttpClient => {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required");
  }

  const context = getRequestContext();
  if (context) {
    if (!context.sdkClient) {
      context.sdkClient = new ConvexHttpClient(
        convexUrl,
        context.authToken ? { auth: context.authToken } : undefined
      );
    }
    return context.sdkClient;
  }
  if (!cachedNoContextClient) {
    cachedNoContextClient = new ConvexHttpClient(convexUrl);
  }
  return cachedNoContextClient;
};

// ---------------------------------------------------------------------------
// HTTP API client (calls .convex.site HTTP endpoints with API key auth)
// Used by index.ts and wake.ts for the newer REST-style API surface
// ---------------------------------------------------------------------------

export interface ConvexClientOptions {
  baseUrl?: string;
  apiKey?: string;
}

export class ConvexClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: ConvexClientOptions = {}) {
    const baseUrl =
      options.baseUrl ??
      process.env.MEMORY_CRYSTAL_API_URL ??
      process.env.MEMORY_CRYSTAL_BACKEND_URL ??
      process.env.CRYSTAL_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "MEMORY_CRYSTAL_API_URL environment variable is required (legacy aliases: MEMORY_CRYSTAL_BACKEND_URL, CRYSTAL_BASE_URL)"
      );
    }
    this.baseUrl = baseUrl;
    this.apiKey =
      options.apiKey ??
      getRequestContext()?.apiKey ??
      process.env.MEMORY_CRYSTAL_API_KEY ??
      process.env.CRYSTAL_API_KEY ??
      "";

    if (!this.apiKey) {
      throw new Error(
        "MEMORY_CRYSTAL_API_KEY environment variable is required (legacy alias: CRYSTAL_API_KEY)"
      );
    }
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    const raw = await response.text();
    const data = raw ? safeParseJson(raw) : null;

    if (!response.ok) {
      const message =
        (data && typeof data === "object" && "error" in data && String((data as { error?: string }).error)) ||
        `HTTP ${response.status}`;
      throw new Error(`Memory Crystal API error: ${message}`);
    }

    return data as T;
  }
}

function safeParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return { raw: input };
  }
}
