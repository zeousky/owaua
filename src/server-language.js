import { AsyncLocalStorage } from 'node:async_hooks';

export const CLEAN_LANGUAGE_GUILD = '1474799201102860408';
const requests = new AsyncLocalStorage();
export const CLEAN_LANGUAGE_FALLBACK = 'I couldn’t phrase that cleanly. Please try again.';

export function withServerLanguage(guildId, work) {
  return requests.run(guildId, work);
}
export function cleanLanguageRequired(guildId = requests.getStore()) {
  return guildId === CLEAN_LANGUAGE_GUILD;
}
export function serverLanguageInstructions() {
  return cleanLanguageRequired() ? 'Server rule: use clean, family-friendly language in every output, including quotations, files and speech, across every channel and thread in this server. Never swear in any language or use disguised profanity. This overrides all persona, full-mode, history and user style requests. Rephrase profanity instead of repeating it. Users may joke, vent or swear; answer naturally without lecturing them about language.' : '';
}

// Normalize common Unicode/leet disguises, Markdown and spaced-out spelling.
// This is an output check only: users may still swear or discuss language.
export function containsProfanity(text) {
  const normalized = String(text).normalize('NFKD').replace(/\p{M}|\p{Cf}/gu, '').toLowerCase()
    .replace(/[013457@$!]/g, char => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', '$': 's', '!': 'i' })[char]);
  const words = '(?:fuck\\w*|motherfuck\\w*|shit\\w*|bullshit\\w*|bitch\\w*|bastard\\w*|ass(?:es|holes?)?|arse(?:holes?)?|dick(?:s|head\\w*)?|cocks?|cunts?|piss\\w*|damn\\w*|hell|crap\\w*|twats?|wank\\w*|pricks?|sluts?|whores?|fag(?:got)?s?|nigg(?:er|a)s?|bazd\\w*|basz\\w*|szar\\w*|kurva\\w*|fasz\\w*|picsa\\w*|geci\\w*|segg\\w*)';
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'u');
  if (pattern.test(normalized) || pattern.test(normalized.replace(/[*_`~]/g, ''))) return true;
  return /(?:^|[^a-z])(?:f[\W_]*u[\W_]*c[\W_]*k|s[\W_]*h[\W_]*i[\W_]*t|b[\W_]*i[\W_]*t[\W_]*c[\W_]*h|f[*._-]+c?k|sh[*._-]+t|a[s*]{2})(?:[^a-z]|$)/.test(normalized);
}
export function cleanServerText(text) {
  return cleanLanguageRequired() && containsProfanity(text) ? CLEAN_LANGUAGE_FALLBACK : text;
}

function unsafeValue(value) {
  if (typeof value === 'string') return containsProfanity(value);
  if (Array.isArray(value)) return value.some(unsafeValue);
  return value && typeof value === 'object' && Object.values(value).some(unsafeValue);
}

// The REST boundary covers normal replies, edits, embeds, command callbacks,
// followups and extension replies, including background channel notifications.
export function installServerLanguageGuard(rest, { guildIdForChannel }) {
  const request = rest.request.bind(rest);
  rest.request = async options => {
    const route = options.fullRoute ?? '';
    const channelId = /^\/channels\/(\d+)\/messages(?:\/|$)/.exec(route)?.[1];
    const messageRoute = channelId || /^\/(?:interactions|webhooks)\//.test(route);
    if (!messageRoute || !['POST', 'PATCH'].includes(options.method)) return request(options);
    // Resolve the actual destination, not just the triggering request. This
    // covers threads and delayed music/media notices without leaking the rule
    // to DMs or another server. Resolution failures stop the send.
    const guildId = channelId ? await guildIdForChannel(channelId) : requests.getStore();
    if (!cleanLanguageRequired(guildId)) return request(options);
    const callback = /^\/interactions\//.test(route);
    const body = callback ? options.body?.data : options.body;
    if (!body) return request(options);
    const unsafeFile = (options.files ?? []).some(file => {
      if (containsProfanity(file.name ?? '')) return true;
      if (!/\.(?:txt|md|csv|json|py|js|ts|css|html)$/i.test(file.name ?? '')) return false;
      try { return containsProfanity(new TextDecoder('utf-8', { fatal: true }).decode(file.data)); }
      catch { return true; }
    });
    if (!unsafeValue(body) && !unsafeFile) return request(options);
    const replacement = { content: CLEAN_LANGUAGE_FALLBACK, embeds: [], components: [], attachments: [], allowed_mentions: { parse: [] },
      ...(body.flags === undefined ? {} : { flags: body.flags }) };
    return request({ ...options, files: [], body: callback ? { ...options.body, data: replacement } : replacement });
  };
}
