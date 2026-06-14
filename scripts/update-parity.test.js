"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

test("all published update scripts stay byte-identical", () => {
  const canonical = fs.readFileSync(path.join(REPO_ROOT, "plugin", "update.sh"), "utf8");
  const scriptsCopy = fs.readFileSync(path.join(REPO_ROOT, "scripts", "update.sh"), "utf8");
  const publicCopy = fs.readFileSync(path.join(REPO_ROOT, "apps", "web", "public", "update.sh"), "utf8");

  assert.equal(scriptsCopy, canonical, "scripts/update.sh drifted from plugin/update.sh");
  assert.equal(publicCopy, canonical, "apps/web/public/update.sh drifted from plugin/update.sh");
});
