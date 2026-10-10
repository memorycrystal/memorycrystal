import { internalQuery, query } from "../_generated/server";
import { v } from "convex/values";
import { stableUserId } from "./auth";
import {
  resolveCapacityPolicy,
  type CapacityPolicy,
} from "../../shared/capacityPolicy";

export async function getCapacityPolicyForUser(
  ctx: { db: any },
  userId: string,
): Promise<CapacityPolicy> {
  const profiles = await ctx.db
    .query("crystalUserProfiles")
    .withIndex("by_user", (q: any) => q.eq("userId", userId))
    .take(100);
  const profile = profiles.sort(
    (a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  )[0];
  let backend = process.env.CRYSTAL_BACKEND;
  if (!profile && backend === "local") {
    const localInstallerKey = (await ctx.db
      .query("crystalApiKeys")
      .withIndex("by_user", (q: any) => q.eq("userId", userId))
      .take(100))
      .some((key: any) => key.active === true && key.label === "local installer");
    if (!localInstallerKey) backend = undefined;
  }
  return resolveCapacityPolicy(profile, { backend });
}

export const getForUser = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => getCapacityPolicyForUser(ctx, userId),
});

export const getCurrent = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return getCapacityPolicyForUser(ctx, stableUserId(identity.subject));
  },
});
