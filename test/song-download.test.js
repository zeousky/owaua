import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { SongDownloads, SongInputError, parseSongRequest, encodeSong, songResult, MAX_SONG_BYTES } from '../src/song-download.js';
import { AICore } from '../src/ai.js';
import { resultReply } from '../src/reply.js';
import { createTools } from '../src/tools.js';

const track = { title: 'Artist - Взрываюсь', duration: 180, url: 'https://soundcloud.com/artist/song' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('the screenshot request and MP3 command select downloads while music discussion stays in chat', () => {
  assert.deepEqual(parseSongRequest('can you attach an MP3 of this song: Взрываюсь LOL'), { query: 'Взрываюсь LOL' });
  for (const text of ['.mp3 Artist - Song', 'please send me an mp3 of Artist - Song', 'get the MP3 for Artist - Song']) {
    assert.deepEqual(parseSongRequest(text), { query: 'Artist - Song' });
  }
  assert.deepEqual(parseSongRequest('.mp3'), { query: '' });
  for (const text of ['what is MP3?', 'recommend a song', '.music Artist - Song', 'explain how to attach an MP3', 'do not send an MP3 of Song']) {
    assert.equal(parseSongRequest(text), null);
  }
});

test('downloads attach actual MP3 bytes with source attribution and a safe Unicode filename', async () => {
  const bytes = Buffer.from('ID3-audio');
  const songs = new SongDownloads({ resolve: async () => ({ ...track, title: '../Artist / Взрываюсь' }), encode: async () => bytes });
  const song = await songs.download('Взрываюсь');
  const payload = resultReply(songResult(song));
  assert.equal(payload.files[0].attachment, bytes);
  assert.equal(payload.files[0].name, 'Artist  Взрываюсь.mp3');
  assert.equal(payload.files[0].contentType, 'audio/mpeg');
  assert.match(payload.content, /https:\/\/soundcloud.com\/artist\/song/);
  assert.equal(songs.active, 0);
});

test('invalid sources, long songs and cancellation cannot begin encoding', async () => {
  let encodes = 0;
  const songs = new SongDownloads({ resolve: async () => ({ ...track, duration: 601 }), encode: async () => { encodes++; } });
  await assert.rejects(songs.download('https://localhost/private'), SongInputError);
  await assert.rejects(songs.download('song'), /10 minutes/);
  await assert.rejects(songs.download('song', { signal: AbortSignal.abort() }), /cancelled/);
  assert.equal(encodes, 0);
  assert.equal(songs.active, 0);
  await assert.rejects(songs.download(''), /\.mp3/);
});

test('downloads bound concurrent work and do not expose extractor diagnostics', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const songs = new SongDownloads({ resolve: async () => { await pending; throw new Error('secret source URL'); } });
  const tasks = Array.from({ length: 3 }, () => assert.rejects(songs.download('song'), error => !error.message.includes('secret')));
  await assert.rejects(songs.download('fourth'), /few songs/);
  finish(); await Promise.all(tasks);
  assert.equal(songs.active, 0);
});

function processes() {
  const children = [];
  const launch = (exe, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { exe, args, options, stdin: new PassThrough(), stdout: new PassThrough() });
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    children.push(child);
    return child;
  };
  return { children, launch };
}

test('MP3 encoding reuses resolved metadata, waits for both successful exits and removes scratch files', async () => {
  const { children, launch } = processes();
  const downloadInfo = { extractor: 'soundcloud', title: track.title, webpage_url: track.url };
  const encoding = encodeSong({ ...track, downloadInfo }, undefined, launch);
  const directory = children[0].options.cwd;
  assert.ok(existsSync(directory));
  assert.equal(children[0].args.at(-2), '--load-info-json');
  assert.deepEqual(JSON.parse(readFileSync(children[0].args.at(-1), 'utf8')), downloadInfo);
  assert.ok(children[1].args.includes('libmp3lame'));
  children[1].stdout.write('ID3-audio');
  children[1].emit('close', 0);
  let done = false;
  encoding.then(() => { done = true; });
  await tick(); assert.equal(done, false);
  children[0].emit('close', 0);
  assert.equal((await encoding).toString(), 'ID3-audio');
  assert.equal(existsSync(directory), false);
});

test('source failures, oversized output, abort and empty output never return partial attachments', async () => {
  for (const mode of ['failure', 'size', 'source-size', 'abort', 'empty', 'spawn']) {
    const { children, launch } = processes();
    const controller = new AbortController();
    const encoding = encodeSong(track, controller.signal, (exe, args, options) => {
      if (mode === 'spawn' && children.length) throw new Error('spawn failed');
      return launch(exe, args, options);
    });
    const rejected = assert.rejects(encoding);
    if (mode === 'failure') { children[1].stdout.write('partial'); children[0].emit('close', 1); }
    if (mode === 'size') children[1].stdout.write(Buffer.alloc(MAX_SONG_BYTES + 1));
    if (mode === 'source-size') children[0].stdout.emit('data', Buffer.alloc(64 * 1024 * 1024 + 1));
    if (mode === 'abort') controller.abort();
    if (mode === 'empty') for (const child of children) child.emit('close', 0);
    await rejected;
    assert.equal(existsSync(children[0].options.cwd), false, mode);
    if (mode !== 'empty') assert.ok(children.every(child => child.killed), mode);
  }
});

test('natural song requests deliver a real attachment after one AI turn', async () => {
  let calls = 0;
  const file = { name: 'song.mp3', contentType: 'audio/mpeg', attachment: Buffer.from('ID3-audio') };
  const ai = new AICore({ apiKey: 'test', fetchImpl: async (_, options) => {
    calls++;
    assert.ok(JSON.parse(options.body).tools.some(tool => tool.name === 'download_song'));
    return { ok: true, json: async () => ({ output: [{ type: 'function_call', name: 'download_song',
      arguments: '{"query":"Artist - Song"}', call_id: 'song' }] }) };
  } });
  const result = await ai.respond({ input: 'Send me Artist - Song as an MP3', context: {
    downloadSong: async (query, { signal }) => { assert.equal(query, 'Artist - Song'); assert.ok(signal); return { ...track, file }; },
  } });
  assert.equal(calls, 1);
  assert.equal(resultReply(result).files[0], file);
  const tools = createTools();
  await assert.rejects(tools.execute('download_song', '{"query":"Song","url":"https://localhost"}', { downloadSong: () => assert.fail() }));
});
