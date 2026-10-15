import { stableUserId } from "../crystal/auth";

/** Local-safe actor lookup. No support-console mutations are shipped. */
export async function getActorForQuery(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const actorUserId = stableUserId(identity.subject);
  const actorProfile = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q: any) => q.eq("userId", actorUserId))
    .first();
  return { actorUserId, actorProfile: actorProfile ?? { roles: ["subscriber"] } };
}
