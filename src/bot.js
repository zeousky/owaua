import 'dotenv/config';
import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from 'discord.js';
import { MusicManager, parseMusicCommand, musicHelp } from './music.js';
import { AICore, ProviderError } from './ai.js';
import { MediaGenerator, MediaInputError, mediaReply } from './media.js';
import { requestImages } from './images.js';
import { card, answerCard, helpCard, animate } from './ui.js';
import { ConversationStore, conversationScope } from './store.js';
import { personaCommand, handlePersonaCommand } from './persona-command.js';
import { memoryCommand, handleMemoryCommand } from './memory-command.js';
import { createMemorySession } from './memory.js';

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
for (const name of ['DISCORD_TOKEN', 'XAI_API_KEY']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
const store = new ConversationStore(process.env.DATA_DIR ?? './data', integer('MAX_CONTEXT_TURNS', 16, 1, 50), {
  archiveTurns: integer('MAX_ARCHIVE_TURNS', 1000, 50, 10000),
  retentionDays: integer('HISTORY_RETENTION_DAYS', 180, 1, 3650),
  maxContextCharacters: integer('MAX_CONTEXT_CHARACTERS', 32000, 1000, 100000),
});
console.log(JSON.stringify({ event: 'memory_ready', recentTurns: store.maxTurns, archiveTurns: store.archiveTurns,
  retentionDays: store.retentionDays, contextCharacters: store.maxContextCharacters }));
const ai = new AICore({
  apiKey: process.env.XAI_API_KEY, model: process.env.XAI_MODEL ?? 'grok-4.7',
  maxOutputTokens: integer('MAX_OUTPUT_TOKENS', 4096, 256, 16000),
  maxToolCalls: integer('MAX_TOOL_CALLS', 8, 1, 30),
  maxToolRounds: integer('MAX_TOOL_ROUNDS', 4, 1, 8),
  timeoutMs: integer('REQUEST_TIMEOUT_MS', 180000, 1000, 600000),
  maxContextCharacters: integer('MAX_CONTEXT_CHARACTERS', 32000, 1000, 100000),
});
const media = new MediaGenerator({ apiKey: process.env.XAI_API_KEY,
  timeoutMs: integer('MEDIA_TIMEOUT_MS', 600000, 1000, 720000) });
const allowedGuilds = new Set((process.env.ALLOWED_GUILD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const cooldown = integer('USER_COOLDOWN_SECONDS', 5, 0, 3600) * 1000;
const concurrency = integer('MAX_CONCURRENT_REQUESTS', 3, 1, 20);
const active = new Set();
const lastRequest = new Map();
const shutdownController = new AbortController();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel], allowedMentions: { parse: [], repliedUser: false },
});
const music = new MusicManager();
let stopping = false;
const help = helpCard(musicHelp);

