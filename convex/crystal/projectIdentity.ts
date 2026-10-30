import { v } from "convex/values";
import { sha256Hex } from "./crypto";

// Serializable so the same request derivation crosses internal query/action boundaries.
export const projectDerivationValidator = v.object({
  legacyId: v.optional(v.string()),
  hookIds: v.array(v.string()),
});
export type ProjectDerivation = { legacyId?: string; hookIds: string[] };
export type ProjectIdentity = { projectId?: string; repoSlug?: string; projectDerivation?: ProjectDerivation };
const candidateHookIds = new WeakMap<ProjectDerivation, Map<string, Promise<string[]>>>();

export function normalizeRepoSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\\")) return undefined;
  const parts = trimmed.split("/");
  if (parts.length > 2 || parts.some((part) => part.length === 0)) return undefined;
  const sanitizedParts = parts.map((part) => part.replace(/[^a-zA-Z0-9._-]/g, ""));
  if (sanitizedParts.some((part) => part.length === 0)) return undefined;
  return sanitizedParts.join("/").slice(0, 120) || undefined;
}

/** Mirrors deriveProjectContext and normalizeGitRemoteUrl in plugins/shared/_lib.mjs. */
export async function deriveHookProjectIds(ownerRepo: string): Promise<string[]> {
  const parts = normalizeRepoSlug(ownerRepo)?.split("/");
  if (!parts || parts.length !== 2) return [];
  const folder = parts[1].replace(/\.git$/i, "");
  if (!folder) return [];
  const path = `${parts[0]}/${folder}`.toLowerCase();
  // Different checkout basenames, non-GitHub hosts, nested paths, and trailing-slash remotes are out of scope.
  const remotes = [`https://github.com/${path}`, `http://github.com/${path}`,
    `git@github.com:${path}`, `ssh://github.com/${path}`];
  const folders = [...new Set([folder, folder.toLowerCase()])];
  return Promise.all(remotes.flatMap(remote => folders.map(async name =>
    `proj_${(await sha256Hex(`${remote}\n${name}`)).slice(0, 24)}`)));
}

/** One eager derivation per normalized recall; lazy fallback for standalone callers. */
export function prepareProjectIdentity(request: ProjectIdentity): Promise<ProjectDerivation> {
  if (request.projectDerivation) return Promise.resolve(request.projectDerivation);
  const slug = request.repoSlug?.trim() || undefined;
  return Promise.all([
    slug ? deriveRepoProjectId(slug) : undefined,
    deriveHookProjectIds(slug ?? ""),
  ]).then(([legacyId, hookIds]) => ({ ...(legacyId ? { legacyId } : {}), hookIds }));
}

function candidateHooks(context: ProjectDerivation, slug: string): Promise<string[]> {
  let cache = candidateHookIds.get(context);
  if (!cache) { cache = new Map(); candidateHookIds.set(context, cache); }
  let pending = cache.get(slug);
  if (!pending) { pending = deriveHookProjectIds(slug); cache.set(slug, pending); }
  return pending;
}
export type ProjectMatch = "projectId" | "repoSlug";

/** Matches the server's legacy repo-slug derivation; remote-derived ids stay opaque. */
export async function deriveRepoProjectId(repoSlug: string): Promise<string> {
  return `proj_${(await sha256Hex(`repo:${repoSlug.trim().toLowerCase()}`)).slice(0, 24)}`;
}

/**
 * Shared, deterministic project identity policy. This is relevance
 * scoping within one account, not a privacy boundary. Callers own the policy
 * for candidates without either field (messages require an exact channel).
 * projectMatch identifies the table row's comparison, including mismatches.
 */
export async function matchProjectIdentity(
  request: ProjectIdentity,
  candidate: ProjectIdentity,
): Promise<{ matches: boolean; projectMatch: ProjectMatch | undefined }> {
  const requestId = request.projectId?.trim() || undefined;
  const candidateId = candidate.projectId?.trim() || undefined;
  const requestSlug = request.repoSlug?.trim().toLowerCase() || undefined;
  const candidateSlug = candidate.repoSlug?.trim().toLowerCase() || undefined;
  if (!requestId && !requestSlug) return { matches: true, projectMatch: undefined };
  if (!candidateId && !candidateSlug) return { matches: false, projectMatch: undefined };

  // Row 1: equal ids always win, even with missing or inconsistent slugs.
  if (requestId && candidateId && requestId === candidateId) {
    return { matches: true, projectMatch: "projectId" };
  }
  const [derivation, candidateDerived] = await Promise.all([
    prepareProjectIdentity(request),
    candidateSlug ? deriveRepoProjectId(candidateSlug) : undefined,
  ]);
  const requestDerived = derivation.legacyId;
  // Row 2: do not collapse different remotes sharing the same basename.
  if (requestId && candidateId && requestDerived && candidateDerived
    && requestId !== requestDerived && candidateId !== candidateDerived) {
    return { matches: false, projectMatch: "projectId" };
  }
  // Rows 3–5: a slug equality or the opposite slug's legacy derivation
  // bridges old clients and hook-stamped candidates symmetrically.
  const sameSlug = !!requestSlug && requestSlug === candidateSlug;
  let matches = sameSlug
    || (!!requestId && requestId === candidateDerived)
    || (!!candidateId && candidateId === requestDerived);
  // Only bridge after the existing rows; explicit conflicting ids still stop at row 2.
  if (!matches) {
    matches = (!!candidateId && derivation.hookIds.includes(candidateId))
      || (!!requestId && !!candidateSlug
        && (await candidateHooks(derivation, candidate.repoSlug!.trim())).includes(requestId));
  }
  return { matches, projectMatch: "repoSlug" };
}
