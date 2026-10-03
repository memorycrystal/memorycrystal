// crystal-utils.js — Shared helpers for the crystal-memory plugin (CommonJS)
// Extracted from index.js to keep it under 500 lines.

"use strict";

function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function trimSnippet(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

function extractTextFromUnknown(value, depth = 0) {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((i) => extractTextFromUnknown(i, depth + 1)).filter(Boolean).join("\n").trim();
  }
  if (typeof value === "object") {
    const direct = firstString(
      value.text, value.content, value.outputText, value.inputText,
      value.prompt, value.completion, value.responseText, value.message, value.delta
    );
    if (direct) return direct;
    for (const key of ["message","messages","parts","content","input","output","response","result","data","choices","delta"]) {
      const t = extractTextFromUnknown(value[key], depth + 1);
      if (t) return t;
    }
  }
  return "";
}

function extractUserText(event) {
  const direct = firstString(
    event?.context?.content, event?.content, event?.text,
    event?.message?.content, event?.message?.text, event?.input, event?.prompt
  );
  if (direct) return direct;
  for (const c of [event?.context, event?.message, event?.input, event?.prompt, event?.payload, event?.data, event]) {
    const t = extractTextFromUnknown(c);
    if (t) return t;
  }
  return "";
}

function joinStringArray(values) {
  if (!Array.isArray(values)) return "";
  return values.filter((v) => typeof v === "string" && v.trim().length > 0).join("\n").trim();
}

function extractAssistantText(event) {
  const direct = firstString(
    joinStringArray(event?.assistantTexts), joinStringArray(event?.texts),
    joinStringArray(event?.outputs), event?.lastAssistant, event?.outputText,
    event?.content, event?.text, event?.message?.content, event?.message?.text,
    event?.response?.content, event?.response?.text,
    event?.result?.content, event?.result?.text
  );
  if (direct) return direct;
  for (const c of [event?.response, event?.result, event?.output, event?.assistant, event?.message, event?.messages, event?.parts, event]) {
    const t = extractTextFromUnknown(c);
    if (t) return t;
  }
  return "";
}

function parseSessionDescriptor(sessionKey) {
  const raw = typeof sessionKey === "string" ? sessionKey : "";
  const m = raw.match(/^agent:[^:]+:([^:]+):([^:]+):(.+)$/);
  if (!m) return null;
  return { provider: m[1], scope: m[2], target: m[3] };
}

function normalizeSessionKey(sessionKey, conversationId) {
  const rawSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const rawConversationId = typeof conversationId === "string" ? conversationId.trim() : "";
  if (rawSessionKey.startsWith("telegram:")) return rawSessionKey;
  if (rawConversationId.startsWith("telegram:")) {
    const parsed = parseSessionDescriptor(rawSessionKey);
    if (!rawSessionKey || (parsed?.provider === "telegram" && parsed?.scope === "direct")) {
      return rawConversationId;
    }
  }
  const parsed = parseSessionDescriptor(rawSessionKey);
  if (parsed?.provider === "telegram" && parsed?.scope === "direct" && parsed?.target) {
    return `telegram:${parsed.target}`;
  }
  return rawSessionKey || rawConversationId;
}

function getPeerId(ctx, event) {
  const meta = event?.metadata || {};
  const telegram = firstString(
    meta?.from?.id && String(meta.from.id),
    event?.context?.from?.id && String(event.context.from.id),
    ctx?.peerId,
    event?.peerId,
    event?.senderId,
    ctx?.senderId,
    event?.context?.sender_id && String(event.context.sender_id),
    meta?.senderId && String(meta.senderId)
  );
  if (telegram) return telegram;

  const discord = firstString(
    meta?.authorId && String(meta.authorId),
    event?.context?.authorId && String(event?.context?.authorId),
    event?.authorId && String(event?.authorId),
    ctx?.authorId && String(ctx?.authorId)
  );
  if (discord) return discord;

  const sessionKey = ctx?.sessionKey || ctx?.sessionId || event?.sessionKey || event?.sessionId || "";
  if (sessionKey) {
    const parts = sessionKey.split(":");
    return parts[parts.length - 1] || sessionKey;
  }

  return "default";
}

