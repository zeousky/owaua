import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRecoveryMonitor, RECOVERY_MODELS } from '../src/provider-recovery.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const answer = () => json({ object: 'chat.completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello!' } }] });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function clock() {
  let timestamp = 1000, sequence = 0;
  const timers = new Map();
  return {
    now: () => timestamp,
    setTimeoutImpl: (fn, delay) => { const key = { id: ++sequence, unref() {} }; timers.set(key, { fn, due: timestamp + delay }); return key; },
    clearTimeoutImpl: key => timers.delete(key),
    count: () => timers.size,
    async advance(milliseconds) {
      const target = timestamp + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        timers.delete(next[0]); timestamp = next[1].due;
        next[1].fn(); await settle();
      }
      timestamp = target; await settle();
    },
  };
}
function router(initial = {}) {
  const states = new Map(Object.entries(initial)), restored = [];
  return {
    restored, states,
    recoveryProviders: () => [...states.keys()],
    recoveryState: name => states.has(name) ? { ...states.get(name) } : null,
    scheduleRecovery(name, schedule, { expectedGeneration } = {}) {
      const state = states.get(name);
      if (!state || expectedGeneration !== undefined && state.generation !== expectedGeneration) return false;
      states.set(name, { ...state, ...schedule }); return true;
    },
    recoverProvider(name, { expectedGeneration } = {}) {
      const state = states.get(name);
      if (!state || state.generation !== expectedGeneration) return false;
      states.delete(name); restored.push(name); return true;
    },
    fail(name) {
      const state = states.get(name);
      states.set(name, state ? { ...state, generation: state.generation + 1 } : { generation: 1, attempts: 0, nextCheckAt: null });
    },
  };
}
function fixture(t, { initial = {}, fetchImpl = async () => answer(), ...options } = {}) {
  const time = clock(), routes = router(initial), results = [], errors = [], calls = [];
  const monitor = new ProviderRecoveryMonitor({ router: routes, providers: { xai: { apiKey: 'private-xai-key' }, mistral: { apiKey: 'private-mistral-key' } },
    intervalMs: 100, maxIntervalMs: 1000, timeoutMs: 50, ...time,
    fetchImpl: async (...args) => { calls.push(args); return fetchImpl(...args); },
    onResult: value => results.push(value), onError: value => errors.push(value), ...options });
  t.after(() => monitor.close());
  return { monitor, time, router: routes, results, errors, calls };
}

test('healthy startup and repeated wakes perform no provider calls or recurring checks', async t => {
  const { monitor, time, calls } = fixture(t);
  monitor.start(); monitor.start(); monitor.wake(); monitor.schedule('xai');
  await time.advance(100000);
  assert.equal(calls.length, 0); assert.equal(time.count(), 0);
});

