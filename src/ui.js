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
  return card('A little of everything.', 'Ask a question. Create something. Put a song on.', {
    section: 'Kirmy / Guide', fields: [
      { name: 'Conversation', value: 'Use `/ask`, mention me, reply to me, or send a DM. I can search the web and X, calculate with sandboxed Python, and understand attached images.' },
      { name: 'Create & edit', value: 'Ask for an image or a video. Attach an image or reply to one and describe your changes. Images use medium quality; videos are six seconds at 720p. I can animate your first reference image. Save generated media before its link expires.' },
      { name: 'Music', value: musicHelp },
      { name: 'Your persona', value: '`/persona set description:...` sets your default persona (up to 120 characters). I use it automatically only for you, across servers and DMs. `/persona view` shows it privately; `/persona reset` restores Kirmy’s usual persona. Safety rules still apply.' },
      { name: 'Your memory', value: 'I keep recent context, search older conversations, and save important facts you tell me. Memory stays scoped to your user and channel. `/memory view` shows saved notes privately; `/memory remember` saves or corrects a note; `/memory forget` deletes one. `/memory pause` stops reading and saving context until `/memory resume`. `/reset`, `!reset`, or `/memory clear` erases your history, archive, and notes here. Conversations default to 180 days / 1,000 exchanges; notes stay until deleted. Prompts, recalled context, and attachments are sent to xAI.' },
    ], footer: 'Kirmy · Conversation / Creativity / Music',
  });
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
