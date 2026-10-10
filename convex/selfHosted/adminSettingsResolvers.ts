export type ProviderKey = "gemini" | "openai" | "anthropic" | "openrouter";
const PROVIDER_ENV: Record<ProviderKey, string> = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY" };
export async function resolveOpenRouterAdminOverride(_ctx: any): Promise<string | null> { return process.env.OPENROUTER_API_KEY?.trim() || null; }
export async function resolveOpenRouterApiKey(_ctx: any, args: { userId?: string; includeShared: boolean }): Promise<string | null> { return args.includeShared ? process.env.OPENROUTER_API_KEY?.trim() || null : null; }
export async function resolveProviderApiKey(_ctx: any, provider: ProviderKey): Promise<string | null> { return process.env[PROVIDER_ENV[provider]]?.trim() || null; }
