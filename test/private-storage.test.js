import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPrivateDatabase } from '../src/private-storage.js';

const unix = { skip: process.platform === 'win32' };
const mode = path => statSync(path).mode & 0o777;

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'owaua-private-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('new database and sidecars are private and existing data survives permission migration', unix, t => {
  const root = join(directory(t), 'data');
  const path = join(root, 'kirmy.sqlite');
  const first = openPrivateDatabase(root, 'kirmy.sqlite');
  try {
    assert.equal(mode(root), 0o700);
    assert.equal(mode(path), 0o600);
    first.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('safe');");
    const paths = [path, path + '-wal', path + '-shm'];
    for (const file of paths) chmodSync(file, 0o644);
    const second = openPrivateDatabase(root, 'kirmy.sqlite');
    try {
      for (const file of paths) assert.equal(mode(file), 0o600);
      assert.equal(second.prepare('SELECT value FROM fixture').get().value, 'safe');
    } finally {
      second.close();
    }
  } finally {
    first.close();
  }
});

test('startup protects and loads the selected environment file', unix, t => {
  const root = directory(t);
  const path = join(root, 'fixture.env');
  const fallback = join(root, 'fallback.env');
  writeFileSync(path, 'OWAUA_FIXTURE_VALUE=selected\n');
  writeFileSync(fallback, 'OWAUA_FIXTURE_VALUE=fallback\n');
  chmodSync(path, 0o644);
  const bootstrap = new URL('../src/secure-environment.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(bootstrap)}); console.log(process.env.OWAUA_FIXTURE_VALUE);`], {
    cwd: root, env: { DOTENV_PATH: path, DOTENV_CONFIG_PATH: fallback }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'selected');
  assert.equal(mode(path), 0o600);
});
