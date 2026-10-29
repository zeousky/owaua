import { card } from './ui.js';
import { FULL_MODE_OWNER } from './full-mode.js';
import { ProviderSwitchError } from './providers.js';

export const providerCommand = {
  name: 'provider', description: 'Owner only: view or switch the bot’s AI provider', options: [
    { type: 3, name: 'name', description: 'Choose a provider, or switch to the other one. Leave empty to view.',
      choices: [{ name: 'xAI', value: 'xai' }, { name: 'Mistral', value: 'mistral' }, { name: 'Switch', value: 'switch' }] },
  ],
};

export async function handleProviderCommand(interaction, router) {
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  if (interaction.user.id !== FULL_MODE_OWNER) return reply('Only the bot owner can view or change the bot’s AI provider.');
  if (!router) return reply('Provider switching is not available yet.');
  const name = interaction.options.getString('name');
  try {
    const status = name === null ? router.status() : router.setProvider(name);
    return reply(`Provider: ${status.provider === 'mistral' ? 'Mistral' : 'xAI'} (${status.model}). This applies to everyone and survives restarts. Configured: ${status.configured.join(', ')}. Use .provider xai, .provider mistral, or .provider switch. A confirmed insufficient-balance error switches to the other configured provider automatically.`);
  } catch (error) {
    if (!(error instanceof ProviderSwitchError)) throw error;
    return reply(error.message);
  }
}
