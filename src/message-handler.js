import { withServerLanguage } from './server-language.js';
import { parseMusicCommand } from './music.js';
import { parsePrefixCommand, createPrefixInteraction, PrefixCommandError } from './prefix-command.js';
import { requestAttachments } from './attachments.js';
import { conversationScope } from './store.js';
import { card } from './ui.js';
import { withFullMode } from './full-mode.js';

export function createMessageHandler({ allowed, localExtension, handleCommand, client, isStopping,
  voiceManager, music, active, store, answer, logError }) {
  return function handleMessage(message) {
    return withServerLanguage(message.guildId, () => withFullMode(message.author.id, store.fullMode?.(message.author.id), async () => {
    if (message.author.bot) return;
    try {
      if (!allowed(message.guildId)) return;
      if (await localExtension?.handleMessage?.(message)) return;
      let command;
      try { command = parsePrefixCommand(message.content, { attachments: message.attachments }); }
      catch (error) {
        if (!(error instanceof PrefixCommandError)) throw error;
        return message.reply(card('', error.message));
      }
      if (command) return await handleCommand(createPrefixInteraction(message, command));
      const musicCommand = parseMusicCommand(message.content);
      if (musicCommand) {
        if (isStopping()) return message.reply(card('Restarting', 'I’m restarting — give me a moment, then try again.', { tone: 'warning' }));
        if (voiceManager.sessions.has(message.guildId)) return message.reply(card('', 'End the voice conversation with /voice leave before using music.'));
        return await music.handle(message, musicCommand);
      }
      let replyToBot = false;
      let reference;
      if (message.reference?.messageId) {
        reference = await message.fetchReference().catch(() => null);
        replyToBot = reference?.author.id === client.user.id;
      }
      if (message.guildId && !message.mentions.users.has(client.user.id) && !replyToBot && !/^\.mp3(?:\s|$)/i.test(message.content)) return;
      const text = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      const scope = conversationScope(message.guildId, message.channelId, message.author.id);
      if (isStopping()) return message.reply(card('', 'I’m restarting — give me a moment, then try again.'));
      if (/^!?(help|reset)$/i.test(text)) {
        if (/reset/i.test(text)) {
          if (active.has(scope)) return message.reply(card('Request in progress', 'Let me finish your current request, then you can reset our chat.', { tone: 'warning' }));
          store.reset(scope);
          return message.reply(card('A fresh start', 'Fresh start — I’ve cleared your conversation history and saved notes in this channel.', { tone: 'success' }));
        }
        return await handleCommand(createPrefixInteraction(message, { commandName: 'help', values: new Map() }));
      }
      let attachments;
      try { attachments = requestAttachments(message, reference, client.user.id); }
      catch (error) { return message.reply(card('Check your images', error.message, { tone: 'warning' })); }
      if (!text && !attachments.images.length && !attachments.documents.length && !attachments.videos.length && !attachments.audio.length) return message.reply(card('', 'Hey, what’s up? Ask me something, or use `/help` for the guide.'));
      await message.channel.sendTyping();
      const typing = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      let response;
      const send = async payload => {
        if (response) return response.edit(payload);
        response = await message.reply(payload);
        return response;
      };
      try {
        await answer({ scope, userId: message.author.id, guildId: message.guildId, text, ...attachments, send });
      } finally { clearInterval(typing); }
    } catch (error) { logError('message_error', error); }
    }));
  };
}
