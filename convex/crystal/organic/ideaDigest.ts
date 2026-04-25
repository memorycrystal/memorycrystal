/**
 * Idea Digest Email — checks each organic user for pending ideas past their
 * delay threshold, sends an email digest, marks ideas as notified.
 * Scheduled to run hourly via crons.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Doc } from "../../_generated/dataModel";

const DEFAULT_EMAIL_DELAY_HOURS = 6;
const DASHBOARD_IDEAS_URL = "https://memorycrystal.ai/organic/ideas";

// ── Internal query: get organic users eligible for idea digest ──────────────

export const getDigestEligibleUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const states = await ctx.db
      .query("organicTickState")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(500);

    // Filter to users who have explicitly opted in to email notifications
    return states.filter((s) => s.notificationEmail === true);
  },
});

// ── Internal mutation: update lastIdeaNotificationAt ────────────────────────

export const updateLastNotificationAt = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("organicTickState")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (state) {
      await ctx.db.patch(state._id, {
        lastIdeaNotificationAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  },
});

// ── Internal mutation: acquire digest lease (atomic check-and-set) ──────────

const DIGEST_LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export const acquireDigestLease = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const lease = await ctx.db
      .query("digestLease")
      .first();

    if (lease?.leaseExpiresAt && lease.leaseExpiresAt > now) {
      return { acquired: false };
    }

    if (lease) {
      await ctx.db.patch(lease._id, {
        leaseHolderAt: now,
        leaseExpiresAt: now + DIGEST_LEASE_TTL_MS,
      });
      return { acquired: true, leaseId: lease._id };
    }

    const leaseId = await ctx.db.insert("digestLease", {
      leaseHolderAt: now,
      leaseExpiresAt: now + DIGEST_LEASE_TTL_MS,
    });
    return { acquired: true, leaseId };
  },
});

export const releaseDigestLease = internalMutation({
  args: { leaseId: v.optional(v.id("digestLease")) },
  handler: async (ctx, args) => {
    const leaseId = args.leaseId ?? (await ctx.db.query("digestLease").first())?._id;
    if (!leaseId) return;

    const lease = await ctx.db.get(leaseId);
    if (lease) {
      await ctx.db.patch(leaseId, {
        leaseHolderAt: undefined,
        leaseExpiresAt: undefined,
      });
    }
  },
});

// ── Internal action: send idea digest emails ────────────────────────────────

export const sendIdeaDigestEmails = internalAction({
  args: {},
  handler: async (ctx) => {
    // Acquire a lease to prevent concurrent digest runs
    const lease = await ctx.runMutation(
      internal.crystal.organic.ideaDigest.acquireDigestLease,
      {}
    );
    if (!lease.acquired) {
      console.log("[idea-digest] Skipped — another digest run holds the lease");
      return { emailsSent: 0 };
    }

    try {
    const eligibleUsers = await ctx.runQuery(
      internal.crystal.organic.ideaDigest.getDigestEligibleUsers,
      {}
    );

    let emailsSent = 0;

    for (const tickState of eligibleUsers) {
      const delayHours = tickState.notificationEmailDelay ?? DEFAULT_EMAIL_DELAY_HOURS;
      const delayMs = delayHours * 60 * 60 * 1000;
      const now = Date.now();

      // Rate limit: don't send more than one digest per delay period
      if (tickState.lastIdeaNotificationAt) {
        const timeSinceLast = now - tickState.lastIdeaNotificationAt;
        if (timeSinceLast < delayMs) continue;
      }

      const windowStart = tickState.lastIdeaNotificationAt ?? now - delayMs;

      const pendingIdeas = await ctx.runQuery(
        internal.crystal.organic.ideas.getIdeasForEmailDigest,
        { userId: tickState.userId, windowStart }
      );

      if (pendingIdeas.length === 0) continue;

      // Build email content
      const ideaSummaries = pendingIdeas
        .slice(0, 10) // Cap at 10 ideas per digest
        .map((idea: any) => buildIdeaRow(idea))
        .join("");

      const count = pendingIdeas.length;
      const subject = count === 1
        ? "Your memory discovered something"
        : `Your memory discovered ${count} things`;

      const variables: Record<string, string> = {
        subject,
        ideaCount: String(count),
        ideaSummaries_html: ideaSummaries,
        dashboardUrl: DASHBOARD_IDEAS_URL,
      };

      // Send via existing email engine
      await ctx.runAction(internal.crystal.emailEngine.sendTemplateEmail, {
        userId: tickState.userId,
        templateSlug: "idea-digest",
        variables,
      });

      // Mark ideas as notified
      const ideaIds = pendingIdeas.map((i: any) => i._id);
      await ctx.runMutation(
        internal.crystal.organic.ideas.markIdeasNotifiedInternal,
        { ideaIds, userId: tickState.userId }
      );

      // Update last notification timestamp
      await ctx.runMutation(
        internal.crystal.organic.ideaDigest.updateLastNotificationAt,
        { userId: tickState.userId }
      );

      emailsSent++;
    }

    console.log(`[idea-digest] Sent ${emailsSent} digest email(s)`);
    return { emailsSent };
    } finally {
      // Always release the lease when done
      await ctx.runMutation(
        internal.crystal.organic.ideaDigest.releaseDigestLease,
        { leaseId: lease.leaseId }
      );
    }
  },
});

// ── Helper: build HTML row for a single idea ────────────────────────────────

function buildIdeaRow(idea: Doc<"organicIdeas">): string {
  const typeLabel = idea.ideaType.replace(/_/g, " ");
  const typeColor = TYPE_COLORS[idea.ideaType] ?? "#7A9AB5";
  const confidence = Math.round(idea.confidence * 100);

  return `<tr>
  <td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.07);">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
      <span style="color:${typeColor};font-size:11px;text-transform:uppercase;letter-spacing:1px;">${escapeHtml(typeLabel)}</span>
      <span style="color:rgba(255,255,255,0.3);font-size:11px;">${confidence}% confidence</span>
    </div>
    <p style="color:#E8F0F8;font-size:14px;font-weight:bold;margin:0 0 4px;">${escapeHtml(idea.title)}</p>
    <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:0;line-height:1.5;">${escapeHtml(idea.summary.slice(0, 300))}</p>
  </td>
</tr>`;
}

const TYPE_COLORS: Record<string, string> = {
  connection: "#4CC1E9",
  pattern: "#2180D6",
  contradiction_resolved: "#E5A84B",
  insight: "#9B59B6",
  action_suggested: "#2ECC71",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
