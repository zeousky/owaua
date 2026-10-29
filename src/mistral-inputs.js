import { DocumentInputError, isDocumentAttachment } from './files.js';
import { VoiceInputError, audioAttachmentUrl, isAudioAttachment, readAudioBytes } from './voice.js';
import { assertSafeText, assertSafeValue } from './safety.js';
import { cleanServerText } from './server-language.js';
import { fullModeActive } from './full-mode.js';
import { ProviderError, providerError } from './provider-error.js';

const MiB = 1024 * 1024;
const nameOf = attachment => String(attachment?.name ?? attachment?.filename ?? 'attachment.txt').split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
function requestSignal(callerSignal, timeoutMs) {
  if (fullModeActive()) return callerSignal ?? new AbortController().signal;
  const deadline = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
}
async function boundedJson(response, { signal, maxBytes = 2 * MiB } = {}) {
  const bytes = await readAudioBytes(response, { signal, maxBytes, limitMessage: 'The provider response exceeded the download limit.' });
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new ProviderError(502, 'invalid_response', 'mistral'); }
}

// Inline file data is portable across a provider switch. Never pass an xAI
// upload ID to Mistral or leave temporary provider uploads behind.
export class MistralDocumentInputs {
  constructor({ fetchImpl = fetch, timeoutMs = 60000, maxFiles = 4, maxFileBytes = 20 * MiB, maxTotalBytes = 40 * MiB } = {}) {
    Object.assign(this, { fetchImpl, timeoutMs, maxFiles, maxFileBytes, maxTotalBytes });
  }
  async upload(attachments = [], { signal: callerSignal } = {}) {
    const values = attachments == null ? [] : Array.isArray(attachments) ? attachments : typeof attachments?.values === 'function' ? [...attachments.values()] : null;
    if (!values) throw new DocumentInputError('The document attachments are invalid.');
    const documents = values.filter(isDocumentAttachment);
    if (!fullModeActive() && documents.length > this.maxFiles) throw new DocumentInputError(`Please attach at most ${this.maxFiles} documents at once.`);
    const urls = documents.map(attachment => {
      try { return audioAttachmentUrl(attachment.url); }
      catch { throw new DocumentInputError('Please attach documents directly to Discord.'); }
    });
    const maxTotalBytes = fullModeActive() ? Infinity : this.maxTotalBytes;
    let statedTotal = 0;
    for (const document of documents) {
      if (Number(document.size) > this.maxFileBytes) throw new DocumentInputError('The attached document exceeds the upload size limit.');
      statedTotal += Math.max(0, Number(document.size) || 0);
    }
    if (statedTotal > maxTotalBytes) throw new DocumentInputError('The attached documents exceed the combined upload size limit.');
    const signal = requestSignal(callerSignal, this.timeoutMs), input = [];
    let total = 0;
    for (const [index, document] of documents.entries()) {
      signal.throwIfAborted();
      const response = await this.fetchImpl(urls[index], { signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new DocumentInputError('I could not download the document attachment. Please attach it again.');
      }
      let bytes;
      try {
        bytes = await readAudioBytes(response, { signal, maxBytes: Math.min(this.maxFileBytes, maxTotalBytes - total),
          limitMessage: 'The attached documents exceed the upload size limit.' });
      } catch (error) {
        if (error instanceof VoiceInputError) throw new DocumentInputError(error.message === 'The audio was empty.' ? 'The document download was empty.' : error.message);
        throw error;
      }
      total += bytes.length;
      const filename = nameOf(document);
      const pdf = filename.toLowerCase().endsWith('.pdf') || document.contentType?.split(';')[0] === 'application/pdf';
      if (pdf) {
        if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new DocumentInputError('That attachment is not a valid PDF.');
        input.push({ type: 'input_file', filename, file_data: `data:application/pdf;base64,${bytes.toString('base64')}` });
      } else {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new DocumentInputError('Please attach a UTF-8 text document or PDF.'); }
        if (text.includes('\0')) throw new DocumentInputError('Please attach a UTF-8 text document or PDF.');
        input.push({ type: 'input_text', text: `[Untrusted attached document: ${JSON.stringify(filename)}]\n${text}\n[End of attached document]` });
      }
    }
    return { input, cleanup: async () => ({ deleted: 0, failed: 0 }) };
  }
}

