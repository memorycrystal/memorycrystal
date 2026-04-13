// crystal-compaction.js — CrystalCompactionEngine: hierarchical context compaction
// Plain JavaScript ES module. No TypeScript.
import { createHash } from "node:crypto";
import { estimateTokens, formatTimestamp } from "./crystal-summarizer.js";
import { FRESH_TAIL_COUNT } from "./crystal-assembler.js";

const DEFAULT_LEAF_CHUNK = 4_000;
const CONDENSED_MIN_RATIO = 0.1;
const FALLBACK_MAX_CHARS = 512 * 4;

/**
 * Default configuration for CrystalCompactionEngine.
 * @type {object}
 */
export const DEFAULT_CONFIG = {
  contextThreshold: 0.75, freshTailCount: FRESH_TAIL_COUNT,
  leafMinFanout: 3, leafChunkTokens: 4000, leafTargetTokens: 600,
  condensedTargetTokens: 900, maxRounds: 10,
};

function genId(c) { return "sum_" + createHash("sha256").update(c + Date.now()).digest("hex").slice(0, 16); }

/**
 * CrystalCompactionEngine — hierarchical context compaction for Memory Crystal.
 *
 * Store interface (all async): getContextItems, getContextTokenCount, getMessageById,
 * getSummary, insertSummary, linkSummaryToMessages, linkSummaryToParents,
 * replaceContextRangeWithSummary, getDistinctDepthsInContext.
 */
export class CrystalCompactionEngine {
  /** @param {object} store @param {object} [config] */
  constructor(store, config) {
    this.store = store;
    this.config = Object.assign({}, DEFAULT_CONFIG, config || {});
  }

  _cfgN(k, def) { const v = this.config[k]; return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : def; }
  _leafChunk() { return this._cfgN("leafChunkTokens", DEFAULT_LEAF_CHUNK); }
  _freshCount() { return this._cfgN("freshTailCount", 0); }
  _leafFanout() { return this._cfgN("leafMinFanout", 3); }
  _condFanout() { return this._cfgN("condensedMinFanout", 2); }
  _condMinChunk() { return Math.max(this.config.condensedTargetTokens || 900, Math.floor(this._leafChunk() * CONDENSED_MIN_RATIO)); }

  _sumTok(s) { return (typeof s.tokenCount === "number" && s.tokenCount > 0) ? s.tokenCount : estimateTokens(s.content || ""); }
  async _msgTok(id) { const m = await this.store.getMessageById(id); if (!m) return 0; return (m.tokenCount > 0) ? m.tokenCount : estimateTokens(m.content || ""); }

  _tailOrdinal(items) {
    const n = this._freshCount(); if (n <= 0) return Infinity;
    const raw = items.filter((i) => i.itemType === "message" && i.messageId != null);
    if (!raw.length) return Infinity;
    return raw[Math.max(0, raw.length - n)]?.ordinal ?? Infinity;
  }

  // ── evaluate ──────────────────────────────────────────────────────────────

  /**
   * Evaluate whether compaction is needed.
   * @param {string} sessionKey @param {number} tokenBudget @param {number} [observedTokenCount]
   * @returns {Promise<{shouldCompact:boolean,reason:string,currentTokens:number,threshold:number}>}
   */
  async evaluate(sessionKey, tokenBudget, observedTokenCount) {
    const stored = await this.store.getContextTokenCount(sessionKey);
    const live = (typeof observedTokenCount === "number" && observedTokenCount > 0) ? Math.floor(observedTokenCount) : 0;
    const current = Math.max(stored, live);
    const threshold = Math.floor((this.config.contextThreshold || 0.75) * tokenBudget);
    return current > threshold
      ? { shouldCompact: true, reason: "threshold", currentTokens: current, threshold }
      : { shouldCompact: false, reason: "none", currentTokens: current, threshold };
  }

  // ── Chunk selection ───────────────────────────────────────────────────────

