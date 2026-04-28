import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc } from "../../_generated/dataModel";
import { callOrganicModel, isRecord, parseGeminiJson } from "./utils";
import { estimateModelSpend, type EstimatedSpend } from "./spend";
import { getModelPreset, type ModelPreset } from "./models";

const skillSuggestionsApi = ((internal as any).crystal.organic.skillSuggestions) as any;

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_MEMORIES_FOR_EXTRACTION = 60;
const DEDUP_SIMILARITY_THRESHOLD = 0.8;
export const MAX_PROCEDURALS_PER_TICK = 1;
export const MIN_OBSERVATIONS_TO_CREATE = 2;

// ── Types ────────────────────────────────────────────────────────────────────

type MemoryDoc = Doc<"crystalMemories">;

export type ProceduralStep = {
  order: number;
  action: string;
  command?: string;
};

export type ProceduralSkillMetadata = {
  skillFormat: true;
  triggerConditions: string[];
  steps: ProceduralStep[];
  pitfalls: string[];
  verification: string;
  patternType: "workflow" | "problem_solving" | "decision_chain";
  observationCount: number;
  lastObserved: number;
};

type ProceduralCandidate = {
  title: string;
  content: string;
  sourceMemoryIndices: number[];
  patternType: "workflow" | "problem_solving" | "decision_chain";
  observationCount: number;
  triggerConditions: string[];
  steps: ProceduralStep[];
  pitfalls: string[];
  verification: string;
};

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildExtractionPrompt(memoriesSummary: string): string {
  return `You are a procedural memory extractor. Analyze the following memories and identify reusable workflow patterns, problem-solving patterns, or decision chains.

Look for:
1. **Workflows**: Sequences of 3+ memories that form steps to accomplish something (e.g., setup → configure → deploy → verify)
2. **Problem-solving patterns**: The same type of issue resolved the same way 2+ times (e.g., debugging approach, troubleshooting steps)
3. **Decision chains**: A decision, its implementation, and its outcome forming a reusable template

Memories to analyze:
${memoriesSummary}

For each pattern found, return a JSON object with ALL of these fields:
- "title": "How to: [action]" for workflows, "Pattern: [name]" for problem-solving patterns
- "content": brief 1-2 sentence summary of the pattern (do NOT put steps/pitfalls here — use the structured fields below)
- "sourceMemoryIndices": array of 0-based indices of the memories that form this pattern
- "patternType": "workflow" | "problem_solving" | "decision_chain"
- "observationCount": how many times you see this pattern in the memories (1 if single sequence, higher if repeated)
- "triggerConditions": array of concrete situations that should activate this skill (REQUIRED — at least 1 entry)
- "steps": ordered array of objects with "order" (number), "action" (string), and optional "command" (string). REQUIRED — extract at least 2 steps for every pattern. This is the core of the skill.
- "pitfalls": array of common mistakes, failure modes, or things to watch out for. REQUIRED — extract at least 1 pitfall per pattern from the source memories.
- "verification": short sentence describing how to confirm the process worked. REQUIRED — never leave empty.

IMPORTANT: The structured fields (steps, pitfalls, verification, triggerConditions) MUST be populated. These are displayed separately in the UI. Do not embed step/pitfall information only in "content" — it must be in the structured arrays.

Return a JSON object: { "patterns": [...] }
Return { "patterns": [] } if no clear patterns are found. Do not force patterns — only extract genuine reusable knowledge.
Return ONLY valid JSON. No markdown, no explanation.`;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export const getRecentMemoriesForExtraction = internalQuery({
  args: { userId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("crystalMemories")
      .withIndex("by_user_created", (q) =>
        q.eq("userId", args.userId).gte("createdAt", args.since)
      )
      .order("desc")
      .take(MAX_MEMORIES_FOR_EXTRACTION * 2);
    return results
      .filter((m) => !m.archived && m.store !== "prospective" && m.store !== "procedural")
      .slice(0, MAX_MEMORIES_FOR_EXTRACTION);
  },
});

export const getExistingProceduralMemories = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("crystalMemories")
      .withIndex("by_store_category", (q) =>
        q.eq("userId", args.userId).eq("store", "procedural").eq("category", "workflow").eq("archived", false)
      )
      .take(100);
  },
});

// ── Mutations ────────────────────────────────────────────────────────────────