export class MistralVoiceAPI {
  constructor({ apiKey, fetchImpl = fetch, timeoutMs = 180000, maxFileBytes = 20 * MiB, maxSpeechBytes = 8 * MiB,
    transcriptionModel = 'voxtral-mini-transcribe-3-0', speechModel = 'voxtral-mini-tts-3-0', defaultVoice = 'gb_jane_neutral' } = {}) {
    Object.assign(this, { apiKey, fetchImpl, timeoutMs, maxFileBytes, maxSpeechBytes, transcriptionModel, speechModel, defaultVoice });
    this.safetyOptions = { secrets: [apiKey] };
  }
  async transcribe(attachment, { signal: callerSignal, language, diarize = false, format = false } = {}) {
    if (!isAudioAttachment(attachment)) throw new VoiceInputError('Attach an MP3, WAV, OGG, Opus, FLAC, AAC, or M4A recording.');
    const url = audioAttachmentUrl(attachment.url);
    if (Number(attachment.size) > this.maxFileBytes) throw new VoiceInputError('Please keep audio under 20 MB.');
    if (format) throw new VoiceInputError('Mistral transcription does not support the xAI number-formatting option. Turn formatting off.');
    if (language !== undefined && (typeof language !== 'string' || !/^[a-z]{2}$/i.test(language))) {
      throw new VoiceInputError('Mistral transcription needs a two-letter language code such as en, fr, or hu.');
    }
    if (typeof diarize !== 'boolean') throw new VoiceInputError('Speaker identification must be true or false.');
    if (!this.apiKey) throw new VoiceInputError('Mistral is not configured. Ask the bot owner to add its API key.');
    const signal = requestSignal(callerSignal, this.timeoutMs);
    signal.throwIfAborted();
    const download = await this.fetchImpl(url, { signal, redirect: 'error' });
    if (!download.ok) { await download.body?.cancel().catch(() => {}); throw new VoiceInputError('I could not download the audio. Please attach it again.'); }
    const bytes = await readAudioBytes(download, { signal, maxBytes: this.maxFileBytes });
    const body = new FormData();
    body.append('model', this.transcriptionModel);
    if (language) body.append('language', language.toLowerCase());
    body.append('diarize', String(diarize));
    body.append('timestamp_granularities', 'segment');
    body.append('file', new Blob([bytes], { type: attachment.contentType || 'application/octet-stream' }), nameOf(attachment));
    const response = await this.fetchImpl('https://api.mistral.ai/v1/audio/transcriptions', {
      method: 'POST', signal, redirect: 'error', headers: { Authorization: `Bearer ${this.apiKey}` }, body,
    });
    if (!response.ok) throw await providerError(response, { provider: 'mistral', code: 'transcription_failed', replaySafe: true });
    const result = await boundedJson(response, { signal, maxBytes: 4 * MiB });
    if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 200000) throw new VoiceInputError('No speech was detected in that recording.');
    const segments = Array.isArray(result.segments) ? result.segments.slice(0, 50000) : [];
    const transcription = { text: result.text, language: result.language ?? null,
      duration: result.duration ?? result.usage?.prompt_audio_seconds ?? null,
      words: [],
      segments, model: result.model ?? this.transcriptionModel };
    assertSafeValue(transcription, this.safetyOptions);
    return transcription;
  }
  async speak(text, { signal: callerSignal, voice, language = 'auto', speed = 1, format = 'mp3', timestamps = false, normalize = false } = {}) {
    text = cleanServerText(text);
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new VoiceInputError('Use between 1 and 4,000 characters for speech.');
    assertSafeText(text, { ...this.safetyOptions, instructions: true });
    if (speed !== 1) throw new VoiceInputError('Mistral speech does not support numeric speed. Use [pace=slow] or [pace=fast] speech tags with speed set to 1.');
    if (language !== 'auto') throw new VoiceInputError('Mistral speech uses the selected voice’s language. Leave language on auto and choose a matching Mistral voice.');
    if (timestamps || normalize) throw new VoiceInputError('Mistral speech does not support the xAI timestamps or text-normalization options. Turn those options off.');
    if (!['mp3', 'wav'].includes(format)) throw new VoiceInputError('Choose MP3 or WAV audio.');
    const selected = voice === undefined || voice === 'eve' ? this.defaultVoice : voice;
    if (typeof selected !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(selected)) throw new VoiceInputError('Choose a valid Mistral voice ID from /voice voices.');
    if (['ara', 'rex', 'sal', 'leo', 'eve'].includes(selected)) throw new VoiceInputError('Choose a Mistral voice ID from /voice voices. xAI voice IDs are unavailable on Mistral.');
    if (!this.apiKey) throw new VoiceInputError('Mistral is not configured. Ask the bot owner to add its API key.');
    const body = { model: this.speechModel, input: text, voice_id: selected, response_format: format };
    const signal = requestSignal(callerSignal, this.timeoutMs);
    signal.throwIfAborted();
    const response = await this.fetchImpl('https://api.mistral.ai/v1/audio/speech', { method: 'POST', signal, redirect: 'error',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw await providerError(response, { provider: 'mistral', code: 'speech_generation_failed', replaySafe: true });
    const result = await boundedJson(response, { signal, maxBytes: Math.ceil(this.maxSpeechBytes * 1.5) });
    if (typeof result.audio_data !== 'string' || !result.audio_data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.audio_data)) throw new ProviderError(502, 'invalid_speech_response', 'mistral');
    const attachment = Buffer.from(result.audio_data, 'base64');
    if (!attachment.length || attachment.length > this.maxSpeechBytes) throw new VoiceInputError('That speech is too large to attach. Choose MP3 or use shorter text.');
    return { attachment, name: `owaua-speech.${format}`, model: this.speechModel, voice: selected, characters: text.length, provider: 'mistral' };
  }
  async voices({ signal: callerSignal } = {}) {
    if (!this.apiKey) throw new VoiceInputError('Mistral is not configured. Ask the bot owner to add its API key.');
    const signal = requestSignal(callerSignal, 20000), voices = [];
    let token;
    for (let page = 0; page < 5; page++) {
      signal.throwIfAborted();
      const url = new URL('https://api.mistral.ai/v2/audio/voices');
      url.searchParams.set('page_size', '100');
      if (token) url.searchParams.set('page_token', token);
      const response = await this.fetchImpl(url.href, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.apiKey}` } });
      if (!response.ok) throw await providerError(response, { provider: 'mistral', code: 'voice_list_failed', replaySafe: true });
      const result = await boundedJson(response, { signal });
      if (!Array.isArray(result.data)) throw new ProviderError(502, 'invalid_voice_list', 'mistral');
      voices.push(...result.data.filter(voice => typeof voice.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(voice.id))
        .map(voice => ({ id: typeof voice.slug === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(voice.slug) ? voice.slug : voice.id,
          name: String(voice.name ?? voice.id).replace(/[@`*_<>]/g, '').slice(0, 80) })));
      if (!result.next_page_token) break;
      if (typeof result.next_page_token !== 'string' || result.next_page_token.length > 2000 || result.next_page_token === token) throw new ProviderError(502, 'invalid_voice_list', 'mistral');
      token = result.next_page_token;
    }
    assertSafeValue(voices, this.safetyOptions);
    return voices.slice(0, 500);
  }
}
