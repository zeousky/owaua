import test from 'node:test';
import assert from 'node:assert/strict';
import { requestImages } from '../src/images.js';

const attachment = (url, contentType = 'image/png', size = 100) => ({ url, contentType, size });
const msg = (attachments = [], extras = {}) => ({ attachments: new Map(attachments.map((a, i) => [i, a])), ...extras });
test('new attachment in a reply takes priority over the old bot image', () => {
  const source = msg([attachment('https://cdn.discordapp.com/new.png')]);
  const ref = msg([], { author: { id: 'bot' }, embeds: [{ image: { url: 'https://imgen.x.ai/old.png' } }] });
  assert.deepEqual(requestImages(source, ref, 'bot'), ['https://cdn.discordapp.com/new.png']);
});
test('replying to an image attachment supplies it when no new image is attached', () => {
  const ref = msg([attachment('https://cdn.discordapp.com/cat.png')], { author: { id: 'user' } });
  assert.deepEqual(requestImages(msg(), ref, 'bot'), ['https://cdn.discordapp.com/cat.png']);
});
test('bot image embeds support iterative edits but other users embeds are ignored', () => {
  const ref = msg([], { author: { id: 'bot' }, embeds: [{ image: { url: 'https://imgen.x.ai/cat.png' } }] });
  assert.deepEqual(requestImages(msg(), ref, 'bot'), ['https://imgen.x.ai/cat.png']);
  ref.author.id = 'other';
  assert.deepEqual(requestImages(msg(), ref, 'bot'), []);
  assert.deepEqual(requestImages(msg(), undefined, 'bot'), []);
});
test('oversize, unsupported, and too many attachments are rejected', () => {
  for (const attachments of [[attachment('https://example.com/a', 'image/png', 21 * 1024 * 1024)],
    [attachment('https://example.com/a', 'video/mp4')],
    Array.from({ length: 5 }, (_, i) => attachment(`https://example.com/${i}.png`))]) {
    assert.throws(() => requestImages(msg(attachments), undefined, 'bot'));
  }
});
