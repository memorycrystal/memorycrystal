/**
 * DEPRECATED / LEGACY
 * -------------------
 * This file is a legacy duplicate of capture logic now consolidated into `index.js`.
 * It was previously used by handler.js (via child_process.spawnSync) and as a
 * standalone hook in older OpenClaw configurations.
 *
 * Canonical capture logic now lives in: `index.js`
 * Do NOT delete — may be referenced by legacy configurations or handler.js.
 *
 * Crystal Capture plugin — captures conversation turns via MCP API
 * Writes to crystalMemories (sensory store) with proper userId via API key auth
 */

const DEFAULT_CONVEX_URL = "https://rightful-mockingbird-389.convex.site";
const pendingUserMessages = new Map();

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "";
}

function joinStringArray(values) {
  if (!Array.isArray(values)) return "";
  return values
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

function extractAssistantText(event) {
  const direct = firstString(
    joinStringArray(event?.assistantTexts),
    joinStringArray(event?.texts),
    joinStringArray(event?.outputs),
    event?.lastAssistant,
    event?.outputText,
    event?.content,
    event?.text,
    event?.message?.content,
    event?.message?.text,
    event?.response?.content,
    event?.response?.text,
    event?.result?.content,
    event?.result?.text
  );

  if (direct) {
    return direct;
  }

  const candidates = [
    event?.response?.messages,
    event?.result?.messages,
    event?.messages,
    event?.response?.parts,
    event?.result?.parts,
    event?.parts,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const text = candidate
      .map((item) =>
        firstString(
          item?.content,
          item?.text,
          item?.message?.content,
          item?.message?.text
        )
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function extractUserText(event) {
  return firstString(
    event?.context?.content,
    event?.content,
    event?.text,
    event?.message?.content,
    event?.message?.text,
    event?.input,
    event?.prompt
  );
}

// Rate-limited stderr reporter so persistent capture failures become visible
// to doctor scripts / operators without spamming. Still fire-and-forget — the
// capture path never blocks the host even when the backend is unreachable.
const __mcCaptureErrorTimestamps = new Map();
function reportCaptureError(detail) {
  const now = Date.now();
  const lastAt = __mcCaptureErrorTimestamps.get(detail) ?? 0;
  if (now - lastAt < 60_000) return;
  __mcCaptureErrorTimestamps.set(detail, now);
  try {
    process.stderr.write(
      `[memory-crystal][capture] ${new Date(now).toISOString()} ${detail}\n`
    );
  } catch {
    // Never throw from the error reporter itself
  }
}

async function captureToMCP(apiKey, convexUrl, payload) {
  try {
    const res = await fetch(`${convexUrl}/api/mcp/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      reportCaptureError(`HTTP ${res.status}`);
    }
    return res.ok;
  } catch (err) {
    reportCaptureError((err && err.message) || String(err));
    return false;
  }
}

module.exports = (api) => {
  // Get API key from config or env
  const getConfig = (ctx) => {
    const apiKey =
      ctx?.config?.apiKey ||
      process.env.CRYSTAL_API_KEY ||
      api.config?.apiKey;
    const convexUrl =
      ctx?.config?.convexUrl ||
      process.env.CRYSTAL_CONVEX_URL ||
      DEFAULT_CONVEX_URL;
    return { apiKey, convexUrl };
  };

  // Capture user message before each turn
  api.on("message_received", (event, ctx) => {
    const text = extractUserText(event);
    if (text && ctx?.sessionKey) {
      pendingUserMessages.set(ctx.sessionKey, String(text));
    }
  });

  // Fire capture after each LLM response
  api.on("llm_output", async (event, ctx) => {
    const assistantText = extractAssistantText(event);
    if (!assistantText) return;

    const { apiKey, convexUrl } = getConfig(ctx);
    if (!apiKey) return;

    const sessionKey = ctx?.sessionKey || "";
    const channel = ctx?.messageProvider || "openclaw";
    const userMessage = sessionKey ? (pendingUserMessages.get(sessionKey) || "") : "";
    if (sessionKey) pendingUserMessages.delete(sessionKey);

    const content = [
      userMessage ? `User: ${userMessage}` : null,
      `Assistant: ${assistantText}`,
    ].filter(Boolean).join("\n\n");

    await captureToMCP(apiKey, convexUrl, {
      title: `Conversation — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      content,
      store: "sensory",
      category: "conversation",
      tags: ["openclaw", "auto-capture", channel],
      channel,
    });
  });

  api.logger?.info?.("[crystal] capture hooks registered (message_received + llm_output)");
};
