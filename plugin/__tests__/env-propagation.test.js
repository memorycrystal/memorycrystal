const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');

const hookPath = join(__dirname, '..', 'recall-hook.js');

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

test('recall hook honors CRYSTAL_CONVEX_URL for authenticated MCP recall', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/mcp/recall') {
      res.end(JSON.stringify({
        memories: [{
          memoryId: 'mem_1',
          store: 'semantic',
          category: 'fact',
          title: 'local backend propagation',
          content: 'Recall request reached the configured local endpoint.',
          strength: 1,
          confidence: 1,
          tags: ['local'],
          score: 0.9,
        }],
      }));
      return;
    }
    res.end(JSON.stringify({ messages: [] }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const tempDir = mkdtempSync(join(tmpdir(), 'crystal-env-prop-'));
  const fetchStub = join(tempDir, 'fetch-stub.cjs');
  writeFileSync(fetchStub, `
const originalFetch = global.fetch;
global.fetch = async (url, init) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    return new Response(JSON.stringify({ embedding: { values: Array.from({ length: 3072 }, () => 0.001) } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(url, init);
};
`, 'utf8');

  try {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${fetchStub}`.trim(),
        CRYSTAL_CONVEX_URL: `http://127.0.0.1:${port}`,
        CONVEX_URL: 'https://convex.memorycrystal.ai',
        CRYSTAL_API_KEY: 'local-dev-bearer-token',
        GEMINI_EMBEDDING_MODEL: 'gemini-embedding-2-preview',
        EMBEDDING_PROVIDER: 'gemini',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end(JSON.stringify({ query: 'what do you remember about local backend propagation?', channel: 'test', sessionKey: 's1' }));
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'));
    const payload = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    assert.match(payload.injectionBlock, /local backend propagation/);

    const recallRequest = requests.find((request) => request.url === '/api/mcp/recall');
    assert.ok(recallRequest, 'expected recall request to hit stub MCP server');
    assert.equal(recallRequest.authorization, 'Bearer local-dev-bearer-token');
    assert.equal(recallRequest.body.query, 'what do you remember about local backend propagation?');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});
