import test from 'node:test';
import { OWNER_ID } from '../test-support/owner.js';
import assert from 'node:assert/strict';
import { DocumentInputs, DocumentInputError, isDocumentAttachment } from '../src/files.js';
import { withFullMode } from '../src/full-mode.js';

const document = (name = 'notes.txt', extras = {}) => ({
  name, url: `https://cdn.discordapp.com/attachments/1/2/${name}?ex=signature`, size: 4,
  contentType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain', ...extras,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const stream = (chunks, headers = {}) => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close(); },
}), { headers });

test('document detection supports PDF and text/code while excluding other modalities', () => {
  for (const name of ['paper.pdf', 'code.py', 'table.csv', 'index.tsx', 'config.json', 'guide.md']) {
    assert.equal(isDocumentAttachment(document(name, { contentType: 'application/octet-stream' })), true);
  }
  assert.equal(isDocumentAttachment(document('extensionless', { contentType: 'application/json' })), true);
  for (const contentType of ['image/png', 'audio/ogg', 'video/mp4']) {
    assert.equal(isDocumentAttachment(document('spoof.txt', { contentType })), false);
  }
  for (const name of ['app.exe', 'document.docx', 'archive.zip']) {
    assert.equal(isDocumentAttachment(document(name, { contentType: 'application/octet-stream' })), false);
  }
});

test('uploads bytes via multipart with temporary expiry and cleans request-scoped IDs once', async () => {
  const calls = [];
  const client = new DocumentInputs({ apiKey: 'private-test-key', fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('https://cdn.discordapp.com/')) {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers, undefined);
      return new Response('test');
    }
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    if (options.method === 'DELETE') return json({ deleted: true });
    assert.equal(url, 'https://api.x.ai/v1/files');
    assert.equal(options.headers['Content-Type'], undefined);
    assert.equal(options.body.get('purpose'), 'assistants');
    assert.equal(options.body.get('expires_after'), '3600');
    assert.equal(options.body.get('file').name, 'paper.pdf');
    assert.equal(options.body.get('file').type, 'application/pdf');
    assert.equal(await options.body.get('file').text(), 'test');
    return json({ id: 'file_request_one' });
  } });
  const uploaded = await client.upload(new Map([['a', document('paper.pdf')]]));
  assert.deepEqual(uploaded.input, [{ type: 'input_file', file_id: 'file_request_one' }]);
  assert.deepEqual(await uploaded.cleanup(), { deleted: 1, failed: 0 });
  assert.deepEqual(await uploaded.cleanup(), { deleted: 1, failed: 0 });
  assert.equal(calls.filter(call => call.options.method === 'DELETE').length, 1);
});

test('validates all attachment hosts, credentials, counts and declared sizes before any upload', async () => {
  let calls = 0;
  const client = new DocumentInputs({ maxFileBytes: 8, maxTotalBytes: 12,
    fetchImpl: async () => { calls++; throw new Error('No network should run'); } });
  for (const url of ['http://cdn.discordapp.com/a.txt', 'https://example.com/a.txt',
    'https://cdn.discordapp.com.example.com/a.txt', 'https://user:pass@cdn.discordapp.com/a.txt',
    'https://cdn.discordapp.com:444/a.txt', 'file:///tmp/a.txt']) {
    await assert.rejects(client.upload([document(), document('second.txt', { url })]), DocumentInputError);
  }
  await assert.rejects(client.upload(Array.from({ length: 5 }, () => document())), /at most 4/);
  await assert.rejects(client.upload([document('big.txt', { size: 9 })]), /Each document/);
  await assert.rejects(client.upload([document('a.txt', { size: 7 }), document('b.txt', { size: 7 })]), /combined/);
  assert.equal(calls, 0);
});

test('enforces actual streamed file bytes even when declared size and content length lie', async () => {
  let uploads = 0;
  const client = new DocumentInputs({ maxFileBytes: 8, maxTotalBytes: 16, fetchImpl: async (url, options) => {
    if (options?.method === 'POST') uploads++;
    return stream([4, 5], { 'content-length': '1' });
  } });
  await assert.rejects(client.upload([document('big.txt', { size: 1 })]), /size limit/);
  assert.equal(uploads, 0);
});

test('rejects excessive Content-Length before reading a document body', async () => {
  let cancelled = false;
  const client = new DocumentInputs({ maxFileBytes: 8, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '9' } }) });
  await assert.rejects(client.upload([document()]), /size limit/);
  assert.equal(cancelled, true);
});

