import { handleMediaCommand } from './media-command.js';
import { handlePersonaCommand } from './persona-command.js';
import { handleLanguageCommand } from './language-command.js';
import { handleFullCommand } from './full-command.js';
import { handleMemoryCommand } from './memory-command.js';
import { handleSpeakCommand, handleTranscribeCommand, handleVoiceCommand } from './voice-command.js';
import { handleKnowledgeCommand } from './knowledge-command.js';
import { card } from './ui.js';
import { conversationScope } from './store.js';
import { requestAttachments } from './attachments.js';
import { PrefixPrivateReplyError } from './prefix-command.js';

export function createCommandHandler({ allowed, isStopping, store, mediaStore, usageStore, knowledge, mcp, voiceAPI, voiceManager,
  standalone, active, help, client, answer, signal, logError }) {
  return async function handleCommand(interaction) {
    const stopping = isStopping();
    try {
      if (!allowed(interaction.guildId)) return await interaction.reply({ ...card('Owaua', 'Owaua is not enabled in this server.', { tone: 'warning' }), flags: 64 });
      if (stopping) return await interaction.reply({ ...card('', 'I’m restarting — give me a moment, then try again.'), flags: 64 });
      if (interaction.commandName === 'language') return await handleLanguageCommand(interaction, store, interaction.options.getString('name') ?? '');
      if (interaction.commandName === 'full') return await handleFullCommand(interaction, store);
      if (['jobs', 'usage'].includes(interaction.commandName)) return await handleMediaCommand(interaction, mediaStore, usageStore);
      if (interaction.commandName === 'knowledge') {
        const run = () => handleKnowledgeCommand(interaction, knowledge, { isActive: () => false, stopping, signal });
        return await (interaction.options.getSubcommand() === 'list' ? run() : standalone(interaction, run, { charge: interaction.options.getSubcommand() === 'add' }));
      }
      if (interaction.commandName === 'integrations') return await interaction.reply({ ...card('',
        mcp.list({ userId: interaction.user.id, guildId: interaction.guildId })
          .map(server => `\`${server.label}\` — ${server.description}`).join('\n') + '\n\nChoose labels with /ask integrations:... for that request only.'), flags: 64 });
      if (interaction.commandName === 'speak') return await standalone(interaction, () => handleSpeakCommand(interaction, voiceAPI, { signal,
        onUsage: data => console.log(JSON.stringify({ event: 'voice_usage', ...data })) }));
      if (interaction.commandName === 'transcribe') return await standalone(interaction, () => handleTranscribeCommand(interaction, voiceAPI, { signal,
        onUsage: data => console.log(JSON.stringify({ event: 'voice_usage', ...data })) }));
      if (interaction.commandName === 'voice') {
        const run = () => handleVoiceCommand(interaction, voiceManager, voiceAPI, { signal });
        return await (interaction.options.getSubcommand() === 'join' ? standalone(interaction, run, { voice: true }) : run());
      }
      if (interaction.commandName === 'memory') return await handleMemoryCommand(interaction, store, { isActive: scope => active.has(scope), stopping });
      if (interaction.commandName === 'persona') {
        if (stopping) return await interaction.reply({ ...card('', 'I’m restarting — give me a moment, then try again.'), flags: 64 });
        return await handlePersonaCommand(interaction, store);
      }
      const scope = conversationScope(interaction.guildId, interaction.channelId, interaction.user.id);
      if (interaction.commandName === 'help') return await interaction.reply({ ...help, flags: 64 });
      if (interaction.commandName === 'reset') {
        if (active.has(scope)) return await interaction.reply({ ...card('Owaua', 'Let me finish your current request, then you can reset our chat.', { tone: 'warning' }), flags: 64 });
        store.reset(scope);
        return await interaction.reply({ ...card('A fresh start', 'Fresh start — I’ve cleared your conversation history and saved notes in this channel.', { tone: 'success' }), flags: 64 });
      }
      if (interaction.commandName !== 'ask') return;
      let attachments;
      try {
        const supplied = ['image', 'file', 'video', 'audio'].map(name => interaction.options.getAttachment(name)).filter(Boolean);
        attachments = requestAttachments({ attachments: new Map(supplied.map((a, i) => [i, a])) }, undefined, client.user.id);
      } catch (error) {
        return await interaction.reply({ ...card('Owaua', error.message, { tone: 'warning' }), flags: 64 });
      }
      await interaction.deferReply();
      await answer({ scope, userId: interaction.user.id, guildId: interaction.guildId, text: interaction.options.getString('prompt', true),
        useLibrary: interaction.options.getBoolean('library') ?? false, spoken: interaction.options.getBoolean('spoken') ?? false,
        ...attachments, requestOptions: {
          reasoningEffort: interaction.options.getString('reasoning'), webDomains: interaction.options.getString('web_domains'),
          xHandles: interaction.options.getString('x_handles'), fromDate: interaction.options.getString('from_date'),
          toDate: interaction.options.getString('to_date'), visualSearch: interaction.options.getBoolean('visual_search'),
          outputFormat: interaction.options.getString('output'), schema: interaction.options.getString('schema'), integrations: interaction.options.getString('integrations'),
        }, send: payload => interaction.editReply(payload) });
    } catch (error) {
      if (error instanceof PrefixPrivateReplyError) {
        await interaction.sourceMessage.reply(card('', 'I couldn’t send you a DM. Enable DMs or use the slash command for a private reply.'));
        return;
      }
      logError('interaction_error', error);
    }
  };
}
