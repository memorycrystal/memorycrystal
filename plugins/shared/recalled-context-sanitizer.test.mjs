import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLogMessagePayload, sanitizeUserMessageContent } from './_lib.mjs';

test('sanitizeUserMessageContent strips complete leading recalled_context envelopes only', () => {
  const input = '<recalled_context><user>old</user></recalled_context>real prompt';
  assert.deepEqual(sanitizeUserMessageContent(input), {
    content: 'real prompt',
    stripped: true,
    strippedChars: 53,
    hadTrailingPrompt: true,
    malformed: false,
  });
});

test('sanitizeUserMessageContent balances nested recalled_context wrappers', () => {
  const input = '<recalled_context><user><recalled_context>old</recalled_context>real</user></recalled_context>next';
  const result = sanitizeUserMessageContent(input);
  assert.equal(result.content, 'next');
  assert.equal(result.stripped, true);
  assert.equal(result.malformed, false);
});

test('sanitizeUserMessageContent preserves mid-message literal tags', () => {
  const input = 'explain <recalled_context> as a tag';
  assert.equal(sanitizeUserMessageContent(input).content, input);
  assert.equal(sanitizeUserMessageContent(input).stripped, false);
});

test('normalizeLogMessagePayload skips wrapper-only or malformed user payloads', () => {
  assert.equal(normalizeLogMessagePayload({ role: 'user', content: '<recalled_context>only</recalled_context>' }), null);
  assert.equal(normalizeLogMessagePayload({ role: 'user', content: '<recalled_context>broken' }), null);
  assert.deepEqual(
    normalizeLogMessagePayload({ role: 'user', content: '<recalled_context>old</recalled_context>prompt', channel: 'x' }),
    { role: 'user', content: 'prompt', channel: 'x' },
  );
});
