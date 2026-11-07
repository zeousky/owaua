import { fullModeActive } from './full-mode.js';

// Current attachments take priority over images in the replied-to message.
export function requestImages(message, reference, botId, isGeneratedMedia) {
  const current = [...message.attachments.values()];
  const attachments = current.length ? current : [...(reference?.attachments.values() ?? [])];
  if (attachments.some(a => !/^image\/(png|jpeg|webp|gif)$/.test(a.contentType ?? '') || a.size > 20 * 1024 * 1024)) {
    throw new Error('Please use PNG, JPEG, WebP, or GIF images under 20 MB.');
  }
  let images = attachments.map(a => a.url);
  if (!current.length && !images.length && reference?.author?.id === botId) {
    images = (reference.embeds ?? []).map(embed => embed.image?.url)
      .filter(url => typeof url === 'string' && isGeneratedMedia?.('image', url));
  }
  images = [...new Set(images)];
  if (!fullModeActive() && images.length > 5) throw new Error('Please use at most five reference images.');
  return images;
}
