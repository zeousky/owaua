import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const names = ['xai', 'mistral'];

export class ProviderSwitchError extends Error {}

// Only the transport's normalized billing code may trigger a switch.
export function isBalanceError(error) { return error?.code === 'insufficient_balance'; }

export class ProviderRouter {
  constructor({ providers, directory, defaultProvider = 'xai', onSwitch }) {
    this.providers = providers;
    this.directory = directory;
    this.filename = join(directory, 'provider.json');
    this.onSwitch = onSwitch;
    this.depleted = new Set();
    if (!names.includes(defaultProvider)) throw new ProviderSwitchError('Invalid default provider.');
    let saved;
    try { saved = JSON.parse(readFileSync(this.filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ProviderSwitchError('The saved provider setting could not be read.', { cause: error });
    }
    if (saved !== undefined && (saved?.version !== 1 || !names.includes(saved?.provider))) {
      throw new ProviderSwitchError('The saved provider setting is invalid.');
    }
    const configured = this.configured();
    this.activeProvider = saved?.provider ?? defaultProvider;
    if (!configured.includes(this.activeProvider)) {
      this.activeProvider = configured.includes(defaultProvider) ? defaultProvider : configured[0];
    }
    if (!this.activeProvider) throw new ProviderSwitchError('Configure an xAI or Mistral API key before starting Owaua.');
  }
  configured() { return names.filter(name => Boolean(this.providers[name]?.apiKey)); }
  get provider() { return this.activeProvider; }
  get model() { return this.providers[this.provider].model; }
  get apiKey() { return this.providers[this.provider].apiKey; }
  status() { return { provider: this.provider, model: this.model, configured: this.configured() }; }
  reportFailure(error, failedProvider) {
    if (!isBalanceError(error) || !names.includes(failedProvider)) return this.status();
    this.depleted.add(failedProvider);
    const alternate = failedProvider === 'xai' ? 'mistral' : 'xai';
    if (this.provider === failedProvider && this.configured().includes(alternate) && !this.depleted.has(alternate)) {
      return this.setProvider(alternate, { automatic: true });
    }
    return this.status();
  }
  setProvider(name, { automatic = false } = {}) {
    if (name === 'switch') name = this.provider === 'xai' ? 'mistral' : 'xai';
    if (!names.includes(name)) throw new ProviderSwitchError('Choose xai, mistral, or switch.');
    if (!this.configured().includes(name)) {
      throw new ProviderSwitchError(`${name === 'mistral' ? 'Mistral' : 'xAI'} is not configured. Add its API key to the bot service first.`);
    }
    const previous = this.provider;
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, provider: name }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filename);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch {}
      throw new ProviderSwitchError('I couldn’t save the provider setting. The active provider has not changed.', { cause: error });
    }
    this.activeProvider = name;
    if (!automatic) this.depleted.delete(name);
    if (previous !== name) {
      // Notification failure cannot undo a persisted switch. Never emit keys.
      try { Promise.resolve(this.onSwitch?.({ from: previous, to: name, automatic })).catch(() => {}); } catch {}
    }
    return this.status();
  }
  async respond(request) {
    const initial = this.provider;
    const { prepareForProvider, ...baseRequest } = request;
    const run = async provider => {
      const prepared = await prepareForProvider?.(provider);
      return this.providers[provider].respond({ ...baseRequest, ...prepared });
    };
    try {
      const result = await run(initial);
      this.depleted.delete(initial);
      return { ...result, provider: initial };
    } catch (error) {
      if (!isBalanceError(error)) throw error;
      // A request uses a provider snapshot; a stale failure cannot switch back
      // a newer manual choice made while that request was in flight.
      // Dedicated media/voice tools may use a different provider from chat.
      // Their failure must not label the healthy chat provider as depleted.
      const failedProvider = names.includes(error.provider) ? error.provider : initial;
      const alternate = this.reportFailure(error, failedProvider).provider;
      if (failedProvider !== initial || alternate === initial || this.depleted.has(alternate) || error.replaySafe !== true || request.signal?.aborted) throw error;
      try {
        const result = await run(alternate);
        this.depleted.delete(alternate);
        return { ...result, provider: alternate };
      } catch (retryError) {
        if (isBalanceError(retryError)) this.depleted.add(names.includes(retryError.provider) ? retryError.provider : alternate);
        throw retryError;
      }
    }
  }
}
