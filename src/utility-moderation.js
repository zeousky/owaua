import { ApplicationCommandOptionType as Option, InteractionContextType, PermissionFlagsBits as Permission } from 'discord.js';
import { openPrivateDatabase } from './private-storage.js';
import { assertSafeText } from './safety.js';
import { discordDate, safeDisplayText, UtilityInputError } from './utility-input.js';

const MINUTE = 60_000;
const HISTORY_AGE_MS = 180 * 24 * 60 * MINUTE;
const REQUEST_LIMIT = 5;
const guild = [InteractionContextType.Guild];
const target = { type: Option.User, name: 'user', description: 'Server member to moderate', required: true };
const targetId = { type: Option.String, name: 'user_id', description: 'Discord user ID', min_length: 17, max_length: 23 };
const reason = { type: Option.String, name: 'reason', description: 'Reason to include in the moderation record', max_length: 240 };
const channelPermissions = [Permission.ViewChannel, Permission.ReadMessageHistory, Permission.ManageMessages];

const moderatorPermission = {
  purge: Permission.ManageMessages, warn: Permission.ModerateMembers, timeout: Permission.ModerateMembers,
  ban: Permission.BanMembers, unban: Permission.BanMembers, modhistory: Permission.ViewAuditLog,
};
const command = (name, description, options) => ({
  name, description, contexts: guild, default_member_permissions: moderatorPermission[name].toString(), options,
});
export const moderationCommands = [
  command('purge', 'Delete recent messages from this channel', [
    { type: Option.Integer, name: 'amount', description: 'Number of recent messages to check', required: true, min_value: 1, max_value: 100 },
    { ...target, description: 'Only delete messages from this user', required: false },
    reason,
  ]),
  command('warn', 'Record a warning and try to notify the member in a DM', [target, { ...reason, required: true }]),
  command('timeout', 'Time out a server member or end their timeout', [
    target, { type: Option.Integer, name: 'minutes', description: 'Timeout in minutes (up to 28 days). Enter 0 to remove it.',
      required: true, min_value: 0, max_value: 40_320 }, reason,
  ]),
  command('ban', 'Ban a member of this server', [target, reason]),
  command('unban', 'Remove a ban using a Discord user ID', [{ ...targetId, required: true }, reason]),
  command('modhistory', 'Review recent moderation cases recorded by Owaua', [
    targetId, { type: Option.Integer, name: 'before', description: 'Show cases with an ID lower than this one', min_value: 1 },
  ]),
];

function userId(value) {
  const id = /^(?:<@!?(\d{17,20})>|(\d{17,20}))$/u.exec(value.trim());
  if (!id) throw new UtilityInputError('Enter a Discord user ID.');
  return id[1] ?? id[2];
}

function needPermission(permission) {
  const names = new Map([
    [Permission.ManageMessages, 'Manage Messages'], [Permission.ModerateMembers, 'Moderate Members'],
    [Permission.BanMembers, 'Ban Members'], [Permission.ViewAuditLog, 'View Audit Log'],
  ]);
  return new UtilityInputError(`You need the ${names.get(permission)} permission to use this command.`);
}

async function moderator(interaction, permission) {
  const { guild, memberPermissions, user, commandName } = interaction;
  if (!guild) throw new UtilityInputError('Use this command in a server.');
  if (!memberPermissions?.has(permission)) throw needPermission(permission);
  const actor = await guild.members.fetch({ user: user.id, force: true });
  const currentPermissions = commandName === 'purge' ? interaction.channel?.permissionsFor?.(actor) : actor.permissions;
  if (!currentPermissions?.has(permission)) throw needPermission(permission);
  if (actor.isCommunicationDisabled()) throw new UtilityInputError('You cannot use moderation commands during a timeout.');
  return actor;
}

async function getModerationTarget(interaction, actor, client, action) {
  const { guild, options } = interaction;
  const selected = options.getUser('user', true);
  if ([actor.id, guild.ownerId, client.user.id].includes(selected.id)) {
    throw new UtilityInputError('You cannot moderate yourself, the server owner, or Owaua.');
  }
  let member;
  try { member = await guild.members.fetch({ user: selected.id, force: true }); }
  catch (error) {
    if (error?.code === 10007) throw new UtilityInputError('That user is no longer a member of this server.');
    throw error;
  }
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
    throw new UtilityInputError('Your highest role must be above the member’s highest role.');
  }
  if (action === 'warn') return member;
  await guild.members.fetchMe({ force: true });
  if (action === 'timeout' && !member.moderatable) {
    throw new UtilityInputError('Owaua needs Moderate Members and a role above the member’s highest role. Discord excludes administrators from timeouts.');
  }
  if (action === 'ban' && !member.bannable) {
    throw new UtilityInputError('Owaua needs Ban Members and a role above the member’s highest role.');
  }
  return member;
}

