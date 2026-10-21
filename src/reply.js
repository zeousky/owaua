import { card, answerCard } from './ui.js';
import { mediaReply } from './media.js';

export function resultReply(result, { notices = [], speech } = {}) {
  const warnings = [...notices, ...(result.artifactWarnings ?? [])].filter(Boolean);
  let payload;
  if (result.media) payload = mediaReply(result.media);
  else if (result.outputFormat === 'json') {
    // Notices are separate text. The attached JSON remains parseable and keeps
    // its exact schema even when memory, speech or file delivery has a warning.
    payload = { ...card('', 'JSON response attached.'), files: [
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
