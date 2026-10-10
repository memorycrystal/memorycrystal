import { classifyChannel, loadWorkChannelAllowlist } from "../channelClassifier";
import { lexicalMessageScore, unwrapQuotedSearchQuery } from "../messages";
import { applyCrossPersonFilter } from "../recallCoverage";
import { matchProjectIdentity, type ProjectIdentity } from "../projectIdentity";
import { isNonConversationalMessage, isOwnPromptEcho, scoreRecallMessage } from "./messagePolicy";
import type { RecallRuntime } from "./types";

export const MESSAGE_SCAN_PAGE = 200;
/**
 * Budgets are counted per lane and in VISIBLE rows. A budget counted in raw rows
 * would make every count and every truncation depend on how many rows the caller
 * may not see (a membership and volume oracle, found by the ILL-311 audits).
 * The raw cap below is only a read-cost bound: the margin between the two is the
 * invisible volume a lane absorbs before its outputs can change (500 by default,
 * at least 100 when project-scoped).
 */
export const LANE_VISIBLE_CAP = 1000;     // distinct visible rows examined per lane
export const LANE_RAW_SAFETY_CAP = 1500;  // raw rows read per lane; never exported, logged or stored
export const LANE_CALL_CAP = Math.ceil(LANE_RAW_SAFETY_CAP / MESSAGE_SCAN_PAGE) + 2;
export const MESSAGE_SCAN_CAP = LANE_VISIBLE_CAP; // the reported `cap`
export const PROJECT_LANE_VISIBLE_CAP = 100;
export const PROJECT_LANE_RAW_SAFETY_CAP = 200; // raw rows read per project-scoped lane; never exported, logged or stored
export const PROJECT_LANE_MIN_MARGIN = PROJECT_LANE_RAW_SAFETY_CAP - PROJECT_LANE_VISIBLE_CAP;
export const PROJECT_MESSAGE_SCAN_PAGE = 100;
export const PROJECT_LANE_CALL_CAP = Math.ceil(PROJECT_LANE_RAW_SAFETY_CAP / PROJECT_MESSAGE_SCAN_PAGE) + 2;
export type MessagePage = { page: any[]; continueCursor: string; isDone: boolean };
/**
 * `cap` is the per-lane visible budget (1,000 unscoped, 100 by default when project-scoped; the raw margin is 500 by default and
 * at least 100 when project-scoped). `examined` is present only when the scan finished: then it is the number of distinct visible
 * rows in the whole window (both lanes), which can exceed `cap` because each lane has its own budget.
 */
export type MessageScan = { examined?: number; cap: number; exhausted: boolean };

type LaneBudget = { visible: number; raw: number; page: number; calls: number };
const DEFAULT_LANE_BUDGET: LaneBudget = { visible: LANE_VISIBLE_CAP, raw: LANE_RAW_SAFETY_CAP, page: MESSAGE_SCAN_PAGE, calls: LANE_CALL_CAP };
/** Trimmed decimal positive integers only; clamp before using the value as a read budget. */
function projectCap(value: string | undefined, minimum: number, maximum: number): number {
  const raw = value?.trim() ?? "";
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) return minimum;
  return Math.min(maximum, Math.max(minimum, Number(raw)));
}

function projectLaneBudget(): LaneBudget {
  const raw = projectCap(process.env.RECALL_PROJECT_LANE_RAW_CAP, PROJECT_LANE_RAW_SAFETY_CAP, LANE_RAW_SAFETY_CAP);
  // Preserve the default invisible-row privacy margin even when operators raise both caps.
  const visible = Math.min(raw - PROJECT_LANE_MIN_MARGIN, projectCap(process.env.RECALL_PROJECT_LANE_VISIBLE_CAP, PROJECT_LANE_VISIBLE_CAP, LANE_VISIBLE_CAP));
  return { visible, raw, page: PROJECT_MESSAGE_SCAN_PAGE, calls: Math.ceil(raw / PROJECT_MESSAGE_SCAN_PAGE) + 2 };
}

