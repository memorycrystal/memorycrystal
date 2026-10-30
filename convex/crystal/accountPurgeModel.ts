import { v, type Infer } from "convex/values";

export const purgeTarget = v.object({
  userId: v.id("users"),
  emailSha256: v.string(),
});
export const purgeOptions = {
  targets: v.array(purgeTarget),
  inactiveDays: v.optional(v.number()),
  force: v.optional(v.array(v.id("users"))),
  polarCancelled: v.optional(v.array(v.id("users"))),
};
export const purgeParents = v.object({
  sessions: v.array(v.string()),
  accounts: v.array(v.string()),
  memories: v.array(v.string()),
});
export const purgeEvidence = v.object({
  checkedAt: v.number(),
  cutoff: v.number(),
  signals: v.record(v.string(), v.number()),
  refusals: v.array(v.string()),
  overrides: v.array(v.string()),
});
export const purgeTargetSummary = v.object({
  ...purgeTarget.fields,
  state: v.union(
    v.literal("pending"),
    v.literal("refused"),
    v.literal("claimed"),
    v.literal("deleting"),
    v.literal("sweeping"),
    v.literal("done"),
    v.literal("stopped"),
  ),
  reason: v.optional(v.string()),
  evidence: v.optional(purgeEvidence),
  consecutiveFailures: v.optional(v.number()),
  lastError: v.optional(v.string()),
});
export const purgePrivateState = {
  dependencyPeers: v.optional(v.array(v.string())),
  dependencyRefusal: v.optional(v.string()),
  dependenciesComplete: v.optional(v.boolean()),
  parents: purgeParents,
  identifierHashes: v.array(v.string()),
  rateLimitIdentifiersShared: v.number(),
  sharedRateLimitIds: v.array(v.string()),
  counts: v.record(v.string(), v.number()),
  filesSkippedInvalidKey: v.number(),
  filesAlreadyMissing: v.number(),
};
export const purgeProgress = {
  table: v.optional(v.string()),
  tableIndex: v.number(),
  targetIndex: v.number(),
  parentIndex: v.number(),
  cursor: v.union(v.string(), v.null()),
  scanRowsRead: v.record(v.string(), v.number()),
};
export type Target = Infer<typeof purgeTarget>;
const privateStateValidator = v.object(purgePrivateState);
export type TargetState = Infer<typeof purgeTargetSummary> &
  Infer<typeof privateStateValidator>;
export type Parents = Infer<typeof purgeParents>;
export type Evidence = Infer<typeof purgeEvidence>;
export type Options = {
  targets: Target[];
  inactiveDays?: number;
  force?: string[];
  polarCancelled?: string[];
};
export const emptyParents = (): Parents => ({
  sessions: [],
  accounts: [],
  memories: [],
});
export const emptyPrivateState = () => ({
  parents: emptyParents(),
  identifierHashes: [] as string[],
  rateLimitIdentifiersShared: 0,
  sharedRateLimitIds: [] as string[],
  counts: {} as Record<string, number>,
  filesSkippedInvalidKey: 0,
  filesAlreadyMissing: 0,
});
export const PAGE_SIZE = 200;
export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_DELETIONS = 200;
// Atomic credential revocation must never truncate a credential graph.
export const MAX_PARENTS = 1000;
export const MAX_IDENTIFIER_CARRIERS = 1000;
export const MAX_REPORT_BYTES = 800_000;

export function validateOptions(args: Options) {
  if (
    !args.targets.length ||
    args.targets.length > 25 ||
    new Set(args.targets.map((t) => t.userId)).size !== args.targets.length
  ) {
    throw new Error("invalid_targets");
  }
  if (args.targets.some((t) => !/^[a-f0-9]{64}$/.test(t.emailSha256))) {
    throw new Error("invalid_identity_hash");
  }
  if (
    !Number.isFinite(args.inactiveDays ?? 30) ||
    (args.inactiveDays ?? 30) <= 0
  ) {
    throw new Error("invalid_inactive_days");
  }
  for (const ids of [args.force, args.polarCancelled]) {
    if (ids?.some((id) => !args.targets.some((t) => t.userId === id))) {
      throw new Error("override_not_targeted");
    }
  }
}
