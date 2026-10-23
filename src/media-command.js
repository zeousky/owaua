import { card } from './ui.js';
import { MEDIA_OWNER, MEDIA_LIMITS } from './media-store.js';

export const jobsCommand = { name: 'jobs', description: 'Find your recent images and videos here (only you can see them)' };
export const usageCommand = { name: 'usage', description: 'Check today’s image and video usage (bot owner only)', options: [
  { type: 6, name: 'user', description: 'Filter to one user' },
  { type: 3, name: 'server', description: 'Filter to a server ID', min_length: 17, max_length: 20 },
] };

const states = { reserved: 'getting ready', submitting: 'sending to xAI', pending: 'still working',
  completed: 'ready', failed: 'didn’t finish', unknown: 'couldn’t confirm submission' };
const mediaCount = (kind, count) => `${count} ${kind}${count === 1 ? '' : 's'}`;
const dateLabel = value => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Budapest', day: 'numeric', month: 'short', year: 'numeric',
}).format(new Date(value));

export async function handleMediaCommand(interaction, store) {
  if (interaction.commandName === 'usage') {
    if (interaction.user.id !== MEDIA_OWNER) return interaction.reply({ ...card('', 'Only the bot owner can use /usage.'), flags: 64 });
    const userId = interaction.options.getUser('user')?.id;
    const guildId = interaction.options.getString('server') ?? undefined;
    if (guildId && !/^\d{17,20}$/.test(guildId)) return interaction.reply({ ...card('', 'Please use a valid server ID.'), flags: 64 });
    const { day, rows } = store.usage({ userId, guildId });
    const totals = rows.map(row => `• ${mediaCount(row.kind, row.units)} — ${states[row.state] ?? 'status unavailable'}${row.exempt ? ' (owner request, doesn’t use the allowance)' : ''}`);
    return interaction.reply({ ...card('', [
      `**Images & videos · ${dateLabel(`${day}T12:00:00Z`)}**${userId ? `\nFor user ${userId}` : ''}${guildId ? `\nIn server ${guildId}` : ''}`,
      totals.join('\n') || `No images or videos requested today${userId || guildId ? ' for this selection' : ''}.`,
      `Each person gets ${MEDIA_LIMITS.user.image} images and ${MEDIA_LIMITS.user.video} video a day, shared across servers and DMs. Each server gets ${MEDIA_LIMITS.server.image} images and ${MEDIA_LIMITS.server.video} videos. Everything resets at midnight Budapest time; the bot owner doesn’t use up these allowances.`,
      'Requests use up the allowance while they’re running, even if they later fail or we lose track of the result. If xAI rejects a request before accepting it, that allowance is returned.',
      'These counts cover images and videos only. They don’t show money spent or chat and voice usage.',
    ].join('\n\n')), flags: 64 });
  }
  const jobs = store.jobs(interaction.user.id, interaction.guildId);
  const lines = jobs.map(job => {
    const result = job.result ? JSON.parse(job.result) : null;
    return `**${job.kind === 'image' ? 'Image' : 'Video'} · ${dateLabel(job.created_at)} · ${states[job.state] ?? 'status unavailable'}**\n${result ? (result.urls ?? [result.url]).join('\n') : job.state === 'pending' ? 'I’m still checking on this one. No need to request it again.' : job.state === 'unknown' ? 'I couldn’t confirm whether xAI accepted this one. I won’t send it again automatically; a retry is a new paid request.' : 'There’s no finished result to download for this one.'}`;
  });
  const content = `${lines.join('\n\n') || 'You haven’t requested any images or videos here recently.'}\n\nThese are just your requests in this server or DM. Download anything you want to keep before the links expire.`;
  return interaction.reply({ ...card('', content), flags: 64 });
}
