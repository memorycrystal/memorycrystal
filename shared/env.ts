/**
 * Shared environment variable resolution.
 *
 * CRYSTAL_API_KEY is the single user-facing env var.
 * Falls back to GEMINI_API_KEY for backward compatibility.
 */

export function resolveGeminiApiKey(): string | undefined {
  return process.env.CRYSTAL_API_KEY ?? process.env.GEMINI_API_KEY;
}
