import { card, answerCard } from './ui.js';
import { mediaReply } from './media.js';
import { assertSafeText, assertSafeValue } from './safety.js';

export function resultReply(result, { notices = [], speech } = {}) {
  assertSafeValue({ text: result.text, notices, warnings: result.artifactWarnings });
  for (const artifact of result.artifacts ?? []) {
    assertSafeText(artifact.name);
    if (/\.(?:txt|md|csv|json|py|js|ts|css|html)$/i.test(artifact.name)) {
      assertSafeText(new TextDecoder('utf-8', { fatal: true }).decode(artifact.attachment));
    }
  }
  const warnings = [...notices, ...(result.artifactWarnings ?? [])].filter(Boolean);
  let payload;
  if (result.media) payload = mediaReply(result.media);
  else if (result.outputFormat === 'json') {
    // Notices are separate text. The attached JSON remains parseable and keeps
    // its exact schema even when memory, speech or file delivery has a warning.
    payload = { ...card('', 'Here’s your answer as a JSON file.'), files: [
      { attachment: Buffer.from(result.text), name: 'kirmy-answer.json' },
    ] };
  } else payload = answerCard(result.text);
  if (warnings.length) {
    const note = warnings.join('\n\n');
    if ((payload.content ?? '').length + note.length + 2 <= 2000) payload.content = [payload.content, note].filter(Boolean).join('\n\n');
    else payload.files = [...(payload.files ?? []), { attachment: Buffer.from(note), name: 'kirmy-notices.txt' }];
  }
  payload.files = [...(payload.files ?? []), ...(result.artifacts ?? []), ...(speech ? [speech] : [])];
  if (!payload.files.length) delete payload.files;
  return payload;
}