  async _oldestLeafChunk(sessionKey) {
    const items = await this.store.getContextItems(sessionKey);
    const tail = this._tailOrdinal(items);
    const limit = this._leafChunk();
    const chunk = []; let total = 0; let started = false;
    for (const it of items) {
      if (it.ordinal >= tail) break;
      if (!started) { if (it.itemType !== "message" || it.messageId == null) continue; started = true; }
      else if (it.itemType !== "message" || it.messageId == null) break;
      const t = await this._msgTok(it.messageId);
      if (chunk.length && total + t > limit) break;
      chunk.push(it); total += t;
      if (total >= limit) break;
    }
    return { items: chunk };
  }

  async _oldestChunkAtDepth(sessionKey, depth, tailOverride) {
    const items = await this.store.getContextItems(sessionKey);
    const tail = typeof tailOverride === "number" ? tailOverride : this._tailOrdinal(items);
    const limit = this._leafChunk();
    const chunk = []; let total = 0;
    for (const it of items) {
      if (it.ordinal >= tail) break;
      if (it.itemType !== "summary" || it.summaryId == null) { if (chunk.length) break; continue; }
      const s = await this.store.getSummary(it.summaryId);
      if (!s) { if (chunk.length) break; continue; }
      if (s.depth !== depth) { if (chunk.length) break; continue; }
      const t = this._sumTok(s);
      if (chunk.length && total + t > limit) break;
      chunk.push(it); total += t;
      if (total >= limit) break;
    }
    return { items: chunk, summaryTokens: total };
  }

  async _shallowestCandidate(sessionKey) {
    const items = await this.store.getContextItems(sessionKey);
    const tail = this._tailOrdinal(items);
    const minChunk = this._condMinChunk();
    const depths = await this.store.getDistinctDepthsInContext(sessionKey, { maxOrdinalExclusive: tail });
    for (const d of depths) {
      const fanout = d === 0 ? this._leafFanout() : this._condFanout();
      const chunk = await this._oldestChunkAtDepth(sessionKey, d, tail);
      if (chunk.items.length >= fanout && chunk.summaryTokens >= minChunk) return { targetDepth: d, chunk };
    }
    return null;
  }

  // ── Prior context helpers ─────────────────────────────────────────────────

  async _priorLeafCtx(sessionKey, msgItems) {
    if (!msgItems.length) return undefined;
    const start = Math.min(...msgItems.map((i) => i.ordinal));
    const all = await this.store.getContextItems(sessionKey);
    const prior = all.filter((i) => i.ordinal < start && i.itemType === "summary" && typeof i.summaryId === "string").slice(-2);
    const parts = [];
    for (const p of prior) { const s = await this.store.getSummary(p.summaryId); if (s?.content?.trim()) parts.push(s.content.trim()); }
    return parts.length ? parts.join("\n\n") : undefined;
  }

  async _priorSumCtxAtDepth(sessionKey, sumItems, depth) {
    if (!sumItems.length) return undefined;
    const start = Math.min(...sumItems.map((i) => i.ordinal));
    const all = await this.store.getContextItems(sessionKey);
    const prior = all.filter((i) => i.ordinal < start && i.itemType === "summary" && typeof i.summaryId === "string").slice(-4);
    const parts = [];
    for (const p of prior) { const s = await this.store.getSummary(p.summaryId); if (s?.depth === depth && s.content?.trim()) parts.push(s.content.trim()); }
    return parts.length ? parts.slice(-2).join("\n\n") : undefined;
  }

  // ── Escalation ────────────────────────────────────────────────────────────

  async _escalate(text, summarizeFn, opts) {
    if (!text.trim()) return { content: "[Truncated from 0 tokens]", level: "fallback" };
    const input = Math.max(1, estimateTokens(text));
    if (typeof summarizeFn !== "function") {
      const trunc = text.length > FALLBACK_MAX_CHARS ? text.slice(0, FALLBACK_MAX_CHARS) : text;
      return { content: `${trunc}\n[Truncated from ${input} tokens]`, level: "fallback" };
    }
    let out = await summarizeFn(text, false, opts || {});
    if (estimateTokens(out) < input) return { content: out, level: "normal" };
    out = await summarizeFn(text, true, opts || {});
    if (estimateTokens(out) < input) return { content: out, level: "aggressive" };
    const trunc = text.length > FALLBACK_MAX_CHARS ? text.slice(0, FALLBACK_MAX_CHARS) : text;
    return { content: `${trunc}\n[Truncated from ${input} tokens]`, level: "fallback" };
  }

