import { v } from "convex/values";
import { query } from "../_generated/server";

// Returns which sign-in methods are available for an email.
// Intentionally vague to minimize enumeration risk:
// - Does NOT confirm whether an account exists
// - Only returns provider hints AFTER a failed sign-in attempt
// Rate limited by Convex's built-in query limits.
export const getAuthMethodsForEmail = query({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const normalizedEmail = email.trim().toLowerCase();

    const users = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), normalizedEmail))
      .collect();

    if (users.length === 0) {
      return { providers: [] as string[] };
    }

    const providers: string[] = [];
    for (const user of users) {
      const accounts = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
        .collect();

      for (const account of accounts) {
        if (!providers.includes(account.provider)) {
          providers.push(account.provider);
        }
      }
    }

    return { providers };
  },
});
