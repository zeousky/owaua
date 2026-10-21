import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaGenerator, MediaInputError, mediaReply } from '../src/media.js';
import { createTools } from '../src/tools.js';

const image = 'https://cdn.discordapp.com/source.png';
const video = 'https://cdn.discordapp.com/source.mp4';
const response = body => ({ ok: true, json: async () => body });
function fixture() {
  const requests = [];
  return { requests, media: new MediaGenerator({ fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    requests.push({ url, body });
    if (url.includes('/images/')) return response({ model: 'resolved-image-model', usage: { cost_in_usd_ticks: 123 },
      data: Array.from({ length: body.n }, (_, i) => ({ url: `https://imgen.x.ai/${i}.jpg` })) });
    return response(options.method === 'POST' ? { request_id: 'job' }
      : { status: 'done', model: 'resolved-video-model', usage: { cost_in_usd_ticks: 456 },
        video: { url: 'https://vidgen.x.ai/result.mp4', respect_moderation: true } });
  } }) };
}

test('image options preserve five references and deliver every requested output with usage', async () => {
  const { media, requests } = fixture();
  const images = Array.from({ length: 5 }, (_, i) => `https://cdn.discordapp.com/${i}.png`);
  const result = await media.generate('edit_image', 'Combine these images', { images,
    options: { count: 3, quality: 'low', resolution: '2k', aspect_ratio: '9:16' } });
  assert.match(requests[0].url, /images\/edits$/);
  assert.equal(requests[0].body.images.length, 5);
  assert.deepEqual({ n: requests[0].body.n, quality: requests[0].body.quality,
    resolution: requests[0].body.resolution, aspect_ratio: requests[0].body.aspect_ratio },
  { n: 3, quality: 'low', resolution: '2k', aspect_ratio: '9:16' });
  assert.equal(result.urls.length, 3);
  assert.equal(result.url, result.urls[0]);
  assert.equal(mediaReply(result).embeds.length, 3);
  assert.equal(result.model, 'resolved-image-model');
  assert.deepEqual(result.usage, { cost_in_usd_ticks: 123 });
  assert.equal(requests.length, 1);
});

test('one-image animation keeps the source ratio; multiple references select the capable model', async () => {
  const first = fixture();
  await first.media.generate('video', 'Blink', { images: [image] });
  assert.equal(first.requests[0].body.model, 'grok-imagine-video-1.5-lite');
  assert.deepEqual(first.requests[0].body.image, { url: image, type: 'image_url' });
  assert.equal(first.requests[0].body.aspect_ratio, undefined);
  const second = fixture();
  const images = [image, 'https://cdn.discordapp.com/background.jpg'];
  const result = await second.media.generate('video', 'Place subject on the set', { images,
    options: { duration: 15, aspect_ratio: '9:16', resolution: '480p' } });
  assert.deepEqual(second.requests[0].body, { model: 'grok-imagine-video-1.5',
    prompt: 'Place subject on the set', duration: 15, aspect_ratio: '9:16', resolution: '480p',
    reference_images: images.map(url => ({ url })) });
  assert.equal(result.model, 'resolved-video-model');
  assert.equal(result.requestId, 'job');
  assert.deepEqual(result.usage, { cost_in_usd_ticks: 456 });
  assert.equal(second.requests.length, 2);
});

test('explicit reference mode supports a single image and text video can request native 1080p', async () => {
  const ref = fixture();
  await ref.media.generate('video', 'Use the subject', { images: [image],
    options: { reference_mode: 'reference', aspect_ratio: '1:1' } });
  assert.deepEqual(ref.requests[0].body.reference_images, [{ url: image }]);
  assert.equal(ref.requests[0].body.model, 'grok-imagine-video-1.5');
  const text = fixture();
  await text.media.generate('video', 'Ocean waves', { options: { model: 'standard', duration: 12, resolution: '1080p' } });
  assert.equal(text.requests[0].body.model, 'grok-imagine-video-1.5');
  assert.equal(text.requests[0].body.resolution, '1080p');
  assert.equal(text.requests[0].body.duration, 12);
});

