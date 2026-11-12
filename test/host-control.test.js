import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostControlError, readHostIdentity, requestHostControl, main } from '../src/host-control.js';
import { checkControlDirectory, controlSocketLocation } from '../src/control-socket.js';

const identity = readHostIdentity();
const localEnv = { RAILWAY_PROJECT_ID: identity.railway.projectId, RAILWAY_ENVIRONMENT_ID: identity.railway.environmentId,
  RAILWAY_SERVICE_ID: identity.railway.serviceId, OWAUA_CONTROL_SOCKET: '/tmp/fixture-owaua.sock' };
const state = { ok: true, state: 'running', enabled: true, pid: 1234, ready: true };
function output() { let text = ''; return { write: value => { text += value; }, read: () => text }; }
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'owaua control '));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function server(t, respond) {
  const socketPath = join(directory(t), 'host.sock'), connections = new Set();
  const host = createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    socket.setEncoding('utf8'); let data = '';
    socket.on('data', chunk => { data += chunk; if (data.includes('\n')) respond(socket, data); });
  });
  await new Promise((resolveReady, reject) => { host.once('error', reject); host.listen(socketPath, resolveReady); });
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolveClosed => host.close(resolveClosed)); });
  return socketPath;
}

test('private controller requests send only one allowed action and wait for a bounded confirmed reply', async t => {
  let received;
  const socketPath = await server(t, (socket, data) => {
    received = data;
    setImmediate(() => socket.end(JSON.stringify(state) + '\n'));
  });
  assert.deepEqual(await requestHostControl('start', { socketPath }), state);
  assert.equal(received, '{"action":"start"}\n');
  let connections = 0;
  await assert.rejects(requestHostControl('kill all', { connectImpl: () => { connections++; } }), HostControlError);
  assert.equal(connections, 0);
});

test('controller failures, malformed responses, missing confirmations and timeouts fail without starting another process', async t => {
  for (const result of ['{"ok":false,"error":"The bot did not become ready."}\n', 'invalid\n',
    JSON.stringify({ ...state, pid: -4 }) + '\n', 'a'.repeat(17000)]) {
    const socketPath = await server(t, socket => socket.end(result));
    await assert.rejects(requestHostControl('stop', { socketPath, timeoutMs: 1000 }), HostControlError);
  }
  const closed = await server(t, socket => socket.end());
  await assert.rejects(requestHostControl('restart', { socketPath: closed }), /before confirming/);
  const idle = await server(t, () => {});
  await assert.rejects(requestHostControl('start', { socketPath: idle, timeoutMs: 10 }), /timed out/);
  await assert.rejects(requestHostControl('status', { socketPath: join(directory(t), 'missing.sock') }), /unavailable/);
});

test('normal Mac terminal uses explicit Owaua Railway SSH selectors and fixed argv without a shell or local client', async () => {
  const calls = [], stdout = output(), stderr = output();
  const result = await main(['stop'], { env: { PATH: '/fixture/bin' }, stdout, stderr,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 0)); return child;
    }, requestImpl: () => { throw new Error('No local socket on Mac'); } });
  assert.equal(result, 0); assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'railway');
  assert.deepEqual(calls[0].args, ['ssh', '--project', identity.railway.projectId, '--environment', identity.railway.environmentId,
    '--service', identity.railway.serviceId, '--', 'node', '/app/src/host-control.js', 'stop', '--local']);
  assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(stderr.read(), '');
});

test('Railway local mode requires all three production selectors and never falls back to launching Discord', async () => {
  for (const env of [{}, { ...localEnv, RAILWAY_PROJECT_ID: 'website-project' },
    { ...localEnv, RAILWAY_SERVICE_ID: 'python-bot' }, { ...localEnv, RAILWAY_ENVIRONMENT_ID: undefined }]) {
    let calls = 0; const stderr = output();
    assert.equal(await main(['start', '--local'], { env, stderr, stdout: output(),
      spawnImpl: () => { calls++; }, requestImpl: () => { calls++; } }), 1);
    assert.equal(calls, 0); assert.match(stderr.read(), /No action was performed/);
  }
  let action;
  const stdout = output();
  assert.equal(await main(['start'], { env: localEnv, stdout, stderr: output(),
    requestImpl: async (value, options) => { action = value; assert.equal(options.socketPath, localEnv.OWAUA_CONTROL_SOCKET); return state; },
    spawnImpl: () => { throw new Error('No SSH inside the container'); } }), 0);
  assert.equal(action, 'start'); assert.equal(stdout.read(), 'Owaua is running.\n');
});