test('a billing failure starts one delayed check per shared key, never per server or per wake', async t => {
  const { monitor, router, time, calls, results } = fixture(t);
  monitor.start(); router.fail('xai');
  monitor.wake(); monitor.wake(); monitor.schedule('xai');
  assert.equal(time.count(), 1); assert.equal(router.recoveryState('xai').nextCheckAt, 1100);
  await time.advance(99); assert.equal(calls.length, 0);
  await time.advance(1); assert.equal(calls.length, 1);
  const [url, options] = calls[0], body = JSON.parse(options.body);
  assert.equal(url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(body, { model: 'grok-4.3', messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, stream: false, reasoning_effort: 'none' });
  assert.deepEqual(router.restored, ['xai']); assert.equal(time.count(), 0);
  assert.deepEqual(results, [{ provider: 'xai', model: 'grok-4.3', status: 'recovered', nextCheckAt: null }]);
  await time.advance(100000); assert.equal(calls.length, 1);
});

test('both providers use separate low-cost models and tiny stateless requests', async t => {
  const { monitor, router, time, calls } = fixture(t);
  router.fail('xai'); router.fail('mistral'); monitor.start(); await time.advance(100);
  assert.equal(calls.length, 2);
  const request = calls.find(([url]) => url.includes('mistral'));
  assert.deepEqual(JSON.parse(request[1].body), { model: RECOVERY_MODELS.mistral, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, stream: false });
  assert.deepEqual(router.restored.sort(), ['mistral', 'xai']);
});

test('failed checks persist bounded exponential backoff and never retry within one check', async t => {
  const { monitor, router, time, calls, results } = fixture(t, { fetchImpl: async () => json({ error: { message: 'Insufficient balance. private response text' } }, 402) });
  router.fail('mistral'); monitor.start();
  for (const [advance, attempts, nextDelay] of [[100, 1, 200], [200, 2, 400], [400, 3, 800], [800, 4, 1000], [1000, 5, 1000]]) {
    await time.advance(advance);
    assert.equal(calls.length, attempts);
    assert.equal(router.recoveryState('mistral').attempts, attempts);
    assert.equal(router.recoveryState('mistral').nextCheckAt - time.now(), nextDelay);
    assert.equal(time.count(), 1);
  }
  assert.equal(router.restored.length, 0);
  assert.equal(results.every(result => result.status === 'insufficient_balance'), true);
  assert.equal(JSON.stringify(results).includes('private response text'), false);
  assert.equal(JSON.stringify(results).includes('private-mistral-key'), false);
});

test('restart uses persisted due time/backoff and does not probe immediately or reset attempts', async t => {
  const state = { generation: 3, attempts: 4, nextCheckAt: 1800 };
  const { monitor, time, router, calls } = fixture(t, { initial: { xai: state }, fetchImpl: async () => json({ error: 'balance empty' }, 402) });
  monitor.start(); await time.advance(799); assert.equal(calls.length, 0);
  await time.advance(1); assert.equal(calls.length, 1);
  assert.equal(router.recoveryState('xai').attempts, 5);
  assert.equal(router.recoveryState('xai').nextCheckAt, 2800);
});

test('HTTP success requires a real nonempty assistant generation before restoring the provider', async t => {
  const invalid = [json({}), json({ error: { code: 'insufficient_balance' } }),
    json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }] }, 201),
    json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] }),
    json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: 'Error' } }] }),
    json({ choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'hello' } }] }),
    new Response('not-json'), json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi', tool_calls: [{}] } }] }),
    json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x'.repeat(20000) } }] })];
  for (const response of invalid) {
    const { monitor, router, time, results } = fixture(t, { fetchImpl: async () => response });
    router.fail('xai'); monitor.start(); await time.advance(100);
    assert.deepEqual(router.restored, []); assert.equal(router.recoveryState('xai').attempts, 1);
    assert.equal(results[0].status, 'unavailable'); monitor.close();
  }
});

test('rate limits, authentication, network failures and server errors keep watching with sanitized status', async t => {
  for (const fetchImpl of [async () => json({ error: 'secret-body' }, 429), async () => json({ error: 'secret-body' }, 401),
    async () => json({}, 500), async () => { throw new Error('private-url-and-key'); }]) {
    const { monitor, router, time, results } = fixture(t, { fetchImpl });
    router.fail('mistral'); monitor.start(); await time.advance(100);
    assert.equal(router.restored.length, 0); assert.equal(time.count(), 1);
    assert.equal(results[0].status, 'unavailable');
    assert.equal(JSON.stringify(results).includes('secret-body'), false);
    assert.equal(JSON.stringify(results).includes('private-url-and-key'), false); monitor.close();
  }
});

test('a newer balance failure prevents an older successful probe restoring the provider', async t => {
  let resolve;
  const { monitor, router, time, calls, results } = fixture(t, { fetchImpl: () => new Promise(done => { resolve = done; }) });
  router.fail('xai'); monitor.start(); await time.advance(100);
  assert.equal(calls.length, 1); router.fail('xai'); resolve(answer()); await settle();
  assert.deepEqual(router.restored, []); assert.equal(router.recoveryState('xai').generation, 2);
  assert.equal(results.some(result => result.status === 'recovered'), false);
  assert.equal(time.count(), 1);
});

