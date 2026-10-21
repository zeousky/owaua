import { CustomPersonaError, DEFAULT_PERSONA, MAX_CUSTOM_PERSONA_LENGTH, PERSONA_OPTIONS } from './persona.js';
import { card } from './ui.js';

export const personaCommand = {
  name: 'persona', description: 'Set the default persona Kirmy uses only for you', options: [
    { type: 1, name: 'set', description: 'Set your default persona; use description for your own character',
      options: [...Object.entries(PERSONA_OPTIONS).map(([name, choices]) => ({
        type: 3, name, description: name === 'character' ? 'Choose a built-in character or Custom' : `Your preferred ${name} for built-in characters`, choices: Object.entries(choices).map(([value, label]) => ({ name: label, value })),
      })), { type: 3, name: 'description', description: 'Custom character or speaking style for you only (max 120 characters)',
        min_length: 1, max_length: MAX_CUSTOM_PERSONA_LENGTH }] },
    { type: 1, name: 'view', description: 'Privately view your personal style' },
    { type: 1, name: 'reset', description: 'Restore Kirmy’s default style for yourself' },
  ],
};

function describe(persona) {
  if (persona.character === 'custom') return persona.description.replace(/[\\`*_{}\[\]()~|]/g, '\\$&');
  return Object.entries(PERSONA_OPTIONS).map(([key, choices]) => `${key[0].toUpperCase() + key.slice(1)}: ${choices[persona[key]]}`).join('\n');
}

// The actor comes exclusively from Discord's authenticated interaction, never
// from command arguments, message mentions, model tool calls, or an admin target.
export async function handlePersonaCommand(interaction, store) {
  const actor = interaction.user.id;
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  const action = interaction.options.getSubcommand();
  if (action === 'view') return reply(`Your default persona:\n${describe(store.persona(actor))}\n\nI use this automatically only for you, across servers and DMs, until you change or reset it.`);
  if (action === 'reset') {
    store.resetPersona(actor);
    return reply(`Your persona has been reset.\n${describe(DEFAULT_PERSONA)}\n\nYour conversation history is unchanged. Use /reset to clear it in this channel.`);
  }
  if (action !== 'set') return reply('Use /persona set, /persona view, or /persona reset.');
  const changes = {};
  for (const key of Object.keys(PERSONA_OPTIONS)) {
    const value = interaction.options.getString(key);
    if (value !== null) changes[key] = value;
  }
  const description = interaction.options.getString('description');
  if (description !== null) changes.description = description;
  if (!Object.keys(changes).length) return reply('Choose at least one style option to change your persona.');
  // Validate every option before writing anything. Never echo rejected input.
  let persona;
  try {
    const current = store.persona(actor);
    // Supplying a description selects Custom automatically unless the caller
    // explicitly selected a different character. Switching away deletes it.
    if (description !== null && changes.character === undefined) changes.character = 'custom';
    if (description !== null && changes.character !== 'custom') return reply('Choose character:custom when supplying a custom description. Your persona was not changed.');
    const next = { ...current, ...changes };
    if (next.character === 'custom' && !next.description) return reply('Add a description of your custom character or speaking style (1–120 characters). Your persona was not changed.');
    if (next.character === 'custom' && ['tone', 'detail', 'format'].some(key => Object.hasOwn(changes, key))) {
      return reply('Your custom description defines your persona. Include your preferred tone, detail, or format in that description, or choose a built-in character to use those options. Your persona was not changed.');
    }
    if (next.character !== 'custom') delete next.description;
    persona = store.setPersona(actor, next);
  } catch (error) {
    if (error instanceof CustomPersonaError) return reply(`${error.message} Your persona was not changed.`);
    if (error.message !== 'Invalid persona') throw error;
    return reply('Please choose one of the listed persona options. Your persona was not changed.');
  }
  return reply(`Your default persona is now:\n${describe(persona)}\n\nI’ll use this automatically only for you, across servers and DMs, until you change it or use /persona reset.`);
}
