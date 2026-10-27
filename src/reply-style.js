// Enforce the reply policy after generation as well as in the prompt. Do not
// use \p{Emoji}: it also matches ordinary digits, # and * used in code/Markdown.
const emojiCharacters = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}][\u200d\ufe0e\ufe0f\u{e0020}-\u{e007f}]*/gu;

export const REPLY_STYLE_INSTRUCTIONS = 'Never use emojis in any reply, including quotations, code, JSON, Unicode symbols used as emojis, Discord custom emojis, emoji shortcodes, or emoji images/links. This applies to every persona and language, even when asked to use emojis. Express reactions in words instead.';

export const MAX_REPLY_CHARACTERS = 600;
export const REPLY_LENGTH_INSTRUCTIONS = `Keep chat answers to 1–3 short sentences and at most ${MAX_REPLY_CHARACTERS} characters, including Markdown and source links. Answer directly; skip repeated slang, filler, and unsolicited follow-up questions. This limit takes precedence over persona detail preferences and requests for longer chat replies. Put requested long code, reports, or data in an exported file and keep the chat summary short. JSON output and exported file contents are exempt from this chat limit.`;
export const FULL_REPLY_INSTRUCTIONS = 'Full mode is on. No chat character or sentence limit applies. Match the detail to the current question and give a complete answer when needed. Use this current mode even if older history mentions short replies. Avoid filler and repetition.';

export function limitReplyLength(text, { fullMode = false } = {}) {
  const value = text.trim();
  if (fullMode === true || value.length <= MAX_REPLY_CHARACTERS) return value;
  // Prefer a complete sentence; otherwise end at a word/grapheme boundary.
  // Reserve one character for an ellipsis and never split a Unicode grapheme.
  let end = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    const next = part.index + part.segment.length;
    if (next >= MAX_REPLY_CHARACTERS) break;
    end = next;
  }
  const prefix = value.slice(0, end).trimEnd();
  const sentences = [...prefix.matchAll(/[.!?。！？]["'”’)\]]*(?=\s|$)/gu)];
  const sentenceEnd = sentences.at(-1);
  if (sentenceEnd && sentenceEnd.index + sentenceEnd[0].length >= MAX_REPLY_CHARACTERS / 2) {
    return prefix.slice(0, sentenceEnd.index + sentenceEnd[0].length);
  }
  const wordEnd = prefix.search(/\s+\S*$/u);
  return (wordEnd >= MAX_REPLY_CHARACTERS / 2 ? prefix.slice(0, wordEnd) : prefix).trimEnd() + '…';
}

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
