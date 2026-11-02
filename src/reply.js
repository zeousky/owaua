import { card, answerCard } from './ui.js';
import { mediaReply } from './media.js';
import { assertSafeText, assertSafeValue } from './safety.js';
import { stripEmojis } from './reply-style.js';

export function resultReply(result, { notices = [], speech } = {}) {
  assertSafeValue({ text: result.text, notices, warnings: result.artifactWarnings });
  for (const artifact of result.artifacts ?? []) {
    assertSafeText(artifact.name);
    if (/\.(?:txt|md|csv|json|py|js|ts|css|html)$/i.test(artifact.name)) {
      assertSafeText(new TextDecoder('utf-8', { fatal: true }).decode(artifact.attachment));
    }
  }
  const warnings = [...notices, ...(result.artifactWarnings ?? [])].filter(Boolean).map(stripEmojis).filter(Boolean);
  let payload;
  if (result.media) payload = mediaReply(result.media);
  else if (result.outputFormat === 'json') {
    // Notices are separate text. The attached JSON remains parseable and keeps
    // its exact schema even when memory, speech or file delivery has a warning.
    payload = { ...card('', 'Here’s your answer as a JSON file.'), files: [
      { attachment: Buffer.from(result.text), name: 'owaua-answer.json' },
    ] };
  } else payload = answerCard(result.text, { fullMode: result.fullMode === true });
  if (warnings.length) {
    const note = warnings.join('\n\n');
    if ((payload.content ?? '').length + note.length + 2 <= 2000) payload.content = [payload.content, note].filter(Boolean).join('\n\n');
    else payload.files = [...(payload.files ?? []), { attachment: Buffer.from(note), name: 'owaua-notices.txt' }];
  }
  payload.files = [...(payload.files ?? []), ...(result.artifacts ?? []), ...(speech ? [speech] : [])];
  if (!payload.files.length) delete payload.files;
  return payload;
}

// Deliver the checked answer before optional speech generation. The caller's
// send function edits that same message on subsequent calls.
export async function deliverResultReply(result, { notices = [], spoken = false, voice, signal, send,
  onSpeechError = () => {} } = {}) {
  const deliveryNotices = [...notices];
  const shouldSpeak = spoken && !result.media;
  if (shouldSpeak && result.text.length > 4000) {
    deliveryNotices.push('Spoken audio covers the first 4,000 characters. The full answer is available in text.');
  }
  const delivered = await send(resultReply(result, { notices: deliveryNotices }));
  if (!shouldSpeak) return delivered;
  const report = error => {
    try { Promise.resolve(onSpeechError(error)).catch(() => {}); } catch {}
  };
  let speech;
  try {
    const generated = await voice.speak(result.text.slice(0, 4000), { signal });
    speech = { attachment: generated.attachment, name: generated.name };
  } catch (error) {
    report(error);
    deliveryNotices.push('I couldn’t generate the spoken audio. Your text answer is still available.');
  }
  try {
    // Rebuild every file and replace previous attachments so exports and long
    // answers remain present exactly once after adding speech or a notice.
    return await send({ ...resultReply(result, { notices: deliveryNotices, speech }), attachments: [] });
  } catch (error) {
    // The useful answer is already visible. A failed optional edit must not
    // turn it into a generic request failure in the caller.
    report(error);
    return delivered;
  }
}
