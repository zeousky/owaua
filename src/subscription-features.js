import { randomBytes } from 'node:crypto';
import { ChannelType, Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { openPrivateDatabase } from './private-storage.js';
import { assertSafeText, SafetyError } from './safety.js';
import { fetchPublic, publicURL, PublicURLError } from './subscription-http.js';
import { feedItems, githubItems, githubRepository, GITHUB_API, GITHUB_EVENTS } from './subscription-sources.js';

const MINUTE = 60_000;
const subscriptionLimit = 300;
const githubSubscriptionLimit = 12;
const guildLimits = { github: 4, feed: 8, monitor: 8 };
const updateIntervals = { github: 15, feed: 5, monitor: 5 };
const notificationLimit = 25;
const noMentions = { parse: [], repliedUser: false };
const textChannels = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const requiredPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const destination = {
  type: 7, name: 'channel', description: 'Channel for updates (defaults to this channel)', channel_types: textChannels,
};
const urlOption = { type: 3, name: 'url', description: 'Public HTTP or HTTPS URL without login or query parameters', required: true, max_length: 800 };

function command(name, description, action, actionDescription, options) {
  return { name, description, contexts: [0], integration_types: [0], default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { type: 1, name: action, description: actionDescription, options: [...options, destination] },
      { type: 1, name: 'list', description: 'List the subscriptions configured for this server' },
      { type: 1, name: 'remove', description: 'Remove a subscription and its queued updates',
        options: [{ type: 4, name: 'id', description: 'Subscription ID from the list', required: true, min_value: 1 }] },
    ] };
}

export const subscriptionCommands = [
  command('github', 'Subscribe to public GitHub repository activity', 'watch', 'Watch commits, releases, issues, or pull requests', [
    { type: 3, name: 'repository', description: 'Public GitHub repository (owner/name or URL)', required: true, max_length: 150 },
    { type: 3, name: 'events', description: 'Events to include (defaults to everything)', choices: GITHUB_EVENTS },
  ]),
  command('feed', 'Subscribe to public RSS and Atom feeds', 'add', 'Post new items from a feed', [urlOption]),
  command('monitor', 'Monitor the uptime of public websites', 'add', 'Send downtime and recovery alerts', [
    urlOption, { type: 4, name: 'minutes', description: 'Minutes between checks (defaults to 5)', min_value: 5, max_value: 60 },
  ]),
];

function destinationPermissions(channel, guildId, user, bot) {
  return channel?.guildId === guildId && textChannels.includes(channel.type) &&
    (!user || channel.permissionsFor(user)?.has(requiredPermissions)) &&
    !!bot && channel.permissionsFor(bot)?.has(requiredPermissions);
}

function checkedTarget(kind, options) {
  if (kind === 'github') {
    const target = githubRepository(options.getString('repository', true));
    return assertSafeText(target);
  }
  return publicURL(options.getString('url', true)).href;
}

