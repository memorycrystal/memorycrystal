export const normalizeContentForHash = (value: string): string =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n /g, "\n")
    .replace(/ \n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const buildMessageHashInput = (args: {
  role: "user" | "assistant" | "system";
  content: string;
}): string => `${args.role}\n${normalizeContentForHash(args.content).toLowerCase()}`;

export const buildMessageDedupeScopeInput = (args: {
  userId: string;
  role: "user" | "assistant" | "system";
  contentHash: string;
  channel?: string;
  sessionKey?: string;
  turnId?: string;
  turnMessageIndex?: number;
}): string => {
  const turnScope = args.turnId
    ? `turn:${args.turnId}:${args.turnMessageIndex ?? -1}`
    : args.sessionKey && args.turnMessageIndex !== undefined
      ? `session-turn:${args.turnMessageIndex}`
      : "near-time";

  return [
    args.userId,
    args.role,
    args.contentHash,
    args.channel ?? "",
    args.sessionKey ?? "",
    turnScope,
  ].join("\u001f");
};

export const normalizeMemoryContentForHash = (value: string): string =>
  normalizeContentForHash(value).toLowerCase();

export const buildMemoryHashInput = (args: {
  store: string;
  category: string;
  content: string;
}): string => `${args.store}\n${args.category}\n${normalizeMemoryContentForHash(args.content)}`;
