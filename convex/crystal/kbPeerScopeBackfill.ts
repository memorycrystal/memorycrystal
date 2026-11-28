import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalMutation } from "../_generated/server";
import { PEER_CAPABLE_SCOPES, deriveAgentIdPrefix } from "./knowledgeBases";
import { metric } from "./metrics";

const selfRef = makeFunctionReference<"mutation">("crystal/kbPeerScopeBackfill:kbPeerScopeBackfill");

// Backfills `peerScopePolicy` on `knowledgeBases` rows.
//
// Rule (must NOT darken existing tenants):
//   - Skip KBs that already have `peerScopePolicy` set.
//   - If the KB has no peer-capable agentId prefix → skip (not relevant).
//   - If scope is a bare numeric string (/^\d+$/) → the KB is already
//     explicitly scoped to one peer; leave peerScopePolicy undefined (strict
//     default is correct and the KB will be visible only to that exact peer).
//   - Otherwise (scope is empty or non-numeric) → this is a legacy shared/
//     unscoped KB; set peerScopePolicy="permissive" to preserve existing
//     behaviour. The operator can tighten this manually after review.
//
// Pagination: 100-per-batch, scheduler-chained.
// Observability: emits mc.metric.kb-backfill-progress after each batch.
export const kbPeerScopeBackfill = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    const page = await ctx.db
      .query("knowledgeBases")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let flagged = 0;
    let scoped = 0;

    for (const kb of page.page) {
      // Skip KBs that already have an explicit policy — never overwrite.
      if (kb.peerScopePolicy !== undefined) continue;

      const prefix = deriveAgentIdPrefix(kb.agentIds);
      if (!prefix || !PEER_CAPABLE_SCOPES.has(prefix)) continue;

      const kbScope = kb.scope?.trim() ?? "";

      if (kbScope && /^\d+$/.test(kbScope)) {
        // Already scoped to a single numeric peer — strict default is fine.
        scoped++;
      } else {
        // Legacy unscoped or non-numeric scope: preserve access by opting in
        // to permissive. Operator must review and tighten explicitly.
        await ctx.db.patch(kb._id, { peerScopePolicy: "permissive" });
        flagged++;
      }
    }

    metric("mc.metric.kb-backfill-progress", {
      flagged,
      scoped,
      isDone: page.isDone ? 1 : 0,
    });

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        100,
        selfRef,
        { cursor: page.continueCursor, batchSize },
      );
    }

    return { flagged, scoped, isDone: page.isDone };
  },
});
