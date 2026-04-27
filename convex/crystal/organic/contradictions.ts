import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc } from "../../_generated/dataModel";
import {
  averageEmbeddings,
  cosineSimilarity,
  todayDateString,
  callOrganicModel,
  isRecord,
  parseGeminiJson,
  embedText,
  vectorSearchUserFilter,
} from "./utils";
import { estimateModelSpend, type EstimatedSpend } from "./spend";
import { getModelPreset, type ModelPreset } from "./models";
import { type DiscoveryFinding } from "./discoveryFiber";
import { isNonKnowledgeBaseMemoryVisibleInChannel } from "../knowledgeBases";

const CONTRADICTION_SIM_LOW = 0.70;
const CONTRADICTION_SIM_HIGH = 0.90;
const CONTRADICTION_TRACE_SCORE = 0.6;
const CONFLICT_GROUP_SCORE = 0.8;
const CONTRADICTION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_CONTRADICTIONS_PER_DAY = 3;
const RESOLVED_CONFLICT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

type MemoryDoc = Doc<"crystalMemories">;
type EnsembleMembershipDoc = Doc<"organicEnsembleMemberships">;

type ContradictionResult = {
  score: number;
  explanation: string;
  conflictType: "factual" | "temporal" | "opinion" | "scope" | "none";
  suggestedResolution: string;
  // True when the LLM call itself failed (network error, empty response, parse error).
  // Distinguishes "no contradiction" (score 0, llmError false) from "couldn't tell"
  // (score 0, llmError true) so the main loop doesn't silently burn budget on outages.
  llmError?: boolean;
};

type ImmediateContradictionNotification = {
  detected: true;
  score: number;
  explanation: string;
  conflictType: "factual" | "temporal" | "opinion" | "scope" | "none";
  suggestedResolution: string;
  conflictingMemory: {
    id: string;
    title: string;
    contentPreview: string;
    similarity: number;
  };
  pairKey: string;
  actionRequired: true;
};

type ImmediateContradictionCheck =
  | { status: "ok"; contradiction: ImmediateContradictionNotification | null }
  | { status: "skipped" | "failed" | "budget_exhausted"; contradiction: null; reason?: string };

type ConflictMetadata = {
  version: 1;
  kind: "contradiction";
  pairKey: string;
  status: "unresolved" | "dismissed" | "resolved" | "scoped";
  conflictType: ContradictionResult["conflictType"];
  score: number;
  explanation: string;
  suggestedResolution: string;
  detectedAt: number;
  detectedBy: "pulse" | "write";
  resolvedAt?: number;
  resolvedByAction?: string;
  resolutionNote?: string;
  resolutionMemoryId?: string;
  supersededMemoryId?: string;
};

type PairCheckCandidate = {
  title: string;
  content: string;
  embedding?: number[];
};

// ── Utilities ────────────────────────────────────────────────────────────────

// ── Gemini API ───────────────────────────────────────────────────────────────

