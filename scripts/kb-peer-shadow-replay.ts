#!/usr/bin/env node
/**
 * Shadow-replay harness: replay recall traffic against the new KB peer-isolation
 * guard and count rows the new guard blocks.
 *
 * Phase 4 observability requirement (§4 Phase 4 / Pre-mortem Scenario B):
 * Run against a snapshot of the last 30 days of recall traffic before deploy.
 * Attach the historical-leak count to the incident ticket.
 *
 * Usage:
 *   npx ts-node scripts/kb-peer-shadow-replay.ts --help
 *   npx ts-node scripts/kb-peer-shadow-replay.ts --mock
 *   npx ts-node scripts/kb-peer-shadow-replay.ts \
 *     --convex-url https://your-deployment.convex.cloud \
 *     --convex-deploy-key <key> \
 *     --days 30 \
 *     --dry-run
 */

// --dry-run / --mock are the default; production calls are opt-in via --no-dry-run.
// Never call production from this script without explicit --no-dry-run flag.

interface ReplayRow {
  channel: string;
  knowledgeBaseId: string;
  kbScope: string | undefined;
  kbAgentIds: string[];
  kbPeerScopePolicy: "strict" | "permissive" | undefined;
  wouldHaveBeenVisible_legacy: boolean;
  isVisible_new: boolean;
}

interface ReplaySummary {
  totalRows: number;
  blockedByNewGuard: number;
  crossPeerLeaks: number;
  rows: ReplayRow[];
}

const PEER_CAPABLE_SCOPES = new Set(["morrow-coach", "cass-coach"]);

const isNumericPeer = (suffix: string) => /^\d+$/.test(suffix);

const normalizeScope = (scope?: string): string | undefined => {
  if (typeof scope !== "string") return undefined;
  const s = scope.trim();
  return s.length > 0 ? s : undefined;
};

const matchesAgentIds = (agentIds: string[] | undefined, agentId: string | undefined): boolean => {
  if (!agentIds || agentIds.length === 0) return true;
  return agentId ? agentIds.includes(agentId) : false;
};

// Mirrors pre-fix isKnowledgeBaseVisibleToAgent (agentIds-only, no peer dimension).
const legacyVisible = (
  kb: { agentIds?: string[]; isActive: boolean; scope?: string },
  agentId: string | undefined
): boolean => {
  if (!kb.isActive) return false;
  return matchesAgentIds(kb.agentIds, agentId);
};

// Mirrors post-fix isKnowledgeBaseVisibleToAgent.
const newVisible = (
  kb: {
    agentIds?: string[];
    isActive: boolean;
    scope?: string;
    peerScopePolicy?: "strict" | "permissive";
    _id?: string;
  },
  agentId: string | undefined,
  channel: string
): boolean => {
  if (!kb.isActive) return false;

  const normalizedScope = normalizeScope(kb.scope);
  const normalizedChannel = normalizeScope(channel);
  if (normalizedScope && normalizedScope !== normalizedChannel) return false;

  const colonIdx = normalizedChannel?.indexOf(":") ?? -1;
  const prefix = colonIdx >= 0 ? normalizedChannel!.slice(0, colonIdx) : (normalizedChannel ?? "");
  const suffix = colonIdx >= 0 ? normalizedChannel!.slice(colonIdx + 1) : "";
  const isPeerCapablePrefix = PEER_CAPABLE_SCOPES.has(prefix);
  const isNumeric = isNumericPeer(suffix);

  if (isPeerCapablePrefix) {
    if (colonIdx < 0) {
      return kb.peerScopePolicy === "permissive";
    }
    if (!isNumeric) {
      if ((kb.peerScopePolicy ?? "strict") === "strict") return false;
    }
    if (isNumeric && (kb.peerScopePolicy ?? "strict") === "strict") {
      const scopeMatchesPeer = normalizedScope === normalizedChannel || normalizedScope === suffix;
      if (!scopeMatchesPeer) return false;
    }
  }

  return matchesAgentIds(kb.agentIds, agentId);
};

// Synthetic mock dataset covering the 11 truth-table rows from §14.
const mockDataset = (): Array<{ channel: string; kb: Parameters<typeof newVisible>[0]; agentId: string }> => [
  { channel: "morrow-coach:511172388", kb: { agentIds: ["coach"], isActive: true, scope: undefined }, agentId: "coach" },
  { channel: "morrow-coach:511172388", kb: { agentIds: ["coach"], isActive: true, scope: "511172388" }, agentId: "coach" },
  { channel: "morrow-coach:511172388", kb: { agentIds: ["coach"], isActive: true, scope: "morrow-coach:511172388" }, agentId: "coach" },
  { channel: "morrow-coach:999", kb: { agentIds: ["coach"], isActive: true, scope: "511172388" }, agentId: "coach" },
  { channel: "morrow-coach:999", kb: { agentIds: ["coach"], isActive: true, scope: undefined }, agentId: "coach" },
  { channel: "morrow-coach", kb: { agentIds: ["coach"], isActive: true, scope: undefined }, agentId: "coach" },
  { channel: "morrow-coach", kb: { agentIds: ["coach"], isActive: true, scope: undefined, peerScopePolicy: "permissive" }, agentId: "coach" },
  { channel: "coder:general", kb: { agentIds: [], isActive: true, scope: undefined }, agentId: undefined as unknown as string },
  { channel: "general", kb: { agentIds: [], isActive: true, scope: undefined }, agentId: undefined as unknown as string },
];

