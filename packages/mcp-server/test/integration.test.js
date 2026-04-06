#!/usr/bin/env node
import assert from 'node:assert/strict';

const API_KEY = process.env.MEMORY_CRYSTAL_API_KEY || '17ccc2f1a19bb08fcdd1958148ba69f51af511a5b348a4ba1ad8b02d6de01949';
const BACKEND_URL = process.env.MEMORY_CRYSTAL_BACKEND_URL || 'http://localhost:3100';
const MCP_URL = process.env.MEMORY_CRYSTAL_MCP_URL || 'https://api.memorycrystal.ai/mcp';
const WAIT_MS = Number(process.env.MEMORY_CRYSTAL_ASYNC_WAIT_MS || 25000);

const authHeaders = {
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

const testResults = [];
const observations = [];

function log(msg = '') {
  process.stdout.write(`${msg}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method, path, body, options = {}) {
  const { withAuth = true, extraHeaders = {} } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (withAuth) {
    headers.Authorization = `Bearer ${API_KEY}`;
  }

  const response = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload, text };
}

function parseSseJson(text) {
  const lines = String(text).split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  assert.ok(dataLines.length > 0, `Expected SSE data lines, got: ${text}`);
  return JSON.parse(dataLines.join('\n'));
}

async function mcp(method, params) {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await response.text();
  return { response, text, payload: parseSseJson(text) };
}

function parseToolTextAsJson(payload) {
  const text = payload?.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `Missing MCP tool text payload: ${JSON.stringify(payload)}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse MCP tool text JSON: ${text}\n${error}`);
  }
}

async function run(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    testResults.push({ name, status: 'PASS', ms });
    log(`PASS ${name} (${ms}ms)`);
  } catch (error) {
    const ms = Date.now() - started;
    testResults.push({ name, status: 'FAIL', ms, error: error?.stack || String(error) });
    log(`FAIL ${name} (${ms}ms)`);
    log(String(error?.stack || error));
    process.exitCode = 1;
  }
}

const stamp = Date.now();
const uniqueTitle = `Gemini integration test ${stamp}`;
const uniqueContent = [
  `Gerald deployed the MCP server on Railway for Andy during live Gemini integration testing ${stamp}.`,
  'Ray Fernando asked about importing memories and self-hosting.',
  'This memory exists to verify async Gemini embeddings and graph enrichment.',
].join(' ');
const semanticQuery = `Railway deployment self-hosting import memories question ${stamp}`;
const uniqueMessageToken = `stm-integration-${stamp}`;
const uniqueChannel = `integration-channel-${stamp}`;
const uniqueSessionKey = `integration-session-${stamp}`;
const checkpointLabel = `compaction-checkpoint-${stamp}`;

let capturedMemoryId = null;
let recallPayload = null;
let recallWithMessagesPayload = null;
let memoryPayload = null;
let statsPayload = null;
let graphStatusPayload = null;
let checkpointId = null;
let stmUserMessageId = null;
let stmAssistantMessageId = null;

await run('1. capture memory through /api/mcp/capture', async () => {
  const { response, payload } = await api('POST', '/api/mcp/capture', {
    title: uniqueTitle,
    content: uniqueContent,
    store: 'semantic',
    category: 'fact',
    tags: ['integration-test', 'gemini', String(stamp)],
  });

  assert.equal(response.status, 200, `capture status ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.ok, true, `capture payload: ${JSON.stringify(payload)}`);
  assert.equal(typeof payload?.id, 'string');
  capturedMemoryId = payload.id;
});

await run(`2. wait ${WAIT_MS}ms for async embedding + graph jobs`, async () => {
  assert.ok(capturedMemoryId, 'memoryId missing before wait');
  await sleep(WAIT_MS);
});

