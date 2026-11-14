import { AttachmentBuilder, MessageFlags } from 'discord.js';
import { stripEmojis, limitReplyLength } from './reply-style.js';

const mentions = { parse: [], repliedUser: false };

// Keep the existing reply helpers, but render finished messages as plain text.
export function card(_title, description, { fields = [] } = {}) {
  const original = [description, ...fields.map(field => `${field.name}\n${field.value}`)]
    .filter(Boolean).join('\n\n');
  const content = stripEmojis(original) || (original.trim() ? 'I couldn’t produce a text reply. Please try again.' : '');
  if (content.length <= 2000) return { content, embeds: [], allowedMentions: mentions };
  return { content: 'That’s a bit long for one message, so I’ve attached the full reply below.', embeds: [], allowedMentions: mentions,
    files: [new AttachmentBuilder(Buffer.from(content), { name: 'owaua-answer.md' })] };
}

export function answerCard(text, { fullMode = false } = {}) {
  const content = limitReplyLength(stripEmojis(text), { fullMode }) || (text.trim() ? 'I couldn’t produce a text reply. Please try again.' : '');
  return { ...card('', content), flags: MessageFlags.SuppressEmbeds };
}

export function helpCard(musicHelp) {
  const quickStart = [
    'Hey, I’m Owaua. Here’s how to get started. Use `.ask Hi` to try a dot command. Private dot command results arrive by DM.',
    '**Chat with me**\nUse `/ask`, @ me, reply to me, or send a DM. Send a question, image, PDF, or code file. I can look things up on the web and X too.',
    '**Make something**\nAsk for an image or video, or send one and tell me what to change. I’ll show you the prompt and settings to confirm before generating. Check `/jobs` for recent results.',
    '**Talk or play music**\n`/voice join` lets us talk; `/voice leave` ends it. `/speak` reads text aloud, and `/transcribe` turns a recording into text. For music, join a voice channel and try `.music <song name>`. Use `.music help` for controls.',
    '**Make it yours**\n`.language Hungarian` sets your reply language; `.language auto` lets me match your message. `/persona set description:...` changes how I talk to you. `.full on` is owner-only and bypasses bot usage and execution caps; `.full off` restores normal limits. These settings follow you across servers and DMs.',
    '**Memory and files**\n`/memory view` shows what I’ve saved here. `/memory pause` pauses memory; `/reset` clears your history and notes here. `/knowledge add` saves a document for later; `/ask library:true` uses it.',
    '**Usage limits**\n`/usage` privately shows your remaining requests, voice sessions and media allowance. Daily limits reset at midnight Budapest time; request and burst limits are shared across channels.',
    '**Server and personal tools**\nTry `/remind`, `/poll`, `/afk`, or `/userinfo`. The attached guide lists moderation, community, and notification commands.',
    'Regular chat sends messages, recalled context, and attachments to xAI. When you use `/jiki`, Jiki on Modal receives your current text prompt. The attached guide has more settings and privacy details.',
  ].join('\n\n');
  const guide = [
    '# A little more about Owaua',
    '## Dot commands\nChat commands also work with a dot, without mentioning me: .ask What time is it?; .speak Hello voice:eve; .voice join; .persona set description:"Talk like a pirate"; .memory remember key:hobby text:"I like hiking"; .knowledge add (attach a document); .transcribe (attach audio); .jobs; .usage; .integrations; .reset; .help. Use the same subcommands and option:value names as slash commands. Quote values containing option-like text. Attach files directly to the command message; filename or attachment number selects a file when needed. Private results go to your DMs and still refer to the server/channel where you ran the command. Your command message stays visible there; use slash commands for private input. Enable DMs to receive private results.',
    '## Chat and search\nAsk naturally with /ask, a mention, a reply, or a DM. I can search the web and X, work through calculations with sandboxed Python, read images, and help with PDFs, text, or code. The /ask options let you adjust reasoning, filter websites or X handles and dates, and turn on visual search.',
    '## Jiki\nUse /jiki prompt:... or .jiki followed by your question for a separate text reply from Jiki on Modal. Jiki receives your current text prompt, up to 2,000 characters. Chat history, attachments, and tools are unavailable in this command.',
    '## Images and videos\nTell me what you want to make and any size, quality, count, or length you have in mind. If you leave those out, I use one medium-quality 1K image or a six-second 720p video. You can send up to five reference images, animate an image, or send/reply to an MP4 to edit or extend it. You’ll review the final prompt and settings before a paid request starts.\n\nEach person gets 2 images and 1 video a day across servers and DMs. Each server gets 5 images and 3 videos a day. Limits reset at midnight Budapest time; the bot owner is exempt. /jobs shows your recent results here and checks saved video jobs after a restart. Download anything you want to keep before the links expire.',
    '## Voice\n/transcribe turns a recording into text. /speak reads text aloud, and /ask spoken:true adds an MP3 of my answer. /voice join starts a conversation for up to ten minutes. I listen only to the person who started it, but everyone in the channel can hear my replies. Use /voice leave to stop, and stop music before starting a voice conversation.',
    `## Music\n${musicHelp}`,
    '## Server and personal tools\nUse /remind with a delay like 30m or a date with its time zone offset. Add repeat:1d for an interval. /reminders list and /reminders remove manage your DMs. Moderators can use /reminders schedule, /reminders scheduled, and /reminders cancel for channel posts.',
    'Use /poll with answers separated by the | character. Select Buttons for single-choice voting with buttons or /vote. Discord polls also support multiple answers. /afk set marks you away until you message the server again.',
    '/userinfo, /serverinfo, /roleinfo and /avatar show Discord details. /purge, /warn, /timeout, /ban and /modhistory are for moderators. /timestamp, /color, /qr, /json and /hash run locally.',
    'Server staff can configure /roles create, /welcome setup, /starboard setup and /ticket setup. Use /github watch for public repository updates, /feed add for RSS or Atom, and /monitor add for downtime and recovery notices.',
    '## Your language and style\nTry .language Hungarian or /language name:Hungarian. Use .language list to see supported languages, or .language auto to have me match your message again. Your choice follows you across servers and DMs, including new voice sessions. Some languages work better than others.\n\n/persona set description:... lets you describe how you’d like me to talk in up to 120 characters. It applies only to you, across servers and DMs. /persona view shows your choice privately; /persona reset brings back my usual style. Language and style choices still follow the same safety rules.\n\nChat replies default to 600 characters. Only the bot owner can use .full on or /full mode:on to bypass bot quotas, cooldowns, shared concurrency caps, chat/output/tool budgets and request deadlines. Use .full off to restore normal limits, and .full to view the setting. The choice is saved for you across servers, DMs and restarts. In full mode, answers over Discord’s message limit arrive as complete Markdown files. Discord/provider limits, safety checks, file/stream protections and data-protection locks still apply; requested file exports and JSON downloads stay intact in either mode.',
    '## Saved documents and downloads\n/knowledge add saves a document at xAI for later questions. /knowledge list shows your private library here; /ask library:true lets me use it. Files stay at xAI until you remove them with /knowledge forget or /knowledge clear. Library commands are private, but /ask answers in a server are visible in the channel.\n\nYou can also ask for downloadable data or charts. /ask output:json gives you a JSON file and can check it against a schema. /integrations lists the read-only connections you can choose with /ask integrations:... .',
    '## What I remember\nI use recent context, look back through older conversations, and save useful facts you tell me. Your memories stay separate from other people’s and other channels. /memory view shows your notes privately; /memory remember saves or updates one; /memory forget removes one.\n\n/memory pause stops me reading and saving context here until /memory resume. /reset, !reset, or /memory clear erases your history, archive, and notes here. By default, conversation history is kept for up to 180 days and 1,000 exchanges; saved notes stay until you delete them. For regular chat, your messages, recalled context, and attachments are sent to xAI so I can answer.',
  ].join('\n\n');
  return { ...card('', quickStart), files: [new AttachmentBuilder(Buffer.from(guide), { name: 'owaua-guide.md' })] };
}

export function clock(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function trackCard(track) {
  return card('', `Now playing: **${track.title}** (${clock(track.duration)})\n${track.url}`);
}