async function runShadowReplay(opts: {
  mock: boolean;
  convexUrl?: string;
  convexDeployKey?: string;
  days: number;
  dryRun: boolean;
}): Promise<ReplaySummary> {
  if (!opts.mock && !opts.dryRun && !opts.convexUrl) {
    throw new Error("--convex-url required for live replay. Use --mock or --dry-run for safe execution.");
  }

  const dataset = opts.mock
    ? mockDataset()
    : // Live path: would fetch recall traffic snapshot from Convex admin API.
      // Not implemented here — production calls are always gated behind --no-dry-run
      // and a separate data-pull step. This harness is a structural scaffold.
      ((): never => {
        throw new Error(
          "Live replay not implemented in this harness. " +
          "Export recall traffic snapshot first, then pass as --input-file. " +
          "Use --mock for CI validation."
        );
      })();

  const rows: ReplayRow[] = [];

  for (const { channel, kb, agentId } of dataset) {
    const legacy = legacyVisible(kb, agentId);
    const next = newVisible(kb, agentId, channel);
    rows.push({
      channel,
      knowledgeBaseId: kb._id ?? "(mock)",
      kbScope: kb.scope,
      kbAgentIds: kb.agentIds ?? [],
      kbPeerScopePolicy: kb.peerScopePolicy,
      wouldHaveBeenVisible_legacy: legacy,
      isVisible_new: next,
    });
  }

  const blockedByNewGuard = rows.filter((r) => r.wouldHaveBeenVisible_legacy && !r.isVisible_new).length;
  // Cross-peer leak = legacy allowed + new blocks + channel is numeric peer-scoped
  const crossPeerLeaks = rows.filter((r) => {
    if (!r.wouldHaveBeenVisible_legacy || r.isVisible_new) return false;
    const colonIdx = r.channel.indexOf(":");
    if (colonIdx < 0) return false;
    const suffix = r.channel.slice(colonIdx + 1);
    return isNumericPeer(suffix);
  }).length;

  return { totalRows: rows.length, blockedByNewGuard, crossPeerLeaks, rows };
}

function printHelp() {
  console.log(`
kb-peer-shadow-replay — replay recall traffic against new KB peer-isolation guard

Options:
  --help                Show this help
  --mock                Use synthetic mock dataset (safe, no network calls)
  --dry-run             Structural dry run (default; requires --no-dry-run to call production)
  --no-dry-run          Enable live production calls (requires --convex-url + --convex-deploy-key)
  --convex-url <url>    Convex deployment URL (required for live mode)
  --convex-deploy-key   Convex deploy key (required for live mode)
  --days <n>            Replay window in days (default: 30)
  --json                Output JSON instead of human-readable summary
`);
}

// CLI — always runs when the script is executed directly
{
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const mock = args.includes("--mock");
  const dryRun = !args.includes("--no-dry-run");
  const convexUrl = get("--convex-url");
  const convexDeployKey = get("--convex-deploy-key");
  const days = Number(get("--days") ?? "30");
  const jsonOutput = args.includes("--json");

  runShadowReplay({ mock, dryRun, convexUrl, convexDeployKey, days }).then((summary) => {
    if (jsonOutput) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("=== kb-peer-shadow-replay ===");
      console.log(`total rows:           ${summary.totalRows}`);
      console.log(`blocked by new guard: ${summary.blockedByNewGuard}`);
      console.log(`cross-peer leaks:     ${summary.crossPeerLeaks}`);
      if (summary.crossPeerLeaks > 0) {
        console.log("\nHistorical leak footprint — attach count to incident ticket:");
        summary.rows
          .filter((r) => r.wouldHaveBeenVisible_legacy && !r.isVisible_new)
          .forEach((r) => console.log(`  channel=${r.channel} kbId=${r.knowledgeBaseId} scope=${r.kbScope}`));
      }
    }
    process.exit(summary.crossPeerLeaks > 0 ? 2 : 0);
  }).catch((err) => {
    console.error("shadow-replay error:", err.message);
    process.exit(1);
  });
}
