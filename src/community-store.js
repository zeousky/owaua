import { openPrivateDatabase } from './private-storage.js';

export function openCommunityStore(directory) {
  const db = openPrivateDatabase(directory, 'community.sqlite');
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT NOT NULL, feature TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (guild_id, feature)
    );
    CREATE TABLE IF NOT EXISTS role_panels (
      message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      mode TEXT NOT NULL, role_ids TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS role_panels_guild ON role_panels(guild_id);
    CREATE TABLE IF NOT EXISTS member_roles (
      guild_id TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (guild_id,role_id)
    );
    CREATE TABLE IF NOT EXISTS pending_autoroles (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS starboard_posts (
      source_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, source_channel_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, message_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS starboard_posts_message ON starboard_posts(message_id);
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, staff_role_id TEXT,
      category_id TEXT, channel_id TEXT UNIQUE, status TEXT NOT NULL CHECK (status IN ('opening', 'open', 'closed'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_active_owner ON tickets(guild_id, owner_id) WHERE status <> 'closed';`);
  const readSetting = db.prepare('SELECT value FROM settings WHERE guild_id=? AND feature=?');
  const writeSetting = db.prepare(`INSERT INTO settings(guild_id,feature,value) VALUES(?,?,?)
    ON CONFLICT(guild_id,feature) DO UPDATE SET value=excluded.value`);
  const clearSetting = db.prepare('DELETE FROM settings WHERE guild_id=? AND feature=?');
  return {
    db,
    get(guildId, feature) {
      const record = readSetting.get(guildId, feature);
      return record && JSON.parse(record.value);
    },
    set(guildId, feature, value) {
      writeSetting.run(guildId, feature, JSON.stringify(value));
    },
    clear(guildId, feature) {
      return clearSetting.run(guildId, feature).changes > 0;
    },
    markMemberRole(guildId, roleId) {
      db.prepare('INSERT OR IGNORE INTO member_roles(guild_id,role_id) VALUES(?,?)').run(guildId, roleId);
    },
    isMemberRole(guildId, roleId) {
      return !!db.prepare('SELECT 1 FROM member_roles WHERE guild_id=? AND role_id=?').get(guildId, roleId) ||
        this.get(guildId, 'welcome')?.roleId === roleId ||
        !!db.prepare(`SELECT 1 FROM role_panels AS p, json_each(p.role_ids) AS r
          WHERE p.guild_id=? AND r.value=? LIMIT 1`).get(guildId, roleId);
    },
    isSupportRole(guildId, roleId) {
      return this.get(guildId, 'ticket')?.staffRoleId === roleId ||
        !!db.prepare('SELECT 1 FROM tickets WHERE guild_id=? AND staff_role_id=? LIMIT 1').get(guildId, roleId);
    },
  };
}
