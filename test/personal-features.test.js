import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection } from 'discord.js';
import { createPersonalFeatures, reminderTime, followingOccurrence } from '../src/personal-features.js';

const guildId = '100000000000000001';
const channelId = '100000000000000002';
const messageId = '100000000000000003';
const owner = '100000000000000004';
const other = '100000000000000005';

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-personal-'));
  const sent = [], edited = [], errors = [];
  let canPost = true;
  const member = { id: owner };
  const channel = {
    guildId,
    type: ChannelType.GuildText,
    isSendable: () => true,
    isThread: () => false,
    guild: { members: { fetch: async () => member, fetchMe: async () => ({ id: 'bot' }) } },
    permissionsFor: who => ({ has: () => who !== member || canPost }),
    send: async payload => {
      sent.push(payload);
      return { id: messageId, url: `https://discord.com/channels/${guildId}/${channelId}/${messageId}` };
    },
    messages: { edit: async (id, payload) => edited.push({ id, ...payload }) },
  };
  const client = {
    channels: { fetch: async id => id === channelId ? channel : null },
    users: { fetch: async id => ({ createDM: async () => ({ send: async payload => sent.push({ id, ...payload }) }) }) },
    isReady: () => true,
  };
  let now = Date.UTC(2026, 10, 14, 10);
  const open = () => createPersonalFeatures({ directory, client, allowed: () => true, clock: () => now,
    logError: (event, error) => errors.push([event, error]) });
  let feature = open();
  t.after(async () => {
    await feature.close();
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  function interaction(commandName, values = {}, userId = owner) {
    const result = {
      commandName, guildId, channelId, channel, user: { id: userId }, id: '100000000000000006',
      inGuild: () => true,
      appPermissions: { has: () => true }, memberPermissions: { has: () => userId === owner },
      options: {
        getSubcommand: () => values.action,
        getString: key => values[key] ?? null,
        getInteger: key => values[key] ?? null,
        getBoolean: key => values[key] ?? null,
        getChannel: () => ({ id: channelId }),
      },
      async deferReply() { result.deferred = true; },
      async reply(payload) { result.response = payload; },
      async editReply(payload) { result.response = payload; },
    };
    return result;
  }
  return { sent, edited, interaction, get feature() { return feature; },
    elapse(ms) { now += ms; }, revokeChannelPermission() { canPost = false; },
    async restart() { await feature.close(); feature = open(); },
    async command(name, values, id) {
      const request = interaction(name, values, id);
      await feature.handleCommand(request);
      return request.response.content;
    },
  };
}

test('reminder times honor explicit offsets, reject rolled dates and catch up at the next interval', () => {
  const now = Date.UTC(2026, 10, 30);
  assert.equal(reminderTime('1d2h', now), now + 26 * 3600000);
  assert.equal(reminderTime('2026-12-01T19:00+01:00', now), Date.UTC(2026, 11, 1, 18));
  assert.throws(() => reminderTime('2027-02-30T16:00Z', now));
  assert.throws(() => reminderTime('2026-12-01T19:00', now));
  assert.throws(() => reminderTime('29s', now));
  assert.equal(followingOccurrence(100, 30, 160), 190);
});

test('personal reminders survive restarts and skip missed recurring deliveries', async t => {
  const h = harness(t);
  assert.match(await h.command('remind', { when: '30s', repeat: '1h', message: 'Read a chapter' }), /#1 is set/);
  assert.equal(await h.command('reminders', { action: 'remove', id: 1 }, other), 'No matching entry in your list.');
  await h.restart();
  h.elapse(5 * 3600000);
  await h.feature.tick();
  await h.feature.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].id, owner);
  assert.equal(h.sent[0].content, '**Reminder**\nRead a chapter');
  assert.equal(h.sent[0].enforceNonce, true);
  assert.deepEqual(h.sent[0].allowedMentions.parse, []);
  assert.match(await h.command('reminders', { action: 'list' }), /repeats/);
});

test('server schedules stop when the author loses permission at delivery time', async t => {
  const h = harness(t);
  assert.match(await h.command('reminders', { action: 'schedule', when: '1m', message: 'Meeting' }), /Scheduled message #1/);
  h.revokeChannelPermission();
  h.elapse(60000);
  await h.feature.tick();
  assert.equal(h.sent.length, 0);
  assert.match(await h.command('reminders', { action: 'scheduled' }), /delivery failed/);
});

test('button polls bind votes to their posted message and keep one vote per member after restart', async t => {
  const h = harness(t);
  await h.command('poll', { format: 'buttons', question: 'Pick a color', options: 'Red | Blue' });
  assert.equal(h.sent[0].components.length, 1);
  const button = (choice, message = messageId) => Object.assign(h.interaction('poll', {}, other), {
    isButton: () => true, customId: `owaua:poll:100000000000000006:${choice}`, message: { id: message },
  });
  const forged = button(1, channelId);
  await h.feature.handleComponent(forged);
  assert.match(forged.response.content, /unavailable/);
  await h.feature.handleComponent(button(1));
  await h.restart();
  await h.feature.handleComponent(button(2));
  assert.match(await h.command('vote', { action: 'results', poll: messageId }), /Red — 0\n\*\*2\.\*\* Blue — 1/);
  assert.match(await h.command('vote', { action: 'close', poll: messageId }, other), /Only the poll creator/);
  await h.command('vote', { action: 'close', poll: messageId });
  assert.equal(h.edited.length, 1);
  assert.deepEqual(h.edited[0].components, []);
  assert.match(await h.command('vote', { action: 'cast', poll: messageId, choice: 1 }), /poll has ended/);
});

test('native polls use Discord voting with the specified duration and options', async t => {
  const h = harness(t);
  await h.command('poll', { question: 'Lunch?', options: 'Soup | Sandwich', hours: 2, multiple: true });
  assert.deepEqual(h.sent[0].poll, {
    question: { text: 'Lunch?' }, answers: [{ text: 'Soup' }, { text: 'Sandwich' }], duration: 2, allowMultiselect: true,
  });
});

test('AFK clears on the member’s next message in the same server', async t => {
  const h = harness(t);
  await h.command('afk', { action: 'set', reason: 'Making tea' });
  const replies = [];
  const message = (author, mentions = []) => ({
    guildId, channelId, author: { id: author }, mentions: { users: new Collection(mentions.map(id => [id, { id }])) },
    reply: async payload => replies.push(payload),
  });
  await h.feature.onMessage(message(other, [owner]));
  assert.match(replies[0].content, /is AFK .* Making tea/);
  assert.deepEqual(replies[0].allowedMentions.parse, []);
  h.elapse(30000);
  await h.feature.onMessage(message(owner));
  await h.feature.onMessage(message(other, [owner]));
  assert.equal(replies.length, 1);
});
