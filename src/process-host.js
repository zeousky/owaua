import { spawn } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createControlServer, createConnection } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const actions = new Set(['start', 'stop', 'restart', 'status']);
const integer = (value, min, max, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${label}`);
  return number;
};
const safeError = message => new Error(message);

async function reclaimSocket(path) {
  let previous;
  try { previous = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!previous.isSocket() || process.getuid && previous.uid !== process.getuid()) throw safeError('The Owaua control socket path is unavailable.');
  const stale = await new Promise(resolveProbe => {
    const probe = createConnection(path);
    const finish = value => { probe.destroy(); resolveProbe(value); };
    probe.once('connect', () => finish(false));
    probe.once('error', error => finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
    probe.setTimeout(1000, () => finish(false));
  });
  if (!stale) throw safeError('An Owaua supervisor is already running.');
  let current;
  try { current = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (current.dev !== previous.dev || current.ino !== previous.ino || !current.isSocket()) throw safeError('The Owaua control socket changed. Try again.');
  rmSync(path);
}

// The host owns only one fixed bot entry point. The control socket is local to
// its operating-system user; no public HTTP route can start or stop the bot.
export function createProcessHost({ root = process.cwd(), directory, socketPath,
  port, childPort, host = '0.0.0.0', env = process.env, fetchImpl = fetch,
  spawnImpl = spawn, startupTimeoutMs = 120000, shutdownTimeoutMs = 35000,
  killTimeoutMs = 5000, restartDelayMs = 5000, maxRestartDelayMs = 30000,
  now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  onEvent = event => console.log(JSON.stringify(event)) } = {}) {
  root = resolve(root);
  directory = resolve(directory ?? env.DATA_DIR ?? join(root, 'data'));
  socketPath = resolve(socketPath ?? env.OWAUA_CONTROL_SOCKET ?? '/tmp/owaua-control.sock');
  port = integer(port ?? env.PORT ?? 3000, 0, 65535, 'host port');
  childPort = integer(childPort ?? env.OWAUA_BOT_PORT ?? (port === 3001 ? 3002 : 3001), 1, 65535, 'internal bot port');
  if (port === childPort) throw safeError('The host and internal bot ports must differ.');
  startupTimeoutMs = integer(startupTimeoutMs, 1, 3600000, 'startup timeout');
  shutdownTimeoutMs = integer(shutdownTimeoutMs, 1, 3600000, 'shutdown timeout');
  killTimeoutMs = integer(killTimeoutMs, 1, 3600000, 'termination timeout');
  restartDelayMs = integer(restartDelayMs, 1, 3600000, 'restart delay');
  maxRestartDelayMs = integer(maxRestartDelayMs, 1, 3600000, 'maximum restart delay');
  if (maxRestartDelayMs < restartDelayMs) throw safeError('Invalid restart backoff.');
  if (Buffer.byteLength(socketPath) > 100) throw safeError('The Owaua control socket path is too long.');
  const statePath = join(directory, 'host-state.json');
  let enabled = true;
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    if (saved?.version !== 1 || typeof saved.enabled !== 'boolean') throw safeError('The saved Owaua start/stop setting is invalid.');
    enabled = saved.enabled;
  } catch (error) { if (error.code !== 'ENOENT') throw safeError('The saved Owaua start/stop setting could not be read.'); }
  let child = null, childExit = null, childStartedAt = 0, stoppingChild = false;
  let closing = false, listening = false, restartTimer = null, crashCount = 0;
  let operations = Promise.resolve(), closePromise, socketOwned = false, ownedSocketStat;
  const connections = new Set(), requests = new Set(), waits = new Map();
  const emit = event => { try { onEvent({ event: 'owaua_host', ...event }); } catch {} };
  const pause = milliseconds => new Promise(resolvePause => {
    const timer = setTimeoutImpl(() => { waits.delete(timer); resolvePause(); }, milliseconds);
    waits.set(timer, resolvePause);
  });
  const cancelRestart = () => { if (restartTimer !== null) clearTimeoutImpl(restartTimer); restartTimer = null; };
  function saveEnabled(value) {
    const temporary = `${statePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, enabled: value }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, statePath);
    } catch {
      try { rmSync(temporary, { force: true }); } catch {}
      throw safeError('The Owaua start/stop setting could not be saved. Nothing was changed.');
    }
    enabled = value;
  }
  async function ready() {
    if (!enabled || !child || stoppingChild || closing) return false;
    try {
      const response = await fetchImpl(`http://127.0.0.1:${childPort}/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return false; }
      return (await response.json())?.ready === true;
    } catch { return false; }
  }
  async function status() {
    const isReady = await ready();
    return { ok: true, enabled, state: stoppingChild || closing || !enabled && child ? 'stopping' : !enabled ? 'stopped' : isReady ? 'running' : 'starting',
      pid: child?.pid ?? null, ready: isReady };
  }
  function scheduleRestart() {
    if (!enabled || closing || stoppingChild || restartTimer !== null) return;
    const delay = Math.min(maxRestartDelayMs, restartDelayMs * 2 ** Math.min(20, crashCount++));
    emit({ state: 'restarting', delayMs: delay });
    restartTimer = setTimeoutImpl(() => {
      restartTimer = null;
      if (!enabled || closing || child) return;
      try { startChild(); } catch { emit({ state: 'start_failed' }); scheduleRestart(); }
    }, delay);
    restartTimer?.unref?.();
  }
  function startChild() {
    if (child || closing || !enabled) return;
    cancelRestart();
    let spawned;
    try {
      spawned = spawnImpl(process.execPath, [join(root, 'src', 'bot.js')], {
        cwd: root, stdio: 'inherit', shell: false,
        env: { ...env, DATA_DIR: directory, PORT: String(childPort), HEALTH_HOST: '127.0.0.1' },
      });
    } catch { throw safeError('Owaua could not be started.'); }
    child = spawned; childStartedAt = now();
    let finished = false, resolveExit;
    childExit = new Promise(resolveChild => { resolveExit = resolveChild; });
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      if (child === spawned) child = null;
      resolveExit();
      if (now() - childStartedAt >= 60000) crashCount = 0;
      emit({ state: 'child_exited', code: Number.isInteger(code) ? code : null, signal: typeof signal === 'string' ? signal : null });
      scheduleRestart();
    };
    spawned.once('exit', finish);
    spawned.once('error', () => finish(null, null));
    emit({ state: 'starting', pid: spawned.pid ?? null });
  }
  async function waitExit(exit, milliseconds) {
    let timer;
    try {
      return await Promise.race([exit.then(() => true), new Promise(resolveTimeout => {
        timer = setTimeoutImpl(() => resolveTimeout(false), milliseconds);
      })]);
    } finally { if (timer !== undefined) clearTimeoutImpl(timer); }
  }
  async function stopChild() {
    cancelRestart();
    if (!child) return;
    const current = child, exited = childExit;
    stoppingChild = true;
    try {
      try { current.kill('SIGTERM'); } catch {}
      if (!await waitExit(exited, shutdownTimeoutMs)) {
        emit({ state: 'forcing_stop', pid: current.pid ?? null });
        try { current.kill('SIGKILL'); } catch {}
        if (!await waitExit(exited, killTimeoutMs)) throw safeError('Owaua has not exited. A second bot was not started.');
      }
    } finally { stoppingChild = false; }
  }
  async function waitReady() {
    const deadline = now() + startupTimeoutMs;
    while (!closing && enabled && now() < deadline) {
      if (await ready()) { crashCount = 0; return; }
      await pause(250);
    }
    throw safeError(closing ? 'Owaua is shutting down.' : !enabled
      ? 'Owaua start was cancelled because it was stopped.' : 'Owaua did not become ready. Check its Railway logs.');
  }
  function action(name) {
    if (!actions.has(name)) return Promise.reject(safeError('Use start, stop, restart, or status.'));
    if (name === 'status') return status();
    const run = async () => {
      if (closing || !listening) throw safeError('The Owaua supervisor is not available.');
      if (name === 'stop') {
        saveEnabled(false); await stopChild(); emit({ state: 'stopped' });
      } else {
        saveEnabled(true);
        if (name === 'restart') await stopChild();
        startChild();
      }
      return name !== 'stop';
    };
    const operation = operations.then(run);
    operations = operation.catch(() => {});
    // Readiness is deliberately outside the mutation queue: a stop must be
    // able to cancel a slow Discord login instead of waiting two minutes.
    return operation.then(async shouldWait => {
      if (shouldWait) await waitReady();
      return status();
    });
  }
  const controlServer = createControlServer(connection => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.setTimeout(5000, () => connection.destroy());
    let buffer = '', handling = false;
    const reply = value => { if (!connection.destroyed) connection.end(JSON.stringify(value) + '\n'); };
    connection.on('data', chunk => {
      if (handling) return;
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 1024) { handling = true; reply({ ok: false, error: 'Invalid Owaua control request.' }); return; }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      handling = true; connection.setTimeout(0);
      let request;
      try {
        request = JSON.parse(buffer.slice(0, end));
        if (!request || Object.keys(request).join(',') !== 'action' || !actions.has(request.action)) throw new Error();
      } catch { reply({ ok: false, error: 'Use start, stop, restart, or status.' }); return; }
      void action(request.action).then(reply, error => reply({ ok: false, error: error.message }));
    });
  });
  const server = createHttpServer(async (request, response) => {
    const json = (code, value) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.url === '/live') {
      if (request.method !== 'GET' && request.method !== 'HEAD') { json(405, { error: 'Method not allowed' }); return; }
      const childReady = enabled && !closing ? await ready() : false;
      json(!closing && (!enabled && !child && !stoppingChild || childReady) ? 200 : 503, { live: !closing, enabled, ready: childReady }); return;
    }
    if (!enabled || !child || stoppingChild || closing) {
      json(503, { ready: false, state: stoppingChild || !enabled && child ? 'stopping' : !enabled ? 'stopped' : 'starting' }); return;
    }
    // Preserve extension routes and request bodies, always to the fixed child.
    const upstream = httpRequest({ hostname: '127.0.0.1', port: childPort, path: request.url,
      method: request.method, headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    requests.add(upstream);
    upstream.once('close', () => requests.delete(upstream));
    upstream.on('error', () => { if (!response.headersSent) json(503, { ready: false, state: 'starting' }); else response.destroy(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  for (const target of [server, controlServer]) target.on('error', () => {
    if (!listening || closing) return;
    emit({ state: 'host_server_failed' });
    void close().catch(() => emit({ state: 'shutdown_failed' }));
  });
  async function listen() {
    if (listening || closing) throw safeError('The Owaua supervisor cannot be started twice.');
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    await reclaimSocket(socketPath);
    await new Promise((resolveListen, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(socketPath, () => { controlServer.off('error', reject); resolveListen(); });
    });
    socketOwned = true;
    try {
      chmodSync(socketPath, 0o600);
      ownedSocketStat = lstatSync(socketPath);
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolveListen(); });
      });
      listening = true;
      if (enabled) { try { startChild(); } catch { emit({ state: 'start_failed' }); scheduleRestart(); } }
      emit({ state: 'host_ready', enabled });
      return api;
    } catch (error) { await close(); throw error; }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true; cancelRestart();
    closePromise = (async () => {
      for (const [timer, resolvePause] of waits) { clearTimeoutImpl(timer); resolvePause(); }
      waits.clear();
      // Retain the exclusive control socket until the child has actually
      // exited. Releasing it first would let another host start a second bot.
      // Failed termination deliberately leaves ownership in place.
      await stopChild();
      for (const request of requests) request.destroy();
      for (const connection of connections) connection.destroy();
      const closeServer = target => new Promise(resolveClosed => {
        if (!target.listening) return resolveClosed();
        target.close(() => resolveClosed()); target.closeAllConnections?.();
      });
      await Promise.all([closeServer(server), closeServer(controlServer)]);
      if (socketOwned) {
        try {
          const current = lstatSync(socketPath);
          if (current.dev === ownedSocketStat.dev && current.ino === ownedSocketStat.ino) rmSync(socketPath);
        } catch {}
        socketOwned = false;
      }
      listening = false;
      emit({ state: 'host_stopped' });
    })();
    return closePromise;
  }
  const api = { listen, action, status, close, server, controlServer, socketPath, statePath };
  return api;
}
