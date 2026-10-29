import test from 'node:test';
import assert from 'node:assert/strict';
import { MistralAPI, MistralInputError, MISTRAL_OPERATIONS, mistralOperations } from '../src/mistral-api.js';
import { handleMistralCommand } from '../src/mistral-command.js';
import { FULL_MODE_OWNER } from '../src/full-mode.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('fixed Mistral operation surface covers current official REST SDK feature families', () => {
  assert.equal(new Set(MISTRAL_OPERATIONS).size, 288);
  for (const operation of ['responsesCreate', 'responsesCountInputTokens', 'chatComplete', 'fimComplete',
    'embeddingsCreate', 'ocrProcess', 'classifiersClassify', 'classifiersModerateChat',
    'betaConversationsStart', 'betaAgentsCreate', 'audioSpeechComplete', 'audioTranscriptionsComplete',
    'audioAgentsCreate', 'audioSessionsCreate', 'audioVoicesCreate', 'filesUpload',
    'betaLibrariesDocumentsUpload', 'batchJobsCreate', 'modelsUpdate', 'betaConnectorsCallTool',
    'betaRagManagedIndexesSearch', 'betaPromptsCreate', 'betaSkillsCreate', 'betaUsersWhoami',
    'betaServiceAccountsCreate', 'betaObservabilityTracesSearch', 'workflowsSchedulesScheduleWorkflow',
    'workflowsDeploymentsCreateDeployment', 'realtimeSessionsCreate']) assert.ok(MISTRAL_OPERATIONS.includes(operation), operation);
  for (const entry of mistralOperations()) assert.match(entry.path, /^\/v[12]\//);
});

test('REST defaults Large 4, uses fixed origin, removes path fields and encodes query fields', async () => {
  const calls = [];
  const api = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ ok: true }); } });
  await api.request('responses', { input: 'Hi' });
  assert.equal(calls[0].url, 'https://api.mistral.ai/v1/responses');
  assert.deepEqual(JSON.parse(calls[0].init.body), { input: 'Hi', model: 'mistral-large-4' });
  assert.equal(calls[0].init.redirect, 'error');
  await api.request('files.url', { file_id: 'some/id?fragment#foo', expiry: 1 });
  assert.equal(calls[1].url, 'https://api.mistral.ai/v1/files/some%2Fid%3Ffragment%23foo/url?expiry=1');
  assert.equal(calls[1].init.body, undefined);
  await api.request('search', { inputs: 'Current news' });
  assert.deepEqual(JSON.parse(calls[2].init.body).tools, [{ type: 'web_search' }]);
  await assert.rejects(api.request('https://attacker.invalid/path', {}), MistralInputError);
  await assert.rejects(api.request('files.url', { file_id: '..' }), MistralInputError);
  assert.equal(calls.length, 3);
});

test('POST routes split REST query parameters from JSON and allow specialized models', async () => {
  const calls = [];
  const api = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ ok: true }); } });
  await api.request('betaConnectorsCallTool', { connector_id_or_name: 'c', tool_name: 'search', credentials_name: 'work', arguments: { q: 'test' } });
  assert.equal(calls[0].url, 'https://api.mistral.ai/v1/connectors/c/tools/search/call?credentials_name=work');
  assert.deepEqual(JSON.parse(calls[0].init.body), { arguments: { q: 'test' } });
  await api.request('embeddings', { input: ['text'] });
  assert.equal(JSON.parse(calls[1].init.body).model, 'mistral-embed');
  await api.request('ocr', { document: { type: 'document_url', document_url: 'https://example.org/test.pdf' } });
  assert.equal(JSON.parse(calls[2].init.body).model, 'mistral-ocr-latest');
});

test('Mistral failures expose only sanitized codes and classify insufficient balance', async () => {
  for (const [status, body, expected] of [[402, { detail: 'private request' }, 'insufficient_balance'],
    [429, { detail: 'insufficient balance fixture-mistral-key' }, 'insufficient_balance'],
    [400, { detail: 'private request fixture-mistral-key' }, 'provider_error']]) {
    const api = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
    await assert.rejects(api.request('models', {}), error => error.status === status && error.code === expected &&
      error.provider === 'mistral' && !error.message.includes('fixture-mistral-key') && !error.message.includes('private request'));
  }
});

test('response byte limits, cancellation, credential redaction and secret checks apply before Discord', async () => {
  const oversized = new MistralAPI({ apiKey: 'fixture-mistral-key', maxResponseBytes: 5, fetchImpl: async () => json({ large: 'content' }) });
  await assert.rejects(oversized.request('models', {}), /transfer limit/);
  const redacted = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async () => json({ api_key: 'private-token', nested: { refresh_token: 'another' }, id: 'safe' }) });
  assert.deepEqual(await redacted.request('models', {}), { api_key: 'redacted', nested: { refresh_token: 'redacted' }, id: 'safe' });
  const secret = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async () => json({ message: 'fixture-mistral-key' }) });
  await assert.rejects(secret.request('models', {}));
  const binary = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async () => new Response('fixture-mistral-key', { headers: { 'content-type': 'application/octet-stream' } }) });
  await assert.rejects(binary.request('files.download', { file_id: 'f' }), error => error.code === 'unsafe_response');
  const abort = new AbortController(); abort.abort();
  let called = false;
  const cancelled = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async () => { called = true; return json({}); } });
  await assert.rejects(cancelled.request('models', {}, { signal: abort.signal }));
  assert.equal(called, false);
});

