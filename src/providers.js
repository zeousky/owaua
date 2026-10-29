import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const names = ['xai', 'mistral'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const scopePattern = /^(?:default|(?:guild|dm):[a-zA-Z0-9_-]{1,100})$/;
const other = name => name === 'xai' ? 'mistral' : 'xai';
export class ProviderSwitchError extends Error {}
export function isBalanceError(error) { return error?.code === 'insufficient_balance'; }

function validState(state) {
  if (!object(state) || state.version !== 2 || !names.includes(state.defaultProvider) || !object(state.scopes) || !object(state.recovery)) return false;
  if (state.generation !== undefined && (!Number.isSafeInteger(state.generation) || state.generation < 0)) return false;
  for (const [key, value] of Object.entries(state.scopes)) {
    if (!scopePattern.test(key) || !object(value) || !names.includes(value.provider) ||
      value.recoverTo !== undefined && !names.includes(value.recoverTo) ||
      value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)) return false;
  }
  for (const [name, value] of Object.entries(state.recovery)) {
    if (!names.includes(name) || !object(value) || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
      value.nextCheckAt !== null && (!Number.isSafeInteger(value.nextCheckAt) || value.nextCheckAt < 0)) return false;
  }
  return true;
}

export class ProviderRouter {
  constructor({ providers, directory, defaultProvider = 'xai', onSwitch, onDepleted, onRecoveryError }) {
    Object.assign(this, { providers, directory, onSwitch, onDepleted, onRecoveryError });
    this.filename = join(directory, 'provider.json');
    this.scopes = new AsyncLocalStorage();
    if (!names.includes(defaultProvider)) throw new ProviderSwitchError('Invalid default provider.');
    if (!this.configured().length) throw new ProviderSwitchError('Configure an xAI or Mistral API key before starting Owaua.');
    let saved;
    try { saved = JSON.parse(readFileSync(this.filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ProviderSwitchError('The saved provider setting could not be read.', { cause: error });
    }
    const legacy = saved?.version === 1 && names.includes(saved.provider);
    if (legacy) saved = { version: 2, defaultProvider: saved.provider, scopes: {}, recovery: {} };
    if (saved !== undefined && !validState(saved)) throw new ProviderSwitchError('The saved provider setting is invalid.');
    this.state = saved ?? { version: 2, defaultProvider, scopes: {}, recovery: {} };
    if (legacy) this.commit(this.state);
  }
  configured() { return names.filter(name => Boolean(this.providers[name]?.apiKey)); }
  scopeKey() { return this.scopes.getStore()?.key ?? 'default'; }
  scopeRevision() { return this.state.scopes[this.scopeKey()]?.revision ?? 0; }
  withScope(context, work) {
    let key = 'default';
    if (context?.guildId) key = `guild:${context.guildId}`;
    else if (context?.userId) key = `dm:${context.userId}`;
    else if (this.scopes.getStore()) return work();
    if (!scopePattern.test(key)) throw new ProviderSwitchError('Invalid provider scope.');
    return this.scopes.run({ key, revision: this.state.scopes[key]?.revision ?? 0 }, work);
  }
  providerFor(key) {
    const selected = this.state.scopes[key]?.provider ?? this.state.defaultProvider;
    const configured = this.configured();
    return configured.includes(selected) ? selected : configured.includes(this.state.defaultProvider) ? this.state.defaultProvider : configured[0];
  }
  get depleted() { return new Set(Object.keys(this.state.recovery)); }
  get provider() { return this.providerFor(this.scopeKey()); }
  get model() { return this.providers[this.provider].model; }
  get apiKey() { return this.providers[this.provider].apiKey; }
  status() { return { provider: this.provider, model: this.model, configured: this.configured(), scope: this.scopeKey() }; }
  commit(next) {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filename);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch {}
      throw new ProviderSwitchError('I couldn’t save the provider setting. The active provider has not changed.', { cause: error });
    }
    this.state = next;
  }
  notify(callback, value) { try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {} }
  reportFailure(error, failedProvider, { expectedRevision } = {}) {
    if (!isBalanceError(error) || !names.includes(failedProvider)) return this.status();
    const key = this.scopeKey(), previous = this.provider;
    const next = structuredClone(this.state), existing = next.recovery[failedProvider];
    // Keep the generation monotonic across recovery and a later new outage:
    // an old in-flight probe must never match a replacement watch's generation.
    next.generation = Math.max(next.generation ?? 0, ...Object.values(next.recovery).map(value => value.generation)) + 1;
    next.recovery[failedProvider] = existing
      ? { ...existing, generation: next.generation }
      : { generation: next.generation, attempts: 0, nextCheckAt: null };
    const alternate = other(failedProvider);
    const revision = this.state.scopes[key]?.revision ?? 0;
    expectedRevision ??= this.scopes.getStore()?.revision ?? revision;
    const switchScope = previous === failedProvider && expectedRevision === revision && this.configured().includes(alternate) && !next.recovery[alternate];
    if (switchScope) next.scopes[key] = { provider: alternate, recoverTo: failedProvider, revision: revision + 1 };
    this.commit(next);
    if (switchScope && this.scopes.getStore()?.key === key) this.scopes.getStore().revision = revision + 1;
    if (!existing) this.notify(this.onDepleted, { provider: failedProvider });
    if (switchScope) this.notify(this.onSwitch, { from: previous, to: alternate, automatic: true, scope: key });
    return this.status();
  }
  setProvider(name) {
    if (name === 'switch') name = other(this.provider);
    if (!names.includes(name)) throw new ProviderSwitchError('Choose xai, mistral, or switch.');
    if (!this.configured().includes(name)) throw new ProviderSwitchError(`${name === 'mistral' ? 'Mistral' : 'xAI'} is not configured. Add its API key to the bot service first.`);
    const key = this.scopeKey(), previous = this.provider, next = structuredClone(this.state);
    next.scopes[key] = { provider: name, revision: (next.scopes[key]?.revision ?? 0) + 1 };
    if (key === 'default') next.defaultProvider = name;
    this.commit(next);
    if (this.scopes.getStore()?.key === key) this.scopes.getStore().revision = next.scopes[key].revision;
    // A manual choice does not prove the shared API account has recovered.
    // Dropping recoverTo also prevents a later probe undoing this choice.
    if (previous !== name) this.notify(this.onSwitch, { from: previous, to: name, automatic: false, scope: key });
    return this.status();
  }
  recoveryProviders() { return Object.keys(this.state.recovery).filter(name => this.configured().includes(name)); }
  recoveryState(name) { return this.state.recovery[name] ? { ...this.state.recovery[name] } : null; }
  recoveryGeneration(name) { return this.state.recovery[name]?.generation ?? 0; }
  scheduleRecovery(name, schedule, { expectedGeneration } = {}) {
    const current = this.state.recovery[name];
    if (!current || expectedGeneration !== undefined && expectedGeneration !== current.generation) return false;
    if (!Number.isSafeInteger(schedule.attempts) || schedule.attempts < 0 || !Number.isSafeInteger(schedule.nextCheckAt) || schedule.nextCheckAt < 0) throw new ProviderSwitchError('Invalid provider recovery schedule.');
    const next = structuredClone(this.state);
    next.recovery[name] = { ...current, attempts: schedule.attempts, nextCheckAt: schedule.nextCheckAt };
    this.commit(next);
    return true;
  }
  updateRecovery(name, schedule, options) { return this.scheduleRecovery(name, schedule, options); }
  recoverProvider(name, { expectedGeneration, generation } = {}) {
    expectedGeneration ??= generation;
    const current = this.state.recovery[name];
    if (!current || !this.configured().includes(name) || expectedGeneration !== undefined && expectedGeneration !== current.generation) return false;
    const next = structuredClone(this.state), changes = [];
    delete next.recovery[name];
    for (const [key, entry] of Object.entries(next.scopes)) {
      if (entry.recoverTo !== name || entry.provider !== other(name)) continue;
      changes.push({ from: entry.provider, to: name, automatic: true, recovered: true, scope: key });
      next.scopes[key] = { provider: name, revision: (entry.revision ?? 0) + 1 };
    }
    this.commit(next);
    const activeScope = this.scopes.getStore();
    if (activeScope && changes.some(change => change.scope === activeScope.key)) activeScope.revision = next.scopes[activeScope.key].revision;
    for (const change of changes) this.notify(this.onSwitch, change);
    return true;
  }
  respond(request) {
    const context = request.context;
    const key = context?.guildId ? `guild:${context.guildId}` : context?.userId ? `dm:${context.userId}` : this.scopeKey();
    // The surrounding answer handler also uses withScope. Share its store so
    // later speech/media in that same request sees our committed revision.
    if (this.scopes.getStore()?.key === key) return this.respondInScope(request);
    return this.withScope(context, () => this.respondInScope(request));
  }
  async respondInScope(request) {
    const initial = this.provider, initialRevision = this.state.scopes[this.scopeKey()]?.revision ?? 0;
    const { prepareForProvider, ...baseRequest } = request;
    const run = async provider => {
      const generation = this.recoveryGeneration(provider);
      const prepared = await prepareForProvider?.(provider);
      const result = await this.providers[provider].respond({ ...baseRequest, ...prepared });
      try { this.recoverProvider(provider, { expectedGeneration: generation }); }
      catch (error) {
        if (!(error instanceof ProviderSwitchError)) throw error;
        // The completed paid answer is still deliverable. Keep the persisted
        // recovery watch and let a later check retry its state update.
        this.notify(this.onRecoveryError, { provider, error });
      }
      return { ...result, provider };
    };
    try { return await run(initial); }
    catch (error) {
      if (!isBalanceError(error)) throw error;
      const failedProvider = names.includes(error.provider) ? error.provider : initial;
      const alternate = this.reportFailure(error, failedProvider, { expectedRevision: initialRevision }).provider;
      if (failedProvider !== initial || alternate === initial || this.depleted.has(alternate) || error.replaySafe !== true || request.signal?.aborted) throw error;
      try { return await run(alternate); }
      catch (retryError) {
        if (isBalanceError(retryError)) {
          // Record depletion and start its watch without a second switch/replay.
          const failed = names.includes(retryError.provider) ? retryError.provider : alternate;
          this.reportFailure(retryError, failed, { expectedRevision: -1 });
        }
        throw retryError;
      }
    }
  }
}
