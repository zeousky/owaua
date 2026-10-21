import { conversationScope } from './store.js';
import { card } from './ui.js';
import { KnowledgeError, knowledgeFilename } from './knowledge.js';

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
    return reply([`Your document library in this channel: ${documents.length} of 20 documents (${size(documents.reduce((sum, document) => sum + document.bytes, 0))} of 40 MiB).`,
      ...entries, !documents.length ? 'Use /knowledge add with a PDF, text, or code attachment to save your first document.' : '',
      'Use /ask library:true to search your saved documents in a question. All saved documents here are available to xAI’s document search. If configured, indexed collections provide semantic retrieval.',
      'Documents are stored at xAI until you use /knowledge forget or clear. Library commands are private; /ask answers are visible in the channel.'].filter(Boolean).join('\n\n'));
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
      return finish(`Saved document #${document.id}: ${displayName(document.filename)} (${size(document.bytes)}). Use /ask library:true to ask about it. Your document stays at xAI until you remove it with /knowledge forget or clear.`);
    }
    if (action === 'forget') {
      return finish(await library.forget(scope, id, { signal })
        ? `Document #${id} has been deleted from your library and xAI. Previous answers may still contain information from it.`
        : 'That document was not found in your library here. Use /knowledge list to check its ID.');
    }
    const result = await library.clear(scope, { signal });
    return finish(result.failed
      ? `Deleted ${result.deleted} documents. ${result.failed} could not be deleted and remain listed; retry /knowledge clear to remove them.`
      : `Deleted ${result.deleted} documents from your library and xAI. Previous answers may still contain information from them.`);
  } catch (error) {
    return finish(error instanceof KnowledgeError ? error.message
      : 'I couldn’t finish that library change. Use /knowledge list to check what is saved, then try again.');
  }
}
