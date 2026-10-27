import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mediaDay } from './media-store.js';

export const DEFAULT_USAGE_LIMITS = {
  daily: { user: 60, server: 300, bot: 1000 },
  minute: { user: 5, server: 30, bot: 60 },
  voice: { user: 3, server: 10, bot: 20 },
};
export class UsageLimitError extends Error {}

export function usageLimitsFromEnv(env = process.env) {
  return Object.fromEntries(Object.entries(DEFAULT_USAGE_LIMITS).map(([window, scopes]) => [window,
    Object.fromEntries(Object.entries(scopes).map(([scope, fallback]) => {
      const name = `${scope.toUpperCase()}_${window.toUpperCase()}_REQUEST_LIMIT`;
      const value = Number(env[name] ?? fallback);
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error(`Invalid ${name}`);
      return [scope, value];
    })),
  ]));
}

// Count admitted attempts, including failures: a lost provider response may still
// be billable. A rejected admission never changes any allowance.
export class UsageStore {
  constructor(directory, { now = Date.now, limits = DEFAULT_USAGE_LIMITS } = {}) {
    for (const window of ['daily', 'minute', 'voice']) for (const scope of ['user', 'server', 'bot']) {
      if (!Number.isSafeInteger(limits[window]?.[scope]) || limits[window][scope] < 1) throw new Error('Invalid usage limits');
    }
    mkdirSync(directory, { recursive: true });
    this.now = now;
    this.limits = structuredClone(limits);
    this.db = new DatabaseSync(join(directory, 'kirmy.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS usage_admissions (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
        day TEXT NOT NULL, voice INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_day ON usage_admissions(day);
      CREATE INDEX IF NOT EXISTS usage_user ON usage_admissions(user_id, day, created_at);
      CREATE INDEX IF NOT EXISTS usage_guild ON usage_admissions(guild_id, day, created_at);
      CREATE INDEX IF NOT EXISTS usage_time ON usage_admissions(created_at);`);
    this.db.prepare('DELETE FROM usage_admissions WHERE created_at < ?').run(now() - 31 * 86400000);
    this.prunedDay = mediaDay(now());
  }
  count(scope, actor, { day, since, voice = false } = {}) {
    const columns = { user: 'user_id', server: 'guild_id', bot: null };
    if (!Object.hasOwn(columns, scope)) throw new Error('Invalid usage scope');
    if (scope !== 'bot' && !actor) return 0;
    const clauses = [], args = [];
    if (columns[scope]) { clauses.push(`${columns[scope]}=?`); args.push(actor); }
    if (day) { clauses.push('day=?'); args.push(day); }
    if (since !== undefined) { clauses.push('created_at>?'); args.push(since); }
    if (voice) clauses.push('voice=1');
    return this.db.prepare(`SELECT COUNT(*) AS used FROM usage_admissions${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`).get(...args).used;
  }
  reserve({ userId, guildId, voice = false }) {
    if (!/^\d{17,20}$/.test(userId) || (guildId && !/^\d{17,20}$/.test(guildId)) || typeof voice !== 'boolean') throw new Error('Invalid usage actor');
    const now = this.now(), day = mediaDay(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [scope, actor] of [['user', userId], ['server', guildId], ['bot', null]]) {
        if (scope === 'server' && !actor) continue;
        for (const window of ['minute', 'daily', ...(voice ? ['voice'] : [])]) {
          const criteria = window === 'minute' ? { since: now - 60000 } : { day, voice: window === 'voice' };
          if (this.count(scope, actor, criteria) >= this.limits[window][scope]) {
            const reset = window === 'minute' ? 'Try again in a minute.' : 'Limits reset at midnight Europe/Budapest.';
            throw new UsageLimitError(`${scope === 'user' ? 'Your' : scope === 'server' ? 'This server’s' : 'The bot’s'} ${window === 'voice' ? 'daily voice session' : window === 'daily' ? 'daily request' : 'one-minute request'} limit is reached (${this.limits[window][scope]}). ${reset} No new request was started. Use /usage to check your allowance.`);
          }
        }
      }
      this.db.prepare('INSERT INTO usage_admissions(user_id,guild_id,day,voice,created_at) VALUES(?,?,?,?,?)')
        .run(userId, guildId ?? '', day, Number(voice), now);
      if (this.prunedDay !== day) this.db.prepare('DELETE FROM usage_admissions WHERE created_at < ?').run(now - 31 * 86400000);
      this.db.exec('COMMIT');
      this.prunedDay = day;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot({ userId, guildId } = {}) {
    const day = mediaDay(this.now());
    return { day, limits: this.limits, scopes: Object.fromEntries(
      [['user', userId], ['server', guildId], ['bot', null]].filter(([scope, actor]) => scope === 'bot' || actor)
        .map(([scope, actor]) => [scope, { requests: this.count(scope, actor, { day }), voice: this.count(scope, actor, { day, voice: true }) }])) };
  }
  close() { this.db.close(); }
}

// One admission path for chat and standalone commands. User locks span channels
// and servers. Free cleanup still takes a scope lock, without spending quota.
export class RequestLimiter {
  constructor({ store, active = new Set(), isActive = () => false, isStopping = () => false,
    cooldownMs = 5000, concurrency = 3, now = Date.now }) {
    Object.assign(this, { store, active, isActive, isStopping, cooldownMs, concurrency, now });
    this.users = new Set(); this.last = new Map();
  }
  acquire({ scope, userId, guildId, voice = false, charge = true }) {
    if (this.isStopping()) throw new UsageLimitError('I’m restarting — give me a moment, then try again.');
    if (this.active.has(scope) || this.isActive(scope) || this.users.has(userId)) throw new UsageLimitError('Please wait for your current request to finish, including requests in other channels.');
    if (this.active.size >= this.concurrency) throw new UsageLimitError('I’ve got a few requests going. Try me again in a moment.');
    const now = this.now();
    if (charge) {
      const last = this.last.get(userId);
      if (last !== undefined && now - last < this.cooldownMs) throw new UsageLimitError(`Please wait ${Math.ceil((this.cooldownMs - now + last) / 1000)} seconds before another request.`);
      this.store.reserve({ userId, guildId, voice });
      this.last.set(userId, now);
      if (this.last.size > 10000) for (const [user, time] of this.last) if (now - time >= this.cooldownMs) this.last.delete(user);
    }
    this.active.add(scope); this.users.add(userId);
    let released = false;
    return () => { if (!released) { released = true; this.active.delete(scope); this.users.delete(userId); } };
  }
}
