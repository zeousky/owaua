import test from 'node:test';
import { OWNER_ID } from '../test-support/owner.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, RequestLimiter, UsageLimitError, DEFAULT_USAGE_LIMITS, usageLimitsFromEnv } from '../src/usage.js';
import { MediaStore } from '../src/media-store.js';
import { handleMediaCommand } from '../src/media-command.js';
import { ConversationStore } from '../src/store.js';

const user = '123456789012345678', other = '223456789012345678';
const guild = '323456789012345678', otherGuild = '423456789012345678';
function fixture(t, limits = DEFAULT_USAGE_LIMITS) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-usage-'));
  let now = Date.parse('2026-10-27T10:00:00Z');
  const stores = [];
  const open = () => { const store = new UsageStore(directory, { now: () => now, limits }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store: open(), open, advance: ms => { now += ms; }, setTime: value => { now = Date.parse(value); }, now: () => now };
}
const reserve = (store, options = {}) => store.reserve({ userId: user, guildId: guild, ...options });
const small = (window, scope, limit) => {
  const limits = structuredClone(DEFAULT_USAGE_LIMITS);
  limits[window][scope] = limit;
  return limits;
};

test('daily counts survive reopening, cross-guild use, and conversation reset without storing content', t => {
  const f = fixture(t, small('daily', 'user', 2));
  reserve(f.store);
  reserve(f.open(), { guildId: null });
  const conversation = new ConversationStore(f.directory);
  conversation.reset(`guild:channel:${user}`); conversation.close();
  const restarted = f.open();
  assert.throws(() => reserve(restarted, { guildId: otherGuild }), /Your daily request limit/);
  assert.equal(restarted.snapshot({ userId: user }).scopes.user.requests, 2);
  assert.equal(restarted.snapshot({ guildId: guild }).scopes.server.requests, 1);
  assert.equal(restarted.db.prepare('SELECT COUNT(*) AS n FROM usage_admissions').get().n, 2);
  assert.equal(restarted.snapshot({ userId: other }).scopes.user.requests, 0);
});

test('server and bot limits include all users, the owner and DMs; rejected attempts do not consume anything', t => {
  const serverFixture = fixture(t, small('daily', 'server', 1));
  reserve(serverFixture.store);
  assert.throws(() => reserve(serverFixture.open(), { userId: other }), /server’s daily request limit/);
  assert.equal(serverFixture.store.snapshot({ userId: other }).scopes.user.requests, 0);
  reserve(serverFixture.store, { userId: other, guildId: otherGuild });
  const botFixture = fixture(t, small('daily', 'bot', 2));
  reserve(botFixture.store, { userId: OWNER_ID });
  reserve(botFixture.store, { userId: other, guildId: null });
  assert.throws(() => reserve(botFixture.store), /bot’s daily request limit/);
  assert.equal(botFixture.store.snapshot().scopes.bot.requests, 2);
});

test('rolling minute window has no boundary burst and survives reopening', t => {
  const f = fixture(t, small('minute', 'user', 2));
  f.setTime('2026-10-27T10:00:58Z'); reserve(f.store);
  f.advance(1000); reserve(f.store);
  f.advance(1000);
  assert.throws(() => reserve(f.open(), { guildId: null }), /one-minute request limit/);
  f.advance(58000); reserve(f.store);
  assert.equal(f.store.snapshot({ userId: user }).scopes.user.requests, 3);
});

test('server and bot minute limits aggregate users and reject without adding records', t => {
  for (const scope of ['server', 'bot']) {
    const f = fixture(t, small('minute', scope, 1));
    reserve(f.store);
    assert.throws(() => reserve(f.store, { userId: other }), /one-minute request limit/);
    assert.equal(f.store.snapshot().scopes.bot.requests, 1);
  }
});

test('voice starts use both quotas; ordinary requests remain after voice quota exhaustion', t => {
  for (const scope of ['user', 'server', 'bot']) {
    const f = fixture(t, small('voice', scope, 1));
    reserve(f.store, { voice: true });
    assert.throws(() => reserve(f.store, { voice: true }), /daily voice session limit/);
    reserve(f.store);
    const usage = f.store.snapshot({ userId: user, guildId: guild });
    assert.deepEqual(usage.scopes.bot, { requests: 2, voice: 1 });
  }
});