function getChannelKey(ctx, event, channelScope) {
  if (channelScope) {
    const peerId = getPeerId(ctx, event);
    return `${channelScope}:${peerId}`;
  }

  const sessionKey = ctx?.sessionKey || ctx?.sessionId || event?.sessionKey || event?.conversationId || event?.sessionId || "";
  const sessionInfo = parseSessionDescriptor(sessionKey);
  const provider = firstString(event?.messageProvider, ctx?.messageProvider, event?.provider, ctx?.provider, sessionInfo?.provider, "openclaw");
  const meta = event?.metadata || {};
  const chatId = firstString(ctx?.conversationId, ctx?.channelId, event?.context?.chat_id, event?.context?.chatId, event?.chat_id, event?.chatId, event?.conversationId, meta?.conversationId);
  const chatIdChannel = typeof chatId === "string" && chatId.startsWith("channel:") ? chatId.split(":")[1] : "";
  const sessionChannel = sessionInfo?.scope === "channel" ? sessionInfo.target : "";
  const workspaceId = firstString(meta?.guildId, event?.context?.workspaceId, event?.workspaceId, ctx?.workspaceId, event?.context?.groupSpace, event?.groupSpace);
  const guildId = firstString(meta?.guildId, event?.context?.guildId, event?.guildId, ctx?.guildId);
  const channelId = firstString(ctx?.channelId, chatIdChannel, sessionChannel, event?.context?.channelId, event?.channelId, meta?.channelId);
  const threadId = firstString(meta?.threadId, event?.context?.threadId, event?.threadId, ctx?.threadId, event?.context?.thread_id, event?.thread_id);
  const parts = [provider, workspaceId, guildId, channelId, threadId].filter(Boolean);
  if (parts.length > 1) return parts.join(":");
  if (provider && chatId) return `${provider}:${chatId}`;
  if (chatId) return chatId;
  return provider;
}

function shouldCapture(userMessage, assistantText) {
  const text = (assistantText || "").trim();
  const userMsg = (userMessage || "").trim();
  if (/HEARTBEAT|heartbeat poll/i.test(userMsg)) return false;
  if (text.length < 20) return false;
  if (/^HEARTBEAT_OK$/i.test(text)) return false;
  if (/^(NO_REPLY|ok|sure|got it|okay|yep|yeah|nope|nah|thanks|thank you)[!.,\s]*$/i.test(text)) return false;
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)[!.,\s]*$/i.test(text)) return false;
  if (text.length < 100 && /^(I don't have|I cannot|I'm not able to)/i.test(text)) return false;
  return true;
}

function isCronOrIsolated(ctx, event) {
  const sessionKey = ctx?.sessionKey || ctx?.sessionId || event?.sessionKey || event?.sessionId || "";
  return Boolean(
    sessionKey && (
      sessionKey.includes(":cron:") ||
      ctx?.sessionTarget === "isolated" ||
      event?.sessionTarget === "isolated"
    )
  );
}

function normalizeContextEngineMessage(message, fallbackRole = "user") {
  if (!message || typeof message !== "object") return null;
  const role = firstString(message.role, message.type, fallbackRole) || fallbackRole;
  const content = extractTextFromUnknown(message.content ?? message.text ?? message.message ?? message);
  if (!content) return null;
  return { role, content };
}

/**
 * Ensure message content is in the structured array format that OpenClaw's
 * context engine expects (compatible with `.flatMap()` calls).
 * String content → [{ type: "text", text }]; arrays pass through as-is.
 */
function toContentParts(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content != null && typeof content === "object" && typeof content.text === "string") return [content];
  return [{ type: "text", text: String(content ?? "") }];
}

module.exports = {
  firstString,
  trimSnippet,
  extractTextFromUnknown,
  extractUserText,
  extractAssistantText,
  normalizeSessionKey,
  getPeerId,
  getChannelKey,
  shouldCapture,
  isCronOrIsolated,
  normalizeContextEngineMessage,
  toContentParts,
};
