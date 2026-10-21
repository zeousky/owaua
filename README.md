# Kirmy

Discord AI core using **Grok 4.7** directly through the official xAI Responses API (`https://api.x.ai/v1/responses`).

## Use

- `.music <song name or SoundCloud track link>` — join your current voice channel and play music, for example `.music go away`. No mention needed. More requests queue up (20 waiting songs per server).
- `.music queue`, `.music skip`, `.music pause`, `.music resume`, `.music stop` (or `leave`) — control playback from the same voice channel.
- `/ask prompt:...` — ask a question, optionally with an image.
- Mention Kirmy with “generate an image of a cat” or “generate a video of a cat” to create media.
- Mention Kirmy, reply to one of its messages, or send it a DM.
- `/memory view` — privately inspect your saved notes and archive count here.
- `/memory remember key:hosting text:...` — save a fact, or correct it by reusing its key.
- `/memory forget id:...` — remove a saved note and its recorded source exchanges.
- `/memory pause` / `/memory resume` — disable / enable reading and saving conversation context here.
- `/reset` or `/memory clear` — erase your history, searchable archive, and saved notes in the current channel.
- `/persona set` — customize Kirmy’s character, tone, detail, and format only for yourself; choose `character:custom` and a `description` (max 120 characters) for a custom persona.
- `/persona view` — privately view your choices; `/persona reset` — restore your default style.
- `/help` — show capabilities and data handling.
- In DMs or when mentioning Kirmy, `!reset` and `!help` also work.

Tools are selected automatically by Grok: web search and browsing, X search, xAI-hosted sandboxed Python, and a local `current_time` function. PNG, JPEG, WebP, and GIF attachments up to 20 MB are accepted, up to four per message. Long answers are sent as Markdown files. Source citations are preserved.

Conversation memory is scoped to **server + channel + user**, so another user's history is never included in your prompt. Recent context uses up to 16 exchanges within a 32,000-character budget. A separate archive keeps up to 1,000 exchanges for 180 days by default. Local full-text search ranks relevant older conversations using topic matches and stemming, returning dated excerpts. Important preferences, projects, constraints, and plans can be saved as durable notes (up to 200 per scope, 1,000 characters each), including through ordinary conversation. Automatic saves must quote the current user's message; invented facts, assistant replies, and retrieved web text are not accepted as quote sources. Reusing a topic key corrects the existing note. Notes remain until forgotten or cleared, independently of archive expiry.

Retrieval and saved data are supplied as untrusted context, with instructions to prefer current corrections and newer evidence. These boundaries reduce risk but do not make model judgment or recall perfect. Retrieval is lexical, without paid embedding or background summarization calls; related ideas without overlapping topic words may require alternate searches. Previously deleted exchanges cannot be recovered by this upgrade. Attached and replied-to image URLs are used for the current request and are not saved in history. Prompts, recalled context, saved notes used in answers, and attachments are sent to xAI; `store: false` disables Responses storage for these requests, but is not a claim about all provider retention policies.

All `/memory` command replies are private and make no provider calls. Memory stays within this channel, including in DMs; persona settings remain user-wide. Pause keeps existing data for inspection/deletion but supplies no history or notes to chat and stores no new exchanges or automatic notes until resumed. Forget removes the note, its recorded revisions/source exchanges, and exchanges repeating the saved quotes; paraphrases in other exchanges may remain. Clear/reset removes all conversation memory in this scope and its search entries, while preserving persona and the pause setting. Memory changes wait until an active request in the same scope finishes. Automatic note changes commit atomically with a successful conversation; a failed request does not save partial changes.

## Personal personas

Use `/persona set character:pirate tone:playful detail:brief format:paragraphs`, or change any one option. Omitted options keep your saved choices. Characters include Kirmy, pirate, robot, wizard, detective, teacher, and custom; combine them with friendly, calm, playful, formal, or direct tones. Detail can match the question, be brief, or be detailed; formatting can match the question, prefer paragraphs, or prefer bullet points.

