import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
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
export async function resolveTrack(query, signal, run = exec) {
  const target = searchTarget(query);
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
    return { title: String(info.title || 'Untitled').replace(/[@*_`~|<>\[\]\\]/g, '').slice(0, 160), url, source, duration: info.duration };
  };
  try { return await extract(target); }
  catch (error) {
    if (signal?.aborted || !target.startsWith('ytsearch1:')) throw error;
    // Public SoundCloud search remains available when YouTube blocks datacenter IPs.
    return extract(`scsearch1:${query}`);
  }
}
export function streamTrack(track, onError) {
  const source = spawn(ytdlp, [...commonArgs, '-f', 'bestaudio/best', '-o', '-', '--', track.url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const encoder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0', '-vn', '-t', '3600', '-c:a', 'libopus', '-b:a', '96k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  const timer = setTimeout(() => fail(), (track.duration + 120) * 1000);
  timer.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    source.stdout.unpipe(encoder.stdin);
    source.kill('SIGKILL'); encoder.kill('SIGKILL');
    source.stdout.destroy(); encoder.stdin.destroy(); encoder.stdout.destroy();
  };
  const fail = () => { if (!closed) { close(); onError(new Error('Audio source or encoder failed')); } };
  // Drain diagnostics without logging signed media URLs or untrusted source text.
  source.stderr.resume(); encoder.stderr.resume();
  source.on('error', fail); encoder.on('error', fail);
  source.on('close', code => { if (code !== 0) fail(); });
  encoder.on('close', code => { if (code !== 0) fail(); });
  source.stdout.on('error', fail); encoder.stdin.on('error', fail); encoder.stdout.on('error', fail);
  source.stdout.pipe(encoder.stdin);
  return { resource: createAudioResource(encoder.stdout, { inputType: StreamType.OggOpus }), close };
}

export class MusicManager {
  constructor({ resolve = resolveTrack, stream = streamTrack, join = joinVoiceChannel,
    player = createAudioPlayer, wait = entersState, idleMs = 60000 } = {}) {
    this.sessions = new Map();
    Object.assign(this, { resolve, stream, join, player, wait, idleMs });
  }
  dispose(session) {
    if (this.sessions.get(session.guildId) !== session) return;
    this.sessions.delete(session.guildId);
    session.abort.abort(); clearTimeout(session.idle);
    session.audio?.close(); session.audio = null;
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) session.connection.destroy();
  }
  close() { for (const session of this.sessions.values()) this.dispose(session); }
  notify(session, text) { return session.text.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {}); }
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
      session.audio = this.stream(track, () => {
        if (this.sessions.get(session.guildId) !== session || session.current !== track) return;
        this.notify(session, 'I couldn’t stream that song. It may be unavailable or blocked by the music source. Try another song.');
        session.player.stop(true);
        if (session.current === track) this.next(session);
      });
      session.player.play(session.audio.resource);
      await this.wait(session.player, AudioPlayerStatus.Playing, 45000);
      if (this.sessions.get(session.guildId) === session && session.current === track) {
        await this.notify(session, `Now playing: **${track.title}**${track.source ? ` (${track.source})` : ''}`);
      }
    } catch {
      if (this.sessions.get(session.guildId) === session && session.current === track) {
        this.notify(session, 'I couldn’t start that song. Check my Connect/Speak permissions or try another song.');
        // Clear the track before stop so Idle cannot advance twice.
        session.current = null; session.audio?.close(); session.audio = null;
        session.player.stop(true); this.next(session);
      }
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
        session.player.stop(true); return reply('Skipped.');
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
      session.player.on(AudioPlayerStatus.Idle, () => { if (session.current) this.next(session); });
      session.player.on('error', () => {
        if (!session.current) return;
        this.notify(session, 'Playback failed. Trying the next song.'); this.next(session);
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
