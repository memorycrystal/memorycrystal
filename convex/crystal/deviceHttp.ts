import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const deviceStart = httpAction(async (ctx, request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { deviceCode, userCode } = await ctx.runMutation(internal.crystal.deviceAuth.startSession, {});
  const webBase = process.env.CRYSTAL_PUBLIC_WEB_URL || "https://memorycrystal.ai";
  const verificationUrl = `${webBase}/device?user_code=${encodeURIComponent(userCode)}`;

  return new Response(
    JSON.stringify({
      device_code: deviceCode,
      user_code: userCode,
      verification_url: verificationUrl,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});

export const deviceStatus = httpAction(async (ctx, request) => {
  const { searchParams } = new URL(request.url);
  const deviceCode = searchParams.get("device_code")?.trim().toUpperCase();

  if (!deviceCode) {
    return new Response(JSON.stringify({ error: "device_code is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Rate limit: 10 polls/min per device_code to prevent brute-force of active codes.
  const rateLimit = await ctx.runMutation(internal.crystal.deviceAuth.checkDevicePollRateLimit, { deviceCode });
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: "too_many_requests", retry_after: 60 }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }

  const status = await ctx.runQuery(internal.crystal.deviceAuth.getSessionStatus, { deviceCode });
  if (status.status === "expired") {
    await ctx.runMutation(internal.crystal.deviceAuth.markExpired, { deviceCode });
    return new Response(JSON.stringify({ status: "expired" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // If the session is complete and has an API key, return it and immediately clear it from the DB.
  // This ensures the plaintext key is not retained after the CLI retrieves it (defense against DB breach).
  if (status.status === "complete" && status.apiKey) {
    await ctx.runMutation(internal.crystal.deviceAuth.clearApiKeyAfterRetrieval, { deviceCode });
  }

  return new Response(
    JSON.stringify({
      status: status.status,
      ...(status.status === "complete" && status.apiKey ? { apiKey: status.apiKey } : {}),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