async function checkContradictionPair(
  memA: { title: string; content: string; createdAt: number },
  memB: { title: string; content: string; createdAt: number },
  preset: ModelPreset,
  apiKeyOverride?: string,
): Promise<ContradictionResult & { spend: EstimatedSpend }> {
  const prompt = `You are a contradiction detector. Given two memories from the same user's memory system, determine if they contradict each other.

Memory A:
Title: ${memA.title}
Content: ${memA.content}
Created: ${new Date(memA.createdAt).toISOString()}

Memory B:
Title: ${memB.title}
Content: ${memB.content}
Created: ${new Date(memB.createdAt).toISOString()}

Score the contradiction on this scale:
- 0.0: No contradiction. Compatible or unrelated.
- 0.3: Minor tension. Different emphasis but not conflicting.
- 0.6: Moderate contradiction. Claims that can't both be fully true.
- 0.9: Direct contradiction. Mutually exclusive claims.
- 1.0: Factual conflict. Explicit opposite statements about the same thing.

Respond in JSON:
{
  "score": <number>,
  "explanation": "<one sentence explaining the conflict or lack thereof>",
  "conflictType": "factual" | "temporal" | "opinion" | "scope" | "none",
  "suggestedResolution": "<optional: how to resolve if score > 0.5>"
}`;

  const text = await callOrganicModel(prompt, preset, apiKeyOverride);
  const spend = estimateModelSpend(prompt, text, preset);
  if (!text) {
    return { score: 0, explanation: "LLM unavailable", conflictType: "none", suggestedResolution: "", spend, llmError: true };
  }

  const parsed = parseGeminiJson<unknown>(text);
  const payload = unwrapGeminiObject(parsed);
  if (!payload) {
    console.error(`[organic-contradictions] Failed to parse model response (${text.length} chars)`);
    return { score: 0, explanation: "Parse error", conflictType: "none", suggestedResolution: "", spend, llmError: true };
  }

  const validTypes = new Set<ContradictionResult["conflictType"]>([
    "factual",
    "temporal",
    "opinion",
    "scope",
    "none",
  ]);
  const conflictType: ContradictionResult["conflictType"] =
    typeof payload.conflictType === "string" &&
    validTypes.has(payload.conflictType as ContradictionResult["conflictType"])
      ? (payload.conflictType as ContradictionResult["conflictType"])
      : "none";

  return {
    score: Math.max(0, Math.min(1, typeof payload.score === "number" ? payload.score : 0)),
    explanation: typeof payload.explanation === "string" ? payload.explanation : "",
    conflictType,
    suggestedResolution:
      typeof payload.suggestedResolution === "string" ? payload.suggestedResolution : "",
    spend,
  };
}

function unwrapGeminiObject(parsed: unknown): Record<string, unknown> | null {
  if (isRecord(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed) && parsed.length > 0 && isRecord(parsed[0])) {
    return parsed[0];
  }

  return null;
}

function canonicalPairKey(memAId: unknown, memBId: unknown) {
  return [String(memAId), String(memBId)].sort().join("::");
}

function parseConflictMetadata(metadata?: string): Partial<ConflictMetadata> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return isRecord(parsed) ? parsed as Partial<ConflictMetadata> : null;
  } catch {
    return null;
  }
}

function buildConflictMetadata(args: {
  memAId: unknown;
  memBId: unknown;
  result: ContradictionResult;
  detectedBy: "pulse" | "write";
  now?: number;
}): ConflictMetadata {
  return {
    version: 1,
    kind: "contradiction",
    pairKey: canonicalPairKey(args.memAId, args.memBId),
    status: "unresolved",
    conflictType: args.result.conflictType,
    score: args.result.score,
    explanation: args.result.explanation,
    suggestedResolution: args.result.suggestedResolution,
    detectedAt: args.now ?? Date.now(),
    detectedBy: args.detectedBy,
  };
}

