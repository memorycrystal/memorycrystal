#!/usr/bin/env node
// ILL-174 — official publication metadata and badge wiring stay table-driven.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const table = JSON.parse(
  readFileSync(join(root, "apps/web/public/install-assets/platforms.json"), "utf8"),
);

test("publication lists the six official platforms and the generic-MCP hosts", () => {
  assert.deepEqual(
    table.publication.official.map((entry) => entry.id),
    ["claude-code", "codex-cli", "grok", "openclaw", "hermes", "buzz"],
  );
  assert.deepEqual(
    table.publication.genericMcp.map((entry) => entry.id),
    ["claude-desktop", "codex-desktop", "opencode", "factory-droid"],
  );
  assert.equal(table.publication.hosted.buzz.tier, "hosted");
  assert.equal(table.publication.hosted.buzz.hosted, true);
  assert.equal(table.platforms.buzz, undefined, "Buzz is Hosted, not an installer row");
  for (const host of table.publication.genericMcp) {
    assert.ok(table.platforms[host.id], `${host.id} must remain an installer target`);
  }
});

test("Buzz page installs into hosted CLIs and does not claim channel memory or isolation", () => {
  const buzzPage = readFileSync(join(root, "apps/web/app/buzz/page.tsx"), "utf8");
  const buzzDocs = readFileSync(join(root, "apps/docs/integrations/buzz.mdx"), "utf8");
  for (const source of [buzzPage, buzzDocs]) {
    assert.match(source, /buzz-acp/);
    assert.match(source, /Channel memory is not available/);
    assert.match(source, /not enforced/);
    assert.match(source, /There is no/);
    assert.doesNotMatch(source, /bash -s -- --targets buzz/);
    assert.doesNotMatch(source, /channel memory is available/i);
    assert.doesNotMatch(source, /isolated per channel/i);
  }
});

test("OfficialPlatforms and SupportTierBadge do not hardcode per-platform badge text", () => {
  const official = readFileSync(join(root, "apps/web/app/components/OfficialPlatforms.tsx"), "utf8");
  const badge = readFileSync(join(root, "apps/web/app/components/SupportTierBadge.tsx"), "utf8");
  const tabbed = readFileSync(join(root, "apps/web/app/components/TabbedInstallCommand.tsx"), "utf8");
  const lib = readFileSync(join(root, "apps/web/lib/supportTier.ts"), "utf8");
  assert.match(official, /publishedOfficialPlatforms/);
  assert.match(official, /SupportTierBadge/);
  assert.doesNotMatch(official, /badge:\s*"Full"|badge:\s*"Capture"/);
  assert.match(badge, /supportTierBadgeLabel/);
  assert.match(lib, /row\.hooks\?\.inject === true \? "full" : "capture"/);
  assert.doesNotMatch(tabbed, /label: "OpenClaw"/);
  assert.match(tabbed, /OfficialPlatforms/);
  assert.match(tabbed, /GenericMcpPath/);
});
