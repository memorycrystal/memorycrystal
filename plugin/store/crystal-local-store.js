import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let Database = null;
let dbLoadError = null;
try {
  const req = createRequire(import.meta.url);
  Database = req('better-sqlite3');
  if (Database?.default) Database = Database.default;
} catch (_) {
  try { const m = await import('better-sqlite3'); Database = m.default ?? m; }
  catch (err) { dbLoadError = err; }
}

const BASE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA wal_autocheckpoint = 200;
PRAGMA journal_size_limit = 16777216;
PRAGMA cache_size = -8192;
PRAGMA mmap_size = 0;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS conversations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_session_key ON conversations (session_key);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content     TEXT    NOT NULL DEFAULT '',
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (conv_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_id ON messages (conv_id, seq);

CREATE TABLE IF NOT EXISTS summaries (
  id          TEXT    PRIMARY KEY,
  conv_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('leaf','condensed')),
  depth       INTEGER NOT NULL DEFAULT 0,
  content     TEXT    NOT NULL DEFAULT '',
  token_count INTEGER NOT NULL DEFAULT 0,
  earliest_at TEXT,
  latest_at   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_summaries_conv_id ON summaries (conv_id, depth);

CREATE TABLE IF NOT EXISTS summary_parents (
  summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  parent_id  TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, parent_id)
);

CREATE TABLE IF NOT EXISTS summary_messages (
  summary_id TEXT    NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (summary_id, message_id)
);

CREATE TABLE IF NOT EXISTS lesson_counter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_saved_at INTEGER NOT NULL,
  UNIQUE(session_key, topic)
);
CREATE INDEX IF NOT EXISTS idx_lesson_counter_session ON lesson_counter(session_key);

