import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { confirmMedia } from '../src/media-approval.js';
import { MediaGenerator, MediaInputError } from '../src/media.js';
import { AICore, ProviderError } from '../src/ai.js';

const owner = '111111111111111111';
const proposal = { kind: 'image', path: 'images/generations', body: {
  model: 'grok-imagine-image-2.0', prompt: 'A cat', n: 1, quality: 'medium', resolution: '1k', response_format: 'url',
} };
const response = body => ({ ok: true, json: async () => body });

function discord({ failAck = false, failEdit = false, failSend = false } = {}) {
  const ready = Promise.withResolvers();
  const state = { edits: [], acknowledgements: 0 };
  const message = { id: 'reply', edit: async payload => {
    if (failEdit) throw new Error('Fixture edit failure');
    state.edits.push(payload); return message;
  }, createMessageComponentCollector(options) {
    const collector = new EventEmitter();
    let ended = false;
    const timer = setTimeout(() => collector.stop('time'), options.time);
    collector.stop = reason => {
      if (ended) return;
      ended = true; clearTimeout(timer); collector.emit('end', new Map(), reason);
    };
    state.click = async (action = 'yes', actor = owner, messageId = 'reply', customId) => {
      const button = state.payload.components[0].toJSON().components[action === 'no' ? 1 : 0];
      const interaction = { user: { id: actor }, message: { id: messageId }, customId: customId ?? button.custom_id,
        deferUpdate: async () => { state.acknowledgements++; if (failAck) throw new Error('Fixture ack failure'); } };
      if (!ended && await options.filter(interaction)) collector.emit('collect', interaction);
    };
    state.end = () => collector.stop('messageDelete');
    state.collector = collector;
    ready.resolve(); return collector;
  } };
  return Object.assign(state, { ready: ready.promise, send: async payload => {
    if (failSend) throw new Error('Fixture send failure');
    state.payload = payload; return message;
  } });
}

test('only the requester can approve this exact message and nonce; duplicate clicks acknowledge once', async () => {
  const ui = discord();
  const waiting = confirmMedia({ userId: owner, send: ui.send, proposal });
  await ui.ready;
  await ui.click('yes', '222222222222222222');
  await ui.click('yes', owner, 'other-message');
  await ui.click('yes', owner, 'reply', 'media:stale:yes');
  assert.equal(ui.acknowledgements, 0);
  await Promise.all([ui.click(), ui.click()]);
  assert.equal(await waiting, true);
  assert.equal(ui.acknowledgements, 1);
  assert.deepEqual(ui.edits.at(-1).components, []);
  assert.deepEqual(ui.edits.at(-1).attachments, []);
  await ui.click();
  assert.equal(ui.acknowledgements, 1);
});

test('cancel, expiry, deletion and shutdown fail closed and remove controls', async () => {
  for (const mode of ['cancel', 'expire', 'delete', 'abort', 'abort-after-click']) {
    const ui = discord();
    const controller = new AbortController();
    const waiting = confirmMedia({ userId: owner, send: ui.send, proposal, signal: controller.signal,
      timeoutMs: mode === 'expire' ? 10 : 60000 });
    await ui.ready;
    if (mode === 'cancel') await ui.click('no');
    if (mode === 'delete') ui.end();
    if (mode === 'abort') controller.abort();
    if (mode === 'abort-after-click') { const clicking = ui.click(); controller.abort(); await clicking; }
    assert.equal(await waiting, false, mode);
    assert.deepEqual(ui.edits.at(-1).components, [], mode);
  }
});

