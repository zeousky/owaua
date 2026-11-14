import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { createSubscriptionFeatures } from '../src/subscription-features.js';
import { fetchPublic, publicAddress, publicURL, PublicURLError } from '../src/subscription-http.js';
import { feedItems, githubItems, githubRepository } from '../src/subscription-sources.js';

test('subscription sources constrain outbound HTTP methods, public URLs and redirects', async () => {
  assert.equal(publicAddress('2606:4700::1111'), true);
  assert.equal(publicAddress('fd00::1'), false);
  assert.equal(publicAddress('::ffff:127.0.0.1'), false);
  assert.equal(publicAddress('169.254.169.254'), false);
  assert.equal(publicAddress('100.64.0.100'), false);
  assert.throws(() => publicURL('file:///feed.xml'), PublicURLError);
  assert.throws(() => publicURL('https://user:pass@news.example.org/feed'), PublicURLError);
  assert.throws(() => publicURL('https://news.example.org/feed?key=fixture'), PublicURLError);
  assert.throws(() => publicURL('http://127.1/'), PublicURLError);
  assert.throws(() => publicURL('http://news.example.org:8888/'), PublicURLError);
  assert.throws(() => publicURL('http://cache.internal/'), PublicURLError);

  const requests = [];
  const transport = {
    resolve: async host => host === 'internal.example.org'
      ? [{ address: '192.168.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
    request: async (url, address) => {
      requests.push([url.hostname, address.address]);
      return { status: 302, headers: { location: 'https://internal.example.org/feed' } };
    },
  };
  await assert.rejects(fetchPublic('https://public.example.org/', transport), PublicURLError);
  assert.deepEqual(requests, [['public.example.org', '93.184.216.34']]);
});

test('feed parsers accept RSS and Atom and ignore unsafe links and DTDs', () => {
  const rss = feedItems('<rss version="2.0"><channel><item><title>New &amp; improved</title><guid>1</guid><link>/news</link></item></channel></rss>', 'https://site.example.org/feed');
  assert.equal(rss[0].title, 'New & improved');
  assert.equal(rss[0].url, 'https://site.example.org/news');
  const atom = feedItems('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Update</title><id>tag:site.example.org,2026:1</id><link rel="self" href="/atom"/><link rel="alternate" href="javascript:alert(1)"/></entry></feed>', 'https://site.example.org/atom');
  assert.equal(atom[0].title, 'Update');
  assert.equal(atom[0].url, undefined);
  assert.throws(() => feedItems('<!DOCTYPE rss><rss/>', 'https://site.example.org/feed'), /declarations/);
  assert.throws(() => feedItems('<html><body>Example</body></html>', 'https://site.example.org/'), /RSS or Atom/);
});

test('GitHub normalization and events support pushes, releases, issues and pull requests', () => {
  const before = '1'.repeat(40);
  const head = '2'.repeat(40);
  const entry = (id, type, payload) => ({ id, type, public: true, repo: { name: 'org/project' }, payload });
  const body = JSON.stringify([
    entry('1', 'PushEvent', { ref: 'refs/heads/main', head, before }),
    entry('2', 'ReleaseEvent', { action: 'published', release: { name: 'First release' } }),
    entry('3', 'IssuesEvent', { action: 'opened', issue: { number: 5, title: 'Check a bug' } }),
    entry('4', 'PullRequestEvent', { action: 'closed', number: 6, pull_request: { title: 'Fix it', merged: true } }),
  ]);
  assert.equal(githubRepository('https://github.com/org/project.git'), 'org/project');
  assert.throws(() => githubRepository('org/..'));
  const items = githubItems(body, 'org/project', 'all');
  assert.equal(items.length, 4);
  assert.equal(items[0].url, `https://github.com/org/project/compare/${before}...${head}`);
  assert.match(items[3].title, /merged/);
  assert.deepEqual(githubItems(body, 'org/project', 'issues'), [items[2]]);
});

test('subscriptions retain seen items across restart, deny hidden destinations and report uptime transitions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-subscriptions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const guildId = '100000000000000001';
  const channelId = '100000000000000002';
  const actor = '100000000000000003';
  const owner = '100000000000000004';
  const bot = '100000000000000005';
  const notifications = new EventTarget();
  const messages = [];
  let now = 1_800_000_000_000;
  let canView = false;
  let siteStatus = 200;
  let feedTitle = 'One';
  let checks = 0;
  const channel = { id: channelId, guildId, type: ChannelType.GuildText,
    permissionsFor(member) {
      return { has: () => member === bot || member === owner || (member === actor && canView) };
    },
    async send(message) {
      messages.push(message);
      notifications.dispatchEvent(new Event('message'));
    },
  };
  const guild = { available: true, ownerId: owner, members: { me: bot },
    channels: { cache: new Map([[channelId, channel]]) } };
  const client = Object.assign(new EventEmitter(), {
    isReady: () => true, guilds: { cache: new Map([[guildId, guild]]) },
    channels: { fetch: async () => channel },
  });
  const config = { directory, client, allowed: id => id === guildId, logError: assert.fail, tickMs: 10, clock: () => now,
    fetch: async url => {
      checks++;
      return { url, status: url.endsWith('feed') ? 200 : siteStatus, headers: {},
        body: `<rss><channel><item><guid>${feedTitle}</guid><title>${feedTitle}</title></item></channel></rss>` };
    },
  };
  let feature = createSubscriptionFeatures(config);
  t.after(() => feature.close());

  async function command(commandName, action, { text, id, user = actor } = {}) {
    return feature.handleCommand({
      commandName, guildId, guild, channel, user: { id: user },
      memberPermissions: { has: key => key === PermissionFlagsBits.ManageGuild },
      options: { getSubcommand: () => action, getChannel: () => channel, getString: () => text,
        getInteger: key => key === 'id' ? id : null },
      reply: payload => payload.content,
    });
  }
  async function waitForChecks(count) {
    for (let attempt = 0; attempt < 100 && checks < count; attempt++) await sleep(5);
    assert.ok(checks >= count);
  }
  const minute = 60_000;
  assert.match(await command('feed', 'add', { text: 'https://site.example.org/feed' }), /you and Owaua/);
  canView = true;
  assert.match(await command('feed', 'add', { text: 'https://site.example.org/feed' }), /Added subscription #1/);
  assert.match(await command('monitor', 'add', { text: 'https://site.example.org/health' }), /Added subscription #2/);
  canView = false;
  assert.match(await command('feed', 'list'), /no subscriptions/);
  assert.match(await command('feed', 'list', { user: owner }), /site\.example\.org\/feed/);
  assert.match(await command('feed', 'remove', { id: 1 }), /No matching/);
  feature.start();
  await waitForChecks(2);
  assert.equal(messages.length, 0);
  await feature.close();
  feature = createSubscriptionFeatures(config);
  feature.start();

  siteStatus = 503;
  now += 5 * minute;
  await waitForChecks(4);
  assert.equal(messages.length, 0);
  feedTitle = 'Two';
  now += 5 * minute;
  await once(notifications, 'message', { signal: AbortSignal.timeout(1000) });
  await waitForChecks(6);
  await sleep(30);
  assert.equal(messages.length, 2);
  assert.ok(messages.some(message => /Two/.test(message.content)));
  assert.ok(messages.some(message => /Website down.*\/health/.test(message.content)));
  assert.ok(messages.every(message => message.allowedMentions.parse.length === 0 && message.enforceNonce));

  siteStatus = 204;
  now += 5 * minute;
  await once(notifications, 'message', { signal: AbortSignal.timeout(1000) });
  assert.match(messages.at(-1).content, /Website recovered/);
  assert.equal(messages.length, 3);
  assert.match(await command('feed', 'remove', { id: 1, user: owner }), /Removed subscription/);
  client.emit(Events.ChannelDelete, channel);
  assert.match(await command('monitor', 'list', { user: owner }), /no subscriptions/);
  await feature.close();
});
