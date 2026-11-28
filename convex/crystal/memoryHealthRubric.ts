/**
 * Memory health rubric (ILL-1177). Port of the Gerald Dashboard Cortex audit
 * rubric design (ILL-950) to Memory Crystal's own signals.
 *
 * Turns one stored snapshot (memoryHealthModel.ts) into eleven 0-10 scores.
 * Deterministic: the same snapshot always gets the same scores, nothing is
 * hand-entered, and each score carries the evidence it used. History is
 * re-scored with this code at read time, so a rubric change applies to every
 * snapshot.
 *
 * "The sample" is a time-uniform sample: random points between the account's
 * oldest and newest memory creation times, each taking the first active
 * non-KB memory at or after it. It is uniform over creation time, not over
 * memories, so bursts of creation are under-represented.
 *
 * `scale(v, best, worst)` is linear: 10 at `best` or better, 0 at `worst` or
 * worse. A category whose inputs are missing, or too thin to mean anything,
 * scores null ("not measured") and is left out of the overall mean.
 *
 * | Category | Rule |
 * |---|---|
 * | Speed | 0.4 x scale(recall p50, 300, 1500 ms) + 0.6 x scale(recall p95, 600, 3000 ms) over the last 7 UTC days of /api/mcp/recall; needs 5 recalls |
 * | Accuracy | 10 x (0.6 hit@5 + 0.4 MRR@5) on the self-probe: memories from the time-uniform sample, queried by words from their own title, recordAccess false; needs 5 probes |
 * | Noise | scale(share of answer-check candidates dropped, 0.25, 0.85) over 7 days; needs 5 checked recalls |
 * | Abstain | 10 x share of nonsense probes that came back empty |
 * | Context weight | scale(returned chars per recall, 3000, 15000) over 7 days; needs 5 recalls |
 * | Duplicates | scale(exact twin rate + near twin rate in the time-uniform sample, 0.01, 0.15); needs 10 sampled memories. Exact twin: another active non-KB memory with the same contentHash (a hash of store, category and normalized content), the same channel and the same agent stamp. Near twin: vector similarity 0.95+ to another active non-KB memory with the same channel and agent stamp |
 * | Never recalled | scale(share of active memories never recalled, 0.5, 1.0) |
 * | Fluff | scale(share of the time-uniform sample that ltmHygiene would call fluff, 0.02, 0.25); needs 10 sampled memories |
 * | Distillation backlog | 0.5 x scale(STM not yet extracted / STM rows, 0.01, 0.2) + 0.5 x scale(oldest pending age, 6, 72 h) |
 * | Capture freshness | scale(hours since the last capture, 24, 336) |
 * | Cost | scale(estimated provider spend per day over 7 days, $0.05, $2.00), excluding this page's own self-probe embeddings |
 */
import { histogramPercentile } from "./recallHealthStats";
import type { MemoryHealthMetrics } from "./memoryHealthModel";

export const CATEGORIES = [
  { key: "speed", label: "Speed" },
  { key: "accuracy", label: "Accuracy" },
  { key: "noise", label: "Noise" },
  { key: "abstain", label: "Abstain" },
  { key: "context_weight", label: "Context weight" },
  { key: "duplicates", label: "Duplicates" },
  { key: "never_recalled", label: "Never recalled" },
  { key: "fluff", label: "Fluff" },
  { key: "distillation", label: "Distillation backlog" },
  { key: "freshness", label: "Capture freshness" },
  { key: "cost", label: "Cost" },
] as const;

export type CategoryKey = (typeof CATEGORIES)[number]["key"];
export type CategoryScore = { key: CategoryKey; label: string; score: number | null; evidence: string };
export type ScoredSnapshot = { overall: number | null; scores: CategoryScore[] };
export type ScorableSnapshot = { startedAt: number; metrics: MemoryHealthMetrics };