export const reinforceProceduralMemory = internalMutation({
  args: {
    memoryId: v.id("crystalMemories"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    metadata: v.optional(v.string()),
    newConfidence: v.float64(),
    additionalTags: v.array(v.string()),
    observationCount: v.number(),
  },
  handler: async (ctx, args) => {
    const memory = await ctx.db.get(args.memoryId);
    if (!memory) return;

    const existingTags = memory.tags ?? [];
    const mergedTags = Array.from(new Set([...existingTags, ...args.additionalTags]));

    await ctx.db.patch(args.memoryId, {
      ...(args.title ? { title: args.title } : {}),
      ...(args.content ? { content: args.content } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
      confidence: Math.max(memory.confidence, args.newConfidence),
      strength: Math.min(1.0, memory.strength + 0.1),
      lastAccessedAt: Date.now(),
      accessCount: Math.max(memory.accessCount + 1, args.observationCount),
      tags: mergedTags,
    });
  },
});

// ── Main Action ──────────────────────────────────────────────────────────────

export const extractProcedurals = internalAction({
  args: {
    userId: v.string(),
    tickId: v.string(),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, tickId } = args;
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;
    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    let estimatedCostUsd = 0;
    let proceduralsCreated = 0;
    let proceduralsReinforced = 0;

    const emptyResult = () => ({
      proceduralsCreated,
      proceduralsReinforced,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    });

    const runSkillGapAnalysis = async () => {
      try {
        await ctx.runAction(skillSuggestionsApi.analyzeSkillGaps, {
          userId: args.userId,
          tickId: args.tickId,
          organicModel: args.organicModel,
          openrouterApiKey: args.openrouterApiKey,
        });
      } catch (e) {
        console.error("[organic-procedural] skill gap analysis failed:", e);
      }
    };

    // Fetch recent memories (last 7 days) for pattern analysis
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentMemories: MemoryDoc[] = await ctx.runQuery(
      internal.crystal.organic.proceduralExtraction.getRecentMemoriesForExtraction,
      { userId, since: sevenDaysAgo }
    );

    if (recentMemories.length < 3) {
      await runSkillGapAnalysis();
      return emptyResult();
    }

    // Build memory summary for the LLM
    const memoriesSummary = recentMemories
      .map((m, i) =>
        `[${i}] [${m.store}/${m.category}] ${m.title}: ${m.content.slice(0, 200)}`
      )
      .join("\n");

    // Call LLM to detect patterns
    const prompt = buildExtractionPrompt(memoriesSummary);
    const text = await callOrganicModel(prompt, preset, apiKeyOverride);
    const spend = estimateModelSpend(prompt, text, preset);
    estimatedInputTokens += spend.estimatedInputTokens;
    estimatedOutputTokens += spend.estimatedOutputTokens;
    estimatedCostUsd += spend.estimatedCostUsd;

    if (!text) {
      console.log(`[organic-procedural] ${userId}: model returned empty`);
      await runSkillGapAnalysis();
      return emptyResult();
    }

    const parsed = parseGeminiJson<unknown>(text);
    const candidates = extractCandidates(parsed);

    if (candidates.length === 0) {
      console.log(`[organic-procedural] ${userId}: no patterns detected`);
    }

    // Load existing procedural memories for deduplication
    const existingProcedurals: MemoryDoc[] = await ctx.runQuery(
      internal.crystal.organic.proceduralExtraction.getExistingProceduralMemories,
      { userId }
    );

    // Process candidates (cap per tick)
    const eligibleCandidates = candidates.filter(
      (candidate) => candidate.observationCount >= MIN_OBSERVATIONS_TO_CREATE
    );
    for (const candidate of eligibleCandidates.slice(0, MAX_PROCEDURALS_PER_TICK)) {
      // Resolve source memory IDs from indices
      const sourceIds = candidate.sourceMemoryIndices
        .filter((i) => i >= 0 && i < recentMemories.length)
        .map((i) => recentMemories[i]._id);

      if (sourceIds.length < 2) continue;

      // Compute confidence from observation count
      const confidence = candidate.observationCount >= 5
        ? 0.9
        : candidate.observationCount >= 2
          ? 0.7
          : 0.5;

      const tags = [
        "organic",
        "auto-extracted",
        `pattern:${candidate.patternType}`,
        ...sourceIds.map((id) => `source:${id}`),
      ];

      // Deduplication: check similarity against existing procedural memories
      // We need an embedding for the candidate to compare. Since we don't have one yet,
      // use text-based title matching as a fast pre-filter, then rely on
      // createMemoryInternal's built-in title+content dedup.
      const duplicateMatch = findDuplicateByContent(candidate, existingProcedurals);

      if (duplicateMatch) {
        const mergedMetadata = mergeProceduralMetadata(
          parseProceduralMetadata(duplicateMatch.metadata),
          candidate,
          sourceIds.length
        );
        const mergedContent = buildHumanReadableContent(candidate, mergedMetadata);

        // Reinforce existing memory
        await ctx.runMutation(
          internal.crystal.organic.proceduralExtraction.reinforceProceduralMemory,
          {
            memoryId: duplicateMatch._id,
            title: mergedMetadata.patternType === "workflow" ? candidate.title.slice(0, 200) : duplicateMatch.title,
            content: mergedContent,
            metadata: JSON.stringify(mergedMetadata),
            newConfidence: confidence,
            additionalTags: tags,
            observationCount: mergedMetadata.observationCount,
          }
        );
        proceduralsReinforced++;
        console.log(`[organic-procedural] ${userId}: reinforced "${duplicateMatch.title}"`);
      } else {
        const metadata = buildProceduralMetadata(candidate, sourceIds.length);
        // Create new procedural memory
        try {
          const memId = await ctx.runMutation(internal.crystal.memories.createMemoryInternal, {
            userId,
            store: "procedural",
            category: "workflow",
            title: candidate.title.slice(0, 200),
            content: candidate.content,
            metadata: JSON.stringify(metadata),
            embedding: [],
            strength: 0.8,
            confidence,
            valence: 0,
            arousal: 0.2,
            source: "inference",
            tags,
            archived: false,
          });

          // Schedule async embedding
          await ctx.scheduler.runAfter(0, internal.crystal.mcp.embedMemory, {
            memoryId: memId,
          });

          proceduralsCreated++;
          console.log(`[organic-procedural] ${userId}: created "${candidate.title}"`);
        } catch (err) {
          console.error(`[organic-procedural] ${userId}: failed to create memory:`, err);
        }
      }
    }

    console.log(
      `[organic-procedural] ${userId}: ${proceduralsCreated} created, ${proceduralsReinforced} reinforced`
    );

    await runSkillGapAnalysis();

    return {
      proceduralsCreated,
      proceduralsReinforced,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
    };
  },
});

// ── Backfill: Re-extract structured fields from existing skill content ────────

function buildReExtractionPrompt(title: string, content: string): string {
  return `Extract structured skill metadata from the following procedural memory. The content contains steps, pitfalls, and verification info in prose form that needs to be parsed into structured fields.

Title: ${title}
Content: ${content}

Return a JSON object with:
- "steps": ordered array of objects with "order" (number), "action" (string), and optional "command" (string). Extract ALL steps mentioned.
- "pitfalls": array of common mistakes or things to watch out for. Extract ALL pitfalls mentioned.
- "verification": short sentence describing how to verify the process worked.
- "triggerConditions": array of situations that should activate this skill.

IMPORTANT: Parse the prose content carefully. Steps often appear as numbered lists, "Step 1/2/3" patterns, or action sequences. Pitfalls appear as warnings, "do NOT", "common pitfalls", caution notes. Verification appears as "verify", "confirm", "check that".

Return ONLY valid JSON. No markdown, no explanation.`;
}

export const backfillSkillStructuredFields = internalAction({
  args: {
    userId: v.optional(v.string()),
    organicModel: v.optional(v.string()),
    openrouterApiKey: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const preset = getModelPreset(args.organicModel);
    const apiKeyOverride = args.openrouterApiKey;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    // Get all procedural memories (optionally filtered by user)
    const skills: MemoryDoc[] = args.userId
      ? await ctx.runQuery(
          internal.crystal.organic.proceduralExtraction.getExistingProceduralMemories,
          { userId: args.userId }
        )
      : [];

    if (skills.length === 0) {
      console.log("[backfill-skills] No skills found");
      return { updated: 0, skipped: 0, failed: 0 };
    }

    for (const skill of skills) {
      const existingMeta = parseProceduralMetadata(skill.metadata);
      const hasStructuredData = existingMeta &&
        (existingMeta.steps.length > 0 || existingMeta.pitfalls.length > 0 || existingMeta.verification.length > 0);

      if (hasStructuredData) {
        skipped++;
        continue;
      }

      // Skill has no structured fields -- re-extract from content
      try {
        const prompt = buildReExtractionPrompt(skill.title, skill.content);
        const text = await callOrganicModel(prompt, preset, apiKeyOverride);
        if (!text) {
          failed++;
          continue;
        }

        const parsed = parseGeminiJson<Record<string, unknown>>(text);
        if (!parsed) {
          failed++;
          continue;
        }

        const steps = normalizeSteps(parsed.steps);
        const pitfalls = normalizeStringArray(parsed.pitfalls);
        const verification = typeof parsed.verification === "string" ? parsed.verification.trim() : "";
        const triggerConditions = normalizeStringArray(parsed.triggerConditions);

        if (steps.length === 0 && pitfalls.length === 0 && !verification) {
          console.log(`[backfill-skills] No structured data extracted for "${skill.title}"`);
          skipped++;
          continue;
        }

        const newMetadata: ProceduralSkillMetadata = {
          skillFormat: true,
          triggerConditions: triggerConditions.length > 0
            ? triggerConditions
            : existingMeta?.triggerConditions ?? [],
          steps,
          pitfalls,
          verification,
          patternType: existingMeta?.patternType ?? "workflow",
          observationCount: existingMeta?.observationCount ?? 1,
          lastObserved: existingMeta?.lastObserved ?? Date.now(),
        };

        if (args.dryRun) {
          console.log(`[backfill-skills] DRY RUN "${skill.title}": ${steps.length} steps, ${pitfalls.length} pitfalls, verification: ${verification ? "yes" : "no"}`);
        } else {
          await ctx.runMutation(
            internal.crystal.organic.proceduralExtraction.reinforceProceduralMemory,
            {
              memoryId: skill._id,
              content: buildHumanReadableContent({ content: skill.content }, newMetadata),
              metadata: JSON.stringify(newMetadata),
              newConfidence: skill.confidence,
              additionalTags: ["backfill-structured"],
              observationCount: newMetadata.observationCount,
            }
          );
          console.log(`[backfill-skills] Updated "${skill.title}": ${steps.length} steps, ${pitfalls.length} pitfalls`);
        }
        updated++;
      } catch (err) {
        console.error(`[backfill-skills] Failed on "${skill.title}":`, err);
        failed++;
      }
    }

    console.log(`[backfill-skills] Done: ${updated} updated, ${skipped} skipped, ${failed} failed`);
    return { updated, skipped, failed };
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractCandidates(parsed: unknown): ProceduralCandidate[] {
  if (!parsed) return [];

  let items: unknown[] = [];

  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (isRecord(parsed)) {
    for (const key of ["patterns", "procedures", "workflows", "results"]) {
      const value = parsed[key];
      if (Array.isArray(value)) {
        items = value;
        break;
      }
    }
  }

  return items
    .filter(isRecord)
    .filter((item) => typeof item.title === "string" && typeof item.content === "string")
    .map((item) => ({
      title: item.title as string,
      content: item.content as string,
      sourceMemoryIndices: Array.isArray(item.sourceMemoryIndices)
        ? (item.sourceMemoryIndices as number[]).filter((n) => typeof n === "number")
        : [],
      patternType: validatePatternType(item.patternType as string),
      observationCount: typeof item.observationCount === "number" ? item.observationCount : 1,
      triggerConditions: normalizeStringArray(item.triggerConditions),
      steps: normalizeSteps(item.steps),
      pitfalls: normalizeStringArray(item.pitfalls),
      verification: typeof item.verification === "string" ? item.verification.trim() : "",
    }));
}

const VALID_PATTERN_TYPES = new Set(["workflow", "problem_solving", "decision_chain"]);

function validatePatternType(t: string): ProceduralCandidate["patternType"] {
  return VALID_PATTERN_TYPES.has(t) ? (t as ProceduralCandidate["patternType"]) : "workflow";
}

/**
 * Simple content-based dedup: checks if any existing procedural memory
 * has substantial title overlap with the candidate.
 * Returns the matching memory if similarity > threshold, null otherwise.
 */
export function findDuplicateByContent(
  candidate: ProceduralCandidate,
  existingProcedurals: MemoryDoc[]
): MemoryDoc | null {
  const candidateTitle = candidate.title.toLowerCase().trim();
  const candidateWords = new Set(candidateTitle.split(/\s+/).filter((w) => w.length > 3));

  for (const existing of existingProcedurals) {
    const existingTitle = existing.title.toLowerCase().trim();
    const existingWords = new Set(existingTitle.split(/\s+/).filter((w) => w.length > 3));

    if (candidateWords.size === 0 || existingWords.size === 0) continue;

    // Jaccard similarity on significant words
    const intersection = [...candidateWords].filter((w) => existingWords.has(w)).length;
    const union = new Set([...candidateWords, ...existingWords]).size;
    const similarity = union > 0 ? intersection / union : 0;

    if (similarity > DEDUP_SIMILARITY_THRESHOLD) {
      return existing;
    }

    // Secondary check: word-level content overlap (>60% = duplicate)
    const candidateContentWords = candidate.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const existingContentWords = existing.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (candidateContentWords.length > 0 && existingContentWords.length > 0) {
      const existingWordSet = new Set(existingContentWords);
      const overlap = candidateContentWords.filter((w) => existingWordSet.has(w)).length;
      const overlapRatio = overlap / Math.max(candidateContentWords.length, existingContentWords.length);
      if (overlapRatio > 0.6) {
        return existing;
      }
    }
  }

  return null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeSteps(value: unknown): ProceduralStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item, index) => {
      const action = typeof item.action === "string" ? item.action.trim() : "";
      if (!action) return null;
      const order = typeof item.order === "number" && Number.isFinite(item.order)
        ? item.order
        : index + 1;
      const command = typeof item.command === "string" ? item.command.trim() : undefined;
      return {
        order,
        action,
        ...(command ? { command } : {}),
      };
    })
    .filter((item): item is ProceduralStep => Boolean(item))
    .sort((a, b) => a.order - b.order)
    .slice(0, 12);
}

export function parseProceduralMetadata(metadata?: string | null): ProceduralSkillMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!isRecord(parsed) || parsed.skillFormat !== true) return null;
    const patternType = validatePatternType(typeof parsed.patternType === "string" ? parsed.patternType : "workflow");
    return {
      skillFormat: true,
      triggerConditions: normalizeStringArray(parsed.triggerConditions),
      steps: normalizeSteps(parsed.steps),
      pitfalls: normalizeStringArray(parsed.pitfalls),
      verification: typeof parsed.verification === "string" ? parsed.verification.trim() : "",
      patternType,
      observationCount: typeof parsed.observationCount === "number" ? Math.max(1, Math.round(parsed.observationCount)) : 1,
      lastObserved: typeof parsed.lastObserved === "number" ? parsed.lastObserved : 0,
    };
  } catch {
    return null;
  }
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function mergeSteps(existing: ProceduralStep[], incoming: ProceduralStep[]): ProceduralStep[] {
  const seen = new Set<string>();
  const merged: ProceduralStep[] = [];

  for (const step of [...existing, ...incoming]) {
    const key = `${step.action.toLowerCase()}::${step.command?.toLowerCase() || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(step);
  }

  return merged
    .map((step, index) => ({ ...step, order: index + 1 }))
    .slice(0, 12);
}

export function buildHumanReadableContent(
  candidate: Pick<ProceduralCandidate, "content">,
  metadata: ProceduralSkillMetadata
): string {
  const triggerSection = metadata.triggerConditions.length
    ? `Trigger conditions:\n${metadata.triggerConditions.map((item) => `- ${item}`).join("\n")}`
    : "";
  const stepsSection = metadata.steps.length
    ? `Steps:\n${metadata.steps.map((step) => `${step.order}. ${step.action}${step.command ? ` (${step.command})` : ""}`).join("\n")}`
    : "";
  const pitfallsSection = metadata.pitfalls.length
    ? `Pitfalls:\n${metadata.pitfalls.map((item) => `- ${item}`).join("\n")}`
    : "";
  const verificationSection = metadata.verification
    ? `Verification:\n${metadata.verification}`
    : "";

  return [
    candidate.content.trim(),
    triggerSection,
    stepsSection,
    pitfallsSection,
    verificationSection,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function buildProceduralMetadata(
  candidate: ProceduralCandidate,
  sourceObservationCount = 1
): ProceduralSkillMetadata {
  return {
    skillFormat: true,
    triggerConditions: uniqueStrings(candidate.triggerConditions),
    steps: mergeSteps([], candidate.steps),
    pitfalls: uniqueStrings(candidate.pitfalls),
    verification: candidate.verification.trim(),
    patternType: candidate.patternType,
    observationCount: Math.max(1, candidate.observationCount, sourceObservationCount),
    lastObserved: Date.now(),
  };
}

export function mergeProceduralMetadata(
  existing: ProceduralSkillMetadata | null,
  candidate: ProceduralCandidate,
  sourceObservationCount = 1
): ProceduralSkillMetadata {
  const incoming = buildProceduralMetadata(candidate, sourceObservationCount);
  if (!existing) return incoming;

  return {
    skillFormat: true,
    triggerConditions: uniqueStrings([...existing.triggerConditions, ...incoming.triggerConditions]),
    steps: mergeSteps(existing.steps, incoming.steps),
    pitfalls: uniqueStrings([...existing.pitfalls, ...incoming.pitfalls]),
    verification: incoming.verification || existing.verification,
    patternType: incoming.patternType,
    observationCount: Math.max(existing.observationCount + Math.max(1, candidate.observationCount), incoming.observationCount),
    lastObserved: Date.now(),
  };
}
