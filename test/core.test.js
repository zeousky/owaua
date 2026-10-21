import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICore, ProviderError } from '../src/ai.js';
import { ConversationStore, conversationScope } from '../src/store.js';
import { createTools } from '../src/tools.js';

const response = body => ({ ok: true, json: async () => body });
const final = (text = 'Done') => ({ status: 'completed', output: [
  { type: 'message', content: [{ type: 'output_text', text }] },
] });
test('custom tool loop submits output and retains model context', async () => {
  const requests = [];
  const ai = new AICore({ apiKey: 'test', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.x.ai/v1/responses');
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) return response({ output: [
      { type: 'function_call', name: 'current_time', arguments: '{"timezone":"Europe/Budapest"}', call_id: 'call-1' },
    ] });
    return response(final());
  } });
  assert.equal((await ai.respond({ input: 'Time?' })).text, 'Done');
  assert.equal(requests[0].model, 'grok-4.7');
  assert.equal(requests[0].store, false);
  assert.deepEqual(requests[0].tools.slice(0, 3).map(t => t.type), ['web_search', 'x_search', 'code_interpreter']);
  const output = requests[1].input.at(-1);
  assert.equal(output.call_id, 'call-1');
  assert.equal(JSON.parse(output.output).timezone, 'Europe/Budapest');
});
test('unknown tools and bad inputs are returned as errors', async () => {
  const tools = createTools();
  assert.ok((await tools.execute('shell', '{}')).error);
  assert.ok((await tools.execute('current_time', '{')).error);
  assert.ok((await tools.execute('current_time', '{"timezone":"fake/time"}')).error);
});
test('provider errors never leak response bodies', async () => {
  const ai = new AICore({ apiKey: 'secret', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret' }) });
  await assert.rejects(ai.respond({ input: 'hi' }), error => error instanceof ProviderError && !error.message.includes('secret'));
});
test('tool loops stop at configured round limit', async () => {
  let requests = 0;
  const ai = new AICore({ apiKey: 'test', maxToolRounds: 1, fetchImpl: async () => {
    requests++;
    return response({ output: [{ type: 'function_call', name: 'current_time', arguments: '{}', call_id: 'x' }] });
  } });
  await assert.rejects(ai.respond({ input: 'loop' }), /limit/);
  assert.equal(requests, 2);
});
test('citations are kept as usable source links', async () => {
  const body = final('Answer'); body.output[0].content[0].annotations = [{ type: 'url_citation', url: 'https://example.com/source' }];
  const ai = new AICore({ apiKey: 'test', fetchImpl: async () => response(body) });
  assert.match((await ai.respond({ input: 'hi' })).text, /https:\/\/example.com\/source/);
});
test('history is bounded, isolated, persistent, and resettable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kirmy-test-'));
  let store;
  try {
    store = new ConversationStore(directory, 2);
    const a = conversationScope('g', 'c', 'a');
    const b = conversationScope('g', 'c', 'b');
    for (let i = 0; i < 4; i++) store.append(a, `u${i}`, `a${i}`);
    store.append(b, 'private', 'answer');
    assert.equal(store.history(a).length, 4);
    assert.equal(store.history(a)[0].content, 'u2');
    store.close(); store = new ConversationStore(directory, 2);
    assert.equal(store.history(b)[0].content, 'private');
    store.reset(a);
    assert.deepEqual(store.history(a), []);
    assert.equal(store.history(b).length, 2);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
