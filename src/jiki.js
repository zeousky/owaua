import { MessageFlags } from 'discord.js';
import { isOwner } from './owner.js';
import { cleanLanguageRequired } from './server-language.js';

export const JIKI_MODEL = 'qwen3.5-9b-abliterated';
export const JIKI_MAX_PROMPT_LENGTH = 2000;
const MAX_INSTRUCTIONS_LENGTH = 4500;
const MAX_OUTPUT_TOKENS = 768;
const TIMEOUT_MS = 140_000;

export function usesDirectJiki(userId, guildId) {
  return isOwner(userId) && !cleanLanguageRequired(guildId);
}

export function directJikiReply(text) {
  const options = { allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds };
  if (text.length <= 2000) return { ...options, content: text };
  return {
    ...options,
    content: 'The full Jiki reply is attached.',
    files: [{ attachment: Buffer.from(text), name: 'jiki-reply.txt' }],
  };
}

export class JikiProviderError extends Error {
  constructor(code, status) {
    super(`Jiki request failed (${code})`);
    this.name = 'JikiProviderError';
    this.code = code;
    this.status = status;
  }
}

export function createJikiClient({ url, apiKey, fetchImpl = fetch } = {}) {
  if (!url && !apiKey) return undefined;
  const base = typeof url === 'string' ? URL.parse(url) : null;
  if (!base || base.protocol !== 'https:' || base.pathname !== '/' ||
      base.username || base.password || base.href !== `${base.origin}/` ||
      typeof apiKey !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(apiKey)) {
    throw new Error('Set QWEN_API_URL to the HTTPS gateway origin and QWEN_API_KEY to its bearer token.');
  }
  const endpoint = new URL('/v1/chat/completions', base).href;
  return {
    async respond({ text, instructions, signal: callerSignal }) {
      if (typeof text !== 'string' || !text.trim() || text.length > JIKI_MAX_PROMPT_LENGTH ||
          (instructions !== undefined && (typeof instructions !== 'string' || !instructions.trim() ||
            instructions.length > MAX_INSTRUCTIONS_LENGTH))) {
        throw new JikiProviderError('invalid_prompt', 400);
      }
      const messages = [{ role: 'user', content: text }];
      if (instructions !== undefined) messages.unshift({ role: 'system', content: instructions });
      const deadline = AbortSignal.timeout(TIMEOUT_MS);
      const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
      let phase = 'connection_error';
      let result;
      try {
        signal.throwIfAborted();
        const response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: JIKI_MODEL,
            messages,
            max_tokens: MAX_OUTPUT_TOKENS,
          }),
        });
        signal.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel();
          throw new JikiProviderError('http_error', response.status);
        }
        phase = 'invalid_response';
        result = await response.json();
        signal.throwIfAborted();
      } catch (error) {
        if (callerSignal?.aborted) throw new JikiProviderError('cancelled');
        if (deadline.aborted) throw new JikiProviderError('timeout', 504);
        if (error instanceof JikiProviderError) throw error;
        // Response bodies, abort reasons and connection errors may contain private data.
        throw new JikiProviderError(phase, 502);
      }
      if (result?.error) throw new JikiProviderError('invalid_response', 502);
      const answer = result?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer.trim()) throw new JikiProviderError('empty_response', 502);
      if (answer.includes(apiKey)) throw new JikiProviderError('invalid_response', 502);
      const counts = {};
      for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        const count = result.usage?.[field];
        if (Number.isSafeInteger(count) && count >= 0) counts[field] = count;
      }
      return { text: instructions === undefined ? answer : answer.trim(), model: JIKI_MODEL, usage: Object.keys(counts).length ? [counts] : [] };
    },
  };
}
