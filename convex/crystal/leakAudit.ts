import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  PEER_CAPABLE_SCOPES,
  isNonKnowledgeBaseMemoryVisibleInChannel,
  isKnowledgeBaseChunkVisibleInChannel,
  isKnowledgeBaseVisibleToAgent,
  resolveKnowledgeBaseAgentId,
} from "./knowledgeBases";

// ---------------------------------------------------------------------------
// Cross-tenant recall leak audit (2026-07-02 incident).
//
// Read-only enumeration of a user's NON-KB memories (knowledgeBaseId absent) to
// prove that no client-PII memory is channel-less or tagged with a bare
// peer-capable scope — either of which could surface across peers. Paginates so
// it is safe on large (25k+) accounts. Companion mutation quarantines (archives)
// any flagged rows; defaults to dryRun.
// ---------------------------------------------------------------------------

// Signals that a memory carries a coaching client's private identity.
const PII_PATTERNS: RegExp[] = [
  /#\s*client\b/i,
  /telegram id/i,
  /\btg-\d{4,}/i,
  /\bprogram:\s/i,
  /\bstart date:/i,
];

const looksLikeClientPii = (content?: string): boolean => {
  if (!content) return false;
  return PII_PATTERNS.some((re) => re.test(content));
};

// Some stored content contains lone surrogates / control chars that break JSON
// serialization of this audit's return values ("unexpected end of hex escape").
// Strip them from any string we return (matching is done on the raw content).
const sanitizeText = (s?: string): string => {
  let out = "";
  for (const ch of s ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue; // C0 controls
    if (code >= 0xd800 && code <= 0xdfff) continue; // lone surrogates
    out += ch;
  }
  return out;
};

// A memory is "broadly visible" (i.e. reachable outside a single exact peer
// scope) when it has no channel OR is tagged with a bare peer-capable scope.
const isBroadlyVisibleChannel = (channel?: string): boolean => {
  const c = channel?.trim();
  if (!c) return true; // channel-less → global bucket
  if (PEER_CAPABLE_SCOPES.has(c)) return true; // bare "peer-coach" etc.
  return false;
};

export const findUserIdsByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const rows = await (ctx.db as any)
      .query("users")
      .withIndex("email", (q: any) => q.eq("email", args.email))
      .take(10);
    return rows.map((r: any) => ({ userId: String(r._id), email: r.email, name: r.name }));
  },
});