/** `messageProject`, or the request when that is absent, if it has a projectId or repoSlug. No normalization. */
function scopedProject(request: RecallRuntime["request"]) {
  const project = request.messageProject ?? request;
  return project.projectId || project.repoSlug ? project : undefined;
}

function laneBudget(request: RecallRuntime["request"]): LaneBudget {
  return scopedProject(request) ? projectLaneBudget() : DEFAULT_LANE_BUDGET;
}

function projectMetadata(message: any): ProjectIdentity {
  try {
    const metadata = typeof message.metadata === "string" ? JSON.parse(message.metadata) : message.metadata;
    return { projectId: typeof metadata?.projectId === "string" ? metadata.projectId : undefined,
      repoSlug: typeof metadata?.repoSlug === "string" ? metadata.repoSlug : undefined };
  } catch { return {}; }
}

/** The sole visibility decision; all row-derived response state is downstream. */
export function isVisibleToRequest(row: any, request: { channel?: string; sessionKey?: string }, allowlist: readonly string[]): boolean {
  if (row.hidden === true) return false; // a stub for a row whose identifiers were too long to return
  if (request.channel && row.channel !== request.channel) return false;
  if (request.sessionKey && row.sessionKey !== request.sessionKey) return false;
  return Boolean(request.channel || request.sessionKey) || classifyChannel(row.channel, allowlist) !== "private";
}

type Lane = { lane: "text" | "recent"; cursor: string | null; done: boolean; failed: boolean; bound: boolean;
  ran: boolean; raw: number; visible: number; calls: number };

async function scanMessagePage(state: RecallRuntime, lane: Lane, pageSize: number, textAllowed: boolean) {
  const { request, ports } = state;
  const args = { query: request.query, limit: pageSize, channel: request.channel,
    sessionKey: request.sessionKey, sinceMs: request.recallSinceMs, beforeMs: request.recallBeforeMs,
    textAllowed, messageLaneOutcome: state.messageLaneOutcome };
  const result = ports.searchMessagePage
    ? await ports.searchMessagePage({ ...args, lane: lane.lane, cursor: lane.cursor, pageSize })
    : { page: await ports.searchMessages(args), isDone: true, continueCursor: "" };
  return result;
}

async function eligibleMessage(state: RecallRuntime, message: any, id: string, score: number) {
  const { request } = state;
  if (request.recallSinceMs !== undefined && message.timestamp < request.recallSinceMs) return;
  if (request.recallBeforeMs !== undefined && message.timestamp > request.recallBeforeMs) return;
  let projectMatch: "projectId" | "repoSlug" | undefined;
  const project = scopedProject(request);
  if (project) {
    const candidate = projectMetadata(message);
    if (!candidate.projectId && !candidate.repoSlug) {
      if (!request.channel || message.channel !== request.channel) return;
    } else {
      const match = await matchProjectIdentity(project, candidate);
      if (!match.matches) return;
      projectMatch = match.projectMatch;
    }
  }
  if (isNonConversationalMessage(message.role, message.content)) return;
  if (isOwnPromptEcho(message, request, state.startedAt)) return;
  const signals = scoreRecallMessage(request.query, message.content, request.recallIntent);
  if (!signals) return;
  const { metadata: _metadata, ...publicMessage } = message;
  const enriched = { ...publicMessage, messageId: id, score, ...signals };
  const { filtered, suppressedCount } = applyCrossPersonFilter([enriched], {
    recallIntent: request.recallIntent, query: request.query,
    accountHolderName: state.accountHolderName, knownPersonNames: state.knownPersonNames,
  });
  // Only visible, otherwise-eligible, distinct rows reach cross-person accounting.
  state.diagnostics.suppressions.crossPerson += suppressedCount;
  if (!filtered.length) return;
  if (projectMatch) state.diagnostics.scope.projectMatch = projectMatch;
  return enriched;
}

