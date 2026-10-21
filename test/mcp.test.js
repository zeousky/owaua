import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPRegistry } from '../src/mcp.js';
import { AICore } from '../src/ai.js';
import { normalizeRequestOptions, RequestOptionsError } from '../src/request-options.js';

test('built-in read-only public integrations require explicit selection for every request', async () => {
  const registry = new MCPRegistry();
  assert.deepEqual(registry.list().map(item => item.label), ['xai_docs', 'deepwiki']);
  assert.deepEqual(registry.definitions(), []);
  assert.equal(registry.definitions(['deepwiki'])[0].allowed_tools.includes('ask_wiki_question'), true);
  const bodies = [];
  const ai = new AICore({ mcpRegistry: registry, fetchImpl: async (_, request) => {
    bodies.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }] }) };
  } });
  await ai.respond({ input: 'Docs', requestOptions: { integrations: 'XAI_DOCS,deepwiki' } });
  await ai.respond({ input: 'Hello' });
  assert.deepEqual(bodies[0].tools.filter(tool => tool.type === 'mcp').map(tool => tool.server_label), ['xai_docs', 'deepwiki']);
  assert.equal(bodies[1].tools.some(tool => tool.type === 'mcp'), false);
  for (const tool of registry.definitions(['xai_docs'])) {
    assert.ok(tool.allowed_tools.length > 0);
    assert.equal(Object.hasOwn(tool, 'require_approval'), false);
    assert.equal(Object.hasOwn(tool, 'authorization'), false);
  }
});

test('deployment credentials are environment references, scoped, and excluded from integration metadata', () => {
  const guildId = '123456789012345678';
  const registry = new MCPRegistry(JSON.stringify([{ label: 'private_docs', url: 'https://docs.example.com/mcp',
    readOnly: true, allowedTools: ['search'], authorizationEnv: 'DOCS_TOKEN', guildIds: [guildId] }]), { environment: { DOCS_TOKEN: 'Bearer secret' } });
  assert.equal(registry.list().some(server => server.label === 'private_docs'), false);
  assert.throws(() => registry.definitions(['private_docs']), RequestOptionsError);
  assert.equal(registry.definitions(['private_docs'], { guildId })[0].authorization, 'Bearer secret');
  assert.doesNotMatch(JSON.stringify(registry.list({ guildId })), /secret|DOCS_TOKEN|docs.example.com/);
  const missing = new MCPRegistry([{ label: 'private_docs', url: 'https://docs.example.com/mcp', readOnly: true,
    allowedTools: ['search'], authorizationEnv: 'DOCS_TOKEN', guildIds: [guildId] }], { environment: {} });
  assert.throws(() => missing.definitions(['private_docs'], { guildId }), /credential configured/);
});

test('MCP rejects arbitrary request URLs and broad or malformed deployment configurations', () => {
  const base = { label: 'example', url: 'https://public.example.com/mcp', readOnly: true, allowedTools: ['search'] };
  for (const override of [{ url: 'http://public.example.com' }, { url: 'https://127.0.0.1/mcp' },
    { url: 'https://localhost/mcp' }, { url: 'https://host.internal/mcp' }, { url: 'https://user:secret@example.com/mcp' },
    { url: 'https://public.example.com?token=secret' }, { allowedTools: [] }, { readOnly: false },
    { authorization: 'secret' }, { authorizationEnv: 'TOKEN' }, { label: 'xai_docs' }]) {
    assert.throws(() => new MCPRegistry([{ ...base, ...override }]), /Invalid MCP_SERVERS_JSON/);
  }
  for (const integrations of ['https://example.com/mcp', 'xai_docs,,deepwiki', ['xai_docs', {}], ['a', 'b', 'c', 'd']]) {
    assert.throws(() => normalizeRequestOptions({ integrations }), RequestOptionsError);
  }
  assert.throws(() => new MCPRegistry().definitions(['unknown']), RequestOptionsError);
});
