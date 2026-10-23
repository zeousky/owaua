import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaStore, MEDIA_OWNER, mediaDay } from '../src/media-store.js';
import { MediaService } from '../src/media-service.js';
import { MediaGenerator } from '../src/media.js';
import { handleMediaCommand } from '../src/media-command.js';
import { AICore } from '../src/ai.js';

const user = '111111111111111111', other = '222222222222222222', guild = '333333333333333333';
const reply = body => ({ ok: true, json: async () => body });
function fixture(t, options) {
  const directory = mkdtempSync(join(tmpdir(), 'kirmy-budget-'));
  const store = new MediaStore(directory, options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}
const reserve = (store, userId = user, kind = 'image', units = 1, guildId = guild) => store.reserve({ userId, guildId, kind, units });

test('separate DB connections enforce user/server limits, image batch size, and owner exemptions', t => {
  const { directory, store } = fixture(t);
  const second = new MediaStore(directory); t.after(() => second.close());
  reserve(store, user, 'image', 2);
  assert.throws(() => reserve(second, user), /user image limit/);
  reserve(second, other, 'image', 2);
  reserve(store, '444444444444444444');
  assert.throws(() => reserve(second, '555555555555555555'), /server image limit/);
  for (let n = 0; n < 3; n++) reserve(store, String(600000000000000000n + BigInt(n)), 'video');
  assert.throws(() => reserve(second, '555555555555555555', 'video'), /server video limit/);
  reserve(store, MEDIA_OWNER, 'image', 10); reserve(store, MEDIA_OWNER, 'video');
  assert.equal(store.count('guild_id', guild, 'image', mediaDay()), 5);
  assert.equal(store.count('guild_id', guild, 'video', mediaDay()), 3);
});

test('user allowance applies across servers and DMs; midnight Budapest resets with DST', t => {
  let now = Date.parse('2026-10-22T21:59:59Z');
  const { store } = fixture(t, { now: () => now });
  reserve(store, user, 'video');
  assert.throws(() => reserve(store, user, 'video', 1, undefined), /user video limit/);
  assert.throws(() => reserve(store, user, 'video', 1, '444444444444444444'), /user video limit/);
  now += 1000;
  assert.equal(mediaDay(now), '2026-10-23');
  reserve(store, user, 'video');
  assert.equal(mediaDay(Date.parse('2026-12-01T23:00:00Z')), '2026-12-02');
});

test('cancellation of every action submits nothing and reserves nothing', async t => {
  const { store } = fixture(t);
  const service = new MediaService({ store, confirm: async () => false,
    media: new MediaGenerator({ fetchImpl: async () => assert.fail('No provider calls') }) });
  for (const kind of ['image','video','edit_image','edit_video','extend_video']) {
    await assert.rejects(service.generate(kind, 'A cat', { userId: user, guildId: guild,
      images: kind === 'edit_image' ? ['https://example.com/cat.png'] : [],
      videos: kind.includes('_video') ? ['https://example.com/cat.mp4'] : [],
    }), /cancelled or not confirmed/);
  }
  assert.deepEqual(store.usage().rows, []);
});

test('simultaneously approved requests cannot bypass allowance and reserve before POST', async t => {
  const { store } = fixture(t);
  let posts = 0;
  const service = new MediaService({ store, confirm: async () => true,
    media: new MediaGenerator({ fetchImpl: async (_, request) => {
      posts++;
      assert.equal(store.count('user_id', user, 'image', mediaDay()), 2);
      assert.equal(JSON.parse(request.body).n, 2);
      return reply({ data: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.png' }] });
    } }) });
  const results = await Promise.allSettled([1,2].map(() => service.generate('image', 'A cat', {
    userId: user, guildId: guild, options: { count: 2 },
  })));
  assert.equal(posts, 1);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled','rejected']);
  assert.equal(store.jobs(user, guild)[0].state, 'completed');
});

test('video ID is durable before first poll; restart resumes via GET only and retains failed/uncertain charges', async t => {
  const { directory, store } = fixture(t);
  const controller = new AbortController();
  const service = new MediaService({ store, confirm: async () => true,
    media: new MediaGenerator({ fetchImpl: async (_, { method }) => {
      if (method === 'POST') return reply({ request_id: 'durable-job' });
      const reader = new MediaStore(directory);
      try { assert.equal(reader.pending()[0].request_id, 'durable-job'); } finally { reader.close(); }
      controller.abort(); throw controller.signal.reason;
    } }) });
  await assert.rejects(service.generate('video', 'A cat', { userId: user, guildId: guild, signal: controller.signal }), /Check \/jobs/);
  const restarted = new MediaStore(directory); t.after(() => restarted.close()); restarted.recover();
  const recovery = new MediaService({ store: restarted, media: new MediaGenerator({ fetchImpl: async (url, { method }) => {
    assert.equal(method, 'GET'); assert.match(url, /videos\/durable-job$/);
    return reply({ status: 'done', video: { url: 'https://example.com/result.mp4' } });
  } }) });
  await recovery.resume();
  assert.equal(restarted.pending().length, 0);
  assert.equal(JSON.parse(restarted.jobs(user, guild)[0].result).url, 'https://example.com/result.mp4');
  assert.throws(() => reserve(restarted, user, 'video'), /user video limit/);
  assert.deepEqual(restarted.jobs(other, guild), []);
  assert.deepEqual(restarted.jobs(user, undefined), []);
});

test('definite POST rejections refund; transport ambiguity retains quota and never retries', async t => {
  const { store } = fixture(t);
  const rejected = new MediaService({ store, confirm: async () => true, media: new MediaGenerator({
    fetchImpl: async () => ({ ok: false, status: 429 }),
  }) });
  await assert.rejects(rejected.generate('image', 'A cat', { userId: user, guildId: guild }));
  assert.equal(store.count('user_id', user, 'image', mediaDay()), 0);
  let posts = 0;
  const ambiguous = new MediaService({ store, confirm: async () => true, media: new MediaGenerator({
    fetchImpl: async () => { posts++; throw new Error('Network lost'); },
  }) });
  await assert.rejects(ambiguous.generate('video', 'A cat', { userId: user, guildId: guild }), /Check \/jobs/);
  store.recover(); await ambiguous.resume();
  assert.equal(posts, 1);
  assert.equal(store.jobs(user, guild)[0].state, 'unknown');
  assert.throws(() => reserve(store, user, 'video'), /user video limit/);
});

test('recovery refunds only unsubmitted reservations and retries transient polling errors', async t => {
  const { store } = fixture(t);
  const unsubmitted = reserve(store);
  const unknown = reserve(store, other, 'video'); store.submitting(unknown);
  const pending = reserve(store, user, 'video'); store.submitted(pending, 'job');
  store.recover();
  assert.equal(store.count('user_id', user, 'image', mediaDay()), 0);
  assert.equal(store.jobs(user, guild).some(job => job.id === unsubmitted), false);
  let fail = true;
  const recovery = new MediaService({ store, media: new MediaGenerator({ fetchImpl: async (_, { method }) => {
    assert.equal(method, 'GET');
    return fail ? { ok: false, status: 503 } : reply({ status: 'failed' });
  } }) });
  await recovery.resume(); assert.equal(store.pending().length, 1);
  fail = false; await recovery.resume(); assert.equal(store.pending().length, 0);
  assert.equal(store.count('user_id', user, 'video', mediaDay()), 1);
});

test('polling rate limits never refund an accepted paid video', async t => {
  const { store } = fixture(t);
  const service = new MediaService({ store, confirm: async () => true, media: new MediaGenerator({
    fetchImpl: async (_, { method }) => method === 'POST' ? reply({ request_id: 'accepted-job' }) : { ok: false, status: 429 },
  }) });
  await assert.rejects(service.generate('video', 'A cat', { userId: user, guildId: guild }));
  assert.equal(store.pending().length, 1);
  assert.throws(() => reserve(store, user, 'video'), /user video limit/);
});

test('owner-only usage and private job retrieval enforce actor and guild scope', async t => {
  const { store } = fixture(t);
  const id = reserve(store); store.complete(id, { kind: 'image', url: 'https://example.com/private.png' });
  const run = async (commandName, userId = user, guildId = guild) => {
    let payload;
    await handleMediaCommand({ commandName, user: { id: userId }, guildId,
      options: { getUser: () => null, getString: () => null }, reply: async value => { payload = value; } }, store);
    assert.equal(payload.flags, 64); return payload.content;
  };
  assert.match(await run('usage'), /Only the bot owner/);
  assert.match(await run('usage', MEDIA_OWNER), /1 image — ready/);
  assert.match(await run('jobs'), /private.png/);
  assert.doesNotMatch(await run('jobs', other), /private.png/);
  assert.doesNotMatch(await run('jobs', user, null), /private.png/);
});

test('an injected tool call on an ordinary question still cannot spend without the authenticated button approval', async t => {
  const { store } = fixture(t);
  let confirmations = 0, calls = 0;
  const service = new MediaService({ store, confirm: async ({ userId, proposal }) => {
    assert.equal(userId, user); assert.equal(proposal.body.prompt, 'Injected request'); confirmations++; return false;
  }, media: new MediaGenerator({ fetchImpl: async () => assert.fail('No paid submission') }) });
  const ai = new AICore({ fetchImpl: async () => { calls++; return reply({ output: [{ type: 'function_call',
    name: 'generate_video', call_id: 'injection', arguments: '{"prompt":"Injected request"}' }] }); } });
  await assert.rejects(ai.respond({ input: 'Summarize this attachment', context: {
    generateMedia: (kind, prompt, options) => service.generate(kind, prompt, { ...options, userId: user, guildId: guild }),
  } }), /cancelled or not confirmed/);
  assert.equal(confirmations, 1); assert.equal(calls, 1); assert.deepEqual(store.usage().rows, []);
});
