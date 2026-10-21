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

const exec = promisify(execFile);
const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
const commonArgs = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-warnings', '--no-cache-dir',
  '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '15', '--retries', '2'];
export const musicHelp = 'Join a voice channel, then use `.music <song name, YouTube link, or SoundCloud link>` (for example `.music go away`). More songs go into the queue.\nControls: `.music queue`, `.music skip`, `.music pause`, `.music resume`, `.music stop`.';
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
  if (!query || query.length > 300) throw new Error('Use a song name, YouTube link, or SoundCloud link under 300 characters.');
  if (/^(?:https?:\/\/|www\.)/i.test(query)) {
    let url;
    try { url = new URL(query.startsWith('www.') ? `https://${query}` : query); } catch { throw new Error('That YouTube link is invalid.'); }
    if (['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) && url.protocol === 'https:'
      && !url.username && !url.password && !url.port
      && /^\/[\w-]+\/[\w-]+\/?$/.test(url.pathname) && !/^\/(sets|discover|search|tags)\//.test(url.pathname) && !/\/(sets|albums|tracks|popular-tracks|reposts)\/?$/.test(url.pathname)) {
      return `https://soundcloud.com${url.pathname.replace(/\/$/, '')}`;
    }
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)
      || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
      throw new Error('Use a YouTube or SoundCloud track link, or search by song name.');
    }
    const id = url.hostname === 'youtu.be' ? url.pathname.slice(1)
      : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(shorts|live)\/([^/]+)$/.exec(url.pathname)?.[2];
    if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Use a single YouTube video link, not a playlist or channel.');
    return `https://www.youtube.com/watch?v=${id}`;
  }
  // Always search plain input; never let yt-dlp interpret user text as options or another URL scheme.
  return `ytsearch1:${query}`;
}
export async function resolveTrack(query, signal, run = exec, preferredSource = 'youtube') {
  const requested = searchTarget(query);
  const target = preferredSource === 'soundcloud' && requested.startsWith('ytsearch1:') ? `scsearch1:${query}` : requested;
  const extract = async input => {
    const { stdout } = await run(ytdlp, [...commonArgs, '--dump-single-json', '--skip-download', '-f', 'bestaudio/best', '--', input],
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024, signal });
    const result = JSON.parse(stdout);
    const info = result.entries ? result.entries[0] : result;
    if (!info) throw new Error('No playable song found. Try adding the artist name.');
    if (info.is_live || !Number.isFinite(info.duration) || info.duration > 3600) throw new Error('Choose a recorded song shorter than one hour.');
    let url, source;
    if (info.extractor === 'soundcloud') {
      url = searchTarget(info.webpage_url);
      if (!url.startsWith('https://soundcloud.com/')) throw new Error('Invalid track source');
      source = 'SoundCloud';
    } else {
      if (!/^[\w-]{11}$/.test(info.id || '')) throw new Error('No playable song found. Try adding the artist name.');
      url = `https://www.youtube.com/watch?v=${info.id}`;
      source = 'YouTube';
    }
    return { title: String(info.title || 'Untitled').replace(/[@*_`~|<>\[\]\\]/g, '').slice(0, 160), url, source, duration: info.duration,
      ...(source === 'YouTube' && requested.startsWith('ytsearch1:') ? { fallbackQuery: query } : {}) };
  };
  try { return await extract(target); }
  catch (error) {
    if (signal?.aborted || !target.startsWith('ytsearch1:')) throw error;
    // Public SoundCloud search remains available when YouTube blocks datacenter IPs.
    return extract(`scsearch1:${query}`);
  }
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
    player = createAudioPlayer, wait = entersState, idleMs = 60000,
    fallback = (query, signal) => resolveTrack(query, signal, exec, 'soundcloud') } = {}) {
    this.sessions = new Map();
    Object.assign(this, { resolve, stream, join, player, wait, idleMs, fallback });
  }
  dispose(session) {
    if (this.sessions.get(session.guildId) !== session) return;
    this.sessions.delete(session.guildId);
    session.abort.abort(); session.current?.recoveryAbort?.abort(); clearTimeout(session.idle);
    session.audio?.close(); session.audio = null;
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  }
  close() { for (const session of this.sessions.values()) this.dispose(session); }
  notify(session, text) { return session.text.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {}); }
  async playbackFailed(session, track, error) {
    if (this.sessions.get(session.guildId) !== session || session.current !== track || track.failed) return;
    track.failed = true;
    console.error(JSON.stringify({ event: 'music_stream_error', source: track.source ?? null,
      stage: error?.stage ?? 'player', code: error?.code ?? null, detail: audioDiagnostic(error?.detail || error?.message || '') }));
    session.current = null; session.audio?.close(); session.audio = null;
    session.player.stop(true);
    if (track.fallbackQuery) {
      const recovery = { ...track, recovering: true, recoveryAbort: new AbortController() };
      session.current = recovery;
      this.notify(session, 'YouTube blocked the audio stream. Trying SoundCloud…');
      try {
        const replacement = await this.fallback(track.fallbackQuery, recovery.recoveryAbort.signal);
        if (this.sessions.get(session.guildId) !== session || session.current !== recovery) return;
        session.queue.unshift(replacement);
      } catch (fallbackError) {
        if (this.sessions.get(session.guildId) !== session || session.current !== recovery) return;
        console.error(JSON.stringify({ event: 'music_fallback_error', type: fallbackError.name, code: fallbackError.code ?? null }));
        this.notify(session, 'Both music sources failed for that song. Try adding the artist name or using a SoundCloud track link.');
      }
      if (this.sessions.get(session.guildId) !== session || session.current !== recovery) return;
      session.current = null;
    } else {
      this.notify(session, 'I couldn’t stream that song. Try searching by song name or using another SoundCloud track link.');
    }
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
        await this.notify(session, `Now playing: **${track.title}**${track.source ? ` (${track.source})` : ''}`);
      }
    } catch (error) {
      await this.playbackFailed(session, track, error);
    }
  }
  async handle(message, command) {
    const reply = content => message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });
    if (!message.guild) return reply('Music works in server voice channels.');
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
      if (command.action === 'pause') return reply(session.player.pause() ? 'Paused.' : 'Nothing is playing to pause.');
      if (command.action === 'resume') return reply(session.player.unpause() ? 'Resumed.' : 'Nothing is paused.');
      if (command.action === 'skip') {
        if (!session.current) return reply('Nothing is playing to skip.');
        session.current.recoveryAbort?.abort();
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
    if (!session) {
      const connection = this.join({ guildId: message.guildId, channelId: channel.id,
        adapterCreator: message.guild.voiceAdapterCreator, selfDeaf: true });
      session = { guildId: message.guildId, channelId: channel.id, connection,
        player: this.player({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
        queue: [], current: null, audio: null, abort: new AbortController(), text: message.channel };
      this.sessions.set(message.guildId, session);
      connection.subscribe(session.player);
      session.player.on(AudioPlayerStatus.Idle, () => { if (session.current && !session.current.recovering) this.next(session); });
      session.player.on('error', error => {
        if (session.current && !session.current.recovering) this.playbackFailed(session, session.current, error);
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
    try {
      await reply('Finding your song…');
      const [track] = await Promise.all([
        this.resolve(command.query, session.abort.signal),
        this.wait(session.connection, VoiceConnectionStatus.Ready, 20000),
      ]);
      if (this.sessions.get(message.guildId) !== session) return;
      // The requester must still be in the same channel after the asynchronous search.
      if (member.voice.channelId !== session.channelId) throw new Error('Stay in the voice channel while I find the song.');
      session.text = message.channel;
      session.queue.push(track);
      if (!session.current) this.next(session);
      else await reply(`Queued: **${track.title}**`);
    } catch (error) {
      if (this.sessions.get(message.guildId) !== session) return;
      console.error(JSON.stringify({ event: 'music_error', type: error.name, code: error.code ?? null }));
      const safe = ['Choose a recorded song shorter than one hour.', 'No playable song found. Try adding the artist name.',
        'Stay in the voice channel while I find the song.'];
      await reply(safe.includes(error.message) ? error.message : 'I couldn’t load that song. The source may have blocked it, or voice connection failed. Try a song name or SoundCloud link.');
    } finally {
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
