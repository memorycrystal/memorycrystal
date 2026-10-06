/**
 * Memory visibility and project identity for recall (ILL-387).
 * Imports the ILL-311 matcher; it does not reimplement the five-row table.
 * Knowledge-base visibility stays on its own path.
 */
import { classifyChannel, loadWorkChannelAllowlist } from "../channelClassifier";
import { isNonKnowledgeBaseMemoryVisibleInChannel } from "../knowledgeBases";
import { MEMORY_VECTOR_READ_BATCH } from "../memoryVectors";
import {
  matchProjectIdentity,
  type ProjectIdentity,
  type ProjectMatch,
} from "../projectIdentity";
import { normalizeRepoSlug } from "./httpFields";
import { normalizeProjectId, parseJsonObject } from "./sourceRole";

const ENABLED = new Set(["1", "true", "on", "yes"]);

/** One search-index page. A query paginates once; the action loops pages. */
export const MEMORY_TEXT_PAGE_SIZE = 200;
/**
 * Per-index cap. With RECALL_FILTER_REFILL on, each index reads further, up to this many hits, only when the
 * checks applied to the first window before ranking (visibility, project, store,
 * category and tag filters, the cross-session filter, the identifier-conflict
 * exclusion and rows without usable content) removed more than half of its
 * unique ids.
 */
export const MEMORY_TEXT_FILTERED_LIMIT = 256;
/** A hydration set this size or smaller stays one query, as the unfiltered base path did. */
export const MEMORY_HYDRATE_SINGLE_QUERY_MAX = 200;

export function recallWorkChannelVisibilityEnabled(): boolean {
  const raw = process.env.RECALL_WORK_CHANNEL_VISIBILITY?.trim().toLowerCase();
  return raw !== undefined && ENABLED.has(raw);
}

/**
 * Opt-in switch for the optional refills behind filter pressure: the deeper lexical read (up to 256 hits per index) and
 * the 256 vector retry. Off by default. They read two to four times as many documents, and on accounts whose memories
 * carry large inline vectors the first production measurement added several seconds to a recall. The machinery, its
 * guards and its tests stay in place, so it can be switched on, with no redeploy, once the documents are slimmer or the
 * reads are cheaper. Same tokens as the visibility flag: 1, true, on, yes.
 */
export function recallFilterRefillEnabled(): boolean {
  const raw = process.env.RECALL_FILTER_REFILL?.trim().toLowerCase();
  return raw !== undefined && ENABLED.has(raw);
}

/** One sanitized allowlist for the request. Flag off skips the parse. */
export function recallRequestAllowlist(): readonly string[] | undefined {
  return recallWorkChannelVisibilityEnabled() ? loadWorkChannelAllowlist() : undefined;
}

/** Ids not yet recorded in `seen`, in order. Marks each fresh id as seen. */
export function unseenIds(ids: readonly string[], seen: Set<string>): string[] {
  const fresh: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    fresh.push(id);
  }
  return fresh;
}

/**
 * Today's non-KB channel rule, plus the default-off work-channel flag.
 * Private channels never gain visibility from the flag. A true result from
 * today's rule stays true, so the bare prefix/suffix fallback is unchanged.
 */
export function isRecallMemoryVisible(
  memoryChannel: string | undefined,
  requestChannel: string | undefined,
  options: { sameProject?: boolean; allowlist?: readonly string[] } = {},
): boolean {
  if (isNonKnowledgeBaseMemoryVisibleInChannel(memoryChannel, requestChannel)) return true;
  if (!recallWorkChannelVisibilityEnabled()) return false;
  const allowlist = options.allowlist ?? loadWorkChannelAllowlist();
  const memoryClass = classifyChannel(memoryChannel, allowlist);
  const requestClass = classifyChannel(requestChannel, allowlist);
  if (memoryClass === "private" || requestClass === "private") return false;
  if (requestClass === "global") return memoryClass === "work";
  if (requestClass === "work") {
    if (memoryClass === "global") return true;
    if (memoryClass === "work") return options.sameProject === true;
  }
  return false;
}

export type MemoryProjectDecision = {
  include: boolean;
  sameProject: boolean;
  projectMatch?: ProjectMatch;
};

