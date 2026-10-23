import { AttachmentBuilder, MessageFlags } from 'discord.js';

const mentions = { parse: [], repliedUser: false };

// Keep the existing reply helpers, but render finished messages as plain text.
// Explicitly clear embeds when replacing the loading bar in the same message.
export function card(_title, description, { fields = [] } = {}) {
  const content = [description, ...fields.map(field => `${field.name}\n${field.value}`)]
    .filter(Boolean).join('\n\n');
  if (content.length <= 2000) return { content, embeds: [], allowedMentions: mentions };
  return { content: 'That’s a bit long for one message, so I’ve attached the full reply below.', embeds: [], allowedMentions: mentions,
    files: [new AttachmentBuilder(Buffer.from(content), { name: 'kirmy-answer.md' })] };
}

export function answerCard(text) {
  return { ...card('', text), flags: MessageFlags.SuppressEmbeds };
}

export function helpCard(musicHelp) {
  const quickStart = [
    'Hey, I’m Kirmy. Here’s how to get started. Every slash command also works with `.` (for example `.ask Hi`). Private command results arrive by DM.',
    '**Chat with me**\nUse `/ask`, @ me, reply to me, or send a DM. Send a question, image, PDF, or code file. I can look things up on the web and X too.',
    '**Make something**\nAsk for an image or video, or send one and tell me what to change. I’ll show you the prompt and settings to confirm before generating. Check `/jobs` for recent results.',
    '**Talk or play music**\n`/voice join` lets us talk; `/voice leave` ends it. `/speak` reads text aloud, and `/transcribe` turns a recording into text. For music, join a voice channel and try `.music <song name>`. Use `.music help` for controls.',
    '**Make it yours**\n`.language Hungarian` sets your reply language; `.language auto` lets me match your message. `/persona set description:...` changes how I talk to you. Both follow you across servers and DMs.',
    '**Memory and files**\n`/memory view` shows what I’ve saved here. `/memory pause` pauses memory; `/reset` clears your history and notes here. `/knowledge add` saves a document for later; `/ask library:true` uses it.',
    'Daily limits: 2 images and 1 video per person; 5 images and 3 videos per server. They reset at midnight Budapest time. The bot owner is exempt.',
    'Messages, recalled context, and attachments go to xAI. The attached guide has more settings and privacy details.',
  ].join('\n\n');
  const guide = [
    '# A little more about Kirmy',
    '## Dot commands\nEvery slash command also works with a dot, without mentioning me: .ask What time is it?; .speak Hello voice:eve; .voice join; .persona set description:"Talk like a pirate"; .memory remember key:hobby text:"I like hiking"; .knowledge add (attach a document); .transcribe (attach audio); .jobs; .usage; .integrations; .reset; .help. Use the same subcommands and option:value names as slash commands. Quote values containing option-like text. Attach files directly to the command message; filename or attachment number selects a file when needed. Private results go to your DMs and still refer to the server/channel where you ran the command. Your command message stays visible there; use slash commands for private input. Enable DMs to receive private results.',
    '## Chat and search\nAsk naturally with /ask, a mention, a reply, or a DM. I can search the web and X, work through calculations with sandboxed Python, read images, and help with PDFs, text, or code. The /ask options let you adjust reasoning, filter websites or X handles and dates, and turn on visual search.',
    '## Images and videos\nTell me what you want to make and any size, quality, count, or length you have in mind. If you leave those out, I use one medium-quality 1K image or a six-second 720p video. You can send up to five reference images, animate an image, or send/reply to an MP4 to edit or extend it. You’ll review the final prompt and settings before a paid request starts.\n\nEach person gets 2 images and 1 video a day across servers and DMs. Each server gets 5 images and 3 videos a day. Limits reset at midnight Budapest time; the bot owner is exempt. /jobs shows your recent results here and checks saved video jobs after a restart. Download anything you want to keep before the links expire.',
    '## Voice\n/transcribe turns a recording into text. /speak reads text aloud, and /ask spoken:true adds an MP3 of my answer. /voice join starts a conversation for up to ten minutes. I listen only to the person who started it, but everyone in the channel can hear my replies. Use /voice leave to stop, and stop music before starting a voice conversation.',
    `## Music\n${musicHelp}`,
    '## Your language and style\nTry .language Hungarian or /language name:Hungarian. Use .language list to see supported languages, or .language auto to have me match your message again. Your choice follows you across servers and DMs, including new voice sessions. Some languages work better than others.\n\n/persona set description:... lets you describe how you’d like me to talk in up to 120 characters. It applies only to you, across servers and DMs. /persona view shows your choice privately; /persona reset brings back my usual style. Language and style choices still follow the same safety rules.',
    '## Saved documents and downloads\n/knowledge add saves a document at xAI for later questions. /knowledge list shows your private library here; /ask library:true lets me use it. Files stay at xAI until you remove them with /knowledge forget or /knowledge clear. Library commands are private, but /ask answers in a server are visible in the channel.\n\nYou can also ask for downloadable data or charts. /ask output:json gives you a JSON file and can check it against a schema. /integrations lists the read-only connections you can choose with /ask integrations:... .',
    '## What I remember\nI use recent context, look back through older conversations, and save useful facts you tell me. Your memories stay separate from other people’s and other channels. /memory view shows your notes privately; /memory remember saves or updates one; /memory forget removes one.\n\n/memory pause stops me reading and saving context here until /memory resume. /reset, !reset, or /memory clear erases your history, archive, and notes here. By default, conversation history is kept for up to 180 days and 1,000 exchanges; saved notes stay until you delete them. Your messages, recalled context, and attachments are sent to xAI so I can answer.',
  ].join('\n\n');
  return { ...card('', quickStart), files: [new AttachmentBuilder(Buffer.from(guide), { name: 'kirmy-guide.md' })] };
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
