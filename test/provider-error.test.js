import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFailure, providerError, billingAwareFetch } from '../src/provider-error.js';
import { ProviderRouter } from '../src/providers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('billing errors recognize provider codes and exhausted balances without mistaking schema or rate failures', () => {
  for (const message of ['Insufficient balance.', 'Your account has run out of credits.', 'No credits remaining.',
    'Your team doesn’t have any credits yet.', 'Your account balance is 0.']) {
    assert.equal(providerFailure(403, { error: { message } }).code, 'insufficient_balance', message);
  }
  for (const message of ["Invalid schema at property 'add credits': unknown type.", 'Too many requests.',
    'Your per-minute token quota is exhausted.', 'You may buy more credits on your billing page.']) {
    assert.equal(providerFailure(429, { error: { message } }).code, 'provider_error', message);
  }
  assert.equal(providerFailure(502, { code: 'insufficient_balance' }).code, 'insufficient_balance');
  assert.equal(providerFailure(402, {}).code, 'insufficient_balance');
});

test('large provider bodies are bounded and never appear in errors', async () => {
  const error = await providerError(new Response(JSON.stringify({ message: 'private-data'.repeat(5000) }), { status: 403 }), { provider: 'mistral' });
  assert.equal(error.provider, 'mistral');
  assert.equal(error.message.includes('private-data'), false);
});

test('billing-aware fetch only inspects official provider hosts and reports safe HTTP rejections', async () => {
  const failures = [];
  const router = { reportFailure: (...args) => failures.push(args) };
  const fetchImpl = billingAwareFetch('xai', router, async () => new Response('{}', { status: 402 }));
  await assert.rejects(fetchImpl('https://management-api.x.ai/v1/collections'), error => error.replaySafe && error.code === 'insufficient_balance');
  assert.equal(failures[0][1], 'xai');
  const response = await fetchImpl('https://cdn.discordapp.com/attachments/audio.mp3');
  assert.equal(response.status, 402); assert.equal(failures.length, 1);
});

test('dedicated HTTP calls use their own revision snapshot after a prior scope change', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-http-scope-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const router = new ProviderRouter({ directory, providers: {
    xai: { apiKey: 'fixture-xai', model: 'grok-4.7' }, mistral: { apiKey: 'fixture-mistral', model: 'mistral-large-4' },
  } });
  const context = { guildId: 'server-a', userId: 'requester' };
  const request = billingAwareFetch('xai', router, async () => new Response('{}', { status: 402 }));
  await router.withScope(context, async () => {
    // An outer request may remain active while another operation changes the
    // same server. A NEW HTTP call still needs a fresh revision snapshot.
    router.withScope(context, () => router.setProvider('xai'));
    await assert.rejects(request('https://api.x.ai/v1/tts'), error => error.code === 'insufficient_balance');
    assert.equal(router.provider, 'mistral');
  });
  assert.equal(router.provider, 'xai');
});

test('a dedicated HTTP failure cannot undo a manual choice made while that call awaited', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-http-stale-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const router = new ProviderRouter({ directory, providers: {
    xai: { apiKey: 'fixture-xai', model: 'grok-4.7' }, mistral: { apiKey: 'fixture-mistral', model: 'mistral-large-4' },
  } });
  const context = { guildId: 'server-a', userId: 'requester' }, started = Promise.withResolvers(), gate = Promise.withResolvers();
  const request = billingAwareFetch('xai', router, async () => { started.resolve(); await gate.promise; return new Response('{}', { status: 402 }); });
  const pending = router.withScope(context, () => assert.rejects(request('https://api.x.ai/v1/tts'), error => error.code === 'insufficient_balance'));
  await started.promise;
  router.withScope(context, () => router.setProvider('xai'));
  gate.resolve(); await pending;
  assert.equal(router.withScope(context, () => router.provider), 'xai');
  assert.deepEqual(router.recoveryProviders(), ['xai']);
});
