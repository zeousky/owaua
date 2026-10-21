import { AttachmentBuilder } from 'discord.js';

const mentions = { parse: [], repliedUser: false };

// Keep the existing reply helpers, but render finished messages as plain text.
// Explicitly clear embeds when replacing the loading bar in the same message.
export function card(_title, description, { fields = [] } = {}) {
  const content = [description, ...fields.map(field => `${field.name}\n${field.value}`)]
    .filter(Boolean).join('\n\n');
  if (content.length <= 2000) return { content, embeds: [], allowedMentions: mentions };
  return { content: 'The full response is attached.', embeds: [], allowedMentions: mentions,
    files: [new AttachmentBuilder(Buffer.from(content), { name: 'kirmy-answer.md' })] };
}

export function answerCard(text) {
  return card('', text);
}

export function helpCard(musicHelp) {
  return card('', [
    '**Kirmy help**',
    'Chat in DMs, mention or reply to me, or use `/ask`. I can search the web and X, calculate with sandboxed Python, understand images, and analyze PDF/text/code files. Create or edit images (including up to five references), animate images, generate or edit/extend videos, transcribe recordings, create spoken replies, and talk for up to ten minutes in voice. Make charts, data/code files, and schema-checked JSON; save documents to a private channel library; use read-only integrations; set your own persona; and keep channel-scoped conversation memory. Prompts and attachments are sent to xAI; generated media links can expire.',
    '',
    '**Commands**',
    '`/ask prompt:` — ask, with optional image/file/video/audio, web/X filters, reasoning, visual search, spoken reply, library, integrations, or JSON output.',
    '`/help`, `.help`, or `!help` — show this guide. `.help` works without mentioning me.',
    '`/reset` or `!reset` — clear your history and saved memories in this channel.',
    '`/persona set|view|reset` — choose, view, or reset your personal style.',
    '`/memory view|remember|forget|pause|resume|clear` — manage your channel memory.',
    '`/knowledge add|list|forget|clear` — manage saved documents for this channel.',
    '`/integrations` — list available read-only connections.',
    '`/speak`, `/transcribe`, `/voice join|leave|status|voices` — audio and voice tools.',
    '`.music <song or SoundCloud link>` — play in your voice channel; `.music help|queue|skip|pause|resume|stop|leave` shows help and controls playback.',
    '',
    musicHelp,
  ].join('\n\n'));
}

export function loadingCard(frame = 0, activity = 'thinking') {
  const marker = activity === 'x' ? '×' : activity === 'web' || activity === 'web_x' ? '═' : '━';
  const label = { web: ' WEB', x: ' X', web_x: ' WEB+X' }[activity] ?? '';
  const width = 18 - label.length;
  // Bounce at either end without hiding the slider behind the search label.
  const distance = width - 3;
  const phase = frame % (distance * 2);
  const position = phase <= distance ? phase : distance * 2 - phase;
  const parts = Array.from({ length: width }, (_, i) => i >= position && i < position + 3 ? marker : '─');
  parts.push(...label);
  const bar = parts.join('');
  return { content: `\`${bar}\``, embeds: [], allowedMentions: mentions };
}

// Serialize edits and drain any pending frame before the final result is sent.
// Failed/deleted messages stop animation; they never cancel the underlying work.
export async function animate(send, { intervalMs = 1000, maxMs = 720000 } = {}) {
  const started = Date.now();
  let frame = 0, activity = 'thinking', stopped = false, busy = false, pending = Promise.resolve();
  const message = await send(loadingCard(frame));
  const update = () => {
    if (stopped || Date.now() - started >= maxMs) { clearInterval(timer); return; }
    if (!message?.edit) return;
    // Don't queue animation frames behind a slow Discord request.
    if (busy) return;
    busy = true;
    pending = Promise.resolve().then(() => message.edit(loadingCard(++frame, activity)))
      .catch(() => { stopped = true; clearInterval(timer); }).finally(() => { busy = false; });
  };
  const timer = setInterval(update, intervalMs);
  timer.unref?.();
  return {
    setActivity(next) {
      if (stopped || !['thinking', 'web', 'x', 'web_x'].includes(next) || activity === next) return;
      activity = next;
    },
    async finish(payload) {
      stopped = true; clearInterval(timer); await pending;
      return message?.edit ? message.edit(payload) : send(payload);
    },
    async stop() { stopped = true; clearInterval(timer); await pending; },
  };
}

export function clock(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function trackCard(track) {
  return card('', `Now playing: **${track.title}** (${clock(track.duration)})\n${track.url}`);
}