await run('3. recall semantically related memory through /api/mcp/recall', async () => {
  const primary = await api('POST', '/api/mcp/recall', {
    query: semanticQuery,
    limit: 50,
  });

  assert.equal(primary.response.status, 200, `recall status ${primary.response.status}: ${JSON.stringify(primary.payload)}`);
  assert.ok(Array.isArray(primary.payload?.memories), `recall payload: ${JSON.stringify(primary.payload)}`);

  let payload = primary.payload;
  let match = payload.memories.find((memory) => memory._id === capturedMemoryId || memory.title === uniqueTitle);

  if (!match) {
    const fallback = await api('POST', '/api/mcp/recall', {
      query: uniqueTitle,
      limit: 50,
    });
    assert.equal(fallback.response.status, 200, `fallback recall status ${fallback.response.status}: ${JSON.stringify(fallback.payload)}`);
    assert.ok(Array.isArray(fallback.payload?.memories), `fallback recall payload: ${JSON.stringify(fallback.payload)}`);
    payload = fallback.payload;
    match = payload.memories.find((memory) => memory._id === capturedMemoryId || memory.title === uniqueTitle);
  }

  assert.ok(match, `Expected captured memory in recall results. Payload: ${JSON.stringify(payload)}`);
  assert.equal(typeof match.score, 'number');
  assert.ok(match.score > 0, `Expected positive semantic score, got ${match.score}`);
  recallPayload = payload;
});

