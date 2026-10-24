import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactCollector, exportChart, exportFile, registerArtifactTools, MAX_ARTIFACT_BYTES } from '../src/artifacts.js';
import { ToolRegistry } from '../src/tools.js';
import { AICore } from '../src/ai.js';

const pythonCall = (stdout, { status = 'completed', exit_code = 0 } = {}) => ({ type: 'code_interpreter_call', status,
  outputs: [{ type: 'logs', logs: JSON.stringify({ stdout, stderr: '', exit_code }) }] });
const envelope = (name, type, data) => `OWAUA_ARTIFACT:${JSON.stringify({ filename: name, mime_type: type, base64: Buffer.from(data).toString('base64') })}`;

test('safe exports create actual file bytes while rejecting paths, malformed data and unsupported files', () => {
  assert.equal(exportFile({ filename: 'data.csv', content: 'x,y\n1,2\n' }).attachment.toString(), 'x,y\n1,2\n');
  assert.deepEqual(JSON.parse(exportFile({ filename: 'data.json', content: '{"ok":true}' }).attachment), { ok: true });
  for (const args of [{ filename: '../data.csv', content: 'a' }, { filename: '/tmp/data.txt', content: 'a' },
    { filename: 'résumé.txt', content: 'a' }, { filename: 'code.exe', content: 'a' }, { filename: 'bad.json', content: '{' },
    { filename: 'bad.png', content: Buffer.from('not a PNG').toString('base64'), encoding: 'base64' },
    { filename: 'bad.txt', content: 'YWJj=', encoding: 'base64' }, { filename: 'nul.txt', content: 'a\0b' },
    { filename: 'big.txt', content: 'é'.repeat(MAX_ARTIFACT_BYTES) }]) assert.throws(() => exportFile(args));
});

test('local charts render a real PNG from bounded data with escaped labels and no local code execution', () => {
  const chart = exportChart({ title: '<script>alert(1)</script>', x_label: 'Quarter', y_label: 'Sales', chart_type: 'bar',
    series: [{ name: '<a href="https://evil">', points: [{ x: 'Q1', y: -2 }, { x: 'Q2', y: 3 }] }] });
  assert.equal(chart.name, 'chart.png');
  assert.equal(chart.contentType, 'image/png');
  assert.ok(chart.attachment.subarray(1, 4).equals(Buffer.from('PNG')));
  assert.equal(chart.attachment.readUInt32BE(16), 1000);
  assert.ok(chart.attachment.length < MAX_ARTIFACT_BYTES);
  for (const series of [[{ name: 'x', points: [{ x: 'a', y: NaN }] }], [{ name: 'x', points: [{ x: 'a', y: 1 }, { x: 'a', y: 2 }] }]]) {
    assert.throws(() => exportChart({ title: 'Bad', series }));
  }
});

test('Python exports are extracted only from successful completed provider code logs and bounded per request', () => {
  const collector = new ArtifactCollector();
  const first = envelope('data.csv', 'text/csv', 'x,y\n1,2');
  collector.collectPython([pythonCall(first), pythonCall(first), pythonCall(envelope('failed.txt', 'text/plain', 'secret'), { exit_code: 1 }),
    pythonCall(envelope('running.txt', 'text/plain', 'secret'), { status: 'in_progress' }),
    { type: 'message', content: [{ type: 'output_text', text: envelope('fake.txt', 'text/plain', 'invented') }] }]);
  assert.equal(collector.artifacts.length, 1);
  assert.equal(collector.artifacts[0].attachment.toString(), 'x,y\n1,2');
  collector.collectPython([pythonCall(envelope('../unsafe.txt', 'text/plain', 'bad')),
    pythonCall(envelope('wrong.csv', 'image/png', 'bad'))]);
  assert.ok(collector.warnings.length > 0);
  collector.add(exportFile({ filename: 'data.csv', content: 'other' }));
  assert.equal(collector.artifacts[1].name, 'data-2.csv');
  collector.add(exportFile({ filename: 'third.txt', content: '3' }));
  assert.match(collector.add(exportFile({ filename: 'fourth.txt', content: '4' })).error, /limit/);
  assert.equal(collector.artifacts.length, 3);
});

