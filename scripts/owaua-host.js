#!/usr/bin/env node
import '../src/runtime.js';
import { createProcessHost } from '../src/process-host.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const host = createProcessHost({ root });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await host.close(); process.exitCode = 0; }
    catch { console.error(JSON.stringify({ event: 'owaua_host_error', code: 'shutdown_failed' })); process.exitCode = 1; }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try { await host.listen(); }
  catch {
    console.error(JSON.stringify({ event: 'owaua_host_error', code: 'startup_failed' }));
    await shutdown(); process.exitCode = 1;
  }
  return host;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
