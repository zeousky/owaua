import { ProviderError } from './ai.js';
import { fullModeActive } from './full-mode.js';

const MiB = 1024 * 1024;
const DISCORD_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
// The Files guide documents PDF and UTF-8 text, including code, CSV and JSON.
// Binary Office documents are deliberately excluded from this attachment path.
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'log', 'ini', 'toml', 'rst',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh', 'sql', 'swift',
  'kt', 'kts', 'lua', 'r', 'dart', 'ipynb',
]);
const TEXT_MIMES = new Set([
  'application/json', 'application/x-ndjson', 'application/xml',
  'application/javascript', 'application/typescript', 'application/yaml',
]);

export class DocumentInputError extends Error {}

function attachmentName(attachment) {
  return String(attachment?.name ?? attachment?.filename ?? '').split(/[\\/]/).at(-1);
}

export function isDocumentAttachment(attachment) {
  const mime = String(attachment?.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (/^(image|audio|video)\//.test(mime)) return false;
  const extension = attachmentName(attachment).split('.').at(-1).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(extension) || mime === 'application/pdf' ||
    mime.startsWith('text/') || TEXT_MIMES.has(mime);
}

function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new DocumentInputError('The document attachment URL is invalid.'); }
  if (url.protocol !== 'https:' || !DISCORD_HOSTS.has(url.hostname) || url.username ||
      url.password || (url.port && url.port !== '443')) {
    throw new DocumentInputError('Please attach documents directly to Discord.');
  }
  return url.href;
}

function asAttachments(attachments) {
  if (attachments == null) return [];
  if (Array.isArray(attachments)) return attachments;
  if (typeof attachments.values === 'function') return [...attachments.values()];
  throw new DocumentInputError('The document attachments are invalid.');
}

async function boundedDownload(response, { signal, maxFileBytes, remainingBytes }) {
  const limit = Math.min(maxFileBytes, remainingBytes);
  const statedSize = Number(response.headers?.get('content-length'));
  if (Number.isFinite(statedSize) && statedSize > limit) {
    await response.body?.cancel().catch(() => {});
    throw new DocumentInputError('The attached documents exceed the upload size limit.');
  }
  if (!response.body?.getReader) throw new DocumentInputError('The document download was empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new DocumentInputError('The attached documents exceed the upload size limit.');
      chunks.push(value);
    }
    if (!size) throw new DocumentInputError('The document attachment is empty.');
    return { blob: new Blob(chunks), size };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class DocumentInputs {
  constructor({ apiKey, timeoutMs = 60000, cleanupTimeoutMs = 10000, fetchImpl = fetch,
    maxFiles = 4, maxFileBytes = 20 * MiB, maxTotalBytes = 40 * MiB,
    onCleanupFailure = () => {} } = {}) {
    Object.assign(this, { apiKey, timeoutMs, cleanupTimeoutMs, fetchImpl, maxFiles, maxFileBytes, maxTotalBytes, onCleanupFailure });
  }

  async upload(attachments, { signal: callerSignal } = {}) {
    const documents = asAttachments(attachments).filter(isDocumentAttachment);
    if (!fullModeActive() && documents.length > this.maxFiles) {
      throw new DocumentInputError(`Please attach at most ${this.maxFiles} documents at once.`);
    }
    const ids = [];
    let cleanupPromise;
    const cleanup = () => cleanupPromise ??= this.#deleteFiles(ids);
    if (!documents.length) return { input: [], cleanup };
    // Validate every URL and declared size before uploading any document.
    const urls = documents.map(document => downloadUrl(document.url));
    let statedTotal = 0;
    for (const document of documents) {
      if (Number.isFinite(document.size) && document.size > this.maxFileBytes) {
        throw new DocumentInputError(`Each document must be no larger than ${Math.floor(this.maxFileBytes / MiB)} MiB.`);
      }
      statedTotal += Number.isFinite(document.size) && document.size > 0 ? document.size : 0;
    }
    const maxTotalBytes = fullModeActive() ? Infinity : this.maxTotalBytes;
    if (statedTotal > maxTotalBytes) throw new DocumentInputError('The attached documents exceed the combined upload size limit.');
    const deadline = fullModeActive() ? null : AbortSignal.timeout(this.timeoutMs);
    const signal = deadline ? (callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline) : callerSignal ?? new AbortController().signal;
    let totalBytes = 0;
    try {
      for (const [index, document] of documents.entries()) {
        signal.throwIfAborted();
        const response = await this.fetchImpl(urls[index], { signal, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new DocumentInputError('I could not download the document attachment. Please attach it again.');
        }
        const { blob, size } = await boundedDownload(response, {
          signal, maxFileBytes: this.maxFileBytes, remainingBytes: maxTotalBytes - totalBytes,
        });
        totalBytes += size;
        signal.throwIfAborted();
        const body = new FormData();
        body.append('purpose', 'assistants');
        // Provider-side expiry is a backstop if the process stops before cleanup.
        body.append('expires_after', '3600');
        const name = attachmentName(document) || 'attachment.txt';
        const mime = String(document.contentType ?? '').split(';')[0].trim().toLowerCase() ||
          (name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain');
        body.append('file', new Blob([blob], { type: mime }), name);
        const upload = await this.fetchImpl('https://api.x.ai/v1/files', {
          method: 'POST', signal, redirect: 'error',
          headers: { Authorization: `Bearer ${this.apiKey}` }, body,
        });
        if (!upload.ok) {
          await upload.body?.cancel().catch(() => {});
          throw new ProviderError(upload.status, 'document_upload_failed');
        }
        const result = await upload.json();
        if (typeof result.id !== 'string' || !/^file[-_][A-Za-z0-9_-]{1,200}$/.test(result.id)) {
          throw new ProviderError(502, 'invalid_document_upload');
        }
        ids.push(result.id);
      }
      signal.throwIfAborted();
      return { input: ids.map(file_id => ({ type: 'input_file', file_id })), cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async #deleteFiles(ids) {
    const results = await Promise.allSettled(ids.map(async id => {
      const response = await this.fetchImpl(`https://api.x.ai/v1/files/${encodeURIComponent(id)}`, {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(this.cleanupTimeoutMs),
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok && response.status !== 404) throw new ProviderError(response.status, 'document_cleanup_failed');
    }));
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) {
      // Logging hooks receive a count only and must never obscure the request's
      // result or its original error, including during partial-upload rollback.
      try { Promise.resolve(this.onCleanupFailure(failed)).catch(() => {}); } catch {}
    }
    return { deleted: results.length - failed, failed };
  }
}
