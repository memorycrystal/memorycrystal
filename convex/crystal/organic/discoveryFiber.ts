import { internal } from "../../_generated/api";
import { type ActionCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { getModelPreset } from "./models";
import { estimateModelSpend } from "./spend";
import { callOrganicModel, isRecord, parseGeminiJson } from "./utils";

const MAX_IDEAS_PER_PULSE = 5;
const MIN_IDEA_CONFIDENCE = 0.3;
const MIN_TITLE_LENGTH = 10;
const MIN_SUMMARY_LENGTH = 30;
const IDEA_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENSEMBLES_IN_PROMPT = 6;
const MAX_FINDINGS_IN_PROMPT = 6;

type EnsembleDoc = Doc<"organicEnsembles">;
type IdeaType =
  | "connection"
  | "pattern"
  | "contradiction_resolved"
  | "insight"
  | "action_suggested";

export type DiscoveryFinding = {
  predictedQuery: string;
  predictedContext: string;
  confidence: number;
  sourceMemoryIds: Id<"crystalMemories">[];
};

type IdeaCandidate = {
  title: string;
  summary: string;
  ideaType: IdeaType;
  confidence: number;
  sourceMemoryIds: string[];
  sourceEnsembleIds?: string[];
};

type ValidIdeaCandidate = {
  title: string;
  summary: string;
  ideaType: IdeaType;
  confidence: number;
  sourceMemoryIds: string[];
  sourceEnsembleIds?: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeIdeaTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function areIdeaTitlesSimilar(a: string, b: string): boolean {
  const normalizedA = normalizeIdeaTitle(a);
  const normalizedB = normalizeIdeaTitle(b);
  if (!normalizedA || !normalizedB) return false;
  return normalizedA === normalizedB;
}

function isIdeaType(value: unknown): value is IdeaType {
  return (
    value === "connection" ||
    value === "pattern" ||
    value === "contradiction_resolved" ||
    value === "insight" ||
    value === "action_suggested"
  );
}

function extractIdeaArray(parsed: unknown): IdeaCandidate[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord).map((item) => ({
      title: typeof item.title === "string" ? item.title : "",
      summary: typeof item.summary === "string" ? item.summary : "",
      ideaType: isIdeaType(item.ideaType) ? item.ideaType : "insight",
      confidence: typeof item.confidence === "number" ? item.confidence : 0,
      sourceMemoryIds: Array.isArray(item.sourceMemoryIds)
        ? item.sourceMemoryIds.filter((id): id is string => typeof id === "string")
        : [],
      sourceEnsembleIds: Array.isArray(item.sourceEnsembleIds)
        ? item.sourceEnsembleIds.filter((id): id is string => typeof id === "string")
        : undefined,
    }));
  }

  if (!isRecord(parsed)) return [];

  for (const key of ["ideas", "results", "items", "discoveries"]) {
    if (Array.isArray(parsed[key])) {
      return extractIdeaArray(parsed[key]);
    }
  }

  return [];
}

export function filterIdeaCandidates(
  ideas: IdeaCandidate[],
  recentTitles: string[],
  limit = MAX_IDEAS_PER_PULSE
): ValidIdeaCandidate[] {
  const accepted: ValidIdeaCandidate[] = [];
  const seenTitles = [...recentTitles];

  for (const idea of ideas) {
    const title = idea.title.trim();
    const summary = idea.summary.trim();
    const confidence = clamp(idea.confidence, 0, 1);

    if (title.length < MIN_TITLE_LENGTH) continue;
    if (summary.length < MIN_SUMMARY_LENGTH) continue;
    if (confidence < MIN_IDEA_CONFIDENCE) continue;
    if (!isIdeaType(idea.ideaType)) continue;
    if (idea.sourceMemoryIds.length === 0) continue;
    if (seenTitles.some((existing) => areIdeaTitlesSimilar(existing, title))) continue;

    accepted.push({
      title,
      summary,
      ideaType: idea.ideaType,
      confidence,
      sourceMemoryIds: [...new Set(idea.sourceMemoryIds)],
      sourceEnsembleIds: idea.sourceEnsembleIds
        ? [...new Set(idea.sourceEnsembleIds)]
        : undefined,
    });
    seenTitles.push(title);

    if (accepted.length >= limit) break;
  }

  return accepted;
}