test('enforces aggregate streamed size and deletes earlier uploads on partial failure', async () => {
  const deleted = [];
  const firstUpload = Promise.withResolvers();
  const client = new DocumentInputs({ maxFileBytes: 8, maxTotalBytes: 10, fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') { deleted.push(url); return json({ deleted: true }); }
    if (options?.method === 'POST') { firstUpload.resolve(); return json({ id: 'file_first' }); }
    if (url.includes('second.txt')) await firstUpload.promise;
    return stream([3, 3]);
  } });
  await assert.rejects(client.upload([document('first.txt', { size: 1 }), document('second.txt', { size: 1 })]), /size limit/);
  assert.deepEqual(deleted, ['https://api.x.ai/v1/files/file_first']);
});

test('provider upload failures clean earlier files and never expose response bodies', async () => {
  let uploads = 0;
  const deleted = [];
  const client = new DocumentInputs({ fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') { deleted.push(url); return json({ deleted: true }); }
    if (options?.method === 'POST') return ++uploads === 1
      ? json({ id: 'file_first' }) : json({ error: 'private body and key' }, 429);
    return new Response('test');
  } });
  await assert.rejects(client.upload([document(), document('second.txt')]), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'document_upload_failed');
    assert.doesNotMatch(error.message, /private body and key/);
    return true;
  });
  assert.equal(deleted.length, 1);
});

test('caller abort interrupts a stalled body and cleanup uses a fresh signal', async () => {
  const controller = new AbortController();
  const firstUpload = Promise.withResolvers();
  let downloads = 0;
  let cancelled = false;
  let cleanupSignal;
  const client = new DocumentInputs({ fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') { cleanupSignal = options.signal; return json({ deleted: true }); }
    if (options?.method === 'POST') { firstUpload.resolve(); return json({ id: 'file_first' }); }
    if (++downloads === 1) return new Response('test');
    await firstUpload.promise;
    queueMicrotask(() => controller.abort(new Error('user cancelled')));
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  } });
  await assert.rejects(client.upload([document(), document('second.txt')], { signal: controller.signal }), /user cancelled/);
  assert.equal(cancelled, true);
  assert.equal(cleanupSignal.aborted, false);
});

for (const fullMode of [false, true]) test(`uploads concurrently with bounded workers and attachment order (full mode: ${fullMode})`, { timeout: 1000 }, async () => {
  const names = ['first.txt', 'second.txt', 'third.txt', 'fourth.txt', ...(fullMode ? ['fifth.txt', 'sixth.txt'] : [])];
  const gates = new Map(names.map(name => [name, Promise.withResolvers()]));
  const initialUploads = Promise.withResolvers();
  const fourthUpload = Promise.withResolvers();
  const started = [];
  let active = 0, peak = 0;
  const client = new DocumentInputs({ ...(fullMode ? { maxFiles: 1, maxTotalBytes: 1 } : {}), fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') return json({ deleted: true });
    if (options?.method !== 'POST') return new Response('test');
    const name = options.body.get('file').name;
    started.push(name);
    peak = Math.max(peak, ++active);
    if (started.length === 3) initialUploads.resolve();
    if (name === 'fourth.txt') fourthUpload.resolve();
    await gates.get(name).promise;
    active--;
    return json({ id: `file_${name.split('.')[0]}` });
  } });
  const pending = withFullMode(OWNER_ID, fullMode, () => client.upload(names.map(name => document(name))));
  try {
    await initialUploads.promise;
    assert.deepEqual(started, names.slice(0, 3));
    gates.get('third.txt').resolve();
    await fourthUpload.promise;
    assert.equal(peak, 3);
  } finally {
    for (const gate of gates.values()) gate.resolve();
  }
  const uploaded = await pending;
  assert.equal(peak, 3);
  assert.deepEqual(uploaded.input.map(file => file.file_id), names.map(name => `file_${name.split('.')[0]}`));
  await uploaded.cleanup();
});

test('concurrent downloads share the actual byte budget despite inaccurate sizes', async () => {
  const uploaded = [], deleted = [];
  const client = new DocumentInputs({ maxFileBytes: 8, maxTotalBytes: 10, fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') { deleted.push(url.split('/').at(-1)); return json({ deleted: true }); }
    if (options?.method === 'POST') {
      const id = `file_${uploaded.length}`;
      uploaded.push(id);
      return json({ id });
    }
    return stream([3, 3], { 'content-length': '1' });
  } });
  await assert.rejects(client.upload([document('first.txt', { size: 1 }), document('second.txt', { size: 1 })]), /size limit/);
  assert.deepEqual(deleted.sort(), uploaded.sort());
});