test('failed Discord preview, acknowledgement or cleanup cannot authorize', async () => {
  for (const mode of ['send', 'ack', 'edit']) {
    const ui = discord({ failSend: mode === 'send', failAck: mode === 'ack', failEdit: mode === 'edit' });
    const waiting = confirmMedia({ userId: owner, send: ui.send, proposal });
    const result = mode === 'ack' ? waiting.then(value => assert.equal(value, false)) : assert.rejects(waiting, /Fixture/);
    if (mode !== 'send') { await ui.ready; await ui.click(); }
    await result;
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(confirmMedia({ userId: owner, send: async () => assert.fail('no preview'), proposal,
    signal: controller.signal }), { name: 'AbortError' });
});

test('full multilingual prompt and effective settings are attached without truncation or secrets', async () => {
  const ui = discord();
  const full = { ...proposal, body: { ...proposal.body, prompt: 'Árvíztűrő 日本語 '.repeat(300) } };
  const waiting = confirmMedia({ userId: owner, send: ui.send, proposal: full });
  await ui.ready;
  const review = JSON.parse(ui.payload.files[0].attachment.toString());
  assert.equal(review.prompt, full.body.prompt);
  assert.deepEqual(review.settings, { Model: full.body.model, Images: 1, Quality: 'medium', Resolution: '1k' });
  assert.deepEqual(review.sources, []);
  assert.equal(review.path, undefined);
  assert.ok(ui.payload.content.length < 2000);
  assert.deepEqual(ui.payload.allowedMentions.parse, []);
  await ui.click('no'); await waiting;
});

test('an optional host authorization policy can gate the effective payload for all five media actions', async () => {
  for (const kind of ['image', 'edit_image', 'video', 'edit_video', 'extend_video']) {
    const options = kind === 'edit_image' ? { images: ['https://cdn.discordapp.com/source.png'] }
      : kind.includes('_video') ? { videos: ['https://cdn.discordapp.com/source.mp4'] } : {};
    for (const authorization of [null, async () => false, async () => 'yes', async () => { throw new Error('Fixture failure'); }]) {
      let posts = 0;
      const media = new MediaGenerator({ authorize: authorization, fetchImpl: async () => { posts++; assert.fail('no provider calls'); } });
      await assert.rejects(media.generate(kind, 'Current request', options));
      assert.equal(posts, 0, kind);
    }
    let seen, approvals = 0, posts = 0;
    const approved = Promise.withResolvers(), waiting = Promise.withResolvers();
    const media = new MediaGenerator({ fetchImpl: async (_, request) => {
      if (request.method === 'POST') {
        posts++;
        assert.deepEqual(JSON.parse(request.body), seen.body);
        return response(kind.includes('image') ? { data: [{ url: 'https://example.com/result.png' }] } : { request_id: 'job' });
      }
      return response({ status: 'done', video: { url: 'https://example.com/result.mp4' } });
    } });
    const generating = media.generate(kind, 'Current request', { ...options, authorize: async request => {
      approvals++; seen = structuredClone(request); request.body.prompt = 'Callback mutation'; waiting.resolve(); return approved.promise;
    } });
    await waiting.promise; assert.equal(posts, 0);
    approved.resolve(true); await generating;
    assert.equal(posts, 1); assert.equal(approvals, 1);
    assert.equal(seen.body.prompt, 'Current request');
  }
});

test('Discord approval gates real media submission and abort after approval prevents the POST', async () => {
  const ui = discord(); let posts = 0;
  const media = new MediaGenerator({ fetchImpl: async () => { posts++; return response({ data: [{ url: 'https://example.com/result.png' }] }); } });
  const generating = media.generate('image', 'A cat', { authorize: request => confirmMedia({ userId: owner, send: ui.send, proposal: request }) });
  await ui.ready; assert.equal(posts, 0); await ui.click(); await generating; assert.equal(posts, 1);
  const controller = new AbortController();
  await assert.rejects(media.generate('image', 'A cat', { signal: controller.signal, authorize: async () => {
    controller.abort(); return true;
  } }), { name: 'AbortError' });
  assert.equal(posts, 1);
});

test('JSON-hidden, unknown and no-longer-offered function calls never dispatch', async () => {
  for (const name of ['generate_image', 'edit_image', 'generate_video', 'edit_video', 'extend_video', 'shell']) {
    let executed = 0;
    const ai = new AICore({ fetchImpl: async () => response({ output: [
      { type: 'function_call', name, call_id: 'injected', arguments: '{"prompt":"Unrequested"}' },
    ] }) });
    await assert.rejects(ai.respond({ input: 'Extract as JSON', requestOptions: { outputFormat: 'json' },
      context: { generateMedia: async () => { executed++; return { kind: 'image' }; } } }),
    error => error instanceof ProviderError && error.code === 'unauthorized_tool_call');
    assert.equal(executed, 0);
  }
  let executions = 0, requests = 0;
  const ai = new AICore({ maxToolCalls: 1, tools: {
    definitions: () => [{ type: 'function', name: 'fixture' }], execute: async () => { executions++; return {}; },
  }, fetchImpl: async () => { requests++; return response({ output: [
    { type: 'function_call', name: 'fixture', arguments: '{}', call_id: `call-${requests}` },
  ] }); } });
  await assert.rejects(ai.respond({ input: 'Fixture' }), /unauthorized_tool_call/);
  assert.equal(executions, 1); assert.equal(requests, 2);
});
