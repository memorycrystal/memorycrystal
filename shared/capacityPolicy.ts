import type { UserTier } from "./tierLimits";

export type CapacityPolicyId =
  | "managed_free"
  | "managed_pro"
  | "managed_ultra"
  | "managed_unlimited"
  | "self_hosted_unmetered";

export type CapacityPolicy = {
  id: CapacityPolicyId;
  requestLimitPerMinute: number | null;
  memoryRecords: number | null;
  messageRecords: number | null;
  researchRecords: number | null;
  researchIngestRecordsPerJob: number | null;
  storageAdmissionBytes: number | null;
  embeddingCallsPerDay: number | null;
  graphEnrichmentsPerHour: number | null;
  productQuotaExempt: boolean;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const CAPACITY_POLICIES: Record<CapacityPolicyId, CapacityPolicy> = {
  managed_free: {
    id: "managed_free",
    requestLimitPerMinute: 60,
    memoryRecords: 500,
    messageRecords: 500,
    researchRecords: 0,
    researchIngestRecordsPerJob: 0,
    storageAdmissionBytes: 250 * MIB,
    embeddingCallsPerDay: 0,
    graphEnrichmentsPerHour: 0,
    productQuotaExempt: false,
  },
  managed_pro: {
    id: "managed_pro",
    requestLimitPerMinute: 600,
    memoryRecords: 25_000,
    messageRecords: 25_000,
    researchRecords: 100_000,
    researchIngestRecordsPerJob: 100_000,
    storageAdmissionBytes: 2 * GIB,
    embeddingCallsPerDay: 500,
    graphEnrichmentsPerHour: 25,
    productQuotaExempt: false,
  },
  managed_ultra: {
    id: "managed_ultra",
    requestLimitPerMinute: 2_000,
    memoryRecords: null,
    messageRecords: null,
    researchRecords: 2_000_000,
    researchIngestRecordsPerJob: 1_000_000,
    storageAdmissionBytes: 10 * GIB,
    embeddingCallsPerDay: null,
    graphEnrichmentsPerHour: 50,
    productQuotaExempt: false,
  },
  managed_unlimited: {
    id: "managed_unlimited",
    requestLimitPerMinute: null,
    memoryRecords: null,
    messageRecords: null,
    researchRecords: null,
    researchIngestRecordsPerJob: null,
    storageAdmissionBytes: null,
    embeddingCallsPerDay: null,
    graphEnrichmentsPerHour: null,
    productQuotaExempt: true,
  },
  self_hosted_unmetered: {
    id: "self_hosted_unmetered",
    requestLimitPerMinute: null,
    memoryRecords: null,
    messageRecords: null,
    researchRecords: null,
    researchIngestRecordsPerJob: null,
    storageAdmissionBytes: null,
    embeddingCallsPerDay: null,
    graphEnrichmentsPerHour: null,
    productQuotaExempt: true,
  },
};

type CapacityProfile = {
  capacityPolicy?: string;
  subscriptionStatus?: string;
  plan?: string;
  entitlementExpiresAt?: number;
  entitlementGraceEndsAt?: number;
  entitlementRevokedAt?: number;
} | null | undefined;

export function policyIdForManagedTier(tier: UserTier): CapacityPolicyId {
  if (tier === "unlimited") return "managed_unlimited";
  if (tier === "ultra") return "managed_ultra";
  if (tier === "starter" || tier === "pro") return "managed_pro";
  return "managed_free";
}

export function capacityPolicyToTier(policyId: CapacityPolicyId): UserTier {
  if (policyId === "managed_free") return "free";
  if (policyId === "managed_pro") return "pro";
  if (policyId === "managed_ultra") return "ultra";
  return "unlimited";
}

export function resolveCapacityPolicyId(
  profile: CapacityProfile,
  options: { backend?: string; now?: number } = {},
): CapacityPolicyId {
  const now = options.now ?? Date.now();
  if (profile?.entitlementRevokedAt && profile.entitlementRevokedAt <= now) {
    return "managed_free";
  }
  if (
    profile?.entitlementExpiresAt &&
    profile.entitlementExpiresAt <= now &&
    (!profile.entitlementGraceEndsAt || profile.entitlementGraceEndsAt <= now)
  ) {
    return "managed_free";
  }

  if (profile?.capacityPolicy && profile.capacityPolicy in CAPACITY_POLICIES) {
    return profile.capacityPolicy as CapacityPolicyId;
  }

  // An authenticated local installation must never degrade to Free merely
  // because its entitlement row is temporarily missing during bootstrap.
  if (options.backend === "local") return "self_hosted_unmetered";
  if (profile?.subscriptionStatus === "unlimited" || profile?.plan === "unlimited") {
    return "managed_unlimited";
  }
  if (profile?.subscriptionStatus !== "active" && profile?.subscriptionStatus !== "trialing") {
    return "managed_free";
  }
  const normalizedPlan = String(profile?.plan ?? "pro").toLowerCase();
  if (normalizedPlan === "free" || normalizedPlan.startsWith("free_")) return "managed_free";
  if (normalizedPlan.includes("ultra")) return "managed_ultra";
  return "managed_pro";
}

export function resolveCapacityPolicy(
  profile: CapacityProfile,
  options: { backend?: string; now?: number } = {},
): CapacityPolicy {
  return CAPACITY_POLICIES[resolveCapacityPolicyId(profile, options)];
}