test('rollback waits for late successful uploads and never starts queued documents after failure', { timeout: 1000 }, async () => {
  const allStarted = Promise.withResolvers();
  const releaseLateUploads = Promise.withResolvers();
  const failureReturned = Promise.withResolvers();
  const uploaded = [], deleted = [], downloaded = [];
  const client = new DocumentInputs({ fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') { deleted.push(url.split('/').at(-1)); return json({ deleted: true }); }
    if (options?.method !== 'POST') { downloaded.push(url); return new Response('test'); }
    const name = options.body.get('file').name;
    uploaded.push(name);
    if (uploaded.length === 3) allStarted.resolve();
    await allStarted.promise;
    if (name === 'first.txt') { failureReturned.resolve(); return json({ private: 'provider body' }, 429); }
    // Simulate a provider that finishes an upload even after its signal aborts.
    await releaseLateUploads.promise;
    return json({ id: `file_${name.split('.')[0]}` });
  } });
  let settled = false;
  const pending = client.upload(['first.txt', 'second.txt', 'third.txt', 'fourth.txt'].map(name => document(name)));
  const checked = assert.rejects(pending, error => error.status === 429 && error.code === 'document_upload_failed');
  pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await failureReturned.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(deleted, []);
    assert.equal(downloaded.length, 3);
  } finally { releaseLateUploads.resolve(); }
  await checked;
  assert.deepEqual(deleted.sort(), ['file_second', 'file_third']);
});

test('total deadline aborts a stalled download', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const client = new DocumentInputs({ timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream()) });
    await assert.rejects(client.upload([document()]), error => error.name === 'TimeoutError');
  } finally { clearInterval(keepAlive); }
});

test('empty and non-document attachments make no provider calls', async () => {
  const client = new DocumentInputs({ fetchImpl: async () => { throw new Error('Unexpected fetch'); } });
  const result = await client.upload([document('photo.png', { contentType: 'image/png' })]);
  assert.deepEqual(result.input, []);
  assert.deepEqual(await result.cleanup(), { deleted: 0, failed: 0 });
});

test('accepts both file ID prefixes shown in the provider documentation', async () => {
  for (const id of ['file-abc123', 'file_a128090d-f0c9-4873-bd84-e499777e7417']) {
    const deleted = [];
    const client = new DocumentInputs({ fetchImpl: async (url, options) => {
      if (options?.method === 'DELETE') { deleted.push(url); return json({ deleted: true }); }
      return options?.method === 'POST' ? json({ id }) : new Response('test');
    } });
    const uploaded = await client.upload([document()]);
    assert.deepEqual(uploaded.input, [{ type: 'input_file', file_id: id }]);
    await uploaded.cleanup();
    assert.deepEqual(deleted, [`https://api.x.ai/v1/files/${id}`]);
  }
});

test('failed rollback reports only a count, preserves upload error and leaves TTL backstop', async () => {
  let uploads = 0;
  const failures = [];
  const client = new DocumentInputs({ onCleanupFailure: count => { failures.push(count); throw new Error('broken logger'); },
    fetchImpl: async (url, options) => {
      if (options?.method === 'DELETE') return json({ private: 'not for logs' }, 503);
      if (options?.method === 'POST') {
        assert.equal(options.body.get('expires_after'), '3600');
        return ++uploads === 1 ? json({ id: 'file_first' }) : json({}, 429);
      }
      return new Response('test');
    },
  });
  await assert.rejects(client.upload([document(), document('second.txt')]), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'document_upload_failed');
    return true;
  });
  assert.deepEqual(failures, [1]);
});

test('cleanup failure callback runs once even when cleanup is called repeatedly', async () => {
  const failures = [];
  const client = new DocumentInputs({ onCleanupFailure: count => { failures.push(count); }, fetchImpl: async (url, options) => {
    if (options?.method === 'DELETE') throw new Error('temporary network failure');
    return options?.method === 'POST' ? json({ id: 'file_one' }) : new Response('test');
  } });
  const uploaded = await client.upload([document()]);
  assert.deepEqual(await uploaded.cleanup(), { deleted: 0, failed: 1 });
  assert.deepEqual(await uploaded.cleanup(), { deleted: 0, failed: 1 });
  assert.deepEqual(failures, [1]);
});
