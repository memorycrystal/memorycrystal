export const CRYSTAL_ROLES = ["subscriber", "manager", "admin"] as const;

export type CrystalRole = (typeof CRYSTAL_ROLES)[number];

const ROLE_SET = new Set<CrystalRole>(CRYSTAL_ROLES);

export function isCrystalRole(value: string): value is CrystalRole {
  return ROLE_SET.has(value as CrystalRole);
}

export function normalizeRoles(roles?: string[] | null): CrystalRole[] {
  if (!roles?.length) return ["subscriber"];

  const deduped = new Set<CrystalRole>();
  for (const role of roles) {
    if (isCrystalRole(role)) deduped.add(role);
  }

  if (deduped.size === 0) {
    deduped.add("subscriber");
  }

  return Array.from(deduped);
}

export function hasRole(roles: string[] | undefined | null, role: CrystalRole): boolean {
  return normalizeRoles(roles).includes(role);
}

export function canPerformWriteActions(roles: string[] | undefined | null): boolean {
  const normalized = normalizeRoles(roles);
  return normalized.includes("manager") || normalized.includes("admin");
}

export function canManageApiKeys(roles: string[] | undefined | null): boolean {
  return canPerformWriteActions(roles);
}

export function canAssignRoles(roles: string[] | undefined | null): boolean {
  return hasRole(roles, "admin");
}

export function requireRole(roles: string[] | undefined | null, role: CrystalRole, message?: string): void {
  if (!hasRole(roles, role)) {
    throw new Error(message ?? `Forbidden: requires ${role} role`);
  }
}

export function requireWriteAccess(roles: string[] | undefined | null, message?: string): void {
  if (!canPerformWriteActions(roles)) {
    throw new Error(message ?? "Forbidden: write access requires manager or admin role");
  }
}

export function requireApiKeyManagementAccess(roles: string[] | undefined | null, message?: string): void {
  if (!canManageApiKeys(roles)) {
    throw new Error(message ?? "Forbidden: API key management requires manager or admin role");
  }
}

export function requireRoleAssignmentAccess(roles: string[] | undefined | null, message?: string): void {
  if (!canAssignRoles(roles)) {
    throw new Error(message ?? "Forbidden: role assignment requires admin role");
  }
}