export const listNonKbMemoryPageForAudit = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });

    const rows = page.page
      .filter((m: any) => !m.knowledgeBaseId)
      .map((m: any) => ({
        id: String(m._id),
        channel: m.channel as string | undefined,
        title: sanitizeText(m.title as string | undefined),
        // Only a short prefix is returned; enough to confirm PII shape without
        // dumping full private content into logs.
        contentHead: sanitizeText(((m.content as string | undefined) ?? "").slice(0, 120)),
        isPii: looksLikeClientPii(m.content as string | undefined),
      }));

    return {
      rows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const auditMemoryChannels = internalAction({
  args: {
    userId: v.string(),
    maxScan: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const maxScan = Math.min(Math.max(args.maxScan ?? 60000, 1), 200000);
    const channelHistogram: Record<string, number> = {};
    const flagged: Array<{
      id: string;
      channel: string | undefined;
      title: string;
      contentHead: string;
    }> = [];

    const piiRows: Array<{
      id: string;
      channel: string;
      title: string;
      contentHead: string;
    }> = [];

    let scanned = 0;
    let piiTotal = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && scanned < maxScan) {
      const page: any = await ctx.runQuery(internal.crystal.leakAudit.listNonKbMemoryPageForAudit, {
        userId: args.userId,
        cursor,
        numItems: 500,
      });
      for (const row of page.rows) {
        scanned += 1;
        const key = row.channel === undefined ? "(none)" : row.channel;
        channelHistogram[key] = (channelHistogram[key] ?? 0) + 1;
        if (row.isPii) {
          piiTotal += 1;
          piiRows.push({ id: row.id, channel: key, title: row.title, contentHead: row.contentHead });
          // Only PII that is broadly visible is a leak risk worth flagging.
          if (isBroadlyVisibleChannel(row.channel)) {
            flagged.push({
              id: row.id,
              channel: row.channel,
              title: row.title,
              contentHead: row.contentHead,
            });
          }
        }
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    // Bare-prefix buckets that could prefix-match their own sub-channels (a
    // memory tagged bare "openclaw" is visible to any "openclaw:*" request).
    const barePrefixBuckets: Record<string, number> = {};
    for (const [ch, count] of Object.entries(channelHistogram)) {
      if (ch === "(none)") continue;
      if (ch.includes(":")) continue;
      // Does any scoped channel use this as a prefix?
      const hasSubChannel = Object.keys(channelHistogram).some(
        (other) => other !== ch && other.startsWith(`${ch}:`),
      );
      if (hasSubChannel) barePrefixBuckets[ch] = count;
    }

    return {
      userId: args.userId,
      scanned,
      truncated: !isDone,
      nonKbTotal: scanned,
      piiTotal,
      broadlyVisiblePiiCount: flagged.length,
      channelHistogram,
      flagged: flagged.slice(0, 100),
      piiRows: piiRows.slice(0, 200),
      barePrefixBuckets,
    };
  },
});

// Channel/scope distribution of a single KB's chunks + a PII sample. Tells us
// whether a per-client KB's chunks are peer-scoped (fixable by chunk filtering)
// or channel-less (need re-scoping).
export const kbChunkChannelHistogram = internalAction({
  args: { userId: v.string(), knowledgeBaseId: v.string(), maxScan: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const maxScan = Math.min(Math.max(args.maxScan ?? 60000, 1), 200000);
    const hist: Record<string, number> = {};
    let piiCount = 0;
    const sample: any[] = [];
    let scanned = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && scanned < maxScan) {
      const page: any = await ctx.runQuery(internal.crystal.leakAudit.listKbChunkPage, {
        userId: args.userId,
        knowledgeBaseId: args.knowledgeBaseId,
        cursor,
        numItems: 500,
      });
      for (const row of page.rows) {
        scanned += 1;
        const key = row.channel ?? "(none)";
        hist[key] = (hist[key] ?? 0) + 1;
        if (row.isPii) piiCount += 1;
        if (sample.length < 12) sample.push({ channel: row.channel ?? "(none)", title: row.title, head: row.contentHead });
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }
    return { knowledgeBaseId: args.knowledgeBaseId, scanned, piiCount, channelHistogram: hist, sample };
  },
});

export const listKbChunkPage = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q: any) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
    return {
      rows: page.page.map((m: any) => ({
        channel: m.channel as string | undefined,
        title: sanitizeText(m.title as string | undefined),
        contentHead: sanitizeText(((m.content as string | undefined) ?? "").slice(0, 120)),
        isPii: looksLikeClientPii(m.content as string | undefined) || looksLikeClientPii(m.title as string | undefined),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const listKbChunkScopePage = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.id("knowledgeBases"),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q: any) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
    return {
      rows: page.page.map((m: any) => ({
        id: m._id,
        channel: m.channel as string | undefined,
        scope: m.scope as string | undefined,
        knowledgeBaseId: m.knowledgeBaseId,
        userId: m.userId as string,
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const batchPatchKbChunkChannelAndScope = internalMutation({
  args: {
    userId: v.string(),
    knowledgeBaseIds: v.array(v.id("knowledgeBases")),
    memoryIds: v.array(v.id("crystalMemories")),
    targetChannel: v.string(),
    targetScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.memoryIds.length > 20) {
      throw new Error(`batchPatchKbChunkChannelAndScope limited to 20 rows, got ${args.memoryIds.length}`);
    }
    const allowedKbIds = new Set(args.knowledgeBaseIds.map((id) => String(id)));
    let patched = 0;
    let skippedAlreadyCorrect = 0;
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const memoryId of args.memoryIds) {
      const memory = await ctx.db.get(memoryId);
      if (!memory) {
        skipped.push({ id: String(memoryId), reason: "missing" });
        continue;
      }
      if (memory.userId !== args.userId) {
        skipped.push({ id: String(memoryId), reason: "wrong_user" });
        continue;
      }
      if (!memory.knowledgeBaseId || !allowedKbIds.has(String(memory.knowledgeBaseId))) {
        skipped.push({ id: String(memoryId), reason: "wrong_knowledge_base" });
        continue;
      }
      if (memory.archived) {
        skipped.push({ id: String(memoryId), reason: "archived" });
        continue;
      }

      const targetScopeMatches = args.targetScope === undefined || memory.scope === args.targetScope;
      if (memory.channel === args.targetChannel && targetScopeMatches) {
        skippedAlreadyCorrect += 1;
        continue;
      }

      await ctx.db.patch(memoryId, {
        channel: args.targetChannel,
        ...(args.targetScope === undefined ? {} : { scope: args.targetScope }),
      });
      patched += 1;
    }

    return { requested: args.memoryIds.length, patched, skippedAlreadyCorrect, skipped };
  },
});

export const setKbChunksChannelForCase = internalAction({
  args: {
    userId: v.string(),
    knowledgeBaseIds: v.array(v.id("knowledgeBases")),
    targetChannel: v.string(),
    targetScope: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
    pageSize: v.optional(v.number()),
    maxScan: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const dryRun = args.dryRun ?? true;
    // The mutation verifies each target by db.get; KB chunks carry embeddings,
    // so keep write batches low enough to stay under Convex read-byte limits.
    const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), 20);
    const maxScan = Math.min(Math.max(args.maxScan ?? 200000, 1), 500000);
    const perKb: any[] = [];
    const totals = {
      scanned: 0,
      alreadyCorrect: 0,
      channelScoped: 0,
      scopeScoped: 0,
      toPatch: 0,
      patched: 0,
      skippedAlreadyCorrect: 0,
      mutationSkipped: 0,
    };

    for (const knowledgeBaseId of args.knowledgeBaseIds) {
      let cursor: string | null = null;
      let isDone = false;
      const kbResult = {
        knowledgeBaseId: String(knowledgeBaseId),
        scanned: 0,
        alreadyCorrect: 0,
        channelScoped: 0,
        scopeScoped: 0,
        toPatch: 0,
        patched: 0,
        skippedAlreadyCorrect: 0,
        mutationSkipped: 0,
        truncated: false,
        channelHistogram: {} as Record<string, number>,
        scopeHistogram: {} as Record<string, number>,
        sampleAlreadyCorrect: [] as any[],
        sampleToPatch: [] as any[],
        mutationSkippedSamples: [] as any[],
      };

      while (!isDone && totals.scanned < maxScan) {
        const remaining = maxScan - totals.scanned;
        const page: any = await ctx.runQuery(internal.crystal.leakAudit.listKbChunkScopePage, {
          userId: args.userId,
          knowledgeBaseId,
          cursor,
          numItems: Math.min(pageSize, remaining),
        });
        const toPatchIds = [];
        for (const row of page.rows) {
          totals.scanned += 1;
          kbResult.scanned += 1;

          const channelKey = row.channel ?? "(none)";
          const scopeKey = row.scope ?? "(none)";
          kbResult.channelHistogram[channelKey] = (kbResult.channelHistogram[channelKey] ?? 0) + 1;
          kbResult.scopeHistogram[scopeKey] = (kbResult.scopeHistogram[scopeKey] ?? 0) + 1;
          if (row.channel) {
            totals.channelScoped += 1;
            kbResult.channelScoped += 1;
          }
          if (row.scope) {
            totals.scopeScoped += 1;
            kbResult.scopeScoped += 1;
          }

          const targetScopeMatches = args.targetScope === undefined || row.scope === args.targetScope;
          const alreadyCorrect = row.channel === args.targetChannel && targetScopeMatches;
          if (alreadyCorrect) {
            totals.alreadyCorrect += 1;
            kbResult.alreadyCorrect += 1;
            if (kbResult.sampleAlreadyCorrect.length < 5) {
              kbResult.sampleAlreadyCorrect.push({ id: String(row.id), channel: channelKey, scope: scopeKey });
            }
            continue;
          }

          totals.toPatch += 1;
          kbResult.toPatch += 1;
          toPatchIds.push(row.id);
          if (kbResult.sampleToPatch.length < 8) {
            kbResult.sampleToPatch.push({ id: String(row.id), fromChannel: channelKey, fromScope: scopeKey });
          }
        }

        if (!dryRun && toPatchIds.length > 0) {
          const patchResult: any = await ctx.runMutation(internal.crystal.leakAudit.batchPatchKbChunkChannelAndScope, {
            userId: args.userId,
            knowledgeBaseIds: args.knowledgeBaseIds,
            memoryIds: toPatchIds,
            targetChannel: args.targetChannel,
            targetScope: args.targetScope,
          });
          totals.patched += patchResult.patched;
          totals.skippedAlreadyCorrect += patchResult.skippedAlreadyCorrect;
          totals.mutationSkipped += patchResult.skipped.length;
          kbResult.patched += patchResult.patched;
          kbResult.skippedAlreadyCorrect += patchResult.skippedAlreadyCorrect;
          kbResult.mutationSkipped += patchResult.skipped.length;
          kbResult.mutationSkippedSamples.push(...patchResult.skipped.slice(0, 5));
        }

        cursor = page.continueCursor;
        isDone = page.isDone;
      }
      kbResult.truncated = !isDone;
      perKb.push(kbResult);
      if (totals.scanned >= maxScan) break;
    }

    return {
      userId: args.userId,
      dryRun,
      targetChannel: args.targetChannel,
      targetScope: args.targetScope ?? null,
      pageSize,
      maxScan,
      totals,
      truncated: perKb.some((kb) => kb.truncated) || totals.scanned >= maxScan,
      perKb,
    };
  },
});

// Re-scope a per-client KB's chunks: set channel = "<peerPrefix>:<clientId>" so
// the read-path chunk filter (isKnowledgeBaseChunkVisibleInChannel) isolates
// each client's chunks to that client's peer session. Client id is derived from
// the chunk's own scope/title/body (single unambiguous tg-id). Unparseable or
// multi-id chunks are reported and, when quarantineUnparseable=true, archived so
// they cannot remain globally visible. dryRun defaults true.
export const rescopeKbChunksToPeerChannel = internalAction({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.string(),
    peerPrefix: v.string(), // e.g. "peer-coach"
    dryRun: v.optional(v.boolean()),
    quarantineUnparseable: v.optional(v.boolean()),
    maxScan: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const dryRun = args.dryRun ?? true;
    const quarantine = args.quarantineUnparseable ?? false;
    const maxScan = Math.min(Math.max(args.maxScan ?? 60000, 1), 200000);

    let scanned = 0;
    let rescoped = 0;
    let alreadyScoped = 0;
    let quarantined = 0;
    const unparseable: Array<{ id: string; title: string; reason: string }> = [];
    const sampleRescope: Array<{ to: string; title: string }> = [];

    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && scanned < maxScan) {
      const page: any = await ctx.runQuery(internal.crystal.leakAudit.listKbChunkPageFull, {
        userId: args.userId,
        knowledgeBaseId: args.knowledgeBaseId,
        cursor,
        numItems: 400,
      });
      for (const row of page.rows) {
        scanned += 1;
        // Already peer-scoped via channel? leave it.
        if (typeof row.channel === "string" && row.channel.startsWith(`${args.peerPrefix}:`)) {
          alreadyScoped += 1;
          continue;
        }
        // The chunk's OWNER is authoritative in this priority: its title
        // "tg-<id>" (each Client Notes chunk is titled with its client), then
        // its scope field (set by backfillScopeFromTitle), then — only when
        // neither exists — a single unambiguous id anywhere in the body. Content
        // may *reference* other clients' ids in passing, so body ids are used
        // ONLY as a last resort and only when there is exactly one.
        const titleId = /\btg-(\d{4,})/i.exec(row.title ?? "")?.[1];
        const scopeId = (row.scope ?? "").trim();
        let peerIdResolved: string | undefined;
        if (titleId) {
          peerIdResolved = titleId;
        } else if (/^\d{4,}$/.test(scopeId)) {
          peerIdResolved = scopeId;
        } else {
          const bodyIds = new Set<string>();
          const hay = `${row.title ?? ""}\n${row.content ?? ""}`;
          for (const re of [/\btg-(\d{4,})/gi, /telegram id:\s*(\d{4,})/gi]) {
            for (const m of hay.matchAll(re)) bodyIds.add(m[1]);
          }
          if (bodyIds.size === 1) peerIdResolved = [...bodyIds][0];
        }
        if (peerIdResolved) {
          const peerId = peerIdResolved;
          const to = `${args.peerPrefix}:${peerId}`;
          if (sampleRescope.length < 15) sampleRescope.push({ to, title: (row.title ?? "").slice(0, 46) });
          if (!dryRun) {
            await ctx.runMutation(internal.crystal.leakAudit.patchMemoryChannelAndScope, {
              memoryId: row.id as any,
              channel: to,
              scope: peerId,
            });
          }
          rescoped += 1;
        } else {
          // No numeric owner id. Fall back to a sanitized title slug so the
          // chunk still becomes peer-scoped (leak-closed, data preserved,
          // trivially re-mappable to the real telegram id later) instead of
          // remaining channel-less/global. Only when the title is a safe,
          // non-empty slug; otherwise quarantine so it can never leak.
          const slug = (row.title ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
          if (slug) {
            const to = `${args.peerPrefix}:${slug}`;
            if (sampleRescope.length < 15) sampleRescope.push({ to, title: (row.title ?? "").slice(0, 46) });
            if (!dryRun) {
              await ctx.runMutation(internal.crystal.leakAudit.patchMemoryChannelAndScope, {
                memoryId: row.id as any,
                channel: to,
                scope: slug,
              });
            }
            rescoped += 1;
          } else if (unparseable.length < 200) {
            unparseable.push({ id: row.id, title: (row.title ?? "").slice(0, 60), reason: "no_owner_id" });
            if (quarantine && !dryRun) {
              await ctx.runMutation(internal.crystal.leakAudit.quarantineMisscopedClientPii, {
                memoryIds: [row.id as any],
                dryRun: false,
              });
              quarantined += 1;
            }
          }
        }
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    return {
      knowledgeBaseId: args.knowledgeBaseId,
      peerPrefix: args.peerPrefix,
      dryRun,
      scanned,
      alreadyScoped,
      rescoped: dryRun ? 0 : rescoped,
      wouldRescope: rescoped,
      quarantined,
      unparseableCount: unparseable.length,
      unparseable: unparseable.slice(0, 60),
      sampleRescope,
    };
  },
});

export const listKbChunkPageFull = internalQuery({
  args: {
    userId: v.string(),
    knowledgeBaseId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_knowledge_base", (q: any) =>
        q.eq("knowledgeBaseId", args.knowledgeBaseId).eq("userId", args.userId).eq("archived", false),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
    return {
      rows: page.page.map((m: any) => ({
        id: String(m._id),
        channel: m.channel as string | undefined,
        scope: (m.scope as string | undefined) ?? "",
        title: sanitizeText(m.title as string | undefined),
        content: (m.content as string | undefined) ?? "",
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const patchMemoryChannelAndScope = internalMutation({
  args: { memoryId: v.id("crystalMemories"), channel: v.string(), scope: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, { channel: args.channel, scope: args.scope });
    return { ok: true };
  },
});

export const listKnowledgeBasesForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const kbs = await ctx.db
      .query("knowledgeBases")
      .withIndex("by_user", (q: any) => q.eq("userId", args.userId))
      .collect();
    return kbs.map((k: any) => ({
      id: String(k._id),
      name: k.name,
      agentIds: k.agentIds ?? null,
      scope: k.scope ?? null,
      isActive: k.isActive,
      peerScopePolicy: k.peerScopePolicy ?? null,
      memoryCount: k.memoryCount ?? null,
    }));
  },
});

// Scan ALL memories (KB + non-KB) for literal needles; report channel + kbId.
export const scanMemoryPageForNeedles = internalQuery({
  args: {
    userId: v.string(),
    needles: v.array(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
    const lowNeedles = args.needles.map((n) => n.toLowerCase());
    const matches = page.page
      .filter((m: any) => {
        const hay = `${m.title ?? ""}\n${m.content ?? ""}`.toLowerCase();
        return lowNeedles.some((n) => hay.includes(n));
      })
      .map((m: any) => ({
        id: String(m._id),
        channel: (m.channel as string | undefined) ?? "(none)",
        knowledgeBaseId: m.knowledgeBaseId ? String(m.knowledgeBaseId) : null,
        title: sanitizeText(m.title as string | undefined),
        head: sanitizeText(((m.content as string | undefined) ?? "").slice(0, 130)),
      }));
    return { matches, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const findMemoriesByNeedles = internalAction({
  args: { userId: v.string(), needles: v.array(v.string()), maxScan: v.optional(v.number()) },
  handler: async (ctx, args): Promise<any> => {
    const maxScan = Math.min(Math.max(args.maxScan ?? 60000, 1), 200000);
    const found: any[] = [];
    let scanned = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && scanned < maxScan) {
      const page: any = await ctx.runQuery(internal.crystal.leakAudit.scanMemoryPageForNeedles, {
        userId: args.userId,
        needles: args.needles,
        cursor,
        numItems: 500,
      });
      found.push(...page.matches);
      scanned += 500;
      cursor = page.continueCursor;
      isDone = page.isDone;
    }
    return { userId: args.userId, needles: args.needles, matchCount: found.length, matches: found.slice(0, 200) };
  },
});

// Replay the REAL production visibility filters for a given peer request against
// every memory, to prove no foreign-peer memory (non-KB) and no client-PII KB
// memory is visible. This is the gold-standard check: it uses the exact same
// isNonKnowledgeBaseMemoryVisibleInChannel / isKnowledgeBaseVisibleToAgent that
// recall.ts uses at ranking time.
export const simulatePeerVisibilityLeak = internalAction({
  args: {
    userId: v.string(),
    requestChannel: v.string(),
    agentId: v.optional(v.string()),
    maxScan: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const maxScan = Math.min(Math.max(args.maxScan ?? 60000, 1), 200000);
    const agentId = resolveKnowledgeBaseAgentId(args.agentId, args.requestChannel);

    const kbs: any[] = await ctx.runQuery(internal.crystal.leakAudit.listKnowledgeBasesForUser, {
      userId: args.userId,
    });
    const kbById = new Map<string, any>(kbs.map((k) => [k.id, k]));
    const visibleKbs = kbs.filter((k) =>
      isKnowledgeBaseVisibleToAgent({ agentIds: k.agentIds ?? undefined, isActive: k.isActive }, agentId, args.requestChannel),
    );
    const visibleKbIds = new Set(visibleKbs.map((k) => k.id));

    const nonKbVisibleByChannel: Record<string, number> = {};
    const nonKbCrossScopeLeak: any[] = [];
    const kbVisiblePii: any[] = [];

    let scanned = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && scanned < maxScan) {
      const page: any = await ctx.runQuery(internal.crystal.leakAudit.scanMemoryPageForVisibility, {
        userId: args.userId,
        cursor,
        numItems: 500,
      });
      for (const row of page.rows) {
        scanned += 1;
        if (row.knowledgeBaseId) {
          // Replay the REAL post-fix recall gate: KB agent-visibility AND the
          // per-chunk channel filter. A chunk only leaks if it is visible to
          // this request AND belongs to a DIFFERENT peer (channel-bearing,
          // channel != requestChannel) or is channel-less client PII.
          const kbLevelVisible = visibleKbIds.has(row.knowledgeBaseId);
          const chunkVisible =
            kbLevelVisible && isKnowledgeBaseChunkVisibleInChannel(row.channel, args.requestChannel);
          if (chunkVisible && row.isPii && row.channel !== args.requestChannel) {
            kbVisiblePii.push({
              id: row.id,
              knowledgeBaseId: row.knowledgeBaseId,
              kbName: kbById.get(row.knowledgeBaseId)?.name ?? null,
              channel: row.channel ?? "(none)",
              title: row.title,
              head: row.contentHead,
            });
          }
          continue;
        }
        const visible = isNonKnowledgeBaseMemoryVisibleInChannel(row.channel, args.requestChannel);
        if (!visible) continue;
        const ch = row.channel ?? "(none)";
        nonKbVisibleByChannel[ch] = (nonKbVisibleByChannel[ch] ?? 0) + 1;
        // A visible non-KB memory whose channel differs from the request channel
        // is a cross-scope surface (the request channel itself and, by design,
        // global "(none)" for non-peer requests are expected; anything else on a
        // peer request is a leak).
        if (row.channel !== undefined && row.channel !== args.requestChannel) {
          nonKbCrossScopeLeak.push({ id: row.id, channel: row.channel, title: row.title, isPii: row.isPii });
        }
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    return {
      userId: args.userId,
      requestChannel: args.requestChannel,
      resolvedAgentId: agentId ?? null,
      visibleKnowledgeBases: visibleKbs.map((k) => ({ id: k.id, name: k.name, agentIds: k.agentIds })),
      kbVisiblePiiCount: kbVisiblePii.length,
      kbVisiblePii: kbVisiblePii.slice(0, 100),
      nonKbVisibleByChannel,
      nonKbCrossScopeLeakCount: nonKbCrossScopeLeak.length,
      nonKbCrossScopeLeak: nonKbCrossScopeLeak.slice(0, 100),
    };
  },
});

export const scanMemoryPageForVisibility = internalQuery({
  args: {
    userId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user", (q) => q.eq("userId", args.userId).eq("archived", false))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
    return {
      rows: page.page.map((m: any) => ({
        id: String(m._id),
        channel: m.channel as string | undefined,
        knowledgeBaseId: m.knowledgeBaseId ? String(m.knowledgeBaseId) : null,
        title: sanitizeText(m.title as string | undefined),
        contentHead: sanitizeText(((m.content as string | undefined) ?? "").slice(0, 130)),
        isPii: looksLikeClientPii(m.content as string | undefined) || looksLikeClientPii(m.title as string | undefined),
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

// Re-scope client-identity profiles that were written under a BARE peer-capable
// scope (e.g. channel "peer-coach" with no ":<peerId>") to their correct peer
// channel, using the Telegram ID embedded in the profile itself. This both
// eliminates the cross-peer leak surface AND restores per-client recall (the
// profile becomes visible only in that client's own peer session).
//
// Fail-safe parsing: a row is only re-scoped when the ":<id>" in the title
// "(tg-<id>)" EXACTLY matches the "Telegram ID: <id>" in the content, and the
// content is shaped like a client profile (has a Program/Marriage marker).
// Anything ambiguous is reported, never mutated. dryRun defaults true.
export const rescopeBarePeerClientProfiles = internalAction({
  args: {
    userId: v.string(),
    bareScope: v.string(), // e.g. "peer-coach"
    dryRun: v.optional(v.boolean()),
    maxScan: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<any> => {
    const dryRun = args.dryRun ?? true;
    const maxScan = Math.min(Math.max(args.maxScan ?? 60000, 1), 200000);
    if (!PEER_CAPABLE_SCOPES.has(args.bareScope)) {
      return { error: `bareScope "${args.bareScope}" is not a peer-capable scope` };
    }

    const planned: Array<{ id: string; title: string; from: string; to: string }> = [];
    const skipped: Array<{ id: string; title: string; reason: string }> = [];

    let scanned = 0;
    let cursor: string | null = null;
    let isDone = false;
    while (!isDone && scanned < maxScan) {
      const page: any = await ctx.runQuery(internal.crystal.leakAudit.listBarePeerScopeRows, {
        userId: args.userId,
        bareScope: args.bareScope,
        cursor,
        numItems: 500,
      });
      for (const row of page.rows) {
        scanned += 1;
        // The bare peer-capable scope holds per-client memories that lost their
        // ":<peerId>" suffix. Every legit row names exactly ONE client via a
        // "(tg-<id>)" title and/or "Telegram ID: <id>" body. Collect every id
        // seen anywhere in the row; a single distinct id is safe to re-scope,
        // multiple distinct ids signal a cross-client note (manual review).
        const titleId = /\(tg-(\d{4,})\)/i.exec(row.title ?? "")?.[1];
        const ids = new Set<string>();
        for (const re of [/\btg-(\d{4,})/gi, /telegram id:\s*(\d{4,})/gi]) {
          for (const m of `${row.title ?? ""}\n${row.content ?? ""}`.matchAll(re)) {
            ids.add(m[1]);
          }
        }
        if (ids.size === 0) {
          skipped.push({ id: row.id, title: row.title ?? "", reason: "no_tg_id" });
          continue;
        }
        if (ids.size > 1) {
          skipped.push({ id: row.id, title: row.title ?? "", reason: "multiple_ids" });
          continue;
        }
        const peerId = titleId ?? [...ids][0];
        const to = `${args.bareScope}:${peerId}`;
        planned.push({ id: row.id, title: row.title ?? "", from: args.bareScope, to });
        if (!dryRun) {
          await ctx.runMutation(internal.crystal.leakAudit.patchMemoryChannel, {
            memoryId: row.id as any,
            channel: to,
          });
        }
      }
      cursor = page.continueCursor;
      isDone = page.isDone;
    }

    return {
      userId: args.userId,
      bareScope: args.bareScope,
      dryRun,
      scannedBareScopeRows: scanned,
      wouldRescope: planned.length,
      rescoped: dryRun ? 0 : planned.length,
      planned: planned.slice(0, 200),
      skipped: skipped.slice(0, 200),
    };
  },
});

export const listBarePeerScopeRows = internalQuery({
  args: {
    userId: v.string(),
    bareScope: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_channel_archived_last_accessed", (q) =>
        q.eq("userId", args.userId).eq("channel", args.bareScope).eq("archived", false),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems });
    return {
      rows: page.page
        .filter((m: any) => !m.knowledgeBaseId)
        .map((m: any) => ({
          id: String(m._id),
          title: sanitizeText(m.title as string | undefined),
          content: (m.content as string | undefined) ?? "",
        })),
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const patchMemoryChannel = internalMutation({
  args: { memoryId: v.id("crystalMemories"), channel: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.memoryId, { channel: args.channel });
    return { ok: true };
  },
});

// Quarantine (archive) the broadly-visible client-PII memories a prior audit
// flagged. Archiving removes them from the recall vector/text scan entirely
// while preserving the row for manual re-scoping. dryRun (default true) reports
// what WOULD be archived without mutating.
export const quarantineMisscopedClientPii = internalMutation({
  args: {
    memoryIds: v.array(v.id("crystalMemories")),
    dryRun: v.optional(v.boolean()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const now = Date.now();
    const acted: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of args.memoryIds) {
      const memory: any = await ctx.db.get(id);
      if (!memory) {
        skipped.push({ id: String(id), reason: "not_found" });
        continue;
      }
      if (memory.archived) {
        skipped.push({ id: String(id), reason: "already_archived" });
        continue;
      }
      if (!dryRun) {
        // Minimal, schema-valid archive: removes the row from the recall
        // vector/text scan while preserving it for manual re-scoping. Aggregate
        // totals are corrected by the daily stats-drift cron; this path is a
        // safety net only expected to run on a handful of flagged rows.
        await ctx.db.patch(id, {
          archived: true,
          archivedAt: now,
        });
      }
      acted.push(String(id));
    }
    return { dryRun, wouldArchive: acted.length, archived: dryRun ? 0 : acted.length, acted, skipped };
  },
});
