import { isNonKnowledgeBaseMemoryVisibleInChannel } from "../knowledgeBases";
import { normalizeTagList } from "./limits";
import type { NormalizedRecallRequest, RecallRuntime } from "./types";
import {
  decideMemoryProject,
  isRecallMemoryVisible,
  memoryProjectIdentity,
  recallRequestAllowlist,
  requestProjectIdentity,
} from "./memoryPolicy";

export function passesStoreCategoryTagFilters(memory: any, request: NormalizedRecallRequest): boolean {
  if (request.resolvedStores?.length && !request.resolvedStores.includes(memory.store)) return false;
  if (request.resolvedCategories?.length && !request.resolvedCategories.includes(memory.category)) return false;
  if (request.requestedTags?.length) {
    const lowerTags = normalizeTagList((memory.tags ?? []).map(String));
    if (!request.requestedTags.every((tag) => lowerTags.includes(tag))) return false;
  }
  return true;
}

export function dropRecentMemoryIds(memories: any[], recentMemoryIds: string[] | undefined): any[] {
  if (!recentMemoryIds || recentMemoryIds.length === 0) return memories;
  const recent = new Set(recentMemoryIds);
  return memories.filter((memory) => !recent.has(String(memory?._id ?? "")));
}

export function applyRequestedKnowledgeBaseFilter(state: RecallRuntime): void {
  if (!state.request.hasKnowledgeBaseScope) return;
  const allowed = new Set(state.request.requestedKnowledgeBaseIds ?? []);
  const before = state.memories.length;
  state.memories = state.memories.filter((memory: any) => allowed.has(String(memory?.knowledgeBaseId ?? "")));
  state.diagnostics.suppressions.requestedKnowledgeBaseFilter += before - state.memories.length;
}

export async function applyProjectFilter(state: RecallRuntime): Promise<void> {
  const request = requestProjectIdentity(state.request);
  if (!request.projectId && !request.repoSlug) return;
  const allowlist = recallRequestAllowlist();
  const kept: any[] = [];
  for (const memory of state.memories) {
    const decision = await decideMemoryProject(request, memoryProjectIdentity(memory));
    if (!decision.include) {
      const visibleIfMatched = memory?.knowledgeBaseId
        ? isNonKnowledgeBaseMemoryVisibleInChannel(memory.channel, state.request.channel)
        : isRecallMemoryVisible(memory.channel, state.request.channel, { sameProject: true, allowlist });
      if (visibleIfMatched) state.diagnostics.suppressions.crossProject += 1;
      continue;
    }
    if (decision.sameProject) memory.sameProject = true;
    if (decision.projectMatch) state.diagnostics.scope.projectMatch = decision.projectMatch;
    kept.push(memory);
  }
  state.memories = kept;
}

export function selectBookkeepingIds(memories: any[], request: NormalizedRecallRequest): string[] {
  const rows = request.excludeProspectiveFromBookkeeping
    ? memories.filter((memory) => memory?._source !== "prospective" && memory?.store !== "prospective")
    : memories;
  const ids = Array.from(new Set(rows.map((memory) => String(memory?._id)).filter(Boolean)));
  return request.bookkeepingIdCap === undefined ? ids : ids.slice(0, request.bookkeepingIdCap);
}
