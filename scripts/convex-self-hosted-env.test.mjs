import assert from "node:assert/strict";
import test from "node:test";

import { resolveSelfHostedConvexEnv } from "./lib/convex-self-hosted-env.mjs";

test("accepts a complete explicit remote self-hosted target", () => {
  const resolved = resolveSelfHostedConvexEnv({
    baseEnv: {
      CONVEX_DEPLOYMENT: "prod:old-cloud-123",
      CONVEX_DEPLOY_KEY: "old-cloud-key",
      CONVEX_SELF_HOSTED_URL: "https://railway.example.test",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "local|admin",
    },
  });

  assert.equal(resolved.url, "https://railway.example.test");
  assert.equal(resolved.source, "environment");
  assert.equal(resolved.env.CONVEX_DEPLOYMENT, "");
  assert.equal(resolved.env.CONVEX_DEPLOY_KEY, "");
});

test("loads Railway variables only when neither explicit credential is set", () => {
  let calls = 0;
  const resolved = resolveSelfHostedConvexEnv({
    baseEnv: {},
    readVariables(service) {
      calls += 1;
      assert.equal(service, "convex-backend-prod");
      return {
        CONVEX_SELF_HOSTED_URL: "https://railway.example.test",
        CONVEX_SELF_HOSTED_ADMIN_KEY: "local|admin",
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(resolved.source, "railway:convex-backend-prod");
});

test("rejects partial, managed Cloud, and accidental loopback targets", () => {
  assert.throws(
    () =>
      resolveSelfHostedConvexEnv({
        baseEnv: { CONVEX_SELF_HOSTED_URL: "https://railway.example.test" },
      }),
    /partial self-hosted credentials/,
  );
  assert.throws(
    () =>
      resolveSelfHostedConvexEnv({
        baseEnv: {
          CONVEX_SELF_HOSTED_URL: "https://example.convex.cloud",
          CONVEX_SELF_HOSTED_ADMIN_KEY: "cloud-key",
        },
      }),
    /managed Convex Cloud host/,
  );
  assert.throws(
    () =>
      resolveSelfHostedConvexEnv({
        baseEnv: {
          CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
          CONVEX_SELF_HOSTED_ADMIN_KEY: "local|admin",
        },
      }),
    /loopback target/,
  );
});

test("allows loopback only when the caller opts in", () => {
  const resolved = resolveSelfHostedConvexEnv({
    allowLocal: true,
    baseEnv: {
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3210",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "local|admin",
    },
  });
  assert.equal(resolved.url, "http://127.0.0.1:3210");
});
