import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaGenerator, mediaReply } from '../src/media.js';
import { AICore, ProviderError } from '../src/ai.js';

const response = body => ({ ok: true, json: async () => body });
test('images pin medium quality, 1K, and one output; Discord displays the result', async () => {
  const media = new MediaGenerator({ authorize: async () => true, apiKey: 'test', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.x.ai/v1/images/generations');
    assert.deepEqual(JSON.parse(options.body), { model: 'grok-imagine-image-2.0', prompt: 'A cat',
      n: 1, quality: 'medium', resolution: '1k', response_format: 'url' });
    return response({ data: [{ url: 'https://imgen.x.ai/cat.jpg' }] });
  } });
  const result = await media.generate('image', 'A cat');
  assert.equal(mediaReply(result).embeds[0].image.url, result.url);
});
test('videos submit once then poll to completion with a shared deadline', async () => {
  const requests = [];
  let sleeps = 0;
  const media = new MediaGenerator({ authorize: async () => true, apiKey: 'test', sleep: async () => { sleeps++; },
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      if (requests.length === 1) return response({ request_id: 'job-1' });
      if (requests.length === 2) return response({ status: 'pending' });
      return response({ status: 'done', video: { url: 'https://vidgen.x.ai/cat.mp4', respect_moderation: true } });
    } });
  const result = await media.generate('video', 'A running cat');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.resolution, '720p');
  assert.equal(body.duration, 6);
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].url, 'https://api.x.ai/v1/videos/job-1');
  assert.equal(requests[0].signal, requests[2].signal);
  assert.equal(sleeps, 1);
  assert.match(mediaReply(result).content, /https:\/\/vidgen.x.ai\/cat.mp4/);
});
test('failed, moderated, missing, and unsafe results are rejected', async () => {
  for (const body of [ { status: 'failed' }, { status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', respect_moderation: false } },
    { status: 'done' }, { status: 'done', video: { url: 'file:///secret' } } ]) {
    let calls = 0;
    const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async () => response(++calls === 1 ? { request_id: 'job' } : body) });
    await assert.rejects(media.generate('video', 'test'));
    assert.equal(calls, 2);
  }
  const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async () => response({ data: [] }) });
  await assert.rejects(media.generate('image', 'test'), ProviderError);
});
test('invalid prompts never call the provider and HTTP errors do not reveal bodies', async () => {
  let calls = 0;
  const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async () => { calls++; return { ok: false, status: 429,
    json: async () => ({ error: 'secret' }) }; } });
  for (const [kind, prompt] of [['image', ' '], ['video', 'x'.repeat(6001)], ['unknown', 'test']]) {
    await assert.rejects(media.generate(kind, prompt));
  }
  assert.equal(calls, 0);
  await assert.rejects(media.generate('image', 'cat'), error => error.status === 429 && !error.message.includes('secret'));
  assert.equal(calls, 1);
});
test('pending video stops at deadline without submitting another paid job', async () => {
  let submissions = 0;
  const media = new MediaGenerator({ authorize: async () => true, timeoutMs: 20, pollIntervalMs: 1000,
    fetchImpl: async (url, options) => {
      if (options.method === 'POST') { submissions++; return response({ request_id: 'job' }); }
      return response({ status: 'pending' });
    } });
  await assert.rejects(media.generate('video', 'cat'), { name: 'AbortError' });
  assert.equal(submissions, 1);
});
test('chat generation returns media immediately and executes only one requested generation', async () => {
  let generations = 0;
  let requests = 0;
  const ai = new AICore({ apiKey: 'test', fetchImpl: async () => {
    requests++;
    return response({ output: ['image', 'video'].map(kind => ({ type: 'function_call',
      name: `generate_${kind}`, arguments: '{"prompt":"cat"}', call_id: kind })) });
  } });
  const result = await ai.respond({ input: 'Draw a cat', context: {
    generateMedia: async kind => { generations++; return { kind, url: 'https://imgen.x.ai/cat.jpg' }; },
  } });
  assert.equal(result.media.kind, 'image');
  assert.equal(generations, 1);
  assert.equal(requests, 1);
});
test('chat media failure propagates without a second submission or model retry', async () => {
  let requests = 0;
  const ai = new AICore({ apiKey: 'test', fetchImpl: async () => {
    requests++;
    return response({ output: [{ type: 'function_call', name: 'generate_video',
      arguments: '{"prompt":"cat"}', call_id: 'video' }] });
  } });
  await assert.rejects(ai.respond({ input: 'Make a cat video', context: {
    generateMedia: async () => { throw new ProviderError(429, 'media_provider_error'); },
  } }), error => error.status === 429);
  assert.equal(requests, 1);
});

