import { escapeMarkdown } from 'discord.js';
import { assertSafeText, SafetyError } from './safety.js';
import { cleanServerText } from './server-language.js';

export class UtilityInputError extends Error {}

export function safeDisplayText(text, fallback = 'Unavailable') {
  try {
    assertSafeText(text);
    return cleanServerText(escapeMarkdown(text.replace(/[\r\n]+/gu, ' '), { maskedLink: true }));
  } catch (error) {
    if (!(error instanceof SafetyError)) throw error;
    return fallback;
  }
}

export function discordDate(ms) {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}
