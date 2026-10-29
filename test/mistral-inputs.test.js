import test from 'node:test';
import assert from 'node:assert/strict';
import { MistralDocumentInputs, MistralVoiceAPI } from '../src/mistral-inputs.js';
import { DocumentInputError } from '../src/files.js';
import { VoiceInputError } from '../src/voice.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const audio = { name: 'voice.ogg', contentType: 'audio/ogg', size: 5, url: 'https://cdn.discordapp.com/attachments/1/2/voice.ogg' };
const pdf = { name: 'report.pdf', contentType: 'application/pdf', size: 9, url: 'https://cdn.discordapp.com/attachments/1/2/report.pdf' };

test('Mistral PDFs use inline Responses data and no provider-specific upload IDs', async () => {
  let calls = 0;
  const documents = new MistralDocumentInputs({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, pdf.url); assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error');
    return new Response('%PDF-test');
  } });
  const result = await documents.upload([pdf]);
  assert.deepEqual(result.input, [{ type: 'input_file', filename: 'report.pdf', file_data: `data:application/pdf;base64,${Buffer.from('%PDF-test').toString('base64')}` }]);
  assert.deepEqual(await result.cleanup(), { deleted: 0, failed: 0 });
  assert.equal(calls, 1);
});
test('Mistral text files carry untrusted reference text and reject binary payloads', async () => {
  const attachment = { ...pdf, name: 'data.csv', contentType: 'text/csv' };
  const documents = new MistralDocumentInputs({ fetchImpl: async () => new Response('name,value\nx,5') });
  const { input } = await documents.upload([attachment]);
  assert.equal(input[0].type, 'input_text'); assert.match(input[0].text, /Untrusted attached document: "data.csv"/);
  assert.match(input[0].text, /name,value\nx,5/);
  await assert.rejects(new MistralDocumentInputs({ fetchImpl: async () => new Response(new Uint8Array([255])) }).upload([attachment]), /UTF-8/);
  await assert.rejects(new MistralDocumentInputs({ fetchImpl: async () => new Response('bad PDF') }).upload([pdf]), /valid PDF/);
});
test('Mistral document downloads enforce host, per-file and aggregate limits before provider calls', async () => {
  let calls = 0;
  const documents = new MistralDocumentInputs({ maxFileBytes: 5, maxTotalBytes: 8, fetchImpl: async () => { calls++; return new Response('12345'); } });
  await assert.rejects(documents.upload([{ ...pdf, url: 'https://localhost/report.pdf', size: 1 }]), DocumentInputError);
  await assert.rejects(documents.upload([{ ...pdf, size: 6 }]), DocumentInputError);
  await assert.rejects(documents.upload([{ ...pdf, size: 5 }, { ...pdf, size: 5 }]), DocumentInputError);
  assert.equal(calls, 0);
  await assert.rejects(documents.upload([{ ...pdf, size: 1 }]), DocumentInputError);
  assert.equal(calls, 1);
});
test('Mistral actual streamed file bytes are bounded and cancelled', async () => {
  let cancelled = false;
  const documents = new MistralDocumentInputs({ maxFileBytes: 4, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(documents.upload([{ ...pdf, size: 1 }]), DocumentInputError);
  assert.equal(cancelled, true);
});
test('Mistral transcription uses Voxtral 3 segment timestamps and retains speaker labels', async () => {
  const calls = [], segments = [{ type: 'transcription_segment', text: 'Hello', start: 0, end: 1, speaker_id: 'speaker_0' }];
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response('audio') : json({ text: 'Hello world', language: 'en', segments,
      model: 'voxtral-mini-transcribe-3-0', usage: { prompt_audio_seconds: 1 } });
  } });
  const result = await voice.transcribe(audio, { language: 'EN', diarize: true });
  assert.equal(calls[0].url, audio.url); assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].url, 'https://api.mistral.ai/v1/audio/transcriptions');
  const fields = calls[1].options.body;
  assert.equal(fields.get('model'), 'voxtral-mini-transcribe-3-0');
  assert.equal(fields.get('diarize'), 'true'); assert.equal(fields.get('timestamp_granularities'), 'segment');
  assert.equal(fields.get('language'), 'en'); assert.equal(fields.get('file').name, 'voice.ogg');
  assert.deepEqual(result.segments, segments); assert.deepEqual(result.words, []); assert.equal(result.duration, 1);
});
test('unsupported transcription options and unsafe attachments fail before download', async () => {
  let calls = 0;
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async () => { calls++; throw new Error(); } });
  await assert.rejects(voice.transcribe(audio, { format: true }), /formatting/);
  await assert.rejects(voice.transcribe(audio, { language: 'pt-BR' }), /two-letter/);
  await assert.rejects(voice.transcribe({ ...audio, url: 'https://evil.example/audio' }), VoiceInputError);
  await assert.rejects(voice.transcribe({ ...audio, size: 30 * 1024 * 1024 }), VoiceInputError);
  assert.equal(calls, 0);
});
test('Mistral TTS decodes documented audio_data and maps the existing default voice', async () => {
  let body;
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.mistral.ai/v1/audio/speech'); assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body); return json({ audio_data: Buffer.from('spoken').toString('base64') });
  } });
  const result = await voice.speak('Hello', { voice: 'eve', format: 'wav' });
  assert.equal(body.model, 'voxtral-mini-tts-3-0'); assert.equal(body.voice_id, 'gb_jane_neutral');
  assert.equal(body.input, 'Hello'); assert.equal(body.response_format, 'wav');
  assert.equal(result.attachment.toString(), 'spoken'); assert.equal(result.name, 'owaua-speech.wav');
  assert.equal(result.provider, 'mistral');
});
test('Mistral speech rejects incompatible options before making a synthesis call', async () => {
  let calls = 0;
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async () => { calls++; throw new Error(); } });
  for (const options of [{ speed: 1.2 }, { language: 'en' }, { timestamps: true }, { normalize: true }, { voice: '../bad' }, { voice: 'ara' }]) {
    await assert.rejects(voice.speak('Hello', options), VoiceInputError);
  }
  assert.equal(calls, 0);
});
test('Mistral rejects invalid speech base64 and bounds synthesized bytes', async () => {
  const invalid = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async () => json({ audio_data: '!' }) });
  await assert.rejects(invalid.speak('Hello'), error => error.code === 'invalid_speech_response');
  const oversized = new MistralVoiceAPI({ apiKey: 'private', maxSpeechBytes: 2, fetchImpl: async () => json({ audio_data: Buffer.from('large-audio').toString('base64') }) });
  await assert.rejects(oversized.speak('Hello'), VoiceInputError);
});
test('Mistral voice listing paginates cursor API and filters unsafe IDs', async () => {
  const calls = [];
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async url => {
    calls.push(url);
    return calls.length === 1 ? json({ data: [{ id: 'one', slug: 'gb_jane_neutral', name: 'Jane' }, { id: '../bad', name: 'bad' }], next_page_token: 'next' })
      : json({ data: [{ id: 'two', name: 'Second <voice>' }], next_page_token: null });
  } });
  assert.deepEqual(await voice.voices(), [{ id: 'gb_jane_neutral', name: 'Jane' }, { id: 'two', name: 'Second voice' }]);
  assert.match(calls[0], /\/v2\/audio\/voices\?page_size=100$/); assert.match(calls[1], /page_token=next/);
});
test('Mistral audio failures keep bodies private and tag insufficient balance for switching', async () => {
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'insufficient_balance', message: 'private user content' } }), { status: 402 }) });
  await assert.rejects(voice.speak('Hello'), error => error.provider === 'mistral' && error.code === 'insufficient_balance' && error.replaySafe === true && !error.message.includes('private'));
});
test('aborted Mistral download cannot reach transcription upload', async () => {
  const controller = new AbortController(); let calls = 0, cancelled = false;
  const voice = new MistralVoiceAPI({ apiKey: 'private', fetchImpl: async () => {
    calls++; return new Response(new ReadableStream({ pull() { queueMicrotask(() => controller.abort()); }, cancel() { cancelled = true; } }));
  } });
  await assert.rejects(voice.transcribe(audio, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
