import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, conversationScope } from '../src/store.js';
import { handleFullCommand } from '../src/full-command.js';
import { createCommandHandler } from '../src/command-handler.js';
import { createPrefixInteraction, parsePrefixCommand, PrefixCommandError } from '../src/prefix-command.js';

const alice = '111111111111111111', bob = '222222222222222222';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-full-mode-'));
  let store = new ConversationStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, reopen() { store.close(); store = new ConversationStore(directory); } };
}

test('full mode defaults off, persists per user and preserves persona, language and conversation', t => {
  const f = fixture(t);
  const scope = conversationScope('g', 'c', alice);
  const persona = f.store.persona(alice);
  f.store.setLanguage(alice, 'hu');
  f.store.append(scope, 'Question', 'Answer');
  assert.equal(f.store.fullMode(alice), false);
  assert.equal(f.store.setFullMode(alice, true), true);
  f.reopen();
  assert.equal(f.store.fullMode(alice), true);
  assert.equal(f.store.fullMode(bob), false);
  assert.deepEqual(f.store.persona(alice), persona);
  assert.equal(f.store.language(alice), 'hu');
  assert.equal(f.store.history(scope).length, 2);
  f.store.reset(scope);
  f.store.resetPersona(alice);
  assert.equal(f.store.fullMode(alice), true);
  for (const value of ['on', 1, null, {}]) assert.throws(() => f.store.setFullMode(alice, value), /Invalid full mode/);
  assert.equal(f.store.fullMode(alice), true);
  assert.throws(() => f.store.setFullMode('invalid-user', true));
  assert.equal(f.store.setFullMode(alice, false), false);
  f.reopen();
  assert.equal(f.store.fullMode(alice), false);
});

test('dot full commands use the real command dispatcher, save only the sender and reply privately', async t => {
  const { store } = fixture(t);
  const errors = [];
  const handle = createCommandHandler({ allowed: () => true, isStopping: () => false, store,
    logError: (...args) => errors.push(args) });
  for (const [content, enabled] of [['.full', false], ['.full on', true], ['.full', true], ['.full off', false]]) {
    const privateReplies = [], publicReplies = [];
    const message = { author: { id: alice, send: async payload => privateReplies.push(payload) },
      guildId: 'g', channelId: 'c', attachments: new Map(), reply: async payload => publicReplies.push(payload) };
    const interaction = createPrefixInteraction(message, parsePrefixCommand(content));
    interaction.target = bob;
    await handle(interaction);
    assert.equal(store.fullMode(alice), enabled);
    assert.equal(store.fullMode(bob), false);
    assert.equal(publicReplies.length, 0);
    assert.equal(privateReplies.length, 1);
    assert.match(privateReplies[0].content, enabled ? /Full mode is on/ : /Full mode is off/);
  }
  assert.deepEqual(errors, []);
  for (const command of ['.full maybe', '.full on user:222222222222222222']) {
    assert.throws(() => parsePrefixCommand(command), PrefixCommandError);
  }
});

test('slash full commands are private and reject invalid mode without changing the saved setting', async t => {
  const { store } = fixture(t);
  const replies = [];
  const event = mode => ({ user: { id: alice }, options: { getString: () => mode }, reply: async payload => replies.push(payload) });
  await handleFullCommand(event('on'), store);
  await handleFullCommand(event('invalid'), store);
  assert.equal(store.fullMode(alice), true);
  await handleFullCommand(event(null), store);
  assert.match(replies.at(-1).content, /Full mode is on/);
  assert.ok(replies.every(reply => reply.flags === 64));
});
