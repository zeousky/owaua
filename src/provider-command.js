import { card } from './ui.js';
import { FULL_MODE_OWNER } from './full-mode.js';
import { ProviderSwitchError } from './providers.js';

export const providerCommand = {
  name: 'provider', description: 'Owner only: view or switch this server’s AI provider', options: [
    { type: 3, name: 'name', description: 'Choose a provider, or switch to the other one. Leave empty to view.',
      choices: [{ name: 'xAI', value: 'xai' }, { name: 'Mistral', value: 'mistral' }, { name: 'Switch', value: 'switch' }] },
  ],
};

export async function handleProviderCommand(interaction, router) {
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  if (interaction.user.id !== FULL_MODE_OWNER) return reply('Only the bot owner can view or change the bot’s AI provider.');
  if (!router) return reply('Provider switching is not available yet.');
  return router.withScope({ guildId: interaction.guildId, userId: interaction.user.id }, () => {
    const name = interaction.options.getString('name');
    try {
      const status = name === null ? router.status() : router.setProvider(name);
      const destination = interaction.guildId ? 'this server' : 'your DMs';
      return reply(`Provider: ${status.provider === 'mistral' ? 'Mistral' : 'xAI'} (${status.model}) for ${destination}. The choice survives restarts. Configured: ${status.configured.join(', ')}. Use .provider xai, .provider mistral, or .provider switch. Insufficient credit switches only this server or DM context. A low-cost recovery check starts after that error and restores automatic fallback choices when credit returns; manual choices are kept.`);
    } catch (error) {
      if (!(error instanceof ProviderSwitchError)) throw error;
      return reply(error.message);
    }
  });
}