test('closing cancels pending and active checks and cannot restore or reschedule afterward', async t => {
  const pending = fixture(t); pending.router.fail('xai'); pending.monitor.start(); pending.monitor.close();
  await pending.time.advance(1000); assert.equal(pending.calls.length, 0);
  let signal;
  const active = fixture(t, { fetchImpl: async (_url, options) => { signal = options.signal; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
  active.router.fail('mistral'); active.monitor.start(); await active.time.advance(100);
  active.monitor.close(); await settle(); assert.equal(signal.aborted, true);
  assert.equal(active.time.count(), 0); assert.equal(active.results.length, 0); assert.deepEqual(active.router.restored, []);
  active.monitor.start(); active.monitor.wake(); await active.time.advance(1000); assert.equal(active.calls.length, 1);
});

test('probe timeout aborts the request once and schedules a later attempt', async t => {
  let signal;
  const { monitor, router, time, calls, results } = fixture(t, { fetchImpl: async (_url, options) => { signal = options.signal; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); } });
  router.fail('xai'); monitor.start(); await time.advance(100); assert.equal(signal.aborted, false);
  await time.advance(50); assert.equal(signal.aborted, true); assert.equal(signal.reason.name, 'TimeoutError');
  assert.equal(calls.length, 1); assert.equal(results[0].status, 'unavailable'); assert.equal(time.count(), 1);
});

test('unconfigured providers and failed persistence cannot start paid probes', async t => {
  const missing = fixture(t, { providers: { xai: {}, mistral: {} } });
  missing.router.fail('xai'); missing.monitor.start(); await missing.time.advance(1000); assert.equal(missing.calls.length, 0);
  const broken = fixture(t); broken.router.fail('xai'); broken.router.scheduleRecovery = () => { throw new Error('private filesystem path'); };
  broken.monitor.start(); await broken.time.advance(1000); assert.equal(broken.calls.length, 0);
  assert.deepEqual(broken.errors, [{ provider: 'xai', code: 'recovery_schedule_failed' }]);
});

test('a paid probe reserves the next eligible time before POST so a restart cannot immediately repeat it', async t => {
  const time = clock(), routes = router(), calls = [];
  const providers = { xai: { apiKey: 'fixture-xai-key' }, mistral: {} };
  let firstSignal;
  const first = new ProviderRecoveryMonitor({ router: routes, providers, intervalMs: 100, maxIntervalMs: 1000, timeoutMs: 50, ...time,
    fetchImpl: async (_url, options) => {
      firstSignal = options.signal; calls.push('first');
      assert.equal(routes.recoveryState('xai').attempts, 1);
      assert.equal(routes.recoveryState('xai').nextCheckAt, 1300);
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
  t.after(() => first.close()); routes.fail('xai'); first.start(); await time.advance(100);
  first.close(); await settle(); assert.equal(firstSignal.aborted, true);
  const second = new ProviderRecoveryMonitor({ router: routes, providers, intervalMs: 100, maxIntervalMs: 1000, timeoutMs: 50, ...time,
    fetchImpl: async () => { calls.push('second'); return answer(); } });
  t.after(() => second.close()); second.start(); await time.advance(199);
  assert.deepEqual(calls, ['first']);
  await time.advance(1); assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(routes.restored, ['xai']);
});

test('failed reservation persistence prevents a due check from submitting a paid POST', async t => {
  const { monitor, router, time, calls, errors } = fixture(t);
  router.fail('xai'); monitor.start();
  router.scheduleRecovery = () => { throw new Error('private filesystem error'); };
  await time.advance(100);
  assert.equal(calls.length, 0); assert.equal(time.count(), 0);
  assert.deepEqual(errors, [{ provider: 'xai', code: 'recovery_schedule_failed' }]);
});

test('a fresh outage replaces a recovered incident’s long-backoff timer with its initial delay', async t => {
  const { monitor, router, time, calls } = fixture(t, { initial: { xai: { generation: 1, attempts: 5, nextCheckAt: 2000 } } });
  monitor.start(); assert.equal(time.count(), 1);
  router.states.delete('xai'); router.fail('xai'); monitor.wake(); monitor.wake();
  assert.equal(router.recoveryState('xai').nextCheckAt, 1100);
  assert.equal(time.count(), 1);
  await time.advance(100); assert.equal(calls.length, 1);
  await time.advance(1000); assert.equal(calls.length, 1);
});
