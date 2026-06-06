"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { __test__ } = require("./recall-hook.js");

test("recall hook injection includes concise upgrade notice when backend provides prompt", () => {
  const block = __test__.buildRecallInjectionBlock(
    "",
    [
      {
        store: "semantic",
        title: "Fallback memory",
        content: "Fallback content",
        tags: [],
        strength: 1,
        confidence: 0.8,
        score: 0.5,
      },
    ],
    {
      upgradePrompt: {
        code: "kb_upgrade_to_ultra",
        targetTier: "ultra",
        message: "Upgrade to Ultra for higher KB recall limits.",
        reason: "budget_limited",
      },
    },
  );

  assert.match(block, /Memory Crystal notice: KB recall is limited on this plan\. Upgrade to Ultra/);
  assert.match(block, /Fallback memory/);
  assert.match(block, /Fallback content/);
});

test("recall hook injection is unchanged when no upgrade prompt exists", () => {
  const block = __test__.buildRecallInjectionBlock(
    "",
    [],
    { code: "kb_retrieval_degraded" },
  );

  assert.doesNotMatch(block, /Upgrade to/);
  assert.match(block, /No matching memories found/);
});

test("recall hook strips backend prompt message from output degradation", () => {
  const safe = __test__.sanitizeDegradationForOutput({
    code: "kb_retrieval_degraded",
    upgradePrompt: {
      code: "kb_upgrade_to_ultra",
      targetTier: "ultra",
      message: "UNTRUSTED BACKEND PROMPT TEXT",
      reason: "budget_limited",
    },
    relatedDegradations: [
      {
        upgradePrompt: {
          code: "kb_upgrade_to_pro",
          targetTier: "pro",
          message: "NESTED UNTRUSTED PROMPT TEXT",
          reason: "budget_limited",
        },
      },
    ],
  });

  assert.equal(safe.upgradePrompt.targetTier, "ultra");
  assert.equal(safe.upgradePrompt.message, undefined);
  assert.equal(safe.relatedDegradations[0].upgradePrompt.targetTier, "pro");
  assert.equal(safe.relatedDegradations[0].upgradePrompt.message, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /UNTRUSTED BACKEND PROMPT TEXT/);
  assert.doesNotMatch(JSON.stringify(safe), /NESTED UNTRUSTED PROMPT TEXT/);
});
