import { spawnSync } from "node:child_process";

const DEFAULT_RAILWAY_SERVICE = "convex-backend-prod";

function readRailwayVariables(service, cwd) {
  const result = spawnSync(
    "npx",
    ["@railway/cli", "variables", "--service", service, "--json"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to read Railway ${service} variables.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Railway ${service} variables were not valid JSON.`);
  }
}

export function resolveSelfHostedConvexEnv({
  allowLocal = false,
  baseEnv = process.env,
  cwd = process.cwd(),
  railwayService = DEFAULT_RAILWAY_SERVICE,
  readVariables = readRailwayVariables,
} = {}) {
  const explicitUrl = baseEnv.CONVEX_SELF_HOSTED_URL?.trim();
  const explicitAdminKey = baseEnv.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim();
  if (Boolean(explicitUrl) !== Boolean(explicitAdminKey)) {
    throw new Error(
      "Refusing partial self-hosted credentials: set both CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY, or neither.",
    );
  }

  let url = explicitUrl;
  let adminKey = explicitAdminKey;
  let source = "environment";
  if (!url && !adminKey) {
    const railwayEnv = readVariables(railwayService, cwd);
    url = railwayEnv.CONVEX_SELF_HOSTED_URL?.trim();
    adminKey = railwayEnv.CONVEX_SELF_HOSTED_ADMIN_KEY?.trim();
    source = `railway:${railwayService}`;
  }

  if (!url || !adminKey) {
    throw new Error(
      "Refusing to run: CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are required.",
    );
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Refusing to run: CONVEX_SELF_HOSTED_URL is not a valid URL.",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      `Refusing unsupported self-hosted Convex protocol: ${parsed.protocol}`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host.endsWith(".convex.cloud") || host.endsWith(".convex.site")) {
    throw new Error(`Refusing managed Convex Cloud host: ${host}`);
  }
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (isLoopback && !allowLocal) {
    throw new Error(
      "Refusing a loopback target. Enable allowLocal only for an intentional local operation.",
    );
  }

  return {
    url,
    adminKey,
    source,
    env: {
      ...baseEnv,
      CONVEX_DEPLOYMENT: "",
      CONVEX_DEPLOY_KEY: "",
      CONVEX_SELF_HOSTED_URL: url,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    },
  };
}
