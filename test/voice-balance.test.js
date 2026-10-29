import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { RealtimeVoice, VoiceManager } from '../src/voice.js';
import { ProviderRouter } from '../src/providers.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const guildA = '100000000000000001', guildB = '100000000000000002', actor = '100000000000000003';
const secret = 'fixture-private-realtime-api-key';
const rawError = { code: 'insufficient_balance', message: `Insufficient balance. ${secret} private-user-audio` };
class FakeSocket extends EventEmitter {
  static instances = [];
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; FakeSocket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
  event(value) { this.emit('message', JSON.stringify(value), false); }
}
function realtime() {
  const voice = new RealtimeVoice({ apiKey: secret, WebSocketImpl: FakeSocket });
  const socket = FakeSocket.instances.at(-1), failures = [], audio = [];
  voice.on('failure', error => failures.push(error)); voice.on('audio', bytes => audio.push(bytes));
  return { voice, socket, failures, audio };
}
async function ready(f) {
  f.socket.emit('open'); f.socket.event({ type: 'session.updated' }); await f.voice.opened;
}

test('realtime balance error events are normalized without exposing content or retrying the session', async () => {
  const before = FakeSocket.instances.length, f = realtime();
  f.socket.event({ type: 'error', error: rawError });
  await assert.rejects(f.voice.opened, error => error.code === 'insufficient_balance' && error.provider === 'xai' && error.replaySafe === false);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].message.includes(secret), false);
  assert.equal(f.failures[0].message.includes('private-user-audio'), false);
  assert.equal(f.voice.closed, true); assert.equal(f.socket.terminated, true);
  f.socket.event({ type: 'error', error: rawError });
  assert.equal(f.failures.length, 1); assert.equal(FakeSocket.instances.length, before + 1);
});

test('matching failed responses classify both documented error envelopes and discard buffered audio', async () => {
  for (const field of ['error', 'status_details']) {
    const f = realtime(); await ready(f);
    f.voice.commit(); f.socket.event({ type: 'response.created', response: { id: 'answer' } });
    f.socket.event({ type: 'response.output_audio.delta', response_id: 'answer', delta: 'AAA=' });
    const details = field === 'error' ? { error: rawError } : { status_details: { type: 'failed', error: rawError } };
    f.socket.event({ type: 'response.done', response: { id: 'unrelated', status: 'failed', ...details } });
    assert.equal(f.failures.length, 0, 'a different response cannot end this turn');
    f.socket.event({ type: 'response.done', response: { id: 'answer', status: 'failed', ...details } });
    assert.equal(f.failures[0].code, 'insufficient_balance');
    assert.equal(f.failures[0].message.includes(secret), false);
    assert.equal(f.voice.outputBytes, 0); assert.equal(f.voice.transcripts.size, 0);
    assert.deepEqual(f.audio, []); assert.equal(f.voice.closed, true);
  }
});

test('unrelated realtime errors retain the existing sanitized error codes', async () => {
  const first = realtime();
  first.socket.event({ type: 'error', error: { message: secret, code: 'invalid_request' } });
  await assert.rejects(first.voice.opened, error => error.code === 'voice_provider_error');
  const second = realtime(); await ready(second);
  second.voice.commit(); second.socket.event({ type: 'response.created', response: { id: 'answer' } });
  second.socket.event({ type: 'response.done', response: { id: 'answer', status: 'failed', error: { message: secret } } });
  assert.equal(second.failures[0].code, 'voice_response_failed');
});

test('HTTP 402 and bounded HTTP 403 handshake failures classify credit errors without another connection', async () => {
  for (const statusCode of [402, 403]) {
    const before = FakeSocket.instances.length, f = realtime(), incoming = new PassThrough();
    incoming.statusCode = statusCode;
    f.socket.emit('unexpected-response', {}, incoming);
    if (statusCode !== 402) incoming.end(JSON.stringify({ error: rawError }));
    await assert.rejects(f.voice.opened, error => error.status === statusCode && error.code === 'insufficient_balance');
    assert.equal(f.failures.length, 1); assert.equal(f.failures[0].message.includes(secret), false);
    assert.equal(incoming.destroyed, true); assert.equal(FakeSocket.instances.length, before + 1);
  }
});

