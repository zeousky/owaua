import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertSupportedNode, SUPPORTED_NODE } from '../src/runtime.js';

test('runtime policy rejects vulnerable releases and accepts patched supported lines', () => {
  for (const version of ['22.23.4', '24.0.0', '24.21.9', '24.22.0', '25.9.0',
    '26.9.0', '26.11.9', '26.12.0', '27.0.0', '24.22.1-rc.1', 'v24.22.1',
    '024.22.1', '24.22', '', null]) {
    assert.throws(() => assertSupportedNode(version), /Unsupported Node.js/, String(version));
  }
  for (const version of ['24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.12.2', '26.13.0']) {
    assert.doesNotThrow(() => assertSupportedNode(version), version);
  }
  assert.doesNotThrow(() => assertSupportedNode());
});

test('guard rejects a vulnerable runtime during import before subsequent startup work', () => {
  const guard = new URL('../src/runtime.js', import.meta.url).href;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process.versions, 'node', { value: '26.9.0' });
     await import(${JSON.stringify(guard)}); console.log('startup continued');`],
  { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /Unsupported Node.js 26\.9\.0/);
    assert.doesNotMatch(error.stdout, /startup continued/);
    return true;
  });
});

test('production entry points run the guard first and version selectors agree', () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.match(read('src/bot.js'), /^import '\.\/runtime\.js';\nimport 'dotenv\/config';/);
  assert.match(read('scripts/backup-memory.js'), /^import '\.\.\/src\/runtime\.js';/);
  assert.equal(JSON.parse(read('package.json')).engines.node, SUPPORTED_NODE);
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].engines.node, SUPPORTED_NODE);
  const pinned = read('.nvmrc').trim();
  assertSupportedNode(pinned);
  assert.ok(read('Dockerfile').startsWith(`FROM node:${pinned}-bookworm-slim\n`));
});