test('single reference uses the JSON image edits endpoint at medium quality', async () => {
  const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.x.ai/v1/images/edits');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.image, { url: 'https://cdn.discordapp.com/photo.png', type: 'image_url' });
    assert.equal(body.quality, 'medium');
    assert.equal(body.resolution, '1k');
    assert.equal(body.images, undefined);
    return response({ data: [{ url: 'https://imgen.x.ai/edited.png' }] });
  } });
  const result = await media.generate('edit_image', 'Make the background blue', { images: ['https://cdn.discordapp.com/photo.png'] });
  assert.equal(result.kind, 'image');
  assert.equal(result.url, 'https://imgen.x.ai/edited.png');
});
test('multiple references use images rather than image, including reference-guided generation', async () => {
  const images = ['https://cdn.discordapp.com/a.jpg', 'https://cdn.discordapp.com/b.png'];
  const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async (url, options) => {
    assert.match(url, /images\/edits$/);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.images, images.map(url => ({ url, type: 'image_url' })));
    assert.equal(body.image, undefined);
    return response({ data: [{ url: 'https://imgen.x.ai/combined.jpg' }] });
  } });
  await media.generate('image', 'Use the first subject with the style of the second', { images });
});
test('missing or unsupported edit sources fail before provider submission', async () => {
  const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async () => assert.fail('must not submit') });
  await assert.rejects(media.generate('edit_image', 'Make it blue'), /Attach an image/);
  await assert.rejects(media.generate('edit_image', 'Make it blue', { images: ['https://cdn.discordapp.com/a.gif?x=1'] }), /instead of a GIF/);
  await assert.rejects(media.generate('edit_image', 'Make it blue', { images: Array(6).fill('https://example.com/a.png') }), /at most five/);
});
test('video animation receives the first supplied image while retaining 720p', async () => {
  const media = new MediaGenerator({ authorize: async () => true, fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.image, { url: 'https://cdn.discordapp.com/cat.png', type: 'image_url' });
      assert.equal(body.resolution, '720p');
      return response({ request_id: 'job' });
    }
    return response({ status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4' } });
  } });
  await media.generate('video', 'Make the cat blink', { images: ['https://cdn.discordapp.com/cat.png'] });
});
test('chat can see the source and selects edit_image without exposing URLs as tool arguments', async () => {
  const images = ['https://cdn.discordapp.com/cat.png'];
  const ai = new AICore({ apiKey: 'test', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.input.at(-1).content[1].image_url, images[0]);
    assert.ok(body.tools.some(t => t.name === 'edit_image'));
    assert.match(body.instructions, /ask what they want changed/);
    return response({ output: [{ type: 'function_call', name: 'edit_image', call_id: 'edit',
      arguments: '{"prompt":"Make the cat orange"}' }] });
  } });
  const result = await ai.respond({ input: [{ type: 'input_text', text: 'Make the cat orange' },
    { type: 'input_image', image_url: images[0] }], context: {
    generateMedia: async (kind, prompt, options) => {
      assert.equal(kind, 'edit_image');
      assert.equal(options.useReference, true);
      return { kind: 'image', url: 'https://imgen.x.ai/orange.png' };
    },
  } });
  assert.equal(result.media.url, 'https://imgen.x.ai/orange.png');
});
test('unrelated text-only creation can explicitly ignore reference images', async () => {
  const ai = new AICore({ fetchImpl: async () => response({ output: [{ type: 'function_call',
    name: 'generate_image', call_id: 'new', arguments: '{"prompt":"A mountain","use_reference":false}' }] }) });
  await ai.respond({ input: 'Create an unrelated mountain image', context: {
    generateMedia: async (kind, prompt, options) => {
      assert.equal(options.useReference, false);
      return { kind, url: 'https://imgen.x.ai/mountain.png' };
    },
  } });
});