export const MIN_RECALLS = 5;
export const MIN_PROBES = 5;
export const MIN_SAMPLE = 10;
const HOUR_MS = 60 * 60 * 1000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v: number) => Math.max(0, Math.min(10, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const pct1 = (v: number) => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
const fixed = (v: number, d = 2) => v.toFixed(d);
const int = (v: number) => Math.round(v).toLocaleString("en-US");
const hours = (ms: number) => (ms < 48 * HOUR_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / (24 * HOUR_MS))} days`);

export function scale(value: number | null | undefined, best: number, worst: number): number | null {
  const v = num(value);
  if (v == null) return null;
  return clamp(((worst - v) / (worst - best)) * 10);
}

function result(score: number | null, evidence: string) {
  return { score: score == null ? null : round1(clamp(score)), evidence };
}

const notMeasured = (what: string) => result(null, `Not measured: ${what}.`);

function speed(m: MemoryHealthMetrics) {
  const r = m.recall;
  if (!r || r.recalls < MIN_RECALLS) return notMeasured(`fewer than ${MIN_RECALLS} recalls in the last ${r?.days ?? 7} days (${r?.recalls ?? 0})`);
  const p50 = histogramPercentile(r.latencyBuckets, 0.5);
  const p95 = histogramPercentile(r.latencyBuckets, 0.95);
  if (p50 == null || p95 == null) return notMeasured("recall latency");
  return result(0.4 * scale(p50, 300, 1500)! + 0.6 * scale(p95, 600, 3000)!,
    `Recall p50 ${int(p50)} ms / p95 ${int(p95)} ms over ${int(r.recalls)} recalls in ${r.days} days.`);
}

export function probeAccuracy(m: MemoryHealthMetrics): { n: number; hit5: number; mrr: number } | null {
  const positives = m.probe?.positives ?? [];
  if (!positives.length) return null;
  let hits = 0;
  let rr = 0;
  for (const p of positives) {
    if (p.rank != null && p.rank >= 1 && p.rank <= 5) {
      hits += 1;
      rr += 1 / p.rank;
    }
  }
  return { n: positives.length, hit5: hits / positives.length, mrr: rr / positives.length };
}

function accuracy(m: MemoryHealthMetrics) {
  const a = probeAccuracy(m);
  if (!a || a.n < MIN_PROBES) {
    const why = m.probe?.skippedReason ? `self-probe skipped (${m.probe.skippedReason})` : `fewer than ${MIN_PROBES} self-probes (${a?.n ?? 0})`;
    return notMeasured(why);
  }
  return result(10 * (0.6 * a.hit5 + 0.4 * a.mrr),
    `Self-probe on ${a.n} memories from a time-uniform sample: found in the top 5 ${pct(a.hit5)} of the time, MRR@5 ${fixed(a.mrr)}.`);
}

function noise(m: MemoryHealthMetrics) {
  const r = m.recall;
  if (!r || r.rerankRuns < MIN_RECALLS || r.rerankCandidates <= 0) {
    return notMeasured(`the answer check ran on fewer than ${MIN_RECALLS} recalls (${r?.rerankRuns ?? 0})`);
  }
  const dropped = 1 - Math.min(r.rerankKept, r.rerankCandidates) / r.rerankCandidates;
  return result(scale(dropped, 0.25, 0.85),
    `The answer check dropped ${pct(dropped)} of ${int(r.rerankCandidates)} candidates over ${int(r.rerankRuns)} recalls${r.rerankFallbacks ? `; ${int(r.rerankFallbacks)} recalls skipped the check` : ""}.`);
}

function abstain(m: MemoryHealthMetrics) {
  const negatives = m.probe?.negatives ?? [];
  if (!negatives.length) {
    return notMeasured(m.probe?.skippedReason ? `self-probe skipped (${m.probe.skippedReason})` : "nonsense probes");
  }
  const empty = negatives.filter((n) => n.returned === 0).length;
  const r = m.recall;
  const live = r && r.recalls > 0
    ? ` Live: ${pct1(r.emptyRecalls / r.recalls)} of ${int(r.recalls)} recalls returned nothing${r.rerankAbstained ? `, ${int(r.rerankAbstained)} by the answer check` : ""}.`
    : "";
  return result(10 * (empty / negatives.length),
    `${empty} of ${negatives.length} nonsense probes came back empty.${live}`);
}

function contextWeight(m: MemoryHealthMetrics) {
  const r = m.recall;
  if (!r || r.recalls < MIN_RECALLS) return notMeasured(`fewer than ${MIN_RECALLS} recalls`);
  const chars = r.returnedChars / r.recalls;
  return result(scale(chars, 3000, 15000),
    `${int(chars)} chars per recall (about ${int(chars / 4)} tokens), ${fixed(r.returnedMemories / r.recalls, 1)} memories per recall.`);
}

export function duplicateRate(m: MemoryHealthMetrics): number | null {
  const s = m.sample;
  if (!s || s.sampled < MIN_SAMPLE) return null;
  // Nothing was checked: no hashed row for exact twins and no completed near search.
  if (s.hashed === 0 && s.nearSearched === 0) return null;
  const exact = s.hashed > 0 ? s.exactDuplicates / s.hashed : 0;
  const near = s.nearSearched > 0 ? s.nearDuplicates / s.nearSearched : 0;
  return exact + near;
}

function duplicates(m: MemoryHealthMetrics) {
  const s = m.sample;
  if (!s || s.sampled < MIN_SAMPLE) return notMeasured(`fewer than ${MIN_SAMPLE} sampled memories (${s?.sampled ?? 0})`);
  const rate = duplicateRate(m);
  if (rate == null) return notMeasured("no sampled memory had a content hash and no near-duplicate search ran");
  const near = s.nearSearched > 0
    ? `${s.nearDuplicates} of ${s.nearSearched} have a near twin (similarity 0.95+, same channel and agent)`
    : `near-duplicates not searched today${s.nearSkippedReason ? ` (${s.nearSkippedReason})` : ""}, so this score counts exact twins only`;
  return result(scale(rate, 0.01, 0.15),
    `${s.exactDuplicates} of ${s.hashed} memories in a time-uniform sample have an exact twin (same store, category, content, channel and agent); ${near}.`);
}

export function neverRecalledShare(m: MemoryHealthMetrics): number | null {
  const st = m.store;
  const recalled = num(st?.activeRecalledMemories);
  if (!st || recalled == null || st.activeMemories <= 0) return null;
  return 1 - Math.min(recalled, st.activeMemories) / st.activeMemories;
}

function neverRecalled(m: MemoryHealthMetrics) {
  const share = neverRecalledShare(m);
  const st = m.store;
  if (share == null || !st) return notMeasured("recall counts for active memories");
  return result(scale(share, 0.5, 1.0),
    `${pct(share)} of ${int(st.activeMemories)} active memories have never been recalled (${int(st.knowledgeBaseMemories)} are knowledge-base chunks).`);
}

function fluff(m: MemoryHealthMetrics) {
  const s = m.sample;
  if (!s || s.sampled < MIN_SAMPLE) return notMeasured(`fewer than ${MIN_SAMPLE} sampled memories (${s?.sampled ?? 0})`);
  const share = s.fluff / s.sampled;
  return result(scale(share, 0.02, 0.25),
    `${s.fluff} of ${s.sampled} memories in a time-uniform sample look like fluff: weak, unsourced and unused, or a leftover digest line.`);
}

function distillation(m: MemoryHealthMetrics, startedAt: number) {
  const total = num(m.store?.totalMessages);
  const stm = m.stm;
  if (!stm || total == null) return notMeasured("short-term memory backlog");
  if (total <= 0) return notMeasured("no short-term messages");
  const share = Math.min(1, stm.pendingExtraction / total);
  const age = stm.oldestPendingAt != null ? Math.max(0, startedAt - stm.oldestPendingAt) : 0;
  const score = 0.5 * scale(share, 0.01, 0.2)! + 0.5 * scale(age / HOUR_MS, 6, 72)!;
  const count = `${stm.pendingCapped ? "at least " : ""}${int(stm.pendingExtraction)}`;
  return result(score,
    `${count} of ${int(total)} short-term messages not yet distilled (${pct1(share)})${stm.oldestPendingAt != null ? `; oldest waiting ${hours(age)}` : ""}.`);
}

function freshness(m: MemoryHealthMetrics, startedAt: number) {
  const last = Math.max(num(m.store?.lastCaptureAt) ?? 0, num(m.stm?.lastMessageAt) ?? 0);
  if (!last) return notMeasured("no capture recorded");
  const age = Math.max(0, startedAt - last);
  return result(scale(age / HOUR_MS, 24, 336), `Last capture ${hours(age)} before this snapshot.`);
}

function cost(m: MemoryHealthMetrics) {
  const c = m.cost;
  if (!c || c.days <= 0) return notMeasured("per-account provider spend");
  const perDay = c.estimatedUsd / c.days;
  return result(scale(perDay, 0.05, 2),
    `About $${fixed(perDay)}/day in model calls over ${c.days} days (${int(c.providerCalls / c.days)} calls/day; ${int(c.embedCalls)} embeddings, ${int(c.generateCalls)} generations). Estimated from call counts${c.probeCallsExcluded ? `, excluding ${int(c.probeCallsExcluded)} embeddings made by this page's own self-probe` : ""}; database usage is not attributed per account.`);
}

/** Score one snapshot. Pure. */
export function scoreSnapshot(snapshot: ScorableSnapshot): ScoredSnapshot {
  const m = snapshot.metrics ?? {};
  const results: Record<CategoryKey, { score: number | null; evidence: string }> = {
    speed: speed(m),
    accuracy: accuracy(m),
    noise: noise(m),
    abstain: abstain(m),
    context_weight: contextWeight(m),
    duplicates: duplicates(m),
    never_recalled: neverRecalled(m),
    fluff: fluff(m),
    distillation: distillation(m, snapshot.startedAt),
    freshness: freshness(m, snapshot.startedAt),
    cost: cost(m),
  };
  const scores = CATEGORIES.map(({ key, label }) => ({ key, label, ...results[key] }));
  const measured = scores.filter((c) => c.score != null);
  const overall = measured.length ? round1(measured.reduce((sum, c) => sum + (c.score as number), 0) / measured.length) : null;
  return { overall, scores };
}

/** Key numbers for the trend strip, from the same inputs the scores use. */
export function keyMetrics(snapshot: ScorableSnapshot) {
  const m = snapshot.metrics ?? {};
  const r = m.recall;
  const enough = r && r.recalls >= MIN_RECALLS;
  const a = probeAccuracy(m);
  const dup = duplicateRate(m);
  const never = neverRecalledShare(m);
  return {
    recallP50Ms: enough ? histogramPercentile(r.latencyBuckets, 0.5) : null,
    recallP95Ms: enough ? histogramPercentile(r.latencyBuckets, 0.95) : null,
    probeHit5: a && a.n >= MIN_PROBES ? Math.round(a.hit5 * 1000) / 1000 : null,
    charsPerRecall: enough ? Math.round(r.returnedChars / r.recalls) : null,
    duplicateRate: dup == null ? null : Math.round(dup * 1000) / 1000,
    neverRecalledShare: never == null ? null : Math.round(never * 1000) / 1000,
    activeMemories: num(m.store?.activeMemories),
    pendingExtraction: num(m.stm?.pendingExtraction),
  };
}