test('multipart uploads download only bounded direct Discord attachments and omit JSON file paths', async () => {
  const calls = [];
  const api = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.startsWith('https://cdn.discordapp.com/') ? new Response('document') : json({ id: 'file' });
  } });
  const attachment = { url: 'https://cdn.discordapp.com/attachments/1/2/report.txt', size: 8, name: '../report.txt', contentType: 'text/plain' };
  await api.request('files.upload', { purpose: 'ocr', file: '/etc/private' }, { attachment });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[1].url, 'https://api.mistral.ai/v1/files');
  assert.equal(calls[1].init.headers['Content-Type'], undefined);
  assert.equal(calls[1].init.body.get('purpose'), 'ocr');
  assert.equal(calls[1].init.body.get('file').name, 'report.txt');
  assert.equal(await calls[1].init.body.get('file').text(), 'document');
  for (const url of ['http://cdn.discordapp.com/file', 'https://evil.invalid/file', 'https://cdn.discordapp.com.evil.invalid/file', 'https://user:pass@cdn.discordapp.com/file']) {
    await assert.rejects(api.request('files.upload', {}, { attachment: { ...attachment, url } }), /directly through Discord/);
  }
  assert.equal(calls.length, 2);
  await assert.rejects(api.request('files.upload', { file: '/etc/private' }), /Attach the file/);
});

test('owner command checks actor before options or API, and sends private files without mentions', async () => {
  let touched = false;
  const unauthorizedReplies = [];
  await handleMistralCommand({ user: { id: 'other' }, options: { getString() { touched = true; } }, reply: async value => unauthorizedReplies.push(value) }, { api: { request() { touched = true; } } });
  assert.equal(touched, false);
  assert.equal(unauthorizedReplies[0].flags, 64);
  const replies = [], edited = [], deferred = [];
  await handleMistralCommand({ user: { id: FULL_MODE_OWNER }, options: { getString: name => name === 'operation' ? 'models' : '{}', getAttachment: () => null },
    reply: async value => replies.push(value), deferReply: async value => deferred.push(value), editReply: async value => edited.push(value) },
  { api: { apiKey: 'fixture-mistral-key', request: async () => ({ data: [] }) } });
  assert.equal(replies.length, 0);
  assert.equal(deferred[0].flags, 64);
  assert.equal(edited[0].flags, 64);
  assert.deepEqual(edited[0].allowedMentions, { parse: [] });
  assert.deepEqual(JSON.parse(edited[0].files[0].attachment.toString()), { data: [] });
});

test('explicit Mistral API actions report balance failure without replay', async () => {
  let calls = 0;
  const failures = [], replies = [];
  const api = new MistralAPI({ apiKey: 'fixture-mistral-key', fetchImpl: async () => { calls++; return new Response('{}', { status: 402 }); } });
  await handleMistralCommand({ user: { id: FULL_MODE_OWNER }, options: { getString: name => name === 'operation' ? 'models' : '{}', getAttachment: () => null },
    deferReply: async () => {}, editReply: async value => replies.push(value) }, { api, router: { reportFailure: (...args) => failures.push(args) } });
  assert.equal(calls, 1);
  assert.equal(failures[0][0].code, 'insufficient_balance');
  assert.equal(failures[0][1], 'mistral');
  assert.equal(replies[0].flags, 64);
});

test('Mistral operations respect shared request admission and shutdown without charging help', async () => {
  let calls = 0, deferred = 0;
  const replies = [], controller = new AbortController();
  const interaction = { user: { id: FULL_MODE_OWNER }, options: { getString: name => name === 'operation' ? 'models' : '{}', getAttachment: () => null },
    reply: async value => replies.push(value), deferReply: async () => { deferred++; }, editReply: async value => replies.push(value) };
  const api = { apiKey: 'fixture-mistral-key', request: async (_op, _payload, options) => { calls++; assert.equal(options.signal, controller.signal); return {}; } };
  await handleMistralCommand(interaction, { api, signal: controller.signal, standalone: async () => 'quota rejected' });
  assert.equal(calls, 0); assert.equal(deferred, 0);
  await handleMistralCommand(interaction, { api, signal: controller.signal, standalone: async (_interaction, run) => run() });
  assert.equal(calls, 1); assert.equal(deferred, 1);
  interaction.options.getString = () => 'operations';
  await handleMistralCommand(interaction, { standalone: () => { throw new Error('Help must not acquire admission'); } });
  assert.equal(replies.at(-1).flags, 64);
  assert.equal(JSON.parse(replies.at(-1).files[0].attachment.toString()).operations.length, 288);
});
