import { v } from "convex/values";
import { action } from "../_generated/server";

const nowMs = () => Date.now();

function sanitizeLastSessionSummary(summary: string | undefined | null): string {
  const text = (summary || "").trim();
  if (!text) return "";
  if (/^## Memory( Crystal)? (— )?(Context|Wake) Briefing/m.test(text)) {
    const recentIdx = text.indexOf("Recent conversation:");
    if (recentIdx >= 0) return text.slice(recentIdx).trim();
    const recentHeadingIdx = text.indexOf("## Recent conversation");
    if (recentHeadingIdx >= 0) return text.slice(recentHeadingIdx).trim();
    const goalsIdx = text.indexOf("Open goals:");
    if (goalsIdx >= 0) return text.slice(goalsIdx).trim();
  }
  return text;
}

function buildStoredSessionSummary(lines: string[]): string {
  if (lines.length > 0) return ["Recent conversation:", ...lines].join("\n");
  return "No recent conversation captured.";
}

function formatRecentMessage(message: { role: "user" | "assistant" | "system"; content: string; timestamp: number }): string {
  const at = new Date(message.timestamp).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const shortContent = message.content.length > 120 ? `${message.content.slice(0, 120)}...` : message.content;
  return `[${at}] ${message.role}: ${shortContent}`;
}

const wakeInput = v.object({
  channel: v.optional(v.string()),
  limit: v.optional(v.number()),
});

type WakeMemory = {
  _id: string;
  memoryId: string;
  title: string;
  content: string;
  store: string;
  category: string;
  strength: number;
  confidence: number;
  lastAccessedAt: number;
};

const toWakeMemory = (memory: {
  _id: string;
  title: string;
  content: string;
  store: string;
  category: string;
  strength: number;
  confidence: number;
  lastAccessedAt: number;
}): WakeMemory => ({
  memoryId: memory._id,
  title: memory.title,
  content: memory.content,
  store: memory.store,
  category: memory.category,
  strength: memory.strength,
  confidence: memory.confidence,
  lastAccessedAt: memory.lastAccessedAt,
  _id: memory._id,
});

const composeBriefing = (
  channel: string | undefined,
  openGoals: WakeMemory[],
  recentDecisions: WakeMemory[],
  guardrailMemories: WakeMemory[],
  recentMessages:
    | Array<{
        role: "user" | "assistant" | "system";
        content: string;
        timestamp: number;
      }>
    | undefined,
  lastSession: { summary?: string; lastActiveAt?: number; messageCount?: number } | null
) => {
  const bootstrapInstructions = [
    "## 🔮 Memory — Active",
    "You have access to persistent memory tools. Use them proactively:",
    "- **crystal_recall** — search your memory when the user references past events, decisions, or asks 'do you remember'",
    "- **crystal_remember** — save important decisions, lessons, facts, goals, or anything worth keeping",
    "- **crystal_checkpoint** — snapshot current memory state at significant milestones",
    "- **crystal_what_do_i_know** — summarize what you know about a topic",
    "- **crystal_why_did_we** — explain the reasoning behind past decisions",
    'In normal client-facing replies, refer to this system as "memory" rather than "Memory Crystal" or "Crystal" unless the user is asking a technical, admin, debug, install, billing, or backend question.',
    "Memory is automatically captured each turn. Save clear durable memories without asking first. Ask before saving only when the memory is ambiguous, sensitive, private, or consent-dependent.",
    "",
  ];

  const heading = ["## Memory Wake Briefing", `Channel: ${channel ?? "unknown"}`, ""];
  const openGoalLines = openGoals.length
    ? openGoals.map((memory) => `- [${memory.store}] ${memory.title}`)
    : ["- none"];
  const decisionLines = recentDecisions.length
    ? recentDecisions.map((memory) => `- [${memory.store}] ${memory.title}`)
    : ["- none"];
  const guardrailLines = guardrailMemories.map(
    (memory) => `- [${memory.category}] ${memory.title}`
  );
  const formattedMessages = recentMessages ? recentMessages.map((message) => formatRecentMessage(message)) : [];

  const lastSessionLines: string[] = [];
  if (lastSession?.summary) {
    const ago = lastSession.lastActiveAt
      ? `${Math.round((Date.now() - lastSession.lastActiveAt) / 3600000)}h ago`
      : "recently";
    lastSessionLines.push(
      "",
      `## Last session (${ago}, ${lastSession.messageCount ?? 0} messages):`,
      sanitizeLastSessionSummary(lastSession.summary).slice(0, 300)
    );
  }

  const lines = [
    ...heading,
    ...lastSessionLines,
    "",
    "Open goals:",
    ...openGoalLines,
    "",
    "Recent decisions:",
    ...decisionLines,
  ];

  if (guardrailMemories.length > 0) {
    lines.push("", "Active guardrails:", ...guardrailLines);
  }

  if (formattedMessages.length > 0) {
    lines.push("", "## Recent conversation", ...formattedMessages);
  }

  lines.push(
    "",
    `${openGoals.length + recentDecisions.length + guardrailMemories.length} memories surfaced | Use crystal_recall to search all memories.`
  );

  return [...bootstrapInstructions, ...lines].join("\n");
};

