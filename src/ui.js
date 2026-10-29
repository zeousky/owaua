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
    'Hey, I’m Owaua. Here’s how to get started. Every slash command also works with `.` (for example `.ask Hi`). Private command results arrive by DM.',
    '**Chat with me**\nUse `/ask`, @ me, reply to me, or send a DM. Send a question, image, PDF, or code file. I can search the web, and X when using xAI.',
    '**Make something**\nAsk for an image or video, or send one and tell me what to change. I’ll show you the prompt and settings to confirm before generating. Check `/jobs` for recent results.',
    '**Talk or play music**\n`/voice join` lets us talk; `/voice leave` ends it. `/speak` reads text aloud, and `/transcribe` turns a recording into text. For music, join a voice channel and try `.music <song name>`. Use `.music help` for controls.',
    '**Make it yours**\n`.language Hungarian` sets your reply language; `.language auto` lets me match your message. `/persona set description:...` changes how I talk to you. `.full on` is owner-only and bypasses bot usage and execution caps; `.full off` restores normal limits. These settings follow you across servers and DMs.',
    '**Memory and files**\n`/memory view` shows what I’ve saved here. `/memory pause` pauses memory; `/reset` clears your history and notes here. `/knowledge add` saves a document for later; `/ask library:true` uses it.',
    '**Usage limits**\n`/usage` privately shows your remaining requests, voice sessions and media allowance. Daily limits reset at midnight Budapest time; request and burst limits are shared across channels.',
    'Chat goes to the selected AI provider. Owner: `.provider` views or switches it. See the attached privacy guide.',
  ].join('\n\n');
  const guide = [
    '# A little more about Owaua',
    '## Dot commands\nEvery slash command also works with a dot, without mentioning me: .ask What time is it?; .speak Hello voice:eve; .voice join; .persona set description:"Talk like a pirate"; .memory remember key:hobby text:"I like hiking"; .knowledge add (attach a document); .transcribe (attach audio); .jobs; .usage; .integrations; .reset; .help. Use the same subcommands and option:value names as slash commands. Quote values containing option-like text. Attach files directly to the command message; filename or attachment number selects a file when needed. Private results go to your DMs and still refer to the server/channel where you ran the command. Your command message stays visible there; use slash commands for private input. Enable DMs to receive private results.',
    '## Chat and search\nAsk naturally with /ask, a mention, a reply, or a DM. I can search the web and X, work through calculations with sandboxed Python, read images, and help with PDFs, text, or code. The /ask options let you adjust reasoning, filter websites or X handles and dates, and turn on visual search. Available tools depend on the selected provider.',
    '## AI providers\nOnly the bot owner can use .provider or /provider to view the active provider. .provider xai selects xAI; .provider mistral selects Mistral Large 4; .provider switch toggles them. The choice applies to this server, or your own DMs, and survives restarts. A confirmed insufficient-balance error selects the other configured provider only for the affected server. After that error, one shared watcher sends a tiny hello to the failed provider after five minutes, backing off to hourly checks if it remains unavailable. A successful check restores servers still on automatic fallback and stops checking. Manual changes are preserved; healthy providers are not polled. A failed request is retried only when it cannot repeat a tool action. If both providers are out of credit, the request stops. Other errors do not trigger a provider switch. Mistral chat supports web search, code execution, images and documents, new image generation, speech and transcription. Image edits, videos, real-time voice and the existing saved-document library use xAI. Messages and recalled context go to the selected provider; these dedicated xAI services also receive their inputs. The owner can list the complete Mistral API operation catalog with .mistral operations, then call an operation with its JSON payload and an optional attachment.',
    '## Images and videos\nTell me what you want to make and any size, quality, count, or length you have in mind. If you leave those out, I use one medium-quality 1K image or a six-second 720p video. You can send up to five reference images, animate an image, or send/reply to an MP4 to edit or extend it. You’ll review the final prompt and settings before a paid request starts.\n\nEach person gets 2 images and 1 video a day across servers and DMs. Each server gets 5 images and 3 videos a day. Limits reset at midnight Budapest time; the bot owner is exempt. /jobs shows your recent results here and checks saved video jobs after a restart. Download anything you want to keep before the links expire.',
    '## Voice\n/transcribe turns a recording into text. /speak reads text aloud, and /ask spoken:true adds an MP3 of my answer. /voice join starts a conversation for up to ten minutes. I listen only to the person who started it, but everyone in the channel can hear my replies. Use /voice leave to stop, and stop music before starting a voice conversation.',
    `## Music\n${musicHelp}`,
    '## Your language and style\nTry .language Hungarian or /language name:Hungarian. Use .language list to see supported languages, or .language auto to have me match your message again. Your choice follows you across servers and DMs, including new voice sessions. Some languages work better than others.\n\n/persona set description:... lets you describe how you’d like me to talk in up to 120 characters. It applies only to you, across servers and DMs. /persona view shows your choice privately; /persona reset brings back my usual style. Language and style choices still follow the same safety rules.\n\nChat replies default to 600 characters. Only the bot owner can use .full on or /full mode:on to bypass bot quotas, cooldowns, shared concurrency caps, chat/output/tool budgets and request deadlines. Use .full off to restore normal limits, and .full to view the setting. The choice is saved for you across servers, DMs and restarts. In full mode, answers over Discord’s message limit arrive as complete Markdown files. Discord/provider limits, safety checks, file/stream protections and data-protection locks still apply; requested file exports and JSON downloads stay intact in either mode.',
    '## Saved documents and downloads\n/knowledge add saves a document at xAI for later questions. /knowledge list shows your private library here; /ask library:true lets me use it. Files stay at xAI until you remove them with /knowledge forget or /knowledge clear. Library commands are private, but /ask answers in a server are visible in the channel.\n\nYou can also ask for downloadable data or charts. /ask output:json gives you a JSON file and can check it against a schema. /integrations lists the read-only connections you can choose with /ask integrations:... .',
    '## What I remember\nI use recent context, look back through older conversations, and save useful facts you tell me. Your memories stay separate from other people’s and other channels. /memory view shows your notes privately; /memory remember saves or updates one; /memory forget removes one.\n\n/memory pause stops me reading and saving context here until /memory resume. /reset, !reset, or /memory clear erases your history, archive, and notes here. By default, conversation history is kept for up to 180 days and 1,000 exchanges; saved notes stay until you delete them. Your messages and recalled context are sent to the selected AI provider so I can answer; attachments may also use dedicated file, media or voice services.',
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
