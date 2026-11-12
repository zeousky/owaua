import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, StreamType,
} from '@discordjs/voice';

import { card, trackCard } from './ui.js';

const execFileAsync = promisify(execFile);
async function exec(file, args, options) {
  const result = execFileAsync(file, args, { ...options, killSignal: 'SIGKILL' });
  // An aborted execFile promise can reject before the child's close event.
  const closed = result.child && new Promise(resolve => result.child.once('close', resolve));
  try { return await result; } finally { await closed; }
}
const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
export const commonArgs = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-warnings', '--no-cache-dir',
  '--socket-timeout', '15', '--retries', '2'];
export const musicHelp = 'Want an MP3 attachment? Use `.mp3 <song name and artist>` or ask me to send a song as an MP3. You can also use a SoundCloud track link. Downloads support songs up to 10 minutes.\n\nHop into a voice channel and try `.music <song name>` or send a SoundCloud track link after `.music`. Request more songs to queue them up.\nSee what’s next with `.music queue`. You can also `.music skip`, `.music pause`, `.music resume`, or `.music stop`.';
export function parseMusicCommand(content) {
  const match = /^\.music(?:\s+([\s\S]*))?$/i.exec(content.trim());
  if (!match) return null;
  const query = (match[1] || '').trim();
  if (!query || /^(help|queue|skip|pause|resume|stop|leave)$/i.test(query)) {
    return { action: query.toLowerCase() || 'help' };
  }
  return { action: 'play', query: query.replace(/^play\s+/i, '') };
}
export function searchTarget(query) {
  if (!query || query.length > 300) throw new Error('Use a song name or SoundCloud track link under 300 characters.');
  if (/^(?:https?:\/\/|www\.)/i.test(query)) {
    let url;
    try { url = new URL(query.startsWith('www.') ? `https://${query}` : query); } catch { throw new Error('That SoundCloud track link is invalid.'); }
    if (['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) && url.protocol === 'https:'
      && !url.username && !url.password && !url.port
      && /^\/[\w-]+\/[\w-]+\/?$/.test(url.pathname) && !/^\/(sets|discover|search|tags)\//.test(url.pathname) && !/\/(sets|albums|tracks|popular-tracks|reposts)\/?$/.test(url.pathname)) {
      return `https://soundcloud.com${url.pathname.replace(/\/$/, '')}`;
    }
    throw new Error('Use a SoundCloud track link, or search by song name.');
  }
  // Always search plain input; never let yt-dlp interpret user text as options or another URL scheme.
  return `scsearch1:${query}`;
}
export async function resolveTrack(query, signal, run = exec, { includeDownloadInfo = false } = {}) {
  const target = searchTarget(query);
  const { stdout } = await run(ytdlp, [...commonArgs, '--dump-single-json', '--skip-download', '-f', 'bestaudio/best', '--', target],
    { timeout: 45000, maxBuffer: 4 * 1024 * 1024, signal });
  const result = JSON.parse(stdout);
  const info = result.entries ? result.entries[0] : result;
  if (!info) throw new Error('No playable song found. Try adding the artist name.');
  if (info.is_live || !Number.isFinite(info.duration) || info.duration > 3600) throw new Error('Choose a recorded song shorter than one hour.');
  if (info.extractor !== 'soundcloud') throw new Error('Invalid track source');
  const url = searchTarget(info.webpage_url);
  if (!url.startsWith('https://soundcloud.com/')) throw new Error('Invalid track source');
  return { title: String(info.title || 'Untitled').replace(/[@*_`~|<>\[\]\\]/g, '').slice(0, 160),
    url, source: 'SoundCloud', duration: info.duration, ...(includeDownloadInfo ? { downloadInfo: info } : {}) };
}
export function audioDiagnostic(text) {
  let result = String(text).replace(/https?:\/\/\S+/gi, '[URL]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  for (const name of ['DISCORD_TOKEN', 'XAI_API_KEY']) {
    if (process.env[name]) result = result.split(process.env[name]).join('[REDACTED]');
  }
  return result.slice(-800);
}
export function streamTrack(track, onError, launch = spawn) {
  // Native HLS downloads still write --Frag*.part files when output is stdout.
  // /app is read-only to the runtime user; isolate fragments for every playback.
  const workDir = mkdtempSync(joinPath(tmpdir(), 'owaua-music-'));
  const children = new Set();
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  let source, encoder, timer, closing = false;
  let sourceDiagnostic = '', encoderDiagnostic = '';
  const cleanup = () => {
    if (children.size) return;
    clearTimeout(timer);
    try { rmSync(workDir, { recursive: true, force: true }); }
    catch (error) { console.error(JSON.stringify({ event: 'music_cleanup_error', code: error.code ?? null })); }
    finally { resolveStopped(); }
  };
  const close = () => {
    if (!closing) {
      closing = true;
      clearTimeout(timer);
      source?.stdout?.unpipe(encoder?.stdin);
      for (const child of children) {
        try { child.kill('SIGKILL'); }
        catch (error) { console.error(JSON.stringify({ event: 'music_stop_error', code: error.code ?? null })); }
      }
      source?.stdout?.destroy(); encoder?.stdin?.destroy(); encoder?.stdout?.destroy();
    }
    return stopped;
  };
  const fail = (stage, code = null, detail = '') => {
    if (closing) return;
    const error = new Error('Audio source or encoder failed');
    error.stage = stage; error.code = code;
    error.detail = audioDiagnostic(sourceDiagnostic || detail || encoderDiagnostic);
    close(); onError(error);
  };
  const start = (file, args, stdio, stage) => {
    const child = launch(file, args, { cwd: workDir, stdio });
    children.add(child);
    child.on('error', error => fail(stage, error.code, error.message));
    child.once('close', code => {
      children.delete(child);
      cleanup();
      if (code !== 0) fail(stage, code);
    });
    return child;
  };
  try {
    source = start(ytdlp, [...commonArgs, '--abort-on-unavailable-fragments', '-f', 'bestaudio/best', '-o', '-', '--', track.url],
      ['ignore', 'pipe', 'pipe'], 'extractor');
    encoder = start(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn', '-t', '3600', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'],
    ['pipe', 'pipe', 'pipe'], 'encoder');
    source.stderr.on('data', chunk => { sourceDiagnostic = (sourceDiagnostic + chunk).slice(-8000); });
    encoder.stderr.on('data', chunk => { encoderDiagnostic = (encoderDiagnostic + chunk).slice(-8000); });
    source.stdout.on('error', error => fail('extractor_pipe', error.code, error.message));
    encoder.stdin.on('error', error => fail('encoder_pipe', error.code, error.message));
    encoder.stdout.on('error', error => fail('encoder_output', error.code, error.message));
    source.stdout.pipe(encoder.stdin);
    const resource = createAudioResource(encoder.stdout, { inputType: StreamType.OggOpus });
    timer = setTimeout(() => fail('timeout'), (track.duration + 120) * 1000);
    timer.unref();
    return { resource, close };
  } catch (error) {
    close();
    cleanup();
    throw Object.assign(new Error(error.message, { cause: error }), { workersClosed: stopped });
  }
}

export class MusicManager {
  constructor({ resolve = resolveTrack, stream = streamTrack, join = joinVoiceChannel,
    player = createAudioPlayer, wait = entersState, idleMs = 60000, maxSessions = 3, isVoiceBusy = () => false } = {}) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error('Invalid music session limit');
    this.sessions = new Map();
    this.draining = new Set();
    this.searchActors = new Set();
    this.closed = false;
    Object.assign(this, { resolve, stream, join, player, wait, idleMs, maxSessions, isVoiceBusy });
  }
  stopAudio(session) {
    if (session.audio) {
      session.audioStopping = session.audio.close();
      session.audio = null;
    }
    return session.audioStopping;
  }
  dispose(session) {
    if (this.sessions.get(session.guildId) !== session) return;
    this.sessions.delete(session.guildId);
    // A stopped guild keeps its slot until its lookup and playback workers exit.
    this.draining.add(session.guildId);
    session.abort.abort(); clearTimeout(session.idle);
    void Promise.allSettled([session.lookup, this.stopAudio(session)]).then(() => this.draining.delete(session.guildId));
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  }
  close() { this.closed = true; for (const session of this.sessions.values()) this.dispose(session); }
  notify(session, text) { return session.text.send(typeof text === 'string'
    ? card('Music update', text, { tone: 'music', section: 'Owaua / Music' }) : text).catch(() => {}); }
  async showPlayback(session, track) {
    await this.notify(session, trackCard(track));
  }
  async playbackFailed(session, track, error) {
    if (this.sessions.get(session.guildId) !== session || session.current !== track || track.failed) return;
    track.failed = true;
    console.error(JSON.stringify({ event: 'music_stream_error', source: track.source ?? null,
      stage: error?.stage ?? 'player', code: error?.code ?? null, detail: audioDiagnostic(error?.detail || error?.message || '') }));
    session.current = null;
    this.stopAudio(session);
    session.player.stop(true);
    this.notify(session, 'I couldn’t stream that song. Try searching by song name or using another SoundCloud track link.');
    this.next(session);
  }
  async next(session) {
    if (this.sessions.get(session.guildId) !== session || session.advancing) return;
    clearTimeout(session.idle);
    session.current = null;
    session.advancing = true;
    await this.stopAudio(session);
    session.advancing = false;
    if (this.sessions.get(session.guildId) !== session) return;
    session.audioStopping = null;
    const track = session.queue.shift();
    if (!track) {
      session.idle = setTimeout(() => { if (!session.pending) this.dispose(session); else this.next(session); }, this.idleMs);
      session.idle.unref();
      return;
    }
    session.current = track;
    try {
      session.audio = this.stream(track, error => { this.playbackFailed(session, track, error); });
      session.player.play(session.audio.resource);
      await this.wait(session.player, AudioPlayerStatus.Playing, 45000);
      if (this.sessions.get(session.guildId) === session && session.current === track) {
        await this.showPlayback(session, track);
      }
    } catch (error) {
      if (session.current === track && error?.workersClosed) session.audioStopping = error.workersClosed;
      await this.playbackFailed(session, track, error);
    }
  }
  async handle(message, command) {
    const reply = content => message.reply(typeof content === 'string'
      ? card('Music', content, { tone: 'music', section: 'Owaua / Music' }) : content);
    if (!message.guild) return reply('Music works in server voice channels.');
    if (this.closed) return reply('I’m restarting. Please try again shortly.');
    if (command.action === 'help') return reply(musicHelp);
    const member = await message.guild.members.fetch(message.author.id);
    const channel = member.voice.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) return reply('Join a regular voice channel first.');
    let session = this.sessions.get(message.guildId);
    if (session && session.channelId !== channel.id) return reply('I’m playing in another voice channel. Join that channel to control the music.');
    if (command.action !== 'play') {
      if (!session) return reply('Nothing is playing. Use `.music <song name>`.');
      if (command.action === 'queue') return reply([
        session.current ? `Now playing: **${session.current.title}**` : 'Nothing playing yet.',
        ...session.queue.map((track, i) => `${i + 1}. ${track.title}`),
      ].join('\n').slice(0, 1900));
      if (['stop', 'leave'].includes(command.action)) { this.dispose(session); return reply('Music’s off — I’ve left the voice channel.'); }
      if (command.action === 'pause') {
        const paused = session.player.pause();
        return reply(paused ? 'Paused.' : 'Nothing is playing to pause.');
      }
      if (command.action === 'resume') {
        const resumed = session.player.unpause();
        return reply(resumed ? 'Resumed.' : 'Nothing is paused.');
      }
      if (command.action === 'skip') {
        if (!session.current) return reply('Nothing is playing to skip.');
        session.current = null;
        this.stopAudio(session);
        session.player.stop(true); this.next(session); return reply('Skipped.');
      }
      return;
    }
    // Validate before joining and reserve one search per server to bound extractor processes.
    try { searchTarget(command.query); } catch (error) { return reply(error.message); }
    if (session?.pending) return reply('I’m still finding the last song. Try again in a moment.');
    if (session?.queue.length >= 20) return reply('The queue is full (20 songs). Wait or skip a song first.');
    const me = message.guild.members.me ?? await message.guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      return reply('I need View Channel, Connect, and Speak permissions in your voice channel.');
    }
    // Metadata fetches above can yield to a voice join or another music search.
    // Recheck immediately before reserving/joining, with no intervening await.
    if (this.closed) return reply('I’m restarting. Please try again shortly.');
    if (this.isVoiceBusy(message.guildId)) return reply('Use /voice leave to end our voice chat, then we can put some music on.');
    session = this.sessions.get(message.guildId);
    if (session && session.channelId !== channel.id) return reply('I’m playing in another voice channel. Join that channel to control the music.');
    if (session?.pending) return reply('I’m still finding the last song. Try again in a moment.');
    if (session?.queue.length >= 20) return reply('The queue is full (20 songs). Wait or skip a song first.');
    const actor = message.author.id;
    if (this.searchActors.has(actor)) return reply('I’m still finding another song for you. Try again in a moment.');
    if (!session) {
      if (this.draining.has(message.guildId)) return reply('I’m still closing this server’s previous music session. Try again in a moment.');
      if (this.sessions.size + this.draining.size >= this.maxSessions) return reply('Music is busy in other servers. Try again when a session ends.');
      const player = this.player({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      const connection = this.join({ guildId: message.guildId, channelId: channel.id,
        adapterCreator: message.guild.voiceAdapterCreator, selfDeaf: true });
      session = { guildId: message.guildId, channelId: channel.id, connection, player,
        queue: [], current: null, audio: null, abort: new AbortController(), text: message.channel };
      this.sessions.set(message.guildId, session);
      try {
        connection.subscribe(player);
        player.on(AudioPlayerStatus.Idle, () => { if (session.current) this.next(session); });
        player.on('error', error => {
          if (session.current) this.playbackFailed(session, session.current, error);
        });
        connection.on('error', () => { this.notify(session, 'Voice connection failed. Please try again.'); this.dispose(session); });
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          try { await Promise.race([
            this.wait(connection, VoiceConnectionStatus.Signalling, 5000),
            this.wait(connection, VoiceConnectionStatus.Connecting, 5000),
          ]); } catch { this.dispose(session); }
        });
        connection.on(VoiceConnectionStatus.Destroyed, () => this.dispose(session));
      } catch (error) {
        this.dispose(session);
        throw error;
      }
    }
    session.pending = true; clearTimeout(session.idle);
    this.searchActors.add(actor);
    const lookupAbort = new AbortController();
    const lookupSignal = AbortSignal.any([session.abort.signal, lookupAbort.signal]);
    const lookup = Promise.resolve().then(() => this.resolve(command.query, lookupSignal))
      .finally(() => this.searchActors.delete(actor));
    session.lookup = lookup;
    try {
      const [track] = await Promise.all([
        lookup,
        Promise.resolve().then(() => this.wait(session.connection, VoiceConnectionStatus.Ready, 20000)),
      ]);
      if (this.sessions.get(message.guildId) !== session) {
        await reply(card('Search cancelled', 'Stopped playing.', { tone: 'music' })); return;
      }
      // The requester must still be in the same channel after the asynchronous search.
      if (member.voice.channelId !== session.channelId) throw new Error('Stay in the voice channel while I find the song.');
      session.text = message.channel;
      session.queue.push(track);
      await reply(card('Added to your queue', `**[${track.title}](${track.url})**`, {
        tone: 'music', section: 'Owaua / Music', footer: `Owaua · Position ${session.queue.length} in queue`,
      }));
      if (!session.current) this.next(session);
    } catch (error) {
      lookupAbort.abort();
      if (this.sessions.get(message.guildId) !== session) {
        await reply(card('Search cancelled', 'Stopped playing.', { tone: 'music' })); return;
      }
      console.error(JSON.stringify({ event: 'music_error', type: error.name, code: error.code ?? null }));
      const safe = ['Choose a recorded song shorter than one hour.', 'No playable song found. Try adding the artist name.',
        'Stay in the voice channel while I find the song.'];
      const payload = card('Couldn’t load your song', safe.includes(error.message) ? error.message : 'I couldn’t load that song. The source may have blocked it, or voice connection failed. Try a song name or SoundCloud link.', { tone: 'error', section: 'Owaua / Music' });
      await reply(payload);
    } finally {
      await lookup.catch(() => {});
      session.lookup = null;
      session.pending = false;
      if (!session.current && this.sessions.get(message.guildId) === session) this.next(session);
    }
  }
  voiceStateUpdate(oldState, newState) {
    const session = this.sessions.get(newState.guild.id);
    if (!session) return;
    if (newState.id === newState.client.user.id && newState.channelId !== session.channelId) { this.dispose(session); return; }
    const channel = newState.guild.channels.cache.get(session.channelId);
    if (oldState.channelId === session.channelId && channel && !channel.members.some(member => !member.user.bot)) this.dispose(session);
  }
}
