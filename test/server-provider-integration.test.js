import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRouter } from '../src/providers.js';
import { billingAwareFetch, ProviderError } from '../src/provider-error.js';
import { createCommandHandler } from '../src/command-handler.js';
import { MediaService } from '../src/media-service.js';
import { FULL_MODE_OWNER } from '../src/full-mode.js';

const guildA = '100000000000000001', guildB = '100000000000000002';
const actor = FULL_MODE_OWNER;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-server-provider-integration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const router = new ProviderRouter({ directory, providers: {
    xai: { apiKey: 'fixture-xai-key', model: 'grok-4.7', respond: async () => ({ text: 'Ready' }) },
    mistral: { apiKey: 'fixture-mistral-key', model: 'mistral-large-4', respond: async () => ({ text: 'Ready' }) },
  } });
  return { router, directory };
}
function interaction(commandName, guildId, values = {}) {
  const replies = [], edits = [];
  return { commandName, guildId, channelId: `channel-${guildId}`, user: { id: actor }, replies, edits,
    options: { getString: name => values[name] ?? null, getNumber: () => null, getBoolean: () => null, getAttachment: () => null },
    reply: async value => { replies.push(value); }, deferReply: async () => {}, editReply: async value => { edits.push(value); },
  };
}
function handler(router, overrides = {}) {
  const errors = [];
  const run = createCommandHandler({ allowed: () => true, isStopping: () => false,
    store: { fullMode: () => false }, providerRouter: router, standalone: async (_interaction, work) => work(),
    logError: (...args) => errors.push(args), ...overrides });
  return { run, errors };
}
const selection = (router, guildId, userId = actor) => router.withScope({ guildId, userId }, () => router.provider);

test('the real command dispatcher changes only the originating guild and preserves private status replies', async t => {
  const { router } = fixture(t), { run, errors } = handler(router);
  const change = interaction('provider', guildA, { name: 'mistral' });
  await run(change);
  assert.equal(selection(router, guildA), 'mistral');
  assert.equal(selection(router, guildB), 'xai');
  assert.equal(selection(router, null), 'xai');
  assert.equal(router.provider, 'xai');
  assert.equal(change.replies[0].flags, 64);
  assert.deepEqual(errors, []);
  const status = interaction('provider', guildB);
  await run(status);
  assert.equal(status.replies[0].flags, 64);
  assert.match(JSON.stringify(status.replies[0]), /grok-4\.7/);
});

test('late billing failure in a speech command retains its guild across concurrent command dispatch', async t => {
  const { router } = fixture(t), started = deferred(), release = deferred(), observed = [];
  const transport = billingAwareFetch('xai', router, async () => {
    observed.push(router.scopeKey()); started.resolve(); await release.promise;
    observed.push(router.scopeKey());
    return new Response('{}', { status: 402 });
  });
  const { run, errors } = handler(router, { voiceAPI: { speak: async () => {
    await transport('https://api.x.ai/v1/tts', { method: 'POST' });
    throw new Error('A failed transport must not return speech');
  } } });
  const speech = interaction('speak', guildA, { text: 'A sentence.' });
  const running = run(speech);
  await started.promise;
  await run(interaction('provider', guildB));
  assert.equal(selection(router, guildB), 'xai');
  release.resolve(); await running;
  assert.deepEqual(observed, [`guild:${guildA}`, `guild:${guildA}`]);
  assert.equal(selection(router, guildA), 'mistral');
  assert.equal(selection(router, guildB), 'xai');
  assert.equal(router.provider, 'xai');
  assert.deepEqual(router.recoveryProviders(), ['xai']);
  assert.equal(speech.edits.length, 1);
  assert.deepEqual(errors, []);
});

test('owner Mistral API billing errors switch only the guild that invoked the explicit API command', async t => {
  const { router } = fixture(t);
  router.withScope({ guildId: guildA, userId: actor }, () => router.setProvider('mistral'));
  router.withScope({ guildId: guildB, userId: actor }, () => router.setProvider('mistral'));
  let calls = 0;
  const { run, errors } = handler(router, { mistralAPI: { apiKey: 'fixture-mistral-key', request: async () => {
    calls++; await Promise.resolve();
    assert.equal(router.scopeKey(), `guild:${guildA}`);
    throw new ProviderError(402, 'insufficient_balance', 'mistral');
  } } });
  const command = interaction('mistral', guildA, { operation: 'models', payload: '{}' });
  await run(command);
  assert.equal(calls, 1);
  assert.equal(selection(router, guildA), 'xai');
  assert.equal(selection(router, guildB), 'mistral');
  assert.deepEqual(router.recoveryProviders(), ['mistral']);
  assert.equal(command.edits[0].flags, 64);
  assert.deepEqual(errors, []);
});

test('background video polling attributes billing failure to the saved job guild without changing the default', async t => {
  const { router } = fixture(t), seen = [];
  const transport = billingAwareFetch('xai', router, async () => {
    await Promise.resolve(); seen.push(router.scopeKey());
    return new Response('{}', { status: 402 });
  });
  const jobs = [{ id: 'job-a', guild_id: guildA, user_id: actor, request_id: 'request-a', model: 'video' }];
  const service = new MediaService({
    media: { checkVideo: async () => transport('https://api.x.ai/v1/videos/request-a') },
    store: { pending: () => jobs, complete: () => assert.fail('Rejected polling must not complete a job'), fail: () => assert.fail('Credit failures keep jobs recoverable') },
    withScope: (context, work) => router.withScope(context, work),
  });
  await service.resume();
  assert.deepEqual(seen, [`guild:${guildA}`]);
  assert.equal(selection(router, guildA), 'mistral');
  assert.equal(selection(router, guildB), 'xai');
  assert.equal(router.provider, 'xai');
  assert.equal(service.active.size, 0);
});
