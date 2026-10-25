import { access } from 'node:fs/promises';

// Deployment-owned extensions are optional and deliberately excluded from Git.
// Only this fixed local entry point is loaded; messages cannot select modules.
export async function loadLocalExtension(context, {
  entry = new URL('./local/message-handler.js', import.meta.url),
  source = process.env.LOCAL_EXTENSION_SOURCE_B64,
} = {}) {
  let specifier = entry.href;
  try { await access(entry); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!source) return null;
    if (typeof source !== 'string' || source.length > 174764 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) {
      throw new TypeError('Invalid local extension source encoding');
    }
    const bytes = Buffer.from(source, 'base64');
    if (!bytes.length || bytes.length > 131072 || bytes.toString('base64') !== source) {
      throw new TypeError('Invalid local extension source size or encoding');
    }
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // This is trusted administrator-owned deployment code, like the local file.
    // It cannot be configured through Discord input or model output.
    specifier = `data:text/javascript;base64,${source}`;
  }
  const module = await import(specifier);
  if (typeof module.createExtension !== 'function') throw new TypeError('Invalid local extension entry point');
  const extension = await module.createExtension(context);
  if (!extension || ['handleMessage', 'handleHttp', 'close'].some(name =>
    extension[name] !== undefined && typeof extension[name] !== 'function')) {
    throw new TypeError('Invalid local extension handlers');
  }
  return extension;
}
