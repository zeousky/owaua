import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PERSONA, validatePersona } from './persona.js';
import { validateLanguage } from './language.js';
import { boundedHistory, memoryKey, memoryText, searchTerms } from './memory.js';

function personaUserId(userId) {
  if (typeof userId !== 'string' || !/^[0-9]{17,20}$/.test(userId)) throw new Error('Invalid persona user');
  return userId;
}

export class ConversationStore {
  constructor(directory, maxTurns = 16, { archiveTurns = 1000, retentionDays = 180, maxContextCharacters = 32000 } = {}) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100 || !Number.isInteger(archiveTurns) || archiveTurns < maxTurns || archiveTurns > 10000 ||
      !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650 || !Number.isInteger(maxContextCharacters) || maxContextCharacters < 1000 || maxContextCharacters > 100000) throw new Error('Invalid memory limits');
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'kirmy.sqlite'));
    this.maxTurns = maxTurns;
    Object.assign(this, { archiveTurns, retentionDays, maxContextCharacters });
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
    try {
    this.db.exec(`CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, user TEXT NOT NULL,
        assistant TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_scope ON turns(scope, id);
      CREATE TABLE IF NOT EXISTS personas (
        user_id TEXT PRIMARY KEY, settings TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS languages (
        user_id TEXT PRIMARY KEY, code TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, user_id TEXT NOT NULL,
        key TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
        explicit INTEGER NOT NULL DEFAULT 0, source_turn_id INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(scope, key)
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, updated_at);
      CREATE TABLE IF NOT EXISTS memory_sources (
        memory_id INTEGER NOT NULL, scope TEXT NOT NULL, text TEXT NOT NULL,
        source_turn_id INTEGER NOT NULL DEFAULT 0, UNIQUE(memory_id, text, source_turn_id)
      );
      CREATE TABLE IF NOT EXISTS memory_settings (
        scope TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0
      );`);
    const indexed = this.db.prepare("SELECT name FROM sqlite_master WHERE name = 'turns_search'").get();
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS turns_search USING fts5(user, assistant, content='turns', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS turns_search_insert AFTER INSERT ON turns BEGIN
        INSERT INTO turns_search(rowid,user,assistant) VALUES(new.id,new.user,new.assistant); END;
      CREATE TRIGGER IF NOT EXISTS turns_search_delete AFTER DELETE ON turns BEGIN
        INSERT INTO turns_search(turns_search,rowid,user,assistant) VALUES('delete',old.id,old.user,old.assistant); END;
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_search USING fts5(key, text, content='memories', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
      CREATE TRIGGER IF NOT EXISTS memories_search_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_search(rowid,key,text) VALUES(new.id,new.key,new.text); END;
      CREATE TRIGGER IF NOT EXISTS memories_search_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_search(memories_search,rowid,key,text) VALUES('delete',old.id,old.key,old.text); END;
      CREATE TRIGGER IF NOT EXISTS memories_search_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_search(memories_search,rowid,key,text) VALUES('delete',old.id,old.key,old.text);
        INSERT INTO memories_search(rowid,key,text) VALUES(new.id,new.key,new.text); END;`);
    if (!indexed) this.db.exec("INSERT INTO turns_search(turns_search) VALUES('rebuild'); INSERT INTO memories_search(memories_search) VALUES('rebuild');");
    this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    this.prune();
  }
  prune() {
    this.db.prepare('DELETE FROM turns WHERE created_at < ?').run(Date.now() - this.retentionDays * 86400000);
  }
  history(scope) {
    if (this.memoryStatus(scope).paused) return [];
    return boundedHistory(this.db.prepare('SELECT user, assistant FROM turns WHERE scope = ? AND created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(scope, Date.now() - this.retentionDays * 86400000, this.maxTurns).reverse().flatMap(t => [
        { role: 'user', content: t.user }, { role: 'assistant', content: t.assistant },
      ]), this.maxContextCharacters);
  }
  append(scope, user, assistant, { userId, memories = [] } = {}) {
    if (this.memoryStatus(scope).paused) return;
    if (typeof user !== 'string' || user.length > 17000 || typeof assistant !== 'string' || assistant.length > 100000 || !Array.isArray(memories) || memories.length > 4) throw new Error('Invalid conversation');
    this.db.exec('BEGIN');
    try {
      const inserted = this.db.prepare('INSERT INTO turns(scope,user,assistant,created_at) VALUES(?,?,?,?)')
        .run(scope, user, assistant, Date.now());
      for (const note of memories) this.remember(scope, userId, { ...note, sourceTurnId: Number(inserted.lastInsertRowid) });
      this.db.prepare('DELETE FROM turns WHERE scope = ? AND id NOT IN (SELECT id FROM turns WHERE scope = ? ORDER BY id DESC LIMIT ?)')
        .run(scope, scope, this.archiveTurns);
      this.prune();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reset(scope) { this.clearMemory(scope); }
  memoryStatus(scope) {
    return {
      paused: !!this.db.prepare('SELECT paused FROM memory_settings WHERE scope = ?').get(scope)?.paused,
      notes: this.db.prepare('SELECT count(*) AS n FROM memories WHERE scope = ?').get(scope).n,
      turns: this.db.prepare('SELECT count(*) AS n FROM turns WHERE scope = ? AND created_at >= ?').get(scope, Date.now() - this.retentionDays * 86400000).n,
    };
  }
  pauseMemory(scope, paused) {
    if (typeof paused !== 'boolean') throw new Error('Invalid memory setting');
    this.db.prepare('INSERT INTO memory_settings(scope,paused) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET paused=excluded.paused').run(scope, Number(paused));
  }
  listMemories(scope) {
    return this.db.prepare('SELECT id,key,text,source,explicit,created_at,updated_at,source_turn_id FROM memories WHERE scope = ? ORDER BY explicit DESC,updated_at DESC,id DESC LIMIT 200').all(scope);
  }
  remember(scope, userId, { key, text, source = 'command', explicit = false, sourceTurnId = null }) {
    personaUserId(userId);
    if (typeof scope !== 'string' || !scope.endsWith(`:${userId}`)) throw new Error('Invalid memory owner');
    if (this.memoryStatus(scope).paused) throw new Error('Memory is paused');
    key = memoryKey(key); text = memoryText(text);
    if (!['command', 'conversation'].includes(source) || typeof explicit !== 'boolean') throw new Error('Invalid memory source');
    if (!this.db.prepare('SELECT id FROM memories WHERE scope=? AND key=?').get(scope, key) && this.memoryStatus(scope).notes >= 200) throw new Error('Memory is full; forget a note first');
    const now = Date.now();
    this.db.exec('SAVEPOINT save_memory');
    try {
      this.db.prepare(`INSERT INTO memories(scope,user_id,key,text,source,explicit,source_turn_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope,key) DO UPDATE SET text=excluded.text,source=excluded.source,explicit=MAX(memories.explicit,excluded.explicit),source_turn_id=excluded.source_turn_id,updated_at=excluded.updated_at`)
        .run(scope, userId, key, text, source, Number(explicit), sourceTurnId, now, now);
      const note = this.db.prepare('SELECT id,key,text,updated_at FROM memories WHERE scope=? AND key=?').get(scope, key);
      this.db.prepare('INSERT OR IGNORE INTO memory_sources(memory_id,scope,text,source_turn_id) VALUES(?,?,?,?)').run(note.id, scope, text, sourceTurnId ?? 0);
      this.db.exec('RELEASE save_memory');
      return note;
    } catch (error) { this.db.exec('ROLLBACK TO save_memory; RELEASE save_memory'); throw error; }
  }
  forgetMemory(scope, id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid memory id');
    const note = this.db.prepare('SELECT source_turn_id FROM memories WHERE scope=? AND id=?').get(scope, id);
    if (!note) return false;
    this.db.exec('BEGIN');
    try {
      // Forget all revisions and exchanges repeating a saved quote. Otherwise a
      // corrected/forgotten note could immediately return through archive recall.
      const sources = this.db.prepare('SELECT text,source_turn_id FROM memory_sources WHERE scope=? AND memory_id=?').all(scope, id);
      for (const source of sources) this.db.prepare('DELETE FROM turns WHERE scope=? AND (id=? OR instr(user,?)>0 OR instr(assistant,?)>0)').run(scope, source.source_turn_id, source.text, source.text);
      if (note.source_turn_id) this.db.prepare('DELETE FROM turns WHERE scope=? AND id=?').run(scope, note.source_turn_id);
      this.db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(scope, id);
      this.db.prepare('DELETE FROM memory_sources WHERE scope=? AND memory_id=?').run(scope, id);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  clearMemory(scope) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM turns WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM memories WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM memory_sources WHERE scope=?').run(scope);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recall(scope, query, { limit = 6 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Invalid recall limit');
    if (this.memoryStatus(scope).paused) return { paused: true, notes: [], conversations: [] };
    const terms = searchTerms(query);
    if (!terms.length) return { notes: this.listMemories(scope).slice(0, limit), conversations: [] };
    const match = terms.map(word => `"${word}"*`).join(' OR ');
    const notes = this.db.prepare(`SELECT m.id,m.key,m.text,m.source,m.updated_at FROM memories_search
      JOIN memories m ON m.id=memories_search.rowid WHERE memories_search MATCH ? AND m.scope=?
      ORDER BY bm25(memories_search,2,1),m.updated_at DESC LIMIT ?`).all(match, scope, limit);
    const conversations = this.db.prepare(`SELECT t.id,t.user,t.assistant,t.created_at FROM turns_search
      JOIN turns t ON t.id=turns_search.rowid WHERE turns_search MATCH ? AND t.scope=? AND t.created_at>=?
      AND t.id NOT IN (SELECT id FROM turns WHERE scope=? ORDER BY id DESC LIMIT ?)
      ORDER BY bm25(turns_search,3,1),t.created_at DESC LIMIT ?`)
      .all(match, scope, Date.now() - this.retentionDays * 86400000, scope, this.history(scope).length / 2, limit)
      .map(t => ({ id: t.id, date: new Date(t.created_at).toISOString(), user: excerpt(t.user, terms, 1200), assistant: excerpt(t.assistant, terms, 1200) }));
    return { notes, conversations };
  }
  context(scope, query) {
    if (this.memoryStatus(scope).paused) return { paused: true, notes: [], conversations: [] };
    const recalled = this.recall(scope, query, { limit: 3 });
    const notes = [...recalled.notes];
    for (const note of this.listMemories(scope)) {
      if (!notes.some(item => item.id === note.id)) notes.push(note);
      if (notes.length >= 8) break;
    }
    return { scope: 'this user in this channel only', notes: notes.slice(0, 8).map(({ id,key,text,updated_at }) => ({ id,key,text,updated_at: new Date(updated_at).toISOString() })), conversations: recalled.conversations };
  }
  language(userId) {
    const row = this.db.prepare('SELECT code FROM languages WHERE user_id = ?').get(personaUserId(userId));
    try { return validateLanguage(row?.code ?? 'auto'); } catch { return 'auto'; }
  }
  setLanguage(userId, code) {
    personaUserId(userId);
    validateLanguage(code);
    if (code === 'auto') this.db.prepare('DELETE FROM languages WHERE user_id = ?').run(userId);
    else this.db.prepare('INSERT INTO languages(user_id, code) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET code = excluded.code').run(userId, code);
    return code;
  }
  persona(userId) {
    const row = this.db.prepare('SELECT settings FROM personas WHERE user_id = ?').get(personaUserId(userId));
    if (row) {
      try { return validatePersona(JSON.parse(row.settings)); } catch { /* Fail closed on malformed or obsolete stored data. */ }
    }
    return { ...DEFAULT_PERSONA };
  }
  setPersona(userId, value) {
    personaUserId(userId);
    const persona = validatePersona(value);
    this.db.prepare('INSERT INTO personas(user_id, settings) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings')
      .run(userId, JSON.stringify(persona));
    return persona;
  }
  resetPersona(userId) { this.db.prepare('DELETE FROM personas WHERE user_id = ?').run(personaUserId(userId)); }
  close() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { this.db.close(); } }
}
function excerpt(text, terms, limit) {
  if (text.length <= limit) return text;
  const lower = text.toLowerCase();
  const matches = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const start = matches.length ? Math.max(0, Math.min(...matches) - 150) : 0;
  return (start ? '[excerpt] ' : '') + text.slice(start, start + limit) + '\n[excerpt truncated]';
}
export function conversationScope(guildId, channelId, userId) {
  return `${guildId ?? 'dm'}:${channelId}:${userId}`;
}
