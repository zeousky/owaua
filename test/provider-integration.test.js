import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICore, ProviderError } from '../src/ai.js';
import { ProviderRouter } from '../src/providers.js';
import { RequestOptionsError } from '../src/request-options.js';
import { createTools } from '../src/tools.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const final = (text = 'Completed safely.') => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const call = (name, args = { query: 'Find the current result.' }) => ({ status: 'completed', output: [{ type: 'function_call', name,
  call_id: `call_${name}`, arguments: JSON.stringify(args) }] });
const stream = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const directory = t => {
  const value = mkdtempSync(join(tmpdir(), 'owaua-provider-integration-'));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
};

test('Mistral AICore sends Large 4 Responses with portable input and only supported fields', async () => {
  const requests = [], input = [{ type: 'input_text', text: 'Summarize this PDF.' },
    { type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }];
  const ai = new AICore({ provider: 'mistral', apiKey: 'fake-mistral-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.mistral.ai/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer fake-mistral-key');
    assert.equal(options.redirect, 'error'); requests.push(JSON.parse(options.body));
    return json(final());
  } });
  const result = await ai.respond({ input, cacheKey: 'a'.repeat(64), safetyIdentifier: 'b'.repeat(64), requestOptions: { reasoningEffort: 'high' } });
  assert.equal(result.model, 'mistral-large-4');
  const body = requests[0];
  assert.equal(body.model, 'mistral-large-4'); assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.deepEqual(body.input.at(-1).content, input);
  for (const unsupported of ['store', 'include', 'prompt_cache_key', 'safety_identifier', 'max_turns']) assert.equal(Object.hasOwn(body, unsupported), false, unsupported);
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.tools.every(tool => tool.type === 'function'), true);
  assert.deepEqual(body.tools.slice(0, 2).map(tool => tool.name), ['web_search', 'code_interpreter']);
  assert.doesNotMatch(body.instructions, /X search for posts/);
});

test('Mistral rejects incompatible reasoning, search restrictions and xAI indexes before network calls', async () => {
  let calls = 0;
  const ai = new AICore({ provider: 'mistral', apiKey: 'fake-key', fetchImpl: async () => { calls++; throw new Error('unexpected network'); } });
  for (const requestOptions of [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' },
    { webDomains: 'example.com' }, { xHandles: 'mistralai' }, { fromDate: '2026-10-01' }, { visualSearch: true }]) {
    await assert.rejects(ai.respond({ input: 'Question', requestOptions }), RequestOptionsError);
  }
  await assert.rejects(ai.respond({ input: 'Question', knowledgeTools: [{ type: 'file_search', vector_store_ids: ['collection_xai'] }] }),
    error => error instanceof ProviderError && error.provider === 'mistral' && error.code === 'incompatible_knowledge_index');
  assert.equal(calls, 0);
});

for (const tool of ['web_search', 'code_interpreter']) {
  test(`Mistral ${tool} dispatches its native hosted Conversations tool and resumes Responses`, async () => {
    const requests = [], states = [];
    const ai = new AICore({ provider: 'mistral', apiKey: 'fake-mistral-key', fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, body });
      if (requests.length === 1) return json(call(tool));
      if (requests.length === 2) return json({ outputs: [
        { type: 'tool.execution', name: tool, info: {} },
        { type: 'message.output', content: [{ type: 'text', text: 'Verified result: 42.' },
          { type: 'tool_reference', url: 'https://example.com/evidence', title: 'Evidence' }] },
      ], usage: { total_tokens: 20 } });
      return stream([{ type: 'response.completed', response: final('The result is 42. https://example.com/evidence') }]);
    } });
    assert.match((await ai.respond({ input: 'Find the result', onActivity: state => states.push(state) })).text, /42/);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].url, 'https://api.mistral.ai/v1/conversations');
    assert.equal(requests[1].body.model, 'mistral-large-4');
    assert.equal(requests[1].body.store, false);
    assert.deepEqual(requests[1].body.tools, [{ type: tool }]);
    assert.equal(requests[1].body.completion_args.tool_choice, 'required');
    assert.equal(requests[2].url, 'https://api.mistral.ai/v1/responses');
    const replay = requests[2].body.input.at(-1);
    assert.equal(replay.type, 'function_call_output'); assert.equal(replay.call_id, `call_${tool}`);
    assert.equal(JSON.parse(replay.output).text, 'Verified result: 42.');
    assert.equal(JSON.parse(replay.output).sources[0].url, 'https://example.com/evidence');
    if (tool === 'web_search') assert.deepEqual(states, ['web', 'thinking']);
  });
}