test('oversize and ordinary handshake errors remain bounded and private', async () => {
  const f = realtime(), incoming = new PassThrough(); incoming.statusCode = 403;
  f.socket.emit('unexpected-response', {}, incoming);
  incoming.end(Buffer.from(secret.repeat(2000)));
  await assert.rejects(f.voice.opened, error => error.code === 'voice_connection_failed' && !error.message.includes(secret));
  assert.equal(incoming.destroyed, true); assert.equal(f.failures.length, 1);
});

function managerFixture(t, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'owaua-voice-balance-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const router = new ProviderRouter({ directory, providers: {
    xai: { apiKey: secret, model: 'grok-4.7' }, mistral: { apiKey: 'fixture-mistral-key', model: 'mistral-large-4' },
  } });
  const sockets = [], sent = [], reports = [];
  let joins = 0, manager;
  const channel = { id: 'voice-a', type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }) };
  const member = { voice: { channel, channelId: channel.id } };
  const message = { guildId: guildA, author: { id: actor },
    guild: { members: { me: {}, fetch: async () => member }, voiceAdapterCreator: {} },
    channel: { send: async payload => sent.push(payload) }, reply: async payload => sent.push(payload) };
  manager = new VoiceManager({ apiKey: secret, onProviderError: (error, context) => {
    reports.push({ error, context, wasActive: manager.sessions.has(context.guildId) });
    router.withScope(context, () => router.reportFailure(error, 'xai'));
    return callback?.();
  }, realtime: options => {
    const voice = new RealtimeVoice({ ...options, WebSocketImpl: FakeSocket });
    sockets.push(FakeSocket.instances.at(-1)); return voice;
  }, player: () => Object.assign(new EventEmitter(), { play() {}, stop() {} }), resource: stream => stream,
  join: () => {
    joins++;
    const connection = Object.assign(new EventEmitter(), { state: { status: VoiceConnectionStatus.Ready }, subscribe() {},
      receiver: { speaking: new EventEmitter() } });
    connection.destroy = () => { connection.state.status = VoiceConnectionStatus.Destroyed; connection.emit(VoiceConnectionStatus.Destroyed); };
    return connection;
  }, wait: async () => {} });
  t.after(() => manager.close());
  return { manager, router, message, reports, sockets, sent, joins: () => joins };
}

test('voice billing callbacks use saved guild and actor outside join context, report once before disposal, and never restart voice', async t => {
  const f = managerFixture(t), joining = f.router.withScope({ guildId: guildA, userId: actor },
    () => f.manager.handle(f.message, { action: 'join' }));
  await tick();
  const socket = f.sockets[0]; socket.emit('open'); socket.event({ type: 'session.updated' }); await joining;
  f.router.withScope({ guildId: guildB, userId: actor }, () => socket.event({ type: 'error', error: rawError }));
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].context, { guildId: guildA, userId: actor });
  assert.equal(f.reports[0].wasActive, true);
  assert.equal(f.router.withScope({ guildId: guildA, userId: actor }, () => f.router.provider), 'mistral');
  assert.equal(f.router.withScope({ guildId: guildB, userId: actor }, () => f.router.provider), 'xai');
  assert.equal(f.router.provider, 'xai'); assert.deepEqual(f.router.recoveryProviders(), ['xai']);
  assert.equal(f.manager.sessions.size, 0); assert.equal(f.joins(), 1); assert.equal(f.sockets.length, 1);
  socket.event({ type: 'error', error: rawError }); socket.emit('close');
  await tick(); assert.equal(f.reports.length, 1); assert.equal(f.joins(), 1);
  assert.equal(JSON.stringify(f.sent).includes(secret), false);
});

test('synchronous and asynchronous failure-observer errors cannot prevent voice cleanup', async t => {
  for (const callback of [() => { throw new Error('Observer failed'); }, () => Promise.reject(new Error('Observer failed'))]) {
    const f = managerFixture(t, callback), joining = f.manager.handle(f.message, { action: 'join' });
    await tick(); const socket = f.sockets[0];
    socket.emit('open'); socket.event({ type: 'session.updated' }); await joining;
    socket.event({ type: 'error', error: rawError }); await tick();
    assert.equal(f.reports.length, 1); assert.equal(f.manager.sessions.size, 0); assert.equal(socket.terminated, true);
  }
});
