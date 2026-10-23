import test from 'node:test';
import assert from 'node:assert/strict';
import { animate, answerCard, card, helpCard, loadingCard, trackCard } from '../src/ui.js';
import { musicHelp } from '../src/music.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('loading edits drain before the final result and cannot overwrite it later', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const edits = [];
  let release;
  const message = { edit: async payload => {
    edits.push(payload);
    if (edits.length === 1) await new Promise(resolve => { release = resolve; });
    return message;
  } };
  const progress = await animate(async () => message);
  t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(12000); await flush();
  assert.equal(edits.length, 1, 'slow Discord edits must not accumulate animation frames');
  const result = card('Done', 'Answer');
  const finishing = progress.finish(result);
  await flush();
  assert.equal(edits.length, 1, 'final result waits for an in-flight frame');
  release(); await finishing;
  t.mock.timers.tick(20000); await flush();
  assert.equal(edits.length, 2);
  assert.equal(edits.at(-1), result);
});

test('deleted loading messages stop background edits without unhandled failures', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let edits = 0;
  const progress = await animate(async () => ({ edit: async () => { edits++; throw new Error('Deleted'); } }));
  t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(40000); await flush();
  assert.equal(edits, 1);
  await progress.stop();
});

test('finished replies contain only their content and clear the loading embed', () => {
  const text = "Hey. What's up?";
  assert.equal(answerCard(text).content, text);
  const payloads = [answerCard(text), helpCard(musicHelp), card('A fresh start', 'History cleared.'),
    trackCard({ title: 'Artist - Track', url: 'https://soundcloud.com/artist/track', duration: 120 })];
  for (const payload of payloads) {
    const message = { ...loadingCard(), ...payload };
    assert.deepEqual(message.embeds, []);
    assert.ok(message.content.length <= 2000);
    assert.ok(!message.content.includes('Kirmy /'));
    assert.ok(!message.content.includes('Made for your conversation'));
    assert.ok(!message.content.includes('─'));
    assert.deepEqual(message.allowedMentions.parse, []);
  }
  const loading = loadingCard();
  assert.deepEqual(loading.embeds, []);
  assert.match(loading.content, /^`[━─]{18}`$/);
});

test('long answers preserve all text and sources in an attachment', () => {
  const text = '```js\n' + 'const value = 1;\n'.repeat(400) + '```\nhttps://example.com/source';
  const payload = answerCard(text);
  assert.equal(payload.files[0].attachment.toString(), text);
  assert.equal(payload.files[0].name, 'kirmy-answer.md');
});

test('help keeps the quick start in chat and preserves advanced settings and privacy in its guide', () => {
  const payload = helpCard(musicHelp);
  assert.ok(payload.content.length <= 2000);
  for (const command of ['/ask', '/jobs', '/voice', '.music', '.language', '/persona', '/memory', '/knowledge', '/reset']) {
    assert.ok(payload.content.includes(command), `Quick start should explain ${command}`);
  }
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, 'kirmy-guide.md');
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

test('search stages change only the bar and stop changing after the plain final reply', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const edits = [];
  const message = { edit: async payload => { edits.push(payload); return message; } };
  const progress = await animate(async () => message);
  for (const [stage, label] of [['web', 'WEB'], ['x', 'X'], ['web_x', 'WEB+X'], ['thinking', '']]) {
    progress.setActivity(stage);
    t.mock.timers.tick(1000); await flush();
    const payload = edits.at(-1);
    assert.deepEqual(payload.embeds, []);
    assert.equal(payload.content.length, 20);
    assert.ok(!/\p{Extended_Pictographic}/u.test(payload.content));
    if (label) assert.ok(payload.content.includes(label));
    else assert.match(payload.content, /^`[━─]{18}`$/);
  }
  await progress.finish(answerCard('Done'));
  const count = edits.length;
  progress.setActivity('web'); t.mock.timers.tick(8000); await flush();
  assert.equal(edits.length, count);
  assert.equal(edits.at(-1).content, 'Done');
});