function rankMessages(rows: any[], request: RecallRuntime["request"], allowlist: readonly string[], limit: number) {
  // A channel- or session-scoped request sees one scope only, so only an unscoped request ranks by class.
  const scopeAdjustment = (message: any) =>
    !request.channel && !request.sessionKey && classifyChannel(message.channel, allowlist) === "global" ? 0.005 : 0;
  return rows.sort((a, b) => (b.relevance + scopeAdjustment(b)) - (a.relevance + scopeAdjustment(a)) ||
    b.timestamp - a.timestamp).slice(0, limit);
}

function failMessageLane(state: RecallRuntime, lane: Lane) {
  lane.failed = true;
  lane.done = true;
  console.error("message_page_failed", lane.lane);
  state.degradation.mark({ code: "message_page_failed", message: "Message search returned partial evidence.",
    recoverable: true, affectedStage: "messages", reason: `message_${lane.lane}_page_failed`, surface: "messages" });
}

type Scan = { allowlist: readonly string[]; seen: Set<string>; eligible: Map<string, any>; probeLimit: number; budget: LaneBudget; rowFailed?: boolean };
const probeSatisfied = (scan: Scan) => scan.eligible.size >= scan.probeLimit;

/** One bounded page read for a lane. Raw counters stay internal; returns undefined when the lane failed. */
async function readLanePage(state: RecallRuntime, lane: Lane, textAllowed: boolean, budget: LaneBudget): Promise<any[] | undefined> {
  lane.calls += 1;
  let result;
  try {
    result = await scanMessagePage(state, lane, Math.min(budget.page, budget.raw - lane.raw), textAllowed);
    if (!Array.isArray(result?.page)) throw new Error("message_page_shape");
  } catch {
    state.messageScan = { cap: budget.visible, exhausted: false };
    failMessageLane(state, lane);
    lane.ran = true;
    return undefined;
  }
  lane.ran = !(lane.lane === "text" && state.messageLaneOutcome.bm25SkippedForBudget);
  if (!result.isDone && (!result.page.length || !result.continueCursor || result.continueCursor === lane.cursor)) {
    failMessageLane(state, lane);
  }
  lane.cursor = result.continueCursor;
  lane.done = lane.done || result.isDone;
  lane.raw += result.page.length;
  return result.page;
}

/** A row the visibility decision cannot evaluate (not an object, unclassifiable) is invisible: nothing downstream may depend on it. */
function canSee(message: any, state: RecallRuntime, scan: Scan) {
  try { return isVisibleToRequest(message, state.request, scan.allowlist); } catch { return false; }
}

/** One row: visibility first, then scoring and eligibility; an invisible row never reaches any counter or filter. */
async function examineRow(state: RecallRuntime, lane: Lane, message: any, scan: Scan) {
  if (!canSee(message, state, scan)) return;
  const score = lane.lane === "text" && message.score !== undefined ? message.score
    : lexicalMessageScore(unwrapQuotedSearchQuery(state.request.query), message.content);
  const id = String(message.messageId ?? message._id);
  if (scan.seen.has(id)) {
    const prior = scan.eligible.get(id);
    if (prior) prior.score = Math.max(prior.score, score);
    return;
  }
  scan.seen.add(id);
  lane.visible += 1;
  const enriched = await eligibleMessage(state, message, id, score);
  if (enriched) scan.eligible.set(id, enriched);
}

/**
 * Examine one page in order. A malformed row is skipped, never aborting the recall; the first one marks a recoverable
 * degradation on the messages stage and is logged once per recall (a fixed code, no row data).
 */
