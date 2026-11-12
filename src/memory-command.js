import { conversationScope } from './store.js';
import { card } from './ui.js';
import { assertSafeValue, SafetyError } from './safety.js';
import { MEMORY_REVISION_LIMIT, MEMORY_SOURCE_HISTORY_INCOMPLETE } from './memory.js';

const MAX_VIEW_LENGTH = 30000;
const MAX_VISIBLE_NOTES = 20;
const MAX_ESCAPED_TEXT = 1200;

export const memoryCommand = {
  name: 'memory', description: 'Manage what Owaua remembers about you in this channel', options: [
    { type: 1, name: 'view', description: 'Privately view your saved facts and memory status here', options: [
      { type: 4, name: 'page', description: 'Show another page of saved facts (20 per page)', min_value: 1, max_value: 10 },
    ] },
    { type: 1, name: 'remember', description: 'Save a fact or update an existing fact using the same key', options: [
      { type: 3, name: 'key', description: 'A short topic, such as hosting or preferred-language', required: true, min_length: 1, max_length: 80 },
      { type: 3, name: 'text', description: 'The fact to remember; do not include passwords or other secrets', required: true, min_length: 1, max_length: 1000 },
    ] },
    { type: 1, name: 'forget', description: 'Delete one of your saved facts here by its ID', options: [
      { type: 4, name: 'id', description: 'The memory ID shown by /memory view', required: true, min_value: 1, max_value: Number.MAX_SAFE_INTEGER },
    ] },
    { type: 1, name: 'clear', description: 'Erase your history, archived exchanges, and saved facts here' },
    { type: 1, name: 'pause', description: 'Pause memory for you in this channel and keep existing data' },
    { type: 1, name: 'resume', description: 'Resume memory for you in this channel' },
  ],
};

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]()~|>]/g, '\\$&');
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) + ' UTC' : 'date unavailable';
}

function describeMemory(status, notes, page) {
  const pages = Math.max(1, Math.ceil(status.notes / MAX_VISIBLE_NOTES));
  const start = (page - 1) * MAX_VISIBLE_NOTES;
  const parts = [
    `Memory for you in this channel: ${status.paused ? 'paused' : 'on'}.`,
    `Saved facts: ${status.notes}. Archived exchanges: ${status.turns}.`,
    'I only use your memories from this server and channel here. Your persona has its own settings.',
  ];
  let shown = 0;
  for (const note of notes.slice(start, start + MAX_VISIBLE_NOTES)) {
    let hidden = false;
    try { assertSafeValue({ key: note.key, text: note.text }, { instructions: true }); }
    catch (error) { if (!(error instanceof SafetyError)) throw error; hidden = true; }
    // Bound even malformed legacy data before escaping or producing an attachment.
    const key = hidden ? 'Hidden note' : escapeMarkdown(String(note.key).slice(0, 80));
    let text = hidden ? 'This saved note is hidden by the reply policy. Use /memory forget with its ID to remove it.' : escapeMarkdown(String(note.text).slice(0, 1000));
    // Keep every note ID on its page accessible even when escaping expands text.
    if (text.length > MAX_ESCAPED_TEXT) text = text.slice(0, MAX_ESCAPED_TEXT).replace(/\\+$/, '') + '\n[Fact text shortened]';
    const entry = `#${note.id} · ${key} · updated ${dateLabel(note.updated_at)}\n${text}`;
    if (parts.join('\n\n').length + entry.length + 300 > MAX_VIEW_LENGTH) break;
    parts.push(entry);
    shown++;
  }
  if (!status.notes) parts.push('I haven’t saved any notes here yet. Tell me what to keep with /memory remember.');
  const range = shown ? ` (facts ${start + 1}–${start + shown})` : '';
  parts.push(`Page ${page} of ${pages}. Showing ${shown} of ${status.notes} saved facts${range}.`);
  if (pages > 1) parts.push(`Use /memory view page:1 through page:${pages} to browse your saved facts.`);
  parts.push('Save a note with the same key to update it. /memory clear erases your history and saved notes here.');
  return parts.join('\n\n');
}

// Scope comes only from the authenticated Discord interaction. No command option
// can select another user, server, or channel, and these commands make no AI calls.
export async function handleMemoryCommand(interaction, store, { isActive = () => false, stopping = false } = {}) {
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  if (stopping) return reply('I’m restarting. Please try again shortly.');
  const userId = interaction.user.id;
  const scope = conversationScope(interaction.guildId, interaction.channelId, userId);
  const action = interaction.options.getSubcommand();
  if (action === 'view') {
    const page = interaction.options.getInteger?.('page') ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 10) return reply('Choose a valid memory page from /memory view.');
    const status = store.memoryStatus(scope);
    const pages = Math.max(1, Math.ceil(status.notes / MAX_VISIBLE_NOTES));
    if (page > pages) return reply('Choose a valid memory page from /memory view.');
    return reply(describeMemory(status, store.listMemories(scope), page));
  }
  if (!['remember', 'forget', 'clear', 'pause', 'resume'].includes(action)) {
    return reply('Use /memory view, remember, forget, clear, pause, or resume.');
  }
  if (isActive(scope)) return reply('Let me finish your current request here before you change my memory.');
  if (action === 'remember') {
    const key = interaction.options.getString('key', true);
    const text = interaction.options.getString('text', true);
    if (typeof key !== 'string' || !key.trim() || key.length > 80 ||
        typeof text !== 'string' || !text.trim() || text.length > 1000) {
      return reply('Use a key of 1–80 characters and a fact of 1–1,000 characters. Your memory was not changed.');
    }
    let note;
    try {
      note = store.remember(scope, userId, { key: key.trim(), text: text.trim(), source: 'command', explicit: true });
    } catch (error) {
      if (error.message === 'Memory is paused') return reply('Memory is paused here. Use /memory resume before saving a fact.');
      if (error.message === MEMORY_REVISION_LIMIT) return reply(MEMORY_REVISION_LIMIT);
      // Do not reflect rejected input, which may contain the secret that was refused.
      return reply('I couldn’t save that memory. Use a short fact without secrets and a key containing letters, numbers, spaces, dots, underscores, or hyphens.');
    }
    return reply(`Got it — saved as memory #${note.id} in this channel. Use the same key to update it, or /memory view to take a look.`);
  }
  if (action === 'forget') {
    const id = interaction.options.getInteger('id', true);
    if (!Number.isSafeInteger(id) || id < 1) return reply('Choose a valid positive memory ID from /memory view. Your memory was not changed.');
    try {
      return reply(store.forgetMemory(scope, id)
        ? `I’ve deleted memory #${id} here. It might still come up in our old conversations. Use /memory clear to remove those too.`
        : 'I couldn’t find a saved note with that ID here. Check /memory view for the right number.');
    } catch (error) {
      if (error.message === MEMORY_SOURCE_HISTORY_INCOMPLETE) return reply(MEMORY_SOURCE_HISTORY_INCOMPLETE);
      throw error;
    }
  }
  if (action === 'clear') {
    store.clearMemory(scope);
    return reply('Fresh start — I’ve cleared your history and saved notes in this channel. Your persona and memory on/off setting stay as they were.');
  }
  const paused = action === 'pause';
  store.pauseMemory(scope, paused);
  return reply(paused
    ? 'Memory is paused here. I’ll keep your saved notes, but won’t read or add to your context until you use /memory resume.'
    : 'Memory’s back on here. I can use your saved notes and context again.');
}