test('AI attaches local and Python exports and sends only metadata through function continuations', async () => {
  const tools = registerArtifactTools(new ToolRegistry());
  const requests = [];
  const fileContent = 'x,y\n1,2';
  const code = { ...pythonCall(`Computed total: 3\r\n${envelope('python.csv', 'text/csv', fileContent)}\r\nOrdinary stdout remains.`),
    id: 'ci-original', call_id: 'code-original', code: 'print("computed")' };
  const originalCode = structuredClone(code);
  const reasoning = { type: 'reasoning', id: 'reasoning-original', encrypted_content: 'opaque-original' };
  const ai = new AICore({ tools, fetchImpl: async (_, request) => {
    const body = JSON.parse(request.body); requests.push(body);
    assert.deepEqual(body.include, ['code_interpreter_call.outputs']);
    return { ok: true, json: async () => requests.length === 1 ? { output: [
      reasoning, code,
      { type: 'function_call', call_id: 'export-1', name: 'export_file', arguments: '{"filename":"notes.txt","content":"Useful result"}' },
    ] } : { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Files attached.' }] }] } };
  } });
  const response = await ai.respond({ input: 'Analyze and export' });
  assert.deepEqual(response.artifacts.map(file => file.name), ['python.csv', 'notes.txt']);
  assert.equal(response.artifacts[0].attachment.toString(), fileContent);
  assert.equal(response.artifacts[1].attachment.toString(), 'Useful result');
  const localResult = requests[1].input.find(item => item.type === 'function_call_output');
  assert.deepEqual(JSON.parse(localResult.output), { filename: 'notes.txt', bytes: 13, attached: true });
  assert.doesNotMatch(localResult.output, /Buffer|Useful result/);
  const replayed = requests[1].input.find(item => item.type === 'code_interpreter_call');
  assert.equal(replayed.id, 'ci-original');
  assert.equal(replayed.call_id, 'code-original');
  assert.equal(replayed.code, originalCode.code);
  assert.deepEqual(requests[1].input.find(item => item.type === 'reasoning'), reasoning);
  const replayedLogs = JSON.parse(replayed.outputs[0].logs);
  assert.match(replayedLogs.stdout, /Computed total: 3\r\n/);
  assert.match(replayedLogs.stdout, /\r\nOrdinary stdout remains\.$/);
  assert.match(replayedLogs.stdout, /"filename":"python.csv","bytes":7,"attached":true/);
  assert.doesNotMatch(replayed.outputs[0].logs, /OWAUA_ARTIFACT:|eCx5CjEsMg==/);
  assert.equal(JSON.stringify(requests[1]).includes(Buffer.from(fileContent).toString('base64')), false);
  assert.deepEqual(code, originalCode);
});

test('unvalidated Python envelopes are removed from replay without claiming successful attachment', () => {
  const collector = new ArtifactCollector();
  const failed = pythonCall(envelope('data.csv', 'text/csv', 'abc'), { exit_code: 1 });
  collector.collectPython([failed]);
  const replay = collector.replayOutput([failed]);
  assert.equal(collector.artifacts.length, 0);
  assert.match(JSON.parse(replay[0].outputs[0].logs).stdout, /"attached":false/);
  assert.doesNotMatch(JSON.stringify(replay), /YWJj|OWAUA_ARTIFACT:/);
  assert.match(JSON.parse(failed.outputs[0].logs).stdout, /OWAUA_ARTIFACT:/);
});

test('successful large UTF-8 and base64 export arguments are replayed as metadata while small content stays meaningful', async () => {
  for (const encoding of ['utf8', 'base64']) {
    const tools = registerArtifactTools(new ToolRegistry());
    const bytes = Buffer.from('Meaningful export text.\n'.repeat(600));
    const content = encoding === 'base64' ? bytes.toString('base64') : bytes.toString();
    const largeCall = { type: 'function_call', id: 'function-original', call_id: 'export-large', status: 'completed',
      name: 'export_file', arguments: JSON.stringify({ filename: 'large.txt', content, encoding }) };
    const smallCall = { type: 'function_call', call_id: 'export-small', name: 'export_file',
      arguments: JSON.stringify({ filename: 'small.txt', content: 'Small meaningful content.' }) };
    const original = structuredClone(largeCall);
    const reasoning = { type: 'reasoning', id: 'reasoning-keep', encrypted_content: 'opaque-keep' };
    const requests = [];
    const ai = new AICore({ tools, fetchImpl: async (_, request) => {
      requests.push(JSON.parse(request.body));
      return { ok: true, json: async () => requests.length === 1 ? { output: [reasoning, largeCall, smallCall] } :
        { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Files attached.' }] }] } };
    } });
    const response = await ai.respond({ input: 'Export both files.' });
    assert.deepEqual(response.artifacts.map(file => file.name), ['large.txt', 'small.txt']);
    assert.deepEqual(response.artifacts[0].attachment, bytes);
    const replay = requests[1].input.find(item => item.call_id === 'export-large');
    assert.equal(replay.id, largeCall.id);
    assert.equal(replay.name, largeCall.name);
    assert.equal(replay.status, largeCall.status);
    assert.match(JSON.parse(replay.arguments).content, /Historical export already attached as large.txt/);
    assert.ok(replay.arguments.length < 300);
    assert.equal(JSON.stringify(requests[1]).includes(content), false);
    assert.deepEqual(requests[1].input.find(item => item.call_id === 'export-small'), smallCall);
    assert.deepEqual(requests[1].input.find(item => item.type === 'reasoning'), reasoning);
    const result = requests[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'export-large');
    assert.deepEqual(JSON.parse(result.output), { filename: 'large.txt', bytes: bytes.length, attached: true });
    assert.deepEqual(largeCall, original);
  }
});
