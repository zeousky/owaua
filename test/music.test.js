import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { MusicManager, parseMusicCommand, searchTarget } from '../src/music.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(resolve = async query => ({ title: query, url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 60 })) {
  const sent = [];
  let closed = 0;
  const player = new EventEmitter();
  player.state = { status: AudioPlayerStatus.Idle };
  player.play = resource => { player.resource = resource; player.state.status = AudioPlayerStatus.Playing; };
  player.stop = () => { player.state.status = AudioPlayerStatus.Idle; player.emit(AudioPlayerStatus.Idle); };
  player.pause = () => { player.state.status = AudioPlayerStatus.Paused; return true; };
  player.unpause = () => { player.state.status = AudioPlayerStatus.Playing; return true; };
  const connection = new EventEmitter();
  connection.state = { status: VoiceConnectionStatus.Ready };
  connection.subscribe = () => {};
  connection.destroy = () => { connection.state.status = VoiceConnectionStatus.Destroyed; connection.emit(VoiceConnectionStatus.Destroyed); };
  const manager = new MusicManager({ resolve, player: () => player, join: () => connection,
    wait: async () => {}, stream: () => ({ resource: {}, close: () => closed++ }), idleMs: 15 });
  const voice = { id: 'voice', type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }) };
  const member = { voice: { channel: voice, channelId: voice.id } };
  const message = { guildId: 'guild', author: { id: 'user' }, guild: { voiceAdapterCreator: {},
    members: { me: {}, fetch: async () => member } },
    channel: { send: async payload => sent.push(payload.content) }, reply: async payload => sent.push(payload.content) };
  return { manager, player, connection, message, sent, member, voice, closed: () => closed };
}

test('music prefix matches without a mention and preserves song queries', () => {
  assert.deepEqual(parseMusicCommand('.music go away'), { action: 'play', query: 'go away' });
  assert.deepEqual(parseMusicCommand('.MuSiC play go away'), { action: 'play', query: 'go away' });
  assert.deepEqual(parseMusicCommand('.music'), { action: 'help' });
  assert.deepEqual(parseMusicCommand('.music STOP'), { action: 'stop' });
  assert.equal(parseMusicCommand('.musical go away'), null);
});
test('only canonical YouTube video URLs reach the extractor', () => {
  assert.equal(searchTarget('go away'), 'ytsearch1:go away');
  assert.equal(searchTarget('--exec rm'), 'ytsearch1:--exec rm');
  assert.equal(searchTarget('https://youtu.be/abcdefghijk?t=2'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(searchTarget('https://youtube.com/watch?v=abcdefghijk&list=other'), 'https://www.youtube.com/watch?v=abcdefghijk');
  for (const query of ['https://localhost/a', 'https://youtube.com.evil/a', 'https://youtube.com:123/watch?v=abcdefghijk',
    'https://youtube.com/playlist?list=x', 'https://user@youtube.com/watch?v=abcdefghijk', 'x'.repeat(301)]) {
    assert.throws(() => searchTarget(query));
  }
});
test('songs queue, skip advances, and stop releases resources', async () => {
  const f = fixture();
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  await f.manager.handle(f.message, { action: 'play', query: 'second' });
  assert.equal(f.manager.sessions.get('guild').queue.length, 1);
  await f.manager.handle(f.message, { action: 'skip' }); await tick();
  assert.equal(f.manager.sessions.get('guild').current.title, 'second');
  assert.equal(f.closed(), 1);
  await f.manager.handle(f.message, { action: 'stop' });
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.closed(), 2);
  assert.equal(f.connection.state.status, VoiceConnectionStatus.Destroyed);
});
test('another voice channel cannot enqueue or stop playback', async () => {
  const f = fixture();
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  f.member.voice.channel = { ...f.voice, id: 'other' };
  await f.manager.handle(f.message, { action: 'stop' });
  assert.equal(f.manager.sessions.size, 1);
  assert.match(f.sent.at(-1), /another voice channel/);
  f.manager.close();
});
test('stop during a search aborts it and prevents late playback', async () => {
  let finish, signal;
  const f = fixture((query, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); });
  const search = f.manager.handle(f.message, { action: 'play', query: 'first' });
  await tick();
  await f.manager.handle(f.message, { action: 'play', query: 'second' });
  assert.match(f.sent.at(-1), /still finding/);
  await f.manager.handle(f.message, { action: 'stop' });
  assert.equal(signal.aborted, true);
  finish({ title: 'late' }); await search;
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.player.resource, undefined);
});
test('permissions are checked before joining and DMs are rejected', async () => {
  const f = fixture();
  f.voice.permissionsFor = () => ({ has: () => false });
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  assert.equal(f.manager.sessions.size, 0);
  assert.match(f.sent.at(-1), /Connect, and Speak/);
  await f.manager.handle({ ...f.message, guild: null }, { action: 'play', query: 'first' });
  assert.match(f.sent.at(-1), /server voice channels/);
});
test('empty queue disconnects after idle timeout', async () => {
  const f = fixture();
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  f.player.stop();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.manager.sessions.size, 0);
  assert.equal(f.closed(), 1);
});
test('leaving the voice channel during a search prevents playback', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const search = f.manager.handle(f.message, { action: 'play', query: 'first' });
  await tick();
  f.member.voice.channelId = null;
  finish({ title: 'late' }); await search;
  assert.equal(f.player.resource, undefined);
  assert.ok(f.sent.some(text => /Stay in the voice channel/.test(text)));
  f.manager.close();
});
test('last human leaving and bot being moved both dispose the session', async () => {
  for (const moved of [false, true]) {
    const f = fixture();
    await f.manager.handle(f.message, { action: 'play', query: 'first' });
    f.manager.voiceStateUpdate({ channelId: 'voice' }, { id: moved ? 'bot' : 'user', channelId: moved ? 'other' : null,
      client: { user: { id: 'bot' } }, guild: { id: 'guild', channels: { cache: new Map([['voice', { members: { some: () => false } }]]) } } });
    assert.equal(f.manager.sessions.size, 0);
    assert.equal(f.closed(), 1);
  }
});
test('skip while paused forces the player to advance', async () => {
  const f = fixture();
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  await f.manager.handle(f.message, { action: 'play', query: 'second' });
  await f.manager.handle(f.message, { action: 'pause' });
  f.player.stop = force => {
    assert.equal(force, true);
    f.player.state.status = AudioPlayerStatus.Idle; f.player.emit(AudioPlayerStatus.Idle);
  };
  await f.manager.handle(f.message, { action: 'skip' }); await tick();
  assert.equal(f.manager.sessions.get('guild').current.title, 'second');
  f.manager.close();
});
test('failed audio source advances to the next song exactly once', async () => {
  const f = fixture();
  const failures = [];
  f.manager.stream = (track, fail) => { failures.push(fail); return { resource: {}, close() {} }; };
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  await f.manager.handle(f.message, { action: 'play', query: 'second' });
  await f.manager.handle(f.message, { action: 'play', query: 'third' });
  failures[0](new Error('unavailable')); await tick();
  assert.equal(f.manager.sessions.get('guild').current.title, 'second');
  failures[0](new Error('late error')); await tick();
  assert.equal(f.manager.sessions.get('guild').current.title, 'second');
  f.manager.close();
});
