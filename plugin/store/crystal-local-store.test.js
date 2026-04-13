/**
 * crystal-local-store tests
 * Run: node --test crystal-local-store.test.js
 *
 * Uses Node's built-in node:test + node:assert. No external deps needed.
 * better-sqlite3 must be installed (or available via the OpenClaw runtime).
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

import { CrystalLocalStore, checkSqliteAvailability } from './crystal-local-store.js';

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

function makeTmpDb() {
  return join(tmpdir(), `crystal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function openStore(dbPath) {
  const store = new CrystalLocalStore();
  store.init(dbPath);
  return store;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CrystalLocalStore', () => {
  // Skip entire suite when better-sqlite3 is unavailable
  const avail = checkSqliteAvailability();
  if (!avail.available) {
    test('SKIP — better-sqlite3 not available: ' + avail.error, () => {
      // pass — no-op stub behaviour covered in separate suite below
    });
    // eslint-disable-next-line no-undef
    return;
  }

  // 1. init() creates DB and all tables
  test('init() creates DB file and all schema tables', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      assert.ok(existsSync(dbPath), 'DB file should exist after init()');

      // Verify tables exist by querying sqlite_master
      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name);

      for (const tbl of ['conversations', 'messages', 'summaries', 'summary_parents', 'summary_messages', 'context_items', 'lesson_counter']) {
        assert.ok(tables.includes(tbl), `Table ${tbl} should exist`);
      }
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('init() applies WAL guardrail pragmas', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const journalMode = store.db.prepare('PRAGMA journal_mode').get();
      const walAutocheckpoint = store.db.prepare('PRAGMA wal_autocheckpoint').get();
      const journalSizeLimit = store.db.prepare('PRAGMA journal_size_limit').get();
      const cacheSize = store.db.prepare('PRAGMA cache_size').get();
      const mmapSize = store.db.prepare('PRAGMA mmap_size').get();

      assert.equal(journalMode.journal_mode, 'wal');
      assert.equal(walAutocheckpoint.wal_autocheckpoint, 200);
      assert.equal(journalSizeLimit.journal_size_limit, 16777216);
      assert.equal(cacheSize.cache_size, -8192);
      assert.equal(mmapSize.mmap_size, 0);
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 2. getOrCreateConversation() — idempotent
  test('getOrCreateConversation() is idempotent', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const id1 = store.getOrCreateConversation('sess:abc');
      const id2 = store.getOrCreateConversation('sess:abc');
      const id3 = store.getOrCreateConversation('sess:abc');
      assert.ok(typeof id1 === 'number', 'should return a number');
      assert.equal(id1, id2, 'same key → same id');
      assert.equal(id2, id3, 'still same on third call');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 3. addMessage() — stores and returns messageId, increments seq
  test('addMessage() returns unique ids and increments seq', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const id1 = store.addMessage('sess:msg', 'user', 'hello');
      const id2 = store.addMessage('sess:msg', 'assistant', 'world');
      assert.ok(typeof id1 === 'number', 'messageId should be a number');
      assert.ok(typeof id2 === 'number', 'second messageId should be a number');
      assert.notEqual(id1, id2, 'messageIds should differ');

      // Check seq incremented
      const msgs = store.getRecentMessages('sess:msg', 10);
      const seqs = msgs.map((m) => m.seq).sort((a, b) => a - b);
      assert.deepEqual(seqs, [0, 1], 'seq values should be 0 and 1');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 4. getRecentMessages() — returns in order, respects limit
  test('getRecentMessages() returns newest-first and respects limit', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      for (let i = 0; i < 5; i++) store.addMessage('sess:recent', 'user', `msg ${i}`);

      const top2 = store.getRecentMessages('sess:recent', 2);
      assert.equal(top2.length, 2, 'limit respected');
      assert.ok(top2[0].seq > top2[1].seq, 'newest first');

      const all = store.getRecentMessages('sess:recent', 100);
      assert.equal(all.length, 5, 'all 5 messages returned');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 5. searchMessages() — finds substring matches
  test('searchMessages() finds substring matches', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      store.addMessage('sess:search', 'user', 'the quick brown fox');
      store.addMessage('sess:search', 'assistant', 'jumped over the lazy dog');
      store.addMessage('sess:search', 'user', 'nothing relevant here');

      const results = store.searchMessages('sess:search', 'fox');
      assert.equal(results.length, 1, 'one message matches "fox"');
      assert.ok(results[0].content.includes('fox'));

      const multi = store.searchMessages('sess:search', 'the');
      assert.ok(multi.length >= 2, '"the" appears in multiple messages');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 6. createLeafSummary() — creates summary, replaces source messages in context_items
  test('createLeafSummary() replaces message context_items with summary', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:leaf';
      const m1 = store.addMessage(key, 'user', 'message one');
      const m2 = store.addMessage(key, 'assistant', 'message two');

      const sumId = store.createLeafSummary(key, 'summary of one and two', [m1, m2]);
      assert.ok(typeof sumId === 'string', 'summaryId should be a string');
      assert.ok(sumId.startsWith('sum_'), 'summaryId should start with sum_');

      const items = store.getContextItems(key);
      const types = items.map((i) => i.itemType);
      assert.ok(!types.includes('message'), 'no message items should remain after summarization');
      assert.ok(types.includes('summary'), 'summary item should be present');
      assert.equal(items.filter((i) => i.itemType === 'summary').length, 1, 'exactly one summary item');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 7. getContextItems() — returns ordered items
  test('getContextItems() returns items in ordinal order', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:ctx';
      store.addMessage(key, 'user', 'first');
      store.addMessage(key, 'assistant', 'second');
      store.addMessage(key, 'user', 'third');

      const items = store.getContextItems(key);
      assert.equal(items.length, 3);
      for (let i = 1; i < items.length; i++) {
        assert.ok(items[i].ordinal > items[i - 1].ordinal, 'ordinals should increase');
      }
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 8. getTokenCount() — returns a number
  test('getTokenCount() returns a non-negative number', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:tokens';
      const count0 = store.getTokenCount(key);
      assert.ok(typeof count0 === 'number', 'should be a number');
      assert.ok(count0 >= 0, 'should be non-negative');

      store.addMessage(key, 'user', 'hello world'); // ~3 tokens
      const count1 = store.getTokenCount(key);
      assert.ok(count1 > 0, 'token count should increase after adding a message');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 9. close() — closes without error and is idempotent
  test('close() closes without error and is idempotent', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      assert.doesNotThrow(() => store.close(), 'first close should not throw');
      assert.doesNotThrow(() => store.close(), 'second close should not throw');
      assert.equal(store.db, null, 'db should be null after close');
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 9b. incrementLessonCount() creates and increments counts
  test('incrementLessonCount() creates and increments counts', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:lesson';
      const topic = 'topic-alpha';
      assert.equal(store.incrementLessonCount(key, topic), 1);
      assert.equal(store.incrementLessonCount(key, topic), 2);
      assert.equal(store.incrementLessonCount(key, topic), 3);
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 9c. getLessonCountsForSession() returns topics above minimum count
  test('getLessonCountsForSession() filters by minCount', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:lesson';
      store.incrementLessonCount(key, 'topic-alpha');
      store.incrementLessonCount(key, 'topic-alpha');
      store.incrementLessonCount(key, 'topic-beta');
      const rows = store.getLessonCountsForSession(key, 2);
      assert.equal(rows.length, 1, 'only one topic should meet minCount');
      assert.equal(rows[0].topic, 'topic-alpha');
      assert.equal(rows[0].count, 2);
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 10. getMessageById() — returns correct shape
  test('getMessageById(id) returns correct message shape', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const msgId = store.addMessage('sess:getmsg', 'user', 'hello from test');
      const result = store.getMessageById(msgId);
      assert.ok(result !== null, 'should return a message');
      assert.equal(result.messageId, msgId, 'messageId matches');
      assert.equal(result.role, 'user', 'role matches');
      assert.equal(result.content, 'hello from test', 'content matches');
      assert.ok(typeof result.tokenCount === 'number', 'tokenCount is a number');
      assert.ok(result.tokenCount >= 0, 'tokenCount is non-negative');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 11. getMessageById() — returns null for nonexistent
  test('getMessageById("nonexistent") returns null', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      store.getOrCreateConversation('sess:getmsg2');
      const result = store.getMessageById(99999);
      assert.equal(result, null, 'nonexistent id should return null');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 12. getSummary() — returns correct shape after createLeafSummary
  test('getSummary(id) returns correct shape after createLeafSummary()', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:getsum';
      const m1 = store.addMessage(key, 'user', 'msg one');
      const m2 = store.addMessage(key, 'assistant', 'msg two');
      const sumId = store.createLeafSummary(key, 'a leaf summary', [m1, m2]);
      assert.ok(sumId, 'summary should be created');
      const result = store.getSummary(sumId);
      assert.ok(result !== null, 'should return a summary');
      assert.equal(result.summaryId, sumId, 'summaryId matches');
      assert.equal(result.kind, 'leaf', 'kind is leaf');
      assert.equal(result.depth, 0, 'depth is 0');
      assert.equal(result.content, 'a leaf summary', 'content matches');
      assert.ok(typeof result.tokenCount === 'number', 'tokenCount is a number');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 13. getSummary() — returns null for nonexistent
  test('getSummary("nonexistent") returns null', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      store.getOrCreateConversation('sess:getsum2');
      const result = store.getSummary('sum_doesnotexist');
      assert.equal(result, null, 'nonexistent id should return null');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 14. getContextItems() message items have both refId and messageId
  test('getContextItems() message items have both refId and messageId set to same value', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:ctxfields';
      store.addMessage(key, 'user', 'test msg');
      const items = store.getContextItems(key);
      const msgItems = items.filter((i) => i.itemType === 'message');
      assert.ok(msgItems.length > 0, 'should have message items');
      for (const item of msgItems) {
        assert.ok('refId' in item, 'refId should be present');
        assert.ok('messageId' in item, 'messageId should be present');
        assert.equal(item.refId, item.messageId, 'refId and messageId should be equal');
      }
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 16. getContextTokenCount() — alias for getTokenCount
  test('getContextTokenCount() returns same value as getTokenCount()', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:ctc';
      store.addMessage(key, 'user', 'hello there');
      assert.equal(store.getContextTokenCount(key), store.getTokenCount(key), 'should be equal');
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 17. getDistinctDepthsInContext() — empty when no summaries
  test('getDistinctDepthsInContext() returns [] when no summaries in context', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:depths-empty';
      store.addMessage(key, 'user', 'msg');
      const depths = store.getDistinctDepthsInContext(key);
      assert.deepEqual(depths, [], 'no summaries = empty array');
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 18. getDistinctDepthsInContext() — [0] after one leaf summary
  test('getDistinctDepthsInContext() returns [0] after one leaf summary', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:depths-leaf';
      const m1 = store.addMessage(key, 'user', 'a');
      const m2 = store.addMessage(key, 'assistant', 'b');
      store.createLeafSummary(key, 'leaf content', [m1, m2]);
      const depths = store.getDistinctDepthsInContext(key);
      assert.deepEqual(depths, [0], 'leaf summary has depth 0');
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 19. insertSummary() — inserts a summary row readable by getSummary
  test('insertSummary() inserts a summary row verifiable via getSummary()', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:inssummary';
      const summaryId = `sum_test_${Date.now()}`;
      const result = store.insertSummary({ summaryId, sessionKey: key, kind: 'leaf', depth: 0, content: 'inserted summary', tokenCount: 3 });
      assert.equal(result, summaryId, 'should return summaryId');
      const row = store.getSummary(summaryId);
      assert.ok(row !== null, 'getSummary should find it');
      assert.equal(row.summaryId, summaryId);
      assert.equal(row.kind, 'leaf');
      assert.equal(row.content, 'inserted summary');
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 20. linkSummaryToMessages() — no crash, idempotent
  test('linkSummaryToMessages() inserts links without crash and is idempotent', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:linkmsg';
      const m1 = store.addMessage(key, 'user', 'hello');
      const m2 = store.addMessage(key, 'assistant', 'hi');
      const summaryId = `sum_lm_${Date.now()}`;
      store.insertSummary({ summaryId, sessionKey: key, kind: 'leaf', depth: 0, content: 'test', tokenCount: 1 });
      assert.doesNotThrow(() => store.linkSummaryToMessages(summaryId, [m1, m2]));
      assert.doesNotThrow(() => store.linkSummaryToMessages(summaryId, [m1, m2]), 'second call idempotent');
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 21. linkSummaryToParents() — no crash, idempotent
  test('linkSummaryToParents() inserts parent links without crash and is idempotent', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:linkpar';
      const parentId = `sum_par_${Date.now()}`;
      const childId  = `sum_child_${Date.now()}`;
      store.insertSummary({ summaryId: parentId, sessionKey: key, kind: 'leaf',      depth: 0, content: 'parent', tokenCount: 1 });
      store.insertSummary({ summaryId: childId,  sessionKey: key, kind: 'condensed', depth: 1, content: 'child',  tokenCount: 1 });
      assert.doesNotThrow(() => store.linkSummaryToParents(childId, [parentId]));
      assert.doesNotThrow(() => store.linkSummaryToParents(childId, [parentId]), 'second call idempotent');
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 22. replaceContextRangeWithSummary() — removes messages, inserts summary item
  test('replaceContextRangeWithSummary() removes message context_items and inserts summary item', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:replace';
      store.addMessage(key, 'user', 'one');
      store.addMessage(key, 'assistant', 'two');
      store.addMessage(key, 'user', 'three');
      const before = store.getContextItems(key);
      assert.equal(before.length, 3, 'three items before');
      const minOrd = before[0].ordinal;
      const maxOrd = before[1].ordinal;
      const summaryId = `sum_rpl_${Date.now()}`;
      store.insertSummary({ summaryId, sessionKey: key, kind: 'leaf', depth: 0, content: 'replaced', tokenCount: 1 });
      store.replaceContextRangeWithSummary(key, minOrd, maxOrd, summaryId);
      const after = store.getContextItems(key);
      const msgItems = after.filter((i) => i.itemType === 'message');
      const sumItems = after.filter((i) => i.itemType === 'summary');
      assert.equal(msgItems.length, 1, 'one message item remains (third msg)');
      assert.equal(sumItems.length, 1, 'one summary item inserted');
      assert.equal(sumItems[0].summaryId, summaryId);
      store.close();
    } finally { rmSync(dbPath, { force: true }); }
  });

  // 23. getMessageById() returns createdAt field
  test('getMessageById() returns createdAt as a non-null string', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const msgId = store.addMessage('sess:getmsg-ts', 'user', 'timestamp test');
      const result = store.getMessageById(msgId);
      assert.ok(result !== null, 'should return a message');
      assert.ok('createdAt' in result, 'createdAt field should be present');
      assert.ok(result.createdAt !== null && result.createdAt !== undefined, 'createdAt should not be null');
      assert.ok(typeof result.createdAt === 'string', 'createdAt should be a string');
      assert.ok(result.createdAt.length > 0, 'createdAt should be non-empty');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 24. getSummary() returns earliestAt and latestAt (can be null for manually inserted summaries)
  test('getSummary() returns earliestAt and latestAt fields', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:sumts1';
      const summaryId = `sum_ts1_${Date.now()}`;
      store.insertSummary({ summaryId, sessionKey: key, kind: 'leaf', depth: 0, content: 'ts test', tokenCount: 1 });
      const result = store.getSummary(summaryId);
      assert.ok(result !== null, 'should return summary');
      assert.ok('earliestAt' in result, 'earliestAt field should be present');
      assert.ok('latestAt' in result, 'latestAt field should be present');
      // manually inserted summaries may have null timestamps — that's fine
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 25. getSummary() returns createdAt as a non-null string
  test('getSummary() returns createdAt as a non-null string', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:sumts2';
      const m1 = store.addMessage(key, 'user', 'a');
      const m2 = store.addMessage(key, 'assistant', 'b');
      const sumId = store.createLeafSummary(key, 'ts test summary', [m1, m2]);
      const result = store.getSummary(sumId);
      assert.ok(result !== null, 'should return summary');
      assert.ok('createdAt' in result, 'createdAt field should be present');
      assert.ok(result.createdAt !== null && result.createdAt !== undefined, 'createdAt should not be null');
      assert.ok(typeof result.createdAt === 'string', 'createdAt should be a string');
      assert.ok(result.createdAt.length > 0, 'createdAt should be non-empty');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 26. getSummary() returns parentSummaryIds as empty array when no parents
  test('getSummary() returns parentSummaryIds as empty array when no parents', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:sumparents';
      const m1 = store.addMessage(key, 'user', 'x');
      const sumId = store.createLeafSummary(key, 'lone summary', [m1]);
      const result = store.getSummary(sumId);
      assert.ok(result !== null, 'should return summary');
      assert.ok('parentSummaryIds' in result, 'parentSummaryIds field should be present');
      assert.ok(Array.isArray(result.parentSummaryIds), 'parentSummaryIds should be an array');
      assert.deepEqual(result.parentSummaryIds, [], 'no parents = empty array');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 27. getSummary() returns sourceMessageIds after linkSummaryToMessages
  test('getSummary() returns sourceMessageIds with message ids after linkSummaryToMessages()', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:sumsrcmsgs';
      const m1 = store.addMessage(key, 'user', 'source msg 1');
      const m2 = store.addMessage(key, 'assistant', 'source msg 2');
      const summaryId = `sum_src_${Date.now()}`;
      store.insertSummary({ summaryId, sessionKey: key, kind: 'leaf', depth: 0, content: 'linked summary', tokenCount: 2 });
      store.linkSummaryToMessages(summaryId, [m1, m2]);
      const result = store.getSummary(summaryId);
      assert.ok(result !== null, 'should return summary');
      assert.ok('sourceMessageIds' in result, 'sourceMessageIds field should be present');
      assert.ok(Array.isArray(result.sourceMessageIds), 'sourceMessageIds should be an array');
      assert.ok(result.sourceMessageIds.includes(m1), 'should include m1');
      assert.ok(result.sourceMessageIds.includes(m2), 'should include m2');
      assert.equal(result.sourceMessageIds.length, 2, 'should have exactly 2 message ids');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 28. searchSummariesByRelevance() — finds relevant summaries via FTS5
  test('searchSummariesByRelevance() finds summaries by keyword', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts';
      store.insertSummary({ summaryId: 'sum_fts1', sessionKey: key, kind: 'leaf', depth: 0, content: 'The database migration was completed successfully', tokenCount: 8 });
      store.insertSummary({ summaryId: 'sum_fts2', sessionKey: key, kind: 'leaf', depth: 0, content: 'User authentication uses JWT tokens', tokenCount: 6 });
      store.insertSummary({ summaryId: 'sum_fts3', sessionKey: key, kind: 'condensed', depth: 1, content: 'Database schema changes for the billing module', tokenCount: 7 });

      const results = store.searchSummariesByRelevance('database', 5, key);
      assert.ok(results.length >= 2, 'should find at least 2 summaries mentioning database');
      assert.ok(results.every((r) => r.content.toLowerCase().includes('database')), 'all results contain "database"');
      assert.ok(results[0].rank <= results[1].rank, 'results ordered by rank (best first)');

      // Verify shape
      const first = results[0];
      assert.ok('summaryId' in first, 'has summaryId');
      assert.ok('content' in first, 'has content');
      assert.ok('depth' in first, 'has depth');
      assert.ok('tokenCount' in first, 'has tokenCount');
      assert.ok('earliestAt' in first, 'has earliestAt');
      assert.ok('latestAt' in first, 'has latestAt');
      assert.ok('rank' in first, 'has rank');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 29. searchSummariesByRelevance() — empty results when no match
  test('searchSummariesByRelevance() returns empty array when no match', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-empty';
      store.insertSummary({ summaryId: 'sum_fts_e1', sessionKey: key, kind: 'leaf', depth: 0, content: 'The quick brown fox', tokenCount: 5 });
      const results = store.searchSummariesByRelevance('zzzznonexistent', 5, key);
      assert.deepEqual(results, [], 'no matches → empty array');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 30. searchSummariesByRelevance() — respects limit
  test('searchSummariesByRelevance() respects limit parameter', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-limit';
      for (let i = 0; i < 10; i++) {
        store.insertSummary({ summaryId: `sum_fl_${i}`, sessionKey: key, kind: 'leaf', depth: 0, content: `topic alpha item ${i}`, tokenCount: 4 });
      }
      const results = store.searchSummariesByRelevance('alpha', 3, key);
      assert.equal(results.length, 3, 'should return at most 3 results');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 31. searchSummariesByRelevance() — returns empty for empty/null query
  test('searchSummariesByRelevance() returns empty for empty query', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-null';
      store.insertSummary({ summaryId: 'sum_fn1', sessionKey: key, kind: 'leaf', depth: 0, content: 'some content', tokenCount: 3 });
      assert.deepEqual(store.searchSummariesByRelevance('', 5, key), []);
      assert.deepEqual(store.searchSummariesByRelevance(null, 5, key), []);
      assert.deepEqual(store.searchSummariesByRelevance(undefined, 5, key), []);
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('searchSummariesByRelevance() filters results by session key', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const sessionA = 'sess:fts-a';
      const sessionB = 'sess:fts-b';
      store.insertSummary({ summaryId: 'sum_a_1', sessionKey: sessionA, kind: 'leaf', depth: 0, content: 'Billing migration for project atlas', tokenCount: 6 });
      store.insertSummary({ summaryId: 'sum_b_1', sessionKey: sessionB, kind: 'leaf', depth: 0, content: 'Billing migration for unrelated workspace', tokenCount: 6 });

      const results = store.searchSummariesByRelevance('billing migration atlas', 10, sessionA);
      assert.equal(results.length, 1, 'only matching summaries from the requested session should be returned');
      assert.equal(results[0].summaryId, 'sum_a_1');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('searchSummariesByRelevance() sanitizes natural language punctuation for FTS5', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-sanitize';
      store.insertSummary({ summaryId: 'sum_san_1', sessionKey: key, kind: 'leaf', depth: 0, content: 'Database migrations fixed the billing schema issue', tokenCount: 8 });

      const results = store.searchSummariesByRelevance('("database": migrations*)', 5, key);
      assert.equal(results.length, 1, 'sanitized natural-language query should still match');
      assert.equal(results[0].summaryId, 'sum_san_1');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('searchSummariesByRelevance() returns empty when sanitization removes the whole query', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-empty-sanitize';
      store.insertSummary({ summaryId: 'sum_empty_1', sessionKey: key, kind: 'leaf', depth: 0, content: 'Some searchable text', tokenCount: 4 });

      assert.deepEqual(store.searchSummariesByRelevance('("a" : *)', 5, key), []);
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('init() backfills existing summaries into fts_summaries', () => {
    const dbPath = makeTmpDb();
    try {
      let store = openStore(dbPath);
      const key = 'sess:fts-backfill';
      store.insertSummary({ summaryId: 'sum_backfill_1', sessionKey: key, kind: 'leaf', depth: 0, content: 'Legacy migration summary for checkout flow', tokenCount: 7 });
      store.db.prepare('DELETE FROM fts_summaries WHERE summary_id = ?').run('sum_backfill_1');
      store.close();

      store = openStore(dbPath);
      const results = store.searchSummariesByRelevance('legacy migration checkout', 5, key);
      assert.equal(results.length, 1, 're-init should repopulate missing FTS rows');
      assert.equal(results[0].summaryId, 'sum_backfill_1');
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('searchSummariesByRelevance() returns empty when fts5 is unavailable', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-disabled';
      store.insertSummary({ summaryId: 'sum_disabled_1', sessionKey: key, kind: 'leaf', depth: 0, content: 'Search should be disabled', tokenCount: 4 });
      store.fts5Available = false;

      assert.deepEqual(store.searchSummariesByRelevance('search disabled', 5, key), []);
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  test('init() rebuilds legacy fts_summaries with porter tokenizer', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:fts-porter';
      const convId = store.getOrCreateConversation(key);
      store.close();

      const legacy = openStore(dbPath);
      legacy.db.exec('DROP TRIGGER IF EXISTS summaries_ai; DROP TRIGGER IF EXISTS summaries_ad; DROP TRIGGER IF EXISTS summaries_au; DROP TABLE IF EXISTS fts_summaries;');
      legacy.db.exec(`
        CREATE VIRTUAL TABLE fts_summaries USING fts5(
          summary_id UNINDEXED,
          content
        );
        CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
          INSERT INTO fts_summaries(summary_id, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER summaries_ad AFTER DELETE ON summaries BEGIN
          DELETE FROM fts_summaries WHERE summary_id = old.id;
        END;
        CREATE TRIGGER summaries_au AFTER UPDATE ON summaries BEGIN
          DELETE FROM fts_summaries WHERE summary_id = old.id;
          INSERT INTO fts_summaries(summary_id, content) VALUES (new.id, new.content);
        END;
      `);
      legacy.db.prepare('INSERT INTO summaries (id, conv_id, kind, depth, content, token_count) VALUES (?, ?, ?, ?, ?, ?)').run(
        'sum_legacy_1',
        convId,
        'leaf',
        0,
        'Earlier migrations were applied cleanly',
        6,
      );
      legacy.close();

      const migrated = openStore(dbPath);
      const createSql = migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_summaries'").get()?.sql || '';
      assert.match(createSql, /tokenize='porter unicode61'/, 'fts table should be recreated with porter tokenizer');
      const results = migrated.searchSummariesByRelevance('migration applied', 5, key);
      assert.equal(results.length, 1, 'porter tokenizer should allow stemmed match after migration');
      migrated.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });

  // 15. getContextItems() summary items have both refId and summaryId
  test('getContextItems() summary items have both refId and summaryId set to same value', () => {
    const dbPath = makeTmpDb();
    try {
      const store = openStore(dbPath);
      const key = 'sess:ctxsumfields';
      const m1 = store.addMessage(key, 'user', 'msg a');
      const m2 = store.addMessage(key, 'assistant', 'msg b');
      store.createLeafSummary(key, 'summary content', [m1, m2]);
      const items = store.getContextItems(key);
      const sumItems = items.filter((i) => i.itemType === 'summary');
      assert.ok(sumItems.length > 0, 'should have summary items');
      for (const item of sumItems) {
        assert.ok('refId' in item, 'refId should be present');
        assert.ok('summaryId' in item, 'summaryId should be present');
        assert.equal(item.refId, item.summaryId, 'refId and summaryId should be equal');
      }
      store.close();
    } finally {
      rmSync(dbPath, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// No-op stub behaviour (when better-sqlite3 is unavailable)
// We test this by constructing a store and NOT calling init() — db stays null.
// ---------------------------------------------------------------------------

describe('CrystalLocalStore no-op stub (db=null)', () => {
  test('all public methods return safe empty values when db is null', () => {
    const store = new CrystalLocalStore(); // db = null, init() never called

    assert.equal(store.getOrCreateConversation('x'), null);
    assert.equal(store.addMessage('x', 'user', 'hi'), null);
    assert.deepEqual(store.getRecentMessages('x'), []);
    assert.deepEqual(store.searchMessages('x', 'foo'), []);
    assert.equal(store.createLeafSummary('x', 'sum', [1, 2]), null);
    assert.equal(store.createCondensedSummary('x', 'sum', ['a'], 1), null);
    assert.deepEqual(store.getContextItems('x'), []);
    assert.deepEqual(store.searchSummaries('x', 'foo'), []);
    assert.deepEqual(store.searchSummariesByRelevance('test', 5, 'x'), []);
    assert.equal(store.getTokenCount('x'), 0);
    assert.equal(store.getContextTokenCount('x'), 0);
    assert.equal(store.incrementLessonCount('x', 'topic'), 0);
    assert.deepEqual(store.getLessonCountsForSession('x', 1), []);
    assert.deepEqual(store.getDistinctDepthsInContext('x'), []);
    assert.equal(store.insertSummary({ summaryId: 'x', sessionKey: 'x', kind: 'leaf', depth: 0, content: '' }), null);
    assert.doesNotThrow(() => store.linkSummaryToMessages('x', [1]));
    assert.doesNotThrow(() => store.linkSummaryToParents('x', ['y']));
    assert.doesNotThrow(() => store.replaceContextRangeWithSummary('x', 0, 1, 'x'));
    assert.equal(store.getMessageById(1), null);
    assert.equal(store.getSummary('sum_abc'), null);
    assert.doesNotThrow(() => store.close());
  });

  test('checkSqliteAvailability returns a valid shape', () => {
    const result = checkSqliteAvailability();
    assert.ok(typeof result === 'object');
    assert.ok('available' in result);
    assert.ok(typeof result.available === 'boolean');
    if (!result.available) {
      assert.ok(typeof result.error === 'string', 'error string when unavailable');
    } else {
      assert.ok(typeof result.version === 'string', 'version string when available');
    }
  });
});
