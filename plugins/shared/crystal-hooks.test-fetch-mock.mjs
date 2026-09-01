// Fetch mock preload for crystal-hooks.test.mjs.
// Imported via `node --import=file://...` when the test spawns a child.
// Intercepts globalThis.fetch, records each call to an ndjson log file,
// and returns canned JSON based on URL path. Honors AbortSignal so the
// Stop timeout test still proves the hook exits before a 10s first fetch.
import { appendFileSync } from 'node:fs';

const logFile = process.env.CRYSTAL_MOCK_FETCH_LOG;
if (!logFile) throw new Error('CRYSTAL_MOCK_FETCH_LOG must be set to an ndjson file path');

const firstDelayMs = parseInt(process.env.CRYSTAL_TEST_FETCH_FIRST_DELAY_MS || '0', 10);
let callCount = 0;

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

globalThis.fetch = async (url, init) => {
  callCount++;
  const urlStr = String(url);
  let body = null;
  if (init?.body) {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  try { appendFileSync(logFile, `${JSON.stringify({ url: urlStr, body, callCount })}\n`); } catch {}

  if (callCount === 1 && firstDelayMs > 0) {
    await delay(firstDelayMs, init?.signal);
  } else if (init?.signal?.aborted) {
    throw abortError(init.signal);
  }

  let jsonData;
  if (urlStr.includes('/api/mcp/recall')) {
    jsonData = { memories: [{ title: 'should-not-inject' }] };
  } else if (urlStr.includes('/api/mcp/wake')) {
    jsonData = { briefing: 'ok' };
  } else {
    jsonData = { ok: true };
  }
  return {
    ok: true,
    async json() { return jsonData; },
  };
};
