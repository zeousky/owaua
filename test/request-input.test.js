import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequestInput } from '../src/request-input.js';
import { resultReply } from '../src/reply.js';

function fixture() {
  const events = [];
  return { events,
    voice: { transcribe: async () => ({ text: 'What does the revenue chart show?' }) },
    documentInputs: { upload: async () => ({ input: [{ type: 'input_file', file_id: 'file_current' }],
      cleanup: async () => events.push('delete-current') }) },
    knowledge: { context: async scope => { events.push(scope); return { input: [{ type: 'input_file', file_id: 'file_saved' }],
      tools: [], total: 1, selected: 1, names: ['saved.pdf'] }; } },
  };
}

test('audio, current documents and saved library references reach one isolated request', async () => {
  const deps = fixture();
  const prepared = await prepareRequestInput({ ...deps, text: 'Compare them.', audio: [{}], documents: [{}],
    images: ['https://cdn.discordapp.com/chart.png'], useLibrary: true, scope: 'g:c:owner' });
  assert.match(prepared.input[0].text, /What does the revenue chart show/);
  assert.deepEqual(prepared.input.slice(1).map(part => part.type), ['input_image', 'input_file', 'input_file']);
  assert.match(prepared.historyInput, /Transcript of your attached audio/);
  assert.doesNotMatch(prepared.historyInput, /file_saved|file_current|cdn\.discordapp/);
  assert.deepEqual(deps.events, ['g:c:owner']);
  await prepared.cleanup();
  assert.deepEqual(deps.events, ['g:c:owner', 'delete-current']);
});

test('saved knowledge is never consulted without explicit opt-in', async () => {
  const deps = fixture();
  const prepared = await prepareRequestInput({ ...deps, text: 'Question', scope: 'owner' });
  assert.deepEqual(deps.events, []);
  assert.equal(prepared.knowledgeTools.length, 0);
  await prepared.cleanup();
});

test('library failure rolls back temporary uploads without deleting saved files', async () => {
  const deps = fixture();
  deps.knowledge.context = async () => { throw new Error('index failed'); };
  await assert.rejects(prepareRequestInput({ ...deps, text: 'Question', documents: [{}], useLibrary: true }), /index failed/);
  assert.deepEqual(deps.events, ['delete-current']);
});

test('long audio transcripts stop before document upload or inference', async () => {
  const deps = fixture();
  deps.voice.transcribe = async () => ({ text: 'x'.repeat(24001) });
  deps.documentInputs.upload = async () => assert.fail('must not upload');
  await assert.rejects(prepareRequestInput({ ...deps, text: '', audio: [{}] }), /too long/);
});

test('collection search tools stay scoped and incomplete library selection is disclosed', async () => {
  const deps = fixture();
  const tools = [{ type: 'file_search', vector_store_ids: ['collection_scoped'] }];
  deps.knowledge.context = async () => ({ input: [], tools, total: 6, selected: 4, names: [] });
  const prepared = await prepareRequestInput({ ...deps, text: 'Compare', useLibrary: true });
  assert.deepEqual(prepared.knowledgeTools, tools);
  assert.match(prepared.notices[0], /4 of 6/);
});

test('JSON output, chart files, speech and warnings remain separate downloadable artifacts', () => {
  const json = '{"answer":"hi","sources":[]}';
  const artifact = { name: 'chart.png', attachment: Buffer.from('chart') };
  const speech = { name: 'speech.mp3', attachment: Buffer.from('audio') };
  const payload = resultReply({ text: json, outputFormat: 'json', artifacts: [artifact], artifactWarnings: ['One file was too large.'] },
    { notices: ['Memory could not be saved.'], speech });
  assert.equal(payload.files[0].name, 'kirmy-answer.json');
  assert.deepEqual(JSON.parse(payload.files[0].attachment.toString()), JSON.parse(json));
  assert.deepEqual(payload.files.slice(1), [artifact, speech]);
  assert.match(payload.content, /Memory could not be saved/);
});

test('long answers retain their Markdown attachment alongside generated files', () => {
  const payload = resultReply({ text: 'x'.repeat(4000), artifacts: [{ name: 'data.csv', attachment: Buffer.from('a,b') }] });
  assert.equal(payload.files.length, 2);
  assert.equal(payload.files[1].name, 'data.csv');
});
