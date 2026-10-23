import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceActive, maintenanceUntil, maintenanceNotice, replyDuringMaintenance, interactionDuringMaintenance } from '../src/maintenance.js';

const now = maintenanceUntil - 1000;
function message(overrides = {}) {
  const replies = [];
  return { guildId: 'guild', author: { id: 'human', bot: false }, content: 'hello',
    mentions: { users: new Set() }, replies, reply: async payload => replies.push(payload), ...overrides };
}
test('maintenance ends precisely at October 24 09:00 CEST', () => {
  assert.equal(new Date(maintenanceUntil).toISOString(), '2026-10-24T07:00:00.000Z');
  assert.equal(maintenanceActive(now), true);
  assert.equal(maintenanceActive(maintenanceUntil), false);
});
test('DMs, mentions, prefix commands and replies receive the exact notice', async () => {
  for (const data of [{ guildId: null }, { mentions: { users: new Set(['bot']) } },
    { content: '.ask hello' }, { content: '!play song' },
    { reference: { messageId: 'ref' }, fetchReference: async () => ({ author: { id: 'bot' } }) }]) {
    const msg = message(data);
    assert.equal(await replyDuringMaintenance(msg, 'bot', now), true);
    assert.equal(msg.replies.length, 1);
    assert.equal(msg.replies[0].content, maintenanceNotice);
    assert.equal(msg.replies[0].allowedMentions.repliedUser, false);
  }
});
test('unrelated messages, other replies and missing references do not get spammed', async () => {
  for (const data of [{}, { reference: { messageId: 'ref' }, fetchReference: async () => ({ author: { id: 'other' } }) },
    { reference: { messageId: 'ref' }, fetchReference: async () => { throw Error('deleted'); } }]) {
    const msg = message(data);
    assert.equal(await replyDuringMaintenance(msg, 'bot', now), true);
    assert.deepEqual(msg.replies, []);
  }
});
test('bots are ignored and normal handling resumes at the deadline', async () => {
  const bot = message({ author: { bot: true } });
  assert.equal(await replyDuringMaintenance(bot, 'bot', now), false);
  const dm = message({ guildId: null });
  assert.equal(await replyDuringMaintenance(dm, 'bot', maintenanceUntil), false);
  assert.deepEqual(dm.replies, []);
});
test('interactions receive a private shutdown response without executing commands', async () => {
  const replies = [];
  const interaction = { reply: async payload => replies.push(payload) };
  assert.equal(await interactionDuringMaintenance(interaction, now), true);
  assert.equal(replies[0].content, maintenanceNotice);
  assert.equal(replies[0].flags, 64);
  assert.equal(await interactionDuringMaintenance(interaction, maintenanceUntil), false);
  assert.equal(replies.length, 1);
});
