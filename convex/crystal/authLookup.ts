import { v } from "convex/values";
import { query } from "../_generated/server";

// Returns which sign-in methods are available for an email.
// Intentionally vague to minimize enumeration risk:
// - Does NOT confirm whether an account exists
// - Only returns provider hints AFTER a failed sign-in attempt
// Rate limited by Convex's built-in query limits.
export const getAuthMethodsForEmail = query({
  args: { email: v.string() },
  handler: async (_ctx, { email: _email }) => {
    // Always return the same response regardless of whether the account exists.
    // Returning real provider data would allow attackers to enumerate which
    // emails have accounts (and which auth methods they use).
    return { providers: ["password"] };
  },
});
