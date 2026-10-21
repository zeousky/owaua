import 'dotenv/config';
import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits, Partials, REST, Routes, AttachmentBuilder } from 'discord.js';
import { AICore, ProviderError } from './ai.js';
import { ConversationStore, conversationScope } from './store.js';

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
for (const name of ['DISCORD_TOKEN', 'XAI_API_KEY']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
const store = new ConversationStore(process.env.DATA_DIR ?? './data', integer('MAX_CONTEXT_TURNS', 16, 1, 50));
const ai = new AICore({
  apiKey: process.env.XAI_API_KEY, model: process.env.XAI_MODEL ?? 'grok-4.7',
  maxOutputTokens: integer('MAX_OUTPUT_TOKENS', 4096, 256, 16000),
  maxToolCalls: integer('MAX_TOOL_CALLS', 8, 1, 30),
  maxToolRounds: integer('MAX_TOOL_ROUNDS', 4, 1, 8),
  timeoutMs: integer('REQUEST_TIMEOUT_MS', 180000, 1000, 600000),
});
const allowedGuilds = new Set((process.env.ALLOWED_GUILD_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean));
const cooldown = integer('USER_COOLDOWN_SECONDS', 5, 0, 3600) * 1000;
const concurrency = integer('MAX_CONCURRENT_REQUESTS', 3, 1, 20);
const active = new Set();
const lastRequest = new Map();
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel], allowedMentions: { parse: [], repliedUser: false },
});
let stopping = false;
const help = '**Kirmy** · Grok 4.7\nUse `/ask`, mention me, reply to me, or send a DM.\nI can search the web and X, run calculations with sandboxed Python, and understand attached images.\n`/reset` or `!reset` clears your history in this channel. `/help` or `!help` shows this message.\nHistory is private to your user/channel context and retained for up to 30 days. Prompts and attachments are sent to xAI.';

