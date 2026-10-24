import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLibrary, KnowledgeError, knowledgeFilename } from '../src/knowledge.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const attachment = (name = 'guide.txt', extras = {}) => ({ name, contentType: 'text/plain', size: 5,
  url: `https://cdn.discordapp.com/attachments/111/222/${encodeURIComponent(name)}`, ...extras });

function setup(t, settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-knowledge-'));
  let id = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (options.method === 'DELETE') return json({ deleted: true });
    if (url.endsWith('/files')) return json({ id: `file_${++id}`, expires_at: null });
    throw new Error('Unexpected request');
  };
  const library = new KnowledgeLibrary({ directory, apiKey: 'infer-test-key', fetchImpl, ...settings });
  t.after(async () => { await library.close(); rmSync(directory, { recursive: true, force: true }); });
  return { library, calls, directory };
}

test('permanent Files uploads persist across restart without content or provider IDs in listings', async t => {
  const { library, calls, directory } = setup(t);
  const saved = await library.add('guild:channel:alice', attachment('../unsafe@name.txt'));
  assert.equal(saved.filename, 'unsafe_name.txt');
  assert.equal(saved.bytes, 5);
  const upload = calls.find(call => call.method === 'POST');
  assert.equal(upload.url, 'https://api.x.ai/v1/files');
  assert.equal(upload.redirect, 'error');
  assert.equal(upload.headers.Authorization, 'Bearer infer-test-key');
  assert.equal(upload.body.get('expires_after'), null);
  assert.equal(upload.body.get('purpose'), 'assistants');
  assert.equal(await upload.body.get('file').text(), 'hello');
  assert.equal(calls[0].headers, undefined);
  assert.equal(library.list('guild:channel:alice')[0].file_id, undefined);
  await library.close();
  const reopened = new KnowledgeLibrary({ directory, apiKey: 'infer-test-key', fetchImpl: () => { throw new Error('Should not fetch'); } });
  try {
    const context = await reopened.context('guild:channel:alice', 'guide');
    assert.deepEqual(context.input, [{ type: 'input_file', file_id: 'file_1' }]);
    assert.equal(context.total, 1);
    assert.equal(context.collectionMode, false);
    assert.deepEqual(await reopened.context('guild:other:alice', 'guide'), { input: [], tools: [], names: [], total: 0, selected: 0, indexing: 0, collectionMode: false });
  } finally { await reopened.close(); }
});

test('library ownership isolates list, context, deletion and clear across users/channels/DMs', async t => {
  const { library, calls } = setup(t);
  const alice = await library.add('g:c:alice', attachment('alice.txt'));
  const bob = await library.add('g:c:bob', attachment('bob.txt'));
  await library.add('dm:c:alice', attachment('dm.txt'));
  assert.equal(await library.forget('g:c:alice', bob.id), false);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  assert.deepEqual((await library.context('g:c:alice')).names, ['alice.txt']);
  assert.deepEqual(await library.clear('g:c:alice'), { deleted: 1, failed: 0 });
  assert.equal(library.list('g:c:alice').length, 0);
  assert.equal(library.list('g:c:bob')[0].id, bob.id);
  assert.equal(library.list('dm:c:alice').length, 1);
  assert.equal(await library.forget('g:c:alice', alice.id), false);
});

test('rejects untrusted hosts, redirects, unsupported files and oversized declared bodies before upload', async t => {
  const { library, calls } = setup(t, { maxFileBytes: 8 });
  for (const url of ['https://example.com/a.txt', 'http://cdn.discordapp.com/attachments/1/2/a.txt',
    'https://cdn.discordapp.com:444/attachments/1/2/a.txt', 'https://u:p@cdn.discordapp.com/attachments/1/2/a.txt',
    'https://cdn.discordapp.com/no-attachment.txt', 'file:///tmp/secret.txt']) {
    await assert.rejects(library.add('scope', attachment('a.txt', { url })), KnowledgeError);
  }
  await assert.rejects(library.add('scope', attachment('movie.mp4', { contentType: 'video/mp4' })), KnowledgeError);
  await assert.rejects(library.add('scope', attachment('a.txt', { size: 9 })), /20 MiB/);
  assert.equal(calls.length, 0);
});

