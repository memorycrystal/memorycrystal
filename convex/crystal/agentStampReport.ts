import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { normalizeAgentStamp, readAgentStamp, sharedMarkers } from "./agentStamp";
import { sha256Hex } from "./crypto";

const MAX_PAGE_SIZE = 100;
// Reserved labels: `none` is the channel table's bucket for rows without a channel, and a `__proto__` key would be
// dropped by value serialization. Neither can be allowlisted, so a real stamp or prefix with that text is hashed.
const RESERVED_LABELS = new Set(["none", "__proto__"]);
const DAY_MS = 86_400_000;
// The clock must keep the whole 14-day window inside the years 0001 to 9999, so day labels stay ten characters.
const MIN_NOW_MS = new Date("0001-01-01T00:00:00.000Z").getTime() + 13 * DAY_MS;
const MAX_NOW_MS = new Date("9999-12-31T23:59:59.999Z").getTime();
const SOURCES = ["conversation", "cron", "observation", "inference", "external"] as const;
const stampCounts = () => ({ stamped: 0, unstamped: 0, malformed: 0 });
const sourceCounts = () => Object.fromEntries(SOURCES.map(source => [source, stampCounts()])) as
  Record<Doc<"crystalMemories">["source"], ReturnType<typeof stampCounts>>;
const sourceTotals = () => Object.fromEntries(SOURCES.map(source => [source, 0])) as
  Record<Doc<"crystalMemories">["source"], number>;
type Agent = { total: number; sharedAny: number; bySource: ReturnType<typeof sourceTotals> };
type Prefix = ReturnType<typeof stampCounts> & { total: number; stampMatchesPrefix: number };

function emptyCounts(nowMs: number) {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return {
    total: 0, archived: 0, kbChunks: 0, active: 0,
    stamp: stampCounts(), shared: { person: 0, tag: 0, metadata: 0, any: 0 },
    sharedByStamp: stampCounts(), bySource: sourceCounts(),
    byCategory: { person: stampCounts(), other: stampCounts() },
    byAgent: Object.create(null) as Record<string, Agent>,
    channelPrefix: Object.create(null) as Record<string, Prefix>,
    recentDaily: Array.from({ length: 14 }, (_, index) => ({
      day: new Date(today + (index - 13) * DAY_MS).toISOString().slice(0, 10), ...stampCounts(),
    })),
    recentBySource: sourceCounts(),
  };
}

function labeler(allowlist: string[]) {
  const allowed = new Set(allowlist.map(value => normalizeAgentStamp(value)?.toLowerCase()).filter(Boolean));
  const cache = new Map<string, string>();
  return async (value: string) => {
    const lower = value.toLowerCase();
    let label = cache.get(lower);
    if (label === undefined) {
      label = allowed.has(lower) ? lower : `h:${(await sha256Hex(lower)).slice(0, 8)}`;
      cache.set(lower, label);
    }
    return label;
  };
}

async function absorb(counts: ReturnType<typeof emptyCounts>, memory: Doc<"crystalMemories">,
  label: ReturnType<typeof labeler>) {
  counts.total++;
  if (memory.archived) counts.archived++;
  if (memory.knowledgeBaseId) counts.kbChunks++;
  if (memory.archived || memory.knowledgeBaseId) return;
  counts.active++;
  const { state, agent } = readAgentStamp(memory.metadata);
  const markers = sharedMarkers(memory);
  const any = markers.person || markers.tag || markers.metadata;
  counts.stamp[state]++;
  counts.bySource[memory.source][state]++;
  counts.byCategory[memory.category === "person" ? "person" : "other"][state]++;
  for (const key of ["person", "tag", "metadata"] as const) if (markers[key]) counts.shared[key]++;
  if (any) { counts.shared.any++; counts.sharedByStamp[state]++; }
  if (agent) {
    const key = await label(agent);
    const entry = counts.byAgent[key] ??= { total: 0, sharedAny: 0, bySource: sourceTotals() };
    entry.total++;
    if (any) entry.sharedAny++;
    entry.bySource[memory.source]++;
  }
  // A row without a channel (or with an empty one) is the reserved bare bucket "none"; a real prefix, even an empty
  // one before a leading colon, is hashed unless allowlisted.
  const prefix = memory.channel ? memory.channel.split(":", 1)[0] : undefined;
  const prefixLabel = prefix === undefined ? "none" : await label(prefix);
  const entry = counts.channelPrefix[prefixLabel] ??= { total: 0, ...stampCounts(), stampMatchesPrefix: 0 };
  entry.total++;
  entry[state]++;
  if (agent && prefix !== undefined && agent.toLowerCase() === prefix.toLowerCase()) entry.stampMatchesPrefix++;
  const created = new Date(memory.createdAt);
  if (!Number.isFinite(created.getTime())) return;
  const day = created.toISOString().slice(0, 10);
  const index = counts.recentDaily.findIndex(bucket => bucket.day === day);
  if (index >= 0) counts.recentDaily[index][state]++;
  if (index >= 7) counts.recentBySource[memory.source][state]++;
}

async function cursorScope(args: { userId: string; pageSize: number; allowlist?: string[]; nowMs?: number }) {
  return sha256Hex(JSON.stringify([args.userId, args.pageSize, args.allowlist ?? [], args.nowMs ?? null]));
}

async function unpackCursor(cursor: string | undefined, scope: string) {
  if (cursor === undefined) return null;
  const parts = cursor.split(":");
  if (parts.length !== 3 || parts[0] !== scope || !/^(?:[0-9a-f]{2})+$/.test(parts[1])
    || parts[2] !== await sha256Hex(`${scope}:${parts[1]}`)) throw new Error("invalid_cursor");
  return new TextDecoder().decode(Uint8Array.from(parts[1].match(/../g)!, pair => parseInt(pair, 16)));
}

async function packCursor(cursor: string, scope: string) {
  const encoded = Array.from(new TextEncoder().encode(cursor), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${scope}:${encoded}:${await sha256Hex(`${scope}:${encoded}`)}`;
}

export const operatorAgentStampReport = internalQuery({
  args: {
    userId: v.string(), pageSize: v.number(), cursor: v.optional(v.string()),
    allowlist: v.optional(v.array(v.string())), nowMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.userId.trim()) throw new Error("user_id_required");
    const pageSize = args.pageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new Error("invalid_page_size");
    if ((args.allowlist?.length ?? 0) > 50) throw new Error("invalid_allowlist");
    for (const entry of args.allowlist ?? []) {
      if (RESERVED_LABELS.has(normalizeAgentStamp(entry)?.toLowerCase() ?? "")) throw new Error("invalid_allowlist");
    }
    const nowMs = args.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs) || nowMs < MIN_NOW_MS || nowMs > MAX_NOW_MS) throw new Error("invalid_now_ms");
    const counts = emptyCounts(nowMs);
    const scope = await cursorScope(args);
    const cursor = await unpackCursor(args.cursor, scope);
    const page = await ctx.db.query("crystalMemories")
      .withIndex("by_user", q => q.eq("userId", args.userId))
      .paginate({ numItems: pageSize, cursor });
    const label = labeler(args.allowlist ?? []);
    for (const memory of page.page) await absorb(counts, memory, label);
    return { counts, readMemories: page.page.length, isDone: page.isDone, continueCursor: page.isDone ? "" : await packCursor(page.continueCursor, scope) };
  },
});
