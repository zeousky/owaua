import { createHash } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, escapeMarkdown, MessageFlags, PermissionFlagsBits as P,
} from 'discord.js';
import { openPrivateDatabase } from './private-storage.js';
import { assertSafeText, SafetyError, withRequestUser } from './safety.js';
import { cleanLanguageRequired, containsProfanity } from './server-language.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MENTIONS = { parse: [], repliedUser: false };
const PERMANENT_DISCORD_ERRORS = new Set([10003, 10007, 10008, 10013, 50001, 50007, 50013]);
const GUILD_TEXT_CHANNELS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

class PersonalInputError extends Error {}

function fail(message) { throw new PersonalInputError(message); }

export function reminderDelay(value) {
  const units = { s: 1000, m: 60000, h: HOUR, d: DAY, w: 7 * DAY };
  const text = value.trim().toLowerCase();
  if (!/^(?:[1-9]\d*\s*[smhdw]\s*)+$/.test(text)) return NaN;
  return Array.from(text.matchAll(/(\d+)\s*([smhdw])/g), ([, amount, unit]) => Number(amount) * units[unit])
    .reduce((total, part) => total + part, 0);
}

export function reminderTime(value, now) {
  const text = value.trim();
  const delay = reminderDelay(text);
  let timestamp = now + delay;
  if (!Number.isFinite(delay)) {
    const date = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(text);
    timestamp = date ? Date.parse(text) : NaN;
    if (date && !Number.isNaN(timestamp) && new Date(date[1]).toISOString().slice(0, 10) !== date[1]) timestamp = NaN;
  }
  if (!Number.isFinite(timestamp) || timestamp < now + 30000 || timestamp > now + 365 * DAY) {
    fail('Choose a time between 30 seconds and one year from now. Use a delay like 2h30m or include the time zone offset in an ISO date.');
  }
  return timestamp;
}

function safeText(text, guildId, max) {
  const value = text?.trim() ?? '';
  if (!value || value.length > max) fail(`Enter text between 1 and ${max} characters.`);
  assertSafeText(value);
  if (cleanLanguageRequired(guildId) && containsProfanity(value)) fail('Use family-friendly text in this server.');
  return value;
}

function shows(value) {
  return escapeMarkdown(value).replaceAll('@', '@\u200b').replace(/\s+/g, ' ');
}