function likelyFactualDifference(a: PairCheckCandidate, b: PairCheckCandidate): boolean {
  const textA = `${a.title}\n${a.content}`.toLowerCase();
  const textB = `${b.title}\n${b.content}`.toLowerCase();
  const numbersA = new Set(textA.match(/\$\s*\d+(?:[.,]\d+)?\s*[kmb]?\b|\b\d+(?:[.,]\d+)?%?\b/g) ?? []);
  const numbersB = new Set(textB.match(/\$\s*\d+(?:[.,]\d+)?\s*[kmb]?\b|\b\d+(?:[.,]\d+)?%?\b/g) ?? []);
  const datesA = new Set(textA.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) ?? []);
  const datesB = new Set(textB.match(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) ?? []);
  const negA = /\b(no|not|never|isn't|aren't|wasn't|won't|can't|cannot|false|disabled|blocked)\b/.test(textA);
  const negB = /\b(no|not|never|isn't|aren't|wasn't|won't|can't|cannot|false|disabled|blocked)\b/.test(textB);
  const differs = (left: Set<string>, right: Set<string>) =>
    left.size > 0 && right.size > 0 && (left.size !== right.size || [...left].some((value) => !right.has(value)));

  return differs(numbersA, numbersB) || differs(datesA, datesB) || negA !== negB;
}

function shouldCheckCandidatePair(a: PairCheckCandidate, b: PairCheckCandidate) {
  const similarity =
    Array.isArray(a.embedding) && a.embedding.length > 0 && Array.isArray(b.embedding) && b.embedding.length > 0
      ? cosineSimilarity(a.embedding, b.embedding)
      : 0;
  const factualBypass = likelyFactualDifference(a, b);
  return {
    similarity,
    factualBypass,
    shouldCheck:
      (similarity >= CONTRADICTION_SIM_LOW && similarity <= CONTRADICTION_SIM_HIGH) ||
      (factualBypass && similarity >= 0.55),
  };
}

function buildContradictionContext(
  result: ContradictionResult,
  memA: Pick<MemoryDoc, "title" | "content">,
  memB: Pick<MemoryDoc, "title" | "content">,
) {
  return [
    `**Contradiction detected** (${result.conflictType}, score: ${result.score.toFixed(2)})`,
    ``,
    `Memory A: "${memA.title}" — ${memA.content.slice(0, 150)}`,
    `Memory B: "${memB.title}" — ${memB.content.slice(0, 150)}`,
    ``,
    `Explanation: ${result.explanation}`,
    result.suggestedResolution ? `Suggested resolution: ${result.suggestedResolution}` : "",
  ].filter(Boolean).join("\n");
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const getAlertBudget = internalQuery({
  args: { userId: v.string(), date: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicAlertBudget")
      .withIndex("by_user_date", (q) => q.eq("userId", args.userId).eq("date", args.date))
      .first();
  },
});

export const getEnsemblesModifiedSince = internalQuery({
  args: { userId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("organicEnsembles")
      .withIndex("by_updated", (q) => q.eq("userId", args.userId).gte("updatedAt", args.since))
      .collect();
  },
});

export const getExistingConflictGroup = internalQuery({
  args: { userId: v.string(), memAId: v.id("crystalMemories"), memBId: v.id("crystalMemories") },
  handler: async (ctx, args) => {
    const pairKey = canonicalPairKey(args.memAId, args.memBId);
    const conflictGroups = await ctx.db
      .query("organicEnsembles")
      .withIndex("by_user_type", (q) =>
        q.eq("userId", args.userId).eq("ensembleType", "conflict_group").eq("archived", false)
      )
      .take(200);

    return conflictGroups.find((g) => {
      const metadata = parseConflictMetadata(g.metadata);
      if (metadata?.pairKey === pairKey) return true;
      const members = new Set(g.memberMemoryIds.map(String));
      return members.has(String(args.memAId)) && members.has(String(args.memBId));
    }) ?? null;
  },
});

export const getMemoriesByIdsForUser = internalQuery({
  args: {
    userId: v.string(),
    memoryIds: v.array(v.id("crystalMemories")),
    channel: v.optional(v.string()),
    excludeMemoryIds: v.optional(v.array(v.id("crystalMemories"))),
  },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.memoryIds.map((id) => ctx.db.get(id)));
    const excluded = new Set((args.excludeMemoryIds ?? []).map(String));
    return docs.filter((doc): doc is MemoryDoc =>
      doc !== null &&
      doc.userId === args.userId &&
      !doc.archived &&
      !doc.knowledgeBaseId &&
      !excluded.has(String(doc._id)) &&
      isNonKnowledgeBaseMemoryVisibleInChannel(doc.channel, args.channel)
    );
  },
});

