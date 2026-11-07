import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestAttachments } from '../src/attachments.js';
import { MediaStore } from '../src/media-store.js';

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
  const isGeneratedMedia = (kind, url) => kind === 'video' && url === reference.content;
  assert.deepEqual(requestAttachments(message(), reference, 'bot', isGeneratedMedia).videos, [reference.content]);
  reference.author.id = 'other';
  assert.deepEqual(requestAttachments(message(), reference, 'bot', isGeneratedMedia).videos, []);
});

test('only replied-to bot video embeds supply generated video references', () => {
  const generated = 'https://vidgen.x.ai/a.mp4';
  const reference = message([], { author: { id: 'bot' }, embeds: [
    { video: { url: 'https://example.com/a.mp4' } }, { video: { url: generated } },
  ] });
  const isGeneratedMedia = (kind, url) => kind === 'video' && url === generated;
  assert.deepEqual(requestAttachments(message(), reference, 'bot', isGeneratedMedia).videos, [generated]);
  reference.author.id = 'other';
  assert.deepEqual(requestAttachments(message(), reference, 'bot', isGeneratedMedia).videos, []);
});

test('completed media references are checked against stored results and the Discord scope', t => {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-media-references-'));
  const store = new MediaStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const userId = '111111111111111111', other = '222222222222222222', guildId = '333333333333333333';
  const firstImage = 'https://imgen.x.ai/first.png', secondImage = 'https://imgen.x.ai/second.png';
  const video = 'https://vidgen.x.ai/a.mp4?signature=original';
  const imageJob = store.reserve({ userId, guildId, kind: 'image' });
  const imageReply = message([], { author: { id: 'bot' }, embeds: [
    { image: { url: firstImage } }, { image: { url: secondImage } },
  ] });
  const attachments = (reference, scope) => requestAttachments(message(), reference, 'bot',
    (kind, url) => store.hasCompletedMedia(kind, url, scope));
  assert.deepEqual(attachments(imageReply, { userId, guildId }).images, []);
  store.complete(imageJob, { url: firstImage, urls: [firstImage, secondImage] });
  assert.deepEqual(attachments(imageReply, { userId: other, guildId }).images, [firstImage, secondImage]);
  assert.deepEqual(attachments(imageReply, { userId }).images, []);
  const videoJob = store.reserve({ userId, kind: 'video' });
  store.complete(videoJob, { url: video });
  const videoReply = content => message([], { author: { id: 'bot' }, content });
  assert.deepEqual(attachments(videoReply(video), { userId }).videos, [video]);
  assert.deepEqual(attachments(videoReply(video), { userId: other }).videos, []);
  assert.deepEqual(attachments(videoReply(video.replace('original', 'tampered')), { userId }).videos, []);
  assert.deepEqual(attachments(videoReply('https://example.com/injected.mp4'), { userId }).videos, []);
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
