import { CustomPersonaError, DEFAULT_PERSONA, MAX_CUSTOM_PERSONA_LENGTH, PERSONA_OPTIONS } from './persona.js';
import { card } from './ui.js';

export const personaCommand = {
  name: 'persona', description: 'Choose how I talk to you', options: [
    { type: 1, name: 'set', description: 'Set your default persona; use description for your own character',
      options: [...Object.entries(PERSONA_OPTIONS).map(([name, choices]) => ({
        type: 3, name, description: name === 'character' ? 'Choose a built-in character or Custom' : `Your preferred ${name} for built-in characters`, choices: Object.entries(choices).map(([value, label]) => ({ name: label, value })),
      })), { type: 3, name: 'description', description: 'Custom character or speaking style for you only (max 120 characters)',
        min_length: 1, max_length: MAX_CUSTOM_PERSONA_LENGTH }] },
    { type: 1, name: 'view', description: 'Privately view your personal style' },
    { type: 1, name: 'reset', description: 'Restore Owaua’s default style for yourself' },
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
  if (action === 'view') return reply(`Here’s how I’m set up to talk to you:\n${describe(store.persona(actor))}\n\nThis follows you across servers and DMs. Use /persona set to change it or /persona reset to go back to my usual style.`);
  if (action === 'reset') {
    store.resetPersona(actor);
    return reply(`Back to my usual style:\n${describe(DEFAULT_PERSONA)}\n\nI’ve kept our conversation history. Use /reset if you want to clear it here too.`);
  }
  if (action !== 'set') return reply('Use /persona set, /persona view, or /persona reset.');
  const changes = {};
  for (const key of Object.keys(PERSONA_OPTIONS)) {
    const value = interaction.options.getString(key);
    if (value !== null) changes[key] = value;
  }
  const description = interaction.options.getString('description');
  if (description !== null) changes.description = description;
  if (!Object.keys(changes).length) return reply('Pick a style option, or tell me how you’d like me to talk in the description.');
  // Validate every option before writing anything. Never echo rejected input.
  let persona;
  try {
    const current = store.persona(actor);
    // Supplying a description selects Custom automatically unless the caller
    // explicitly selected a different character. Switching away deletes it.
    if (description !== null && changes.character === undefined) changes.character = 'custom';
    if (description !== null && changes.character !== 'custom') return reply('Choose character:custom to use your own description. I haven’t changed your style yet.');
    const next = { ...current, ...changes };
    if (next.character === 'custom' && !next.description) return reply('Tell me about your character or speaking style in 1–120 characters. I haven’t changed your style yet.');
    if (next.character === 'custom' && ['tone', 'detail', 'format'].some(key => Object.hasOwn(changes, key))) {
      return reply('For a custom character, put the tone, detail, and format you want in the description itself. Those separate options work with built-in characters. I haven’t changed your style yet.');
    }
    if (next.character !== 'custom') delete next.description;
    persona = store.setPersona(actor, next);
  } catch (error) {
    if (error instanceof CustomPersonaError) return reply(`${error.message} I haven’t changed your style yet.`);
    if (error.message !== 'Invalid persona') throw error;
    return reply('Pick one of the style options in the command. I haven’t changed your style yet.');
  }
  return reply(`Got it — here’s how I’ll talk to you:\n${describe(persona)}\n\nThis follows you across servers and DMs. You can change it anytime, or use /persona reset to bring back my usual style.`);
}
