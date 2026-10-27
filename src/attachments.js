import { requestImages } from './images.js';
import { isDocumentAttachment } from './files.js';
import { isAudioAttachment } from './voice.js';
import { fullModeActive } from './full-mode.js';

export class AttachmentInputError extends Error {}

// Only Discord attachment metadata and explicitly replied-to bot media become
// references. Model tool arguments never choose an input URL.
export function requestAttachments(message, reference, botId) {
  const current = [...message.attachments.values()];
  const selected = current.length ? current : [...(reference?.attachments.values() ?? [])];
  const pictures = [], documents = [], videos = [], audio = [];
  for (const attachment of selected) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > 20 * 1024 * 1024) {
      throw new AttachmentInputError('Please keep each attachment under 20 MB.');
    }
    if (/^image\/(png|jpeg|webp|gif)$/.test(attachment.contentType ?? '')) pictures.push(attachment);
    else if (attachment.contentType === 'video/mp4') {
      let url;
      try { url = new URL(attachment.url); } catch {}
      if (!url || url.protocol !== 'https:' || url.username || url.password) {
        throw new AttachmentInputError('Please attach an MP4 video through Discord.');
      }
      videos.push(url.href);
    } else if (isAudioAttachment(attachment)) audio.push(attachment);
    else if (isDocumentAttachment(attachment)) documents.push(attachment);
    else throw new AttachmentInputError('Please attach images, audio, an MP4 video, or PDF/text/code documents.');
  }
  if ((!fullModeActive() && (pictures.length > 5 || documents.length > 4 || audio.length > 1)) || videos.length > 1) {
    throw new AttachmentInputError('Please use at most five images, four documents, one audio recording, and one MP4 per request.');
  }
  // New documents/videos suppress old image references just as new images do.
  const images = requestImages({ attachments: new Map(pictures.map((a, i) => [i, a])) },
    selected.length || current.length ? undefined : reference, botId);
  if (!selected.length && !current.length && reference?.author?.id === botId) {
    const preview = (reference.embeds ?? []).map(e => e.video?.url).find(Boolean);
    const direct = /^https:\/\/\S+\.mp4(?:\?\S*)?$/i.test(reference.content?.trim() ?? '') ? reference.content.trim() : null;
    const source = preview ?? direct;
    if (source) {
      const url = new URL(source);
      if (url.protocol === 'https:' && !url.username && !url.password) videos.push(url.href);
    }
  }
  return { images, documents, videos, audio };
}