test('streamed upload limits hold when attachment metadata and Content-Length lie', async t => {
  let uploaded = false, cancelled = false;
  const { library } = setup(t, { maxFileBytes: 8, fetchImpl: async (url, options) => {
    if (options.method === 'POST') uploaded = true;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } }), { headers: { 'content-length': '1' } });
  } });
  await assert.rejects(library.add('scope', attachment('a.txt', { size: 1 })), /20 MiB/);
  assert.equal(uploaded, false);
  assert.equal(cancelled, true);
  assert.deepEqual(library.list('scope'), []);
});

test('hanging document reads abort within the deadline and do not save or upload', async t => {
  let cancelled = false;
  const { library } = setup(t, { timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(library.add('scope', attachment()), error => error.name === 'TimeoutError'); }
  finally { clearTimeout(keepAlive); }
  assert.equal(cancelled, true);
  assert.equal(library.list('scope').length, 0);
});

test('refuses expiring provider originals and reports failed rollback only as a count', async t => {
  const cleanup = [];
  const { library } = setup(t, { onCleanupFailure: count => cleanup.push(count), fetchImpl: async (url, options = {}) => {
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (options.method === 'POST') return json({ id: 'file_expiring', expires_at: 12345 });
    return json({ error: 'secret-provider-payload' }, 500);
  } });
  await assert.rejects(library.add('scope', attachment()), /expiring file/);
  assert.deepEqual(library.list('scope'), []);
  assert.deepEqual(cleanup, [1]);
});

test('concurrent adds serialize before the per-scope cap and shutdown drains accepted operations', async t => {
  const { library } = setup(t, { maxDocuments: 1 });
  const first = library.add('scope', attachment('first.txt'));
  const second = library.add('scope', attachment('second.txt'));
  assert.equal(library.isActive('scope'), true);
  const closing = library.close();
  assert.throws(() => library.add('scope', attachment('third.txt')), /restarting/);
  await first;
  await assert.rejects(second, /full/);
  await closing;
  assert.equal(library.isActive('scope'), false);
  await library.close();
});

test('failed deletions keep owned metadata for retry and clear reports partial progress honestly', async t => {
  let failure = true, id = 0;
  const { library } = setup(t, { fetchImpl: async (url, options = {}) => {
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (options.method === 'POST') return json({ id: `file_${++id}` });
    if (failure && url.endsWith('/file_1')) return json({ error: 'denied' }, 403);
    return json({ deleted: true });
  } });
  await library.add('scope', attachment('first.txt'));
  await library.add('scope', attachment('second.txt'));
  assert.deepEqual(await library.clear('scope'), { deleted: 1, failed: 1 });
  assert.deepEqual(library.list('scope').map(row => row.filename), ['first.txt']);
  failure = false;
  assert.deepEqual(await library.clear('scope'), { deleted: 1, failed: 0 });
  assert.equal(library.list('scope').length, 0);
});

test('fallback selects filename matches before newer documents and enforces file/count budgets', async t => {
  const { library } = setup(t, { maxInputFiles: 2, maxInputBytes: 10 });
  await library.add('scope', attachment('deployment-guide.txt'));
  await library.add('scope', attachment('other.txt'));
  await library.add('scope', attachment('recent.txt'));
  const context = await library.context('scope', 'deployment');
  assert.deepEqual(context.names, ['deployment-guide.txt', 'recent.txt']);
  assert.equal(context.total, 3);
  assert.equal(context.selected, 2);
});

test('all capped library documents remain available and the total byte budget resists lying metadata', async t => {
  const { library, calls } = setup(t, { maxLibraryBytes: 15 });
  for (const name of ['one.txt', 'two.txt', 'three.txt']) await library.add('scope', attachment(name));
  const context = await library.context('scope', 'unrelated question');
  assert.equal(context.input.length, 3);
  assert.equal(context.selected, context.total);
  const uploads = () => calls.filter(call => call.method === 'POST').length;
  await assert.rejects(library.add('scope', attachment('over.txt')), /40 MiB in total/);
  assert.equal(uploads(), 3);
  await assert.rejects(library.add('scope', attachment('over.txt', { size: 0 })), /40 MiB in total/);
  assert.equal(uploads(), 3);
  assert.equal(library.list('scope').length, 3);
});

test('native Collections uses isolated hashed scope, authenticated management transport and status gate', async t => {
  const calls = [];
  let processed = false;
  const { library } = setup(t, { managementApiKey: 'management-test-key', fetchImpl: async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (url === 'https://api.x.ai/v1/files') return json({ id: 'file_saved' });
    if (url.endsWith('/collections')) {
      assert.equal(options.headers.Authorization, 'Bearer management-test-key');
      assert.doesNotMatch(options.body, /alice|channel/);
      return json({ collection_id: 'collection_private' });
    }
    if (options.method === 'DELETE') return json({});
    if (options.method === 'POST') return json({ status: 'DOCUMENT_STATUS_PROCESSING' });
    return json({ status: processed ? 'DOCUMENT_STATUS_PROCESSED' : 'DOCUMENT_STATUS_PROCESSING' });
  } });
  const saved = await library.add('guild:channel:alice', attachment());
  assert.equal(saved.index_status, 'processing');
  const pending = await library.context('guild:channel:alice');
  assert.deepEqual(pending.input, [{ type: 'input_file', file_id: 'file_saved' }]);
  assert.deepEqual(pending.tools, []);
  processed = true;
  const ready = await library.context('guild:channel:alice');
  assert.equal(ready.collectionMode, true);
  assert.deepEqual(ready.input, []);
  assert.deepEqual(ready.tools, [{ type: 'file_search', vector_store_ids: ['collection_private'] }]);
  assert.deepEqual((await library.context('guild:channel:bob')).tools, []);
  assert.equal(await library.forget('guild:channel:alice', saved.id), true);
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.url), [
    'https://management-api.x.ai/v1/collections/collection_private/documents/file_saved', 'https://api.x.ai/v1/files/file_saved',
  ]);
});