class ModerationCases {
  constructor(directory) {
    this.db = openPrivateDatabase(directory, 'moderation.sqlite');
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS case_numbers (
        guild_id TEXT PRIMARY KEY,
        last_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cases (
        id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        target_id TEXT,
        action TEXT NOT NULL,
        reason TEXT,
        detail TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, id)
      );
      CREATE INDEX IF NOT EXISTS cases_by_target ON cases (guild_id, target_id, id DESC);
      CREATE INDEX IF NOT EXISTS cases_by_time ON cases (created_at);
    `);
  }
  prune(guildId, now = Date.now()) {
    this.db.prepare('DELETE FROM cases WHERE created_at < ?').run(now - HISTORY_AGE_MS);
    this.db.prepare(`DELETE FROM cases WHERE guild_id = ? AND id <= (
      SELECT id FROM cases WHERE guild_id = ? ORDER BY id DESC LIMIT 1 OFFSET 5000
    )`).run(guildId, guildId);
  }
  start(interaction, record) {
    const { guildId, id: interactionId, user } = interaction;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM cases WHERE interaction_id = ?').get(interactionId)) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const { last_id: id } = this.db.prepare(`INSERT INTO case_numbers (guild_id, last_id) VALUES (?, 1)
        ON CONFLICT (guild_id) DO UPDATE SET last_id = last_id + 1 RETURNING last_id`).get(guildId);
      this.db.prepare(`INSERT INTO cases (id, guild_id, interaction_id, actor_id, target_id, action, reason, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
        id, guildId, interactionId, user.id, record.target ?? null, record.action, record.reason || null, Date.now(),
      );
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  finish(guildId, id, state, detail = null) {
    this.db.prepare('UPDATE cases SET state = ?, detail = ? WHERE guild_id = ? AND id = ?').run(state, detail, guildId, id);
  }
  recent(guildId, target, before = Number.MAX_SAFE_INTEGER) {
    const conditions = target ? 'AND target_id = ?' : '';
    return this.db.prepare(`SELECT id, actor_id, target_id, action, reason, detail, state, created_at FROM cases
      WHERE guild_id = ? AND id < ? AND created_at >= ? ${conditions} ORDER BY id DESC LIMIT ?`)
      .all(guildId, before, Date.now() - HISTORY_AGE_MS, ...(target ? [target] : []), REQUEST_LIMIT + 1);
  }
  close() {
    this.db.close();
  }
}

function historyPayload(cases, interaction) {
  const input = interaction.options.getString('user_id');
  const target = input ? userId(input) : null;
  const matches = cases.recent(interaction.guildId, target, interaction.options.getInteger('before') ?? undefined);
  if (!matches.length) return { content: 'No matching Owaua moderation cases from the past 180 days.' };
  const rows = matches.slice(0, REQUEST_LIMIT);
  const lines = rows.map(row => {
    const who = row.target_id ? ` for <@${row.target_id}>` : '';
    const details = row.detail ? ` · ${row.detail}` : '';
    const outcome = row.state === 'success' ? '' : row.state === 'failed' ? ' · Failed' : ' · Outcome unconfirmed';
    return `**#${row.id} ${row.action}${who}**${details}${outcome}\nBy <@${row.actor_id}> · ${discordDate(row.created_at)}` +
      (row.reason ? `\n${safeDisplayText(row.reason, 'Reason unavailable')}` : '');
  });
  if (matches.length > REQUEST_LIMIT) lines.push(`Find older cases with \`/modhistory before:${rows.at(-1).id}\`.`);
  return { embeds: [{ title: 'Owaua moderation history', description: lines.join('\n\n') }] };
}

async function preparePurge(interaction, actor, client) {
  const { channel, guild, options } = interaction;
  if (!channel?.messages || typeof channel.bulkDelete !== 'function') {
    throw new UtilityInputError('Use /purge in a server text channel or thread.');
  }
  const bot = await guild.members.fetchMe({ force: true });
  if (bot.id !== client.user.id || !interaction.appPermissions?.has(channelPermissions) ||
      !channel.permissionsFor(bot)?.has(channelPermissions)) {
    throw new UtilityInputError('Owaua needs access to the channel, Read Message History, and Manage Messages.');
  }
  if (!channel.permissionsFor(actor)?.has(channelPermissions)) {
    throw new UtilityInputError('You need access to the channel, Read Message History, and Manage Messages.');
  }
  const limit = options.getInteger('amount', true);
  const selected = options.getUser('user');
  const messages = await channel.messages.fetch({ limit, cache: false });
  // Leave a short buffer before Discord's 14-day bulk deletion cutoff.
  const cutoff = Date.now() - 14 * 24 * 60 * MINUTE + MINUTE;
  const matches = messages.filter(message => !message.pinned && message.bulkDeletable &&
    message.createdTimestamp > cutoff && (!selected || message.author.id === selected.id));
  return {
    target: selected?.id,
    async perform() {
      if (!matches.size) return { content: 'No eligible recent messages matched. Owaua leaves pinned messages in place.' };
      let deleted;
      if (matches.size === 1) {
        await matches.first().delete();
        deleted = 1;
      } else {
        deleted = (await channel.bulkDelete(matches, true)).size;
      }
      const count = `${deleted} message${deleted === 1 ? '' : 's'}`;
      return { content: `Deleted ${count}.`, detail: `${count} deleted` };
    },
  };
}

async function prepareAction(interaction, actor, client, action, reason) {
  const { options, guild } = interaction;
  if (action === 'purge') return preparePurge(interaction, actor, client);
  if (action === 'unban') {
    const target = userId(options.getString('user_id', true));
    const bot = await guild.members.fetchMe({ force: true });
    if (!bot.permissions.has(Permission.BanMembers)) throw new UtilityInputError('Owaua needs Ban Members to remove bans.');
    return { target, async perform(auditReason) {
      await guild.bans.remove(target, auditReason);
      return { content: `Removed the ban for <@${target}>.` };
    } };
  }
  const member = await getModerationTarget(interaction, actor, client, action);
  return {
    target: member.id,
    async perform(auditReason) {
      if (action === 'warn') return { content: `Warning recorded for <@${member.id}>.` };
      if (action === 'timeout') {
        const minutes = options.getInteger('minutes', true);
        await member.timeout(minutes ? minutes * MINUTE : null, auditReason);
        return minutes ? { content: `Timed out <@${member.id}> for ${minutes} minutes.`, detail: `${minutes} minutes` } :
          { content: `Removed the timeout for <@${member.id}>.`, detail: 'Timeout ended' };
      }
      await guild.bans.create(member.id, { reason: auditReason, deleteMessageSeconds: 0 });
      return { content: `Banned <@${member.id}>.` };
    },
    ...(action === 'warn' ? { async notify() {
      const text = `You received a warning in **${safeDisplayText(guild.name, 'a server')}**.\n**Reason** ${safeDisplayText(reason)}`;
      try {
        await member.send({ content: text, allowedMentions: { parse: [] } });
        return 'The member was notified by DM.';
      } catch {
        return 'The member’s DM could not be delivered.';
      }
    } } : {}),
  };
}

function assertReason(input) {
  assertSafeText(input);
  if (input && /^\s*$/u.test(input)) throw new UtilityInputError('Enter a reason or leave the option blank.');
  return input.trim();
}

export function createModerationFeatures({ directory, client, signal, logError }) {
  const cases = new ModerationCases(directory);
  return {
    async handleCommand(interaction) {
      const action = interaction.commandName;
      const actor = await moderator(interaction, moderatorPermission[action]);
      if (action === 'modhistory') return historyPayload(cases, interaction);
      const reason = assertReason(interaction.options.getString('reason') ?? '');
      if (action === 'warn' && !reason) throw new UtilityInputError('Enter a reason for the warning.');
      const operation = await prepareAction(interaction, actor, client, action, reason);
      signal?.throwIfAborted();
      cases.prune(interaction.guildId);
      const id = cases.start(interaction, { ...operation, action, reason });
      if (id === null) throw new UtilityInputError('This moderation request was already recorded. Check /modhistory.');
      let result;
      try {
        result = await operation.perform(`Owaua case #${id} by moderator ${actor.id}`);
      } catch (error) {
        logError('owaua_moderation_action_error', error);
        if ([400, 403, 404].includes(error?.status)) {
          cases.finish(interaction.guildId, id, 'failed');
          if (error.status === 403) return { content: `Discord refused case #${id}. Check Owaua’s permissions and role position.` };
          if (error.code === 10026) return { content: `That user does not have a ban to remove (case #${id}).` };
          return { content: `Discord rejected case #${id}. Check the member, channel, and bot permissions.` };
        }
        return { content: `Discord did not confirm whether case #${id} succeeded. Check Discord before retrying.` };
      }
      try { cases.finish(interaction.guildId, id, 'success', result.detail); }
      catch (error) {
        logError('owaua_moderation_save_error', error);
        return { content: `${result.content} Case #${id} could not be marked complete.` };
      }
      const notification = operation.notify ? ` ${await operation.notify()}` : '';
      return { content: `${result.content} Case #${id}.${notification}` };
    },
    close() { cases.close(); },
  };
}
