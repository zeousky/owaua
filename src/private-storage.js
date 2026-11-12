import { DatabaseSync } from 'node:sqlite';
import {
  closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, statSync,
} from 'node:fs';
import { join } from 'node:path';

// Open by descriptor so permission changes cannot follow a symlink.
function protectFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    const uid = process.getuid?.();
    if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid)) {
      throw new Error('Sensitive storage must be a regular file owned by the bot account.');
    }
    if (process.platform !== 'win32' && (info.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function protectEnvironmentFile(path) {
  protectFile(path);
}

export function openPrivateDatabase(directory, filename) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = statSync(directory);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && ((info.mode & 0o022) !== 0 || (info.uid !== uid && info.uid !== 0)))) {
    throw new Error('DATA_DIR must be a trusted directory without group or public write access.');
  }
  const path = join(directory, filename);
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!protectFile(path)) throw new Error('The database file is unavailable.');
  for (const suffix of ['-wal', '-shm', '-journal']) protectFile(path + suffix);
  return new DatabaseSync(path);
}
