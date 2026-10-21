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

import { card, animate, trackCard } from './ui.js';

const exec = promisify(execFile);
const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
const commonArgs = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-warnings', '--no-cache-dir',
  '--socket-timeout', '15', '--retries', '2'];
export const musicHelp = 'Join a voice channel, then use `.music <song name or SoundCloud track link>` (for example `.music go away`). More songs go into the queue.\nControls: `.music queue`, `.music skip`, `.music pause`, `.music resume`, `.music stop`.';
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
export async function resolveTrack(query, signal, run = exec) {
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
    url, source: 'SoundCloud', duration: info.duration };
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
  const workDir = mkdtempSync(joinPath(tmpdir(), 'kirmy-music-'));
  const children = new Set();
  const cleanup = () => { if (!children.size) rmSync(workDir, { recursive: true, force: true }); };
  const start = (file, args, stdio) => {
    const child = launch(file, args, { cwd: workDir, stdio });
    children.add(child);
    child.once('close', () => { children.delete(child); cleanup(); });
    return child;
  };
  let source, encoder;
  try {
    source = start(ytdlp, [...commonArgs, '--abort-on-unavailable-fragments', '-f', 'bestaudio/best', '-o', '-', '--', track.url], ['ignore', 'pipe', 'pipe']);
    encoder = start(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0', '-vn', '-t', '3600', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'],
    ['pipe', 'pipe', 'pipe']);
  } catch (error) {
    for (const child of children) child.kill('SIGKILL');
    cleanup();
    throw error;
  }
  let closed = false;
  let sourceDiagnostic = '', encoderDiagnostic = '';
  const timer = setTimeout(() => fail('timeout'), (track.duration + 120) * 1000);
  timer.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    source.stdout.unpipe(encoder.stdin);
    source.kill('SIGKILL'); encoder.kill('SIGKILL');
    source.stdout.destroy(); encoder.stdin.destroy(); encoder.stdout.destroy();
  };
  const fail = (stage, code = null, detail = '') => {
    if (closed) return;
    const error = new Error('Audio source or encoder failed');
    error.stage = stage; error.code = code;
    error.detail = audioDiagnostic(sourceDiagnostic || detail || encoderDiagnostic);
    close(); onError(error);
  };
  source.stderr.on('data', chunk => { sourceDiagnostic = (sourceDiagnostic + chunk).slice(-8000); });
  encoder.stderr.on('data', chunk => { encoderDiagnostic = (encoderDiagnostic + chunk).slice(-8000); });
  source.on('error', error => fail('extractor', error.code, error.message));
  encoder.on('error', error => fail('encoder', error.code, error.message));
  source.on('close', code => { if (code !== 0) fail('extractor', code); });
  encoder.on('close', code => { if (code !== 0) fail('encoder', code); });
  source.stdout.on('error', error => fail('extractor_pipe', error.code, error.message));
  encoder.stdin.on('error', error => fail('encoder_pipe', error.code, error.message));
  encoder.stdout.on('error', error => fail('encoder_output', error.code, error.message));
  source.stdout.pipe(encoder.stdin);
  return { resource: createAudioResource(encoder.stdout, { inputType: StreamType.OggOpus }), close };
}

