import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const installers = [
  "apps/web/public/install-claude-mcp.sh",
  "apps/web/public/install-codex-mcp.sh",
  "apps/web/public/install-droid-mcp.sh",
];

test("every installer SHA256 pin matches its mirrored plugin asset", () => {
  const assetByPin = {
    HOOK_SCRIPT_SHA256: "crystal-hooks.mjs",
    HOOK_HELPER_SHA256: "install-hook-config.mjs",
    HOOK_LIB_SHA256: "_lib.mjs",
    HOOK_SWEEP_SHA256: "crystal-hooks-sweep.mjs",
    SWEEP_SCRIPT_SHA256: "crystal-hooks-sweep.mjs",
    SWEEP_LAUNCHD_SHA256: "install-sweep-launchd.mjs",
    FEATURES_HELPER_SHA256: "ensure-codex-hooks-flag.mjs",
    INSTRUCTIONS_SHA256: "MEMORY_CRYSTAL_INSTRUCTIONS.md",
  };
  for (const path of installers) {
    const script = readFileSync(resolve(repoRoot, path), "utf8");
    const pins = [...script.matchAll(/^([A-Z][A-Z0-9_]*)_SHA256="([a-f0-9]{64})"$/gm)];
    assert.ok(pins.length > 0, `${path} must declare file hash pins`);
    for (const [, name, pin] of pins) {
      const asset = assetByPin[`${name}_SHA256`];
      assert.ok(asset, `${path} has an unmapped ${name}_SHA256 pin`);
      const mirrored = readFileSync(resolve(repoRoot, "apps/web/public/plugins/shared", asset));
      const digest = createHash("sha256").update(mirrored).digest("hex");
      assert.equal(pin, digest, `${path} ${name}_SHA256 must match mirrored ${asset}`);
    }
  }
});
