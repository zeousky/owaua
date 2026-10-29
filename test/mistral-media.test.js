import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MistralMediaGenerator } from '../src/mistral-tools.js';
import { MediaService } from '../src/media-service.js';
import { MediaStore, mediaDay } from '../src/media-store.js';
import { MediaInputError } from '../src/media.js';
import { billingAwareFetch } from '../src/provider-error.js';

const user = '111111111111111111', guild = '333333333333333333';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const generated = (files = [{ file_id: 'generated_one', file_name: 'one.png', file_type: 'png', tool: 'image_generation' }]) => ({
  outputs: [{ type: 'tool.execution', name: 'image_generation', info: {} },
    { type: 'message.output', content: files.map(file => ({ type: 'tool_file', ...file })) }], usage: { total_tokens: 30 },
});
function fixture(t, fetchImpl, { confirm = async () => true } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'owaua-mistral-media-'));
  const store = new MediaStore(path);
  t.after(() => { store.close(); rmSync(path, { recursive: true, force: true }); });
  const media = new MistralMediaGenerator({ apiKey: 'fake-mistral-key', fetchImpl });
  return { store, media, service: new MediaService({ media, store, confirm }) };
}

test('Mistral image authorization and durable quota reservation happen before the generation POST', async t => {
  const calls = [];
  const { service, store } = fixture(t, async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer fake-mistral-key');
    assert.equal(store.count('user_id', user, 'image', mediaDay()), 1);
    assert.equal(store.jobs(user, guild)[0].state, 'submitting');
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.mistral.ai/v1/conversations');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'mistral-large-4'); assert.equal(body.store, false);
      assert.deepEqual(body.tools, [{ type: 'image_generation' }]);
      assert.equal(body.inputs, 'A lighthouse by the sea');
      return json(generated());
    }
    assert.equal(url, 'https://api.mistral.ai/v1/files/generated_one/url?expiry=24');
    return json({ url: 'https://files.example.com/image.png?signature=example' });
  }, { confirm: async () => assert.fail('A clear current image request needs no confirmation') });
  const result = await service.generate('image', 'A lighthouse by the sea', { userId: user, guildId: guild,
    currentRequest: 'make an image of a lighthouse by the sea' });
  assert.equal(calls.length, 2); assert.equal(result.provider, 'mistral'); assert.equal(result.kind, 'image');
  assert.equal(result.url, 'https://files.example.com/image.png?signature=example');
  const job = store.jobs(user, guild)[0];
  assert.equal(job.state, 'completed'); assert.equal(job.model, 'mistral-large-4');
  assert.equal(JSON.parse(job.result).provider, 'mistral'); assert.equal(service.active.size, 0);
});

test('Mistral images retain existing daily allowance and block excess work before another POST', async t => {
  let posts = 0;
  const { service, store } = fixture(t, async (_, options) => {
    if (options.method === 'POST') { posts++; return json(generated()); }
    return json({ url: 'https://files.example.com/image.png' });
  });
  const request = { userId: user, guildId: guild, currentRequest: 'make an image' };
  await service.generate('image', 'A tree', request);
  await service.generate('image', 'A flower', request);
  await assert.rejects(service.generate('image', 'A third image', request), /Daily user image limit/);
  assert.equal(posts, 2); assert.equal(store.count('user_id', user, 'image', mediaDay()), 2);
  assert.equal(service.active.size, 0);
});

test('declined Mistral image approval performs no POST and reserves no quota', async t => {
  let confirmations = 0;
  const { service, store } = fixture(t, async () => assert.fail('No network after declined approval'),
    { confirm: async () => { confirmations++; return false; } });
  await assert.rejects(service.generate('image', 'A tree', { userId: user, guildId: guild }), /not approved/);
  assert.equal(confirmations, 1); assert.deepEqual(store.usage().rows, []); assert.equal(service.active.size, 0);
});

