import './runtime.js';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const actions = new Set(['start', 'stop', 'restart', 'status']);
const states = new Set(['running', 'starting', 'stopped', 'stopping']);
const expected = Object.freeze({
  application: '1442127404607737999',
  project: 'f9819aec-de3b-460b-850a-ff3f97ddbbd3',
  environment: '9ae72159-bdbf-40c6-9c3e-613e381ef6b7',
  service: '1e0cac45-0cea-4cf9-ac0d-b886764e8887',
});

export class HostControlError extends Error {}

export function readHostIdentity(path = new URL('../BOT_IDENTITY.json', import.meta.url)) {
  let identity;
  try { identity = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new HostControlError('Owaua’s bot identity file could not be read.'); }
  if (identity.botName !== 'Owaua' || identity.runtime !== 'node' ||
    identity.discordApplicationId !== expected.application || identity.githubRepository !== 'zeousky/kirmy-bot' ||
    identity.railway?.projectId !== expected.project || identity.railway?.environmentId !== expected.environment ||
    identity.railway?.serviceId !== expected.service) {
    throw new HostControlError('The configured service does not match the Owaua bot. No action was performed.');
  }
  return identity;
}

function validateLocalIdentity(env, identity) {
  if (env.RAILWAY_PROJECT_ID !== identity.railway.projectId ||
    env.RAILWAY_ENVIRONMENT_ID !== identity.railway.environmentId ||
    env.RAILWAY_SERVICE_ID !== identity.railway.serviceId) {
    throw new HostControlError('Run this command in Owaua’s production Railway terminal, or from your normal Mac terminal. No action was performed.');
  }
}

// There is deliberately no fallback that starts a local Discord client.
export function requestHostControl(action, { socketPath = process.env.OWAUA_CONTROL_SOCKET ?? '/tmp/owaua-control.sock',
  timeoutMs = 200000, connectImpl = createConnection } = {}) {
  if (!actions.has(action)) return Promise.reject(new HostControlError('Use start, stop, restart, or status.'));
  if (typeof socketPath !== 'string' || !socketPath || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new HostControlError('Invalid host controller configuration.'));
  }
  return new Promise((resolveRequest, reject) => {
    let socket, settled = false, buffer = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      if (error) reject(error); else resolveRequest(value);
    };
    try { socket = connectImpl({ path: socketPath }); }
    catch { finish(new HostControlError('Owaua’s host controller could not be reached.')); return; }
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new HostControlError('Owaua’s host control request timed out. Check status before trying again.')));
    socket.once('connect', () => socket.write(JSON.stringify({ action }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16384) return finish(new HostControlError('The host controller returned an invalid response.'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let value;
      try { value = JSON.parse(buffer.slice(0, newline)); }
      catch { return finish(new HostControlError('The host controller returned an invalid response.')); }
      if (value?.ok === false) {
        const message = typeof value.error === 'string' && value.error.length <= 500
          ? value.error.replace(/[\x00-\x1f\x7f]/g, ' ') : 'Owaua’s host control request failed.';
        return finish(new HostControlError(message));
      }
      if (value?.ok !== true || !states.has(value.state) || typeof value.enabled !== 'boolean' || typeof value.ready !== 'boolean' ||
        value.pid !== null && (!Number.isSafeInteger(value.pid) || value.pid < 1)) {
        return finish(new HostControlError('The host controller returned an invalid response.'));
      }
      finish(null, value);
    });
    socket.once('error', () => finish(new HostControlError('Owaua’s host controller is unavailable. The Railway deployment must be running the managed host.')));
    socket.once('close', () => { if (!settled) finish(new HostControlError('The host controller closed before confirming the action. Check status before trying again.')); });
  });
}

function remoteControl(action, { identity, env, spawnImpl }) {
  const selectors = identity.railway;
  const args = ['ssh', '--project', selectors.projectId, '--environment', selectors.environmentId,
    '--service', selectors.serviceId, '--', 'node', '/app/src/host-control.js', action, '--local'];
  return new Promise((resolveExit, reject) => {
    let child;
    try { child = spawnImpl('railway', args, { env, stdio: 'inherit', shell: false }); }
    catch { reject(new HostControlError('Railway SSH could not be started. Check that the Railway CLI is installed and signed in.')); return; }
    child.once('error', () => reject(new HostControlError('Railway SSH could not be started. Check that the Railway CLI is installed and signed in.')));
    child.once('exit', code => resolveExit(Number.isInteger(code) ? code : 1));
  });
}

export async function main(args = process.argv.slice(2), { env = process.env, identity: suppliedIdentity,
  spawnImpl = spawn, requestImpl = requestHostControl, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (args.length < 1 || args.length > 2 || !actions.has(args[0]) || args.length === 2 && args[1] !== '--local') {
      throw new HostControlError('Usage: owaua start|stop|restart|status (or start owaua / stop owaua).');
    }
    const identity = suppliedIdentity ?? readHostIdentity();
    const railwayRuntime = ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID']
      .some(key => Boolean(env[key]));
    if (args[1] === '--local' || railwayRuntime) {
      validateLocalIdentity(env, identity);
      const result = await requestImpl(args[0], { socketPath: env.OWAUA_CONTROL_SOCKET ?? '/tmp/owaua-control.sock' });
      stdout.write(`Owaua is ${result.state}.${result.state === 'running' && !result.ready ? ' Discord is still connecting.' : ''}\n`);
      return 0;
    }
    return await remoteControl(args[0], { identity, env, spawnImpl });
  } catch (error) {
    stderr.write((error instanceof HostControlError ? error.message : 'Owaua’s host control request failed.') + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
