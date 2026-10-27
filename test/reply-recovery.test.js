import test from 'node:test';
import assert from 'node:assert/strict';
import { AICore, ReplySafetyError, ProviderError } from '../src/ai.js';
import { SAFETY_REFUSAL, withRequestUser } from '../src/safety.js';
import { CLEAN_LANGUAGE_GUILD, withServerLanguage } from '../src/server-language.js';
import { FULL_MODE_OWNER } from '../src/full-mode.js';

const final = text => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
function fixture(outputs) {
  const requests = [], signals = [];
  const ai = new AICore({ apiKey: 'test', fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body)); signals.push(options.signal);
    return { ok: true, json: async () => ({ ...outputs[Math.min(requests.length - 1, outputs.length - 1)], usage: { output_tokens: 10 } }) };
  } });
  return { ai, requests, signals };
}

test('get a job receives a clean rewrite instead of the generic safety refusal after a bad draft', async () => {
  const f = fixture([final("You're an idiot"), final('Already on the clock here.')]);
  const result = await f.ai.respond({ input: 'get a job' });
  assert.equal(result.text, 'Already on the clock here.');
  assert.equal(result.usage.length, 2);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].tools, []);
  assert.equal(f.requests[1].stream, false);
  assert.equal(f.requests[1].max_turns, 1);
  assert.equal(f.signals[0], f.signals[1]);
  assert.equal(JSON.stringify(f.requests[1]).includes("You're an idiot"), false);
});

test('a model-generated policy refusal for harmless banter is rewritten too', async () => {
  const f = fixture([final(SAFETY_REFUSAL), final('Already on it.')]);
  assert.equal((await f.ai.respond({ input: 'get a job' })).text, 'Already on it.');
  assert.equal(f.requests.length, 2);
});

test('the screenshot replies are rewritten in the protected server even for the exempt owner', async () => {
  for (const text of ["hows ur ass doin tho", "I'll tear that shit apart and make it slap."]) {
    const f = fixture([final(text), final('Send it over and I can help improve it.')]);
    const result = await withServerLanguage(CLEAN_LANGUAGE_GUILD, () => withRequestUser(FULL_MODE_OWNER,
      () => f.ai.respond({ input: "I'm going to send you a job application in a moment boi.",
        context: { userId: FULL_MODE_OWNER }, fullMode: true })));
    assert.equal(result.text, 'Send it over and I can help improve it.');
    assert.doesNotMatch(f.requests[0].instructions, /act gen z ish, swear alot/);
    assert.match(f.requests[0].instructions, /Server rule:/);
  }
});

test('recovery is bounded and its final draft must pass the same output checks', async () => {
  for (const text of ["You're an idiot", 'I love cum', 'xai-1234567890abcdefghijklmnop']) {
    const f = fixture([final(text)]);
    await assert.rejects(f.ai.respond({ input: 'get a job' }), error =>
      error instanceof ReplySafetyError && !error.message.includes('safe version of that request'));
    assert.equal(f.requests.length, 2);
  }
  const f = fixture([final('shit')]);
  await assert.rejects(withServerLanguage(CLEAN_LANGUAGE_GUILD, () => f.ai.respond({ input: 'Hello' })), ReplySafetyError);
  assert.equal(f.requests.length, 2);
});

test('recovery never replays completed tools or executes new tool calls', async () => {
  for (const repairOutput of [final('Already on the clock.'), { output: [
    { type: 'function_call', name: 'current_time', call_id: 'new', arguments: '{}' },
  ] }]) {
    const f = fixture([{ output: [{ type: 'function_call', name: 'current_time', call_id: 'first', arguments: '{}' }] },
      final("You're an idiot"), repairOutput]);
    let executed = 0;
    f.ai.tools.execute = async () => { executed++; return { time: '12:00' }; };
    const run = () => f.ai.respond({ input: 'get a job' });
    if (repairOutput.output[0].type === 'function_call') await assert.rejects(run(), error => error instanceof ProviderError && error.code === 'unexpected_reply_tool_call');
    else assert.equal((await run()).text, 'Already on the clock.');
    assert.equal(executed, 1);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.requests[2].tools, []);
  }
});

test('normal replies need no retry and structured retries retain their schema', async () => {
  const f = fixture([final('Hello!')]);
  assert.equal((await f.ai.respond({ input: 'Hi' })).text, 'Hello!');
  assert.equal(f.requests.length, 1);
  const json = fixture([final('{"answer":"You are an idiot"}'), final('{"answer":"Already on it."}')]);
  const result = await json.ai.respond({ input: 'get a job', requestOptions: { outputFormat: 'json', schema: {
    type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false,
  } } });
  assert.equal(JSON.parse(result.text).answer, 'Already on it.');
  assert.deepEqual(json.requests[0].text, json.requests[1].text);
});
