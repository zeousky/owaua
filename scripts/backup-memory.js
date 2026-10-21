import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, chmodSync, closeSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw failure('not_regular_file');
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function checkIntegrity(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw failure('integrity_check_failed');
  } finally { db.close(); }
}

// Produces one self-contained SQLite file, including data still in the live WAL.
// Publish with a hard link only after verification: an existing target is never replaced.
export async function backupMemory(source, destination) {
  const path = resolve(destination);
  const sourcePath = resolve(source);
  regularFile(sourcePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(path), '.kirmy-backup-'));
  const staged = join(temporary, 'memory.sqlite');
  let db;
  try {
    db = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5000 });
    await backup(db, staged);
    db.close(); db = undefined;
    chmodSync(staged, 0o600);
    // The backup must travel as one file; do not require copying WAL/SHM sidecars.
    const snapshot = new DatabaseSync(staged, { timeout: 5000 });
    try { snapshot.exec('PRAGMA journal_mode=DELETE'); } finally { snapshot.close(); }
    const result = await verifyBackup(staged);
    const descriptor = openSync(staged, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    linkSync(staged, path);
    return { status: 'backed_up', path, sha256: result.sha256 };
  } finally {
    db?.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function verifyBackup(file, expectedHash) {
  const path = resolve(file);
  regularFile(path);
  if (expectedHash !== undefined && !/^[a-f\d]{64}$/i.test(expectedHash)) throw failure('invalid_sha256');
  checkIntegrity(path);
  const sha256 = await hashFile(path);
  if (expectedHash !== undefined && !timingSafeEqual(Buffer.from(sha256, 'hex'), Buffer.from(expectedHash, 'hex'))) {
    throw failure('sha256_mismatch');
  }
  return { status: 'verified', path, sha256 };
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (!['backup', 'verify'].includes(command) || options.length % 2) throw failure('invalid_usage');
  const allowed = new Set(command === 'backup' ? ['--source', '--output'] : ['--file', '--sha256']);
  const values = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const [key, value] = options.slice(index, index + 2);
    if (!allowed.has(key) || !value || values.has(key)) throw failure('invalid_usage');
    values.set(key, value);
  }
  if (command === 'verify') {
    if (!values.has('--file')) throw failure('invalid_usage');
    return verifyBackup(values.get('--file'), values.get('--sha256'));
  }
  const data = resolve(process.env.DATA_DIR || join(root, 'data'));
  const source = values.get('--source') || join(data, 'kirmy.sqlite');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = values.get('--output') || join(data, 'backups', `kirmy-${timestamp}-${randomUUID().slice(0, 8)}.sqlite`);
  return backupMemory(source, output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    // SQLite errors may contain schema names or data. Report only a classification.
    const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_]+$/.test(error.code) ? error.code : 'backup_failed';
    console.error(JSON.stringify({ status: 'error', code }));
    process.exitCode = 1;
  });
}