await run('4. inspect raw memory through /api/mcp/memory', async () => {
  const { response, payload } = await api('POST', '/api/mcp/memory', { memoryId: capturedMemoryId });
  assert.equal(response.status, 200, `memory status ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.memory?.id, capturedMemoryId);
  assert.equal(payload?.memory?.title, uniqueTitle);
  memoryPayload = payload;

  const memory = payload.memory || {};
  assert.equal(memory.graphEnriched, true, `Expected graphEnriched=true, got ${JSON.stringify(memory)}`);
  assert.equal(typeof memory.graphEnrichedAt, 'number', `Expected graphEnrichedAt number, got ${JSON.stringify(memory)}`);
  assert.ok(memory.graphEnrichedAt > 0, `Expected graphEnrichedAt > 0, got ${memory.graphEnrichedAt}`);

  observations.push({
    endpoint: '/api/mcp/memory',
    hasEmbeddingField: Object.prototype.hasOwnProperty.call(memory, 'embedding'),
    hasGraphEnrichedField: Object.prototype.hasOwnProperty.call(memory, 'graphEnriched'),
    hasGraphEnrichedAtField: Object.prototype.hasOwnProperty.call(memory, 'graphEnrichedAt'),
    graphEnriched: memory.graphEnriched,
    graphEnrichedAt: memory.graphEnrichedAt,
  });
});

await run('5. embedding verification via externally visible API behavior', async () => {
  const match = recallPayload?.memories?.find((memory) => memory._id === capturedMemoryId || memory.title === uniqueTitle);
  assert.ok(match, 'Captured memory missing from recall payload');

  const recallMemory = match || {};
  const directEmbedding = recallMemory.embedding ?? memoryPayload?.memory?.embedding;
  if (Array.isArray(directEmbedding) && directEmbedding.length > 0) {
    assert.equal(directEmbedding.length, 3072, `Expected 3072-dim embedding, got ${directEmbedding.length}`);
    assert.ok(directEmbedding.some((value) => typeof value === 'number' && Number.isFinite(value) && value !== 0));
    observations.push({ endpoint: 'direct-memory-surface', embeddingExposed: true, embeddingLength: directEmbedding.length });
    return;
  }

  observations.push({
    endpoint: 'public-memory-surfaces',
    embeddingExposed: false,
    conclusion: 'Embedding is not exposed on /api/mcp/recall or /api/mcp/memory; verified indirectly by semantic recall score > 0.',
  });

  assert.ok(match.score > 0, 'Positive semantic vector score is required when embedding is hidden');
});

await run('6. log deterministic STM messages through /api/mcp/log', async () => {
  const userMessage = `User message ${uniqueMessageToken}: checkpoint before compaction preserves context.`;
  const assistantMessage = `Assistant reply ${uniqueMessageToken}: after compaction we recall from STM + LTM.`;

  const first = await api('POST', '/api/mcp/log', {
    role: 'user',
    content: userMessage,
    channel: uniqueChannel,
    sessionKey: uniqueSessionKey,
  });
  assert.equal(first.response.status, 200, `first log status ${first.response.status}: ${JSON.stringify(first.payload)}`);
  assert.equal(first.payload?.ok, true, `first log payload: ${JSON.stringify(first.payload)}`);
  assert.equal(typeof first.payload?.id, 'string');
  stmUserMessageId = first.payload.id;

  await sleep(15);

  const second = await api('POST', '/api/mcp/log', {
    role: 'assistant',
    content: assistantMessage,
    channel: uniqueChannel,
    sessionKey: uniqueSessionKey,
  });
  assert.equal(second.response.status, 200, `second log status ${second.response.status}: ${JSON.stringify(second.payload)}`);
  assert.equal(second.payload?.ok, true, `second log payload: ${JSON.stringify(second.payload)}`);
  assert.equal(typeof second.payload?.id, 'string');
  stmAssistantMessageId = second.payload.id;
});

await run('7. /api/mcp/recent-messages returns the logged STM messages with filters', async () => {
  const { response, payload } = await api('POST', '/api/mcp/recent-messages', {
    limit: 10,
    channel: uniqueChannel,
    sessionKey: uniqueSessionKey,
  });

  assert.equal(response.status, 200, `recent-messages status ${response.status}: ${JSON.stringify(payload)}`);
  assert.ok(Array.isArray(payload?.messages), `recent-messages payload: ${JSON.stringify(payload)}`);

  const messages = payload.messages;
  const ids = messages.map((message) => message.messageId || message._id || message.id);
  assert.ok(ids.includes(stmUserMessageId), `Expected user message ${stmUserMessageId} in filtered recent list`);
  assert.ok(ids.includes(stmAssistantMessageId), `Expected assistant message ${stmAssistantMessageId} in filtered recent list`);

  const assistantIdx = ids.indexOf(stmAssistantMessageId);
  const userIdx = ids.indexOf(stmUserMessageId);
  assert.ok(assistantIdx !== -1 && userIdx !== -1, 'Both logged message ids must be present');
  assert.ok(userIdx < assistantIdx, `Expected chronological ordering (oldest -> newest). ids=${JSON.stringify(ids)}`);

  for (let i = 1; i < messages.length; i += 1) {
    const prevTs = Number(messages[i - 1]?.timestamp || 0);
    const currTs = Number(messages[i]?.timestamp || 0);
    assert.ok(currTs >= prevTs, `Expected recent-messages timestamps to be ascending. prev=${prevTs} curr=${currTs}`);
  }

  const badScope = messages.find((message) => message.channel !== uniqueChannel || message.sessionKey !== uniqueSessionKey);
  assert.equal(badScope, undefined, `Found out-of-scope message in filtered results: ${JSON.stringify(badScope)}`);
});

await run('8. /api/mcp/search-messages finds the deterministic STM token', async () => {
  const { response, payload } = await api('POST', '/api/mcp/search-messages', {
    query: uniqueMessageToken,
    limit: 5,
    channel: uniqueChannel,
    sinceMs: Date.now() - 60 * 60 * 1000,
  });

  assert.equal(response.status, 200, `search-messages status ${response.status}: ${JSON.stringify(payload)}`);
  assert.ok(Array.isArray(payload?.messages), `search-messages payload: ${JSON.stringify(payload)}`);
  assert.ok(payload.messages.length > 0, `Expected at least one message match for ${uniqueMessageToken}`);

  const top = payload.messages[0];
  assert.equal(typeof top.score, 'number', `Expected numeric score, got ${JSON.stringify(top)}`);
  assert.ok(top.score > 0, `Expected positive score for search hit, got ${top.score}`);

  const matched = payload.messages.find((message) =>
    String(message.content || '').includes(uniqueMessageToken) &&
    (message.messageId === stmUserMessageId || message.messageId === stmAssistantMessageId)
  );
  assert.ok(matched, `Expected deterministic STM message in search results. Payload: ${JSON.stringify(payload)}`);

  observations.push({ endpoint: '/api/mcp/search-messages', matchedMessageId: matched.messageId, score: matched.score });
});

await run('9. /api/mcp/recall returns messageMatches that include deterministic STM evidence', async () => {
  const { response, payload } = await api('POST', '/api/mcp/recall', {
    query: uniqueMessageToken,
    limit: 10,
    channel: uniqueChannel,
  });

  assert.equal(response.status, 200, `recall status ${response.status}: ${JSON.stringify(payload)}`);
  assert.ok(Array.isArray(payload?.messageMatches), `Expected messageMatches array in recall payload: ${JSON.stringify(payload)}`);
  assert.ok(payload.messageMatches.length > 0, 'Expected recall to surface STM message matches');

  const matched = payload.messageMatches.find((message) =>
    String(message.content || '').includes(uniqueMessageToken) &&
    (message.messageId === stmUserMessageId || message.messageId === stmAssistantMessageId)
  );
  assert.ok(matched, `Expected deterministic STM match in recall.messageMatches. Payload: ${JSON.stringify(payload)}`);
  recallWithMessagesPayload = payload;
});

await run('10. POST /api/mcp/checkpoint', async () => {
  const { response, payload } = await api('POST', '/api/mcp/checkpoint', {
    label: checkpointLabel,
    description: `Checkpoint to verify compaction-aware capture path ${stamp}`,
  });

  assert.equal(response.status, 200, `checkpoint status ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.ok, true, `checkpoint payload: ${JSON.stringify(payload)}`);
  assert.equal(typeof payload?.id, 'string');
  checkpointId = payload.id;
});

