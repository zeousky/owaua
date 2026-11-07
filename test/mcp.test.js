import test from 'node:test';
import assert from 'node:assert/strict';
import { MCPRegistry } from '../src/mcp.js';
import { AICore } from '../src/ai.js';
import { normalizeRequestOptions, RequestOptionsError } from '../src/request-options.js';
import { SafetyError } from '../src/safety.js';

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

test('authenticated integration credentials cannot reach replies, text exports or local tools', async () => {
  const guildId = '123456789012345678';
  const credential = 'opaque-private-integration-value';
  const authorization = `Bearer ${credential}`;
  const registry = new MCPRegistry([{ label: 'private_docs', url: 'https://docs.example.com/mcp',
    readOnly: true, allowedTools: ['search'], authorizationEnv: 'PRIVATE_DOCS_ACCESS', guildIds: [guildId],
  }], { environment: { PRIVATE_DOCS_ACCESS: authorization } });
  const requestOptions = { integrations: 'private_docs' };
  const context = { guildId, memory: { recall: () => assert.fail('A credential reached a local tool') } };
  const envelope = JSON.stringify({ filename: 'document.txt', mime_type: 'text/plain',
    base64: Buffer.from(credential).toString('base64') });
  const binary = JSON.stringify({ filename: 'document.pdf', mime_type: 'application/pdf',
    base64: Buffer.from(`%PDF-1.5\n%${credential}\n%%EOF`).toString('base64') });
  const exportCall = { type: 'code_interpreter_call', status: 'completed', outputs: [{ type: 'logs',
    logs: JSON.stringify({ exit_code: 0, stdout: `OWAUA_ARTIFACT:${envelope}\nOWAUA_ARTIFACT:${binary}` }) }] };
  let requests = 0;
  const ai = new AICore({ mcpRegistry: registry, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body);
    const first = ++requests === 1;
    if (first) assert.equal(body.tools.find(tool => tool.type === 'mcp').authorization, authorization);
    else {
      assert.deepEqual(body.tools, []);
      assert.equal(request.body.includes(credential), false);
    }
    const message = { type: 'message', content: [{ type: 'output_text', text: first ? credential : 'Here are the docs.' }] };
    return { ok: true, json: async () => ({
      output: first ? [exportCall, message] : [message], model: credential,
      usage: { output_tokens: 8, unexpected: credential },
    }) };
  } });
  const result = await ai.respond({ input: 'Find the docs', context, requestOptions });
  assert.equal(requests, 2);
  assert.equal(result.text, 'Here are the docs.');
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.model, ai.model);
  assert.deepEqual(result.usage, [{ output_tokens: 8 }, { output_tokens: 8 }]);
  assert.match(result.artifactWarnings.join(' '), /Hosted binary exports are unavailable/);
  await assert.rejects(ai.respond({ input: authorization, context, requestOptions }), SafetyError);
  assert.equal(requests, 2);

  const leakingTool = new AICore({ mcpRegistry: registry, fetchImpl: async () => ({ ok: true, json: async () => ({
    output: [{ type: 'function_call', name: 'recall_memory', call_id: 'recall',
      arguments: JSON.stringify({ query: credential }) }],
  }) }) });
  await assert.rejects(leakingTool.respond({ input: 'Find the docs', context, requestOptions }), SafetyError);
});

test('decoded and short Basic credentials receive the same reply protection', async () => {
  const guildId = '123456789012345678';
  const basic = Buffer.from('x:z').toString('base64');
  const registry = new MCPRegistry([{ label: 'private_docs', url: 'https://docs.example.com/mcp',
    readOnly: true, allowedTools: ['search'], authorizationEnv: 'PRIVATE_DOCS_ACCESS', guildIds: [guildId],
  }], { environment: { PRIVATE_DOCS_ACCESS: `Basic ${basic}` } });
  for (const leak of [basic, 'x:z', 'z']) {
    let requests = 0;
    const ai = new AICore({ mcpRegistry: registry, fetchImpl: async () => ({ ok: true, json: async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text: ++requests === 1 ? leak : 'Done.' }] }],
    }) }) });
    const reply = await ai.respond({ input: 'Find the docs', context: { guildId }, requestOptions: { integrations: 'private_docs' } });
    assert.equal(requests, 2);
    assert.equal(reply.text, 'Done.');
  }
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
