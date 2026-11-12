import test from 'node:test';
import { OWNER_ID } from '../test-support/owner.js';
import assert from 'node:assert/strict';
import { createJikiClient, JIKI_MODEL, JIKI_MAX_PROMPT_LENGTH, JikiProviderError,
  directJikiReply, usesDirectJiki } from '../src/jiki.js';
import { CLEAN_LANGUAGE_GUILD } from '../src/server-language.js';

const url = 'https://jiki.example';
const apiKey = 'test-' + 'a'.repeat(32);
const prompt = { text: 'Hello, Jiki.', instructions: 'Answer in English.' };
const clientFor = fetchImpl => createJikiClient({ url, apiKey, fetchImpl });

test('Jiki is optional and requires a bare HTTPS origin and a gateway-compatible key', () => {
  assert.equal(createJikiClient(), undefined);
  assert.equal(createJikiClient({ url: '', apiKey: '' }), undefined);
  assert.ok(createJikiClient({ url: url + '/', apiKey }));
  for (const config of [
    { url }, { apiKey }, { url, apiKey: 'too short' },
    { url: 'http://jiki.example', apiKey },
    { url: 'https://user:secret@jiki.example', apiKey },
    { url: url + '/v1', apiKey },
    { url: url + '?secret', apiKey },
    { url: url + '#secret', apiKey },
  ]) {
    assert.throws(() => createJikiClient(config), error =>
      error.message.includes('QWEN_API_URL') && !error.message.includes('secret'));
  }
});

test('Jiki uses a single-turn text payload and returns only the final answer and numeric usage', async () => {
  const client = clientFor(async (target, options) => {
    assert.equal(target, url + '/v1/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(options.headers, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), {
      model: JIKI_MODEL,
      messages: [{ role: 'system', content: prompt.instructions }, { role: 'user', content: prompt.text }],
      max_tokens: 768,
    });
    return Response.json({
      model: 'untrusted name',
      choices: [{ message: { content: ' Hi. ', reasoning_content: 'private scratchpad' } }],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 'untrusted', extra: 8 },
    });
  });
  assert.deepEqual(await client.respond(prompt), {
    text: 'Hi.', model: JIKI_MODEL, usage: [{ prompt_tokens: 10, completion_tokens: 7 }],
  });
});

test('only the owner can use direct Jiki outside the clean-language server', () => {
  assert.equal(usesDirectJiki(OWNER_ID, null), true);
  assert.equal(usesDirectJiki(OWNER_ID, 'other-guild'), true);
  assert.equal(usesDirectJiki(OWNER_ID, CLEAN_LANGUAGE_GUILD), false);
  assert.equal(usesDirectJiki('other-user', null), false);
});

test('direct Jiki sends no system message and preserves the final text through delivery', async () => {
  const reply = '  I decline. 🧪 @everyone\n';
  const client = clientFor(async (_, { body }) => {
    assert.deepEqual(JSON.parse(body), {
      model: JIKI_MODEL,
      messages: [{ role: 'user', content: prompt.text }],
      max_tokens: 768,
    });
    return Response.json({ choices: [{ message: { content: reply } }] });
  });
  const result = await client.respond({ text: prompt.text });
  const payload = directJikiReply(result.text);
  assert.equal(payload.content, reply);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  const long = reply.repeat(100);
  assert.equal(directJikiReply(long).files[0].attachment.toString(), long);
});

test('Jiki rejects empty or oversized prompts without sending a request', async () => {
  let calls = 0;
  const client = clientFor(() => { calls++; });
  for (const request of [
    { ...prompt, text: '' },
    { ...prompt, text: 'x'.repeat(JIKI_MAX_PROMPT_LENGTH + 1) },
    { ...prompt, instructions: '' },
    { ...prompt, instructions: 'x'.repeat(4501) },
  ]) {
    await assert.rejects(client.respond(request), { name: 'JikiProviderError', code: 'invalid_prompt' });
  }
  assert.equal(calls, 0);
});

test('Jiki sanitizes network and provider errors and never returns reasoning or a reflected key', async () => {
  const cases = [
    [() => { throw new Error(apiKey); }, 'connection_error', 502],
    [() => new Response(apiKey, { status: 429 }), 'http_error', 429],
    [() => new Response(apiKey), 'invalid_response', 502],
    [() => Response.json({ error: apiKey }), 'invalid_response', 502],
    [() => Response.json({ choices: [{ message: { reasoning_content: apiKey } }] }), 'empty_response', 502],
    [() => Response.json({ choices: [{ message: { content: apiKey } }] }), 'invalid_response', 502],
  ];
  for (const [fetchImpl, code, status] of cases) {
    await assert.rejects(clientFor(fetchImpl).respond(prompt), error => error instanceof JikiProviderError &&
      error.code === code && error.status === status && !error.stack.includes(apiKey) && !error.cause);
  }
});

test('Jiki skips the request if already cancelled and observes cancellation during response parsing', async () => {
  const controller = new AbortController();
  const client = clientFor(async (_, { signal }) => ({
    ok: true,
    async json() {
      controller.abort(new Error(apiKey));
      assert.equal(signal.aborted, true);
      return { choices: [{ message: { content: 'Do not send me.' } }] };
    },
  }));
  const request = { ...prompt, signal: controller.signal };
  await assert.rejects(client.respond(request), { name: 'JikiProviderError', code: 'cancelled' });
  await assert.rejects(clientFor(() => assert.fail('Cancelled before fetch')).respond(request),
    { name: 'JikiProviderError', code: 'cancelled' });
});

test('Jiki keeps its deadline active until the response body has been read', async t => {
  const deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const client = clientFor(async (_, { signal }) => ({
    ok: true,
    async json() {
      deadline.abort();
      assert.equal(signal.aborted, true);
      throw signal.reason;
    },
  }));
  await assert.rejects(client.respond(prompt), { name: 'JikiProviderError', code: 'timeout', status: 504 });
  assert.deepEqual(timeout.mock.calls[0].arguments, [140_000]);
});
