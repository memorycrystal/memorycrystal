/**
 * Committed placeholder. `scripts/convex-deploy-self-hosted.mjs` overwrites this
 * file before a deploy and restores these bytes afterwards, so the git tree
 * does not keep a generated SHA.
 */
export const BUILD_INFO = {
  commit: "unknown",
  dirty: false,
  builtAt: null as string | null,
  source: "unknown" as "unknown" | "generated",
};
