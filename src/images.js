// Current attachments take priority over images in the replied-to message.
export function requestImages(message, reference, botId) {
  const current = [...message.attachments.values()];
  const attachments = current.length ? current : [...(reference?.attachments.values() ?? [])];
  if (attachments.some(a => !/^image\/(png|jpeg|webp|gif)$/.test(a.contentType ?? '') || a.size > 20 * 1024 * 1024)) {
    throw new Error('Please use PNG, JPEG, WebP, or GIF images under 20 MB.');
  }
  let images = attachments.map(a => a.url);
  // Only trust image embeds from this bot, not arbitrary third-party link previews.
  if (!current.length && !images.length && reference?.author.id === botId) {
    images = (reference.embeds ?? []).map(embed => embed.image?.url).filter(Boolean);
  }
  images = [...new Set(images)];
  if (images.length > 4) throw new Error('Please use at most four reference images.');
  return images;
}
