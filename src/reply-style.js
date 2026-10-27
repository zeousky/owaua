// Enforce the reply policy after generation as well as in the prompt. Do not
// use \p{Emoji}: it also matches ordinary digits, # and * used in code/Markdown.
const emojiCharacters = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}][\u200d\ufe0e\ufe0f\u{e0020}-\u{e007f}]*/gu;

export const REPLY_STYLE_INSTRUCTIONS = 'Never use emojis in any reply, including quotations, code, JSON, Unicode symbols used as emojis, Discord custom emojis, emoji shortcodes, or emoji images/links. This applies to every persona and language, even when asked to use emojis. Express reactions in words instead.';

export function stripEmojis(text, { trim = true } = {}) {
  const clean = value => value
    .replace(/<a?:[A-Za-z0-9_]+:[0-9]+>/g, '')
    .replace(/:(?:[A-Za-z_][A-Za-z0-9_+-]*|[+-]1):/g, '')
    .replace(/[#*0-9]\ufe0f?\u20e3/gu, '')
    .replace(emojiCharacters, '');
  const result = clean(text
    // Remove an emoji-only link as a unit, so Discord's asset URL is not left
    // behind after removing its label. Ordinary citations retain their targets.
    .replace(/!?\[([^\]\n]*)\]\(([^)\n]*)\)/g, (link, label) =>
      label.trim() && !clean(label).trim() ? '' : link)
    .replace(/<?https?:\/\/(?:(?:cdn|media)\.discordapp\.(?:com|net)\/emojis\/)[^\s<>]+>?/gi, ''));
  return trim ? result.trim() : result;
}

// Parse JSON first so escaped emoji code points cannot bypass the filter.
// Keep property names intact; the caller rejects emoji keys rather than
// silently changing the requested schema or collapsing distinct properties.
export function stripJsonEmojis(value) {
  if (typeof value === 'string') return stripEmojis(value, { trim: false });
  if (Array.isArray(value)) return value.map(stripJsonEmojis);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (stripEmojis(key, { trim: false }) !== key) throw new Error('Emoji in JSON property name');
      return [key, stripJsonEmojis(item)];
    }));
  }
  return value;
}
