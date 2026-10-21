import { card } from './ui.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from './ai.js';

export function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid media URL');
  return url.href;
}

export class MediaInputError extends Error {}

export class MediaGenerator {
  constructor({ apiKey, timeoutMs = 600000, fetchImpl = fetch, pollIntervalMs = 5000,
    sleep = delay } = {}) {
    Object.assign(this, { apiKey, timeoutMs, fetchImpl, pollIntervalMs, sleep });
  }
  async generate(kind, prompt, { images = [], signal: callerSignal } = {}) {
    if (!['image', 'video', 'edit_image'].includes(kind) || typeof prompt !== 'string' ||
      !prompt.trim() || prompt.length > 6000) throw new Error('Invalid generation request');
    if (!Array.isArray(images) || images.length > 4) throw new MediaInputError('Please use at most four reference images.');
    const references = images.map(mediaUrl);
    if (kind === 'edit_image' && !references.length) {
      throw new MediaInputError('Attach an image or reply to a message containing one, and tell me what to change.');
    }
    if (references.some(url => /\.gif$/i.test(new URL(url).pathname))) {
      throw new MediaInputError('For image editing or animation, please attach a PNG, JPEG, or WebP image instead of a GIF.');
    }
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    const request = async (path, body) => {
      signal.throwIfAborted();
      const response = await this.fetchImpl(`https://api.x.ai/v1/${path}`, {
        method: body ? 'POST' : 'GET', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new ProviderError(response.status, 'media_provider_error');
      const result = await response.json();
      if (result.error) throw new ProviderError(502, 'media_generation_failed');
      return result;
    };
    if (kind === 'image' || kind === 'edit_image') {
      const sources = references.map(url => ({ url, type: 'image_url' }));
      const result = await request(sources.length ? 'images/edits' : 'images/generations', {
        model: 'grok-imagine-image-2.0', prompt, n: 1,
        quality: 'medium', resolution: '1k', response_format: 'url',
        ...(sources.length === 1 ? { image: sources[0] } : sources.length ? { images: sources } : {}),
      });
      if (!result.data?.[0]?.url) throw new ProviderError(502, 'image_unavailable');
      return { kind: 'image', url: mediaUrl(result.data[0].url), model: 'grok-imagine-image-2.0' };
    }
    const job = await request('videos/generations', {
      model: 'grok-imagine-video-1.5-lite', prompt, duration: 6,
      resolution: '720p', aspect_ratio: '16:9',
      ...(references.length ? { image: { url: references[0], type: 'image_url' } } : {}),
    });
    if (typeof job.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(job.request_id)) {
      throw new ProviderError(502, 'invalid_video_job');
    }
    for (;;) {
      const result = await request(`videos/${job.request_id}`);
      if (result.status === 'done') {
        if (!result.video?.url || result.video.respect_moderation === false) {
          throw new ProviderError(502, 'video_unavailable');
        }
        return { kind, url: mediaUrl(result.video.url), model: 'grok-imagine-video-1.5-lite' };
      }
      if (result.status !== 'pending') throw new ProviderError(502, 'video_generation_failed');
      await this.sleep(this.pollIntervalMs, undefined, { signal });
    }
  }
}

export function mediaReply(media) {
  const url = mediaUrl(media.url);
  // Only the generated image itself needs an embed, with no labels or footer.
  return media.kind === 'image'
    ? { ...card('', ''), embeds: [{ image: { url } }] }
    : card('', url);
}