function allowed(guildId) { return !guildId || !allowedGuilds.size || allowedGuilds.has(guildId); }
function logError(event, error) {
  console.error(JSON.stringify({ event, type: error?.name ?? 'Error', status: error?.status ?? null, code: error?.code ?? null }));
}
async function answer({ scope, userId, text, images = [], send }) {
  if (stopping) return send(card('One moment', 'I’m restarting. Please try again shortly.', { tone: 'warning' }));
  if (active.has(scope)) return send(card('One moment', 'I’m still working on your previous request here.', { tone: 'warning' }));
  if (active.size >= concurrency) return send(card('One moment', 'I’m busy right now. Please try again shortly.', { tone: 'warning' }));
  const now = Date.now();
  if (now - (lastRequest.get(userId) ?? 0) < cooldown) return send(card('One moment', 'Please wait a few seconds before asking again.', { tone: 'warning' }));
  // Reject oversize input rather than silently losing part of the question.
  if (text.length > 16000 || images.length > 4) return send(card('One moment', 'Please use at most 16,000 characters and four images per request.', { tone: 'warning' }));
  if (lastRequest.size > 10000) for (const [key, time] of lastRequest) if (now - time > cooldown) lastRequest.delete(key);
  lastRequest.set(userId, now);
  active.add(scope);
  let progress;
  try {
    const persona = store.persona(userId);
    const memory = createMemorySession(store, { scope, userId, input: text });
    progress = await animate(send);
    const content = images.length ? [
      { type: 'input_text', text: text || 'Describe these images.' },
      ...images.map(url => ({ type: 'input_image', image_url: url })),
    ] : text;
    let generationStarted = false;
    const generateMedia = async (type, prompt, { useReference = true } = {}) => {
      if (generationStarted) throw new Error('Only one generation attempt per request');
      generationStarted = true;
      await progress.stop();
      progress = await animate(send);
      return media.generate(type, prompt, { images: useReference ? images : [], signal: shutdownController.signal });
    };
    const result = await ai.respond({ input: content, history: store.history(scope), memory: store.context(scope, text), persona,
      context: { userId, generateMedia, memory }, signal: shutdownController.signal,
      onActivity: activity => progress?.setActivity(activity) });
    // Keep text history only; Discord attachment links expire.
    let memoryWarning = '';
    try { memory.commit(text + (images.length ? `\n[${images.length} image attachment(s) supplied]` : ''), result.text); }
    catch (error) {
      logError('memory_save_error', error);
      memoryWarning = '\n\nI couldn’t save memory for this reply. Please try saving important facts with /memory remember.';
    }
    const payload = result.media ? mediaReply(result.media) : answerCard(result.text + memoryWarning);
    if (result.media && memoryWarning) payload.content = (payload.content ?? '') + memoryWarning;
    await progress.finish(payload);
    console.log(JSON.stringify({ event: 'ai_response', model: result.media?.model ?? result.model, usage: result.usage }));
  } catch (error) {
    logError('ai_error', error);
    const message = stopping ? 'I’m restarting. Please try again shortly. A submitted generation may still finish at xAI; retrying starts a new request.'
      : error instanceof MediaInputError ? error.message
      : error instanceof ProviderError && error.status === 429
      ? 'xAI is rate limiting requests. Please try again shortly.'
      : error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'That request timed out. A submitted generation may still complete at xAI; retrying starts a new request.'
        : 'I couldn’t finish that request. Please try again shortly.';
    const payload = card('Couldn’t complete your request', message, { tone: 'error' });
    await (progress ? progress.finish(payload) : send(payload)).catch(error => logError('send_error', error));
  } finally {
    try { await progress?.stop(); } finally { active.delete(scope); }
  }
}
client.once(Events.ClientReady, async ready => {
  console.log(JSON.stringify({ event: 'discord_ready', user: ready.user.tag, id: ready.user.id, model: ai.model }));
  try {
    await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN).put(Routes.applicationCommands(ready.user.id), { body: [
      { name: 'ask', description: 'Ask Kirmy anything', options: [
        { type: 3, name: 'prompt', description: 'Your question', required: true, max_length: 6000 },
        { type: 11, name: 'image', description: 'Optional image to understand' },
      ] },
      { name: 'reset', description: 'Clear your Kirmy history and saved memories in this channel' },
      { name: 'help', description: 'Show what Kirmy can do' },
      personaCommand,
      memoryCommand,
    ] });
    console.log(JSON.stringify({ event: 'commands_registered' }));
  } catch (error) { logError('command_registration_error', error); }
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!allowed(interaction.guildId)) return interaction.reply({ ...card('Kirmy', 'Kirmy is not enabled in this server.', { tone: 'warning' }), flags: 64 });
    if (stopping) return interaction.reply({ ...card('', 'I’m restarting. Please try again shortly.'), flags: 64 });
    if (interaction.commandName === 'memory') return await handleMemoryCommand(interaction, store, { isActive: scope => active.has(scope), stopping });
    if (interaction.commandName === 'persona') {
      if (stopping) return interaction.reply({ ...card('', 'I’m restarting. Please try again shortly.'), flags: 64 });
      return await handlePersonaCommand(interaction, store);
    }
    const scope = conversationScope(interaction.guildId, interaction.channelId, interaction.user.id);
    if (interaction.commandName === 'help') return interaction.reply({ ...help, flags: 64 });
    if (interaction.commandName === 'reset') {
      if (active.has(scope)) return interaction.reply({ ...card('Kirmy', 'Please wait for your current request to finish before resetting.', { tone: 'warning' }), flags: 64 });
      store.reset(scope);
      return interaction.reply({ ...card('A fresh start', 'Your history, archived conversations, and saved memories in this channel have been cleared.', { tone: 'success' }), flags: 64 });
    }
    if (interaction.commandName !== 'ask') return;
    const image = interaction.options.getAttachment('image');
    if (image && (!/^image\/(png|jpeg|webp|gif)$/.test(image.contentType ?? '') || image.size > 20 * 1024 * 1024)) {
      return interaction.reply({ ...card('Kirmy', 'Please attach a PNG, JPEG, WebP, or GIF image under 20 MB.', { tone: 'warning' }), flags: 64 });
    }
    await interaction.deferReply();
    await answer({ scope, userId: interaction.user.id, text: interaction.options.getString('prompt', true),
      images: image ? [image.url] : [], send: payload => interaction.editReply(payload) });
  } catch (error) { logError('interaction_error', error); }
});
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !allowed(message.guildId)) return;
  try {
    const musicCommand = parseMusicCommand(message.content);
    if (musicCommand) {
      if (stopping) return message.reply(card('Restarting', 'I’m restarting. Please try again shortly.', { tone: 'warning' }));
      return await music.handle(message, musicCommand);
    }
    let replyToBot = false;
    let reference;
    if (message.reference?.messageId) {
      reference = await message.fetchReference().catch(() => null);
      replyToBot = reference?.author.id === client.user.id;
    }
    if (message.guildId && !message.mentions.users.has(client.user.id) && !replyToBot) return;
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const scope = conversationScope(message.guildId, message.channelId, message.author.id);
    if (stopping) return message.reply(card('', 'I’m restarting. Please try again shortly.'));
    if (/^!?(help|reset)$/i.test(text)) {
      if (/reset/i.test(text)) {
        if (active.has(scope)) return message.reply(card('Request in progress', 'Please wait for your current request to finish before resetting.', { tone: 'warning' }));
        store.reset(scope);
        return message.reply(card('A fresh start', 'Your history, archived conversations, and saved memories in this channel have been cleared.', { tone: 'success' }));
      }
      return message.reply(help);
    }
    let images;
    try { images = requestImages(message, reference, client.user.id); }
    catch (error) { return message.reply(card('Check your images', error.message, { tone: 'warning' })); }
    if (!text && !images.length) return message.reply(help);
    await message.channel.sendTyping();
    const typing = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
    let response;
    const send = async payload => {
      if (response) return response.edit(payload);
      response = await message.reply(payload);
      return response;
    };
    try {
      await answer({ scope, userId: message.author.id, text, images, send });
    } finally { clearInterval(typing); }
  } catch (error) { logError('message_error', error); }
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => music.voiceStateUpdate(oldState, newState));
client.on(Events.Error, error => logError('discord_error', error));
const server = createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404); return response.end(); }
  const ready = client.isReady() && !stopping;
  response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ready, model: ai.model }));
});
server.listen(integer('PORT', 3000, 1, 65535), process.env.HEALTH_HOST ?? '0.0.0.0');
server.on('error', error => { logError('health_server_error', error); void shutdown(1); });
async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  music.close();
  shutdownController.abort(new DOMException('Bot is restarting', 'AbortError'));
  const deadline = Date.now() + 20000;
  while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  client.destroy();
  try { store.close(); } catch (error) { logError('memory_close_error', error); exitCode = 1; }
  process.exit(exitCode);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
client.login(process.env.DISCORD_TOKEN).catch(error => {
  logError('discord_login_failed', error);
  server.close(); store.close(); process.exit(1);
});
