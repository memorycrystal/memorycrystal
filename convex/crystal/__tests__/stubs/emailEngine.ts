import { internalAction } from "../../../_generated/server";
import { v } from "convex/values";

export const sendTemplateEmail = internalAction({
  args: v.any(),
  handler: async () => ({ ok: true }),
});

export const sendAdminNotificationEmail = internalAction({
  args: v.any(),
  handler: async () => ({ ok: true }),
});
