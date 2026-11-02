import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverResultReply } from '../src/reply.js';
import { SafetyError } from '../src/safety.js';

const speech = { attachment: Buffer.from('audio bytes'), name: 'owaua-speech.mp3' };
const artifact = { attachment: Buffer.from('x,y\n1,2'), name: 'report.csv' };

test('spoken replies deliver text and exports before stalled TTS, then replace attachments once', async () => {
  const sent = [], errors = [];
  let finishSpeech, spokenText;
  const waiting = new Promise(resolve => { finishSpeech = resolve; });
  const signal = new AbortController().signal;
  const result = { text: 'The total is 3.', artifacts: [artifact] };
  const notices = ['An existing notice.'];
  const running = deliverResultReply(result, { notices, spoken: true, signal,
    voice: { speak: async (text, options) => { spokenText = text; assert.equal(options.signal, signal); return waiting; } },
    send: async payload => { sent.push(payload); return payload; }, onSpeechError: error => errors.push(error) });
  await new Promise(setImmediate);
  try {
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /The total is 3/);
    assert.match(sent[0].content, /An existing notice/);
    assert.deepEqual(sent[0].files, [artifact]);
    assert.equal(spokenText, result.text);
  } finally { finishSpeech(speech); }
  const delivered = await running;
  assert.equal(sent.length, 2);
  assert.equal(delivered, sent[1]);
  assert.deepEqual(sent[1].attachments, []);
  assert.deepEqual(sent[1].files, [artifact, speech]);
  assert.deepEqual(notices, ['An existing notice.']);
  assert.deepEqual(errors, []);
});

test('long spoken answers retain the complete text attachment and explain the audio limit', async () => {
  const sent = [];
  const text = 'Useful details. '.repeat(300);
  let spokenText;
  await deliverResultReply({ text, fullMode: true, artifacts: [artifact] }, { spoken: true,
    voice: { speak: async value => { spokenText = value; return speech; } },
    send: async payload => sent.push(payload) });
  assert.equal(spokenText, text.slice(0, 4000));
  for (const payload of sent) {
    assert.match(payload.content, /Spoken audio covers the first 4,000 characters/);
    assert.equal(payload.files[0].name, 'owaua-answer.md');
    assert.equal(payload.files[0].attachment.toString(), text.trim());
    assert.equal(payload.files.filter(file => file.name === artifact.name).length, 1);
  }
  assert.deepEqual(sent[1].attachments, []);
  assert.equal(sent[1].files.at(-1).name, speech.name);
});

test('speech failure adds an honest notice while preserving the delivered answer and artifacts', async () => {
  const sent = [], errors = [];
  const failure = new Error('TTS unavailable');
  await deliverResultReply({ text: 'Here is the result.', artifacts: [artifact] }, { spoken: true,
    voice: { speak: async () => { throw failure; } },
    send: async payload => sent.push(payload), onSpeechError: error => errors.push(error) });
  assert.equal(sent.length, 2);
  assert.match(sent[0].content, /Here is the result/);
  assert.match(sent[1].content, /I couldn’t generate the spoken audio/);
  assert.match(sent[1].content, /Your text answer is still available/);
  assert.deepEqual(sent[1].files, [artifact]);
  assert.deepEqual(sent[1].attachments, []);
  assert.deepEqual(errors, [failure]);
});

test('a failed speech attachment edit leaves the delivered answer intact and reports the error', async () => {
  const sent = [], errors = [];
  const failure = new Error('Discord edit failed');
  const initial = { id: 'answer' };
  const result = await deliverResultReply({ text: 'A useful answer.', artifacts: [artifact] }, { spoken: true,
    voice: { speak: async () => speech },
    send: async payload => { sent.push(payload); if (sent.length > 1) throw failure; return initial; },
    onSpeechError: error => { errors.push(error); throw new Error('Logging failed'); } });
  assert.equal(result, initial);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].content, 'A useful answer.');
  assert.deepEqual(sent[0].files, [artifact]);
  assert.deepEqual(errors, [failure]);
});

test('text-only and media replies are sent once without TTS', async () => {
  for (const [result, spoken] of [[{ text: 'Hello.' }, false],
    [{ text: 'Generated image.', media: { kind: 'image', url: 'https://example.com/image.png' } }, true]]) {
    const sent = [];
    await deliverResultReply(result, { spoken,
      voice: { speak: () => { assert.fail('TTS should not run'); } }, send: async payload => sent.push(payload) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].attachments, undefined);
  }
});

test('an initial delivery failure propagates before TTS starts', async () => {
  const failure = new Error('Discord unavailable');
  await assert.rejects(deliverResultReply({ text: 'A useful answer.' }, { spoken: true,
    voice: { speak: () => { assert.fail('TTS should not run'); } },
    send: async () => { throw failure; } }), error => error === failure);
});

test('unsafe text is blocked before either message delivery or TTS', async () => {
  await assert.rejects(deliverResultReply({ text: `xai-${'a'.repeat(32)}` }, { spoken: true,
    voice: { speak: () => { assert.fail('TTS should not run'); } },
    send: () => { assert.fail('An unsafe answer must not be sent'); } }), SafetyError);
});