export class MusicManager {
  constructor({ resolve = resolveTrack, stream = streamTrack, join = joinVoiceChannel,
    player = createAudioPlayer, wait = entersState, idleMs = 60000, isVoiceBusy = () => false } = {}) {
    this.sessions = new Map();
    this.closed = false;
    Object.assign(this, { resolve, stream, join, player, wait, idleMs, isVoiceBusy });
  }
  dispose(session) {
    if (this.sessions.get(session.guildId) !== session) return;
    this.sessions.delete(session.guildId);
    session.abort.abort(); clearTimeout(session.idle);
    session.audio?.close(); session.audio = null;
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  }
  close() { this.closed = true; for (const session of this.sessions.values()) this.dispose(session); }
  notify(session, text) { return session.text.send(typeof text === 'string'
    ? card('Music update', text, { tone: 'music', section: 'Kirmy / Music' }) : text).catch(() => {}); }
  async showPlayback(session, track) {
    await this.notify(session, trackCard(track));
  }
  async playbackFailed(session, track, error) {
    if (this.sessions.get(session.guildId) !== session || session.current !== track || track.failed) return;
    track.failed = true;
    console.error(JSON.stringify({ event: 'music_stream_error', source: track.source ?? null,
      stage: error?.stage ?? 'player', code: error?.code ?? null, detail: audioDiagnostic(error?.detail || error?.message || '') }));
    session.current = null; session.audio?.close(); session.audio = null;
    session.player.stop(true);
    this.notify(session, 'I couldn’t stream that song. Try searching by song name or using another SoundCloud track link.');
    this.next(session);
  }
  async next(session) {
    if (this.sessions.get(session.guildId) !== session) return;
    clearTimeout(session.idle);
    session.audio?.close(); session.audio = null; session.current = null;
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
      await this.playbackFailed(session, track, error);
    }
  }
  async handle(message, command) {
    const reply = content => message.reply(typeof content === 'string'
      ? card('Music', content, { tone: 'music', section: 'Kirmy / Music' }) : content);
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
      if (['stop', 'leave'].includes(command.action)) { this.dispose(session); return reply('Stopped music and left the voice channel.'); }
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
        session.current = null; session.audio?.close(); session.audio = null;
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
    if (this.isVoiceBusy(message.guildId)) return reply('End the voice conversation with /voice leave before using music.');
    session = this.sessions.get(message.guildId);
    if (session && session.channelId !== channel.id) return reply('I’m playing in another voice channel. Join that channel to control the music.');
    if (session?.pending) return reply('I’m still finding the last song. Try again in a moment.');
    if (session?.queue.length >= 20) return reply('The queue is full (20 songs). Wait or skip a song first.');
    if (!session) {
      const connection = this.join({ guildId: message.guildId, channelId: channel.id,
        adapterCreator: message.guild.voiceAdapterCreator, selfDeaf: true });
      session = { guildId: message.guildId, channelId: channel.id, connection,
        player: this.player({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
        queue: [], current: null, audio: null, abort: new AbortController(), text: message.channel };
      this.sessions.set(message.guildId, session);
      connection.subscribe(session.player);
      session.player.on(AudioPlayerStatus.Idle, () => { if (session.current) this.next(session); });
      session.player.on('error', error => {
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
    }
    session.pending = true; clearTimeout(session.idle);
    let progress;
    try {
      progress = await animate(reply);
      const [track] = await Promise.all([
        this.resolve(command.query, session.abort.signal),
        this.wait(session.connection, VoiceConnectionStatus.Ready, 20000),
      ]);
      if (this.sessions.get(message.guildId) !== session) {
        await progress.finish(card('Search cancelled', 'Playback was stopped.', { tone: 'music' })); return;
      }
      // The requester must still be in the same channel after the asynchronous search.
      if (member.voice.channelId !== session.channelId) throw new Error('Stay in the voice channel while I find the song.');
      session.text = message.channel;
      session.queue.push(track);
      await progress.finish(card('Added to your queue', `**[${track.title}](${track.url})**`, {
        tone: 'music', section: 'Kirmy / Music', footer: `Kirmy · Position ${session.queue.length} in queue`,
      }));
      if (!session.current) this.next(session);
    } catch (error) {
      if (this.sessions.get(message.guildId) !== session) {
        await progress?.finish(card('Search cancelled', 'Playback was stopped.', { tone: 'music' })); return;
      }
      console.error(JSON.stringify({ event: 'music_error', type: error.name, code: error.code ?? null }));
      const safe = ['Choose a recorded song shorter than one hour.', 'No playable song found. Try adding the artist name.',
        'Stay in the voice channel while I find the song.'];
      const payload = card('Couldn’t load your song', safe.includes(error.message) ? error.message : 'I couldn’t load that song. The source may have blocked it, or voice connection failed. Try a song name or SoundCloud link.', { tone: 'error', section: 'Kirmy / Music' });
      await (progress ? progress.finish(payload) : reply(payload));
    } finally {
      await progress?.stop();
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
