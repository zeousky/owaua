import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAttachments } from '../src/attachments.js';

const attachment = (name, contentType, extra = {}) => ({ name, contentType, size: 100,
  url: `https://cdn.discordapp.com/attachments/1/2/${name}`, ...extra });
const message = (attachments = [], extra = {}) => ({ attachments: new Map(attachments.map((a, i) => [i, a])), ...extra });

test('mixed image, document, and video attachments reach their own input paths', () => {
  const image = attachment('photo.png', 'image/png');
  const pdf = attachment('report.pdf', 'application/pdf');
  const video = attachment('clip.mp4', 'video/mp4');
  assert.deepEqual(requestAttachments(message([image, pdf, video]), undefined, 'bot'), {
    images: [image.url], documents: [pdf], videos: [video.url], audio: [],
  });
});

test('five image references are supported and a sixth is rejected', () => {
  const images = Array.from({ length: 6 }, (_, i) => attachment(`${i}.png`, 'image/png'));
  assert.equal(requestAttachments(message(images.slice(0, 5)), undefined, 'bot').images.length, 5);
  assert.throws(() => requestAttachments(message(images), undefined, 'bot'), /five images/);
});

test('new documents and videos suppress old replied-to image references', () => {
  const old = message([], { author: { id: 'bot' }, embeds: [{ image: { url: 'https://imgen.x.ai/old.png' } }] });
  for (const file of [attachment('a.pdf', 'application/pdf'), attachment('a.mp4', 'video/mp4')]) {
    assert.deepEqual(requestAttachments(message([file]), old, 'bot').images, []);
  }
});

test('replying to document attachments and generated MP4s preserves the requested source', () => {
  const pdf = attachment('a.pdf', 'application/pdf');
  assert.deepEqual(requestAttachments(message(), message([pdf]), 'bot').documents, [pdf]);
  const reference = message([], { author: { id: 'bot' }, content: 'https://vidgen.x.ai/a.mp4?token=example' });
  assert.deepEqual(requestAttachments(message(), reference, 'bot').videos, [reference.content]);
  reference.author.id = 'other';
  assert.deepEqual(requestAttachments(message(), reference, 'bot').videos, []);
});

test('only replied-to bot video embeds supply generated video references', () => {
  const reference = message([], { author: { id: 'bot' }, embeds: [{ video: { url: 'https://vidgen.x.ai/a.mp4' } }] });
  assert.deepEqual(requestAttachments(message(), reference, 'bot').videos, ['https://vidgen.x.ai/a.mp4']);
  reference.author.id = 'other';
  assert.deepEqual(requestAttachments(message(), reference, 'bot').videos, []);
});

test('voice messages use the audio path and cannot silently add a second recording', () => {
  const recording = attachment('voice.ogg', 'audio/ogg');
  assert.deepEqual(requestAttachments(message([recording]), undefined, 'bot').audio, [recording]);
  assert.throws(() => requestAttachments(message([recording, recording]), undefined, 'bot'), /one audio/);
});

test('unsupported, oversize, multiple-video and unsafe video inputs fail before any provider call', () => {
  for (const files of [
    [attachment('a.zip', 'application/zip')],
    [attachment('a.mp4', 'video/mp4', { size: 21 * 1024 * 1024 })],
    [attachment('a.mp4', 'video/mp4', { url: 'http://cdn.discordapp.com/a.mp4' })],
    [attachment('a.mp4', 'video/mp4'), attachment('b.mp4', 'video/mp4')],
    Array.from({ length: 5 }, (_, i) => attachment(`${i}.pdf`, 'application/pdf')),
  ]) assert.throws(() => requestAttachments(message(files), undefined, 'bot'));
});
