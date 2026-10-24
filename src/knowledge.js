import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDocumentAttachment } from './files.js';
import { ProviderError } from './ai.js';

const MiB = 1024 * 1024;
const FILE_ID = /^file[-_][A-Za-z0-9_-]{1,200}$/;
const COLLECTION_ID = /^collection[-_][A-Za-z0-9_-]{1,200}$/;
const HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
export class KnowledgeError extends Error {}

export function knowledgeFilename(value) {
  return String(value ?? '').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120).trim() || 'document.txt';
}

function validScope(scope) {
  if (typeof scope !== 'string' || !scope.length || scope.length > 200 || /[\x00-\x1f]/.test(scope)) throw new KnowledgeError('Invalid knowledge library scope.');
  return scope;
}

function attachmentUrl(attachment) {
  let url;
  try { url = new URL(attachment?.url); } catch { throw new KnowledgeError('Attach a PDF, text, or code document directly to Discord.'); }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password ||
      (url.port && url.port !== '443') || !/^\/attachments\/\d+\/\d+\/[^/]+$/.test(url.pathname)) {
    throw new KnowledgeError('Attach a PDF, text, or code document directly to Discord.');
  }
  return url.href;
}

async function downloadBody(response, limit, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new KnowledgeError('Each library document must be no larger than 20 MiB.');
  }
  if (!response.body?.getReader) throw new KnowledgeError('The document attachment is empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new KnowledgeError('Each library document must be no larger than 20 MiB.');
      chunks.push(value);
    }
    if (!bytes) throw new KnowledgeError('The document attachment is empty.');
    return { blob: new Blob(chunks), bytes };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Files are permanent (no expires_after). Only filenames and provider IDs are