await run('11. GET /api/mcp/graph-status', async () => {
  const { response, payload } = await api('GET', '/api/mcp/graph-status');
  assert.equal(response.status, 200, `graph-status status ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.ok, true, `graph-status payload: ${JSON.stringify(payload)}`);
  assert.equal(typeof payload?.totalNodes, 'number');
  assert.equal(typeof payload?.totalRelations, 'number');
  assert.equal(typeof payload?.enrichedMemories, 'number');
  assert.equal(typeof payload?.totalMemories, 'number');
  assert.equal(typeof payload?.enrichmentPercent, 'number');
  assert.ok(payload.totalNodes > 0, `Expected totalNodes > 0, got ${JSON.stringify(payload)}`);
  assert.ok(payload.totalRelations > 0, `Expected totalRelations > 0, got ${JSON.stringify(payload)}`);
  assert.ok(payload.enrichedMemories > 0, `Expected enrichedMemories > 0, got ${JSON.stringify(payload)}`);

  const expectedPercent = payload.totalMemories > 0
    ? Math.round((payload.enrichedMemories / payload.totalMemories) * 100)
    : 0;
  assert.equal(payload.enrichmentPercent, expectedPercent, `Enrichment percent mismatch: ${JSON.stringify(payload)}`);

  graphStatusPayload = payload;
  observations.push({ endpoint: '/api/mcp/graph-status', ...payload });
});

await run('12. GET /api/mcp/stats with store total consistency checks', async () => {
  const { response, payload } = await api('GET', '/api/mcp/stats');
  assert.equal(response.status, 200, `stats status ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(typeof payload?.total, 'number');
  assert.equal(typeof payload?.byStore, 'object');
  for (const key of ['sensory', 'episodic', 'semantic', 'procedural', 'prospective']) {
    assert.equal(typeof payload?.byStore?.[key], 'number', `Missing byStore.${key}`);
  }

  const byStoreTotal = Object.values(payload.byStore).reduce((sum, n) => sum + Number(n || 0), 0);
  assert.equal(byStoreTotal, payload.total, `Expected byStore sum to equal total. payload=${JSON.stringify(payload)}`);

  if (graphStatusPayload) {
    assert.equal(
      payload.total,
      graphStatusPayload.totalMemories,
      `Expected stats.total to equal graph-status.totalMemories. stats=${JSON.stringify(payload)} graph=${JSON.stringify(graphStatusPayload)}`
    );
  }

  statsPayload = payload;
});

await run('13. unauthorized request is rejected (auth guard evidence)', async () => {
  const { response, payload } = await api('GET', '/api/mcp/stats', undefined, { withAuth: false });
  assert.equal(response.status, 401, `Expected 401 for unauthenticated request, got ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.error, 'Unauthorized', `Unexpected unauthorized payload: ${JSON.stringify(payload)}`);
});

await run('14. POST /api/mcp/reflect', async () => {
  const { response, payload } = await api('POST', '/api/mcp/reflect', { windowHours: 1 });
  assert.equal(response.status, 200, `reflect status ${response.status}: ${JSON.stringify(payload)}`);
  assert.equal(payload?.ok, true, `reflect payload: ${JSON.stringify(payload)}`);
  assert.equal(typeof payload?.stats, 'object');
});

await run('15. MCP initialize through https://api.memorycrystal.ai/mcp', async () => {
  const { response, payload } = await mcp('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'gemini-integration-test', version: '1.0.0' },
  });
  assert.equal(response.status, 200, `MCP initialize status ${response.status}`);
  assert.equal(payload?.result?.protocolVersion, '2025-03-26');
  assert.equal(typeof payload?.result?.capabilities, 'object');
});

await run('16. MCP tools/list exposes expected tool surface', async () => {
  const { response, payload } = await mcp('tools/list', {});
  assert.equal(response.status, 200, `MCP tools/list status ${response.status}`);
  const tools = payload?.result?.tools;
  assert.ok(Array.isArray(tools), `tools/list payload: ${JSON.stringify(payload)}`);
  const names = new Set(tools.map((tool) => tool?.name));

  const expected = ['memory_search', 'memory_save', 'memory_checkpoint', 'search_messages', 'recent_messages', 'memory_stats'];
  for (const name of expected) {
    assert.ok(names.has(name), `Expected MCP tool '${name}' in tools/list. got=${JSON.stringify([...names])}`);
  }
});

await run('17. MCP tools/call memory_stats returns structured totals', async () => {
  const { response, payload } = await mcp('tools/call', {
    name: 'memory_stats',
    arguments: {},
  });
  assert.equal(response.status, 200, `MCP tools/call status ${response.status}`);
  assert.ok(!payload?.error, `MCP tools/call error payload: ${JSON.stringify(payload)}`);

  const parsed = parseToolTextAsJson(payload);
  assert.equal(typeof parsed.total, 'number', `memory_stats parsed payload: ${JSON.stringify(parsed)}`);
  assert.equal(typeof parsed.byStore, 'object', `memory_stats parsed payload: ${JSON.stringify(parsed)}`);
});

await run('18. MCP tools/call search_messages finds deterministic STM token', async () => {
  const { response, payload } = await mcp('tools/call', {
    name: 'search_messages',
    arguments: {
      query: uniqueMessageToken,
      limit: 5,
    },
  });
  assert.equal(response.status, 200, `MCP tools/call search_messages status ${response.status}`);
  assert.ok(!payload?.error, `MCP search_messages error payload: ${JSON.stringify(payload)}`);

  const parsed = parseToolTextAsJson(payload);
  assert.ok(Array.isArray(parsed.messages), `Expected messages array from MCP search_messages: ${JSON.stringify(parsed)}`);
  assert.ok(parsed.messages.length > 0, `Expected at least one search_messages hit for token ${uniqueMessageToken}`);

  const matched = parsed.messages.find((message) => String(message.content || '').includes(uniqueMessageToken));
  assert.ok(matched, `Expected deterministic STM token in MCP search_messages results: ${JSON.stringify(parsed)}`);
});

await run('19. MCP tools/call memory_checkpoint creates a checkpoint', async () => {
  const { response, payload } = await mcp('tools/call', {
    name: 'memory_checkpoint',
    arguments: {
      summary: `MCP checkpoint verification ${stamp}`,
    },
  });
  assert.equal(response.status, 200, `MCP tools/call memory_checkpoint status ${response.status}`);
  assert.ok(!payload?.error, `MCP memory_checkpoint error payload: ${JSON.stringify(payload)}`);

  const parsed = parseToolTextAsJson(payload);
  assert.equal(parsed?.ok, true, `Expected ok=true from MCP memory_checkpoint: ${JSON.stringify(parsed)}`);
  assert.equal(typeof parsed?.id, 'string', `Expected checkpoint id from MCP memory_checkpoint: ${JSON.stringify(parsed)}`);
});

log('\n=== SUMMARY ===');
for (const result of testResults) {
  log(`${result.status} ${result.name}${result.error ? `\n${result.error}` : ''}`);
}

log('\n=== OBSERVATIONS ===');
for (const item of observations) {
  log(JSON.stringify(item));
}

if (statsPayload) {
  log('\n=== FINAL STATS SNAPSHOT ===');
  log(JSON.stringify(statsPayload, null, 2));
}

if (capturedMemoryId) {
  log(`\nCaptured memory ID: ${capturedMemoryId}`);
}

if (checkpointId) {
  log(`Checkpoint ID: ${checkpointId}`);
}

if (recallWithMessagesPayload) {
  log(`Recall messageMatches count: ${recallWithMessagesPayload.messageMatches?.length ?? 0}`);
}

if (process.exitCode) {
  log('\nIntegration test suite failed.');
} else {
  log('\nIntegration test suite passed.');
}
