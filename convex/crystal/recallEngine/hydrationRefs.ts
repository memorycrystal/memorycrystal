import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

const ENABLED = new Set(["1", "true", "on", "yes"]);

export function recallHydrationRefsEnabled(): boolean {
  return ENABLED.has(process.env.RECALL_HYDRATION_REFS?.trim().toLowerCase() ?? "");
}

const observers = new Set<(path: "ref" | "fallback") => void>();

/** Test-only observation of actual resolution, inert without a listener. */
export function observeHydrationRefs(observer: (path: "ref" | "fallback") => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export async function uniqueHydrationRef(ctx: QueryCtx, embeddingId: Id<"crystalMemoryEmbeddings">) {
  const refs = await ctx.db.query("crystalMemoryEmbeddingRefs")
    .withIndex("by_embeddingId", (q) => q.eq("embeddingId", embeddingId)).take(2);
  const ref = refs.length === 1 ? refs[0] : null;
  for (const observer of observers) observer(ref ? "ref" : "fallback");
  return ref;
}
