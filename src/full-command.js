import { card } from './ui.js';
import { FULL_MODE_OWNER } from './full-mode.js';

export const fullCommand = {
  name: 'full', description: 'Owner only: turn full mode on or off', options: [
    { type: 3, name: 'mode', description: 'Bypass bot usage and execution limits. Leave empty to view.',
      choices: [{ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }] },
  ],
};

export async function handleFullCommand(interaction, store) {
  const actor = interaction.user.id;
  const mode = interaction.options.getString('mode');
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  if (actor !== FULL_MODE_OWNER) return reply('Only the bot owner can use full mode.');
  if (mode !== null && !['on', 'off'].includes(mode)) return reply('Use .full on or .full off. Your setting was not changed.');
  const enabled = mode === null ? store.fullMode(actor) : store.setFullMode(actor, mode === 'on');
  return reply(`Full mode is ${enabled ? 'on. Bot quotas, cooldowns, concurrency caps, reply caps, and request/tool budgets are bypassed. Long answers arrive as complete files.' : 'off. Normal bot limits apply, including the 600-character chat cap.'} This follows you across servers and DMs. Discord/provider limits, safety checks and data-protection locks still apply. Use .full on or .full off to change it.`);
}
