import test from 'node:test';
import assert from 'node:assert/strict';
import { AICore, ProviderError } from '../src/ai.js';

const final = (text = 'Result café', extra = {}) => ({ status: 'completed', model: 'grok-4.7', usage: { output_tokens: 7 },
  output: [{ type: 'message', content: [{ type: 'output_text', text,
    annotations: [{ url: 'https://example.com/source' }] }] }], ...extra });
const added = (id, type, extra = {}) => ({ type: 'response.output_item.added', item: { id, type, status: 'in_progress', ...extra } });
const done = (id, type, extra = {}) => ({ type: 'response.output_item.done', item: { id, type, status: 'completed', ...extra } });
function stream(events, { terminal = final(), ending = true } = {}) {
  const wire = events.map(event => `: keepalive\r\nevent: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('') +
    (ending ? `data: ${JSON.stringify({ type: 'response.completed', response: terminal })}\n\n` : '');
  const bytes = Buffer.from(wire);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('provider search events drive web, X, combined and thinking states while preserving the final answer', async () => {
  const states = [];
  const ai = new AICore({ apiKey: 'mock', fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return stream([
      added('ws_1', 'web_search_call'), added('ws_2', 'web_search_call'),
      done('ws_1', 'web_search_call'),
      added('ct_1', 'custom_tool_call', { call_id: 'xs_123' }),
      added('ct_other', 'custom_tool_call', { call_id: 'as_attachment' }),
      done('ws_2', 'web_search_call'), done('ct_1', 'custom_tool_call', { call_id: 'xs_123' }),
      added('x_2', 'x_search_call'), done('x_2', 'x_search_call'),
    ]);
  } });
  const result = await ai.respond({ input: 'question', onActivity: state => states.push(state) });
  assert.deepEqual(states, ['web', 'web_x', 'x', 'thinking', 'x', 'thinking']);
  assert.match(result.text, /Result café/);
  assert.match(result.text, /https:\/\/example.com\/source/);
  assert.deepEqual(result.usage, [{ output_tokens: 7 }]);
});

test('web lifecycle events and terminal completion clear search state', async () => {
  const states = [];
  const ai = new AICore({ fetchImpl: async () => stream([
    { type: 'response.web_search_call.in_progress', item_id: 'ws_1' },
    { type: 'response.web_search_call.searching', item_id: 'ws_1' },
    { type: 'response.web_search_call.completed', item_id: 'ws_1' },
    added('ct_1', 'custom_tool_call', { call_id: 'xs_1' }),
  ]) });
  await ai.respond({ input: 'hi', onActivity: state => states.push(state) });
  assert.deepEqual(states, ['web', 'thinking', 'x', 'thinking']);
});

test('streamed custom tools still continue once and preserve tool outputs', async () => {
  const requests = [];
  const ai = new AICore({ fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    return requests.length === 1 ? stream([], { terminal: final('', { output: [
      { type: 'function_call', name: 'current_time', call_id: 'clock', arguments: '{"timezone":"UTC"}' },
    ] }) }) : stream([]);
  } });
  assert.match((await ai.respond({ input: 'Time?', onActivity() {} })).text, /Result/);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.at(-1).call_id, 'clock');
  assert.equal(JSON.parse(requests[1].input.at(-1).output).timezone, 'UTC');
});

test('truncated and failed streams fail safely without retrying the paid request', async () => {
  for (const events of [[], [{ type: 'error', message: 'secret-provider-body' }],
    [{ type: 'response.failed', response: { error: { message: 'secret-provider-body' } } }]]) {
    let calls = 0;
    const states = [];
    const ai = new AICore({ fetchImpl: async () => { calls++; return stream([
      added('ws_1', 'web_search_call'), ...events,
    ], { ending: false }); } });
    await assert.rejects(ai.respond({ input: 'hi', onActivity: state => states.push(state) }),
      error => error instanceof ProviderError && !error.message.includes('secret-provider-body'));
    assert.equal(calls, 1);
    assert.deepEqual(states, ['web', 'thinking']);
  }
});

test('presentation errors cannot fail provider output, and JSON responses remain compatible', async () => {
  const ai = new AICore({ fetchImpl: async () => stream([added('ws_1', 'web_search_call')]) });
  assert.match((await ai.respond({ input: 'hi', onActivity: async () => { throw new Error('Discord unavailable'); } })).text, /Result/);
  const json = new AICore({ fetchImpl: async () => new Response(JSON.stringify(final()), { headers: { 'Content-Type': 'application/json' } }) });
  const states = [];
  assert.match((await json.respond({ input: 'hi', onActivity: state => states.push(state) })).text, /Result/);
  assert.deepEqual(states, [], 'do not invent search activity from the final answer');
});