/** Memories with neither project field stay included. A request with neither applies no project scoping. */
export async function decideMemoryProject(
  request: ProjectIdentity,
  candidate: ProjectIdentity,
): Promise<MemoryProjectDecision> {
  const requestId = request.projectId?.trim() || undefined;
  const requestSlug = request.repoSlug?.trim() || undefined;
  if (!requestId && !requestSlug) return { include: true, sameProject: false };
  const candidateId = candidate.projectId?.trim() || undefined;
  const candidateSlug = candidate.repoSlug?.trim() || undefined;
  if (!candidateId && !candidateSlug) return { include: true, sameProject: false };
  const match = await matchProjectIdentity(
    { projectId: requestId, repoSlug: requestSlug },
    { projectId: candidateId, repoSlug: candidateSlug },
  );
  if (!match.matches) return { include: false, sameProject: false };
  return { include: true, sameProject: true, projectMatch: match.projectMatch };
}

export function memoryProjectIdentity(memory: any): ProjectIdentity {
  const metadata = parseJsonObject(memory?.metadata);
  return {
    projectId: normalizeProjectId(memory?.projectId) ?? normalizeProjectId(metadata.projectId),
    repoSlug: normalizeRepoSlug(memory?.repoSlug) ?? normalizeRepoSlug(metadata.repoSlug),
  };
}

/** Raw request identity. Callers must not pass a projectId synthesized from a slug. */
export function requestProjectIdentity(request: {
  messageProject?: ProjectIdentity;
}): ProjectIdentity {
  const raw = request.messageProject;
  if (!raw) return {};
  return {
    projectId: normalizeProjectId(raw.projectId),
    repoSlug: normalizeRepoSlug(raw.repoSlug),
  };
}

/** Attach the flag-on class preference, or leave the candidate unchanged when the override is off. */
export function withRecallScopeAdjustment<T extends {
  channel?: string;
  projectId?: string;
  sameProject?: boolean;
  knowledgeBaseId?: string;
}>(
  candidate: T,
  options: { channel?: string; projectId?: string; allowlist?: readonly string[] },
): T & { scopeAdjustmentOverride?: number } {
  const exactChannel = Boolean(options.channel)
    && String(candidate.channel ?? "").trim().toLowerCase() === String(options.channel).trim().toLowerCase();
  const legacy =
    (options.projectId && candidate.projectId === options.projectId ? 0.005 : 0) +
    (exactChannel ? 0.005 : 0);
  const scopeAdjustmentOverride = recallScopeAdjustmentOverride({
    legacy,
    exactChannel,
    requestChannel: options.channel,
    memoryChannel: candidate.channel,
    sameProject: candidate.sameProject === true,
    knowledgeBaseId: candidate.knowledgeBaseId ? String(candidate.knowledgeBaseId) : undefined,
    allowlist: options.allowlist,
  });
  return scopeAdjustmentOverride === undefined
    ? candidate
    : { ...candidate, scopeAdjustmentOverride };
}

/**
 * Flag-on work-channel ordering. Undefined keeps the ranker's existing
 * scope adjustment. The returned values sit inside the ranker's ±0.05 clamp
 * and stay below a real relevance gap: exact channel, then same-project work,
 * then global, at equal relevance.
 */
export function recallScopeAdjustmentOverride(args: {
  legacy: number;
  exactChannel: boolean;
  requestChannel?: string;
  memoryChannel?: string;
  sameProject: boolean;
  knowledgeBaseId?: string;
  allowlist?: readonly string[];
}): number | undefined {
  if (args.knowledgeBaseId) return undefined;
  if (!recallWorkChannelVisibilityEnabled()) return undefined;
  const allowlist = args.allowlist ?? loadWorkChannelAllowlist();
  if (classifyChannel(args.requestChannel, allowlist) !== "work") return undefined;
  if (args.exactChannel) return args.legacy + 0.004;
  const memoryClass = classifyChannel(args.memoryChannel, allowlist);
  if (memoryClass === "work" && args.sameProject) return 0.006;
  if (memoryClass === "global") return Math.min(args.legacy, 0.004);
  return undefined;
}

