#!/usr/bin/env node

/**
 * Loop through operatorScopeReport pages and print aggregate counts, plus the
 * reportable bare labels for a single account (ILL-320 A04, requirement 4).
 * Never outputs message or memory text or peer identifiers: the query returns
 * counts and safe bare labels only, and this script only sums them.
 *
 * Usage:
 *   CONVEX_SELF_HOSTED_URL=... CONVEX_SELF_HOSTED_ADMIN_KEY=... \
 *     node scripts/operator-scope-report.mjs [--userId <id>] [--allowlist a,b]
 *
 * `--userId` restricts every count to one account and includes that account's
 * reportable bare labels. Without it the report is the all-tenant aggregate:
 * counts only, no `bareLabels` (the spec allows aggregate counts only across
 * tenants). `--allowlist` previews an operator allowlist so the "would stop
 * appearing" count reflects the labels about to be approved.
 */

import { fileURLToPath } from "node:url";

const EMPTY_CLASS = () => ({ global: 0, work: 0, private: 0 });

/** Parse `--userId <id>` and `--allowlist a,b` from argv (exported for tests). */
export function parseScopeReportArgs(argv) {
  const read = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const allowlistRaw = read("--allowlist");
  return {
    userId: read("--userId"),
    allowlist: allowlistRaw
      ? allowlistRaw.split(",").map((label) => label.trim()).filter(Boolean)
      : undefined,
  };
}

/**
 * Walk every page of the report through `fetchPage(args)` and sum the counts.
 * `fetchPage` receives `{ pageSize, cursor, userId, allowlist }` and returns
 * `{ done, cursor, page }` exactly as `operatorScopeReport` does.
 */
export async function aggregateScopeReport(fetchPage, options = {}) {
  const pageSize = options.pageSize ?? 100;
  const userId = options.userId;
  const allowlist = options.allowlist;
  const maxPages = options.maxPages ?? 100_000;

  const totals = {
    readMemories: 0,
    readMessages: 0,
    scannedMemories: 0,
    scannedMessages: 0,
    bareLabels: new Map(),
    byClass: EMPTY_CLASS(),
    messagesByClass: EMPTY_CLASS(),
    devSessionFamilies: new Map(),
    privateBuckets: {},
    allowlistRejectedCount: 0,
    pages: 0,
  };

  let cursor;
  let done = false;
  while (!done) {
    if (totals.pages >= maxPages) {
      throw new Error(`scope report exceeded ${maxPages} pages without finishing`);
    }
    const result = await fetchPage({
      pageSize,
      ...(cursor ? { cursor } : {}),
      ...(userId ? { userId } : {}),
      ...(allowlist ? { allowlist } : {}),
    });
    const page = result.page ?? {};
    totals.readMemories += page.readMemories ?? 0;
    totals.readMessages += page.readMessages ?? 0;
    totals.scannedMemories += page.scannedMemories ?? 0;
    totals.scannedMessages += page.scannedMessages ?? 0;
    for (const key of ["global", "work", "private"]) {
      totals.byClass[key] += page.byClass?.[key] ?? 0;
      totals.messagesByClass[key] += page.messagesByClass?.[key] ?? 0;
    }
    for (const row of page.bareLabels ?? []) {
      totals.bareLabels.set(row.label, (totals.bareLabels.get(row.label) ?? 0) + row.count);
    }
    for (const row of page.devSessionFamilies ?? []) {
      totals.devSessionFamilies.set(
        row.family,
        (totals.devSessionFamilies.get(row.family) ?? 0) + row.count,
      );
    }
    for (const [bucket, count] of Object.entries(page.privateBuckets ?? {})) {
      totals.privateBuckets[bucket] = (totals.privateBuckets[bucket] ?? 0) + count;
    }
    // The rejected count is per call, not per page: keep the max, not the sum.
    totals.allowlistRejectedCount = Math.max(
      totals.allowlistRejectedCount,
      page.allowlistRejectedCount ?? 0,
    );
    totals.pages += 1;
    done = result.done === true;
    cursor = result.cursor ?? undefined;
    if (!done && !cursor) {
      throw new Error("scope report returned done=false without a cursor");
    }
  }

  const sortedEntries = (map) =>
    Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return {
    userId: userId ?? "(all tenants)",
    pages: totals.pages,
    // Rows read per table across all tenants (progress), and rows counted
    // toward this report (all rows, or only the given user's).
    readMemories: totals.readMemories,
    readMessages: totals.readMessages,
    scannedMemories: totals.scannedMemories,
    scannedMessages: totals.scannedMessages,
    byClass: totals.byClass,
    messagesByClass: totals.messagesByClass,
    // Messages an unscoped surface stops returning under this allowlist.
    privateMessagesHidden: totals.messagesByClass.private,
    // Bare labels are reported per account only; the all-tenant run is
    // aggregate counts only.
    ...(userId
      ? { bareLabels: sortedEntries(totals.bareLabels).map(([label, count]) => ({ label, count })) }
      : {}),
    devSessionFamilies: userId ? sortedEntries(totals.devSessionFamilies).map(([family, count]) => ({
      family,
      count,
    })) : [],
    privateBuckets: totals.privateBuckets,
    allowlistRejectedCount: totals.allowlistRejectedCount,
  };
}

async function main() {
  const url = process.env.CONVEX_SELF_HOSTED_URL;
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (!url || !adminKey) {
    console.error("Set CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY.");
    process.exit(2);
  }
  const { ConvexHttpClient } = await import("convex/browser");
  const client = new ConvexHttpClient(url, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  });
  client.setAdminAuth(adminKey);

  const { userId, allowlist } = parseScopeReportArgs(process.argv.slice(2));
  const report = await aggregateScopeReport(
    (args) => client.function("crystal/scopeReport:operatorScopeReport", undefined, args),
    { userId, allowlist, pageSize: 100 },
  );
  console.log(JSON.stringify(report, null, 2));
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(() => {
    console.error("Scope report failed.");
    process.exit(1);
  });
}