function websiteLabel(target) {
  const url = new URL(target);
  const path = url.pathname === '/' ? '' : url.pathname;
  const label = (url.hostname + path).replace(/[`*_~|[\]<>@]/g, '');
  return label.length > 120 ? label.slice(0, 117) + '…' : label;
}

class SubscriptionStore {
  constructor(directory) {
    this.db = openPrivateDatabase(directory, 'subscriptions.sqlite');
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS notification_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL, target TEXT NOT NULL, events TEXT NOT NULL, interval_ms INTEGER NOT NULL,
        due_at INTEGER NOT NULL, initialized INTEGER NOT NULL DEFAULT 0, etag TEXT,
        status TEXT NOT NULL DEFAULT 'Waiting for first check', checked_at INTEGER, failure_count INTEGER NOT NULL DEFAULT 0,
        outage_at INTEGER, send_at INTEGER NOT NULL DEFAULT 0, UNIQUE(kind,guild_id,channel_id,target,events)
      );
      CREATE INDEX IF NOT EXISTS notifications_due ON notification_subscriptions(due_at);
      CREATE TABLE IF NOT EXISTS subscription_seen (
        subscription_id INTEGER NOT NULL REFERENCES notification_subscriptions ON DELETE CASCADE,
        event_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(subscription_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS subscription_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subscription_id INTEGER NOT NULL REFERENCES notification_subscriptions ON DELETE CASCADE,
        content TEXT NOT NULL, nonce TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subscription_outbox_subscription ON subscription_outbox(subscription_id,id);
      CREATE TABLE IF NOT EXISTS subscription_limits (provider TEXT PRIMARY KEY, resume_at INTEGER NOT NULL);
    `);
  }

  add({ kind, guildId, channelId, target, events, intervalMs, now }) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT COUNT(*) AS count FROM notification_subscriptions WHERE guild_id=? AND kind=?').get(guildId, kind).count >= guildLimits[kind]) {
        return { error: `This server can have up to ${guildLimits[kind]} ${kind} subscriptions.` };
      }
      if (this.db.prepare('SELECT COUNT(*) AS count FROM notification_subscriptions').get().count >= subscriptionLimit) {
        return { error: 'Owaua has reached its subscription limit.' };
      }
      if (kind === 'github' && this.db.prepare("SELECT COUNT(*) AS count FROM notification_subscriptions WHERE kind='github'").get().count >= githubSubscriptionLimit) {
        return { error: 'Owaua has reached its GitHub subscription limit.' };
      }
      const saved = this.db.prepare(`INSERT INTO notification_subscriptions(kind,guild_id,channel_id,target,events,interval_ms,due_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,guild_id,channel_id,target,events) DO NOTHING RETURNING id`)
        .get(kind, guildId, channelId, target, events, intervalMs, now);
      return saved ?? { error: 'That subscription is already configured for this channel.' };
    });
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  list(kind, guildId) {
    return this.db.prepare('SELECT * FROM notification_subscriptions WHERE kind=? AND guild_id=? ORDER BY id').all(kind, guildId);
  }

  remove(kind, guildId, id) {
    return this.db.prepare('DELETE FROM notification_subscriptions WHERE kind=? AND guild_id=? AND id=?')
      .run(kind, guildId, id).changes;
  }

  removeGuild(guildId) {
    this.db.prepare('DELETE FROM notification_subscriptions WHERE guild_id=?').run(guildId);
  }

  removeChannel(guildId, channelId) {
    this.db.prepare('DELETE FROM notification_subscriptions WHERE guild_id=? AND channel_id=?').run(guildId, channelId);
  }

  get(id) { return this.db.prepare('SELECT * FROM notification_subscriptions WHERE id=?').get(id); }

  due(now) {
    return this.db.prepare('SELECT * FROM notification_subscriptions WHERE due_at<=? ORDER BY due_at,id').all(now);
  }

  pending(now) {
    return this.db.prepare(`SELECT * FROM notification_subscriptions s WHERE send_at<=?
      AND EXISTS(SELECT 1 FROM subscription_outbox WHERE subscription_id=s.id) ORDER BY send_at,id`).all(now);
  }

  enqueue(id, content) {
    this.db.prepare('INSERT INTO subscription_outbox(subscription_id,content,nonce) VALUES(?,?,?)')
      .run(id, content, randomBytes(12).toString('hex'));
    this.db.prepare(`DELETE FROM subscription_outbox WHERE subscription_id=? AND id NOT IN
      (SELECT id FROM subscription_outbox WHERE subscription_id=? ORDER BY id DESC LIMIT ?)`).run(id, id, notificationLimit);
  }

  nextMessage(id) {
    return this.db.prepare('SELECT id,content,nonce FROM subscription_outbox WHERE subscription_id=? ORDER BY id LIMIT 1').get(id);
  }

  sent(id) { this.db.prepare('DELETE FROM subscription_outbox WHERE id=?').run(id); }

  resumeSending(id, time) {
    this.db.prepare('UPDATE notification_subscriptions SET send_at=? WHERE id=?').run(time, id);
  }

  saveItems(row, items, etag, next, now) {
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO subscription_seen(subscription_id,event_id,seen_at) VALUES(?,?,?)
        ON CONFLICT(subscription_id,event_id) DO NOTHING`);
      const known = this.db.prepare('UPDATE subscription_seen SET seen_at=? WHERE subscription_id=? AND event_id=?');
      const updates = [];
      for (const item of items.toReversed()) {
        if (insert.run(row.id, item.key, now).changes) updates.push(item);
        else known.run(now, row.id, item.key);
      }
      if (row.initialized && updates.length) {
        // Group a burst into messages that fit Discord limits, preserving item order.
        const source = row.kind === 'github' ? row.target : websiteLabel(row.target);
        const title = `**${row.kind === 'github' ? 'GitHub' : 'Feed'} · ${source}**`;
        let message = title;
        for (const item of updates) {
          const line = `\n• ${item.title}${item.url ? ` <${item.url}>` : ''}`;
          if (message.length + line.length > 1900) {
            this.enqueue(row.id, message);
            message = title;
          }
          message += line;
        }
        this.enqueue(row.id, message);
      }
      this.db.prepare(`DELETE FROM subscription_seen WHERE subscription_id=? AND event_id NOT IN
        (SELECT event_id FROM subscription_seen WHERE subscription_id=? ORDER BY seen_at DESC,rowid DESC LIMIT 1000)`).run(row.id, row.id);
      this.db.prepare(`UPDATE notification_subscriptions SET etag=?,initialized=1,status='Active',failure_count=0,due_at=?,checked_at=? WHERE id=?`)
        .run(etag, next, now, row.id);
    });
  }

  fetchFailed(row, status, now) {
    const interval = Math.min(60 * MINUTE, row.interval_ms * 2 ** Math.min(row.failure_count, 4));
    this.db.prepare(`UPDATE notification_subscriptions SET status=?,checked_at=?,due_at=?,failure_count=failure_count+1 WHERE id=?`)
      .run(status, now, now + interval, row.id);
  }

  health(row, ok, status, now) {
    const failed = ok ? 0 : row.failure_count + 1;
    const outageAt = ok ? null : row.outage_at ?? (failed === 1 ? now : row.checked_at);
    this.transaction(() => {
      if (!ok && failed === 2) {
        this.enqueue(row.id, `**Website down** · ${websiteLabel(row.target)}\n${status}. First failed check <t:${Math.floor(outageAt / 1000)}:R>.`);
      } else if (ok && row.failure_count >= 2) {
        this.enqueue(row.id, `**Website recovered** · ${websiteLabel(row.target)}\n${status}. The outage began <t:${Math.floor(row.outage_at / 1000)}:R>.`);
      }
      const state = ok ? 'Up' : failed === 1 ? 'One failed check' : 'Down';
      this.db.prepare(`UPDATE notification_subscriptions SET status=?,outage_at=?,failure_count=?,checked_at=?,due_at=? WHERE id=?`)
        .run(`${state} (${status})`, outageAt, failed, now, now + row.interval_ms, row.id);
    });
  }

  providerReady(provider, now) {
    return (this.db.prepare('SELECT resume_at FROM subscription_limits WHERE provider=?').get(provider)?.resume_at ?? 0) <= now;
  }

  limitProvider(provider, time) {
    this.db.prepare(`INSERT INTO subscription_limits(provider,resume_at) VALUES(?,?)
      ON CONFLICT(provider) DO UPDATE SET resume_at=MAX(resume_at,excluded.resume_at)`).run(provider, time);
  }

  close() { this.db.close(); }
}

function providerDelay(result, now) {
  const seconds = header => /^\d{1,10}$/.test(result.headers[header] ?? '') ? Number(result.headers[header]) : 0;
  const responseReset = seconds('x-ratelimit-reset') * 1000 - now;
  const throttled = result.status === 429 || result.status === 403;
  return Math.max(
    65_000,
    seconds('retry-after') * 1000,
    result.headers['x-ratelimit-remaining'] === '0' ? responseReset : 0,
    throttled ? 5 * MINUTE : 0,
  );
}

export function createSubscriptionFeatures({
  directory, client, allowed, signal, logError, fetch = fetchPublic, clock = Date.now, tickMs = 10_000,
}) {
  const store = new SubscriptionStore(directory);
  const local = new AbortController();
  const running = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  let timer, cycle, closing;
  const enabled = row => allowed(row.guild_id) && client.guilds.cache.get(row.guild_id)?.available;
  const onGuildDelete = guild => {
    try { store.removeGuild(guild.id); }
    catch (error) { logError('subscription_cleanup_error', error); }
  };
  const onChannelDelete = channel => {
    if (!channel.guildId) return;
    try { store.removeChannel(channel.guildId, channel.id); }
    catch (error) { logError('subscription_cleanup_error', error); }
  };

  async function handleCommand(interaction) {
    const reply = content => interaction.reply({ content, allowedMentions: noMentions, flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds });
    const { guildId, guild, commandName: kind, options } = interaction;
    if (!guildId || !allowed(guildId) || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return reply('You need Manage Server permission to configure subscriptions here.');
    }
    if (running.aborted) return reply('Owaua is restarting. Try again in a moment.');
    const canView = row => {
      if (interaction.user.id === guild.ownerId) return true;
      const channel = guild.channels.cache.get(row.channel_id);
      return channel?.guildId === guildId && channel.permissionsFor(interaction.user.id)?.has(PermissionFlagsBits.ViewChannel);
    };
    switch (options.getSubcommand()) {
      case 'list': {
        const rows = store.list(kind, guildId).filter(canView);
        if (!rows.length) return reply('There are no subscriptions of this type in channels you can view.');
        return reply(rows.map(row => `**#${row.id}** · ${kind === 'github' ? `${row.target} (${row.events})` : websiteLabel(row.target)} → <#${row.channel_id}>\n${row.status}${
          row.checked_at ? ` · Checked <t:${Math.floor(row.checked_at / 1000)}:R>` : ''}`).join('\n\n'));
      }
      case 'remove': {
        const id = options.getInteger('id', true);
        const row = store.get(id);
        const removed = row?.guild_id === guildId && row.kind === kind && canView(row) && store.remove(kind, guildId, id);
        return reply(removed ? `Removed subscription #${id}.` : 'No matching subscription in channels you can view.');
      }
      default: {
        const channel = options.getChannel('channel') ?? interaction.channel;
        if (!destinationPermissions(channel, guildId, interaction.user.id, guild.members.me)) {
          return reply('Choose a server text or announcement channel that you and Owaua can both view and send messages in.');
        }
        let target;
        try { target = checkedTarget(kind, options); }
        catch (error) {
          if (error instanceof PublicURLError || error instanceof SafetyError) return reply(error.message);
          throw error;
        }
        const events = kind === 'github' ? options.getString('events') ?? 'all' : '';
        const minutes = kind === 'monitor' ? options.getInteger('minutes') ?? updateIntervals.monitor : updateIntervals[kind];
        const result = store.add({ kind, guildId, channelId: channel.id, target, events, intervalMs: minutes * MINUTE, now: clock() });
        const detail = kind === 'monitor' ? `Checks run about every ${minutes} minutes. Two consecutive failures trigger a downtime alert.`
          : 'The first successful check records existing activity. New activity will appear after that.';
        return reply(result.error ?? `Added subscription #${result.id} for <#${channel.id}>. ${detail}`);
      }
    }
  }

  async function poll(row) {
    const github = row.kind === 'github';
    const monitor = row.kind === 'monitor';
    const target = github ? `${GITHUB_API}/repos/${row.target}/events?per_page=100` : row.target;
    try {
      if (github) store.limitProvider('github', clock() + 65_000);
      const result = await fetch(target, {
        signal: running, statusOnly: monitor, fixedOrigin: github ? GITHUB_API : undefined, etag: row.etag,
        maxBytes: github ? 4_194_304 : 1_048_576,
      });
      if (running.aborted || !store.get(row.id)) return;
      const now = clock();
      const ok = result.status >= 200 && result.status < 300;
      const delay = github && /^\d{1,8}$/.test(result.headers['x-poll-interval'] ?? '') ? Number(result.headers['x-poll-interval']) * 1000 : 0;
      if (github) store.limitProvider('github', now + providerDelay(result, now));
      if (monitor) {
        store.health(row, ok, `HTTP ${result.status}`, now);
      } else if (result.status === 304 || ok) {
        const items = result.status === 304 ? [] : github ? githubItems(result.body, row.target, row.events) : feedItems(result.body, result.url);
        const etag = typeof result.headers.etag === 'string' && /^[\x20-\x7e]{1,200}$/.test(result.headers.etag) ? result.headers.etag : null;
        store.saveItems(row, items, etag ?? (result.status === 304 ? row.etag : null), now + Math.max(row.interval_ms, delay), now);
      } else {
        store.fetchFailed(row, `Source unavailable (HTTP ${result.status})`, now);
      }
    } catch (error) {
      if (running.aborted || !store.get(row.id)) return;
      const status = error instanceof PublicURLError ? 'Public address check failed' : 'Website or response unavailable';
      if (monitor) store.health(row, false, status, clock());
      else store.fetchFailed(row, status, clock());
    }
  }

  async function deliver(row) {
    const message = store.nextMessage(row.id);
    if (!message) return;
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (running.aborted || !store.get(row.id)) return;
      const guild = client.guilds.cache.get(row.guild_id);
      if (!destinationPermissions(channel, row.guild_id, null, guild?.members.me)) {
        store.resumeSending(row.id, clock() + 15 * MINUTE);
        return;
      }
      // Reuse the persisted nonce if Discord receives the message before the
      // delivery acknowledgment is recorded.
      await channel.send({ content: message.content, nonce: message.nonce, enforceNonce: true, allowedMentions: noMentions,
        flags: MessageFlags.SuppressEmbeds });
      store.sent(message.id);
      store.resumeSending(row.id, clock());
    } catch (error) {
      if (running.aborted) return;
      logError('subscription_delivery_error', error);
      store.resumeSending(row.id, clock() + 5 * MINUTE);
    }
  }

  async function run() {
    if (running.aborted || !client.isReady()) return;
    const due = store.due(clock()).filter(enabled);
    const websiteChecks = due.filter(row => row.kind !== 'github').slice(0, 4);
    const githubCheck = due.find(row => row.kind === 'github' && store.providerReady('github', clock()));
    const pending = store.pending(clock()).filter(enabled).slice(0, 4);
    await Promise.allSettled([...websiteChecks, ...(githubCheck ? [githubCheck] : [])].map(poll).concat(pending.map(deliver)))
      .then(results => {
        for (const result of results) if (result.status === 'rejected') logError('subscription_worker_error', result.reason);
      });
  }

  function start() {
    if (timer || running.aborted) return;
    const tick = () => {
      if (cycle || running.aborted) return;
      cycle = run().catch(error => logError('subscription_worker_error', error)).finally(() => { cycle = undefined; });
    };
    timer = setInterval(tick, tickMs);
    timer.unref();
    client.on(Events.GuildDelete, onGuildDelete);
    client.on(Events.ChannelDelete, onChannelDelete);
    tick();
  }

  function close() {
    closing ??= (async () => {
      clearInterval(timer);
      client.off(Events.GuildDelete, onGuildDelete);
      client.off(Events.ChannelDelete, onChannelDelete);
      local.abort();
      await cycle;
      store.close();
    })();
    return closing;
  }

  return { handleCommand, start, close };
}