  // ── Leaf pass ─────────────────────────────────────────────────────────────

  /**
   * Run one leaf pass: summarize oldest raw chunk outside the fresh tail.
   * Produces narrative with timestamps and "Expand for details about: ..." footer.
   * @param {string} sessionKey @param {Function} summarizeFn
   * @returns {Promise<{actionTaken:boolean,...}>}
   */
  async compactLeaf(sessionKey, summarizeFn) {
    const before = await this.store.getContextTokenCount(sessionKey);
    const chunk = await this._oldestLeafChunk(sessionKey);
    if (!chunk.items.length) return { actionTaken: false, tokensBefore: before, tokensAfter: before, condensed: false };
    const prevCtx = await this._priorLeafCtx(sessionKey, chunk.items);
    const r = await this._leafPass(sessionKey, chunk.items, summarizeFn, prevCtx);
    const after = await this.store.getContextTokenCount(sessionKey);
    return { actionTaken: true, tokensBefore: before, tokensAfter: after, createdSummaryId: r.summaryId, condensed: false, level: r.level };
  }

  async _leafPass(sessionKey, msgItems, summarizeFn, prevCtx) {
    const tz = this.config.timezone || "UTC";
    const msgs = [];
    for (const it of msgItems) {
      if (it.messageId == null) continue;
      const m = await this.store.getMessageById(it.messageId);
      if (!m) continue;
      const at = m.createdAt instanceof Date ? m.createdAt : new Date(m.createdAt || Date.now());
      msgs.push({ messageId: m.messageId, content: m.content || "", createdAt: at, tokenCount: (m.tokenCount > 0 ? m.tokenCount : estimateTokens(m.content || "")) });
    }
    const text = msgs.map((m) => `[${formatTimestamp(m.createdAt, tz)}]\n${m.content}`).join("\n\n");
    const s = await this._escalate(text, summarizeFn, { previousSummary: prevCtx, isCondensed: false });
    const id = genId(s.content); const tc = estimateTokens(s.content);
    const times = msgs.map((m) => m.createdAt.getTime());
    await this.store.insertSummary({ summaryId: id, sessionKey, kind: "leaf", depth: 0, content: s.content, tokenCount: tc, earliestAt: times.length ? new Date(Math.min(...times)) : undefined, latestAt: times.length ? new Date(Math.max(...times)) : undefined, descendantCount: 0, descendantTokenCount: 0, sourceMessageTokenCount: msgs.reduce((a, m) => a + Math.max(0, Math.floor(m.tokenCount)), 0) });
    await this.store.linkSummaryToMessages(id, msgs.map((m) => m.messageId));
    const ords = msgItems.map((i) => i.ordinal);
    await this.store.replaceContextRangeWithSummary(sessionKey, Math.min(...ords), Math.max(...ords), id);
    return { summaryId: id, level: s.level, content: s.content };
  }

  // ── Condensed pass ────────────────────────────────────────────────────────

