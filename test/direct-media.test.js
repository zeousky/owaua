import test from 'node:test';
import assert from 'node:assert/strict';
import { AICore } from '../src/ai.js';
import { MediaGenerator } from '../src/media.js';

const response = body => ({ ok: true, json: async () => body });

test('explicit media requests dispatch and deliver without a confirmation callback or second AI turn', async () => {
  for (const kind of ['image', 'edit_image', 'video', 'edit_video', 'extend_video']) {
    let aiCalls = 0;
    const submissions = [];
    const media = new MediaGenerator({ fetchImpl: async (url, request) => {
      if (request.method === 'POST') {
        submissions.push({ url, body: JSON.parse(request.body) });
        return response(kind.includes('image')
          ? { data: [{ url: 'https://example.com/result.png' }] }
          : { request_id: 'job' });
      }
      return response({ status: 'done', video: { url: 'https://example.com/result.mp4' } });
    } });
    const ai = new AICore({ fetchImpl: async (_, request) => {
      aiCalls++;
      const body = JSON.parse(request.body);
      assert.match(body.instructions, /call the appropriate tool immediately/);
      assert.match(body.instructions, /Do not show a proposed prompt or settings for approval/);
      assert.match(body.instructions, /even if older conversation history mentions a confirmation step/);
      return response({ output: [{ type: 'function_call',
        name: ['image', 'video'].includes(kind) ? `generate_${kind}` : kind,
        call_id: 'create', arguments: JSON.stringify({ prompt: 'A cat under blue light' }) }] });
    } });
    const result = await ai.respond({ input: 'Create a cat under blue light', history: [
      { role: 'user', content: 'Create a cat' },
      { role: 'assistant', content: 'Please confirm the prompt and settings first.' },
    ], context: { generateMedia: (type, prompt, { options }) => media.generate(type, prompt, {
      options,
      images: kind === 'edit_image' ? ['https://example.com/source.png'] : [],
      videos: kind.includes('_video') ? ['https://example.com/source.mp4'] : [],
    }) } });
    assert.equal(aiCalls, 1, kind);
    assert.equal(submissions.length, 1, kind);
    assert.equal(submissions[0].body.prompt, 'A cat under blue light');
    assert.equal(result.media.kind, kind.includes('image') ? 'image' : 'video');
    if (kind.includes('image')) {
      assert.equal(submissions[0].body.n, 1);
      assert.equal(submissions[0].body.quality, 'medium');
      assert.equal(submissions[0].body.resolution, '1k');
    }
    if (kind === 'video') {
      assert.equal(submissions[0].body.duration, 6);
      assert.equal(submissions[0].body.resolution, '720p');
    }
  }
});

test('direct media submission still stops before the provider when already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const media = new MediaGenerator({ fetchImpl: async () => assert.fail('no provider calls') });
  await assert.rejects(media.generate('image', 'A cat', { signal: controller.signal }), { name: 'AbortError' });
});
