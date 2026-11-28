import { v } from "convex/values";
import { agentStampKey, normalizeAgentStamp, sharedMarkers } from "../agentStamp";
import { MEMORY_VECTOR_DEFAULT_CAP } from "../memoryVectors";
import { recallFilterRefillEnabled } from "./memoryPolicy";
import type { RecallRuntime } from "./types";

const ENABLED = new Set(["1", "true", "on", "yes"]);

export const agentPoolValidator = v.union(v.literal("account"), v.literal("layer"), v.literal("agent"));
export type AgentPool = "account" | "layer" | "agent";
export type AgentRecallPolicy = {
  agentKey: string; extraStamps: string[]; extraChannelPrefixes: string[];
  includeShared: boolean; updatedAt: number;
};
export const agentLayerValidator = v.object({
  agentKey: v.string(), extraStamps: v.array(v.string()), extraChannelPrefixes: v.array(v.string()),
  includeShared: v.boolean(), updatedAt: v.number(), mode: v.union(v.literal("layer"), v.literal("agent")),
});
export type AgentLayer = AgentRecallPolicy & { mode: "layer" | "agent" };

/** The received identity alone activates; never the backend's effectiveAgentId fallback. */
export async function loadAgentLayer(state: RecallRuntime): Promise<void> {
  const { agentPool, agentId } = state.request;
  if (agentPool !== "layer" && agentPool !== "agent") return;
  const agentKey = normalizeAgentStamp(agentId)?.toLowerCase();
  if (!agentKey) return;
  const policy = await state.ports.getAgentRecallPolicy?.({ userId: state.ports.userId, agentId: agentKey });
  if (!policy) return;
  const { extraStamps, extraChannelPrefixes, includeShared, updatedAt } = policy;
  state.agentLayer = { agentKey: policy.agentKey, extraStamps, extraChannelPrefixes, includeShared, updatedAt, mode: agentPool };
  state.diagnostics.scope.agentLayer = { active: true, mode: agentPool };
  state.diagnostics.suppressions.agentLayer = 0;
}

export function inAgentLayer(memory: {
  knowledgeBaseId?: unknown; metadata?: unknown; channel?: string; category?: string; tags?: string[];
}, layer?: AgentLayer): boolean {
  if (!layer || memory.knowledgeBaseId) return true;
  const stamp = agentStampKey(memory.metadata);
  if (stamp && (stamp === layer.agentKey || layer.extraStamps.includes(stamp))) return true;
  if (layer.extraChannelPrefixes.some((prefix) => (memory.channel ?? "").toLowerCase().startsWith(prefix))) return true;
  return layer.includeShared && layer.mode !== "agent" && Object.values(sharedMarkers(memory)).some(Boolean);
}

/**
 * Called only after visibility and project checks; a double drop belongs to project.
 * Like crossProject, counts drops per lane, not unique rows across the recall.
 */
export function keepAgentLayer(state: RecallRuntime, memory: any): boolean {
  if (inAgentLayer(memory, state.agentLayer)) return true;
  state.diagnostics.suppressions.agentLayer = (state.diagnostics.suppressions.agentLayer ?? 0) + 1;
  return false;
}

export function applyAgentLayer(state: RecallRuntime): void {
  if (state.agentLayer) state.memories = state.memories.filter((memory) => keepAgentLayer(state, memory));
}

export function agentLayerRefillEnabled(layer?: AgentLayer): boolean {
  const raw = process.env.MC_AGENT_LAYER_REFILL?.trim().toLowerCase();
  return recallFilterRefillEnabled() || (Boolean(layer) && raw !== undefined && ENABLED.has(raw));
}

export function widenAgentVector(depth: number, layer?: AgentLayer): number {
  return layer ? Math.min(depth * 4, MEMORY_VECTOR_DEFAULT_CAP) : depth;
}

export function widenAgentText(depth: number, cap: number, layer?: AgentLayer): number {
  return layer ? Math.min(depth * 4, cap) : depth;
}
