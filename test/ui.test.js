import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCard, card, helpCard, trackCard } from '../src/ui.js';
import { musicHelp } from '../src/music.js';

test('replies contain plain content without a progress bar', () => {
  const text = "Hey. What's up?";
  assert.equal(answerCard(text).content, text);
  const payloads = [answerCard(text), helpCard(musicHelp), card('A fresh start', 'History cleared.'),
    trackCard({ title: 'Artist - Track', url: 'https://soundcloud.com/artist/track', duration: 120 })];
  for (const payload of payloads) {
    const message = payload;
    assert.deepEqual(message.embeds, []);
    assert.ok(message.content.length <= 2000);
    assert.ok(!message.content.includes('Owaua /'));
    assert.ok(!message.content.includes('Made for your conversation'));
    assert.ok(!message.content.includes('─'));
    assert.deepEqual(message.allowedMentions.parse, []);
  }
});

test('long chat answers stay short without an automatic full-answer attachment', () => {
  const text = '```js\n' + 'const value = 1;\n'.repeat(400) + '```\nhttps://example.com/source';
  const payload = answerCard(text);
  assert.ok(payload.content.length <= 600);
  assert.equal(payload.files, undefined);
});

test('help keeps the quick start in chat and preserves advanced settings and privacy in its guide', () => {
  const payload = helpCard(musicHelp);
  assert.match(payload.content, /I’m Owaua/);
  assert.doesNotMatch(JSON.stringify(payload), /Kirmy/i);
  assert.ok(payload.content.length <= 2000);
  for (const command of ['/ask', '/jobs', '/voice', '.music', '.language', '.full on', '.full off', '/persona', '/memory', '/knowledge', '/reset']) {
    assert.ok(payload.content.includes(command), `Quick start should explain ${command}`);
  }
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, 'owaua-guide.md');
  const guide = payload.files[0].attachment.toString();
  for (const detail of ['180 days', '1,000 exchanges', 'xAI', '/integrations', 'output:json', '/knowledge forget', '/memory forget']) {
    assert.ok(guide.includes(detail), `Detailed guide should retain ${detail}`);
  }
  assert.ok(guide.includes(musicHelp));
  for (const detail of ['Every slash command also works with', '.ask', '.speak', '.knowledge add', '.transcribe', 'Private results go to your DMs', 'use slash commands for private input']) {
    assert.ok(guide.includes(detail), `Detailed guide should explain dot commands: ${detail}`);
  }
  assert.deepEqual(payload.allowedMentions.parse, []);
});