// stored locally; the document bytes stay at xAI until /knowledge forget/clear.
// Collection management is optional: the normal inference key alone provides a
// functioning durable library by attaching selected stored Files to /ask.
export class KnowledgeLibrary {
  constructor({ directory, apiKey, managementApiKey, fetchImpl = fetch, timeoutMs = 60000,
    maxDocuments = 20, maxFileBytes = 20 * MiB, maxLibraryBytes = 40 * MiB,
    maxInputFiles = 20, maxInputBytes = 40 * MiB,
    onCleanupFailure = () => {} } = {}) {
    Object.assign(this, { apiKey, managementApiKey, fetchImpl, timeoutMs, maxDocuments,
      maxFileBytes, maxLibraryBytes, maxInputFiles, maxInputBytes, onCleanupFailure });
    this.pending = new Map();
    this.closed = false;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, 'knowledge.sqlite');
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS knowledge_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        file_id TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL, index_status TEXT NOT NULL DEFAULT 'unindexed'
      );
      CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge_files(scope, id);
      CREATE TABLE IF NOT EXISTS knowledge_collections (
        scope TEXT PRIMARY KEY, collection_id TEXT NOT NULL UNIQUE
      );`);
  }

  isActive(scope) { return this.pending.has(scope); }

  #assertOpen() { if (this.closed) throw new KnowledgeError('The knowledge library is restarting. Please try again shortly.'); }

  #serialized(scope, operation) {
    this.#assertOpen();
    validScope(scope);
    const prior = this.pending.get(scope) ?? Promise.resolve();
    const result = prior.catch(() => {}).then(operation);
    // Store a rejection-handled tail so an unobserved finally promise cannot
    // become an unhandled rejection while retaining the caller's actual error.
    const tail = result.then(() => {}, () => {}).finally(() => {
      if (this.pending.get(scope) === tail) this.pending.delete(scope);
    });
    this.pending.set(scope, tail);
    return result;
  }

  #signal(caller) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    return caller ? AbortSignal.any([deadline, caller]) : deadline;
  }

  #rows(scope) {
    return this.db.prepare('SELECT * FROM knowledge_files WHERE scope = ? ORDER BY id DESC').all(scope);
  }

  list(scope) {
    this.#assertOpen();
    return this.#rows(validScope(scope)).map(({ id, filename, bytes, created_at, index_status }) => ({ id, filename, bytes, created_at, index_status }));
  }

  async #request(path, { method = 'GET', body, management = false, signal, allowMissing = false } = {}) {
    signal.throwIfAborted();
    const response = await this.fetchImpl(`${management ? 'https://management-api.x.ai/v1' : 'https://api.x.ai/v1'}${path}`, {
      method, redirect: 'error', signal,
      headers: { Authorization: `Bearer ${management ? this.managementApiKey : this.apiKey}`,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
    if (allowMissing && response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(response.status, 'knowledge_request_failed');
    }
    // DELETE endpoints can return an empty response.
    if (method === 'DELETE') { await response.body?.cancel().catch(() => {}); return true; }
    return response.json();
  }

  async #collection(scope, signal) {
    const existing = this.db.prepare('SELECT collection_id FROM knowledge_collections WHERE scope = ?').get(scope);
    if (existing) return existing.collection_id;
    const label = createHash('sha256').update(scope).digest('hex').slice(0, 20);
    const result = await this.#request('/collections', { method: 'POST', body: { collection_name: `Owaua ${label}` }, management: true, signal });
    const id = result.collection_id;
    if (typeof id !== 'string' || !COLLECTION_ID.test(id)) throw new ProviderError(502, 'invalid_knowledge_collection');
    try {
      this.db.prepare('INSERT INTO knowledge_collections(scope, collection_id) VALUES(?,?)').run(scope, id);
    } catch (error) {
      try { await this.#request(`/collections/${id}`, { method: 'DELETE', management: true, signal: AbortSignal.timeout(10000), allowMissing: true }); }
      catch { this.#cleanupFailed(); }
      throw error;
    }
    return id;
  }

  #cleanupFailed() {
    try { Promise.resolve(this.onCleanupFailure(1)).catch(() => {}); } catch {}
  }

  async #index(scope, row, signal) {
    if (!this.managementApiKey) return row.index_status;
    let attached = !['unindexed', 'index_error'].includes(row.index_status);
    try {
      const collectionId = await this.#collection(scope, signal);
      const path = `/collections/${collectionId}/documents/${row.file_id}`;
      // A previous transport error may have happened after xAI accepted the
      // attachment. Check its metadata before retrying a possibly completed POST.
      let document;
      if (row.index_status === 'index_error') {
        document = await this.#request(path, { management: true, signal, allowMissing: true });
        attached = document != null;
      }
      if (!attached) {
        await this.#request(path, { method: 'POST', management: true, signal });
        attached = true;
        this.db.prepare('UPDATE knowledge_files SET index_status = ? WHERE scope = ? AND id = ?').run('processing', scope, row.id);
      }
      document ??= await this.#request(path, { management: true, signal });
      const status = { DOCUMENT_STATUS_PROCESSED: 'ready', DOCUMENT_STATUS_FAILED: 'failed', DOCUMENT_STATUS_PROCESSING: 'processing' }[document.status] ?? 'processing';
      this.db.prepare('UPDATE knowledge_files SET index_status = ? WHERE scope = ? AND id = ?').run(status, scope, row.id);
      return status;
    } catch (error) {
      if (signal.aborted) throw error;
      // Keep the permanent original usable even if management permissions or
      // indexing are unavailable. Provider messages/content are never reflected.
      const status = attached ? 'processing' : 'index_error';
      this.db.prepare('UPDATE knowledge_files SET index_status = ? WHERE scope = ? AND id = ?').run(status, scope, row.id);
      return status;
    }
  }

  add(scope, attachment, { signal: callerSignal } = {}) {
    return this.#serialized(scope, async () => {
      if (!isDocumentAttachment(attachment)) throw new KnowledgeError('Attach a PDF, text, or code document directly to Discord.');
      const url = attachmentUrl(attachment);
      const existing = this.#rows(scope);
      if (existing.length >= this.maxDocuments) throw new KnowledgeError(`Your library here is full (${this.maxDocuments} documents). Use /knowledge forget or clear first.`);
      const storedBytes = existing.reduce((sum, row) => sum + row.bytes, 0);
      if (Number.isFinite(attachment.size) && attachment.size > this.maxFileBytes) throw new KnowledgeError('Each library document must be no larger than 20 MiB.');
      if (Number.isFinite(attachment.size) && storedBytes + attachment.size > this.maxLibraryBytes) throw new KnowledgeError('Your library here can hold up to 40 MiB in total. Remove a document with /knowledge forget first.');
      const signal = this.#signal(callerSignal);
      const response = await this.fetchImpl(url, { redirect: 'error', signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new KnowledgeError('I could not download that document. Please attach it again.');
      }
      const { blob, bytes } = await downloadBody(response, this.maxFileBytes, signal);
      if (storedBytes + bytes > this.maxLibraryBytes) throw new KnowledgeError('Your library here can hold up to 40 MiB in total. Remove a document with /knowledge forget first.');
      const filename = knowledgeFilename(attachment.name ?? attachment.filename);
      const mime = filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain';
      const body = new FormData();
      body.append('purpose', 'assistants');
      body.append('file', new Blob([blob], { type: mime }), filename);
      const uploaded = await this.#request('/files', { method: 'POST', body, signal });
      if (typeof uploaded.id !== 'string' || !FILE_ID.test(uploaded.id)) throw new ProviderError(502, 'invalid_knowledge_upload');
      let row;
      try {
        if (uploaded.expires_at != null) throw new KnowledgeError('The provider returned an expiring file. It was not saved to your permanent library.');
        signal.throwIfAborted();
        const result = this.db.prepare('INSERT INTO knowledge_files(scope,file_id,filename,bytes,created_at) VALUES(?,?,?,?,?)')
          .run(scope, uploaded.id, filename, bytes, Date.now());
        row = { id: Number(result.lastInsertRowid), file_id: uploaded.id, filename, bytes, index_status: 'unindexed' };
      } catch (error) {
        try { await this.#request(`/files/${uploaded.id}`, { method: 'DELETE', signal: AbortSignal.timeout(10000), allowMissing: true }); }
        catch { this.#cleanupFailed(); }
        throw error;
      }
      // The durable save is already complete. An indexing timeout must not make
      // a successful upload look lost or provoke duplicate client retries.
      try { row.index_status = await this.#index(scope, row, signal); }
      catch { row.index_status = 'processing'; }
      return { id: row.id, filename, bytes, index_status: row.index_status };
    });
  }

  async #deleteRow(scope, row, signal) {
    const collection = this.db.prepare('SELECT collection_id FROM knowledge_collections WHERE scope = ?').get(scope);
    if (collection) {
      if (!this.managementApiKey) throw new KnowledgeError('Library deletion needs the configured collection management key. Please ask the bot owner to restore it.');
      await this.#request(`/collections/${collection.collection_id}/documents/${row.file_id}`, { method: 'DELETE', management: true, signal, allowMissing: true });
      this.db.prepare('UPDATE knowledge_files SET index_status = ? WHERE scope = ? AND id = ?').run('unindexed', scope, row.id);
    }
    await this.#request(`/files/${row.file_id}`, { method: 'DELETE', signal, allowMissing: true });
    this.db.prepare('DELETE FROM knowledge_files WHERE scope = ? AND id = ?').run(scope, row.id);
  }

  forget(scope, id, { signal: callerSignal } = {}) {
    return this.#serialized(scope, async () => {
      if (!Number.isSafeInteger(id) || id < 1) throw new KnowledgeError('Choose a valid document ID from /knowledge list.');
      const row = this.db.prepare('SELECT * FROM knowledge_files WHERE scope = ? AND id = ?').get(scope, id);
      if (!row) return false;
      await this.#deleteRow(scope, row, this.#signal(callerSignal));
      return true;
    });
  }

  clear(scope, { signal: callerSignal } = {}) {
    return this.#serialized(scope, async () => {
      const signal = this.#signal(callerSignal);
      let deleted = 0, failed = 0;
      for (const row of this.#rows(scope)) {
        try { await this.#deleteRow(scope, row, signal); deleted++; }
        catch { failed++; }
      }
      if (!failed) {
        const collection = this.db.prepare('SELECT collection_id FROM knowledge_collections WHERE scope = ?').get(scope);
        if (collection && this.managementApiKey) {
          try {
            await this.#request(`/collections/${collection.collection_id}`, { method: 'DELETE', management: true, signal, allowMissing: true });
            this.db.prepare('DELETE FROM knowledge_collections WHERE scope = ?').run(scope);
          } catch { this.#cleanupFailed(); }
        }
      }
      return { deleted, failed };
    });
  }

  context(scope, query = '', { signal: callerSignal } = {}) {
    return this.#serialized(scope, async () => {
      let rows = this.#rows(scope);
      if (!rows.length) return { input: [], tools: [], names: [], total: 0, selected: 0, indexing: 0, collectionMode: false };
      const signal = this.#signal(callerSignal);
      if (this.managementApiKey) {
        // A single status refresh per request avoids unbounded polling. Files
        // remain usable while their collection index processes asynchronously.
        for (const row of rows) {
          if (row.index_status !== 'ready' && row.index_status !== 'failed') {
            try { await this.#index(scope, row, signal); } catch { break; }
          }
        }
        rows = this.#rows(scope);
      }
      const collection = this.db.prepare('SELECT collection_id FROM knowledge_collections WHERE scope = ?').get(scope);
      const indexing = rows.filter(row => row.index_status !== 'ready').length;
      if (this.managementApiKey && collection && !indexing) {
        return { input: [], tools: [{ type: 'file_search', vector_store_ids: [collection.collection_id] }],
          names: rows.map(row => row.filename), total: rows.length, selected: rows.length, indexing, collectionMode: true };
      }
      const words = [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 50);
      const score = row => words.filter(word => row.filename.toLowerCase().includes(word)).length;
      rows.sort((a, b) => score(b) - score(a) || b.id - a.id);
      const selected = [];
      let bytes = 0;
      for (const row of rows) {
        if (selected.length >= this.maxInputFiles) break;
        if (bytes + row.bytes > this.maxInputBytes) continue;
        bytes += row.bytes; selected.push(row);
      }
      return { input: selected.map(row => ({ type: 'input_file', file_id: row.file_id })), tools: [],
        names: selected.map(row => row.filename), total: rows.length, selected: selected.length, indexing, collectionMode: false };
    });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    return this.closePromise = Promise.allSettled([...this.pending.values()]).then(() => {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { this.db.close(); }
    });
  }
}
