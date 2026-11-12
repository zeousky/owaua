import { lstatSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export function controlSocketLocation(env = process.env, socketPath) {
  const configured = socketPath ?? env.OWAUA_CONTROL_SOCKET;
  if (configured !== undefined) return { path: resolve(configured), privateDefault: false };
  const uid = process.getuid?.();
  // Railway SSH enters as root even though the image runs Owaua as UID 10001.
  const railwayRootShell = Boolean(env.RAILWAY_SERVICE_ID) && uid === 0;
  const home = railwayRootShell ? '/app' : env.HOME || homedir();
  return { path: resolve(home, '.owaua', 'control.sock'), privateDefault: true, ownerUid: railwayRootShell ? 10001 : uid };
}

export function checkControlDirectory({ path, privateDefault, ownerUid }, { create = false } = {}) {
  const directory = dirname(path);
  if (!privateDefault) {
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    return;
  }
  const home = statSync(dirname(directory));
  if (!home.isDirectory() || (home.mode & 0o022) || (ownerUid !== undefined && home.uid !== ownerUid && home.uid !== 0)) {
    throw new Error('Owaua’s default control socket requires a trusted home directory.');
  }
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || (info.mode & 0o077) || (ownerUid !== undefined && info.uid !== ownerUid)) {
    throw new Error('Owaua’s default control socket requires a private directory owned by its account.');
  }
}