function idPages(ids: string[], size: number): string[][] {
  const pages: string[][] = [];
  for (let index = 0; index < ids.length; index += size) pages.push(ids.slice(index, index + size));
  return pages;
}

export async function hydrateRecallMemories(
  runQuery: (queryRef: any, args: any) => Promise<any[]>,
  queryRef: any,
  memoryIds: string[],
): Promise<any[]> {
  if (memoryIds.length === 0) return [];
  const run = (ids: string[]) => runQuery(queryRef, { memoryIds: ids, omitEmbedding: true });
  if (memoryIds.length <= MEMORY_HYDRATE_SINGLE_QUERY_MAX) {
    const page = await run(memoryIds);
    return Array.isArray(page) ? page : [];
  }
  const pages = await Promise.all(idPages(memoryIds, MEMORY_VECTOR_READ_BATCH).map(run));
  return pages.flatMap((page) => Array.isArray(page) ? page : []);
}

/** Cross-session checks at 100 ids per query, concurrently. Callers pass only new ids. */
export async function queryCrossSessionMemoryIds(
  runQuery: (queryRef: any, args: any) => Promise<string[]>,
  queryRef: any,
  args: { userId: string; memoryIds: string[]; sessionKey: string },
): Promise<string[]> {
  const unique = [...new Set(args.memoryIds.filter(Boolean))];
  if (unique.length === 0) return [];
  const pages = await Promise.all(idPages(unique, MEMORY_VECTOR_READ_BATCH).map((memoryIds) =>
    runQuery(queryRef, { userId: args.userId, memoryIds, sessionKey: args.sessionKey })));
  return pages.flatMap((page) => Array.isArray(page) ? page : []);
}

const TEXT_INDEXES = ["title", "content", "recallText"] as const;

/** First-window ids with an action-local continuation; never serialized by a query. */
export type MemoryTextHits = Array<{ _id: string }> & {
  deepen?: () => Promise<Array<{ _id: string }>>;
};

/** Today's index windows, retaining cursors for a single filter-pressure refill. */
export async function collectFilteredMemoryTextHits(
  runQuery: (queryRef: any, args: any) => Promise<{ ids?: string[]; continueCursor?: string; isDone?: boolean }>,
  queryRef: any,
  args: { userId: string; query: string; limit?: number; knowledgeBaseId?: string },
): Promise<MemoryTextHits> {
  const contentLimit = Math.min(args.limit ?? 20, 200);
  const auxiliaryLimit = Math.min(contentLimit, 50);
  const windows = await Promise.all(TEXT_INDEXES.map(async (index) => {
    const firstLimit = index === "content" ? contentLimit : auxiliaryLimit;
    const read = (cursor: string | null, pageSize: number) => runQuery(queryRef, {
      userId: args.userId, query: args.query, index, cursor, pageSize,
      ...(args.knowledgeBaseId ? { knowledgeBaseId: args.knowledgeBaseId } : {}),
    });
    const page = await read(null, firstLimit);
    return { ids: [...(page.ids ?? [])], page, read, full: page.ids?.length === firstLimit };
  }));
  const merged = () => [...new Set(windows.flatMap((window) => window.ids))].map((_id) => ({ _id }));
  const hits: MemoryTextHits = merged();
  if (!recallFilterRefillEnabled()) return hits; // no continuation: the first window is all the lane reads
  let deepened = false;
  hits.deepen = async () => {
    if (deepened) return merged();
    deepened = true;
    for (const window of windows) {
      if (!window.full) continue;
      while (!window.page.isDone && window.page.continueCursor && window.ids.length < MEMORY_TEXT_FILTERED_LIMIT) {
        const cursor = window.page.continueCursor;
        window.page = await window.read(cursor, Math.min(MEMORY_TEXT_PAGE_SIZE, MEMORY_TEXT_FILTERED_LIMIT - window.ids.length));
        const ids = window.page.ids ?? [];
        window.ids.push(...ids);
        if (!ids.length || window.page.continueCursor === cursor) break;
      }
    }
    return merged();
  };
  return hits;
}
