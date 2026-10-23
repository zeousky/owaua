import { card } from './ui.js';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from './ai.js';
import { assertSafeText } from './safety.js';

export function mediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid media URL');
  return url.href;
}

export class MediaInputError extends Error {}

const imageRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2',
  '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2', 'auto'];
const videoRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'];
const videoModels = { lite: 'grok-imagine-video-1.5-lite', standard: 'grok-imagine-video-1.5',
  classic: 'grok-imagine-video' };

function choice(value, values, message) {
  if (!values.includes(value)) throw new MediaInputError(message);
  return value;
}
function integer(value, min, max, message) {
  if (!Number.isInteger(value) || value < min || value > max) throw new MediaInputError(message);
  return value;
}
function validOptions(options, allowed) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some(key => !allowed.includes(key))) {
    throw new MediaInputError('That option is not supported for this media request.');
  }
}

export class MediaGenerator {
  constructor({ apiKey, timeoutMs = 600000, fetchImpl = fetch, pollIntervalMs = 5000,
    sleep = delay, authorize } = {}) {
    Object.assign(this, { apiKey, timeoutMs, fetchImpl, pollIntervalMs, sleep, authorize });
  }
  async generate(kind, prompt, { images = [], videos = [], options = {}, signal: callerSignal,
    authorize = this.authorize, onSubmitting, onSubmitted, onCompleted } = {}) {
    if (!['image', 'video', 'edit_image', 'edit_video', 'extend_video'].includes(kind) || typeof prompt !== 'string' ||
      !prompt.trim() || prompt.length > 6000) throw new Error('Invalid generation request');
    assertSafeText(prompt, { instructions: true, secrets: [this.apiKey] });
    if (!Array.isArray(images) || images.length > 5) throw new MediaInputError('Please use at most five reference images.');
    if (!Array.isArray(videos) || videos.length > 1) throw new MediaInputError('Please use one source video per request.');
    const references = images.map(mediaUrl);
    if (kind === 'edit_image' && !references.length) {
      throw new MediaInputError('Attach an image or reply to a message containing one, and tell me what to change.');
    }
    if (references.some(url => /\.gif$/i.test(new URL(url).pathname))) {
      throw new MediaInputError('For image editing or animation, please attach a PNG, JPEG, or WebP image instead of a GIF.');
    }
    let path;
    let body;
    if (kind === 'image' || kind === 'edit_image') {
      validOptions(options, ['count', 'quality', 'resolution', 'aspect_ratio']);
      if (videos.length) throw new MediaInputError('Image creation uses image references. To change a video, ask me to edit or extend it.');
      const sources = references.map(url => ({ url, type: 'image_url' }));
      if (sources.length === 1 && options.aspect_ratio !== undefined) {
        throw new MediaInputError('Single-image editing keeps the source image aspect ratio. Omit the ratio or attach a source cropped to the shape you want.');
      }
      path = sources.length ? 'images/edits' : 'images/generations';
      body = { model: 'grok-imagine-image-2.0', prompt,
        n: integer(options.count ?? 1, 1, 10, 'Please request between one and ten images.'),
        quality: choice(options.quality ?? 'medium', ['low', 'medium', 'auto'], 'Image quality must be low, medium, or auto.'),
        resolution: choice(options.resolution ?? '1k', ['1k', '2k'], 'Image resolution must be 1k or 2k.'),
        response_format: 'url',
        ...(options.aspect_ratio === undefined ? {} : { aspect_ratio: choice(options.aspect_ratio, imageRatios, 'Unsupported image aspect ratio.') }),
        ...(sources.length === 1 ? { image: sources[0] } : sources.length ? { images: sources } : {}),
      };
    } else if (kind === 'edit_video' || kind === 'extend_video') {
      validOptions(options, kind === 'extend_video' ? ['duration'] : []);
      if (videos.length !== 1) throw new MediaInputError('Attach one MP4 video or reply to a message containing one.');
      if (references.length) throw new MediaInputError('Video editing and extension use one source video, without image references.');
      const source = typeof videos[0] === 'string' ? { url: videos[0] } : videos[0];
      const url = mediaUrl(source?.url);
      if (!/\.mp4$/i.test(new URL(url).pathname)) throw new MediaInputError('Please use an MP4 source video.');
      if (source.duration !== undefined && (!Number.isFinite(source.duration) || source.duration <= 0 ||
        (kind === 'edit_video' ? source.duration > 8.7 : source.duration < 2 || source.duration > 15))) {
        throw new MediaInputError(kind === 'edit_video' ? 'Video editing supports clips up to 8.7 seconds.'
          : 'Video extension needs a source clip between 2 and 15 seconds.');
      }
      path = kind === 'edit_video' ? 'videos/edits' : 'videos/extensions';
      body = { model: videoModels.classic, prompt, video: { url },
        ...(kind === 'extend_video' ? { duration: integer(options.duration ?? 6, 2, 10,
          'Please extend the video by between two and ten seconds.') } : {}),
      };
    } else {
      validOptions(options, ['model', 'duration', 'resolution', 'aspect_ratio', 'reference_mode']);
      if (videos.length) throw new MediaInputError('To use a source video, ask me to edit or extend it.');
      const mode = choice(options.reference_mode ?? (references.length > 1 ? 'reference' : 'animate'),
        ['animate', 'reference'], 'Video reference mode must be animate or reference.');
      if (mode === 'animate' && references.length > 1) throw new MediaInputError('Animating a first frame uses one image. Use reference mode to include multiple images.');
      if (mode === 'reference' && !references.length) throw new MediaInputError('Reference-to-video needs at least one image.');
      const selected = options.model ?? (mode === 'reference' ? 'standard' : 'lite');
      const model = videoModels[selected] ?? selected;
      choice(model, Object.values(videoModels), 'Unsupported video model.');
      if (mode === 'reference' && model === videoModels.lite) throw new MediaInputError('Reference-to-video needs the standard or classic model.');
      const duration = integer(options.duration ?? 6, 1, mode === 'reference' && model === videoModels.classic ? 10 : 15,
        mode === 'reference' && model === videoModels.classic ? 'Classic reference videos support one to ten seconds.' : 'Video duration must be between one and fifteen seconds.');
      const resolution = choice(options.resolution ?? '720p', ['480p', '720p', '1080p'], 'Video resolution must be 480p, 720p, or 1080p.');
      if (resolution === '1080p' && (mode === 'reference' || model === videoModels.classic)) {
        throw new MediaInputError('Reference and classic video modes support up to 720p.');
      }
      if (options.aspect_ratio !== undefined && mode === 'animate' && references.length) {
        throw new MediaInputError('Image animation keeps the source image aspect ratio. Use reference mode to choose another ratio.');
      }
      const ratio = choice(options.aspect_ratio ?? '16:9', videoRatios, 'Unsupported video aspect ratio.');
      path = 'videos/generations';
      body = { model, prompt, duration, resolution,
        ...(mode === 'animate' && references.length ? { image: { url: references[0], type: 'image_url' } }
          : { aspect_ratio: ratio, ...(references.length ? { reference_images: references.map(url => ({ url })) } : {}) }),
      };
    }
    // The host authorizes the final validated payload before reserving budget.
    callerSignal?.throwIfAborted();
    if (authorize !== undefined && (typeof authorize !== 'function' ||
      await authorize({ kind, path, body: structuredClone(body) }) !== true)) {
      throw new MediaInputError('Media generation was cancelled or not confirmed. No media request was submitted.');
    }
    callerSignal?.throwIfAborted();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
    const request = (path, body) => this.request(path, body, signal);
    onSubmitting?.();
    if (kind === 'image' || kind === 'edit_image') {
      const result = await request(path, body);
      if (!Array.isArray(result.data) || !result.data.length || result.data.length > body.n ||
        result.data.some(image => !image.url || image.respect_moderation === false)) throw new ProviderError(502, 'image_unavailable');
      const urls = result.data.map(image => mediaUrl(image.url));
      const media = { kind: 'image', url: urls[0], urls, model: result.model ?? body.model, usage: result.usage };
      onCompleted?.(media);
      return media;
    }
    const job = await request(path, body);
    if (typeof job.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(job.request_id)) {
      throw new ProviderError(502, 'invalid_video_job');
    }
    // Persist the ID synchronously before the first GET or any other await.
    onSubmitted?.(job.request_id);
    for (;;) {
      const result = await this.checkVideo(job.request_id, { model: body.model, signal, timeoutMs: null });
      if (result) { onCompleted?.(result); return result; }
      await this.sleep(this.pollIntervalMs, undefined, { signal });
    }
  }
  async request(path, body, signal) {
    signal?.throwIfAborted();
    const response = await this.fetchImpl(`https://api.x.ai/v1/${path}`, {
      method: body ? 'POST' : 'GET', signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new ProviderError(response.status, 'media_provider_error');
    const result = await response.json();
    if (result.error) throw new ProviderError(502, 'media_generation_failed');
    return result;
  }
  async checkVideo(requestId, { model, signal: callerSignal, timeoutMs = 15000 } = {}) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) throw new Error('Invalid video job');
    const timeout = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
    const signal = timeout ? (callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout) : callerSignal;
    const result = await this.request(`videos/${requestId}`, undefined, signal);
    if (result.status === 'done') {
      if (!result.video?.url || result.video.respect_moderation === false) throw new ProviderError(502, 'video_unavailable');
      return { kind: 'video', url: mediaUrl(result.video.url), model: result.model ?? model,
        usage: result.usage, requestId };
    }
    if (result.status !== 'pending') throw new ProviderError(502, 'video_generation_failed');
    return null;
  }
}

export function mediaReply(media) {
  const url = mediaUrl(media.url);
  // Only the generated image itself needs an embed, with no labels or footer.
  return media.kind === 'image'
    ? { ...card('', ''), embeds: (media.urls ?? [url]).map(value => ({ image: { url: mediaUrl(value) } })) }
    : card('', url);
}
