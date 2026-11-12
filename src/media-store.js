import { randomUUID } from 'node:crypto';
import { MediaInputError } from './media.js';
import { isOwner } from './owner.js';
import { openPrivateDatabase } from './private-storage.js';

export const MEDIA_LIMITS = { user: { image: 2, video: 1 }, server: { image: 5, video: 3 } };
export const mediaDay = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

// Synchronous transactions serialize admission across channels and DB connections.
export class MediaStore {
  constructor(directory, { now = Date.now } = {}) {
    this.now = now;
    // Share the historical conversation database, including existing media jobs.
    this.db = openPrivateDatabase(directory, 'kirmy.sqlite');
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS media_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, guild_id TEXT NOT NULL,
        day TEXT NOT NULL, kind TEXT NOT NULL, units INTEGER NOT NULL,
        exempt INTEGER NOT NULL, state TEXT NOT NULL, request_id TEXT,
        model TEXT, result TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_daily ON media_requests(day, kind, user_id, guild_id);
      CREATE INDEX IF NOT EXISTS media_pending ON media_requests(state);`);
  }
  count(column, actor, kind, day) {
    if (!['user_id', 'guild_id'].includes(column)) throw new Error('Invalid usage scope');
    return this.db.prepare(`SELECT COALESCE(SUM(units), 0) AS used FROM media_requests
      WHERE ${column}=? AND kind=? AND day=? AND exempt=0 AND state!='released'`)
      .get(actor, kind, day).used;
  }
  reserve({ userId, guildId, kind, units = 1, model }) {
    if (!/^\d{17,20}$/.test(userId) || (guildId && !/^\d{17,20}$/.test(guildId)) ||
      !['image', 'video'].includes(kind) || !Number.isInteger(units) || units < 1 || units > 10) {
      throw new Error('Invalid media reservation');
    }
    const day = mediaDay(this.now()), exempt = isOwner(userId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!exempt) {
        for (const [scope, column, actor] of [['user', 'user_id', userId], ['server', 'guild_id', guildId]]) {
          if (actor && this.count(column, actor, kind, day) + units > MEDIA_LIMITS[scope][kind]) {
            throw new MediaInputError(`Daily ${scope} ${kind} limit reached (${MEDIA_LIMITS[scope][kind]}). Limits reset at midnight Europe/Budapest. No media request was submitted.`);
          }
        }
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO media_requests
        (id,user_id,guild_id,day,kind,units,exempt,state,model,created_at) VALUES (?,?,?,?,?,?,?,'reserved',?,?)`)
        .run(id, userId, guildId ?? '', day, kind, units, Number(exempt), model ?? null, this.now());
      this.db.exec('COMMIT');
      return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  submitting(id) { this.db.prepare("UPDATE media_requests SET state='submitting' WHERE id=? AND state='reserved'").run(id); }
  submitted(id, requestId) {
    this.db.prepare("UPDATE media_requests SET state='pending',request_id=? WHERE id=?").run(requestId, id);
  }
  complete(id, result) {
    this.db.prepare("UPDATE media_requests SET state='completed',result=? WHERE id=?").run(JSON.stringify(result), id);
  }
  fail(id) { this.db.prepare("UPDATE media_requests SET state='failed' WHERE id=?").run(id); }
  uncertain(id) { this.db.prepare("UPDATE media_requests SET state='unknown' WHERE id=? AND state='submitting'").run(id); }
  release(id) { this.db.prepare("UPDATE media_requests SET state='released' WHERE id=?").run(id); }
  recover() {
    // A crash before submission is safe to refund. Ambiguous POSTs remain charged
    // against the daily allowance and are never automatically resubmitted.
    this.db.exec("UPDATE media_requests SET state='released' WHERE state='reserved'; UPDATE media_requests SET state='unknown' WHERE state='submitting'");
  }
  pending() { return this.db.prepare("SELECT * FROM media_requests WHERE state='pending' ORDER BY created_at LIMIT 100").all(); }
  jobs(userId, guildId) {
    return this.db.prepare(`SELECT * FROM media_requests WHERE user_id=? AND guild_id=?
      AND state NOT IN ('reserved','released') ORDER BY created_at DESC LIMIT 10`).all(userId, guildId ?? '');
  }
  hasCompletedMedia(kind, url, { userId, guildId }) {
    const guild = guildId ?? '';
    return Boolean(this.db.prepare(`SELECT 1 FROM media_requests
      WHERE guild_id=? AND (?<>'' OR user_id=?) AND state='completed' AND kind=?
      AND CASE WHEN json_valid(result) THEN json_extract(result,'$.url')=?
        OR EXISTS (SELECT 1 FROM json_each(result,'$.urls') WHERE value=?) ELSE 0 END
      LIMIT 1`).get(guild, guild, userId, kind, url, url));
  }
  usage({ userId, guildId } = {}) {
    const day = mediaDay(this.now());
    const rows = this.db.prepare(`SELECT kind, state, exempt, SUM(units) AS units FROM media_requests
      WHERE day=? AND state!='released' AND (? IS NULL OR user_id=?) AND (? IS NULL OR guild_id=?)
      GROUP BY kind,state,exempt`).all(day, userId ?? null, userId ?? null, guildId ?? null, guildId ?? null);
    return { day, rows };
  }
  close() { this.db.close(); }
}
