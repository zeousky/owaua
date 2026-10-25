import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalExtension } from '../src/local-extension.js';

async function fixture(t, content) {
  const directory = await mkdtemp(join(tmpdir(), 'local-extension-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = pathToFileURL(join(directory, 'entry.mjs'));
  if (content !== undefined) await writeFile(entry, content);
  return entry;
}

test('absent optional extension does not prevent startup', async t => {
  assert.equal(await loadLocalExtension({}, { entry: await fixture(t) }), null);
});

test('extension receives context and exposes optional independent handlers', async t => {
  const entry = await fixture(t, 'export const createExtension = context => ({ handleMessage: () => context.value });');
  const extension = await loadLocalExtension({ value: true }, { entry });
  assert.equal(extension.handleMessage(), true);
});

test('invalid handlers and broken extension imports fail visibly', async t => {
  const invalid = await fixture(t, 'export const createExtension = () => ({ handleHttp: true });');
  await assert.rejects(loadLocalExtension({}, { entry: invalid }), /Invalid local extension handlers/);
  const broken = await fixture(t, "import './missing-dependency.mjs'; export const createExtension = () => ({});");
  await assert.rejects(loadLocalExtension({}, { entry: broken }), { code: 'ERR_MODULE_NOT_FOUND' });
});

test('trusted deployment source works without a private checkout file', async t => {
  const source = Buffer.from('export const createExtension = context => ({ handleHttp: () => context.value });').toString('base64');
  const extension = await loadLocalExtension({ value: true }, { entry: await fixture(t), source });
  assert.equal(extension.handleHttp(), true);
});

test('private local file takes precedence over deployment source', async t => {
  const entry = await fixture(t, 'export const createExtension = () => ({ handleMessage: () => true });');
  const extension = await loadLocalExtension({}, { entry, source: 'invalid' });
  assert.equal(extension.handleMessage(), true);
});

test('deployment source must be bounded canonical Base64 with valid UTF-8', async t => {
  const entry = await fixture(t);
  for (const source of ['invalid', 'YQ==\n', 'YR==', Buffer.alloc(131073).toString('base64'), '/w==']) {
    await assert.rejects(loadLocalExtension({}, { entry, source }));
  }
});