for (const provider of ['xai', 'mistral']) {
  for (const envelope of ['http', 'json', 'sse']) {
    test(`${provider} ${envelope} insufficient balance is classified without exposing provider content`, async () => {
      const secretBody = { code: 'insufficient_balance', message: 'Insufficient balance. user-private-content fake-provider-key' };
      const ai = new AICore({ provider, apiKey: 'fake-provider-key', fetchImpl: async () => envelope === 'http'
        ? json({ error: secretBody }, 402) : envelope === 'json'
          ? json({ status: 'failed', error: secretBody, output: [] })
          : stream([{ type: 'response.failed', response: { status: 'failed', error: secretBody } }]) });
      await assert.rejects(ai.respond({ input: 'Hello', onActivity() {} }), error => {
        assert.equal(error instanceof ProviderError, true);
        assert.equal(error.provider, provider); assert.equal(error.code, 'insufficient_balance');
        assert.equal(error.message.includes('user-private-content'), false);
        assert.equal(error.message.includes('fake-provider-key'), false);
        // HTTP rejection occurs before generation/tool execution; failed 200
        // envelopes may already have executed hosted tools and are conservative.
        assert.equal(error.replaySafe, envelope === 'http');
        return true;
      });
    });
  }
}

test('actual Router and AICore retry a first-request billing failure after provider-specific attachment preparation', async t => {
  const prepared = [], requests = [];
  const providers = {
    xai: new AICore({ apiKey: 'fake-xai-key', fetchImpl: async (url, options) => {
      requests.push({ provider: 'xai', url, body: JSON.parse(options.body) });
      return json({ error: { message: 'Your account has insufficient credits.' } }, 400);
    } }),
    mistral: new AICore({ provider: 'mistral', apiKey: 'fake-mistral-key', fetchImpl: async (url, options) => {
      requests.push({ provider: 'mistral', url, body: JSON.parse(options.body) }); return json(final());
    } }),
  };
  const router = new ProviderRouter({ providers, directory: directory(t) });
  const result = await router.respond({ input: 'Read this file', prepareForProvider: async provider => {
    prepared.push(provider);
    return { input: [{ type: 'input_text', text: 'Read this file' }, provider === 'xai'
      ? { type: 'input_file', file_id: 'file_xai_only' }
      : { type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' }] };
  } });
  assert.equal(result.provider, 'mistral'); assert.equal(router.provider, 'mistral');
  assert.deepEqual(prepared, ['xai', 'mistral']); assert.equal(requests.length, 2);
  assert.equal(requests[0].body.input.at(-1).content[1].file_id, 'file_xai_only');
  assert.equal(requests[1].body.input.at(-1).content[1].file_id, undefined);
  assert.match(requests[1].body.input.at(-1).content[1].file_data, /^data:application\/pdf;base64,/);
  assert.equal(new ProviderRouter({ providers, directory: router.directory }).provider, 'mistral');
});

test('a billing failure after executing a local tool switches future requests without replaying side effects', async t => {
  let firstCalls = 0, alternateCalls = 0, executions = 0;
  const tools = createTools(); tools.execute = async () => { executions++; return { time: '12:00' }; };
  const router = new ProviderRouter({ directory: directory(t), providers: {
    xai: new AICore({ apiKey: 'fake-xai-key', tools, fetchImpl: async () => ++firstCalls === 1
      ? json(call('current_time', { timezone: 'UTC' })) : json({ error: { code: 'insufficient_balance' } }, 402) }),
    mistral: new AICore({ provider: 'mistral', apiKey: 'fake-mistral-key', fetchImpl: async () => { alternateCalls++; return json(final()); } }),
  } });
  await assert.rejects(router.respond({ input: 'What time is it?' }), error => error.code === 'insufficient_balance' && error.replaySafe === false);
  assert.equal(router.provider, 'mistral'); assert.equal(executions, 1);
  assert.equal(firstCalls, 2); assert.equal(alternateCalls, 0);
  assert.equal((await router.respond({ input: 'Hello again' })).provider, 'mistral');
  assert.equal(executions, 1); assert.equal(alternateCalls, 1);
});

test('nonbilling provider failures never silently change the provider', async t => {
  let alternateCalls = 0;
  const router = new ProviderRouter({ directory: directory(t), providers: {
    xai: new AICore({ apiKey: 'fake-xai-key', fetchImpl: async () => json({ error: { code: 'rate_limit', message: 'Too many requests' } }, 429) }),
    mistral: new AICore({ provider: 'mistral', apiKey: 'fake-mistral-key', fetchImpl: async () => { alternateCalls++; return json(final()); } }),
  } });
  await assert.rejects(router.respond({ input: 'Hello' }), error => error.status === 429 && error.code === 'provider_error');
  assert.equal(router.provider, 'xai'); assert.equal(alternateCalls, 0);
});

test('Mistral safety repair uses its own endpoint and supported fields without replaying rejected output', async () => {
  const requests = [], signals = [];
  const ai = new AICore({ provider: 'mistral', apiKey: 'fake-mistral-key', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.mistral.ai/v1/responses'); signals.push(options.signal); requests.push(JSON.parse(options.body));
    return json(final(requests.length === 1 ? "You're an idiot" : 'Already on the clock.'));
  } });
  assert.equal((await ai.respond({ input: 'get a job', onActivity() {} })).text, 'Already on the clock.');
  assert.equal(requests.length, 2); assert.equal(signals[0], signals[1]);
  assert.equal(requests[0].stream, true); assert.equal(requests[1].stream, false); assert.deepEqual(requests[1].tools, []);
  assert.equal(Object.hasOwn(requests[1], 'max_turns'), false);
  assert.equal(JSON.stringify(requests[1]).includes("You're an idiot"), false);
});