test('collection permission failure retains a usable permanent Files library and retries later', async t => {
  const { library } = setup(t, { managementApiKey: 'unprivileged', fetchImpl: async (url, options = {}) => {
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (url.endsWith('/files')) return json({ id: 'file_saved' });
    return json({ error: 'secret rejected token' }, 403);
  } });
  const saved = await library.add('scope', attachment());
  assert.equal(saved.index_status, 'index_error');
  const context = await library.context('scope');
  assert.deepEqual(context.input, [{ type: 'input_file', file_id: 'file_saved' }]);
  assert.deepEqual(context.tools, []);
});

test('collection metadata recovery never reattaches an already accepted document after a transient failure', async t => {
  let attached = 0, reads = 0;
  const { library } = setup(t, { managementApiKey: 'management-test-key', fetchImpl: async (url, options = {}) => {
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (url.endsWith('/files')) return json({ id: 'file_saved' });
    if (url.endsWith('/collections')) return json({ collection_id: 'collection_private' });
    if (options.method === 'POST') { attached++; return json({}); }
    if (++reads === 1) return json({ error: 'Temporary metadata outage' }, 503);
    return json({ status: 'DOCUMENT_STATUS_PROCESSED' });
  } });
  const saved = await library.add('scope', attachment());
  assert.equal(saved.index_status, 'processing');
  const context = await library.context('scope');
  assert.equal(context.collectionMode, true);
  assert.equal(attached, 1);
  assert.equal(reads, 2);
  assert.equal(library.list('scope')[0].index_status, 'ready');
});

test('ambiguous collection attach failure checks metadata before retrying its POST', async t => {
  let attached = 0, reads = 0;
  const { library } = setup(t, { managementApiKey: 'management-test-key', fetchImpl: async (url, options = {}) => {
    if (url.startsWith('https://cdn.discordapp.com/')) return new Response('hello');
    if (url.endsWith('/files')) return json({ id: 'file_saved' });
    if (url.endsWith('/collections')) return json({ collection_id: 'collection_private' });
    if (options.method === 'POST') { attached++; throw new TypeError('Connection closed after provider accepted the document'); }
    reads++;
    return json({ status: 'DOCUMENT_STATUS_PROCESSED' });
  } });
  const saved = await library.add('scope', attachment());
  assert.equal(saved.index_status, 'index_error');
  const context = await library.context('scope');
  assert.equal(context.collectionMode, true);
  assert.equal(attached, 1);
  assert.equal(reads, 1);
});

test('filename sanitization bounds hostile and bidirectional names', () => {
  assert.equal(knowledgeFilename('../../@everyone\u202e*private*.txt'), '_everyone_private_.txt');
  assert.ok(knowledgeFilename('a'.repeat(1000)).length <= 120);
  assert.equal(knowledgeFilename(''), 'document.txt');
});
