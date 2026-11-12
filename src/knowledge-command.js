import { conversationScope } from './store.js';
import { card } from './ui.js';
import { KnowledgeError, knowledgeFilename } from './knowledge.js';
import { fullModeActive } from './full-mode.js';

export const knowledgeCommand = {
  name: 'knowledge', description: 'Manage your private document library for this channel', options: [
    { type: 1, name: 'add', description: 'Save a PDF, text, or code attachment for later questions', options: [
      { type: 11, name: 'file', description: 'A document up to 20 MiB (20 documents, 40 MiB total per channel)', required: true },
    ] },
    { type: 1, name: 'list', description: 'Privately list your saved documents in this channel' },
    { type: 1, name: 'forget', description: 'Delete a saved document from xAI and your library', options: [
      { type: 4, name: 'id', description: 'The document ID from /knowledge list', required: true, min_value: 1, max_value: Number.MAX_SAFE_INTEGER },
    ] },
    { type: 1, name: 'clear', description: 'Delete all documents in your library in this channel' },
  ],
};

const displayName = value => knowledgeFilename(value).replace(/[\\`*_{}\[\]()~|>]/g, '\\$&');
const size = bytes => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

// No user/scope/URL command fields are accepted. Only the actor's resolved
// Discord attachment can enter the library; every response is ephemeral.
export async function handleKnowledgeCommand(interaction, library, { isActive = () => false, stopping = false, signal } = {}) {
  const reply = text => interaction.reply({ ...card('', text), flags: 64 });
  if (stopping) return reply('I’m restarting. Please try again shortly.');
  const scope = conversationScope(interaction.guildId, interaction.channelId, interaction.user.id);
  const action = interaction.options.getSubcommand();
  if (action === 'list') {
    const documents = library.list(scope);
    const entries = documents.map(document => `#${document.id} · ${displayName(document.filename)} · ${size(document.bytes)}`);
    return reply([fullModeActive() ? `You’ve saved ${documents.length} documents here (${size(documents.reduce((sum, document) => sum + document.bytes, 0))}). Full mode bypasses per-channel limits. Shared storage limits still apply.` : `You’ve saved ${documents.length} of 20 documents here (${size(documents.reduce((sum, document) => sum + document.bytes, 0))} of 40 MiB used).`,
      ...entries, !documents.length ? 'Want to save a document for later? Attach a PDF, text, or code file with /knowledge add.' : '',
      'Use /ask library:true when you want me to look through these files for an answer. xAI’s document search can access every document you’ve saved here.',
      'Your files stay at xAI until you remove them with /knowledge forget or clear. Only you see these library commands; /ask answers are visible in the channel.'].filter(Boolean).join('\n\n'));
  }
  if (!['add', 'forget', 'clear'].includes(action)) return reply('Use /knowledge add, list, forget, or clear.');
  if (isActive(scope) || library.isActive(scope)) return reply('Please wait for your current request in this channel to finish before changing your library.');
  let attachment, id;
  if (action === 'add') {
    attachment = interaction.options.getAttachment('file', true);
    if (!attachment) return reply('Attach a PDF, text, or code document directly to Discord.');
  }
  if (action === 'forget') {
    id = interaction.options.getInteger('id', true);
    if (!Number.isSafeInteger(id) || id < 1) return reply('Choose a valid document ID from /knowledge list.');
  }
  await interaction.deferReply({ flags: 64 });
  const finish = text => interaction.editReply(card('', text));
  try {
    if (action === 'add') {
      const document = await library.add(scope, attachment, { signal });
      return finish(`Saved **${displayName(document.filename)}** as document #${document.id} (${size(document.bytes)}). Ask about it with /ask library:true. It stays at xAI until you remove it with /knowledge forget or clear.`);
    }
    if (action === 'forget') {
      return finish(await library.forget(scope, id, { signal })
        ? `I’ve removed document #${id} from your library and xAI. Our earlier answers may still include information from it.`
        : 'I couldn’t find that document here. Check /knowledge list for the right ID.');
    }
    const result = await library.clear(scope, { signal });
    return finish(result.failed
      ? `Removed ${result.deleted} ${result.deleted === 1 ? 'document' : 'documents'}. I couldn’t remove ${result.failed}; they’re still in your list. Try /knowledge clear again for those.`
      : `Removed ${result.deleted} ${result.deleted === 1 ? 'document' : 'documents'} from your library and xAI. Our earlier answers may still include information from them.`);
  } catch (error) {
    return finish(error instanceof KnowledgeError ? error.message
      : 'I couldn’t finish that library change. Use /knowledge list to check what is saved, then try again.');
  }
}
