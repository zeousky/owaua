import { MediaInputError } from './media.js';

export class MediaService {
  constructor({ media, store, confirm }) { Object.assign(this, { media, store, confirm }); this.active = new Set(); }
  async generate(kind, prompt, { userId, guildId, send, signal, ...options }) {
    let id, posted = false, accepted = false;
    try {
      return await this.media.generate(kind, prompt, { ...options, signal,
        authorize: async proposal => {
          // Every paid action needs a fresh actor-bound button approval of the
          // final payload, including actions proposed from untrusted content.
          if (await this.confirm({ userId, send, proposal, signal }) !== true) return false;
          signal?.throwIfAborted();
          id = this.store.reserve({ userId, guildId, kind: kind.includes('image') ? 'image' : 'video',
            units: proposal.body.n ?? 1, model: proposal.body.model });
          this.active.add(id);
          return true;
        },
        onSubmitting: () => { this.store.submitting(id); posted = true; },
        onSubmitted: requestId => { accepted = true; this.store.submitted(id, requestId); },
        onCompleted: result => this.store.complete(id, result),
      });
    } catch (error) {
      if (id) {
        if (!posted || (!accepted && error.code === 'media_provider_error' && [400,401,403,404,422,429].includes(error.status))) this.store.release(id);
        else if (['video_generation_failed','video_unavailable'].includes(error.code)) this.store.fail(id);
        else this.store.uncertain(id);
      }
      if (id && posted && !['video_generation_failed','video_unavailable','media_provider_error'].includes(error.code)) {
        throw new MediaInputError('I lost track of that request after sending it. Check /jobs before trying again — I’ll keep checking videos that have a saved job ID. A retry starts a new paid request.');
      }
      throw error;
    } finally { this.active.delete(id); }
  }
  async resume({ signal } = {}) {
    for (const job of this.store.pending()) {
      if (signal?.aborted) break;
      if (this.active.has(job.id)) continue;
      this.active.add(job.id);
      try {
        const result = await this.media.checkVideo(job.request_id, { model: job.model, signal });
        if (result) this.store.complete(job.id, result);
      } catch (error) {
        if (['video_generation_failed', 'video_unavailable'].includes(error.code) ||
          (error.code === 'media_provider_error' && [404,410].includes(error.status))) this.store.fail(job.id);
        // Transport errors, rate limits and restarts leave the job recoverable.
      } finally { this.active.delete(job.id); }
    }
  }
}
