// Provider bodies are inspected only to classify billing failures. Never retain
// or expose their messages: they may contain user content or credentials.
export class ProviderError extends Error {
  constructor(status, code, provider = 'xai') {
    super(`${provider === 'mistral' ? 'Mistral' : 'xAI'} request failed (${status}, ${code})`);
    this.name = 'ProviderError';
    Object.assign(this, { status, code, provider, replaySafe: false });
  }
}

export function providerFailure(status, value, { provider = 'xai', code = 'provider_error', replaySafe = false } = {}) {
  const envelope = value?.error ?? value;
  const errorCode = String(envelope?.code ?? envelope?.type ?? '').toLowerCase().replace(/[ -]/g, '_');
  const message = [typeof envelope === 'string' ? envelope : envelope?.message,
    envelope?.detail?.message, typeof envelope?.detail === 'string' ? envelope.detail : '']
    .filter(item => typeof item === 'string').join(' ').slice(0, 16384);
  const knownCode = /^(?:insufficient_(?:balance|credits?|funds)|(?:credits?|funds|balance)_(?:exhausted|depleted)|credit_balance_too_low)$/.test(errorCode);
  const balanceWords = /(?:not enough|insufficient|exhausted|depleted|run out of|ran out of|used (?:up )?all|(?:no|zero) (?:remaining )?)[\s\S]{0,45}(?:credits?|funds|balance)|(?:credits?|funds|balance)[\s\S]{0,45}(?:exhausted|depleted|insufficient|(?:is |are |of )?zero|(?:is |are )?0\b)|(?:doesn['’]t|does not|don['’]t|do not) have (?:any |enough )?(?:credits?|funds)/i;
  // Schema/validation failures can echo arbitrary user field names. A request
  // mentioning "add credits" must never change the global provider by itself.
  const billingMessage = !/\b(?:schema|property|parameter|validation)\b/i.test(message) && balanceWords.test(message);
  const billing = status === 402 || knownCode || billingMessage;
  const error = new ProviderError(status, billing ? 'insufficient_balance' : code, provider);
  error.replaySafe = replaySafe;
  return error;
}

export async function providerError(response, options = {}) {
  let value;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16384) break;
          chunks.push(value);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try { value = JSON.parse(text); } catch { value = text; }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } else value = await response.json?.();
  } catch { /* Keep a safe generic error when the body cannot be inspected. */ }
  return providerFailure(response.status, value, options);
}

// Other provider endpoints cannot always be replayed on another provider
// (video, realtime sessions, uploads). Switch future requests without replaying.
export function billingAwareFetch(provider, router, fetchImpl = fetch) {
  return async (url, options) => {
    const response = await fetchImpl(url, options);
    const host = new URL(url).hostname;
    if (!response.ok && (provider === 'mistral' ? host === 'api.mistral.ai' : ['api.x.ai', 'management-api.x.ai'].includes(host))) {
      const error = await providerError(response, { provider, replaySafe: true });
      if (error.code === 'insufficient_balance') {
        router.reportFailure(error, provider);
        throw error;
      }
      // The provider body has been consumed. Callers only use status on failure.
    }
    return response;
  };
}
