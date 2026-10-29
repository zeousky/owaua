import { ProviderError, providerError } from './provider-error.js';

// These probes are independent of the chat model and never carry user data.
// xAI's retired fast aliases now redirect to grok-4.3 at its current rates.
export const RECOVERY_MODELS = Object.freeze({ xai: 'grok-4.3', mistral: 'ministral-3b-latest' });
const origins = { xai: 'https://api.x.ai', mistral: 'https://api.mistral.ai' };
const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);

async function boundedJson(response, signal) {
  if (!response.body?.getReader) throw new ProviderError(502, 'invalid_recovery_response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) throw new ProviderError(502, 'invalid_recovery_response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// One watcher per shared provider key, regardless of the number of affected
// servers. Watchers exist only after a persisted insufficient-balance report.
export class ProviderRecoveryMonitor {
  constructor({ router, providers, fetchImpl = fetch, intervalMs = 300000,
    maxIntervalMs = 3600000, timeoutMs = 20000, onResult, onError,
    now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    if (!router || !providers || !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
      !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < intervalMs ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid provider recovery configuration');
    for (const provider of Object.keys(origins)) {
      const model = providers[provider]?.model ?? RECOVERY_MODELS[provider];
      if (!validModel(model)) throw new TypeError('Invalid provider recovery model');
    }
    Object.assign(this, { router, providers, fetchImpl, intervalMs, maxIntervalMs, timeoutMs,
      onResult, onError, now, setTimeoutImpl, clearTimeoutImpl });
    this.jobs = new Map();
    this.started = false;
    this.closed = false;
  }
  start() {
    if (this.closed) return;
    this.started = true;
    this.wake();
  }
  wake() {
    if (!this.started || this.closed) return;
    for (const provider of this.router.recoveryProviders()) this.schedule(provider);
  }
  schedule(provider) {
    if (!this.started || this.closed || !Object.hasOwn(origins, provider) ||
      !this.providers[provider]?.apiKey) return;
    let state = this.router.recoveryState(provider);
    const existing = this.jobs.get(provider);
    if (existing) {
      // A normal chat reply may clear an outage before its timer fires. If a
      // later outage starts, discard the old long-backoff timer and give the
      // new incident its first delay. Keep active requests single-flight.
      if (existing.controller || state?.nextCheckAt != null) return;
      this.clearTimeoutImpl(existing.timer);
      this.jobs.delete(provider);
    }
    if (!state) return;
    try {
      if (state.nextCheckAt == null) {
        if (!this.router.scheduleRecovery(provider, { attempts: state.attempts, nextCheckAt: this.now() + this.intervalMs },
          { expectedGeneration: state.generation })) return;
        state = this.router.recoveryState(provider);
        if (!state) return;
      }
      const job = {};
      // Clamp the actual timer delay to Node's maximum, without changing the
      // persisted due time. Normal production intervals are at most one hour.
      const delay = Math.max(0, Math.min(2147483647, state.nextCheckAt - this.now()));
      job.timer = this.setTimeoutImpl(() => this.#run(provider, job), delay);
      job.timer?.unref?.();
      this.jobs.set(provider, job);
    } catch {
      this.#notify(this.onError, { provider, code: 'recovery_schedule_failed' });
    }
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.values()) {
      this.clearTimeoutImpl(job.timer);
      this.clearTimeoutImpl(job.timeout);
      job.controller?.abort(new DOMException('Provider recovery is stopping', 'AbortError'));
    }
    this.jobs.clear();
  }
  #notify(callback, value) {
    try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {}
  }
  async #run(provider, job) {
    if (this.closed || this.jobs.get(provider) !== job) return;
    const state = this.router.recoveryState(provider);
    if (!state) { this.jobs.delete(provider); return; }
    // A distant persisted timestamp may need several clamped timer periods.
    if (state.nextCheckAt > this.now()) {
      this.jobs.delete(provider); this.schedule(provider); return;
    }
    const model = this.providers[provider].model ?? RECOVERY_MODELS[provider];
    const attempts = Math.min(30, state.attempts + 1);
    const nextCheckAt = this.now() + Math.min(this.maxIntervalMs, this.intervalMs * 2 ** attempts);
    try {
      // Reserve the next eligible check before the paid POST. A crash after
      // submission must not replay the same hello immediately on restart.
      if (!this.router.scheduleRecovery(provider, { attempts, nextCheckAt }, { expectedGeneration: state.generation })) {
        this.jobs.delete(provider); this.schedule(provider); return;
      }
    } catch {
      this.jobs.delete(provider);
      this.#notify(this.onError, { provider, code: 'recovery_schedule_failed' });
      return;
    }
    job.controller = new AbortController();
    job.timeout = this.setTimeoutImpl(() => job.controller.abort(new DOMException('Provider recovery timed out', 'TimeoutError')), this.timeoutMs);
    job.timeout?.unref?.();
    const signal = job.controller.signal;
    let recovered = false, status = 'unavailable';
    try {
      const response = await this.fetchImpl(`${origins[provider]}/v1/chat/completions`, {
        method: 'POST', signal, redirect: 'error',
        headers: { Authorization: `Bearer ${this.providers[provider].apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8, stream: false,
          ...(provider === 'xai' ? { reasoning_effort: 'none' } : {}) }),
      });
      if (!response.ok) throw await providerError(response, { provider });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new ProviderError(502, 'invalid_recovery_response', provider);
      }
      const result = await boundedJson(response, signal);
      const choice = result?.choices?.[0];
      if (result.error || !['stop', 'length'].includes(choice?.finish_reason) ||
        choice?.message?.role !== 'assistant' || typeof choice.message.content !== 'string' || !choice.message.content.trim() ||
        choice.message.tool_calls?.length) throw new ProviderError(502, 'invalid_recovery_response', provider);
      if (this.closed) return;
      recovered = this.router.recoverProvider(provider, { expectedGeneration: state.generation }) === true;
      if (recovered) this.#notify(this.onResult, { provider, model, status: 'recovered', nextCheckAt: null });
    } catch (error) {
      if (error?.code === 'insufficient_balance') status = 'insufficient_balance';
    } finally {
      this.clearTimeoutImpl(job.timeout);
      this.jobs.delete(provider);
      if (!this.closed && !recovered) {
        let current = this.router.recoveryState(provider);
        if (current) {
          // An in-flight probe cannot clear a newer billing report. Give that
          // report its own delayed check rather than probing again immediately.
          try {
            if (current.nextCheckAt == null || current.nextCheckAt <= this.now()) {
              const due = this.now() + Math.min(this.maxIntervalMs, this.intervalMs * 2 ** current.attempts);
              if (!this.router.scheduleRecovery(provider, { attempts: current.attempts, nextCheckAt: due }, { expectedGeneration: current.generation })) return;
              current = this.router.recoveryState(provider);
            }
            if (current) this.#notify(this.onResult, { provider, model, status, nextCheckAt: current.nextCheckAt });
            this.schedule(provider);
          } catch { this.#notify(this.onError, { provider, code: 'recovery_schedule_failed' }); }
        }
      }
    }
  }
}