function privateMessage(interaction, content) {
  const payload = { content, allowedMentions: MENTIONS };
  return interaction.deferred ? interaction.editReply(payload) : interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function whenDiscord(ms) { return `<t:${Math.floor(ms / 1000)}:R>`; }

export function followingOccurrence(due, period, now) {
  return due + (Math.floor(Math.max(0, now - due) / period) + 1) * period;
}

export function createPersonalFeatures({ directory, client, allowed, signal, logError, clock = Date.now }) {
  const db = openPrivateDatabase(directory, 'personal-features.sqlite');
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, guild TEXT NOT NULL,
      channel TEXT, body TEXT NOT NULL, due INTEGER NOT NULL, period INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, failed INTEGER
    );
    CREATE INDEX IF NOT EXISTS reminders_due ON reminders(next_attempt) WHERE failed IS NULL;
    CREATE INDEX IF NOT EXISTS reminders_owner ON reminders(owner,guild);
    CREATE INDEX IF NOT EXISTS reminders_guild ON reminders(guild);
    CREATE TABLE IF NOT EXISTS button_polls (
      id TEXT PRIMARY KEY, guild TEXT NOT NULL, channel TEXT NOT NULL, message TEXT UNIQUE,
      owner TEXT NOT NULL, question TEXT NOT NULL, answers TEXT NOT NULL, ends INTEGER NOT NULL,
      closed INTEGER, published INTEGER
    );
    CREATE INDEX IF NOT EXISTS polls_due ON button_polls(ends) WHERE published IS NULL;
    CREATE INDEX IF NOT EXISTS polls_guild ON button_polls(guild, owner);
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll TEXT NOT NULL REFERENCES button_polls(id) ON DELETE CASCADE, voter TEXT NOT NULL,
      choice INTEGER NOT NULL, PRIMARY KEY(poll,voter)
    );
    CREATE TABLE IF NOT EXISTS afk_status (
      guild TEXT NOT NULL, user TEXT NOT NULL, reason TEXT NOT NULL, since INTEGER NOT NULL,
      PRIMARY KEY(guild,user)
    );`);

  let timer, worker;
  let stopped = false;
  let lastPrune = 0;
  const publishing = new Map();
  const notices = new Map();

  async function scheduledChannel(guildId, channelId, ownerId) {
    const channel = await client.channels.fetch(channelId, { force: true });
    if (channel?.guildId !== guildId || !GUILD_TEXT_CHANNELS.has(channel?.type)) return null;
    const [owner, bot] = await Promise.all([
      channel.guild.members.fetch({ user: ownerId, force: true }),
      channel.guild.members.fetchMe({ force: true }),
    ]);
    return !owner.isCommunicationDisabled?.() && channel.permissionsFor(owner)?.has([P.ViewChannel, P.SendMessages, P.ManageMessages]) &&
      channel.permissionsFor(bot)?.has([P.ViewChannel, P.SendMessages]) ? channel : null;
  }

  async function addReminder(interaction, scheduled) {
    const options = interaction.options;
    const owner = interaction.user.id;
    const guild = scheduled ? interaction.guildId : '';
    if (scheduled && !guild) fail('Schedule server messages from a server channel.');
    const now = clock();
    const due = reminderTime(options.getString('when', true), now);
    const body = safeText(options.getString('message', true), scheduled ? guild : null, scheduled ? 1500 : 1000);
    const repeat = options.getString('repeat');
    const period = repeat ? reminderDelay(repeat) : 0;
    if (repeat && !(period >= HOUR && period <= 365 * DAY)) fail('Choose a repeat interval between one hour and one year.');
    const channel = scheduled ? options.getChannel('channel', true).id : null;
    if (scheduled) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!await scheduledChannel(guild, channel, owner).catch(() => null)) {
        fail('You need View Channel, Send Messages, and Manage Messages in the destination. Owaua needs permission to view and post there.');
      }
    }
    if (stopped || signal?.aborted) fail('Owaua is restarting. Try again in a moment.');
    const count = db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE owner=? AND guild=?').get(owner, guild).n;
    if (count >= 20) fail('You can save up to 20 reminders in this list. Remove one before adding another.');
    if (channel && db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE guild=?').get(guild).n >= 100) fail('This server has 100 scheduled messages. Cancel one before adding another.');
    const { lastInsertRowid: id } = db.prepare(`INSERT INTO reminders(owner,guild,channel,body,due,period,next_attempt)
      VALUES(?,?,?,?,?,?,?)`).run(owner, guild, channel, body, due, period, due);
    const suffix = period ? ' It repeats at the interval you entered.' : '';
    return privateMessage(interaction, scheduled
      ? `Scheduled message #${id} in <#${channel}> for ${whenDiscord(due)}.${suffix}`
      : `Reminder #${id} is set for ${whenDiscord(due)} by DM. Keep DMs enabled for Owaua.${suffix}`);
  }

  function reminderCommand(interaction) {
    if (interaction.commandName === 'remind') return addReminder(interaction, false);
    const action = interaction.options.getSubcommand();
    if (action === 'schedule') return addReminder(interaction, true);
    const scheduled = action === 'scheduled' || action === 'cancel';
    const guild = scheduled ? interaction.guildId : '';
    if (scheduled && !guild) fail('Open this list from the server where you scheduled the message.');
    if (action === 'remove' || action === 'cancel') {
      const id = interaction.options.getInteger('id', true);
      const { changes } = db.prepare('DELETE FROM reminders WHERE id=? AND owner=? AND guild=?').run(id, interaction.user.id, guild);
      return privateMessage(interaction, changes ? `Removed #${id}.` : 'No matching entry in your list.');
    }
    const rows = db.prepare('SELECT id,channel,body,due,period,failed FROM reminders WHERE owner=? AND guild=? ORDER BY due')
      .all(interaction.user.id, guild);
    const list = rows.map(row => {
      const state = row.failed ? 'delivery failed' : `${whenDiscord(row.due)}${row.period ? ', repeats' : ''}`;
      return `#${row.id} · ${state}${row.channel ? ` · <#${row.channel}>` : ''} · ${shows(row.body.slice(0, 16))}`;
    });
    return privateMessage(interaction, list.join('\n') || 'This list is empty.');
  }

  async function deliver(row) {
    const isPending = () => !stopped && !signal?.aborted && db.prepare('SELECT 1 FROM reminders WHERE id=? AND due=?').get(row.id, row.due);
    try {
      if (row.guild && !allowed(row.guild)) { stopDelivery(row); return; }
      const channel = row.channel
        ? await scheduledChannel(row.guild, row.channel, row.owner)
        : await (await client.users.fetch(row.owner)).createDM();
      if (!isPending()) return;
      if (!channel) { stopDelivery(row); return; }
      try {
        withRequestUser(row.owner, () => safeText(row.body, row.guild || null, row.channel ? 1500 : 1000));
      } catch (error) {
        if (!(error instanceof SafetyError || error instanceof PersonalInputError)) throw error;
        stopDelivery(row);
        return;
      }
      // Discord de-duplicates retries of the same occurrence for a short window.
      const nonce = createHash('sha256').update(`reminder:${row.id}:${row.due}`).digest('hex').slice(0, 24);
      await channel.send({
        content: row.channel ? row.body : `**Reminder**\n${row.body}`, nonce, enforceNonce: true, allowedMentions: MENTIONS,
        flags: MessageFlags.SuppressEmbeds,
      });
      if (row.period) {
        const next = followingOccurrence(row.due, row.period, clock());
        db.prepare('UPDATE reminders SET due=?, next_attempt=?, attempts=0 WHERE id=? AND due=?')
          .run(next, next, row.id, row.due);
      } else {
        db.prepare('DELETE FROM reminders WHERE id=? AND due=?').run(row.id, row.due);
      }
    } catch (error) {
      if (!isPending()) return;
      if (PERMANENT_DISCORD_ERRORS.has(error?.code) || row.attempts >= 4) { stopDelivery(row); return; }
      db.prepare('UPDATE reminders SET next_attempt=?,attempts=attempts+1 WHERE id=? AND due=?')
        .run(clock() + 60000 * 2 ** row.attempts, row.id, row.due);
      logError('reminder_delivery_error', error);
    }
  }

  function stopDelivery(row) {
    db.prepare('UPDATE reminders SET failed=? WHERE id=? AND due=?').run(clock(), row.id, row.due);
  }

  function pollContent(poll, results = null) {
    const answers = JSON.parse(poll.answers);
    const lines = answers.map((answer, i) => `**${i + 1}.** ${shows(answer)}${results ? ` — ${results.get(i + 1) ?? 0}` : ''}`);
    return [`**${shows(poll.question)}**`, ...lines, poll.closed === null
      ? `Voting ends ${whenDiscord(poll.ends)}.` : 'Voting closed.'].join('\n');
  }

  function pollButtons(poll) {
    const answers = JSON.parse(poll.answers);
    const buttons = answers.map((_, i) => new ButtonBuilder()
      .setLabel(String(i + 1)).setStyle(ButtonStyle.Secondary).setCustomId(`owaua:poll:${poll.id}:${i + 1}`));
    const rows = [new ActionRowBuilder().addComponents(buttons.slice(0, 5))];
    if (buttons.length > 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(5)));
    return rows;
  }

  async function createPoll(interaction) {
    if (!interaction.inGuild() || !interaction.channel?.isSendable()) fail('Create a poll in a server text channel.');
    const options = interaction.options;
    const question = safeText(options.getString('question', true), interaction.guildId, 300);
    const answers = options.getString('options', true).split('|').map(answer => safeText(answer, interaction.guildId, 55));
    if (answers.length < 2 || answers.length > 10 || new Set(answers.map(answer => answer.toLowerCase())).size !== answers.length) {
      fail('Enter two to ten distinct answers separated by |.');
    }
    const format = options.getString('format') ?? 'native';
    const duration = options.getInteger('hours') ?? 24;
    const multi = options.getBoolean('multiple') ?? false;
    if (format === 'buttons' && multi) fail('Choose the Discord poll format to allow multiple answers.');
    const send = interaction.channel.isThread() ? P.SendMessagesInThreads : P.SendMessages;
    if (!interaction.memberPermissions?.has([P.ViewChannel, send]) ||
      !interaction.appPermissions?.has([P.ViewChannel, send])) fail('You and Owaua need permission to post in this channel.');
    if (format === 'native' && (!interaction.memberPermissions.has(P.SendPolls) || !interaction.appPermissions.has(P.SendPolls))) {
      fail('You and Owaua need Create Polls in this channel. Use format:Buttons for a button poll.');
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (stopped || signal?.aborted) fail('Owaua is restarting. Try again in a moment.');
    if (format === 'native') {
      const post = await interaction.channel.send({
        poll: { question: { text: question }, answers: answers.map(text => ({ text })), duration, allowMultiselect: multi },
        allowedMentions: MENTIONS,
      });
      return privateMessage(interaction, `Poll posted: ${post.url}`);
    }
    const poll = { id: interaction.id, guild: interaction.guildId, channel: interaction.channelId,
      owner: interaction.user.id, question, answers: JSON.stringify(answers), ends: clock() + duration * HOUR, closed: null };
    if (db.prepare('SELECT COUNT(*) AS n FROM button_polls WHERE guild=? AND ends>? AND closed IS NULL').get(poll.guild, clock()).n >= 50 ||
        db.prepare('SELECT COUNT(*) AS n FROM button_polls WHERE guild=? AND owner=? AND ends>? AND closed IS NULL').get(poll.guild, poll.owner, clock()).n >= 5) {
      fail('Too many button polls are open. Close a poll before creating another.');
    }
    db.prepare('INSERT INTO button_polls(id,guild,channel,owner,question,answers,ends) VALUES(?,?,?,?,?,?,?)')
      .run(poll.id, poll.guild, poll.channel, poll.owner, poll.question, poll.answers, poll.ends);
    let post;
    try {
      post = await interaction.channel.send({
        content: pollContent(poll), components: pollButtons(poll), allowedMentions: MENTIONS, flags: MessageFlags.SuppressEmbeds,
      });
      db.prepare('UPDATE button_polls SET message=? WHERE id=?').run(post.id, poll.id);
    } catch (error) {
      db.prepare('DELETE FROM button_polls WHERE id=?').run(poll.id);
      if (post) await post.delete().catch(() => {});
      throw error;
    }
    return privateMessage(interaction, `Poll posted: ${post.url}\nUse the buttons or \`/vote cast\` with the message link.`);
  }

  function voteResults(pollId) {
    return new Map(db.prepare('SELECT choice,COUNT(*) AS n FROM poll_votes WHERE poll=? GROUP BY choice').all(pollId)
      .map(row => [row.choice, row.n]));
  }

  function cast(interaction, poll, choice) {
    if (!poll || poll.closed !== null || poll.ends <= clock()) fail('This poll has ended or is unavailable.');
    if (!Number.isInteger(choice) || choice < 1 || choice > JSON.parse(poll.answers).length) fail('Choose one of the listed answers.');
    db.prepare(`INSERT INTO poll_votes (poll,voter,choice) VALUES(?,?,?)
      ON CONFLICT(poll,voter) DO UPDATE SET choice=excluded.choice`).run(poll.id, interaction.user.id, choice);
    return privateMessage(interaction, `Vote recorded for answer ${choice}.`);
  }

  async function publishClosedPoll(pollId) {
    if (publishing.has(pollId)) return publishing.get(pollId);
    const task = Promise.resolve().then(async () => {
      const now = clock();
      db.prepare('UPDATE button_polls SET closed=MIN(ends, ?) WHERE id=? AND closed IS NULL AND ends<=?').run(now, pollId, now);
      const poll = db.prepare('SELECT * FROM button_polls WHERE id=? AND message IS NOT NULL AND closed IS NOT NULL AND published IS NULL').get(pollId);
      if (!poll || stopped || signal?.aborted) return;
      try {
        if (allowed(poll.guild)) {
          const channel = await client.channels.fetch(poll.channel);
          if (channel?.guildId === poll.guild && !stopped && !signal?.aborted) {
            await channel.messages.edit(poll.message, {
              content: pollContent(poll, voteResults(poll.id)), components: [], allowedMentions: MENTIONS, flags: MessageFlags.SuppressEmbeds,
            });
          }
        }
      } catch (error) {
        if (!PERMANENT_DISCORD_ERRORS.has(error?.code) && now < poll.closed + DAY) {
          logError('poll_publish_error', error);
          return;
        }
      }
      db.prepare('UPDATE button_polls SET published=? WHERE id=?').run(now, pollId);
    }).finally(() => publishing.delete(pollId));
    publishing.set(pollId, task);
    return task;
  }

  async function voteCommand(interaction) {
    if (!interaction.inGuild()) fail('Open this command in the channel where the poll was posted.');
    const action = interaction.options.getSubcommand();
    const input = interaction.options.getString('poll', true).trim();
    const match = /^https:\/\/(?:canary\.|ptb\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/.exec(input);
    const id = /^\d{17,20}$/.test(input) ? input : match?.[1] === interaction.guildId && match[2] === interaction.channelId ? match[3] : '';
    const poll = db.prepare('SELECT * FROM button_polls WHERE guild=? AND channel=? AND message=?')
      .get(interaction.guildId, interaction.channelId, id || '');
    if (!poll) fail('Give the ID or link of a button poll in this channel.');
    if (action === 'cast') return cast(interaction, poll, interaction.options.getInteger('choice', true));
    if (action === 'results') {
      if (poll.ends <= clock()) poll.closed ??= poll.ends;
      return privateMessage(interaction, pollContent(poll, voteResults(poll.id)));
    }
    if (poll.owner !== interaction.user.id && !interaction.memberPermissions?.has(P.ManageMessages)) fail('Only the poll creator or a moderator can close it.');
    db.prepare('UPDATE button_polls SET closed=MIN(ends, ?) WHERE id=? AND closed IS NULL').run(clock(), poll.id);
    await privateMessage(interaction, 'Voting closed.');
    if (!stopped) await publishClosedPoll(poll.id);
  }

  function afkCommand(interaction) {
    if (!interaction.inGuild()) fail('Set an away status in the server where it should appear.');
    const options = interaction.options;
    if (options.getSubcommand() === 'clear') {
      const result = db.prepare('DELETE FROM afk_status WHERE guild=? AND user=?').run(interaction.guildId, interaction.user.id);
      return privateMessage(interaction, result.changes ? 'Your AFK status is cleared.' : 'You have no AFK status here.');
    }
    const raw = options.getString('reason');
    const reason = raw ? safeText(raw, interaction.guildId, 180) : 'Away';
    if (!db.prepare('SELECT 1 FROM afk_status WHERE guild=? AND user=?').get(interaction.guildId, interaction.user.id) &&
        db.prepare('SELECT COUNT(*) AS n FROM afk_status WHERE guild=?').get(interaction.guildId).n >= 1000) fail('This server has reached its AFK status limit.');
    db.prepare(`INSERT INTO afk_status(guild,user,reason,since) VALUES(?,?,?,?)
      ON CONFLICT(guild,user) DO UPDATE SET reason=excluded.reason,since=excluded.since`)
      .run(interaction.guildId, interaction.user.id, reason, clock());
    return privateMessage(interaction, 'You’re marked as AFK here until you send a message or clear your status.');
  }

  async function handleCommand(interaction) {
    try {
      if (interaction.commandName === 'poll') return await createPoll(interaction);
      if (interaction.commandName === 'vote') return await voteCommand(interaction);
      if (interaction.commandName === 'afk') return await afkCommand(interaction);
      return await reminderCommand(interaction);
    } catch (error) {
      if (error instanceof PersonalInputError || error instanceof SafetyError) return privateMessage(interaction, error.message);
      throw error;
    }
  }

  async function handleComponent(interaction) {
    if (!interaction.isButton() || !interaction.inGuild() || !allowed(interaction.guildId)) return;
    const match = /^owaua:poll:(\d{17,20}):(10|[1-9])$/.exec(interaction.customId);
    if (!match) return;
    const poll = db.prepare('SELECT * FROM button_polls WHERE id=? AND guild=? AND channel=? AND message=?')
      .get(match[1], interaction.guildId, interaction.channelId, interaction.message.id);
    try { await cast(interaction, poll, Number(match[2])); }
    catch (error) {
      if (!(error instanceof PersonalInputError)) throw error;
      await privateMessage(interaction, error.message);
    }
  }

  async function onMessage(message) {
    if (stopped || !message.guildId || !allowed(message.guildId) || message.author.bot || message.webhookId) return;
    const now = clock();
    db.prepare('DELETE FROM afk_status WHERE guild=? AND user=?').run(message.guildId, message.author.id);
    if ((notices.get(message.channelId) ?? -Infinity) > now - 20000) return;
    const mentions = message.mentions.users.filter(user => !user.bot && user.id !== message.author.id).first(10);
    const rows = [];
    for (const user of mentions) {
      const row = db.prepare('SELECT reason,since FROM afk_status WHERE guild=? AND user=? AND since>?').get(message.guildId, user.id, now - 30 * DAY);
      if (row) rows.push(`<@${user.id}> is AFK ${whenDiscord(row.since)} · ${shows(row.reason.slice(0, 100))}`);
      if (rows.length === 4) break;
    }
    if (rows.length) {
      if (notices.size >= 1000) notices.delete(notices.keys().next().value);
      notices.delete(message.channelId);
      notices.set(message.channelId, now);
      await message.reply({ content: rows.join('\n'), allowedMentions: MENTIONS, flags: MessageFlags.SuppressEmbeds });
    }
  }

  async function processDue() {
    const now = clock();
    if (now - lastPrune >= HOUR) {
      db.prepare('DELETE FROM button_polls WHERE (message IS NULL AND ends<?) OR published<?').run(now - DAY, now - 30 * DAY);
      db.prepare('DELETE FROM afk_status WHERE since<?').run(now - 30 * DAY);
      db.prepare('DELETE FROM reminders WHERE failed<?').run(now - 30 * DAY);
      lastPrune = now;
    }
    const due = db.prepare('SELECT * FROM reminders WHERE failed IS NULL AND next_attempt<=? ORDER BY next_attempt,id LIMIT 20').all(now);
    for (const row of due) {
      if (stopped || signal?.aborted) return;
      if (db.prepare('SELECT 1 FROM reminders WHERE id=? AND due=?').get(row.id, row.due)) await deliver(row);
    }
    const polls = db.prepare(`SELECT id FROM button_polls WHERE message IS NOT NULL AND published IS NULL AND (closed IS NOT NULL OR ends<=?)
      ORDER BY ends LIMIT 20`).all(now);
    for (const { id } of polls) {
      if (stopped || signal?.aborted) return;
      await publishClosedPoll(id);
    }
  }

  function tick() {
    if (stopped || signal?.aborted || !client.isReady()) return;
    worker ??= processDue().catch(error => logError('personal_worker_error', error)).finally(() => { worker = undefined; });
    return worker;
  }

  return { handleCommand, handleComponent, onMessage, tick,
    start() {
      if (timer || stopped) return;
      void tick();
      timer = setInterval(tick, 10000);
      timer.unref();
    },
    async close() {
      stopped = true;
      clearInterval(timer);
      await worker;
      await Promise.allSettled(publishing.values());
      db.close();
    },
  };
}