Set your own default persona with `/persona set description:cute discordian`. Kirmy adopts that persona automatically in replies to you until you change or reset it; this does not create a shared preset. Descriptions must contain 1–120 characters and describe only character or speaking style. Supplying a description alone automatically selects Custom. The description replaces the usual assistant voice and preset tone, detail, and format defaults, including values saved by earlier versions. Include any desired style preferences in the description itself; separate tone/detail/format options apply only to built-in characters. Switching to a preset or resetting removes the saved description. Existing saved descriptions become the user's active default persona without needing to be entered again.

Personas belong to the authenticated Discord user, apply to that user's future requests across servers, channels, and DMs, and persist in SQLite until `/persona reset`. There is no target-user parameter or admin override. All persona command replies are ephemeral. The bot's answers in a server channel remain visible to people who can read that channel. Changing a persona does not erase history, and `/reset` does not erase persona settings. An already-running request keeps its original style.

Preset choices are checked against an allowlist before storage and again before prompt construction. Custom descriptions are checked for length, malformed/hidden characters, role delimiters, links, mentions, and common attempts to override rules or access private data. Rejected changes leave the previous settings intact. These checks are conservative filters, not a complete jailbreak detector, and may reject otherwise harmless phrasing. Only fixed application-owned style phrases enter privileged instructions; custom text is JSON-encoded in a separate user message as untrusted style data. Malformed stored settings fall back to defaults. The model has no persona-management tool. Persona settings do not grant permissions or access to another user's history/settings; tools and request limits remain unchanged. Free text still creates prompt-injection risk: neither the filter nor the prompt boundary guarantees that the model will reject every jailbreak or harmful request. Style choices and custom descriptions are sent to xAI with your request; persona command handling itself makes no AI calls.

## Discord presentation

Finished replies, help, confirmations, music updates, queues, and errors use plain messages with no branded embed headings or footers. Generated images display on their own, and video URLs retain Discord's native player. AI replies are instructed to avoid emojis. Long responses remain available as complete Markdown attachments.

Chat, media generation, and music lookup show only a moving loading bar as a plain message without an embed border or color, edited in place every second, with the slider bouncing continuously between the ends. It is replaced by the plain result when work finishes, leaving no loading embed behind. The bar indicates activity rather than a completion percentage. During Grok requests it uses live provider streaming events to show `WEB`, `X`, or `WEB+X` inside the bar while those searches run, then returns to the normal sliding pattern. Very short stages may finish between the one-second Discord updates. Final answers are still sent as plain messages.

## Image and video generation

Ask Kirmy in a mention, reply, DM, or `/ask`: “generate an image of a cat” or “make a video of waves at sunset.” Both use the existing `XAI_API_KEY`. Image generation uses `grok-imagine-image-2.0` with explicit `quality: medium` and `resolution: 1k`. Video uses `grok-imagine-video-1.5-lite` at 720p for six seconds. Image generation can use up to four reference images, and video generation can animate the first supplied image. Attach a PNG, JPEG, or WebP and describe your edit, for example “make the background blue.” You can also reply to an image message or one of Kirmy’s generated images to edit it further. New attachments take priority over replied-to images. If you only say “edit this image,” Kirmy asks what to change. GIFs remain supported for understanding but not editing or animation.

Images display in Discord as image previews without a visible source link; videos are returned as direct MP4 links. Provider links are temporary, so save results promptly. Media URLs are not saved in conversation history. Generation shares the existing per-user cooldown, per-conversation lock, and global request limit. Each request attempts at most one generation, with no automatic submission retries. Videos are polled every five seconds with a separate ten-minute deadline (`MEDIA_TIMEOUT_MS`). A timeout or restart does not cancel an already-submitted provider job; manually retrying can incur another charge.

