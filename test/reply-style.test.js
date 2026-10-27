import test from 'node:test';
import assert from 'node:assert/strict';
import { stripEmojis } from '../src/reply-style.js';
import { AICore, ProviderError } from '../src/ai.js';
import { DEFAULT_PERSONA, personaInstructions } from '../src/persona.js';
import { answerCard, card, trackCard } from '../src/ui.js';
import { resultReply } from '../src/reply.js';

const response = text => ({ ok: true, json: async () => ({ output: [
  { type: 'message', content: [{ type: 'output_text', text }] },
] }) });

test('reported Discord emoji links leave neither emojis nor orphan asset links', async () => {
  const text = '**Aight bet, owner/dev!** [🔥](https://discord.com/assets/a7bd71d6389d0dfe.svg) Got it fr fr. [👀](https://discord.com/assets/4b6781044811b929.svg)';
  const ai = new AICore({ fetchImpl: async () => response(text) });
  const result = await ai.respond({ input: 'Hello' });
  assert.equal(result.text, '**Aight bet, owner/dev!**  Got it fr fr.');
  assert.equal(resultReply(result).content, result.text);
});

test('Unicode sequences, custom Discord emojis, emoji images and shortcodes are removed', () => {
  for (const emoji of ['🔥', '👨‍👩‍👧‍👦', '👩🏽‍💻', '🇭🇺', '1️⃣', '#️⃣', '*️⃣', '❤️', '👍🏿',
    '🏴\u{e0067}\u{e0062}\u{e007f}', '<:fire:123456789012345678>', '<a:dance:123456789012345678>',
    ':fire:', ':+1:', '![🔥](https://example.com/fire.png)',
    'https://cdn.discordapp.com/emojis/123456789012345678.gif']) {
    assert.equal(stripEmojis(`Before ${emoji} after`), 'Before  after', emoji);
  }
});

test('ordinary prose, code, math, numbers, languages and citations survive', () => {
  const text = 'Aight, that actually fucking worked.\n**2 * 3 = 6** # heading 12:30\n```js\n  const x = 42;\n```\nMagyar szöveg, 日本語, می\u200dروم\n[source](https://example.com/a?x=1)';
  assert.equal(stripEmojis(text), text);
  assert.equal(stripEmojis('[Docs 🔥](https://example.com)'), '[Docs ](https://example.com)');
});

test('all personas carry the emoji prohibition including custom and voice styles', () => {
  for (const persona of [DEFAULT_PERSONA, { ...DEFAULT_PERSONA, character: 'pirate' },
    { ...DEFAULT_PERSONA, character: 'custom', description: 'A cheerful character using emojis' }]) {
    assert.match(personaInstructions(persona), /Never use emojis in any reply/);
  }
});

test('final delivery strips reflected command text, tracks, long answers and notices', () => {
  assert.equal(card('', 'Saved 🔥', { fields: [{ name: 'Style 👀', value: ':fire: Casual' }] }).content,
    'Saved \n\nStyle \n Casual');
  assert.doesNotMatch(trackCard({ title: '🔥 Song', duration: 60, url: 'https://example.com' }).content, /🔥/);
  const long = answerCard('🔥Hello\n'.repeat(500));
  assert.doesNotMatch(long.files[0].attachment.toString(), /🔥/);
  assert.equal(resultReply({ text: 'Hello 👀', artifactWarnings: ['Ready 🔥'] }, { notices: [':fire: Note'] }).content,
    'Hello\n\nNote\n\nReady');
  assert.match(answerCard('🔥').content, /couldn’t produce a text reply/);
  assert.equal(card('', '').content, '', 'image-only messages keep an empty caption');
});

test('emoji-only model answers have a useful text fallback', async () => {
  const ai = new AICore({ fetchImpl: async () => response('🔥👀') });
  assert.match((await ai.respond({ input: 'Hello' })).text, /couldn’t produce a text reply/);
});

test('JSON strips escaped emojis after parsing, preserves structure and revalidates schema', async () => {
  const ai = new AICore({ fetchImpl: async () => response('{"answer":"Aight \\ud83d\\udd25","sources":[]}') });
  const result = await ai.respond({ input: 'Hello', requestOptions: { outputFormat: 'json' } });
  assert.deepEqual(JSON.parse(result.text), { answer: 'Aight ', sources: [] });
  for (const text of ['{"🔥":"value"}', '{"answer":"🔥"}']) {
    const bad = new AICore({ fetchImpl: async () => response(text) });
    await assert.rejects(bad.respond({ input: 'Hello', requestOptions: { outputFormat: 'json', schema: {
      type: 'object', properties: { answer: { enum: ['🔥'] } }, required: ['answer'], additionalProperties: false,
    } } }), error => error instanceof ProviderError && error.code === 'invalid_structured_output');
  }
});
