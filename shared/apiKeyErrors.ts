import { ConvexError } from "convex/values";

export const API_KEY_LIMIT_MESSAGE = "Too many active API keys; revoke unused keys in the dashboard";

export function apiKeyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConvexError && error.data?.code === "api_key_limit") return API_KEY_LIMIT_MESSAGE;
  return error instanceof Error ? error.message : fallback;
}
