import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRouter, ProviderSwitchError } from '../src/providers.js';
import { handleProviderCommand } from '../src/provider-command.js';
import { parsePrefixCommand, createPrefixInteraction, PrefixCommandError } from '../src/prefix-command.js';
import { createCommandHandler } from '../src/command-handler.js';
import { FULL_MODE_OWNER } from '../src/full-mode.js';

const billing = (replaySafe = true) => Object.assign(new Error('Provider billing failed'), { code: 'insufficient_balance', replaySafe });
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-providers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const providers = Object.fromEntries(['xai', 'mistral'].map(name => [name, {
    apiKey: `${name}-test-key`, model: name === 'xai' ? 'grok-4.7' : 'mistral-large-4',
    respond: async request => { calls.push({ provider: name, request }); return { text: name }; },
    ...overrides[name],
  }]));
  return { directory, providers, calls, router: new ProviderRouter({ providers, directory }) };
}

test('provider choice persists privately across restarts and exposes no credentials', t => {
  const { router, directory, providers } = fixture(t);
  assert.equal(router.provider, 'xai');
  router.setProvider('mistral');
  assert.equal(router.model, 'mistral-large-4');
  assert.equal(new ProviderRouter({ providers, directory }).provider, 'mistral');
  const saved = readFileSync(join(directory, 'provider.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), { version: 2, defaultProvider: 'mistral', scopes: { default: { provider: 'mistral', revision: 1 } }, recovery: {} });
  assert.equal(statSync(join(directory, 'provider.json')).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(router.status()), /test-key/);
  assert.equal(router.setProvider('switch').provider, 'xai');
});

test('invalid and unconfigured choices leave the provider unchanged', t => {
  const { router } = fixture(t, { mistral: { apiKey: undefined } });
  assert.deepEqual(router.status().configured, ['xai']);
  assert.throws(() => router.setProvider('mistral'), /not configured/);
  assert.throws(() => router.setProvider('switch'), /not configured/);
  assert.throws(() => router.setProvider('other'), /Choose/);
  assert.equal(router.provider, 'xai');
});

test('a failed atomic save leaves the active provider unchanged', t => {
  const { router, directory } = fixture(t);
  mkdirSync(join(directory, 'provider.json'));
  assert.throws(() => router.setProvider('mistral'), ProviderSwitchError);
  assert.equal(router.provider, 'xai');
});

test('malformed saved settings fail cleanly and unavailable saved providers use a configured default', t => {
  const { providers, directory } = fixture(t);
  writeFileSync(join(directory, 'provider.json'), '{broken');
  assert.throws(() => new ProviderRouter({ providers, directory }), /could not be read/);
  writeFileSync(join(directory, 'provider.json'), JSON.stringify({ version: 1, provider: 'other' }));
  assert.throws(() => new ProviderRouter({ providers, directory }), /invalid/);
  writeFileSync(join(directory, 'provider.json'), JSON.stringify({ version: 1, provider: 'mistral' }));
  providers.mistral.apiKey = undefined;
  assert.equal(new ProviderRouter({ providers, directory }).provider, 'xai');
});

for (const initial of ['xai', 'mistral']) test(`confirmed ${initial} insufficient balance switches and safely retries once`, async t => {
  const error = billing(), notifications = [];
  const { router, calls, providers, directory } = fixture(t, { [initial]: { respond: async () => { throw error; } } });
  const alternate = initial === 'xai' ? 'mistral' : 'xai';
  router.setProvider(initial);
  router.onSwitch = event => notifications.push(event);
  const result = await router.respond({ input: 'Hello' });
  assert.equal(result.provider, alternate);
  assert.equal(router.provider, alternate);
  assert.equal(new ProviderRouter({ providers, directory }).provider, alternate);
  assert.deepEqual(calls.map(call => call.provider), [alternate]);
  assert.deepEqual(notifications, [{ from: initial, to: alternate, automatic: true, scope: 'default' }]);
});

test('both depleted providers stop after one retry and cannot bounce on the next failure', async t => {
  const calls = [];
  const { router } = fixture(t, Object.fromEntries(['xai', 'mistral'].map(name => [name, {
    respond: async () => { calls.push(name); throw billing(); },
  }])));
  await assert.rejects(router.respond({ input: 'Hello' }), { code: 'insufficient_balance' });
  assert.deepEqual(calls, ['xai', 'mistral']);
  assert.equal(router.provider, 'mistral');
  await assert.rejects(router.respond({ input: 'Again' }), { code: 'insufficient_balance' });
  assert.deepEqual(calls, ['xai', 'mistral', 'mistral']);
  assert.equal(router.provider, 'mistral');
  router.setProvider('xai');
  assert.equal(router.provider, 'xai', 'owner can explicitly try a topped-up provider again');
  assert.equal(router.depleted.has('xai'), true, 'a manual choice does not establish shared account recovery');
});

test('unsafe replay still switches future requests without repeating tool effects', async t => {
  const error = billing(false);
  const { router, calls } = fixture(t, { xai: { respond: async () => { throw error; } } });
  await assert.rejects(router.respond({ input: 'Generate something' }), error);
  assert.equal(router.provider, 'mistral');
  assert.deepEqual(calls, []);
});

test('xAI-only tool billing failures do not mark healthy Mistral chat as depleted', async t => {
  const error = Object.assign(billing(false), { provider: 'xai' });
  const { router, calls } = fixture(t, { mistral: { respond: async () => { throw error; } } });
  router.setProvider('mistral');
  await assert.rejects(router.respond({ input: 'Edit an image' }), error);
  assert.equal(router.provider, 'mistral');
  assert.equal(router.depleted.has('xai'), true);
  assert.equal(router.depleted.has('mistral'), false);
  assert.deepEqual(calls, []);
});

test('a dedicated provider failure during the retry does not exhaust the retry chat provider', async t => {
  const toolError = Object.assign(billing(false), { provider: 'xai' });
  const { router } = fixture(t, { xai: { respond: async () => { throw billing(); } },
    mistral: { respond: async () => { throw toolError; } } });
  await assert.rejects(router.respond({ input: 'Edit an image' }), toolError);
  assert.equal(router.provider, 'mistral');
  assert.equal(router.depleted.has('xai'), true);
  assert.equal(router.depleted.has('mistral'), false);
});

test('unclassified errors, rate limits and absent alternates do not switch providers', async t => {
  const { router, calls } = fixture(t);
  for (const error of [new Error('insufficient balance'), Object.assign(new Error('Rate limit'), { status: 429 }),
    Object.assign(new Error('Auth'), { status: 401 }), Object.assign(new Error('Payment'), { status: 402 })]) {
    router.providers.xai.respond = async () => { throw error; };
    await assert.rejects(router.respond({ input: 'Hello' }), error);
    assert.equal(router.provider, 'xai');
  }
  router.providers.mistral.apiKey = undefined;
  router.providers.xai.respond = async () => { throw billing(); };
  await assert.rejects(router.respond({ input: 'Hello' }), { code: 'insufficient_balance' });
  assert.equal(router.provider, 'xai');
  assert.deepEqual(calls, []);
});

test('abort prevents retry, while non-chat billing failures switch only their active provider', async t => {
  const controller = new AbortController();
  const { router, calls } = fixture(t, { xai: { respond: async () => { controller.abort(); throw billing(); } } });
  await assert.rejects(router.respond({ input: 'Hello', signal: controller.signal }), { code: 'insufficient_balance' });
  assert.deepEqual(calls, []);
  assert.equal(router.provider, 'mistral');
  router.reportFailure(billing(), 'xai');
  assert.equal(router.provider, 'mistral');
});

test('concurrent stale failures preserve a newer manual choice', async t => {
  let fail, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { router } = fixture(t, { xai: { respond: () => { started(); return new Promise((_, reject) => { fail = reject; }); } } });
  const pending = router.respond({ input: 'Hello' });
  await ready;
  router.setProvider('mistral');
  fail(billing());
  assert.equal((await pending).provider, 'mistral');
  assert.equal(router.provider, 'mistral');
});

test('fallback prepares input separately for each provider without losing the caller signal', async t => {
  const controller = new AbortController(), prepared = [];
  const { router, calls } = fixture(t, { xai: { respond: async request => {
    assert.equal(request.input, 'xai-input');
    assert.equal(request.signal, controller.signal);
    assert.equal(request.prepareForProvider, undefined);
    throw billing();
  } } });
  await router.respond({ input: 'base-input', context: { userId: FULL_MODE_OWNER }, signal: controller.signal,
    prepareForProvider: async provider => { prepared.push(provider); return { input: `${provider}-input` }; } });
  assert.deepEqual(prepared, ['xai', 'mistral']);
  assert.equal(calls[0].request.input, 'mistral-input');
  assert.equal(calls[0].request.context.userId, FULL_MODE_OWNER);
  assert.equal(calls[0].request.signal, controller.signal);
});

test('billing failures during provider input preparation are handled before the core is called', async t => {
  const { router, calls } = fixture(t);
  await router.respond({ input: 'base', prepareForProvider: async name => {
    if (name === 'xai') throw billing();
    return { input: 'mistral-prepared' };
  } });
  assert.deepEqual(calls.map(call => call.provider), ['mistral']);
  assert.equal(calls[0].request.input, 'mistral-prepared');
});

test('only the owner can view or change providers, and replies stay private', async t => {
  const { router } = fixture(t);
  const replies = [];
  const event = (userId, name) => ({ user: { id: userId }, options: { getString: () => name }, reply: async payload => replies.push(payload) });
  await handleProviderCommand(event('222222222222222222', 'mistral'), router);
  assert.match(replies.at(-1).content, /Only the bot owner/);
  assert.equal(router.provider, 'xai');
  await handleProviderCommand(event(FULL_MODE_OWNER, 'mistral'), router);
  assert.equal(router.withScope({ userId: FULL_MODE_OWNER }, () => router.provider), 'mistral');
  assert.match(replies.at(-1).content, /Mistral \(mistral-large-4\)/);
  await handleProviderCommand(event(FULL_MODE_OWNER, null), router);
  await handleProviderCommand(event(FULL_MODE_OWNER, 'invalid'), router);
  assert.equal(router.withScope({ userId: FULL_MODE_OWNER }, () => router.provider), 'mistral');
  assert.ok(replies.every(reply => reply.flags === 64));
});

test('dot provider command reaches the real dispatcher and sends results to DMs', async t => {
  const { router } = fixture(t);
  const replies = [], errors = [];
  const handle = createCommandHandler({ allowed: () => true, isStopping: () => false, store: {}, providerRouter: router,
    logError: (...args) => errors.push(args) });
  const message = { author: { id: FULL_MODE_OWNER, send: async payload => replies.push(payload) }, guildId: 'g',
    channelId: 'c', reply: () => assert.fail('Provider controls must remain private') };
  for (const content of ['.provider', '.provider mistral', '.provider switch', '.provider name:mistral']) {
    await handle(createPrefixInteraction(message, parsePrefixCommand(content)));
  }
  assert.equal(router.withScope({ guildId: 'g' }, () => router.provider), 'mistral');
  assert.equal(replies.length, 4);
  assert.deepEqual(errors, []);
  assert.throws(() => parsePrefixCommand('.provider unknown'), PrefixCommandError);
});

test('Mistral dot commands preserve JSON payloads and accept any direct attachment type', () => {
  const payload = '{"messages": [{"role": "user", "content": "Hello world"}], "nested": {"file": "private.wav"}}';
  const audio = { id: 'audio', name: 'private.wav', contentType: 'audio/wav' };
  const attachments = new Map([['audio', audio]]);
  for (const content of [`.mistral chat ${payload}`, `.mistral chat payload:${payload}`]) {
    const parsed = parsePrefixCommand(content, { attachments });
    assert.equal(parsed.values.get('operation'), 'chat');
    assert.deepEqual(JSON.parse(parsed.values.get('payload')), JSON.parse(payload));
    assert.equal(parsed.values.get('file'), audio);
  }
  assert.equal(parsePrefixCommand('.mistral operations').values.get('operation'), 'operations');
});

test('guild choices and balance fallback are isolated while DM choices belong to one user', async t => {
  const { router } = fixture(t, { xai: { respond: async () => { throw billing(); } } });
  await router.respond({ input: 'Hello', context: { guildId: 'server-a', userId: 'alice' } });
  assert.equal(router.withScope({ guildId: 'server-a', userId: 'bob' }, () => router.provider), 'mistral');
  assert.equal(router.withScope({ guildId: 'server-b', userId: 'alice' }, () => router.provider), 'xai');
  assert.equal(router.provider, 'xai');
  router.withScope({ userId: 'alice' }, () => router.setProvider('mistral'));
  assert.equal(router.withScope({ userId: 'alice' }, () => router.provider), 'mistral');
  assert.equal(router.withScope({ userId: 'bob' }, () => router.provider), 'xai');
});

test('legacy global preference migrates atomically as the default for all server scopes', t => {
  const { providers, directory } = fixture(t);
  writeFileSync(join(directory, 'provider.json'), JSON.stringify({ version: 1, provider: 'mistral' }));
  const router = new ProviderRouter({ providers, directory });
  assert.equal(router.withScope({ guildId: 'a' }, () => router.provider), 'mistral');
  assert.equal(router.withScope({ guildId: 'b' }, () => router.provider), 'mistral');
  const saved = JSON.parse(readFileSync(join(directory, 'provider.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.defaultProvider, 'mistral');
  assert.equal(statSync(join(directory, 'provider.json')).mode & 0o777, 0o600);
});

test('repeated failures share one persisted recovery watch and retain its backoff schedule', t => {
  const { router, providers, directory } = fixture(t);
  const starts = [];
  router.onDepleted = value => starts.push(value);
  router.withScope({ guildId: 'a' }, () => router.reportFailure(billing(), 'xai'));
  const generation = router.recoveryGeneration('xai');
  assert.equal(router.scheduleRecovery('xai', { attempts: 2, nextCheckAt: 123456 }, { expectedGeneration: generation }), true);
  router.withScope({ guildId: 'b' }, () => router.reportFailure(billing(), 'xai'));
  assert.deepEqual(starts, [{ provider: 'xai' }]);
  assert.ok(router.recoveryGeneration('xai') > generation);
  assert.equal(router.recoveryState('xai').nextCheckAt, 123456);
  assert.equal(router.recoveryState('xai').attempts, 2);
  assert.equal(router.scheduleRecovery('xai', { attempts: 0, nextCheckAt: 0 }, { expectedGeneration: generation }), false);
  const restored = new ProviderRouter({ providers, directory });
  assert.deepEqual(restored.recoveryState('xai'), router.recoveryState('xai'));
  assert.deepEqual(restored.recoveryProviders(), ['xai']);
  assert.equal(restored.withScope({ guildId: 'a' }, () => restored.provider), 'mistral');
  assert.equal(restored.withScope({ guildId: 'b' }, () => restored.provider), 'mistral');
});

test('confirmed recovery restores automatic choices and preserves manual overrides in every scope', t => {
  const { router } = fixture(t);
  for (const guildId of ['a', 'b']) router.withScope({ guildId }, () => router.reportFailure(billing(), 'xai'));
  router.withScope({ guildId: 'a' }, () => router.setProvider('mistral'));
  router.withScope({ guildId: 'c' }, () => router.setProvider('mistral'));
  const generation = router.recoveryGeneration('xai');
  assert.equal(router.recoverProvider('xai', { expectedGeneration: generation }), true);
  assert.equal(router.withScope({ guildId: 'a' }, () => router.provider), 'mistral');
  assert.equal(router.withScope({ guildId: 'b' }, () => router.provider), 'xai');
  assert.equal(router.withScope({ guildId: 'c' }, () => router.provider), 'mistral');
  assert.deepEqual(router.recoveryProviders(), []);
  assert.equal(router.recoverProvider('xai', { expectedGeneration: generation }), false);
});

test('an old probe cannot recover a newer failure, including after a watch was removed and recreated', t => {
  const { router } = fixture(t);
  router.reportFailure(billing(), 'xai');
  const first = router.recoveryGeneration('xai');
  router.reportFailure(billing(), 'xai');
  assert.equal(router.recoverProvider('xai', { expectedGeneration: first }), false);
  assert.equal(router.recoverProvider('xai', { expectedGeneration: router.recoveryGeneration('xai') }), true);
  router.reportFailure(billing(), 'xai');
  assert.ok(router.recoveryGeneration('xai') > first);
  assert.equal(router.recoverProvider('xai', { expectedGeneration: first }), false);
  assert.equal(router.provider, 'mistral');
});

test('stale responses cannot recover an outage observed after their request began', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { router } = fixture(t, { xai: { respond: () => { started(); return new Promise(resolve => { finish = resolve; }); } } });
  const response = router.respond({ input: 'Hello', context: { guildId: 'a' } });
  await ready;
  router.withScope({ guildId: 'a' }, () => router.reportFailure(billing(), 'xai'));
  finish({ text: 'An earlier response' });
  assert.equal((await response).text, 'An earlier response');
  assert.equal(router.depleted.has('xai'), true);
  assert.equal(router.withScope({ guildId: 'a' }, () => router.provider), 'mistral');
});

test('a concurrent manual choice is not overridden even when it selects the original provider again', async t => {
  let fail, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { router } = fixture(t, { xai: { respond: () => { started(); return new Promise((_, reject) => { fail = reject; }); } } });
  const response = router.respond({ input: 'Hello', context: { guildId: 'a' } });
  await ready;
  router.withScope({ guildId: 'a' }, () => { router.setProvider('mistral'); router.setProvider('xai'); });
  fail(billing());
  await assert.rejects(response, { code: 'insufficient_balance' });
  assert.equal(router.withScope({ guildId: 'a' }, () => router.provider), 'xai');
});

test('recovery persistence failure keeps the watch and delivers an already completed paid answer', async t => {
  const { router, directory } = fixture(t);
  router.withScope({ guildId: 'a' }, () => router.reportFailure(billing(), 'xai'));
  const persisted = readFileSync(router.filename, 'utf8');
  const recoveryErrors = [];
  router.onRecoveryError = value => recoveryErrors.push(value);
  const blockingDirectory = join(directory, 'blocked-provider.json');
  mkdirSync(blockingDirectory);
  router.filename = blockingDirectory;
  const result = await router.respond({ input: 'Hello', context: { guildId: 'b' } });
  assert.equal(result.text, 'xai');
  assert.equal(router.depleted.has('xai'), true);
  assert.equal(router.withScope({ guildId: 'a' }, () => router.provider), 'mistral');
  assert.equal(readFileSync(join(directory, 'provider.json'), 'utf8'), persisted);
  assert.equal(recoveryErrors.length, 1);
  assert.ok(recoveryErrors[0].error instanceof ProviderSwitchError);
});

test('scope-local mutation refreshes its own revision without refreshing a stale concurrent request', t => {
  const { router } = fixture(t);
  router.withScope({ guildId: 'a' }, () => {
    router.setProvider('mistral');
    router.reportFailure(billing(), 'mistral');
    assert.equal(router.provider, 'xai');
    router.recoverProvider('mistral');
    assert.equal(router.provider, 'mistral');
    router.reportFailure(billing(), 'mistral');
    assert.equal(router.provider, 'xai');
  });
});

test('nested respond shares its recovery revision with later dedicated work in the same answer', async t => {
  const { router } = fixture(t);
  const context = { guildId: 'a', userId: 'alice' };
  router.withScope(context, () => router.reportFailure(billing(), 'xai'));
  router.providers.mistral.respond = async () => {
    router.recoverProvider('xai', { expectedGeneration: router.recoveryGeneration('xai') });
    return { text: 'Completed answer' };
  };
  await router.withScope(context, async () => {
    assert.equal((await router.respond({ input: 'Hello', context })).text, 'Completed answer');
    assert.equal(router.provider, 'xai');
    router.reportFailure(billing(), 'xai');
    assert.equal(router.provider, 'mistral', 'fresh dedicated failure after recovery still switches this scope');
  });
});
