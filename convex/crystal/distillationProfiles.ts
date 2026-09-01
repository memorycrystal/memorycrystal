/**
 * Channel-derived distillation profiles (ADR 0008).
 *
 * The nightly Reflection Cycle derives a distillation profile from each
 * message's channel prefix. A coding session and a coaching session must
 * produce different kinds of memory: engineering channels record what changed
 * and its effect, relational channels keep the person / relationship / date
 * rules, and everything else uses the general profile.
 *
 * All prompt text lives in this one module behind a single profile -> prompt
 * mapping. Call sites must not scatter per-profile strings.
 */

export type DistillationProfile = "engineering" | "relational" | "general";

type DistillationWindow = {
  text: string;
};

type RecentExtractionDigest = {
  title: string;
  content: string;
};

const ENGINEERING_PREFIXES = new Set(["codex", "mission-control"]);
const RELATIONAL_PREFIXES = new Set(["peer-coach", "telegram"]);

export function deriveDistillationProfile(channel?: string): DistillationProfile {
  const prefix = channel?.split(":")[0]?.trim().toLowerCase() ?? "";
  if (ENGINEERING_PREFIXES.has(prefix)) return "engineering";
  if (RELATIONAL_PREFIXES.has(prefix)) return "relational";
  return "general";
}

// General profile — today's extraction prompt. Relational reuses it verbatim so
// the person / relationship / date instructions stay exactly as they are.
const GENERAL_DISTILLATION_PROMPT = `You extract durable long-term memories from short-term conversation logs.

Return ONLY valid JSON in this exact shape:
{"memories":[{"title":"short title","content":"durable fact/decision/preference/lesson","store":"semantic|episodic|procedural|prospective","category":"decision|lesson|person|rule|event|fact|goal|skill|workflow|conversation","tags":["tag"],"importance":0.0,"confidence":0.0}]}

Rules:
- Extract only durable memories useful in future sessions: decisions, preferences, stable facts, goals, lessons, reusable workflows, commitments, or meaningful events.
- Do not save transient chatter, greetings, tool output noise, or content already phrased as a temporary status.
- Prefer semantic/fact for stable facts, episodic/event for dated work/events, procedural/skill or workflow for reusable processes, prospective/goal for future commitments.
- Keep each content item self-contained, factual, and under 600 characters.
- Make each memory findable on its own: include the relevant person's name AND their relationship to the user, plus dates and specifics, so it surfaces for both specific and general queries. E.g. write "Andy's daughter Scarlett Parsons was born October 25, 2016" — NOT "Scarlett born October 25, 2016". For a person memory, name the relationship (daughter, son, wife, partner, client, colleague) explicitly in the content.
- Use category "person" for facts about people the user knows (family, relationships, contacts); "fact" for other stable facts.
- If the window states the same fact more than once, extract it exactly once; do not emit near-identical restatements as separate memories.
- Do not emit any fact already represented in the earlier-turn digest list, even when the new wording differs. Return only genuinely new or materially changed information.
- Return {"memories":[]} when no durable memory exists.`;

// Engineering profile — genuinely new prompt text. Records what changed, where,
// when and to what effect, and never stores reasoning, chain-of-thought, diffs,
// code blocks, tool output or stack traces.
const ENGINEERING_DISTILLATION_PROMPT = `You extract durable long-term memories from short-term software-engineering conversation logs.

Return ONLY valid JSON in this exact shape:
{"memories":[{"title":"short title","content":"durable fact/decision/preference/lesson","store":"semantic|episodic|procedural|prospective","category":"decision|lesson|person|rule|event|fact|goal|skill|workflow|conversation","tags":["tag"],"importance":0.0,"confidence":0.0}]}

Rules:
- Record what changed in the engineering session: the change itself, the file or function involved, when it happened, and the effect or outcome.
- Keep each content item factual, self-contained, and under 600 characters. Include the date, the file path, and the symbol so it surfaces on its own, e.g. "On 2026-08-06 memoryCapForWindow in convex/crystal/ltmExtraction.ts gained an ExtractionContext branch; nightly windows now allow 6 memories."
- Never store reasoning, chain-of-thought, internal deliberation, diffs, code blocks, tool output, logs, or stack traces. When a window contains only such content with no durable fact, return {"memories":[]}.
- Do not save transient chatter or temporary status messages.
- Prefer semantic/fact for stable facts, episodic/event for dated work/events, procedural/skill or workflow for reusable processes, prospective/goal for future commitments.
- Use category "person" for facts about people the user works with (teammates, clients, contacts); "fact" for other stable facts.
- If the window states the same fact more than once, extract it exactly once; do not emit near-identical restatements as separate memories.
- Do not emit any fact already represented in the earlier-turn digest list, even when the new wording differs. Return only genuinely new or materially changed information.
- Return {"memories":[]} when no durable memory exists.`;

export const DISTILLATION_PROFILE_PROMPTS: Record<DistillationProfile, string> = {
  engineering: ENGINEERING_DISTILLATION_PROMPT,
  relational: GENERAL_DISTILLATION_PROMPT,
  general: GENERAL_DISTILLATION_PROMPT,
};

export const buildDistillationPrompt = (
  window: DistillationWindow,
  profile: DistillationProfile,
  recentDigests: RecentExtractionDigest[] = [],
) => {
  const priorSection = recentDigests.length > 0
    ? `\nAlready extracted from earlier turns in this same session and channel:\n${recentDigests
        .map((digest) => `- ${digest.title.slice(0, 120)}: ${digest.content.slice(0, 240)}`)
        .join("\n")}\n`
    : "";
  return `${DISTILLATION_PROFILE_PROMPTS[profile]}${priorSection}
Conversation window:
${window.text}`;
};