test('native managed hosts use a private home directory socket by default', t => {
  const home = directory(t);
  const location = controlSocketLocation({ HOME: home });
  assert.equal(location.path, join(home, '.owaua', 'control.sock'));
  checkControlDirectory(location, { create: true });
  assert.equal(lstatSync(join(home, '.owaua')).mode & 0o777, 0o700);
});

test('invalid CLI arguments and wrong owning identity fail before any process or socket action', async t => {
  for (const args of [[], ['start owaua'], ['stop;echo secret'], ['start', '--other'], ['start', '--local', 'extra']]) {
    let calls = 0;
    assert.equal(await main(args, { stdout: output(), stderr: output(), spawnImpl: () => { calls++; }, requestImpl: () => { calls++; } }), 1);
    assert.equal(calls, 0);
  }
  const path = join(directory(t), 'identity.json');
  writeFileSync(path, JSON.stringify({ ...identity, botName: 'Kirmy' }));
  assert.throws(() => readHostIdentity(path), /does not match/);
});

test('Railway SSH exit failures remain failures, including missing CLI installation', async () => {
  const stderr = output();
  assert.equal(await main(['status'], { env: {}, stdout: output(), stderr,
    spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 9)); return child; } }), 9);
  assert.equal(await main(['status'], { env: {}, stdout: output(), stderr,
    spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('private environment'))); return child; } }), 1);
  assert.match(stderr.read(), /Railway SSH could not be started/);
  assert.equal(stderr.read().includes('private environment'), false);
});

test('installer supports paths containing spaces, is idempotent, and never overwrites other commands', t => {
  const root = resolve('.'), destination = join(directory(t), 'bin with spaces');
  const install = () => spawnSync('bash', ['scripts/install-terminal-commands.sh', '--directory', destination], { cwd: root, encoding: 'utf8' });
  assert.equal(install().status, 0);
  for (const name of ['owaua', 'start', 'stop']) {
    assert.equal(lstatSync(join(destination, name)).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(destination, name)), join(root, 'scripts', name));
  }
  assert.equal(install().status, 0);
  rmSync(join(destination, 'start')); writeFileSync(join(destination, 'start'), 'another app\n');
  rmSync(join(destination, 'owaua'));
  const collision = install(); assert.equal(collision.status, 1); assert.match(collision.stderr, /different command/);
  assert.equal(readFileSync(join(destination, 'start'), 'utf8'), 'another app\n');
  assert.equal(existsSync(join(destination, 'owaua')), false, 'preflight prevents partial installation');
});

test('installed start and stop wrappers accept only literal owaua and pass the intended action across symlinks', t => {
  const root = resolve('.'), fixture = directory(t), destination = join(fixture, 'bin');
  assert.equal(spawnSync('bash', ['scripts/install-terminal-commands.sh', '--directory', destination], { cwd: root }).status, 0);
  const log = join(fixture, 'arguments');
  const fakeNode = join(destination, 'node');
  writeFileSync(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$@" > "$OWAUA_TEST_ARGUMENTS"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: destination + ':' + process.env.PATH, OWAUA_TEST_ARGUMENTS: log };
  for (const action of ['start', 'stop']) {
    assert.equal(spawnSync(join(destination, action), ['owaua'], { env }).status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [join(root, 'src/host-control.js').replace('/src/', '/scripts/../src/'), action]);
    rmSync(log);
    for (const args of [[], ['kirmy'], ['owaua', 'extra'], ['owaua;echo'], ['$(echo owaua)']]) {
      assert.equal(spawnSync(join(destination, action), args, { env }).status, 1);
      assert.equal(existsSync(log), false);
    }
  }
});