export const getActiveConflictForPair = internalQuery({
  args: { userId: v.string(), pairKey: v.string() },
  handler: async (ctx, args) => {
    const groups = await ctx.db
      .query("organicEnsembles")
      .withIndex("by_user_type", (q) =>
        q.eq("userId", args.userId).eq("ensembleType", "conflict_group").eq("archived", false)
      )
      .take(200);
    return groups.find((group) => {
      const metadata = parseConflictMetadata(group.metadata);
      if (metadata?.pairKey !== args.pairKey) return false;
      const status = metadata.status ?? "unresolved";
      if (status === "unresolved") return true;
      const resolvedAt = typeof metadata.resolvedAt === "number" ? metadata.resolvedAt : group.updatedAt;
      return Date.now() - resolvedAt < RESOLVED_CONFLICT_COOLDOWN_MS;
    }) ?? null;
  },
});

// ── Mutations ────────────────────────────────────────────────────────────────

export const incrementAlertBudget = internalMutation({
  args: {
    userId: v.string(),
    date: v.string(),
    field: v.union(v.literal("contradictionsFired"), v.literal("resonancesFired")),
  },
  handler: async (ctx, args) => {
    // Collect all rows (handles duplicate-row race condition by merging)
    const rows = await ctx.db
      .query("organicAlertBudget")
      .withIndex("by_user_date", (q) => q.eq("userId", args.userId).eq("date", args.date))
      .collect();

    if (rows.length === 0) {
      await ctx.db.insert("organicAlertBudget", {
        userId: args.userId,
        date: args.date,
        contradictionsFired: args.field === "contradictionsFired" ? 1 : 0,
        resonancesFired: args.field === "resonancesFired" ? 1 : 0,
        updatedAt: Date.now(),
      });
    } else {
      // Merge all rows into the first (deletes duplicates created by concurrent inserts)
      const primary = rows[0];
      const totalContradictions = rows.reduce((s, r) => s + (r.contradictionsFired ?? 0), 0)
        + (args.field === "contradictionsFired" ? 1 : 0);
      const totalResonances = rows.reduce((s, r) => s + (r.resonancesFired ?? 0), 0)
        + (args.field === "resonancesFired" ? 1 : 0);

      await ctx.db.patch(primary._id, {
        contradictionsFired: totalContradictions,
        resonancesFired: totalResonances,
        updatedAt: Date.now(),
      });
      for (const row of rows.slice(1)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});

export const writeContradictionTrace = internalMutation({
  args: {
    userId: v.string(),
    tickId: v.string(),
    predictedQuery: v.string(),
    predictedContext: v.string(),
    confidence: v.float64(),
    sourceMemoryIds: v.array(v.id("crystalMemories")),
    sourcePattern: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("organicProspectiveTraces", {
      userId: args.userId,
      createdAt: now,
      tickId: args.tickId,
      predictedQuery: args.predictedQuery,
      predictedContext: args.predictedContext,
      traceType: "contradiction",
      confidence: args.confidence,
      expiresAt: now + CONTRADICTION_TTL_MS,
      validated: null,
      sourceMemoryIds: args.sourceMemoryIds,
      sourcePattern: args.sourcePattern,
      accessCount: 0,
      usefulness: 0.0,
    });
  },
});

export const createConflictGroupEnsemble = internalMutation({
  args: {
    userId: v.string(),
    memAId: v.id("crystalMemories"),
    memBId: v.id("crystalMemories"),
    label: v.string(),
    summary: v.string(),
    centroid: v.array(v.float64()),
    tickId: v.string(),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const [memA, memB] = await Promise.all([
      ctx.db.get(args.memAId),
      ctx.db.get(args.memBId),
    ]);
    if (!memA || !memB || memA.userId !== args.userId || memB.userId !== args.userId) {
      throw new Error("Conflict group memories must belong to the target user");
    }
    const ensembleId = await ctx.db.insert("organicEnsembles", {
      userId: args.userId,
      ensembleType: "conflict_group",
      label: args.label,
      summary: args.summary,
      memberMemoryIds: [args.memAId, args.memBId],
      centroidEmbedding: args.centroid,
      strength: 0.5,
      confidence: 0.5,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
      lastTickId: args.tickId,
      archived: false,
    });

    for (const memoryId of [args.memAId, args.memBId]) {
      await ctx.db.insert("organicEnsembleMemberships", {
        userId: args.userId,
        memoryId,
        ensembleId,
        addedAt: now,
        joinedAt: now,
      });
    }

    return ensembleId;
  },
});

export const updateConflictGroupMetadata = internalMutation({
  args: {
    ensembleId: v.id("organicEnsembles"),
    metadata: v.string(),
    tickId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.ensembleId, {
      metadata: args.metadata,
      updatedAt: Date.now(),
      lastTickId: args.tickId,
    });
  },
});

// ── Main Action ──────────────────────────────────────────────────────────────

export const scanContradictions = internalAction({
  args: {
    userId: v.string(),
    lastTickTime: v.number(),
    tickId: v.string(),
    budget: v.number(),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, lastTickTime, tickId, budget } = args;
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;
    let checksRemaining = budget;
    let checksPerformed = 0;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;
    let llmErrors = 0;
    // Abort the whole scan once this many back-to-back LLM errors occur. Before this
    // guard, OpenRouter outages silently burned the entire `budget` worth of checks
    // (each returning "score: 0, LLM unavailable") and reported zero contradictions
    // — a false-negative pattern that looked indistinguishable from a healthy scan.
    const MAX_LLM_ERRORS_BEFORE_ABORT = 3;
    const findings: DiscoveryFinding[] = [];

    const emptyResult = () => ({
      checksPerformed,
      contradictionsFound: 0,
      findings,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    });

    // Check daily budget
    const today = todayDateString();
    const alertBudget = await ctx.runQuery(
      internal.crystal.organic.contradictions.getAlertBudget,
      { userId, date: today }
    );
    if ((alertBudget?.contradictionsFired ?? 0) >= MAX_CONTRADICTIONS_PER_DAY) {
      console.log(`[organic-contradictions] ${userId}: daily budget exhausted`);
      return emptyResult();
    }
    let dailyRemaining = MAX_CONTRADICTIONS_PER_DAY - (alertBudget?.contradictionsFired ?? 0);

    // Get ensembles modified since last tick
    const modifiedEnsembles = await ctx.runQuery(
      internal.crystal.organic.contradictions.getEnsemblesModifiedSince,
      { userId, since: lastTickTime }
    );

    if (modifiedEnsembles.length === 0) {
      console.log(`[organic-contradictions] ${userId}: no modified ensembles`);
      return emptyResult();
    }

    let totalContradictions = 0;

    for (const ensemble of modifiedEnsembles) {
      if (checksRemaining <= 0 || dailyRemaining <= 0) break;

      // Fetch all member memories and their memberships
      const allMembers = (await ctx.runQuery(
        internal.crystal.organic.ensembles.getMemoriesByIds,
        { userId, memoryIds: ensemble.memberMemoryIds }
      )).filter((m: MemoryDoc | null): m is MemoryDoc => m !== null && !m.archived);

      const memberships = await ctx.runQuery(
        internal.crystal.organic.ensembles.getMembershipsByEnsemble,
        { ensembleId: ensemble._id }
      );
      const membershipByMemory = new Map<string, EnsembleMembershipDoc>(
        memberships.map((m: EnsembleMembershipDoc) => [String(m.memoryId), m])
      );

      // Split into new vs existing based on when the memory joined the ensemble
      const newMembers = allMembers.filter((m: MemoryDoc) => {
        const membership = membershipByMemory.get(String(m._id));
        const memberJoinedAt = membership?.joinedAt ?? m.createdAt;
        return memberJoinedAt > lastTickTime;
      });
      const existingMembers = allMembers.filter((m: MemoryDoc) => {
        const membership = membershipByMemory.get(String(m._id));
        const memberJoinedAt = membership?.joinedAt ?? m.createdAt;
        return memberJoinedAt <= lastTickTime;
      });

      if (newMembers.length === 0) continue;

      const candidatePairs: Array<[MemoryDoc, MemoryDoc]> = [];

      for (const newMem of newMembers) {
        for (const existingMem of existingMembers) {
          candidatePairs.push([newMem, existingMem]);
        }
      }

      // Also compare memories that both joined since the last tick. Without this,
      // contradictions introduced by the same batch/cluster pass are never seen.
      for (let i = 0; i < newMembers.length; i++) {
        for (let j = i + 1; j < newMembers.length; j++) {
          candidatePairs.push([newMembers[i], newMembers[j]]);
        }
      }

      for (const [newMem, existingMem] of candidatePairs) {
        if (checksRemaining <= 0 || dailyRemaining <= 0) break;

        const pairKey = canonicalPairKey(newMem._id, existingMem._id);
        const existingConflict = await ctx.runQuery(
          internal.crystal.organic.contradictions.getActiveConflictForPair,
          { userId, pairKey },
        );
        if (existingConflict) continue;

        const pairDecision = shouldCheckCandidatePair(newMem, existingMem);
        if (!pairDecision.shouldCheck) continue;

        // LLM contradiction check
        const result = await checkContradictionPair(
          { title: newMem.title, content: newMem.content, createdAt: newMem.createdAt },
          { title: existingMem.title, content: existingMem.content, createdAt: existingMem.createdAt },
          preset,
          apiKeyOverride,
        );
        checksRemaining--;
        checksPerformed++;
        estimatedInputTokens += result.spend.estimatedInputTokens;
        estimatedOutputTokens += result.spend.estimatedOutputTokens;
        estimatedCostUsd += result.spend.estimatedCostUsd;

        // If the LLM is failing, break early so we stop burning budget on a broken
        // provider AND surface the outage instead of silently reporting zero finds.
        if (result.llmError) {
          llmErrors++;
          if (llmErrors >= MAX_LLM_ERRORS_BEFORE_ABORT) {
            console.warn(
              `[organic-contradictions] ${userId}: aborting scan after ${llmErrors} LLM errors (likely provider outage)`,
            );
            checksRemaining = 0;
            break;
          }
          continue;
        }

        if (result.score >= CONTRADICTION_TRACE_SCORE) {
          const predictedContext = buildContradictionContext(result, newMem, existingMem);

          // Write contradiction trace
          await ctx.runMutation(
            internal.crystal.organic.contradictions.writeContradictionTrace,
            {
              userId,
              tickId,
              predictedQuery: `Contradiction: ${result.explanation}`,
              predictedContext,
              confidence: result.score,
              sourceMemoryIds: [newMem._id, existingMem._id],
              sourcePattern: `pair:${pairKey} Detected ${result.conflictType} contradiction within ensemble "${ensemble.label}"`,
            }
          );
          findings.push({
            predictedQuery: `Contradiction: ${result.explanation}`,
            predictedContext,
            confidence: result.score,
            sourceMemoryIds: [newMem._id, existingMem._id],
          });

          // Increment daily budget
          await ctx.runMutation(
            internal.crystal.organic.contradictions.incrementAlertBudget,
            { userId, date: today, field: "contradictionsFired" }
          );
          dailyRemaining--;
          totalContradictions++;

          // Create/update conflict_group ensemble for high-scoring pairs
          if (result.score >= CONFLICT_GROUP_SCORE) {
            const existing = await ctx.runQuery(
              internal.crystal.organic.contradictions.getExistingConflictGroup,
              { userId, memAId: newMem._id, memBId: existingMem._id }
            );

            const metadata = JSON.stringify(buildConflictMetadata({
              memAId: newMem._id,
              memBId: existingMem._id,
              result,
              detectedBy: "pulse",
            }));

            if (existing) {
              await ctx.runMutation(
                internal.crystal.organic.contradictions.updateConflictGroupMetadata,
                { ensembleId: existing._id, metadata, tickId }
              );
            } else {
              const centroid = averageEmbeddings([newMem.embedding, existingMem.embedding]);
              await ctx.runMutation(
                internal.crystal.organic.contradictions.createConflictGroupEnsemble,
                {
                  userId,
                  memAId: newMem._id,
                  memBId: existingMem._id,
                  label: `Conflict: ${result.explanation.slice(0, 50)}`,
                  summary: result.explanation,
                  centroid,
                  tickId,
                  metadata,
                }
              );
            }
          }
        }
      }
    }

    console.log(
      `[organic-contradictions] ${userId}: ${budget - checksRemaining} checks, ${totalContradictions} contradictions found`
    );

    return {
      checksPerformed,
      contradictionsFound: totalContradictions,
      findings,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    };
  },
});

export const detectImmediateContradiction = internalAction({
  args: {
    userId: v.string(),
    memoryId: v.id("crystalMemories"),
    channel: v.optional(v.string()),
    excludeMemoryIds: v.optional(v.array(v.id("crystalMemories"))),
    persist: v.optional(v.boolean()),
    maxCandidates: v.optional(v.number()),
    maxChecks: v.optional(v.number()),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ImmediateContradictionCheck> => {
    const targetMemory = await ctx.runQuery(internal.crystal.mcp.getMemoryById, { memoryId: args.memoryId });
    if (!targetMemory || targetMemory.userId !== args.userId || targetMemory.archived) {
      return { status: "skipped", contradiction: null, reason: "memory_not_available" };
    }

    const today = todayDateString();
    const alertBudget = await ctx.runQuery(
      internal.crystal.organic.contradictions.getAlertBudget,
      { userId: args.userId, date: today },
    );
    if ((alertBudget?.contradictionsFired ?? 0) >= MAX_CONTRADICTIONS_PER_DAY) {
      return { status: "budget_exhausted", contradiction: null };
    }

    const maxCandidates = Math.max(1, Math.min(10, args.maxCandidates ?? 5));
    const maxChecks = Math.max(1, Math.min(5, args.maxChecks ?? 3));
    const preset = getModelPreset(args.organicModel);

    const queryEmbedding =
      Array.isArray(targetMemory.embedding) && targetMemory.embedding.length > 0
        ? targetMemory.embedding
        : await embedText(`${targetMemory.title}\n${targetMemory.content}`);
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return { status: "skipped", contradiction: null, reason: "missing_embedding" };
    }

    const rawMatches = (await ctx.vectorSearch("crystalMemories", "by_embedding", {
      vector: queryEmbedding,
      limit: maxCandidates + 3,
      filter: vectorSearchUserFilter(args.userId),
    })) as Array<{ _id: any; _score: number }>;

    const excluded = new Set((args.excludeMemoryIds ?? []).map(String));
    const candidateIds = rawMatches
      .filter((match) => String(match._id) !== String(args.memoryId) && !excluded.has(String(match._id)))
      .slice(0, maxCandidates)
      .map((match) => match._id);
    if (candidateIds.length === 0) {
      return { status: "ok", contradiction: null };
    }

    const candidateDocs = await ctx.runQuery(
      internal.crystal.organic.contradictions.getMemoriesByIdsForUser,
      {
        userId: args.userId,
        memoryIds: candidateIds,
        channel: args.channel ?? targetMemory.channel,
        excludeMemoryIds: args.excludeMemoryIds,
      },
    );
    if (candidateDocs.length === 0) {
      return { status: "ok", contradiction: null };
    }

    const rankedCandidates = candidateDocs
      .map((candidate: MemoryDoc) => {
        const decision = shouldCheckCandidatePair(
          { title: targetMemory.title, content: targetMemory.content, embedding: queryEmbedding },
          { title: candidate.title, content: candidate.content, embedding: candidate.embedding },
        );
        return { candidate, similarity: decision.similarity, shouldCheck: decision.shouldCheck };
      })
      .filter((item: { shouldCheck: boolean }) => item.shouldCheck)
      .sort((a: { similarity: number }, b: { similarity: number }) => b.similarity - a.similarity)
      .slice(0, maxChecks);

    let best: ImmediateContradictionNotification | null = null;
    for (const { candidate, similarity } of rankedCandidates) {
      const pairKey = canonicalPairKey(args.memoryId, candidate._id);
      const existingConflict = await ctx.runQuery(
        internal.crystal.organic.contradictions.getActiveConflictForPair,
        { userId: args.userId, pairKey },
      );
      if (existingConflict) continue;

      const result = await checkContradictionPair(
        { title: targetMemory.title, content: targetMemory.content, createdAt: targetMemory.createdAt },
        { title: candidate.title, content: candidate.content, createdAt: candidate.createdAt },
        preset,
        args.openrouterApiKey,
      );
      if (result.llmError || result.score < CONTRADICTION_TRACE_SCORE) {
        continue;
      }

      const contradiction: ImmediateContradictionNotification = {
        detected: true,
        score: result.score,
        explanation: result.explanation,
        conflictType: result.conflictType,
        suggestedResolution: result.suggestedResolution,
        conflictingMemory: {
          id: String(candidate._id),
          title: candidate.title,
          contentPreview: candidate.content.slice(0, 160),
          similarity,
        },
        pairKey,
        actionRequired: true,
      };

      if (!best || contradiction.score > best.score) {
        best = contradiction;
      }
    }

    if (!best) {
      return { status: "ok", contradiction: null };
    }

    if (args.persist ?? true) {
      const candidate = candidateDocs.find((doc: MemoryDoc) => String(doc._id) === best.conflictingMemory.id);
      if (candidate) {
        const now = Date.now();
        const result: ContradictionResult = {
          score: best.score,
          explanation: best.explanation,
          conflictType: best.conflictType,
          suggestedResolution: best.suggestedResolution,
        };
        const tickId = `write:${String(args.memoryId)}:${now}`;
        const predictedContext = buildContradictionContext(result, targetMemory, candidate);
        await ctx.runMutation(internal.crystal.organic.contradictions.writeContradictionTrace, {
          userId: args.userId,
          tickId,
          predictedQuery: `Contradiction: ${best.explanation}`,
          predictedContext,
          confidence: best.score,
          sourceMemoryIds: [args.memoryId, candidate._id],
          sourcePattern: `pair:${best.pairKey} Detected ${best.conflictType} contradiction during memory write`,
        });
        await ctx.runMutation(
          internal.crystal.organic.contradictions.incrementAlertBudget,
          { userId: args.userId, date: today, field: "contradictionsFired" },
        );
        if (best.score >= CONFLICT_GROUP_SCORE) {
          const existing = await ctx.runQuery(
            internal.crystal.organic.contradictions.getExistingConflictGroup,
            { userId: args.userId, memAId: args.memoryId, memBId: candidate._id },
          );
          const metadata = JSON.stringify(buildConflictMetadata({
            memAId: args.memoryId,
            memBId: candidate._id,
            result,
            detectedBy: "write",
            now,
          }));
          if (existing) {
            await ctx.runMutation(
              internal.crystal.organic.contradictions.updateConflictGroupMetadata,
              { ensembleId: existing._id, metadata, tickId },
            );
          } else {
            await ctx.runMutation(
              internal.crystal.organic.contradictions.createConflictGroupEnsemble,
              {
                userId: args.userId,
                memAId: args.memoryId,
                memBId: candidate._id,
                label: `Conflict: ${best.explanation.slice(0, 50)}`,
                summary: best.explanation,
                centroid: averageEmbeddings([queryEmbedding, candidate.embedding]),
                tickId,
                metadata,
              },
            );
          }
        }
      }
    }

    return { status: "ok", contradiction: best };
  },
});
