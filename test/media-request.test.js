import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsMedia } from '../src/media-request.js';

test('clear creation requests authorize their own media type with no settings questionnaire', () => {
  for (const text of ['make an image', 'can you make me a pic of a cat', 'Please generate a portrait',
    'draw a cat', 'I want a picture of the moon', 'kérlek készíts egy képet egy macskáról']) {
    assert.equal(requestsMedia('image', text), true, text);
    assert.equal(requestsMedia('video', text), false, text);
  }
  for (const text of ['make a video', 'could you please create a clip of the ocean',
    'I need a video of a sunset', 'készíts egy videót egy macskáról']) {
    assert.equal(requestsMedia('video', text), true, text);
    assert.equal(requestsMedia('image', text), false, text);
  }
});

test('reference edits, animation and extension use the current supplied media', () => {
  const images = ['https://example.com/cat.png'], videos = ['https://example.com/cat.mp4'];
  assert.equal(requestsMedia('video', 'animate this', { images }), true);
  assert.equal(requestsMedia('edit_image', 'make the background blue', { images }), true);
  assert.equal(requestsMedia('edit_video', 'remove the background', { videos }), true);
  assert.equal(requestsMedia('extend_video', 'continue this clip', { videos }), true);
  assert.equal(requestsMedia('edit_image', 'make the background blue'), false);
  assert.equal(requestsMedia('extend_video', 'continue this clip', { images }), false);
});

test('ordinary questions, negations, quoted examples and mismatched types still need review', () => {
  for (const text of [undefined, 'Summarize this attachment', 'What is image generation?',
    'How do you make a video?', 'Do not make an image', 'Make an image, but not yet',
    'Explain "make an image"', 'Translate: make an image', '```make an image```',
    '"make an image"', 'Generate code for making a video']) {
    for (const kind of ['image', 'video']) assert.equal(requestsMedia(kind, text), false, text);
  }
});