test('Budapest midnight resets daily quotas across DST while keeping the rolling minute window', t => {
  for (const [before, after, day] of [
    ['2026-03-28T22:59:59Z', '2026-03-28T23:00:00Z', '2026-03-29'],
    ['2026-03-29T21:59:59Z', '2026-03-29T22:00:00Z', '2026-03-30'],
    ['2026-10-24T21:59:59Z', '2026-10-24T22:00:00Z', '2026-10-25'],
    ['2026-10-25T22:59:59Z', '2026-10-25T23:00:00Z', '2026-10-26'],
  ]) {
    const f = fixture(t, small('daily', 'user', 1));
    f.setTime(before); reserve(f.store);
    assert.throws(() => reserve(f.store), /daily request limit/);
    f.setTime(after); reserve(f.store);
    assert.equal(f.store.snapshot({ userId: user }).day, day);
    assert.equal(f.store.snapshot({ userId: user }).scopes.user.requests, 1);
  }
  const burst = fixture(t, small('minute', 'user', 1));
  burst.setTime('2026-10-27T22:59:59Z'); reserve(burst.store);
  burst.setTime('2026-10-27T23:00:00Z');
  assert.throws(() => reserve(burst.store), /one-minute request limit/);
});

test('shared admission locks user across scopes, bounds concurrency and releases after errors', async t => {
  const f = fixture(t);
  const active = new Set();
  const limiter = new RequestLimiter({ store: f.store, active, now: f.now, concurrency: 1 });
  const request = { scope: 'one', userId: user, guildId: guild };
  const release = limiter.acquire(request);
  assert.throws(() => limiter.acquire({ ...request, scope: 'two', guildId: otherGuild }), /current request/);
  assert.throws(() => limiter.acquire({ ...request, userId: other, scope: 'two' }), /few requests/);
  release(); release();
  assert.equal(active.size, 0);
  assert.throws(() => limiter.acquire(request), /wait 5 seconds/);
  f.advance(5000);
  await assert.rejects(async () => {
    const done = limiter.acquire(request);
    try { throw new Error('Mock provider failure'); } finally { done(); }
  }, /Mock provider failure/);
  assert.equal(active.size, 0);
  assert.equal(f.store.snapshot().scopes.bot.requests, 2, 'failures retain admission');
  f.advance(5000);
  limiter.acquire(request)();
});

test('quota rejection and shutdown never run work; free cleanup bypasses quota and cooldown', t => {
  const f = fixture(t, small('daily', 'user', 1));
  let stopping = false;
  const limiter = new RequestLimiter({ store: f.store, now: f.now, isStopping: () => stopping });
  const request = { scope: 'one', userId: user, guildId: guild };
  limiter.acquire(request)();
  limiter.acquire({ ...request, charge: false })();
  f.advance(5000);
  assert.throws(() => limiter.acquire(request), UsageLimitError);
  assert.equal(limiter.users.size, 0); assert.equal(limiter.active.size, 0);
  limiter.acquire({ ...request, charge: false })();
  assert.equal(f.store.snapshot().scopes.bot.requests, 1);
  stopping = true;
  assert.throws(() => limiter.acquire({ ...request, charge: false }), /restarting/);
  const busy = new RequestLimiter({ store: f.store, isActive: () => true });
  assert.throws(() => busy.acquire({ ...request, charge: false }), /current request/);
});

test('private usage is actor-scoped; only owner may select other actors', async t => {
  const f = fixture(t);
  const media = new MediaStore(f.directory, { now: f.now }); t.after(() => media.close());
  reserve(f.store, { voice: true }); reserve(f.store, { userId: other });
  const run = async (actor, selectedUser, selectedGuild, guildId = guild) => {
    let payload;
    await handleMediaCommand({ commandName: 'usage', user: { id: actor }, guildId,
      options: { getUser: () => selectedUser && { id: selectedUser }, getString: () => selectedGuild },
      reply: async value => { payload = value; } }, media, f.store);
    assert.equal(payload.flags, 64);
    return payload.content || payload.files[0].attachment.toString();
  };
  assert.match(await run(user), /1\/60 requests; 1\/3 voice sessions/);
  assert.match(await run(other), /1\/60 requests; 0\/3 voice sessions/);
  assert.match(await run(user, other), /Only the bot owner/);
  assert.match(await run(user, null, otherGuild), /Only the bot owner/);
  assert.match(await run(OWNER_ID, other), /Selected user: 1\/60/);
  assert.doesNotMatch(await run(user, null, null, null), /Server \(shared\)/);
});

test('environment limits reject invalid values instead of silently disabling enforcement', () => {
  assert.deepEqual(usageLimitsFromEnv({}), DEFAULT_USAGE_LIMITS);
  assert.equal(usageLimitsFromEnv({ USER_DAILY_REQUEST_LIMIT: '10' }).daily.user, 10);
  for (const value of ['', '0', '-1', '1.5', 'Infinity', 'oops', '1000001']) {
    assert.throws(() => usageLimitsFromEnv({ BOT_MINUTE_REQUEST_LIMIT: value }), /Invalid BOT_MINUTE_REQUEST_LIMIT/);
  }
});

test('admission history is pruned after 31 days without resetting current limits', t => {
  const f = fixture(t);
  reserve(f.store);
  f.advance(32 * 86400000); reserve(f.store);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM usage_admissions').get().n, 1);
  assert.equal(f.open().snapshot().scopes.bot.requests, 1);
});
