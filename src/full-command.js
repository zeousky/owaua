import { card } from './ui.js';

export const fullCommand = {
  name: 'full', description: 'Turn full-length replies on or off for yourself', options: [
    { type: 3, name: 'mode', description: 'On removes the chat length cap; off restores it. Leave empty to view.',
      choices: [{ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }] },
  ],
};

export async function handleFullCommand(interaction, store) {
  const actor = interaction.user.id;
  const mode = interaction.options.getString('mode');
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  if (mode !== null && !['on', 'off'].includes(mode)) return reply('Use .full on or .full off. Your setting was not changed.');
  const enabled = mode === null ? store.fullMode(actor) : store.setFullMode(actor, mode === 'on');
  return reply(`Full mode is ${enabled ? 'on. Replies have no chat length cap; answers over Discord’s message limit arrive as a complete file.' : 'off. Chat replies stay within 600 characters.'} This follows you across servers and DMs. Use .full on or .full off to change it.`);
}