async function examineRows(state: RecallRuntime, lane: Lane, rows: any[], scan: Scan) {
  for (const message of rows) {
    // Stop mid-page: the visible rows examined are then a prefix of the visible sequence,
    // independent of page boundaries and of interleaved invisible rows.
    if (probeSatisfied(scan)) break;
    try {
      await examineRow(state, lane, message, scan);
    } catch {
      if (!scan.rowFailed) {
        scan.rowFailed = true;
        console.error("message_row_failed");
        state.degradation.mark({ code: "message_row_failed", message: "Message search skipped a malformed row.",
          recoverable: true, affectedStage: "messages", reason: "message_row_failed", surface: "messages" });
      }
    }
    if (lane.visible >= scan.budget.visible) break;
  }
}

/** The reported scan: `examined` only for a finished scan (no invisible row can change it). */
function finishScan(state: RecallRuntime, lanes: Lane[], scan: Scan) {
  // Guarantee: for a caller that can only add rows it can see, no output below depends on rows it may not see (the page
  // queries return bounded projections, so a page's size cannot carry them either).
  // Known limitations, for a caller that can also write rows that are invisible to its own requests, or very large documents:
  // (1) when the invisible rows in a lane's scanned prefix exceed the margin (500 unscoped, at least 100 when project-scoped)
  // before the visible cap is reached, the lane is bound, `exhausted` is false and the visible window is truncated; that
  // reveals an aggregate count of rows the caller may not see (in the text lane, rows matching its own query term), and
  // rows written to be invisible to its own requests lower the margin; (2) Convex's 16 MiB per-query READ limit still
  // applies to every page, so stored document size can steer a page failure (pre-existing at base; write-side caps are
  // tracked in ILL-388).
  const exhausted = !probeSatisfied(scan) && lanes.every(l => l.ran && l.done && !l.failed && !l.bound);
  const result: MessageScan = { cap: scan.budget.visible, exhausted };
  if (exhausted) result.examined = scan.seen.size;
  if (lanes.some(l => l.ran)) state.messageScan = result;
  state.messageMatchesAvailable = Math.min(scan.eligible.size, scan.probeLimit);
}

/** Runs in the action: each page is a separate, bounded query transaction. */
export async function collectRecallMessages(state: RecallRuntime, textAllowed: boolean): Promise<any[]> {
  const limit = state.request.messageLimit ?? 3;
  if (limit === 0 || state.request.includeMessages === false || state.request.hasKnowledgeBaseScope) return [];
  // Chosen once from the request, before any row is read. Both sub-lanes share it.
  const scan: Scan = { allowlist: loadWorkChannelAllowlist(), seen: new Set(), eligible: new Map(), probeLimit: limit + 1,
    budget: laneBudget(state.request) };
  // Per-lane counters. `raw` is internal only: never returned, logged, stored or put in diagnostics.
  const lanes: Lane[] = ["text", "recent"].map(lane => ({
    lane: lane as Lane["lane"], cursor: null, done: false, failed: false,
    bound: false, ran: false, raw: 0, visible: 0, calls: 0 }));
  if (!state.ports.searchMessagePage) lanes.pop();
  // Lanes run one after the other, the text index first (all-term matches in relevance order), then the recent
  // window (partial matches): the order in which visible rows are examined then follows each lane's visible
  // sequence only. Alternating raw pages would let invisible rows decide which lane sees a row first.
  for (const lane of lanes) {
    while (!lane.done && !probeSatisfied(scan)) {
      const rows = await readLanePage(state, lane, textAllowed, scan.budget);
      if (rows) await examineRows(state, lane, rows, scan);
      // Reaching the visible cap binds the lane whether or not that page was the last one: the page's isDone flag
      // is decided by invisible rows (they set the page boundary), so it must not decide this outcome.
      if (lane.visible >= scan.budget.visible || (!lane.done && (lane.raw >= scan.budget.raw || lane.calls >= scan.budget.calls))) {
        lane.bound = true;
        lane.done = true;
      }
    }
  }
  finishScan(state, lanes, scan);
  return rankMessages([...scan.eligible.values()], state.request, scan.allowlist, limit);
}
