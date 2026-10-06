export type AssetStorageProviderName = "convex";
export type AssetAccessMethod = "proxy";

export type AssetStorageConfig = {
  provider: AssetStorageProviderName;
  publicProxyBasePath: string;
};

export type AssetStorageKeyInput = {
  userId: string;
  assetId: string;
  contentHash: string;
  extension: string;
  now?: Date;
};

export type AssetAccessDescriptor = {
  provider: AssetStorageProviderName;
  method: AssetAccessMethod;
  url: string;
  expiresAt: number;
};

export const DEFAULT_PROXY_BASE_PATH = "/api/assets";
const DEFAULT_SIGNED_URL_TTL_MS = 5 * 60 * 1000;

export function resolveAssetStorageConfig(env: Record<string, string | undefined> = process.env): AssetStorageConfig {
  return {
    provider: "convex",
    publicProxyBasePath: env.MEMORYCRYSTAL_ASSET_PROXY_BASE_PATH || DEFAULT_PROXY_BASE_PATH,
  };
}

export function buildTenantAssetStorageKey(input: AssetStorageKeyInput): string {
  const now = input.now ?? new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const userHash = stableHexHash(input.userId, 24);
  const assetId = sanitizeSegment(input.assetId, "asset");
  const contentHash = sanitizeSegment(input.contentHash, "content");
  const extension = sanitizeExtension(input.extension);
  return `users/${userHash}/assets/${year}/${month}/${assetId}/${contentHash}.${extension}`;
}

export function tenantAssetStoragePrefix(userId: string): string {
  const userHash = stableHexHash(userId, 24);
  return `users/${userHash}/assets/`;
}

export function isTenantAssetStorageKey(userId: string, storageKey: string): boolean {
  return storageKey.startsWith(tenantAssetStoragePrefix(userId));
}

export function createProxyReadDescriptor(
  config: Pick<AssetStorageConfig, "provider" | "publicProxyBasePath">,
  assetId: string,
  now = Date.now(),
): AssetAccessDescriptor {
  const expiresAt = now + DEFAULT_SIGNED_URL_TTL_MS;
  const encodedAssetId = encodeURIComponent(assetId);
  return {
    provider: config.provider,
    method: "proxy",
    url: `${config.publicProxyBasePath}/${encodedAssetId}/read?expiresAt=${expiresAt}`,
    expiresAt,
  };
}


function stableHexHash(value: string, length: number): string {
  let first = 2166136261;
  let second = 2166136261 ^ 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 16777619);
  }
  const third = (first ^ (second >>> 16) ^ Math.imul(value.length + 1, 0x85ebca6b)) >>> 0;
  const hex = `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}${third.toString(16).padStart(8, "0")}`;
  return hex.slice(0, length);
}

function sanitizeSegment(value: string, fallback: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return sanitized || fallback;
}

function sanitizeExtension(value: string): string {
  const sanitized = value.trim().replace(/^\.+/, "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return sanitized || "bin";
}
