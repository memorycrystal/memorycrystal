export type ProviderKey = "gemini" | "openai" | "anthropic" | "openrouter";
export type Tier = "default" | "free" | "starter" | "pro" | "ultra" | "unlimited";

function coerce<T extends string | boolean | number>(raw: string | undefined, fallback: T): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (typeof fallback === "boolean") return (raw.trim() === "true") as T;
  if (typeof fallback === "number") {
    const value = Number(raw);
    return (Number.isFinite(value) ? value : fallback) as T;
  }
  return raw.trim() as T;
}

export async function resolveFeatureFlag<T extends string | boolean | number>(
  _ctx: any,
  _key: string,
  envVarName: string,
  fallback: T,
): Promise<T> {
  return coerce(process.env[envVarName], fallback);
}

export async function resolveGraphModel(_ctx: any, _tier?: Tier): Promise<string> {
  return process.env.MC_GEMINI_GRAPH_MODEL?.trim() || "google/gemini-2.5-flash";
}

export async function resolveOpenRouterAdminOverride(_ctx: any): Promise<string | null> {
  return process.env.OPENROUTER_API_KEY?.trim() || null;
}

export async function resolveOpenRouterApiKey(
  _ctx: any,
  args: { userId?: string; includeShared: boolean },
): Promise<string | null> {
  // Per-user keys are resolved by providerSettings before this fallback is
  // called. This local-safe resolver deliberately has no admin-settings table.
  return args.includeShared ? process.env.OPENROUTER_API_KEY?.trim() || null : null;
}

const PROVIDER_ENV: Record<ProviderKey, string> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export async function resolveProviderApiKey(_ctx: any, provider: ProviderKey): Promise<string | null> {
  return process.env[PROVIDER_ENV[provider]]?.trim() || null;
}

export async function resolveOrganicDefaultPresetKey(
  _ctx: any,
  _tier: Tier,
): Promise<"small" | "medium" | "large"> {
  const value = process.env.MC_ORGANIC_DEFAULT_PRESET;
  return value === "small" || value === "large" ? value : "medium";
}
