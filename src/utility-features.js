import { MessageFlags } from 'discord.js';
import { developerCommands, handleDeveloperCommand } from './utility-developer.js';
import { informationCommands, handleInformationCommand } from './utility-information.js';
import { createModerationFeatures, moderationCommands } from './utility-moderation.js';
import { SafetyError } from './safety.js';
import { UtilityInputError } from './utility-input.js';

export const utilityCommands = [...informationCommands, ...moderationCommands, ...developerCommands];
const informationNames = new Set(informationCommands.map(command => command.name));
const moderationNames = new Set(moderationCommands.map(command => command.name));
const allowedMentions = { parse: [], repliedUser: false };

export function createUtilityFeatures({ directory, client, allowed, signal, logError }) {
  const moderation = createModerationFeatures({ directory, client, signal, logError });
  const running = new Set();
  let closing = false;

  async function run(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { commandName } = interaction;
    let result;
    try {
      if (moderationNames.has(commandName)) result = await moderation.handleCommand(interaction);
      else if (informationNames.has(commandName)) result = handleInformationCommand(interaction);
      else result = await handleDeveloperCommand(interaction);
    } catch (error) {
      if (error instanceof UtilityInputError || error instanceof SafetyError) result = { content: error.message };
      else {
        logError('owaua_utility_error', error);
        result = { content: 'Owaua couldn’t complete that command. Check the parameters and server permissions.' };
      }
    }
    await interaction.editReply({ ...result, allowedMentions });
  }

  return {
    async handleCommand(interaction) {
      if (!allowed(interaction.guildId) || closing || signal?.aborted) {
        const content = closing || signal?.aborted ? 'Owaua is restarting. Try again shortly.' : 'Owaua is disabled in this server.';
        await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions });
        return;
      }
      const operation = run(interaction);
      running.add(operation);
      try { await operation; }
      finally { running.delete(operation); }
    },
    async close() {
      closing = true;
      await Promise.allSettled(running);
      moderation.close();
    },
  };
}