API references: [image quality and resolution](https://docs.x.ai/developers/model-capabilities/images/generation), [video generation and polling](https://docs.x.ai/developers/model-capabilities/video/generation).

## Local setup

Requires Node.js 24 or later, FFmpeg with libopus, and `yt-dlp[default]` (2026.8.19) with Python 3.10+. The Dockerfile includes the music dependencies. For local development, install FFmpeg and yt-dlp and put them on PATH (or set `FFMPEG_PATH` / `YTDLP_PATH`).

```sh
npm ci
cp .env.example .env
# Fill in DISCORD_TOKEN and XAI_API_KEY locally.
npm start
```

Enable **Message Content Intent** in the Discord Developer Portal for ordinary messages, replies, and DMs. Invite the bot with `bot` and `applications.commands` scopes and View Channels, Send Messages, Read Message History, Attach Files, Embed Links, Connect, and Speak permissions. Music also needs View Channel in the selected voice channel. It registers `/ask`, `/help`, `/reset`, `/persona`, and `/memory` on startup. Slash commands may take time to appear globally.

`ALLOWED_GUILD_IDS` can restrict server access; empty allows every server the bot joins. DMs remain enabled. API tokens, SQLite data, and `.env` files are excluded from Git and Docker build context. Never commit them.

## Run in the background on macOS

**Current hosting decision (2026-10-21):** Kirmy is temporarily hosted on the owner's Mac while Railway is being fixed. The intended destination is Railway once it is working again. Keep the SQLite database when moving so conversation memory and personas follow the bot.

With Node 24+, FFmpeg, yt-dlp, and the local `.env` ready, run:

```sh
./scripts/mac-host.sh start
./scripts/mac-host.sh status
./scripts/mac-host.sh logs
```

This installs the `org.kirmy.bot` LaunchAgent, starts Kirmy in the background, restarts it after a crash, and launches it when you log in. It runs directly from this checkout, so keep the folder in place. Data stays in `data/kirmy.sqlite`; credentials stay in `.env`. Logs are in `~/Library/Logs/Kirmy/`. The local readiness endpoint is `http://127.0.0.1:3017/health`.

Use `./scripts/mac-host.sh restart` after source changes. `./scripts/mac-host.sh stop` stops it and disables automatic launch until you run `start` again. Keep the Mac awake and online for the bot to respond. Log out, shutdown, and sleep interrupt service. Stop any hosted copy before starting locally to prevent duplicate replies. AI requests still use xAI and its normal API billing.

Restarts now send a graceful shutdown, cancel pending client requests, let SQLite checkpoint, wait for the old process to exit, and then wait for readiness. Cancelling a submitted media request does not cancel the provider's job. The LaunchAgent explicitly uses this checkout's `data/` directory, regardless of a different `DATA_DIR` in `.env`.

## Memory backups and returning to Railway

Create a consistent, private SQLite snapshot while the bot is running:

```sh
npm run memory:backup
# Prints a private snapshot path and its SHA-256; no conversation content.
npm run memory:verify -- --file ./data/backups/<snapshot>.sqlite --sha256 <printed-hash>
```

The backup includes uncheckpointed WAL writes, checks SQLite integrity, uses private file permissions, and refuses to replace an existing file. Keep snapshots private; they contain conversation history and persona settings. A raw copy of only a live `kirmy.sqlite` can miss recent writes held in its WAL sidecar.

When Railway is fixed, stop the Mac bot, create a final snapshot, and transfer that verified file to the stopped Railway service's persistent `DATA_DIR/kirmy.sqlite` (normally `/app/data/kirmy.sqlite`). Preserve its previous database as a private backup before replacing it, and remove obsolete WAL/SHM sidecars only while that service is stopped. Verify the transferred hash and integrity before startup. Then start only Railway, check a fresh `discord_ready`, `commands_registered`, and `/health` success, and keep the Mac snapshot for recovery. Changing `DATA_DIR` alone does not transfer memory. No Railway migration is performed automatically.

## Railway

The Dockerfile installs locked production dependencies on Node 24. Set the Railway healthcheck path to `/health` with a 120-second startup timeout; it returns 200 only when the Discord gateway is ready. A running container alone does not prove a Discord login.

In a Railway project with available capacity:

1. Create a service from this private repository, branch `main`.
2. Add a persistent volume mounted at `/app/data`. If reusing Sefbot's volume, set `DATA_DIR=/app/data/kirmy` to preserve its database separately.
3. Set `DISCORD_TOKEN`, `XAI_API_KEY`, `XAI_MODEL=grok-4.7`, and `DATA_DIR=/app/data` as Railway variables. Use the values in your local `.env`; do not upload that file.
4. Set healthcheck path `/health`, startup timeout 120 seconds, one replica, and restart on failure (10 retries). Deploy and verify `discord_ready` and `commands_registered` in the new deployment logs.

For CLI deployment after linking the project/service:

```sh
railway up --detach
railway logs --lines 100
```

Run one replica to avoid duplicate Discord replies and concurrent SQLite writers. The database is `/app/data/kirmy.sqlite`; keep backups private. No public domain is required for this gateway bot.

## Music

Music runs independently of xAI and makes no AI generation calls. Song-name searches use the first public SoundCloud result. Include the artist for a more precise match. Full SoundCloud track links are also accepted. Playlists, live streams, tracks over one hour, and Stage channels are unsupported. Unavailable or restricted tracks can prevent playback; the bot reports a failure so you can try another song. No cookies or account credentials are used. Music searches and streaming requests go to SoundCloud.

There is one player per server. Only members in its voice channel can enqueue or control playback. Kirmy leaves after 60 seconds without queued music, when the voice channel has no human listeners, or on `.music stop`. Queues are in memory and reset on restart. Disconnects and shutdown clean up child audio processes. Keep yt-dlp updated when SoundCloud changes.

## Limits and extension

`.env.example` lists configurable limits. Defaults: 4,096 output tokens, 8 tool calls, 4 custom-tool continuation rounds, a 180-second request deadline, 5-second per-user cooldown, and 3 concurrent requests. Tool calls and tokens incur xAI charges. These limits bound individual requests; they are **not** a monthly spending cap. Set spending controls in your provider account separately.

Register new local functions in `src/tools.js` through `ToolRegistry.register(definition, execute)`. Each executor must validate arguments, enforce access using the supplied context, and bound any I/O. Only registered functions can execute; model requests cannot run shell commands or access environment variables. Python executes on xAI's sandbox, not on the Railway host.

`src/ai.js` is transport-independent and can be reused for another interface. `src/store.js` owns SQLite recent history, full-text archives, durable notes, and persona settings. `src/memory.js` bounds context and stages grounded memory updates; `src/memory-command.js` handles private memory controls. `src/persona.js` validates style choices and compiles fixed prompt text; `src/persona-command.js` handles private, actor-only commands. `src/bot.js` handles Discord, admission limits, health, and shutdown. Logs contain readiness, usage, and error classifications, not prompts or credentials.

## Verification

```sh
npm run check
npm test
```

Tests mock the provider: tool continuation, denied/invalid tools, loop bounds, sanitized provider errors, citations, persistent isolated history, media quality settings, video polling, deadlines, failed/moderated output, chat-to-media routing, image edits, reference selection, and image-to-video requests. Persona tests cover authenticated-user isolation, forged targets, private replies, persistence/reset, malformed stored data, injection rejection, concurrent requests, and prompt stability across tool rounds. They make no paid generation calls. Model catalog access and a Discord gateway login verify credentials separately; they do not establish live answer quality, successful web/code execution, or actual generated media delivery.

API references: [Grok 4.7](https://docs.x.ai/developers/grok-4-7), [web search](https://docs.x.ai/developers/tools/web-search), [code execution](https://docs.x.ai/developers/tools/code-execution), [function calling](https://docs.x.ai/developers/tools/function-calling).
