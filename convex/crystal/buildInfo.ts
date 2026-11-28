import { BUILD_INFO } from "./buildInfo.generated";

export type HealthBuildIdentity = {
  commit: string;
  dirty: boolean;
  builtAt: string | null;
  source: "generated" | "unknown";
};

/**
 * Health exposes `generated` only when the deploy script wrote a real commit.
 * The committed placeholder and any incomplete stamp stay `unknown`.
 */
export function healthBuildFromInfo(info: {
  commit?: string | null;
  dirty?: boolean;
  builtAt?: string | null;
  source?: string | null;
} | null | undefined): HealthBuildIdentity {
  const commit = typeof info?.commit === "string" ? info.commit.trim() : "";
  if (info?.source === "generated" && commit && commit !== "unknown") {
    return {
      commit,
      dirty: info.dirty === true,
      builtAt: typeof info.builtAt === "string" ? info.builtAt : null,
      source: "generated",
    };
  }
  return { commit: "unknown", dirty: false, builtAt: null, source: "unknown" };
}

export function currentHealthBuild(): HealthBuildIdentity {
  return healthBuildFromInfo(BUILD_INFO);
}
