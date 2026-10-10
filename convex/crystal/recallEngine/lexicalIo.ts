import { unseenIds } from "./memoryPolicy";
import type { RecallRuntime } from "./types";
import { logError } from "../crypto";

type TextHit = { _id: string };

export function textHitIds(results: TextHit[]): string[] {
  return [...new Set(results.map((result) => String(result._id)).filter(Boolean))];
}

/**
 * Hydrate the memory documents behind text hits. Successful results are remembered per distinct id set for the
 * request, so the early-return probe and the lexical merge pass read each document once. A failed hydration is
 * not remembered: the merge pass retries it, as it did before the probe existed.
 */
export async function hydrateTextDocs(state: RecallRuntime, ids: string[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const memoKey = ids.slice().sort().join(",");
  state.textHydrationMemo ??= new Map();
  const cached = state.agentLayer ? undefined : state.textHydrationMemo.get(memoKey);
  if (cached) return cached;
  let failed = false;
  const docs = await state.ports.hydrate({ memoryIds: ids }).catch(async (err: unknown) => {
    console.error("[recall] text hydration failed:", await logError(err, state.ports.userId));
    failed = true;
    return [];
  });
  if (!failed && !state.agentLayer) state.textHydrationMemo.set(memoKey, docs);
  return docs;
}

/**
 * Collect the ids of memories saved in another session (scopeToSession requests). The port is asked only about ids
 * not yet answered for this request, so a second pass over the same documents makes no second query.
 */
export async function blockForeignSessions(
  state: RecallRuntime,
  sources: any[],
  seen: Set<string>,
  blocked: Set<string>,
): Promise<void> {
  if (!state.request.scopeToSession) return;
  const memoryIds = unseenIds(sources.map((memory) => String(memory?._id ?? "")), seen);
  if (memoryIds.length === 0) return;
  const answers = state.agentLayer ? new Map<string, boolean>() : (state.crossSessionMemo ??= new Map<string, boolean>());
  const fresh = memoryIds.filter((id) => !answers.has(id));
  if (fresh.length > 0) {
    const foreign = new Set((await state.ports.crossSessionIds({ memoryIds: fresh, sessionKey: state.request.sessionKey as string })).map(String));
    for (const id of fresh) answers.set(id, foreign.has(id));
  }
  for (const id of memoryIds) if (answers.get(id)) blocked.add(id);
}
