import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class ConversationStore {
  constructor(directory, maxTurns = 16) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'kirmy.sqlite'));
    this.maxTurns = maxTurns;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY, scope TEXT NOT NULL, user TEXT NOT NULL,
        assistant TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_scope ON turns(scope, id);`);
    this.prune();
  }
  prune() {
    this.db.prepare('DELETE FROM turns WHERE created_at < ?').run(Date.now() - 30 * 86400000);
  }
  history(scope) {
    return this.db.prepare('SELECT user, assistant FROM turns WHERE scope = ? AND created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(scope, Date.now() - 30 * 86400000, this.maxTurns).reverse().flatMap(t => [
        { role: 'user', content: t.user }, { role: 'assistant', content: t.assistant },
      ]);
  }
  append(scope, user, assistant) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO turns(scope,user,assistant,created_at) VALUES(?,?,?,?)')
        .run(scope, user, assistant, Date.now());
      this.db.prepare('DELETE FROM turns WHERE scope = ? AND id NOT IN (SELECT id FROM turns WHERE scope = ? ORDER BY id DESC LIMIT ?)')
        .run(scope, scope, this.maxTurns);
      this.prune();
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reset(scope) { this.db.prepare('DELETE FROM turns WHERE scope = ?').run(scope); }
  close() { this.db.close(); }
}
export function conversationScope(guildId, channelId, userId) {
  return `${guildId ?? 'dm'}:${channelId}:${userId}`;
}