test('edit and extend use their dedicated endpoints and classic model without generation-only fields', async () => {
  for (const kind of ['edit_video', 'extend_video']) {
    const { media, requests } = fixture();
    const result = await media.generate(kind, 'Continue the shot', { videos: [{ url: video, duration: 5 }],
      options: kind === 'extend_video' ? { duration: 10 } : {} });
    assert.match(requests[0].url, kind === 'edit_video' ? /videos\/edits$/ : /videos\/extensions$/);
    assert.deepEqual(requests[0].body, { model: 'grok-imagine-video', prompt: 'Continue the shot',
      video: { url: video }, ...(kind === 'extend_video' ? { duration: 10 } : {}) });
    assert.equal(result.kind, 'video');
    assert.equal(requests.length, 2);
  }
});

test('invalid or incompatible media options fail before any provider submission', async () => {
  const media = new MediaGenerator({ fetchImpl: async () => assert.fail('must not submit') });
  const cases = [
    ['image', { options: { count: 11 } }], ['image', { options: { count: 1.5 } }],
    ['image', { options: { resolution: '4k' } }], ['image', { options: { quality: 'high' } }],
    ['image', { options: { aspect_ratio: '17:2' } }], ['image', { options: { model: 'other' } }],
    ['edit_image', { images: [image], options: { aspect_ratio: '1:1' } }],
    ['image', { images: [image], options: { aspect_ratio: '9:16' } }],
    ['image', { videos: [video] }], ['image', { options: [] }],
    ['video', { options: { duration: 16 } }], ['video', { options: { resolution: '4k' } }],
    ['video', { options: { aspect_ratio: 'auto' } }], ['video', { options: { model: 'unknown' } }],
    ['video', { images: [image, image], options: { model: 'lite' } }],
    ['video', { images: [image, image], options: { reference_mode: 'animate' } }],
    ['video', { images: [image], options: { aspect_ratio: '1:1' } }],
    ['video', { options: { reference_mode: 'reference' } }],
    ['video', { images: [image, image], options: { resolution: '1080p' } }],
    ['video', { options: { model: 'classic', resolution: '1080p' } }],
    ['video', { images: [image, image], options: { model: 'classic', duration: 11 } }],
    ['video', { videos: [video] }],
    ['edit_video', {}], ['extend_video', { videos: [video, video] }],
    ['edit_video', { videos: ['https://cdn.discordapp.com/source.webm'] }],
    ['edit_video', { videos: [{ url: video, duration: 9 }] }],
    ['extend_video', { videos: [{ url: video, duration: 1 }] }],
    ['extend_video', { videos: [{ url: video, duration: 16 }] }],
    ['edit_video', { videos: [video], options: { duration: 4 } }],
    ['extend_video', { videos: [video], options: { duration: 11 } }],
    ['edit_video', { videos: [video], images: [image] }],
  ];
  for (const [kind, options] of cases) {
    await assert.rejects(media.generate(kind, 'Make the requested change', options), MediaInputError, JSON.stringify([kind, options]));
  }
});

test('media tool schemas expose options and forward them without accepting model-provided URLs', async () => {
  const tools = createTools();
  const definitions = tools.definitions();
  for (const name of ['generate_image', 'edit_image', 'generate_video', 'edit_video', 'extend_video']) {
    assert.ok(definitions.some(tool => tool.name === name && tool.parameters.properties.options));
  }
  const options = { count: 3, resolution: '2k' };
  await tools.execute('generate_image', JSON.stringify({ prompt: 'Three cats', options }), {
    generateMedia: async (kind, prompt, settings) => {
      assert.equal(kind, 'image');
      assert.equal(prompt, 'Three cats');
      assert.deepEqual(settings, { useReference: true, options });
      return { kind, url: image };
    },
  });
  for (const name of ['edit_video', 'extend_video']) {
    await tools.execute(name, '{"prompt":"Change the clip","use_reference":false}', {
      generateMedia: async (_kind, _prompt, settings) => {
        assert.equal(settings.useReference, true);
        return { kind: 'video', url: video };
      },
    });
  }
  await assert.rejects(tools.execute('generate_video', JSON.stringify({ prompt: 'Animate', images: [image] }), {
    generateMedia: async () => assert.fail('must not dispatch'),
  }), /Invalid generation request/);
});