test('unsupported Mistral media types, references and settings are rejected before authorization or POST', async () => {
  let approvals = 0, calls = 0;
  const media = new MistralMediaGenerator({ apiKey: 'fake-mistral-key', fetchImpl: async () => { calls++; assert.fail('No network for unsupported media'); } });
  const authorize = async () => { approvals++; return true; };
  for (const [kind, extra] of [['video', {}], ['edit_image', {}], ['image', { images: ['https://example.com/reference.png'] }],
    ['image', { videos: ['https://example.com/reference.mp4'] }], ['image', { options: { count: 2 } }],
    ['image', { options: { resolution: '1k' } }], ['image', { options: { quality: 'medium' } }]]) {
    await assert.rejects(media.generate(kind, 'A tree', { authorize, ...extra }), MediaInputError);
  }
  assert.equal(approvals, 0); assert.equal(calls, 0);
});

test('a Mistral billing rejection does not automatically repeat the image generation request', async () => {
  let posts = 0, completed = 0;
  const media = new MistralMediaGenerator({ apiKey: 'fake-mistral-key', fetchImpl: async () => {
    posts++; return json({ error: { code: 'insufficient_balance', message: 'Insufficient balance; private-provider-content' } }, 402);
  } });
  await assert.rejects(media.generate('image', 'A tree', { authorize: async () => true, onCompleted: () => { completed++; } }), error =>
    error.code === 'insufficient_balance' && error.provider === 'mistral' && !error.message.includes('private-provider-content'));
  assert.equal(posts, 1); assert.equal(completed, 0);
});

test('a definite Mistral generation POST billing rejection releases the unused reservation', async t => {
  let posts = 0;
  const { service, store } = fixture(t, async () => {
    posts++; return json({ error: { code: 'insufficient_balance' } }, 402);
  });
  await assert.rejects(service.generate('image', 'A tree', { userId: user, guildId: guild, currentRequest: 'make an image' }));
  assert.equal(posts, 1); assert.equal(service.active.size, 0);
  assert.equal(store.count('user_id', user, 'image', mediaDay()), 0);
  assert.deepEqual(store.jobs(user, guild), []);
});

test('the production billing-aware transport switches future requests and refunds a rejected image POST', async t => {
  let posts = 0, failures = 0;
  const router = { reportFailure(error, provider) {
    failures++; assert.equal(provider, 'mistral'); assert.equal(error.code, 'insufficient_balance');
  } };
  const transport = billingAwareFetch('mistral', router, async () => {
    posts++; return json({ error: { code: 'insufficient_balance' } }, 402);
  });
  const { service, store } = fixture(t, transport);
  await assert.rejects(service.generate('image', 'A tree', { userId: user, guildId: guild, currentRequest: 'make an image' }));
  assert.equal(posts, 1); assert.equal(failures, 1);
  assert.equal(store.count('user_id', user, 'image', mediaDay()), 0); assert.equal(service.active.size, 0);
});

test('failure fetching a generated image URL retains the completed generation charge without another POST', async t => {
  let posts = 0, gets = 0;
  const { service, store } = fixture(t, async (_, options) => {
    if (options.method === 'POST') { posts++; return json(generated()); }
    gets++; return json({ error: { code: 'insufficient_balance' } }, 402);
  });
  await assert.rejects(service.generate('image', 'A tree', { userId: user, guildId: guild, currentRequest: 'make an image' }));
  assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(store.count('user_id', user, 'image', mediaDay()), 1);
  assert.equal(store.jobs(user, guild)[0].state, 'unknown'); assert.equal(service.active.size, 0);
});

test('Mistral image files must be returned by image_generation and have safe IDs and URLs', async () => {
  for (const [body, signed, code, expectedCalls] of [
    [generated([{ file_id: 'other_tool', tool: 'code_interpreter' }]), {}, 'missing_generated_image', 1],
    [generated([{ file_id: '../escape', tool: 'image_generation' }]), {}, 'invalid_generated_file', 1],
    [generated(), { url: 'http://files.example.com/image.png' }, 'invalid_generated_url', 2],
    [generated(), { url: 'https://user:password@files.example.com/image.png' }, 'invalid_generated_url', 2],
  ]) {
    let calls = 0;
    const media = new MistralMediaGenerator({ apiKey: 'fake-mistral-key', fetchImpl: async () => ++calls === 1 ? json(body) : json(signed) });
    await assert.rejects(media.generate('image', 'A tree', { authorize: async () => true }), error => error.code === code);
    assert.equal(calls, expectedCalls);
  }
});