CREATE TABLE IF NOT EXISTS context_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL,
  item_type TEXT    NOT NULL CHECK (item_type IN ('message','summary')),
  ref_id    TEXT    NOT NULL,
  UNIQUE (conv_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_context_items_conv_id ON context_items (conv_id, ordinal);

CREATE TABLE IF NOT EXISTS context_engine_ops (
  id             TEXT PRIMARY KEY,
  session_key    TEXT NOT NULL,
  op_type        TEXT NOT NULL DEFAULT 'message',
  role           TEXT,
  content_hash   TEXT NOT NULL,
  dedupe_key     TEXT NOT NULL UNIQUE,
  content        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','flushed','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  source_callback TEXT,
  turn_id        TEXT,
  message_index  INTEGER,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  flushed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_engine_ops_pending ON context_engine_ops (session_key, status, created_at);

CREATE TABLE IF NOT EXISTS context_engine_debt (
  id             TEXT PRIMARY KEY,
  session_key    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  estimated_chars INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cleared_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_engine_debt_open ON context_engine_debt (session_key, cleared_at, created_at);
`;

// Helpers
const estimateTokens = (t) => Math.ceil((t || '').length / 4);
const generateId = (p = 'id') => `${p}_${randomBytes(8).toString('hex')}`;
const hashText = (t) => createHash('sha256').update(String(t || '')).digest('hex');
const placeholders = (arr) => arr.map(() => '?').join(',');
const MAX_CONTEXT_ENGINE_QUEUE_DEPTH = 1000;
const LIKE_ESCAPE_CHAR = '\\';
const FTS_SUMMARIES_SQL = `
CREATE VIRTUAL TABLE fts_summaries USING fts5(
  summary_id UNINDEXED,
  content,
  tokenize='porter unicode61'
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
`;

function sanitizeQuery(query) {
  if (!query || typeof query !== 'string') return null;
  const sanitized = query
    .replace(/[():^*"]/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .join(' ')
    .trim()
    .slice(0, 200);
  return sanitized || null;
}

function toEscapedContainsPattern(query) {
  if (typeof query !== 'string' || query.length === 0) return null;
  const escaped = query.replace(/[\\%_]/g, (char) => `${LIKE_ESCAPE_CHAR}${char}`);
  return `%${escaped}%`;
}

export function checkSqliteAvailability() {
  if (!Database) {
    return { available: false, error: dbLoadError?.message ?? 'better-sqlite3 not found' };
  }
  try {
    const tmp = new Database(':memory:');
    const { version } = tmp.prepare('SELECT sqlite_version() AS version').get();
    try {
      tmp.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_check USING fts5(test);');
      tmp.exec('DROP TABLE IF EXISTS _fts5_check;');
      tmp.close();
      return { available: true, version, fts5Available: true };
    } catch (err) {
      tmp.close();
      return { available: true, version, fts5Available: false, error: err.message };
    }
  } catch (err) {
    return { available: false, error: err.message };
  }
}

export class CrystalLocalStore {
  constructor() {
    /** @type {import('better-sqlite3').Database | null} */
    this.db = null;
    this._stmts = {};
    this.fts5Available = false;
    this._writeOpsSinceCheckpoint = 0;
  }

  init(dbPath = `${homedir()}/.crystal-memory.db`) {
    if (!Database) {
      console.warn(
        `[crystal-local-store] better-sqlite3 unavailable (${dbLoadError?.message ?? 'load failed'}). ` +
        'Running in no-op mode. Run: npm i better-sqlite3'
      );
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(BASE_SCHEMA_SQL);
    this.fts5Available = this._checkFts5Available();
    if (this.fts5Available) this._ensureFtsSummariesSchema();
    this._prepareStatements();
  }

  _checkFts5Available() {
    if (!this.db) return false;
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_check USING fts5(test);');
      this.db.exec('DROP TABLE IF EXISTS _fts5_check;');
      return true;
    } catch (_) {
      return false;
    }
  }

  _ensureFtsSummariesSchema() {
    if (!this.db) return;
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_summaries'").get();
    const currentSql = row?.sql || '';
    const hasPorterTokenizer = /tokenize='porter unicode61'/.test(currentSql);

    if (!hasPorterTokenizer) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS summaries_ai;
        DROP TRIGGER IF EXISTS summaries_ad;
        DROP TRIGGER IF EXISTS summaries_au;
        DROP TABLE IF EXISTS fts_summaries;
      `);
      this.db.exec(FTS_SUMMARIES_SQL);
    } else {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
          INSERT INTO fts_summaries(summary_id, content) VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
          DELETE FROM fts_summaries WHERE summary_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON summaries BEGIN
          DELETE FROM fts_summaries WHERE summary_id = old.id;
          INSERT INTO fts_summaries(summary_id, content) VALUES (new.id, new.content);
        END;
      `);
    }

    this.db.prepare(`
      INSERT INTO fts_summaries(summary_id, content)
      SELECT s.id, s.content
      FROM summaries s
      WHERE s.content IS NOT NULL
        AND s.content != ''
        AND NOT EXISTS (
          SELECT 1
          FROM fts_summaries f
          WHERE f.summary_id = s.id
        )
    `).run();
  }

  _prepareStatements() {
    const d = this.db;
    this._stmts = {
      getConv:        d.prepare('SELECT id FROM conversations WHERE session_key = ?'),
      insertConv:     d.prepare('INSERT OR IGNORE INTO conversations (session_key) VALUES (?)'),
      getMaxSeq:      d.prepare('SELECT COALESCE(MAX(seq),-1) AS v FROM messages WHERE conv_id = ?'),
      insertMsg:      d.prepare('INSERT INTO messages (conv_id,seq,role,content,token_count) VALUES (@conv_id,@seq,@role,@content,@token_count)'),
      getMaxOrd:      d.prepare('SELECT COALESCE(MAX(ordinal),-1) AS v FROM context_items WHERE conv_id = ?'),
      insertCtx:      d.prepare('INSERT OR IGNORE INTO context_items (conv_id,ordinal,item_type,ref_id) VALUES (@conv_id,@ordinal,@item_type,@ref_id)'),
      recentMsgs:     d.prepare('SELECT id,conv_id,seq,role,content,token_count,created_at FROM messages WHERE conv_id=? ORDER BY seq DESC LIMIT ?'),
      searchMsgs:     d.prepare("SELECT id,conv_id,seq,role,content,token_count,created_at FROM messages WHERE conv_id=? AND content LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 50"),
      insertSum:      d.prepare('INSERT INTO summaries (id,conv_id,kind,depth,content,token_count,earliest_at,latest_at) VALUES (@id,@conv_id,@kind,@depth,@content,@token_count,@earliest_at,@latest_at)'),
      linkSumMsg:     d.prepare('INSERT OR IGNORE INTO summary_messages (summary_id,message_id) VALUES (?,?)'),
      linkSumParent:  d.prepare('INSERT OR IGNORE INTO summary_parents (summary_id,parent_id) VALUES (?,?)'),
      searchSums:     d.prepare("SELECT id,kind,depth,content,token_count,created_at FROM summaries WHERE conv_id=? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 50"),
      ctxItems:       d.prepare(`
        SELECT ci.ordinal,ci.item_type,ci.ref_id,
               m.role,m.content AS msg_content,m.token_count AS msg_tokens,
               s.kind AS sum_kind,s.depth AS sum_depth,
               s.content AS sum_content,s.token_count AS sum_tokens,
               s.earliest_at,s.latest_at
        FROM context_items ci
        LEFT JOIN messages  m ON ci.item_type='message' AND ci.ref_id=CAST(m.id AS TEXT)
        LEFT JOIN summaries s ON ci.item_type='summary' AND ci.ref_id=s.id
        WHERE ci.conv_id=? ORDER BY ci.ordinal ASC`),
      tokenCount:     d.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN ci.item_type='message' THEN m.token_count ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN ci.item_type='summary' THEN s.token_count ELSE 0 END),0) AS total
        FROM context_items ci
        LEFT JOIN messages  m ON ci.item_type='message' AND ci.ref_id=CAST(m.id AS TEXT)
        LEFT JOIN summaries s ON ci.item_type='summary' AND ci.ref_id=s.id
        WHERE ci.conv_id=?`),
      insertContextOp: d.prepare(`
        INSERT OR IGNORE INTO context_engine_ops
          (id, session_key, op_type, role, content_hash, dedupe_key, content, source_callback, turn_id, message_index)
        VALUES
          (@id, @session_key, @op_type, @role, @content_hash, @dedupe_key, @content, @source_callback, @turn_id, @message_index)`),
      pendingContextOps: d.prepare(`
        SELECT id, session_key, op_type, role, content_hash, content, status, attempts,
               source_callback, turn_id, message_index, last_error, created_at, updated_at
        FROM context_engine_ops
        WHERE session_key = ? AND status IN ('queued','failed')
        ORDER BY created_at ASC, COALESCE(message_index, -1) ASC, id ASC
        LIMIT ?`),
      markContextOpFlushed: d.prepare(`
        UPDATE context_engine_ops
        SET status='flushed', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), flushed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error=NULL
        WHERE id=?`),
      markContextOpFailed: d.prepare(`
        UPDATE context_engine_ops
        SET status='failed', attempts=attempts+1, last_error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?`),
      contextQueueStats: d.prepare(`
        SELECT
          COUNT(*) AS pending,
          MIN(created_at) AS oldest_at,
          COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,
          COALESCE(MAX(attempts),0) AS max_attempts
        FROM context_engine_ops
        WHERE status IN ('queued','failed')`),
      insertDebt: d.prepare(`
        INSERT INTO context_engine_debt
          (id, session_key, reason, estimated_chars, estimated_tokens, last_error)
        VALUES
          (@id, @session_key, @reason, @estimated_chars, @estimated_tokens, @last_error)`),
      clearDebt: d.prepare(`
        UPDATE context_engine_debt
        SET cleared_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?`),
      debtStats: d.prepare(`
        SELECT COUNT(*) AS open,
               MIN(created_at) AS oldest_at,
               COALESCE(SUM(estimated_tokens),0) AS estimated_tokens,
               COALESCE(MAX(attempts),0) AS max_attempts
        FROM context_engine_debt
        WHERE cleared_at IS NULL`),
    };
  }

  getOrCreateConversation(sessionKey) {
    if (!this.db) return null;
    this._stmts.insertConv.run(sessionKey);
    return this._stmts.getConv.get(sessionKey)?.id ?? null;
  }

  addMessage(sessionKey, role, content) {
    if (!this.db) return null;
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return null;

    const seq = this._stmts.getMaxSeq.get(convId).v + 1;
    const msgId = this._stmts.insertMsg.run({
      conv_id: convId, seq, role,
      content: content || '',
      token_count: estimateTokens(content),
    }).lastInsertRowid;

    this._stmts.insertCtx.run({
      conv_id: convId,
      ordinal: this._stmts.getMaxOrd.get(convId).v + 1,
      item_type: 'message',
      ref_id: String(msgId),
    });
    this._maybeCheckpointWal();
    return Number(msgId);
  }

  getHealthSnapshot() {
    const base = {
      healthy: false,
      dbOpen: Boolean(this.db),
      schemaReady: false,
      writable: false,
      fts5Available: Boolean(this.fts5Available),
      lastError: null,
    };
    if (!this.db) return { ...base, lastError: 'database is not open' };
    try {
      const required = [
        'conversations',
        'messages',
        'summaries',
        'summary_parents',
        'summary_messages',
        'context_items',
        'context_engine_ops',
        'context_engine_debt',
      ];
      const rows = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (" + placeholders(required) + ")")
        .all(...required)
        .map((r) => r.name);
      const present = new Set(rows);
      const missing = required.filter((name) => !present.has(name));
      const schemaReady = missing.length === 0;
      let writable = false;
      try {
        this.db.exec('CREATE TEMP TABLE IF NOT EXISTS _crystal_write_check (id INTEGER);');
        this.db.prepare('INSERT INTO _crystal_write_check (id) VALUES (1)').run();
        this.db.prepare('DELETE FROM _crystal_write_check').run();
        writable = true;
      } catch (_) {
        writable = false;
      }
      return {
        healthy: schemaReady && writable,
        dbOpen: true,
        schemaReady,
        writable,
        fts5Available: Boolean(this.fts5Available),
        lastError: missing.length ? `missing tables: ${missing.join(', ')}` : null,
      };
    } catch (err) {
      return {
        ...base,
        dbOpen: true,
        fts5Available: Boolean(this.fts5Available),
        lastError: err?.message || String(err),
      };
    }
  }

  enqueueContextEngineOp({ sessionKey, opType = 'message', role, content, sourceCallback, turnId, messageIndex } = {}) {
    if (!this.db || !sessionKey || !content) return null;
    const pending = this._stmts.contextQueueStats.get()?.pending || 0;
    if (pending >= MAX_CONTEXT_ENGINE_QUEUE_DEPTH) return null;
    const normalizedContent = String(content || '');
    const contentHash = hashText(normalizedContent);
    const dedupeParts = [
      sessionKey,
      opType || 'message',
      role || '',
      contentHash,
      turnId || '',
      Number.isFinite(Number(messageIndex)) ? String(Math.floor(Number(messageIndex))) : '-1',
    ];
    const dedupeKey = hashText(dedupeParts.join('\u001f'));
    const id = `ceop_${dedupeKey.slice(0, 24)}`;
    this._stmts.insertContextOp.run({
      id,
      session_key: sessionKey,
      op_type: opType || 'message',
      role: role || null,
      content_hash: contentHash,
      dedupe_key: dedupeKey,
      content: normalizedContent,
      source_callback: sourceCallback || null,
      turn_id: turnId || null,
      message_index: Number.isFinite(Number(messageIndex)) ? Math.floor(Number(messageIndex)) : null,
    });
    this._maybeCheckpointWal();
    return id;
  }

  getPendingContextEngineOps(sessionKey, limit = 100) {
    if (!this.db || !sessionKey) return [];
    const rows = this._stmts.pendingContextOps.all(sessionKey, Math.max(1, Math.min(Math.floor(Number(limit) || 100), 1000)));
    return rows.map((r) => ({
      id: r.id,
      sessionKey: r.session_key,
      opType: r.op_type,
      role: r.role,
      contentHash: r.content_hash,
      content: r.content,
      status: r.status,
      attempts: r.attempts,
      sourceCallback: r.source_callback,
      turnId: r.turn_id,
      messageIndex: r.message_index,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  markContextEngineOpFlushed(id) {
    if (!this.db || !id) return;
    this._stmts.markContextOpFlushed.run(id);
  }

  markContextEngineOpFailed(id, error) {
    if (!this.db || !id) return;
    this._stmts.markContextOpFailed.run(String(error || 'write failed').slice(0, 500), id);
  }

  getContextEngineQueueStats() {
    if (!this.db) return { pending: 0, oldestAt: null, failed: 0, maxAttempts: 0 };
    const row = this._stmts.contextQueueStats.get();
    return {
      pending: row?.pending || 0,
      oldestAt: row?.oldest_at || null,
      failed: row?.failed || 0,
      maxAttempts: row?.max_attempts || 0,
    };
  }

  recordCompactionDebt(sessionKey, reason, details = {}) {
    if (!this.db || !sessionKey || !reason) return null;
    const estimatedChars = Math.max(0, Math.floor(Number(details.estimatedChars) || 0));
    const estimatedTokens = Math.max(0, Math.floor(Number(details.estimatedTokens) || Math.ceil(estimatedChars / 4)));
    const id = `cedebt_${hashText([sessionKey, reason, Date.now(), randomBytes(4).toString('hex')].join('\u001f')).slice(0, 24)}`;
    this._stmts.insertDebt.run({
      id,
      session_key: sessionKey,
      reason,
      estimated_chars: estimatedChars,
      estimated_tokens: estimatedTokens,
      last_error: details.lastError ? String(details.lastError).slice(0, 500) : null,
    });
    this._maybeCheckpointWal();
    return id;
  }

  clearCompactionDebt(id) {
    if (!this.db || !id) return;
    this._stmts.clearDebt.run(id);
  }

  getCompactionDebtStats() {
    if (!this.db) return { open: 0, oldestAt: null, estimatedTokens: 0, maxAttempts: 0 };
    const row = this._stmts.debtStats.get();
    return {
      open: row?.open || 0,
      oldestAt: row?.oldest_at || null,
      estimatedTokens: row?.estimated_tokens || 0,
      maxAttempts: row?.max_attempts || 0,
    };
  }

  getRecentMessages(sessionKey, limit = 20) {
    if (!this.db) return [];
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return [];
    return this._stmts.recentMsgs.all(convId, limit).map((r) => ({
      id: r.id, seq: r.seq, role: r.role,
      content: r.content, tokenCount: r.token_count, createdAt: r.created_at,
    }));
  }

  searchMessages(sessionKey, query) {
    if (!this.db) return [];
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return [];
    const pat = toEscapedContainsPattern(query);
    if (!pat) return [];
    return this._stmts.searchMsgs.all(convId, pat).map((r) => ({
      id: r.id, role: r.role, content: r.content, createdAt: r.created_at,
    }));
  }

  _insertSummaryWithLinks({ convId, kind, depth, content, tokenCount, timeQuery, linkIds, linkFn, ctxItemType }) {
    const summaryId = generateId('sum');
    const tc = tokenCount ?? estimateTokens(content);

    let earliestAt = null, latestAt = null;
    if (linkIds.length > 0) {
      const row = this.db.prepare(timeQuery(linkIds)).get(...linkIds);
      earliestAt = row?.earliest ?? null;
      latestAt   = row?.latest   ?? null;
    }

    const refIds = linkIds.map(String);

    this.db.transaction(() => {
      this._stmts.insertSum.run({
        id: summaryId, conv_id: convId, kind, depth, content,
        token_count: tc, earliest_at: earliestAt, latest_at: latestAt,
      });

      for (const id of linkIds) linkFn(summaryId, id);

      if (refIds.length > 0) {
        const ph = placeholders(refIds);
        const minOrdRow = this.db
          .prepare(`SELECT MIN(ci.ordinal) AS min_ord FROM context_items ci WHERE ci.conv_id=? AND ci.item_type=? AND ci.ref_id IN (${ph})`)
          .get(convId, ctxItemType, ...refIds);

        const ordinal = minOrdRow?.min_ord ?? (this._stmts.getMaxOrd.get(convId).v + 1);

        this.db.prepare(`DELETE FROM context_items WHERE conv_id=? AND item_type=? AND ref_id IN (${ph})`)
          .run(convId, ctxItemType, ...refIds);

        this._stmts.insertCtx.run({ conv_id: convId, ordinal, item_type: 'summary', ref_id: summaryId });
      }
    })();

    return summaryId;
  }

  createLeafSummary(sessionKey, content, sourceMessageIds, tokenCount) {
    if (!this.db) return null;
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return null;
    const ids = (sourceMessageIds || []).map(Number).filter(Boolean);
    return this._insertSummaryWithLinks({
      convId, kind: 'leaf', depth: 0, content, tokenCount,
      linkIds: ids,
      timeQuery: (a) => `SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest FROM messages WHERE id IN (${placeholders(a)})`,
      linkFn: (sid, mid) => this._stmts.linkSumMsg.run(sid, mid),
      ctxItemType: 'message',
    });
  }

  createCondensedSummary(sessionKey, content, parentSummaryIds, depth, tokenCount) {
    if (!this.db) return null;
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return null;
    const ids = (parentSummaryIds || []).filter((id) => typeof id === 'string');
    return this._insertSummaryWithLinks({
      convId, kind: 'condensed', depth, content, tokenCount,
      linkIds: ids,
      timeQuery: (a) => `SELECT MIN(earliest_at) AS earliest, MAX(latest_at) AS latest FROM summaries WHERE id IN (${placeholders(a)})`,
      linkFn: (sid, pid) => this._stmts.linkSumParent.run(sid, pid),
      ctxItemType: 'summary',
    });
  }

  getContextItems(sessionKey) {
    if (!this.db) return [];
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return [];
    return this._stmts.ctxItems.all(convId).map((r) =>
      r.item_type === 'message'
        ? { ordinal: r.ordinal, itemType: 'message', refId: r.ref_id, messageId: r.ref_id, role: r.role, content: r.msg_content, tokenCount: r.msg_tokens }
        : { ordinal: r.ordinal, itemType: 'summary', refId: r.ref_id, summaryId: r.ref_id, summaryKind: r.sum_kind, summaryDepth: r.sum_depth, content: r.sum_content, tokenCount: r.sum_tokens, earliestAt: r.earliest_at, latestAt: r.latest_at }
    );
  }

  getMessageById(messageId) {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT id, role, content, token_count, created_at FROM messages WHERE id = ?').get(messageId);
    if (!row) return null;
    return { messageId: row.id, role: row.role, content: row.content, tokenCount: row.token_count || 0, createdAt: row.created_at };
  }

  getSummary(summaryId) {
    if (!this.db) return null;
    const row = this.db.prepare(
      'SELECT id, kind, depth, content, token_count, earliest_at, latest_at, created_at FROM summaries WHERE id = ?'
    ).get(summaryId);
    if (!row) return null;
    const parents = this.db.prepare('SELECT parent_id FROM summary_parents WHERE summary_id = ?').all(summaryId).map(r => r.parent_id);
    const children = this.db.prepare('SELECT summary_id FROM summary_parents WHERE parent_id = ?').all(summaryId).map(r => r.summary_id);
    const messages = this.db.prepare('SELECT message_id FROM summary_messages WHERE summary_id = ?').all(summaryId).map(r => r.message_id);
    return {
      summaryId: row.id,
      kind: row.kind,
      depth: row.depth,
      content: row.content,
      tokenCount: row.token_count || 0,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
      createdAt: row.created_at,
      parentSummaryIds: parents,
      childSummaryIds: children,
      sourceMessageIds: messages,
    };
  }

  searchSummaries(sessionKey, query) {
    if (!this.db) return [];
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return [];
    const pat = toEscapedContainsPattern(query);
    if (!pat) return [];
    return this._stmts.searchSums.all(convId, pat).map((r) => ({
      id: r.id, kind: r.kind, depth: r.depth,
      content: r.content, tokenCount: r.token_count, createdAt: r.created_at,
    }));
  }

  searchSummariesByRelevance(query, limit = 5, sessionKey) {
    if (!this.db || !this.fts5Available) return [];
    if (!sessionKey || typeof sessionKey !== 'string') return [];
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return [];
    const sanitizedQuery = sanitizeQuery(query);
    if (!sanitizedQuery) return [];
    try {
      const rows = this.db.prepare(
        `SELECT s.id AS summaryId,
                s.content,
                s.depth,
                s.token_count,
                s.earliest_at,
                s.latest_at,
                bm25(fts_summaries) AS rank
         FROM fts_summaries
         JOIN summaries s ON fts_summaries.summary_id = s.id
         WHERE fts_summaries MATCH ?
           AND s.conv_id = ?
         ORDER BY rank
         LIMIT ?`
      ).all(sanitizedQuery, convId, limit);
      return rows.map((r) => ({
        summaryId: r.summaryId,
        content: r.content,
        depth: r.depth,
        tokenCount: r.token_count,
        earliestAt: r.earliest_at,
        latestAt: r.latest_at,
        rank: r.rank,
      }));
    } catch (_) {
      return [];
    }
  }

  getTokenCount(sessionKey) {
    if (!this.db) return 0;
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return 0;
    return this._stmts.tokenCount.get(convId)?.total ?? 0;
  }

  incrementLessonCount(sessionKey, topic) {
    if (!this.db) return 0;
    const ts = Date.now();
    this.db.prepare('INSERT INTO lesson_counter (session_key, topic, count, last_saved_at) VALUES (?, ?, 1, ?) ON CONFLICT(session_key, topic) DO UPDATE SET count = count + 1, last_saved_at = excluded.last_saved_at').run(sessionKey, topic, ts);
    return this.db.prepare('SELECT count FROM lesson_counter WHERE session_key = ? AND topic = ?').get(sessionKey, topic)?.count ?? 0;
  }

  getLessonCountsForSession(sessionKey, minCount) {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT topic, count FROM lesson_counter WHERE session_key = ? AND count >= ? ORDER BY count DESC').all(sessionKey, minCount);
    return rows;
  }

  getContextTokenCount(sessionKey) { return this.getTokenCount(sessionKey); }

  getDistinctDepthsInContext(sessionKey, opts = {}) {
    if (!this.db) return [];
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return [];
    const maxOrd = opts.maxOrdinalExclusive ?? 999999;
    const rows = this.db.prepare(
      `SELECT DISTINCT s.depth FROM context_items ci
       JOIN summaries s ON ci.ref_id = s.id
       WHERE ci.conv_id = ? AND ci.item_type = 'summary' AND ci.ordinal < ?
       ORDER BY s.depth ASC`
    ).all(convId, maxOrd);
    return rows.map((r) => r.depth);
  }

  insertSummary({ summaryId, sessionKey, kind, depth, content, tokenCount, earliestAt, latestAt }) {
    if (!this.db) return null;
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return null;
    const tc = tokenCount ?? estimateTokens(content);
    const toTs = (v) => v ? (v instanceof Date ? v.toISOString() : v) : null;
    this._stmts.insertSum.run({
      id: summaryId, conv_id: convId,
      kind: kind || 'leaf', depth: depth ?? 0,
      content: content || '', token_count: tc,
      earliest_at: toTs(earliestAt), latest_at: toTs(latestAt),
    });
    return summaryId;
  }

  linkSummaryToMessages(summaryId, messageIds) {
    if (!this.db || !messageIds?.length) return;
    const ins = this._stmts.linkSumMsg;
    this.db.transaction((ids) => { for (const id of ids) ins.run(summaryId, id); })(messageIds);
  }

  linkSummaryToParents(summaryId, parentSummaryIds) {
    if (!this.db || !parentSummaryIds?.length) return;
    const ins = this._stmts.linkSumParent;
    this.db.transaction((ids) => { for (const id of ids) ins.run(summaryId, id); })(parentSummaryIds);
  }

  replaceContextRangeWithSummary(sessionKey, minOrdinal, maxOrdinal, summaryId) {
    if (!this.db) return;
    const convId = this.getOrCreateConversation(sessionKey);
    if (convId == null) return;
    const nextOrdinal = (this._stmts.getMaxOrd.get(convId)?.v ?? 0) + 1;
    this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM context_items WHERE conv_id = ? AND ordinal >= ? AND ordinal <= ?`
      ).run(convId, minOrdinal, maxOrdinal);
      this._stmts.insertCtx.run({ conv_id: convId, ordinal: nextOrdinal, item_type: 'summary', ref_id: summaryId });
    })();
  }

  close() {
    try { this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) { /* ignore */ }
    try { this.db?.close(); } catch (_) { /* ignore */ }
    this.db = null;
  }

  _maybeCheckpointWal() {
    if (!this.db) return;
    this._writeOpsSinceCheckpoint += 1;
    if (this._writeOpsSinceCheckpoint < 250) return;
    this._writeOpsSinceCheckpoint = 0;
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    } catch (_) { /* ignore */ }
  }
}

export default CrystalLocalStore;
