import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commonArgs, resolveTrack, searchTarget } from './music.js';
import { assertSafeText } from './safety.js';
import { fullModeActive } from './full-mode.js';

export const MAX_SONG_BYTES = 9 * 1024 * 1024;
export class SongInputError extends Error {}

// Explicit requests have a deterministic path, including the wording in chat.
// Other languages/wording can use the AI's download_song tool.
export function parseSongRequest(text) {
  const command = /^\.mp3(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (command) return { query: (command[1] ?? '').trim() };
  const request = /^(?:(?:hey[,!]?\s+)?(?:can|could|would)\s+you\s+|please\s+)?(?:send|attach|download|get|give)\s+(?:me\s+)?(?:an?\s+|the\s+)?mp3\s+(?:of|for)\s+(?:(?:this|the)\s+song\s*:?\s*)?(.+?)\s*$/i.exec(text.trim());
  return request ? { query: request[1].replace(/\s+please[.!?]*$/i, '').trim() } : null;
}

export function songResult(song, extra = {}) {
  return { ...extra, text: `Here’s **${song.title}** as an MP3.\nSource: <${song.url}>`, artifacts: [song.file] };
}

// Stream through FFmpeg so neither the source nor the MP3 can grow unbounded.
// Both processes must finish successfully before any bytes reach Discord.
export async function encodeSong(track, signal, launch = spawn) {
  signal?.throwIfAborted();
  const workDir = mkdtempSync(join(tmpdir(), 'owaua-mp3-'));
  const children = [];
  const closed = [];
  let failure, source, encoder;
  const fail = error => {
    failure ??= error;
    for (const child of children) child.kill('SIGKILL');
  };
  const start = (file, args, stdio) => {
    const child = launch(file, args, { cwd: workDir, stdio });
    children.push(child);
    closed.push(new Promise(resolve => {
      child.once('error', () => fail(new SongInputError('I couldn’t prepare that MP3. Please try another song.')));
      child.once('close', code => {
        if (code !== 0) fail(new SongInputError('I couldn’t download that song. Try adding the artist name or another SoundCloud track link.'));
        resolve();
      });
    }));
    return child;
  };
  const abort = () => fail(signal.reason);
  try {
    // Reuse the metadata already fetched by the search, rather than fetching
    // SoundCloud's page a second time (which can time out independently).
    const target = searchTarget(track.url);
    let input = ['--', target];
    if (track.downloadInfo) {
      const infoPath = join(workDir, 'track.json');
      writeFileSync(infoPath, JSON.stringify(track.downloadInfo), { mode: 0o600 });
      input = ['--load-info-json', infoPath];
    }
    source = start(process.env.YTDLP_PATH || 'yt-dlp', [...commonArgs, '--abort-on-unavailable-fragments',
      '-f', 'bestaudio/best', '-o', '-', ...input], ['ignore', 'pipe', 'ignore']);
    encoder = start(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn', '-t', '600', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '112k',
      '-f', 'mp3', 'pipe:1'], ['pipe', 'pipe', 'ignore']);
    for (const stream of [source.stdout, encoder.stdin, encoder.stdout]) {
      stream.on('error', () => fail(new SongInputError('I couldn’t prepare that MP3. Please try another song.')));
    }
    const chunks = [];
    let size = 0, sourceSize = 0;
    source.stdout.on('data', chunk => {
      sourceSize += chunk.length;
      if (sourceSize > 64 * 1024 * 1024) fail(new SongInputError('That audio source is too large. Please choose another track.'));
    });
    encoder.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_SONG_BYTES) fail(new SongInputError('That MP3 is too large to attach. Please choose a shorter track.'));
      else if (!failure) chunks.push(chunk);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    source.stdout.pipe(encoder.stdin);
    await Promise.all(closed);
    if (failure) throw failure;
    if (!size) throw new SongInputError('The audio source returned an empty file. Please try another song.');
    return Buffer.concat(chunks);
  } catch (error) {
    fail(error);
    await Promise.all(closed);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    source?.stdout.destroy(); encoder?.stdin.destroy(); encoder?.stdout.destroy();
    rmSync(workDir, { recursive: true, force: true });
  }
}

export class SongDownloads {
  constructor({ resolve = (query, signal) => resolveTrack(query, signal, undefined, { includeDownloadInfo: true }), encode = encodeSong } = {}) {
    Object.assign(this, { resolve, encode });
    this.active = 0;
  }
  async download(query, { signal: callerSignal } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new SongInputError('Use `.mp3 <song name and artist>` or `.mp3 <SoundCloud track link>`.');
    assertSafeText(query);
    try { searchTarget(query); } catch (error) { throw new SongInputError(error.message); }
    if (this.active >= 3) throw new SongInputError('I’m preparing a few songs. Please try again in a moment.');
    const deadline = fullModeActive() ? new AbortController().signal : AbortSignal.timeout(120000);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    this.active++;
    try {
      signal.throwIfAborted();
      const track = await this.resolve(query, signal);
      if (!Number.isFinite(track.duration) || track.duration <= 0 || track.duration > 600) {
        throw new SongInputError('Choose a recorded song no longer than 10 minutes for an MP3 attachment.');
      }
      assertSafeText(track.title);
      const attachment = await this.encode(track, signal);
      signal.throwIfAborted();
      const name = (track.title.replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/^\.+/, '').trim().slice(0, 80) || 'song') + '.mp3';
      return { title: track.title, url: track.url, file: { attachment, name, contentType: 'audio/mpeg' } };
    } catch (error) {
      if (signal.aborted) throw new SongInputError('That song download timed out or was cancelled. Please try again.');
      if (error instanceof SongInputError || error.name === 'SafetyError') throw error;
      throw new SongInputError('I couldn’t find or download that song. Try adding the artist name or send a SoundCloud track link.');
    } finally { this.active--; }
  }
}
