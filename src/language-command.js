import { LANGUAGE_NAMES, LanguageError, languageName, resolveLanguage } from './language.js';
import { card } from './ui.js';

export const languageCommand = {
  name: 'language', description: 'Choose the language I reply to you in', options: [
    { type: 3, name: 'name', description: 'Language name, e.g. Hungarian; auto/reset, list, or leave empty to view', max_length: 80 },
  ],
};

export function parseLanguageCommand(content) {
  if (typeof content !== 'string' || !/^\.language(?:\s|$)/i.test(content)) return null;
  return { value: content.slice('.language'.length).trim() };
}

export async function handleLanguageCommand(event, store, value) {
  // Prefix commands and slash commands both use the authenticated sender only.
  const actor = event.author?.id ?? event.user.id;
  const reply = text => event.reply({ ...card('', text), ...(event.author ? {} : { flags: 64 }) });
  if (value === '') return reply(`I’m set to: ${languageName(store.language(actor))}.\nTry \`.language Hungarian\` to change it, \`.language auto\` to let me match your message, or \`.language list\` to see your options.`);
  if (typeof value === 'string' && /^list$/i.test(value)) return reply(`Here are the languages you can choose from:\n${LANGUAGE_NAMES.join(', ')}\n\nTry \`.language Hungarian\`, or use \`.language auto\` to let me match your message. I handle some languages better than others.`);
  try {
    const code = typeof value === 'string' && /^(auto|reset)$/i.test(value) ? 'auto' : resolveLanguage(value);
    store.setLanguage(actor, code);
    return reply(`${code === 'auto' ? 'I’ll match the language of your messages again.' : `Got it — I’ll reply to you in ${languageName(code)}.`} This follows you across servers and DMs, including new voice sessions. Use \`.language auto\` whenever you want me to match your message.`);
  } catch (error) {
    if (!(error instanceof LanguageError)) throw error;
    return reply(error.message);
  }
}
