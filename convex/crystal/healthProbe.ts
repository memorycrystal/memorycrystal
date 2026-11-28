/**
 * Opt-in deep health for `/api/mcp/health?deep=1` (ILL-1176). The default health response proves one authenticated
 * database read; this probes the recall dependencies a real recall needs: the query embedding, the memory vector
 * index and, when configured, the rerank model. Every probe uses fixed synthetic input and reports only a status,
 * its latency and a failure reason, never account data.
 */
import { buildRerankPrompt, parseRerankReply } from "./recallEngine/rerank";
import type { RerankReply } from "./recallEngine/types";

export const DEEP_HEALTH_PROBE_TIMEOUT_MS = 2_500;
/** Gateway source and cost-ledger reason for every provider call a deep probe makes. */
export const DEEP_HEALTH_SOURCE = "mcp.health.deep";
/** Deep probes per API key per rate-limit window (60 s); each one makes paid provider calls. */
export const DEEP_HEALTH_LIMIT_PER_WINDOW = 2;

export type DeepProbeStatus = "passed" | "failed" | "timeout" | "skipped";
export type DeepProbe = { status: DeepProbeStatus; ms: number; reason?: string };
/** `ready`: every configured probe passed. `degraded`: recall works without the rerank stage. `not_ready`: semantic recall cannot run. */
export type DeepReadiness = "ready" | "degraded" | "not_ready";

/**
 * Each probe gets an AbortSignal that fires when its deadline expires. The embedding and rerank ports hand it to the
 * provider gateway, which aborts the HTTP request. The vector search cannot be cancelled once issued
 * (ctx.vectorSearch takes no signal), so its deadline is response-only: the probe reports `timeout` and stops waiting,
 * but the search itself runs to completion. The credential lookup and cost debits before a provider call are
 * response-only too.
 */
export type DeepHealthPorts = {
  embed: (signal: AbortSignal) => Promise<{ ok: true; embedding: number[] } | { ok: false; reason: string }>;
  /** A limit-1 search on the account's memory vectors; resolves with the hit count only. */
  vectorSearch: (embedding: number[]) => Promise<number>;
  /** Undefined when no rerank model is configured: the stage is off and the probe is skipped. */
  rerank?: (signal: AbortSignal) => Promise<{ ok: true } | { ok: false; reason: string }>;
  now?: () => number;
  timeoutMs?: number;
};

export type DeepHealth = {
  readiness: DeepReadiness;
  checks: { recallEmbedding: DeepProbe; recallVectorSearch: DeepProbe; recallRerank: DeepProbe };
};

const TIMED_OUT = Symbol("timeout");

async function timed<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  now: () => number,
): Promise<{ value?: T; timedOut: boolean; error: boolean; ms: number }> {
  const started = now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  try {
    const value = await Promise.race([work(controller.signal), timeout]);
    if (value === TIMED_OUT) return { timedOut: true, error: false, ms: now() - started };
    return { value: value as T, timedOut: false, error: false, ms: now() - started };
  } catch {
    return { timedOut: false, error: true, ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const skipped = (reason: string): DeepProbe => ({ status: "skipped", ms: 0, reason });

function outcome<T>(run: Awaited<ReturnType<typeof timed<T>>>, passed: (value: T) => DeepProbe): DeepProbe {
  if (run.timedOut) return { status: "timeout", ms: run.ms, reason: "timeout" };
  if (run.error) return { status: "failed", ms: run.ms, reason: "error" };
  return { ...passed(run.value as T), ms: run.ms };
}

export async function runDeepHealth(ports: DeepHealthPorts): Promise<DeepHealth> {
  const now = ports.now ?? Date.now;
  const timeoutMs = ports.timeoutMs ?? DEEP_HEALTH_PROBE_TIMEOUT_MS;
  const rerankRun = ports.rerank ? timed(ports.rerank, timeoutMs, now) : null;
  const embedRun = await timed(ports.embed, timeoutMs, now);
  const reply = embedRun.value;
  const embedding = reply?.ok && Array.isArray(reply.embedding) && reply.embedding.length > 0 ? reply.embedding : null;
  const recallEmbedding = outcome(embedRun, (value): DeepProbe => {
    if (!value.ok) return { status: "failed", ms: 0, reason: value.reason };
    return embedding ? { status: "passed", ms: 0 } : { status: "failed", ms: 0, reason: "empty_embedding" };
  });
  const recallVectorSearch = embedding
    ? outcome(await timed(() => ports.vectorSearch(embedding), timeoutMs, now), (): DeepProbe => ({ status: "passed", ms: 0 }))
    : skipped("embedding_unavailable");
  const recallRerank = rerankRun
    ? outcome(await rerankRun, (value): DeepProbe => value.ok ? { status: "passed", ms: 0 } : { status: "failed", ms: 0, reason: value.reason })
    : skipped("not_configured");
  const semantic = recallEmbedding.status === "passed" && recallVectorSearch.status === "passed";
  const readiness: DeepReadiness = !semantic ? "not_ready"
    : recallRerank.status === "passed" || recallRerank.status === "skipped" ? "ready" : "degraded";
  return { readiness, checks: { recallEmbedding, recallVectorSearch, recallRerank } };
}

/** `?deep=1|true` on the URL, or `deep: true` in a POST body. */
export function wantsDeepHealth(url: string, body: unknown): boolean {
  const flag = new URL(url).searchParams.get("deep")?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  return typeof body === "object" && body !== null && (body as { deep?: unknown }).deep === true;
}

/** Fixed synthetic candidates for the rerank probe: no account data reaches the model. */
const RERANK_PROBE_QUERY = "What colour is the health probe marker?";
const RERANK_PROBE_CANDIDATES = [
  { title: "Health probe marker", content: "The health probe marker is teal." },
  { title: "Unrelated note", content: "A note about the weather that mentions no marker." },
];
/** The production answer-check prompt, built from the fixed synthetic candidates. */
export const deepHealthRerankPrompt = (): string => buildRerankPrompt(RERANK_PROBE_QUERY, RERANK_PROBE_CANDIDATES);
/**
 * A rerank reply passes only when the production parser accepts it, exactly as recall would; an HTTP-OK reply that
 * recall would discard as `invalid_response` fails the probe with that reason.
 */
export function deepRerankVerdict(reply: RerankReply): { ok: true } | { ok: false; reason: string } {
  if (!reply.ok) return { ok: false, reason: reply.reason };
  return parseRerankReply(reply.content, RERANK_PROBE_CANDIDATES.length) ? { ok: true } : { ok: false, reason: "invalid_response" };
}
/** A fixed probe phrase. The nonce defeats the per-isolate embedding cache, so the provider is actually called. */
export const deepHealthEmbeddingText = (nonce: number) => `memory crystal recall health probe ${nonce}`;
