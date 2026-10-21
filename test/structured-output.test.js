import test from 'node:test';
import assert from 'node:assert/strict';
import { AICore, ProviderError } from '../src/ai.js';
import { matchesOutputSchema, normalizeRequestOptions, RequestOptionsError } from '../src/request-options.js';

const result = (text, status = 'completed', annotations = []) => ({ ok: true, json: async () => ({ status, output: [
  { type: 'message', content: [{ type: 'output_text', text, annotations }] },
] }) });

test('structured output keeps valid JSON separate from citations and uses Responses text.format', async () => {
  let body;
  const ai = new AICore({ fetchImpl: async (_, request) => {
    body = JSON.parse(request.body);
    return result('{"answer":"It works","sources":[]}', 'completed', [{ url: 'https://example.com' }]);
  } });
  const options = normalizeRequestOptions({ outputFormat: 'json' });
  assert.deepEqual(normalizeRequestOptions(options), options);
  const response = await ai.respond({ input: 'Answer as JSON', requestOptions: options });
  assert.deepEqual(JSON.parse(response.text), { answer: 'It works', sources: [] });
  assert.equal(response.outputFormat, 'json');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.type, 'object');
  assert.doesNotMatch(response.text, /example.com|Sources:/);
  assert.ok(body.tools.every(tool => !/^(generate_|edit_|extend_)/.test(tool.name ?? '')));
});

test('custom schema validates nested constraints and rejects invalid provider JSON without returning partial data', async () => {
  const schema = JSON.stringify({ type: 'object', properties: { rows: { type: 'array', minItems: 1, maxItems: 2,
    items: { type: 'object', properties: { score: { type: 'integer', minimum: 1, maximum: 5 },
      name: { type: ['string', 'null'], maxLength: 3 } }, required: ['score', 'name'], additionalProperties: false } },
    status: { enum: ['ok', 'failed'] } }, required: ['rows', 'status'], additionalProperties: false });
  const options = normalizeRequestOptions({ outputFormat: 'json', schema });
  assert.deepEqual(normalizeRequestOptions(options), options);
  assert.equal(matchesOutputSchema({ rows: [{ score: 3, name: null }], status: 'ok' }, options.schema), true);
  for (const text of ['```json\n{}\n```', '{"rows":[],"status":"ok"}',
    '{"rows":[{"score":6,"name":"a"}],"status":"ok"}', '{"rows":[{"score":2,"name":"long"}],"status":"ok"}',
    '{"rows":[{"score":2,"name":null,"extra":1}],"status":"ok"}', '{"rows":[{"score":2,"name":"a"}],"status":"other"}']) {
    const ai = new AICore({ fetchImpl: async () => result(text) });
    await assert.rejects(ai.respond({ input: 'Extract', requestOptions: options }), error => error instanceof ProviderError && error.code === 'invalid_structured_output');
  }
  const ai = new AICore({ fetchImpl: async () => result('{"rows":[{"score":3,"name":null}],"status":"ok"}', 'incomplete') });
  await assert.rejects(ai.respond({ input: 'Extract', requestOptions: options }), /incomplete_structured_output/);
});

test('unsupported schemas and controls fail before inference', async () => {
  let calls = 0;
  const ai = new AICore({ fetchImpl: async () => { calls++; return result('{}'); } });
  const schemas = ['{', JSON.stringify({ type: 'array', items: { type: 'string' } }),
    JSON.stringify({ type: 'object', pattern: '(a+)+$' }), JSON.stringify({ type: 'object', properties: { x: { $ref: 'https://invalid' } } }),
    JSON.stringify({ type: 'object', required: ['unknown'] }), JSON.stringify({ type: 'object', properties: { items: { type: 'array' } } }),
    JSON.stringify({ type: 'object', properties: { x: { type: 'string', maxLength: 2049 } } }),
    '{"type":"object","properties":{"x":{"enum":[1e400]}}}',
    JSON.stringify({ type: 'object', properties: { x: { type: ['string', 'string'] } } }),
    JSON.stringify({ type: 'object', properties: { x: { type: 'number', exclusiveMinimum: 1, maximum: 1 } } }), ' '.repeat(4001)];
  for (const schema of schemas) await assert.rejects(ai.respond({ input: 'Extract', requestOptions: { outputFormat: 'json', schema } }), RequestOptionsError);
  await assert.rejects(ai.respond({ input: 'Extract', requestOptions: { outputFormat: 'yaml' } }), RequestOptionsError);
  await assert.rejects(ai.respond({ input: 'Extract', requestOptions: { outputFormat: 'text', schema: '{}' } }), RequestOptionsError);
  assert.equal(calls, 0);
});

test('knowledge search accepts only scoped hosted file search definitions before provider calls', async () => {
  let body;
  const ai = new AICore({ fetchImpl: async (_, request) => { body = JSON.parse(request.body); return result('Answer'); } });
  await ai.respond({ input: 'Find a fact', knowledgeTools: [{ type: 'file_search', vector_store_ids: ['collection-abc'] }] });
  assert.ok(body.tools.some(tool => tool.type === 'file_search' && tool.vector_store_ids[0] === 'collection-abc'));
  for (const knowledgeTools of [[{ type: 'mcp', vector_store_ids: ['abc'] }], [{ type: 'file_search', vector_store_ids: [] }],
    [{ type: 'file_search', vector_store_ids: ['../private'] }], [{ type: 'file_search', vector_store_ids: ['abc'], filters: {} }]]) {
    await assert.rejects(ai.respond({ input: 'Find a fact', knowledgeTools }), RequestOptionsError);
  }
});