export const getWakePrompt = action({
  args: wakeInput,
  handler: async (ctx, args) => {
    const now = nowMs();
    const requestedLimit = Math.min(Math.max(Math.floor(args.limit ?? 8), 1), 20);
    const channel = args.channel?.trim() || undefined;
    const candidateLimit = Math.max(requestedLimit * 5, 100);

    const activeMemories = (await ctx.runQuery("crystal/sessions:getActiveMemories" as any, {
      channel,
      limit: candidateLimit,
    })) as WakeMemory[];

    const openGoals = activeMemories
      .filter((memory: WakeMemory) => memory.store === "prospective" || memory.category === "goal")
      .sort((a, b) => b.strength - a.strength)
      .slice(0, requestedLimit)
      .map((memory) => toWakeMemory(memory));

    const recentDecisions = activeMemories
      .filter((memory: WakeMemory) => memory.category === "decision")
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, requestedLimit)
      .map((memory) => toWakeMemory(memory));

    // Guardrail memories: top lessons + rules by salience/strength
    const guardrailMemories = activeMemories
      .filter(
        (m: WakeMemory) =>
          m.category === "lesson" ||
          m.category === "rule"
      )
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5)
      .map((memory) => toWakeMemory(memory));

    const recentMessages = await ctx.runQuery(
      "crystal/messages:getRecentMessages" as any,
      { limit: 20, channel, sinceMs: now - 24 * 60 * 60 * 1000 }
    );

    // Fetch last session summary for continuity
    const lastSession = await ctx.runQuery("crystal/sessions:getLastSession" as any, {
      channel,
    }) as { summary?: string; lastActiveAt?: number; messageCount?: number } | null;

    const wakePrompt = composeBriefing(
      channel,
      openGoals,
      recentDecisions,
      guardrailMemories,
      recentMessages,
      lastSession
    );
    const injectedMemoryIds = [...openGoals, ...recentDecisions, ...guardrailMemories].map(
      (memory) => memory.memoryId
    );
    const sessionId = await ctx.runMutation("crystal/sessions:createSession" as any, {
      channel: channel ?? "unknown",
      startedAt: now,
      lastActiveAt: now,
      messageCount: 0,
      memoryCount: activeMemories.length,
      summary: buildStoredSessionSummary(
        (recentMessages ?? []).map((message: { role: "user" | "assistant" | "system"; content: string; timestamp: number }) => formatRecentMessage(message))
      ),
      participants: [],
    });

    const wakeStateId = await ctx.runMutation("crystal/sessions:createWakeState" as any, {
      sessionId,
      injectedMemoryIds,
      wakePrompt,
      createdAt: now,
    });

    return {
      wakeStateId,
      briefing: wakePrompt,
      openGoals,
      recentDecisions,
      guardrailMemories,
      recentMessages,
    };
  },
});
