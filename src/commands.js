import { personaCommand } from './persona-command.js';
import { languageCommand } from './language-command.js';
import { memoryCommand } from './memory-command.js';
import { jobsCommand, usageCommand } from './media-command.js';
import { knowledgeCommand } from './knowledge-command.js';
import { speakCommand, transcribeCommand, voiceCommand } from './voice-command.js';

// One registry for Discord registration and dot-prefix parsing.
export const commands = [
  { name: 'ask', description: 'Ask Kirmy anything', options: [
    { type: 3, name: 'prompt', description: 'Your question', required: true, max_length: 6000 },
    { type: 11, name: 'image', description: 'Optional image to understand' },
    { type: 11, name: 'file', description: 'Optional PDF, text, or code document to analyze' },
    { type: 11, name: 'video', description: 'Optional MP4 to edit or extend' },
    { type: 11, name: 'audio', description: 'Optional audio or voice message to transcribe and answer' },
    { type: 5, name: 'spoken', description: 'Also generate a spoken MP3 of the answer' },
    { type: 5, name: 'library', description: 'Use your saved document library in this channel' },
    { type: 3, name: 'output', description: 'Answer format (default: text)', choices: [{ name: 'Text', value: 'text' }, { name: 'JSON file', value: 'json' }] },
    { type: 3, name: 'schema', description: 'Optional JSON Schema for JSON output (object, up to 4000 characters)', max_length: 4000 },
    { type: 3, name: 'integrations', description: 'Opt into read-only MCP integrations, e.g. xai_docs,deepwiki', max_length: 200 },
    { type: 3, name: 'reasoning', description: 'Reasoning effort; higher can take longer and cost more', choices:
      ['low', 'medium', 'high', 'xhigh'].map(value => ({ name: value, value })) },
    { type: 3, name: 'web_domains', description: 'Limit web search to these domains (comma-separated, up to 5)', max_length: 1000 },
    { type: 3, name: 'x_handles', description: 'Limit X search to these handles (comma-separated, up to 20)', max_length: 400 },
    { type: 3, name: 'from_date', description: 'Search X posts from this date (YYYY-MM-DD)', max_length: 10 },
    { type: 3, name: 'to_date', description: 'Search X posts before this date (YYYY-MM-DD, exclusive)', max_length: 10 },
    { type: 5, name: 'visual_search', description: 'Allow web image search and search image/video understanding' },
  ] },
  { name: 'reset', description: 'Clear your Kirmy history and saved memories in this channel' },
  { name: 'help', description: 'Show what Kirmy can do' },
  personaCommand,
  languageCommand,
  memoryCommand,
  jobsCommand, usageCommand,
  knowledgeCommand, speakCommand, transcribeCommand, voiceCommand,
  { name: 'integrations', description: 'Privately list the read-only integrations available to you' },
];
