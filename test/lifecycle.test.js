import test from 'node:test';
import assert from 'node:assert/strict';
import { AICore, ProviderError } from '../src/ai.js';
import { MediaGenerator } from '../src/media.js';

const response = body => ({ ok: true, json: async () => body });
const restartReason = () => new DOMException('Fixture restart', 'AbortError');

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('pre-aborted AI and media requests never call the provider', async () => {
  const controller = new AbortController();
  const reason = restartReason();
  controller.abort(reason);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected provider call'); };
  const ai = new AICore({ apiKey: 'fixture', fetchImpl });
  const media = new MediaGenerator({ apiKey: 'fixture', fetchImpl });
  await assert.rejects(ai.respond({ input: 'hello', signal: controller.signal }), error => error === reason);
  for (const kind of ['image', 'video', 'edit_image']) {
    await assert.rejects(media.generate(kind, 'fixture prompt', {
      images: kind === 'edit_image' ? ['https://example.com/fixture.png'] : [], signal: controller.signal,
    }), error => error === reason);
  }
  assert.equal(calls, 0);
});

test('caller cancellation aborts an in-flight AI fetch without retrying', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const reason = restartReason();
  const started = Promise.withResolvers();
  let calls = 0, providerSignal;
  const ai = new AICore({ apiKey: 'fixture', fetchImpl: async (url, { signal }) => {
    calls++; providerSignal = signal; started.resolve();
    return waitForAbort(signal);
  } });
  const responding = ai.respond({ input: 'hello', signal: controller.signal });
  const rejected = assert.rejects(responding, error => error === reason);
  await started.promise;
  assert.notEqual(providerSignal, controller.signal, 'request deadline and caller cancellation share a combined signal');
  controller.abort(reason);
  await rejected;
  assert.equal(providerSignal.aborted, true);
  assert.equal(calls, 1);
});

test('abort after a provider response prevents local tool dispatch and continuation', async () => {
  const controller = new AbortController();
  const reason = restartReason();
  let requests = 0, executions = 0;
  const ai = new AICore({ apiKey: 'fixture', tools: {
    definitions: () => [],
    execute: async () => { executions++; return { saved: true }; },
  }, fetchImpl: async () => {
    requests++;
    return { ok: true, json: async () => {
      controller.abort(reason);
      return { output: [{ type: 'function_call', name: 'remember_memory',
        arguments: '{"key":"fixture","text":"fixture fact"}', call_id: 'fixture-call' }] };
    } };
  } });
  await assert.rejects(ai.respond({ input: 'fixture fact', signal: controller.signal }), error => error === reason);
  assert.equal(executions, 0);
  assert.equal(requests, 1);
});

test('caller cancellation stops video polling sleep without submitting another job', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const reason = restartReason();
  const sleeping = Promise.withResolvers();
  const methods = [];
  let sleepSignal;
  const media = new MediaGenerator({ apiKey: 'fixture', fetchImpl: async (url, { method }) => {
    methods.push(method);
    return response(method === 'POST' ? { request_id: 'fixture-job' } : { status: 'pending' });
  }, sleep: (milliseconds, value, { signal }) => {
    sleepSignal = signal; sleeping.resolve();
    return waitForAbort(signal);
  } });
  const generating = media.generate('video', 'fixture video', { signal: controller.signal });
  const rejected = assert.rejects(generating, error => error === reason);
  await sleeping.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(sleepSignal.aborted, true);
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('caller cancellation aborts an in-flight video poll without another paid submission', { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const reason = restartReason();
  const polling = Promise.withResolvers();
  const methods = [];
  let pollSignal;
  const media = new MediaGenerator({ apiKey: 'fixture', fetchImpl: async (url, { method, signal }) => {
    methods.push(method);
    if (method === 'POST') return response({ request_id: 'fixture-job' });
    pollSignal = signal; polling.resolve();
    return waitForAbort(signal);
  } });
  const generating = media.generate('video', 'fixture video', { signal: controller.signal });
  const rejected = assert.rejects(generating, error => error === reason);
  await polling.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(pollSignal.aborted, true);
  assert.deepEqual(methods, ['POST', 'GET']);
});

test('provider errors retain classification codes without reading response bodies', async () => {
  const error = new ProviderError(502, 'response_stream_interrupted');
  assert.equal(error.status, 502);
  assert.equal(error.code, 'response_stream_interrupted');
  let bodiesRead = 0;
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => { bodiesRead++; return 'private fixture body'; } });
  const ai = new AICore({ apiKey: 'fixture', fetchImpl });
  await assert.rejects(ai.respond({ input: 'hello' }), error =>
    error instanceof ProviderError && error.status === 429 && error.code === 'provider_error' && !error.message.includes('private fixture body'));
  const media = new MediaGenerator({ apiKey: 'fixture', fetchImpl });
  await assert.rejects(media.generate('image', 'fixture image'), error =>
    error instanceof ProviderError && error.status === 429 && error.code === 'media_provider_error');
  assert.equal(bodiesRead, 0);
});
