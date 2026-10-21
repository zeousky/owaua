import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { MusicManager, parseMusicCommand, searchTarget, resolveTrack, streamTrack, audioDiagnostic } from '../src/music.js';

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
test('SoundCloud links are restricted to canonical public track paths', () => {
  assert.equal(searchTarget('https://soundcloud.com/artist/song?utm_source=abc'), 'https://soundcloud.com/artist/song');
  for (const url of ['https://soundcloud.com/artist/sets/list', 'https://soundcloud.com/artist/sets',
    'https://soundcloud.com.evil/artist/song', 'https://user@soundcloud.com/artist/song',
    'http://soundcloud.com/artist/song', 'https://soundcloud.com:123/artist/song']) assert.throws(() => searchTarget(url));
});
test('song-name search falls back to SoundCloud when YouTube blocks extraction', async () => {
  const inputs = [];
  const track = await resolveTrack('go away', undefined, async (exe, args) => {
    inputs.push(args.at(-1));
    if (inputs.length === 1) throw new Error('Sign in to confirm you are not a bot');
    return { stdout: JSON.stringify({ entries: [{ extractor: 'soundcloud', title: 'Artist - Go Away',
      duration: 180, webpage_url: 'https://soundcloud.com/artist/go-away' }] }) };
  });
  assert.deepEqual(inputs, ['ytsearch1:go away', 'scsearch1:go away']);
  assert.equal(track.source, 'SoundCloud');
  assert.equal(track.url, 'https://soundcloud.com/artist/go-away');
});
test('exact YouTube links and aborted requests never silently search another source', async () => {
  for (const [query, signal] of [['https://youtu.be/abcdefghijk', undefined], ['go away', { aborted: true }]]) {
    let count = 0;
    await assert.rejects(resolveTrack(query, signal, async () => { count++; throw new Error('blocked'); }), /blocked/);
    assert.equal(count, 1);
  }
});
test('resolver rejects live streams, long tracks, and unexpected SoundCloud destinations', async () => {
  for (const info of [
    { id: 'abcdefghijk', is_live: true, duration: 60 },
    { id: 'abcdefghijk', duration: 3601 },
    { extractor: 'soundcloud', duration: 60, webpage_url: 'https://localhost/private' },
  ]) {
    await assert.rejects(resolveTrack('https://youtu.be/abcdefghijk', undefined, async () => ({ stdout: JSON.stringify(info) })));
  }
});
test('a YouTube stream failure retries SoundCloud before the next queued song', async () => {
  const f = fixture(async query => ({ title: query, source: 'YouTube', fallbackQuery: query, duration: 60 }));
  const failures = [];
  f.manager.stream = (track, fail) => { failures.push(fail); return { resource: {}, close() {} }; };
  let retries = 0;
  f.manager.fallback = async query => { retries++; return { title: query + ' fallback', source: 'SoundCloud', duration: 60 }; };
  await f.manager.handle(f.message, { action: 'play', query: 'first' });
  await f.manager.handle(f.message, { action: 'play', query: 'second' });
  failures[0](new Error('429'));
  failures[0](new Error('duplicate')); await tick();
  assert.equal(retries, 1);
  assert.equal(f.manager.sessions.get('guild').current.title, 'first fallback');
  assert.equal(f.manager.sessions.get('guild').queue[0].title, 'second');
  failures[1](new Error('SoundCloud failed')); await tick();
  assert.equal(retries, 1);
  assert.equal(f.manager.sessions.get('guild').current.title, 'second');
  f.manager.close();
});
test('stop and skip cancel a pending streaming fallback without late playback', async () => {
  for (const action of ['skip', 'stop']) {
    const f = fixture(async query => ({ title: query, source: 'YouTube', fallbackQuery: query, duration: 60 }));
    let fail, finish, signal;
    f.manager.stream = (track, callback) => { fail = callback; return { resource: {}, close() {} }; };
    f.manager.fallback = (query, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); };
    await f.manager.handle(f.message, { action: 'play', query: 'first' });
    fail(new Error('blocked')); await tick();
    await f.manager.handle(f.message, { action });
    assert.equal(signal.aborted, true);
    finish({ title: 'late fallback', duration: 60 }); await tick();
    assert.ok(!f.manager.sessions.get('guild')?.current);
    f.manager.close();
  }
});
test('explicit SoundCloud resolution bypasses YouTube and cannot recursively fall back', async () => {
  const inputs = [];
  const track = await resolveTrack('go away', undefined, async (exe, args) => {
    inputs.push(args.at(-1));
    return { stdout: JSON.stringify({ extractor: 'soundcloud', title: 'Go Away', duration: 180,
      webpage_url: 'https://soundcloud.com/artist/go-away' }) };
  }, 'soundcloud');
  assert.deepEqual(inputs, ['scsearch1:go away']);
  assert.equal(track.fallbackQuery, undefined);
});
test('extractor failure reports bounded diagnostics and kills both child processes', async () => {
  const children = [];
  const launch = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    children.push(child); return child;
  };
  let reported;
  const audio = streamTrack({ url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 10 }, error => { reported = error; }, launch);
  children[0].stderr.write('ERROR: HTTP Error 429 https://media.example/audio?secret=token');
  children[0].emit('close', 1);
  assert.equal(reported.stage, 'extractor');
  assert.equal(reported.code, 1);
  assert.match(reported.detail, /429/);
  assert.ok(!reported.detail.includes('secret'));
  assert.ok(children.every(child => child.killed));
  assert.ok(audioDiagnostic('x'.repeat(10000)).length <= 800);
  audio.close();
  await tick();
});

test('HLS fragment files are writable, isolated between streams, and removed after child exit', async () => {
  const children = [], directories = [];
  const launch = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    if (children.length % 2 === 0) {
      assert.ok(args.includes('--abort-on-unavailable-fragments'));
      directories.push(options.cwd);
      // yt-dlp uses this same relative filename even when streaming to stdout.
      writeFileSync(join(options.cwd, '--Frag1.part'), String(directories.length));
    }
    children.push(child);
    return child;
  };
  const track = { url: 'https://soundcloud.com/artist/song', duration: 60 };
  const first = streamTrack(track, assert.fail, launch);
  const second = streamTrack(track, assert.fail, launch);
  assert.notEqual(directories[0], directories[1]);
  assert.equal(readFileSync(join(directories[0], '--Frag1.part'), 'utf8'), '1');
  assert.equal(readFileSync(join(directories[1], '--Frag1.part'), 'utf8'), '2');
  first.close();
  assert.ok(children[0].killed && children[1].killed);
  children[0].emit('close', null);
  assert.ok(existsSync(directories[0]), 'wait for both children before removing files');
  children[1].emit('close', null);
  assert.equal(existsSync(directories[0]), false);
  assert.ok(existsSync(directories[1]));
  children[2].emit('close', 0); children[3].emit('close', 0);
  assert.equal(existsSync(directories[1]), false);
  second.close();
});

test('encoder startup failure terminates the downloader and cleans its fragments', () => {
  let directory, child;
  const launch = (file, args, options) => {
    if (child) throw new Error('spawn failed');
    directory = options.cwd;
    writeFileSync(join(directory, '--Frag1.part'), 'partial');
    child = new EventEmitter();
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    return child;
  };
  assert.throws(() => streamTrack({ duration: 60 }, assert.fail, launch), /spawn failed/);
  assert.equal(child.killed, true);
  child.emit('close', null);
  assert.equal(existsSync(directory), false);
});