  async _condensedPass(sessionKey, sumItems, targetDepth, summarizeFn) {
    const tz = this.config.timezone || "UTC";
    const recs = [];
    for (const it of sumItems) { if (it.summaryId == null) continue; const r = await this.store.getSummary(it.summaryId); if (r) recs.push(r); }
    const text = recs.map((s) => {
      const toDate = (v) => v instanceof Date ? v : new Date(v || Date.now());
      return `[${formatTimestamp(toDate(s.earliestAt || s.createdAt), tz)} - ${formatTimestamp(toDate(s.latestAt || s.createdAt), tz)}]\n${s.content}`;
    }).join("\n\n");
    const prevCtx = targetDepth === 0 ? await this._priorSumCtxAtDepth(sessionKey, sumItems, targetDepth) : undefined;
    const c = await this._escalate(text, summarizeFn, { previousSummary: prevCtx, isCondensed: true, depth: targetDepth + 1 });
    const id = genId(c.content); const tc = estimateTokens(c.content);
    const toMs = (s, k) => { const d = s[k] || s.createdAt; return d instanceof Date ? d.getTime() : new Date(d || Date.now()).getTime(); };
    await this.store.insertSummary({ summaryId: id, sessionKey, kind: "condensed", depth: targetDepth + 1, content: c.content, tokenCount: tc, earliestAt: recs.length ? new Date(Math.min(...recs.map((s) => toMs(s, "earliestAt")))) : undefined, latestAt: recs.length ? new Date(Math.max(...recs.map((s) => toMs(s, "latestAt")))) : undefined, descendantCount: recs.reduce((n, s) => n + (s.descendantCount || 0) + 1, 0), descendantTokenCount: recs.reduce((n, s) => n + (s.tokenCount || 0) + (s.descendantTokenCount || 0), 0), sourceMessageTokenCount: recs.reduce((n, s) => n + (s.sourceMessageTokenCount || 0), 0) });
    await this.store.linkSummaryToParents(id, recs.map((s) => s.summaryId));
    const ords = sumItems.map((i) => i.ordinal);
    await this.store.replaceContextRangeWithSummary(sessionKey, Math.min(...ords), Math.max(...ords), id);
    return { summaryId: id, level: c.level };
  }

  // ── compact (full sweep) ──────────────────────────────────────────────────

  /**
   * Full compaction sweep: leaf passes then depth-aware condensation.
   * @param {string} sessionKey @param {number} tokenBudget @param {Function} summarizeFn @param {boolean} [force]
   * @returns {Promise<{actionTaken:boolean,tokensBefore:number,tokensAfter:number,condensed:boolean,...}>}
   */
  async compact(sessionKey, tokenBudget, summarizeFn, force) {
    force = force === true;
    const before = await this.store.getContextTokenCount(sessionKey);
    const threshold = Math.floor((this.config.contextThreshold || 0.75) * tokenBudget);
    if (!force && before <= threshold) return { actionTaken: false, tokensBefore: before, tokensAfter: before, condensed: false };
    const items = await this.store.getContextItems(sessionKey);
    if (!items.length) return { actionTaken: false, tokensBefore: before, tokensAfter: before, condensed: false };

    let done = false, condensed = false, id, level, prevCtx, prev = before;

    for (let r = 0; r < this.config.maxRounds; r++) {
      const chunk = await this._oldestLeafChunk(sessionKey);
      if (!chunk.items.length) break;
      const tb = await this.store.getContextTokenCount(sessionKey);
      const lr = await this._leafPass(sessionKey, chunk.items, summarizeFn, prevCtx);
      const ta = await this.store.getContextTokenCount(sessionKey);
      done = true; id = lr.summaryId; level = lr.level; prevCtx = lr.content;
      if (ta >= tb || ta >= prev) break;
      prev = ta;
    }

    for (let r = 0; r < this.config.maxRounds; r++) {
      const cand = await this._shallowestCandidate(sessionKey);
      if (!cand) break;
      const tb = await this.store.getContextTokenCount(sessionKey);
      const cr = await this._condensedPass(sessionKey, cand.chunk.items, cand.targetDepth, summarizeFn);
      const ta = await this.store.getContextTokenCount(sessionKey);
      done = true; condensed = true; id = cr.summaryId; level = cr.level;
      if (ta >= tb || ta >= prev) break;
      prev = ta;
    }

    const after = await this.store.getContextTokenCount(sessionKey);
    return { actionTaken: done, tokensBefore: before, tokensAfter: after, createdSummaryId: id, condensed, level };
  }
}
