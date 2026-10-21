import { isIP } from 'node:net';
import { RequestOptionsError } from './request-options.js';

const BUILTINS = [
  { label: 'xai_docs', url: 'https://docs.x.ai/api/mcp', allowedTools: ['list_doc_pages', 'get_doc_page', 'search_docs', 'get_llms_txt'],
    readOnly: true, description: 'Search the official xAI API documentation.' },
  { label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp', allowedTools: ['read_wiki_structure', 'read_wiki_contents', 'ask_wiki_question'],
    readOnly: true, description: 'Read documentation and ask questions about public GitHub repositories.' },
];
const KEYS = new Set(['label', 'url', 'allowedTools', 'readOnly', 'description', 'authorizationEnv', 'guildIds', 'userIds']);
const invalid = () => new Error('Invalid MCP_SERVERS_JSON: use unique labels, public HTTPS URLs, explicit read-only tool allowlists, and environment variable references for authorization.');
const snowflakes = values => values === undefined || Array.isArray(values) && values.length > 0 && values.length <= 100 && values.every(id => typeof id === 'string' && /^\d{15,22}$/.test(id));

// Deployment-owned configuration only. Discord requests can select labels, never
// provide URLs, credentials, headers, tool names, or connection configuration.
export class MCPRegistry {
  #servers = new Map();
  #environment;
  constructor(raw = undefined, { environment = process.env, includeBuiltins = true } = {}) {
    this.#environment = environment;
    let configured = [];
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw === 'string') {
        if (raw.length > 32000) throw invalid();
        try { configured = JSON.parse(raw); } catch { throw invalid(); }
      } else configured = raw;
      if (!Array.isArray(configured) || configured.length > 20) throw invalid();
    }
    for (const server of [...(includeBuiltins ? BUILTINS : []), ...configured]) {
      if (!server || typeof server !== 'object' || Array.isArray(server) || Object.keys(server).some(key => !KEYS.has(key)) ||
        typeof server.label !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(server.label) || this.#servers.has(server.label) || server.readOnly !== true ||
        !Array.isArray(server.allowedTools) || !server.allowedTools.length || server.allowedTools.length > 50 ||
        server.allowedTools.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(name)) ||
        !snowflakes(server.guildIds) || !snowflakes(server.userIds) ||
        server.description !== undefined && (typeof server.description !== 'string' || server.description.length > 500)) throw invalid();
      let url;
      try { url = new URL(server.url); } catch { throw invalid(); }
      const hostname = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.port && url.port !== '443' ||
        isIP(hostname.replace(/^\[|\]$/g, '')) || !hostname.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(hostname) || hostname.endsWith('.localhost') ||
        hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw invalid();
      if (server.authorizationEnv !== undefined && (typeof server.authorizationEnv !== 'string' ||
        !/^[A-Z][A-Z0-9_]{1,99}$/.test(server.authorizationEnv) || !server.guildIds?.length && !server.userIds?.length)) throw invalid();
      this.#servers.set(server.label, { ...structuredClone(server), url: url.href, allowedTools: [...new Set(server.allowedTools)] });
    }
  }
  #allowed(server, context) {
    return (!server.guildIds || server.guildIds.includes(context?.guildId)) && (!server.userIds || server.userIds.includes(context?.userId));
  }
  list(context = {}) {
    return [...this.#servers.values()].filter(server => this.#allowed(server, context)).map(server => ({ label: server.label,
      description: server.description ?? 'Configured read-only integration.', authenticated: Boolean(server.authorizationEnv) }));
  }
  definitions(labels = [], context = {}) {
    if (!Array.isArray(labels) || labels.length > 3) throw new RequestOptionsError('Choose at most three integration labels from /integrations.');
    return labels.map(label => {
      const server = this.#servers.get(label);
      if (!server || !this.#allowed(server, context)) throw new RequestOptionsError('That integration is unavailable here. Use /integrations to see available labels.');
      const token = server.authorizationEnv ? this.#environment[server.authorizationEnv] : undefined;
      if (server.authorizationEnv && (typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n]/.test(token))) {
        throw new RequestOptionsError('That integration needs its deployment credential configured before it can be used.');
      }
      return { type: 'mcp', server_label: server.label, server_url: server.url,
        ...(server.description ? { server_description: server.description } : {}),
        allowed_tools: [...server.allowedTools], ...(token ? { authorization: token } : {}) };
    });
  }
}

export function createMCPRegistry(raw = process.env.MCP_SERVERS_JSON, options) { return new MCPRegistry(raw, options); }
