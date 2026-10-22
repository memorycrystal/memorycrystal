import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

function page(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe — Memory Crystal</title></head>
<body style="margin:0;padding:80px 24px;background:#0D1820;color:#E8F0F8;font-family:Arial,sans-serif;">
<main style="max-width:480px;margin:auto;padding:24px;background:#111C28;border:1px solid rgba(124,178,219,0.12);border-radius:0;">
${content}
</main></body></html>`;
}

export const emailUnsubscribe = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  if (request.method === "POST") {
    await ctx.runMutation(internal.crystal.emailPreferences.unsubscribeByToken, {
      token,
      source: url.searchParams.get("source") === "link" ? "link" : "one_click",
    });
    return new Response(page(`<h1 style="font-size:22px;">Your unsubscribe request has been processed.</h1>
<p style="color:#7A9AB5;line-height:1.6;">Account and billing emails such as trial reminders still send.</p>
<a href="https://memorycrystal.ai/settings" style="color:#2180D6;">Turn product emails back on in Settings</a>`), { headers });
  }
  const safeToken = /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
  return new Response(page(`<h1 style="font-size:22px;">Unsubscribe from Memory Crystal product emails?</h1><form method="POST" action="/api/email/unsubscribe?token=${safeToken}&amp;source=link"><button type="submit" style="padding:12px 16px;background:#2180D6;color:#E8F0F8;border:0;border-radius:0;font-size:16px;cursor:pointer;">Confirm unsubscribe</button></form><a href="https://memorycrystal.ai/settings" style="color:#2180D6;">Manage email preferences in Settings</a>`), { headers });
});
