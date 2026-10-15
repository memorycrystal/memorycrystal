import { sha256Hex } from "./crypto";

export type ProjectIdentity = { projectId?: string; repoSlug?: string };
export type ProjectMatch = "projectId" | "repoSlug";

/** Matches the server's legacy repo-slug derivation; remote-derived ids stay opaque. */
export async function deriveRepoProjectId(repoSlug: string): Promise<string> {
  return `proj_${(await sha256Hex(`repo:${repoSlug.trim().toLowerCase()}`)).slice(0, 24)}`;
}

/**
 * Shared, deterministic five-row project identity policy. This is relevance
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
  const [requestDerived, candidateDerived] = await Promise.all([
    requestSlug ? deriveRepoProjectId(requestSlug) : undefined,
    candidateSlug ? deriveRepoProjectId(candidateSlug) : undefined,
  ]);
  // Row 2: do not collapse different remotes sharing the same basename.
  if (requestId && candidateId && requestDerived && candidateDerived
    && requestId !== requestDerived && candidateId !== candidateDerived) {
    return { matches: false, projectMatch: "projectId" };
  }
  // Rows 3–5: a slug equality or the opposite slug's legacy derivation
  // bridges old clients and hook-stamped candidates symmetrically.
  const sameSlug = !!requestSlug && requestSlug === candidateSlug;
  const matches = sameSlug
    || (!!requestId && requestId === candidateDerived)
    || (!!candidateId && candidateId === requestDerived);
  return { matches, projectMatch: "repoSlug" };
}
