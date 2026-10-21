import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupMemory, main, verifyBackup } from '../scripts/backup-memory.js';

const exec = promisify(execFile);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'kirmy-backup-test-'));
  const source = join(directory, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE turns(id INTEGER PRIMARY KEY, user TEXT);
    INSERT INTO turns(user) VALUES('private fixture prompt');`);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, source, db };
}

test('online backups include uncheckpointed WAL data and verify as a private standalone file', async t => {
  const { directory, source, db } = fixture(t);
  assert.ok(statSync(`${source}-wal`).size > 0);
  const output = join(directory, 'backups', 'memory.sqlite');
  const result = await backupMemory(source, output);
  assert.equal(result.status, 'backed_up');
  assert.equal(result.path, output);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'backups')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(directory, 'backups')), ['memory.sqlite']);
  const snapshot = new DatabaseSync(output, { readOnly: true });
  try { assert.equal(snapshot.prepare('SELECT user FROM turns').get().user, 'private fixture prompt'); }
  finally { snapshot.close(); }
  db.prepare('INSERT INTO turns(user) VALUES(?)').run('newer live data');
  assert.equal((await verifyBackup(output, result.sha256)).status, 'verified');
  assert.equal(result.sha256, createHash('sha256').update(readFileSync(output)).digest('hex'));
  assert.notEqual(readFileSync(source).toString('hex'), readFileSync(output).toString('hex'));
});

test('backup refuses to clobber files, source, or symlinks and cleans temporary files', async t => {
  const { directory, source } = fixture(t);
  const existing = join(directory, 'keep.sqlite');
  writeFileSync(existing, 'must stay');
  await assert.rejects(backupMemory(source, existing), { code: 'EEXIST' });
  assert.equal(readFileSync(existing, 'utf8'), 'must stay');
  await assert.rejects(backupMemory(source, source), { code: 'EEXIST' });
  const link = join(directory, 'link.sqlite');
  symlinkSync(existing, link);
  await assert.rejects(backupMemory(source, link), { code: 'EEXIST' });
  assert.equal(readFileSync(existing, 'utf8'), 'must stay');
  assert.ok(!readdirSync(directory).some(name => name.startsWith('.kirmy-backup-')));
});

test('verify rejects corruption, missing files, and mismatched or malformed hashes', async t => {
  const { directory, source } = fixture(t);
  const output = join(directory, 'memory.sqlite');
  await backupMemory(source, output);
  await assert.rejects(verifyBackup(output, '0'.repeat(64)), { code: 'sha256_mismatch' });
  await assert.rejects(verifyBackup(output, 'not-a-hash'), { code: 'invalid_sha256' });
  await assert.rejects(verifyBackup(join(directory, 'missing.sqlite')), { code: 'ENOENT' });
  const corrupt = join(directory, 'corrupt.sqlite');
  writeFileSync(corrupt, 'private corrupt contents');
  await assert.rejects(verifyBackup(corrupt));
  assert.ok(!existsSync(join(directory, 'missing.sqlite')));
});

test('CLI emits only backup status, path and hash, and never prints database contents on failure', async t => {
  const { directory, source } = fixture(t);
  const script = fileURLToPath(new URL('../scripts/backup-memory.js', import.meta.url));
  const output = join(directory, 'cli.sqlite');
  const result = await exec(process.execPath, [script, 'backup', '--source', source, '--output', output]);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(data).sort(), ['path', 'sha256', 'status']);
  assert.equal(data.status, 'backed_up');
  assert.ok(!result.stdout.includes('private fixture prompt'));
  const checked = await exec(process.execPath, [script, 'verify', '--file', output, '--sha256', data.sha256]);
  assert.equal(JSON.parse(checked.stdout).status, 'verified');
  const corrupt = join(directory, 'corrupt.sqlite');
  writeFileSync(corrupt, 'private corrupt contents');
  await assert.rejects(exec(process.execPath, [script, 'verify', '--file', corrupt]), error => {
    assert.equal(error.stdout, '');
    const failure = JSON.parse(error.stderr.trim().split('\n').at(-1));
    assert.equal(failure.status, 'error');
    assert.ok(!error.stderr.includes('private corrupt contents'));
    return true;
  });
});

test('CLI argument validation cannot accidentally select a missing source or unsupported operation', async () => {
  for (const args of [[], ['restore'], ['verify'], ['verify', '--file'],
    ['verify', '--file', 'a', '--file', 'b'], ['backup', '--unknown', 'x']]) {
    await assert.rejects(main(args), { code: 'invalid_usage' });
  }
});
