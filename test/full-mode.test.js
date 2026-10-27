import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, conversationScope } from '../src/store.js';
import { handleFullCommand } from '../src/full-command.js';
import { createCommandHandler } from '../src/command-handler.js';
import { createPrefixInteraction, parsePrefixCommand, PrefixCommandError } from '../src/prefix-command.js';
import { FULL_MODE_OWNER, fullModeActive, withFullMode } from '../src/full-mode.js';
import { UsageStore, RequestLimiter, DEFAULT_USAGE_LIMITS } from '../src/usage.js';
import { AICore } from '../src/ai.js';

const alice = '1172433512364769342', bob = '222222222222222222';
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

test('non-owners cannot trigger full mode through commands or stale saved settings', async t => {
  const { store } = fixture(t);
  const replies = [];
  store.db.prepare('INSERT INTO reply_settings(user_id,full_mode) VALUES(?,1)').run(bob);
  assert.equal(store.fullMode(bob), false);
  assert.throws(() => store.setFullMode(bob, true), /Only the bot owner/);
  const handle = createCommandHandler({ allowed: () => true, isStopping: () => false, store,
    logError: () => assert.fail('Unexpected command failure') });
  for (const mode of ['on', 'off', null]) {
    await handle({ commandName: 'full', user: { id: bob }, options: { getString: () => mode },
      reply: async payload => replies.push(payload) });
  }
  assert.equal(replies.length, 3);
  assert.ok(replies.every(reply => reply.flags === 64 && /Only the bot owner/.test(reply.content)));
  assert.equal(store.fullMode(bob), false);
});

test('full mode is an actor-bound asynchronous capability isolated from other users', async () => {
  await Promise.all([withFullMode(FULL_MODE_OWNER, true, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fullModeActive(), true);
    assert.equal(fullModeActive(bob), false);
    await withFullMode(bob, true, async () => assert.equal(fullModeActive(), false));
    assert.equal(fullModeActive(), true);
  }), withFullMode(bob, true, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fullModeActive(), false);
  })]);
  assert.equal(fullModeActive(), false);
  withFullMode(FULL_MODE_OWNER, false, () => assert.equal(fullModeActive(), false));
});

test('owner full mode bypasses every request/voice quota, burst, cooldown and shared capacity without consuming others allowances', t => {
  const { store: conversation } = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'owaua-full-quota-'));
  const limits = structuredClone(DEFAULT_USAGE_LIMITS);
  for (const scopes of Object.values(limits)) for (const scope of Object.keys(scopes)) scopes[scope] = 1;
  const usage = new UsageStore(directory, { limits });
  t.after(() => { usage.close(); rmSync(directory, { recursive: true, force: true }); });
  const active = new Set(['other-request']);
  const limiter = new RequestLimiter({ store: usage, active, concurrency: 1, cooldownMs: 60000 });
  conversation.setFullMode(alice, true);
  const run = work => withFullMode(alice, conversation.fullMode(alice), work);
  const ownerRequest = { scope: 'one', userId: alice, guildId: bob, voice: true };
  usage.reserve({ userId: alice, guildId: bob, voice: true });
  assert.throws(() => limiter.acquire(ownerRequest), /few requests/);
  const first = run(() => limiter.acquire(ownerRequest));
  const second = run(() => limiter.acquire({ ...ownerRequest, scope: 'two' }));
  assert.throws(() => run(() => limiter.acquire(ownerRequest)), /current request/);
  first(); first();
  assert.equal(limiter.users.get(alice), 1);
  second();
  run(() => limiter.acquire(ownerRequest))();
  assert.equal(usage.snapshot({ userId: alice }).scopes.user.requests, 4);
  assert.equal(usage.snapshot().scopes.bot.requests, 1, 'exempt attempts do not consume shared quotas');
  assert.equal(usage.db.prepare('SELECT count(*) AS n FROM usage_admissions WHERE exempt=1').get().n, 3);
  withFullMode(bob, true, () => assert.throws(() => usage.reserve({ userId: bob, guildId: bob }), /limit/));
  conversation.setFullMode(alice, false);
  active.clear();
  assert.throws(() => run(() => limiter.acquire(ownerRequest)), /wait|limit/i);
  assert.equal(limiter.users.size, 0);
});

test('full mode removes AI token, context, local tool and round budgets; cancellation still stops it', async () => {
  const requests = [];
  const controller = new AbortController();
  const text = 'A complete explanation. '.repeat(80).trim();
  const ai = new AICore({ maxOutputTokens: 1, maxToolCalls: 1, maxToolRounds: 1, timeoutMs: 1, maxContextCharacters: 20,
    fetchImpl: async (_url, { body, signal }) => {
      const request = JSON.parse(body); requests.push(request);
      assert.equal(signal, controller.signal, 'only the caller cancellation signal applies');
      await new Promise(resolve => setTimeout(resolve, 5));
      if (requests.length <= 4) return { ok: true, json: async () => ({ output: [{ type: 'function_call',
        name: 'current_time', arguments: '{}', call_id: `time-${requests.length}` }] }) };
      return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) };
    } });
  const history = [{ role: 'user', content: 'Old context '.repeat(20) }, { role: 'assistant', content: 'Previous answer '.repeat(20) }];
  const result = await ai.respond({ input: 'Explain', history, fullMode: true, context: { userId: alice }, signal: controller.signal });
  assert.equal(requests.length, 5);
  assert.equal(result.text, text);
  assert.ok(requests.every(request => !Object.hasOwn(request, 'max_output_tokens') && !Object.hasOwn(request, 'max_turns')));
  assert.ok(JSON.stringify(requests[0].input).includes(history[0].content));
  controller.abort(new DOMException('Restart', 'AbortError'));
  await assert.rejects(ai.respond({ input: 'Explain', fullMode: true, context: { userId: alice }, signal: controller.signal }), /Restart/);
  assert.equal(requests.length, 5);
});

test('a non-owner cannot gain full mode through AI options or tool context', async () => {
  const ai = new AICore({ maxOutputTokens: 12, fetchImpl: async (_url, { body }) => {
    const request = JSON.parse(body);
    assert.equal(request.max_output_tokens, 12);
    assert.equal(request.max_turns, 8);
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Word '.repeat(200) }] }] }) };
  } });
  const result = await ai.respond({ input: 'Explain', fullMode: true, context: { userId: bob, fullMode: true } });
  assert.equal(result.fullMode, false);
  assert.ok(result.text.length <= 600);
});