function allowed(guildId) { return !guildId || !allowedGuilds.size || allowedGuilds.has(guildId); }
function logError(event, error) {
  console.error(JSON.stringify({ event, type: error?.name ?? 'Error', status: error?.status ?? null, code: error?.code ?? null }));
}
function formatReply(text) {
  if (text.length <= 1900) return { content: text };
  return { content: 'My full answer is attached.', files: [new AttachmentBuilder(Buffer.from(text), { name: 'kirmy-answer.md' })] };
}
async function answer({ scope, userId, text, images = [], send }) {
  if (stopping) return send({ content: 'I’m restarting. Please try again shortly.' });
  if (active.has(scope)) return send({ content: 'I’m still working on your previous request here.' });
  if (active.size >= concurrency) return send({ content: 'I’m busy right now. Please try again shortly.' });
  const now = Date.now();
  if (now - (lastRequest.get(userId) ?? 0) < cooldown) return send({ content: 'Please wait a few seconds before asking again.' });
  // Reject oversize input rather than silently losing part of the question.
  if (text.length > 16000 || images.length > 4) return send({ content: 'Please use at most 16,000 characters and four images per request.' });
  if (lastRequest.size > 10000) for (const [key, time] of lastRequest) if (now - time > cooldown) lastRequest.delete(key);
  lastRequest.set(userId, now);
  active.add(scope);
  try {
    const content = images.length ? [
      { type: 'input_text', text: text || 'Describe these images.' },
      ...images.map(url => ({ type: 'input_image', image_url: url })),
    ] : text;
    const result = await ai.respond({ input: content, history: store.history(scope), context: { userId } });
    // Keep text history only; Discord attachment links expire.
    store.append(scope, text + (images.length ? `\n[${images.length} image attachment(s) supplied]` : ''), result.text);
    await send(formatReply(result.text));
    console.log(JSON.stringify({ event: 'ai_response', model: result.model, usage: result.usage }));
  } catch (error) {
    logError('ai_error', error);
    const message = error instanceof ProviderError && error.status === 429
      ? 'xAI is rate limiting requests. Please try again shortly.'
      : 'I couldn’t finish that request. Please try again shortly.';
    await send({ content: message }).catch(error => logError('send_error', error));
  } finally { active.delete(scope); }
}
client.once(Events.ClientReady, async ready => {
  console.log(JSON.stringify({ event: 'discord_ready', user: ready.user.tag, id: ready.user.id, model: ai.model }));
  try {
    await new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN).put(Routes.applicationCommands(ready.user.id), { body: [
      { name: 'ask', description: 'Ask Kirmy anything', options: [
        { type: 3, name: 'prompt', description: 'Your question', required: true, max_length: 6000 },
        { type: 11, name: 'image', description: 'Optional image to understand' },
      ] },
      { name: 'reset', description: 'Clear your Kirmy history in this channel' },
      { name: 'help', description: 'Show what Kirmy can do' },
    ] });
    console.log(JSON.stringify({ event: 'commands_registered' }));
  } catch (error) { logError('command_registration_error', error); }
});
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!allowed(interaction.guildId)) return interaction.reply({ content: 'Kirmy is not enabled in this server.', flags: 64 });
    const scope = conversationScope(interaction.guildId, interaction.channelId, interaction.user.id);
    if (interaction.commandName === 'help') return interaction.reply({ content: help, flags: 64 });
    if (interaction.commandName === 'reset') {
      if (active.has(scope)) return interaction.reply({ content: 'Please wait for your current request to finish before resetting.', flags: 64 });
      store.reset(scope);
      return interaction.reply({ content: 'Your conversation history in this channel has been cleared.', flags: 64 });
    }
    if (interaction.commandName !== 'ask') return;
    const image = interaction.options.getAttachment('image');
    if (image && (!/^image\/(png|jpeg|webp|gif)$/.test(image.contentType ?? '') || image.size > 20 * 1024 * 1024)) {
      return interaction.reply({ content: 'Please attach a PNG, JPEG, WebP, or GIF image under 20 MB.', flags: 64 });
    }
    await interaction.deferReply();
    await answer({ scope, userId: interaction.user.id, text: interaction.options.getString('prompt', true),
      images: image ? [image.url] : [], send: payload => interaction.editReply(payload) });
  } catch (error) { logError('interaction_error', error); }
});
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !allowed(message.guildId)) return;
  try {
    let replyToBot = false;
    if (message.reference?.messageId) {
      const reference = await message.fetchReference().catch(() => null);
      replyToBot = reference?.author.id === client.user.id;
    }
    if (message.guildId && !message.mentions.users.has(client.user.id) && !replyToBot) return;
    const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    const scope = conversationScope(message.guildId, message.channelId, message.author.id);
    if (/^!?(help|reset)$/i.test(text)) {
      if (/reset/i.test(text)) {
        if (active.has(scope)) return message.reply('Please wait for your current request to finish before resetting.');
        store.reset(scope);
        return message.reply('Your conversation history in this channel has been cleared.');
      }
      return message.reply(help);
    }
    const attachments = [...message.attachments.values()];
    if (attachments.some(a => !/^image\/(png|jpeg|webp|gif)$/.test(a.contentType ?? '') || a.size > 20 * 1024 * 1024)) {
      return message.reply('For now I support PNG, JPEG, WebP, and GIF attachments under 20 MB.');
    }
    const images = attachments.map(a => a.url);
    if (!text && !images.length) return message.reply(help);
    await message.channel.sendTyping();
    const typing = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
    try {
      await answer({ scope, userId: message.author.id, text, images, send: payload => message.reply(payload) });
    } finally { clearInterval(typing); }
  } catch (error) { logError('message_error', error); }
});
client.on(Events.Error, error => logError('discord_error', error));
const server = createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404); return response.end(); }
  const ready = client.isReady() && !stopping;
  response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ready, model: ai.model }));
});
server.listen(integer('PORT', 3000, 1, 65535), '0.0.0.0');
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  const deadline = Date.now() + 20000;
  while (active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  client.destroy(); store.close(); process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
client.login(process.env.DISCORD_TOKEN).catch(error => {
  logError('discord_login_failed', error);
  server.close(); store.close(); process.exit(1);
});
