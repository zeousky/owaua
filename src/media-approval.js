import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { card } from './ui.js';
import { assertSafeValue } from './safety.js';

const actions = { image: 'Create images', edit_image: 'Edit images', video: 'Create a video',
  edit_video: 'Edit a video', extend_video: 'Extend a video' };

// The caller supplies the authenticated actor and the provider's final payload.
// Neither a model argument nor message text can approve or reconstruct a request.
export async function confirmMedia({ userId, send, proposal, signal, timeoutMs = 60000 }) {
  signal?.throwIfAborted();
  assertSafeValue(proposal, { instructions: true });
  if (!/^\d{17,20}$/.test(userId) || !actions[proposal?.kind]) return false;
  const nonce = randomUUID();
  const yes = `media:${nonce}:yes`, no = `media:${nonce}:no`;
  const body = proposal.body;
  const labels = { model: 'Model', n: 'Images', quality: 'Quality', resolution: 'Resolution',
    duration: proposal.kind === 'extend_video' ? 'Added seconds' : 'Seconds', aspect_ratio: 'Aspect ratio' };
  const settings = Object.fromEntries(Object.entries(labels).filter(([key]) => body[key] !== undefined)
    .map(([key, label]) => [label, body[key]]));
  const sources = [...(body.images ?? body.reference_images ?? []), ...(body.image ? [body.image] : []),
    ...(body.video ? [body.video] : [])].map(source => source.url);
  const note = body.video ? 'Video edits inherit source settings, capped at 720p. Extension seconds are added to the source.'
    : body.image ? 'The aspect ratio comes from the source image.' : 'An unspecified aspect ratio uses the provider default.';
  const review = { action: actions[proposal.kind], prompt: body.prompt, settings, sources, note };
  const message = await send({ ...card('', `Ready to go? **${actions[proposal.kind]}**\n\n${Object.entries(settings).map(([label, value]) => `${label}: ${value}`).join(' · ')}\nUsing ${sources.length} reference ${sources.length === 1 ? 'file' : 'files'}. ${note}\n\nThe attached file has the full prompt, references, and settings. Take a look, then hit “Go ahead” to start this paid xAI request. Only you can approve it. You have ${Math.ceil(timeoutMs / 1000)} seconds to decide.`),
    attachments: [], files: [{ attachment: Buffer.from(JSON.stringify(review, null, 2)), name: 'media-request.json' }],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(yes).setLabel('Go ahead').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(no).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  });
  if (!message?.id || typeof message.createMessageComponentCollector !== 'function') return false;
  const expiresAt = Date.now() + timeoutMs;
  let collector, abort, approved = false;
  try {
    if (signal?.aborted) return false;
    approved = await new Promise(resolve => {
      let claimed = false;
      collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: timeoutMs,
        filter: interaction => interaction.user?.id === userId && interaction.message?.id === message.id &&
          [yes, no].includes(interaction.customId) && !signal?.aborted && Date.now() < expiresAt });
      collector.on('collect', interaction => {
        // Claim synchronously before acknowledging: simultaneous clicks can
        // already be queued by the collector's asynchronous filter machinery.
        if (claimed) return;
        claimed = true;
        collector.stop('selected');
        Promise.resolve().then(() => interaction.deferUpdate()).then(
          () => resolve(interaction.customId === yes && !signal?.aborted && Date.now() < expiresAt),
          () => resolve(false),
        );
      });
      collector.on('end', () => { if (!claimed) { claimed = true; resolve(false); } });
      abort = () => collector.stop('aborted');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    collector?.stop('finished');
    // Failed acknowledgement or removal fails closed before any provider POST.
    await message.edit({ ...card('', approved ? 'Got it — starting your request.' : 'I didn’t start it — you cancelled, or the confirmation timed out.'),
      components: [], attachments: [] });
  }
  return approved && !signal?.aborted && Date.now() < expiresAt;
}
