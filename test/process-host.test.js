import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessHost } from '../src/process-host.js';
import { requestHostControl } from '../src/host-control.js';

const worker = `import { createServer } from 'node:http';
const server = createServer((req,res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ready:process.env.TEST_READY !== 'false'})); return; }
  if (req.url === '/crash') { res.end('done'); setTimeout(()=>process.exit(2),10); return; }
  let body=''; req.on('data',part=>body+=part); req.on('end',()=>{res.writeHead(201,{'content-type':'application/json','x-child':'yes'});res.end(JSON.stringify({pid:process.pid,method:req.method,url:req.url,body,header:req.headers['x-test']}));});
});
server.listen(Number(process.env.PORT),'127.0.0.1');
process.on('SIGTERM',()=>{if(process.env.TEST_IGNORE_TERM==='true')return;setTimeout(()=>server.close(()=>process.exit(0)),Number(process.env.TEST_TERM_DELAY??0));});`;
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('The expected worker state was not reached.');
}
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oh-'));
  const workerPath = join(root, 'worker.mjs'); writeFileSync(workerPath, worker);
  const childPort = await freePort(), children = [], active = new Set(), events = [];
  let maximumActive = 0;
  const settings = { root, directory: join(root, 'data'), socketPath: join(root, 'host.sock'), host: '127.0.0.1', port: 0, childPort,
    env: {}, startupTimeoutMs: 2500, shutdownTimeoutMs: 700, killTimeoutMs: 700, restartDelayMs: 40, maxRestartDelayMs: 100,
    onEvent: event => events.push(event), ...options,
    spawnImpl: (executable, args, config) => {
      assert.equal(executable, process.execPath); assert.equal(args[0], join(root, 'src', 'bot.js'));
      assert.equal(config.shell, false); assert.equal(config.env.HEALTH_HOST, '127.0.0.1');
      const child = spawn(process.execPath, [workerPath], { ...config, stdio: 'ignore' });
      children.push(child); active.add(child); maximumActive = Math.max(maximumActive, active.size);
      child.once('exit', () => active.delete(child));
      return child;
    } };
  const hosts = [];
  const make = () => { const host = createProcessHost(settings); hosts.push(host); return host; };
  const host = make();
  t.after(async () => {
    for (const current of hosts) await current.close().catch(() => {});
    for (const child of active) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
    rmSync(root, { force: true, recursive: true });
  });
  await host.listen();
  return { host, make, settings, root, children, events, active, maximumActive: () => maximumActive,
    url: () => `http://127.0.0.1:${host.server.address().port}`,
    rpc: action => requestHostControl(action, { socketPath: settings.socketPath, timeoutMs: 5000 }) };
}

test('managed host proxies existing HTTP routes and starts only one child for repeated start commands', async t => {
  const f = await fixture(t);
  await Promise.all([f.rpc('start'), f.rpc('start')]);
  assert.equal(f.children.length, 1); assert.equal(f.maximumActive(), 1);
  assert.equal(statSync(f.settings.socketPath).mode & 0o777, 0o600);
  const health = await fetch(f.url() + '/health'); assert.equal(health.status, 200); assert.equal((await health.json()).ready, true);
  const response = await fetch(f.url() + '/extension?query=value', { method: 'POST', headers: { 'x-test': 'preserved' }, body: 'test body' });
  assert.equal(response.status, 201); assert.equal(response.headers.get('x-child'), 'yes');
  assert.deepEqual(await response.json(), { pid: f.children[0].pid, method: 'POST', url: '/extension?query=value', body: 'test body', header: 'preserved' });
  const forbidden = await fetch(f.url() + '/live', { method: 'POST' }); assert.equal(forbidden.status, 405);
  await assert.rejects(f.rpc('arbitrary-command'), /Use start/);
});

test('stop is durable, retains terminal liveness, and restart never overlaps Discord child processes', async t => {
  const f = await fixture(t); await f.rpc('start');
  const oldPid = f.children[0].pid;
  const stopped = await f.rpc('stop'); assert.equal(stopped.state, 'stopped'); assert.equal(stopped.pid, null);
  assert.equal(f.active.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.host.statePath, 'utf8')), { version: 1, enabled: false });
  assert.equal((await fetch(f.url() + '/live')).status, 200);
  assert.equal((await fetch(f.url() + '/health')).status, 503);
  await new Promise(resolve => setTimeout(resolve, 130)); assert.equal(f.children.length, 1);
  const started = await f.rpc('start'); assert.equal(started.state, 'running'); assert.notEqual(started.pid, oldPid);
  const restarted = await f.rpc('restart'); assert.notEqual(restarted.pid, started.pid);
  assert.equal(f.children.length, 3); assert.equal(f.maximumActive(), 1);
  await f.rpc('stop'); await f.host.close();
  const replacement = f.make(); await replacement.listen();
  assert.equal((await replacement.status()).state, 'stopped'); assert.equal(f.children.length, 3);
  assert.equal((await fetch(`http://127.0.0.1:${replacement.server.address().port}/live`)).status, 200);
});

test('container shutdown preserves enabled intent and keeps the singleton barrier until the old child exits', async t => {
  const f = await fixture(t, { env: { TEST_TERM_DELAY: '250' } }); await f.rpc('start');
  const closing = f.host.close();
  const competing = f.make(); await assert.rejects(competing.listen(), /already running/);
  assert.equal(f.children.length, 1);
  await closing;
  assert.deepEqual(JSON.parse(readFileSync(f.host.statePath, 'utf8')), { version: 1, enabled: true });
  const replacement = f.make(); await replacement.listen(); await replacement.action('start');
  assert.equal(f.children.length, 2); assert.equal(f.maximumActive(), 1);
});

test('a stop command cancels a pending start without waiting for the readiness deadline', async t => {
  const f = await fixture(t, { env: { TEST_READY: 'false' }, startupTimeoutMs: 4000 });
  const starting = assert.rejects(f.rpc('start'), /cancelled.*stopped/);
  await until(async () => (await f.host.status()).pid !== null);
  const before = Date.now(); const stopped = await f.rpc('stop');
  await starting; assert.equal(stopped.state, 'stopped'); assert.ok(Date.now() - before < 2000);
  assert.equal(f.children.length, 1); assert.equal(f.active.size, 0);
});

test('unexpected crashes retry with one child and intentional stop cancels future retries', async t => {
  const f = await fixture(t); await f.rpc('start');
  await fetch(f.url() + '/crash');
  await until(() => f.children.length === 2); await f.rpc('start');
  assert.equal(f.maximumActive(), 1);
  assert.equal(f.events.some(event => event.state === 'restarting'), true);
  await f.rpc('stop'); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.children.length, 2); assert.equal(f.active.size, 0);
});

test('unresponsive children are terminated before a replacement can start', async t => {
  const f = await fixture(t, { env: { TEST_IGNORE_TERM: 'true' }, shutdownTimeoutMs: 70 }); await f.rpc('start');
  await f.rpc('restart');
  assert.equal(f.children[0].signalCode, 'SIGKILL'); assert.equal(f.maximumActive(), 1);
  assert.equal(f.events.some(event => event.state === 'forcing_stop'), true);
});