function buildPrompt(
  ensembles: EnsembleDoc[],
  contradictionFindings: DiscoveryFinding[],
  resonanceFindings: DiscoveryFinding[]
): string {
  const payload = {
    ensembles: ensembles.slice(0, MAX_ENSEMBLES_IN_PROMPT).map((ensemble) => ({
      id: String(ensemble._id),
      type: ensemble.ensembleType,
      label: ensemble.label,
      summary: ensemble.summary,
      confidence: ensemble.confidence,
      memberMemoryIds: ensemble.memberMemoryIds.map(String),
    })),
    contradictions: contradictionFindings.slice(0, MAX_FINDINGS_IN_PROMPT).map((finding) => ({
      predictedQuery: finding.predictedQuery,
      predictedContext: finding.predictedContext,
      confidence: finding.confidence,
      sourceMemoryIds: finding.sourceMemoryIds.map(String),
    })),
    resonances: resonanceFindings.slice(0, MAX_FINDINGS_IN_PROMPT).map((finding) => ({
      predictedQuery: finding.predictedQuery,
      predictedContext: finding.predictedContext,
      confidence: finding.confidence,
      sourceMemoryIds: finding.sourceMemoryIds.map(String),
    })),
  };

  return `You are a discovery engine analyzing the organic memory system's latest pulse results for a user.

Recent pulse found:
${JSON.stringify(payload, null, 2)}

Based on these findings, identify meaningful discoveries. For each:
- Title: A concise, specific insight (not generic)
- Summary: 2-3 sentences explaining why this matters and what the user should know
- Type: connection | pattern | contradiction_resolved | insight | action_suggested
- Confidence: 0.0-1.0
- Source memory IDs: which memories contributed
- Source ensemble IDs: which ensembles contributed, when relevant

RULES:
- Only create ideas that are genuinely insightful, not simple restatements
- Max 5 ideas per pulse
- Prefer fewer, higher-quality ideas over many weak ones
- Only use memory IDs and ensemble IDs that appear in the pulse data
- Return an empty array if nothing stands out

Return ONLY valid JSON array. No markdown, no explanation.`;
}

export async function runDiscoveryFiber(
  ctx: ActionCtx,
  args: {
    userId: string;
    tickId: string;
    since: number;
    organicModel?: string;
    openrouterApiKey?: string;
    ensemblesCreated: number;
    contradictionsFound: number;
    resonancesFound: number;
    contradictionFindings: DiscoveryFinding[];
    resonanceFindings: DiscoveryFinding[];
  }
): Promise<{
  ideasCreated: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}> {
  const emptyResult = {
    ideasCreated: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCostUsd: 0,
  };

  if (
    args.ensemblesCreated <= 0 &&
    args.contradictionsFound <= 0 &&
    args.resonancesFound <= 0
  ) {
    return emptyResult;
  }

  const [ensembles, recentIdeasPage] = await Promise.all([
    ctx.runQuery(internal.crystal.organic.contradictions.getEnsemblesModifiedSince, {
      userId: args.userId,
      since: args.since,
    }),
    ctx.runQuery(internal.crystal.organic.ideas.getMyIdeasInternal, {
      userId: args.userId,
      limit: 50,
    }),
  ]);

  const recentTitles = recentIdeasPage.ideas
    .filter((idea: any) => idea.createdAt >= Date.now() - IDEA_DEDUP_WINDOW_MS)
    .map((idea: any) => idea.title);

  if (
    ensembles.length === 0 &&
    args.contradictionFindings.length === 0 &&
    args.resonanceFindings.length === 0
  ) {
    return emptyResult;
  }

  const prompt = buildPrompt(
    ensembles,
    args.contradictionFindings,
    args.resonanceFindings
  );
  const preset = getModelPreset(args.organicModel);
  const responseText = await callOrganicModel(prompt, preset, args.openrouterApiKey);
  const spend = estimateModelSpend(prompt, responseText, preset);
  if (!responseText) {
    return {
      ideasCreated: 0,
      ...spend,
    };
  }

  const parsed = parseGeminiJson<unknown>(responseText);
  const candidates = extractIdeaArray(parsed);
  const filtered = filterIdeaCandidates(candidates, recentTitles, MAX_IDEAS_PER_PULSE);
  if (filtered.length === 0) {
    return {
      ideasCreated: 0,
      ...spend,
    };
  }

  const validMemoryIds = new Set<string>();
  const validEnsembleIds = new Set<string>();
  for (const ensemble of ensembles) {
    validEnsembleIds.add(String(ensemble._id));
    for (const memoryId of ensemble.memberMemoryIds) {
      validMemoryIds.add(String(memoryId));
    }
  }
  for (const finding of [...args.contradictionFindings, ...args.resonanceFindings]) {
    for (const memoryId of finding.sourceMemoryIds) {
      validMemoryIds.add(String(memoryId));
    }
  }

  let ideasCreated = 0;
  for (const idea of filtered) {
    const sourceMemoryIds = idea.sourceMemoryIds.filter((id) => validMemoryIds.has(id)) as Array<
      Id<"crystalMemories">
    >;
    if (sourceMemoryIds.length === 0) continue;

    const sourceEnsembleIds = idea.sourceEnsembleIds?.filter((id) =>
      validEnsembleIds.has(id)
    ) as Array<Id<"organicEnsembles">> | undefined;

    await ctx.runMutation(internal.crystal.organic.ideas.createIdea, {
      userId: args.userId,
      title: idea.title,
      summary: idea.summary,
      ideaType: idea.ideaType,
      sourceMemoryIds,
      sourceEnsembleIds: sourceEnsembleIds && sourceEnsembleIds.length > 0 ? sourceEnsembleIds : undefined,
      confidence: idea.confidence,
      pulseId: args.tickId,
      fiberId: "discovery",
    });
    ideasCreated++;
  }

  return {
    ideasCreated,
    ...spend,
  };
}
