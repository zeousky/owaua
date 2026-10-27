import test from 'node:test';
import assert from 'node:assert/strict';
import { AICore } from '../src/ai.js';
import { DEFAULT_PERSONA, personaInstructions } from '../src/persona.js';
import { limitReplyLength, MAX_REPLY_CHARACTERS } from '../src/reply-style.js';
import { resultReply } from '../src/reply.js';

const response = text => ({ ok: true, json: async () => ({ output: [
  { type: 'message', content: [{ type: 'output_text', text }] },
] }) });

test('short replies and the exact character boundary remain intact', () => {
  for (const text of ['', 'Hey, what’s up?', 'a'.repeat(MAX_REPLY_CHARACTERS)]) {
    assert.equal(limitReplyLength(text), text);
  }
});

test('overlong replies end at a complete sentence or word when possible', () => {
  const sentence = 'This is a complete sentence with useful context. ';
  const limited = limitReplyLength(sentence.repeat(30));
  assert.ok(limited.length <= MAX_REPLY_CHARACTERS);
  assert.ok(limited.endsWith('.'));
  assert.equal(limitReplyLength('word '.repeat(200)), ('word '.repeat(119)).trimEnd() + '…');
  assert.equal(limitReplyLength('x'.repeat(2000)), 'x'.repeat(599) + '…');
});

test('the cutoff preserves Unicode graphemes and stays stable on repeated delivery', () => {
  for (const text of ['𐐀'.repeat(400), 'a\u0301'.repeat(400), '日本語'.repeat(400)]) {
    const limited = limitReplyLength(text);
    assert.ok(limited.length <= MAX_REPLY_CHARACTERS);
    assert.ok(limited.isWellFormed());
    assert.equal(limitReplyLength(limited), limited);
    if (text.startsWith('a')) assert.ok(limited.endsWith('a\u0301…'));
  }
});

test('all personas receive the length rule, including detailed and custom styles', () => {
  for (const persona of [DEFAULT_PERSONA, { ...DEFAULT_PERSONA, detail: 'detailed' },
    { ...DEFAULT_PERSONA, character: 'custom', description: 'A dramatic storyteller' }]) {
    assert.match(personaInstructions(persona), /1–3 short sentences and at most 600 characters/);
  }
});

test('model output is capped before history, speech and Discord delivery', async () => {
  const ai = new AICore({ fetchImpl: async (_url, options) => {
    assert.match(JSON.parse(options.body).instructions, /at most 600 characters/);
    return response('Here is my answer. ' + 'More unnecessary filler. '.repeat(100));
  } });
  const result = await ai.respond({ input: 'Should you be open source?' });
  assert.ok(result.text.length <= MAX_REPLY_CHARACTERS);
  assert.equal(resultReply(result).content, result.text);
  const direct = resultReply({ text: 'word '.repeat(1000) });
  assert.ok(direct.content.length <= MAX_REPLY_CHARACTERS);
  assert.equal(direct.files, undefined);
});

test('large JSON answers and requested file contents remain intact', async () => {
  const text = JSON.stringify({ answer: 'x'.repeat(2000), sources: [] });
  const ai = new AICore({ fetchImpl: async () => response(text) });
  const result = await ai.respond({ input: 'Return JSON', requestOptions: { outputFormat: 'json' } });
  assert.deepEqual(JSON.parse(result.text), JSON.parse(text));
  const artifact = { name: 'report.txt', attachment: Buffer.from('x'.repeat(4000)) };
  const payload = resultReply({ ...result, artifacts: [artifact] });
  assert.deepEqual(JSON.parse(payload.files[0].attachment.toString()), JSON.parse(text));
  assert.equal(payload.files[1], artifact);
});
