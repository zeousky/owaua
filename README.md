# Kirmy

Discord AI core using **Grok 4.7** directly through the official xAI Responses API (`https://api.x.ai/v1/responses`).

## Use

- `.music <song name or SoundCloud track link>` — join your current voice channel and play music, for example `.music go away`. No mention needed. More requests queue up (20 waiting songs per server).
- `.music queue`, `.music skip`, `.music pause`, `.music resume`, `.music stop` (or `leave`) — control playback from the same voice channel.
- `/ask prompt:...` — ask a question, optionally with an image, a PDF/text/code document (`file`), or an MP4 (`video`) to edit or extend.
- `/ask reasoning:low|medium|high|xhigh` — choose reasoning effort for that request. Higher effort can take longer and cost more.
- `/ask web_domains:docs.x.ai,example.com x_handles:xai from_date:2026-10-01 to_date:2026-10-22` — narrow web/X research. Options are independent; the X end date is exclusive.
- `/ask visual_search:true` — also allow web image search and image/video understanding inside web/X search results.
- `/ask output:json` — download a schema-validated JSON answer; optionally supply your own JSON object `schema`.
- `/ask library:true` — include your saved document library in this channel.
- `/ask integrations:xai_docs,deepwiki` — enable selected read-only MCP integrations for this request; `/integrations` lists available choices privately.
- `/ask audio:<recording> spoken:true` — transcribe and answer a recording, optionally with a spoken MP3 reply.
- `/transcribe audio:<recording>` — download a transcript and word timestamps; optional speaker identification and language hints.
- `/speak text:...` — generate an AI-spoken MP3/WAV with voice, language, speed, normalization and optional caption timing.
- `/voice join`, `/voice leave`, `/voice status`, `/voice voices` — talk with Grok Voice 3 in your voice channel or inspect voice choices.
- `/knowledge add file:<document>`, `/knowledge list`, `/knowledge forget id:...`, `/knowledge clear` — manage your private saved documents in this channel.
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

Tools are selected automatically by Grok: web search and browsing, X search, xAI-hosted sandboxed Python, and a local `current_time` function. PNG, JPEG, WebP, and GIF attachments up to 20 MB are accepted, up to five per message. Long answers are sent as Markdown files. Source citations are preserved. Search filters affect their respective search tools; X thread retrieval can fetch posts outside handle/date filters, and ordinary web search remains available alongside filtered X search. These are research controls, not access restrictions.

Attach up to four PDF or UTF-8 text/code documents (20 MiB each, 40 MiB total) through Discord to summarize, compare, or ask questions about them. `/ask` accepts one document; message requests support multiple documents and mixed image/document/audio attachments. Current attachments take priority over replied-to attachments. Ordinary documents are uploaded to xAI Files for the current request and deletion is attempted afterward, including on failures; a one-hour provider expiry is a fallback if cleanup fails or the process stops. Raw documents and temporary file IDs are not saved locally or carried into future requests. Normal answers derived from them remain in text history. Reattach or reply to the source document for a new analysis, or explicitly save it using `/knowledge add`. Binary Office documents are not supported by this attachment path.

## Voice and spoken replies

Audio attachments and Discord voice messages in mentions, replies or DMs are transcribed before the normal chat request. Audio is limited to one recording up to 20 MiB per question. Transcripts over 24,000 characters must use `/transcribe` instead. The audio bytes are not saved locally; the transcript becomes normal conversation text when used with `/ask` or ordinary chat. Standalone `/transcribe` delivers files without saving a conversation. `/speak` accepts up to 4,000 characters; speech output is capped at 8 MiB. `/ask spoken:true` speaks the first 4,000 characters of a text answer and preserves its full text. JSON answers are file-only.

`/voice join` starts a native `grok-voice-3.0` conversation and sends **only the initiating user's microphone audio** to xAI. Replies are audible to everyone in that voice channel. Only that user can control the session from the same channel. Voice sessions use the user's current persona, with custom descriptions kept in a separate user message, but do not read or save SQLite conversation history or knowledge libraries. Web/X search is available inside the voice session. Barge-in cancels the current spoken answer before starting the next one.

There is one music or voice connection per server, at most three voice sessions across the bot, and a ten-minute maximum per session. Sessions end after two minutes without speech, when the creator leaves, when Kirmy is moved/disconnected, or during shutdown. Stop music before joining voice; end voice before starting music. Voice/audio requests incur normal xAI charges; raw audio and realtime transcripts are not written to local logs. Built-in and eligible existing custom voice IDs can be selected; custom-voice creation and regional/account eligibility are not changed by this integration.

## Saved knowledge and MCP integrations

`/knowledge add` deliberately stores a document at xAI until `/knowledge forget` or `/knowledge clear`. Local `knowledge.sqlite` stores private filename/size/provider-ID metadata in the same persistent `DATA_DIR` as conversation memory. The library is scoped to **server + channel + user**. Each scope holds up to 20 PDF/text/code documents, 20 MiB per file and 40 MiB total. `/knowledge` replies are private. Use `/ask library:true` to make saved documents available for that question; normal `/ask` answers remain visible in the channel. `/reset`, `/memory clear` and `/memory pause` affect conversation memory, while document libraries have their own explicit deletion controls. Earlier text answers can retain information derived from deleted documents.

The normal `XAI_API_KEY` supports persistent Files and native attachment search immediately. If `XAI_MANAGEMENT_API_KEY` is configured with collection permissions, Kirmy additionally creates a private collection per scope, indexes documents and uses hosted `file_search` when the full index is ready. Pending or failed indexing keeps the stored Files usable. Removing a configured management key can prevent deletion of an associated collection; restore its permissions before deleting that library. Back up both SQLite databases when migrating hosting. The backup helper also accepts `--source ./data/knowledge.sqlite` for a separate consistent snapshot.

MCP is opt-in for each request. `xai_docs` reads official xAI documentation; `deepwiki` reads public GitHub repository documentation. These public read-only endpoints need no extra account credentials. Custom integrations are deployment-owned `MCP_SERVERS_JSON` entries with an explicit tool allowlist and `readOnly:true`. Requests select labels, never URLs, headers or credentials. Authenticated entries must also restrict `guildIds` or `userIds`, and refer to a token using `authorizationEnv`; never put a token in the JSON or a Discord prompt. Provider approval flags are unsupported, so write tools are not exposed by this registry. Selected integrations receive relevant request data through xAI.

Example deployment configuration (the referenced token stays in a separate environment variable):

```json
[{"label":"manuals","url":"https://mcp.example.com/mcp","readOnly":true,"allowedTools":["search_docs"],"authorizationEnv":"MANUALS_MCP_TOKEN","userIds":["123456789012345678"]}]
```

## Structured answers and downloadable analysis

`/ask output:json` attaches valid JSON with `answer` and `sources` fields by default. The optional `schema` accepts a bounded JSON object schema, up to 4,000 characters, eight levels and 64 properties per object. Basic types, objects/arrays, required fields, enum/const/anyOf and numeric/length bounds are supported; remote references and regular expressions are rejected. Results are parsed and validated locally before delivery. Incomplete or invalid provider JSON produces a clear error, with no automatic paid retry. Notices and additional attachments never alter the JSON file's schema.

Ask for a downloadable CSV, JSON, Markdown, text/code file or PNG chart. Hosted Python can compute the data; the application renders line/bar chart files from validated numeric data. Genuine Python-generated PNG/PDF/XLSX/CSV files can also be delivered through bounded provider stdout exports. Only actual returned bytes are attached; sandbox paths and invented URLs do not establish a downloadable file. Exports are capped at three files, 1 MiB each and 3 MiB combined. Unsupported or oversized exports are reported; a successful text answer is retained. Export bytes are replaced by small metadata before tool continuations to avoid resending binary content as paid context.

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

Ask Kirmy in a mention, reply, DM, or `/ask`: “generate an image of a cat” or “make a video of waves at sunset.” Both use the existing `XAI_API_KEY`. Defaults remain one `grok-imagine-image-2.0` image at medium quality / 1k, or a six-second 720p `grok-imagine-video-1.5-lite` video. Explicit requests can select 1–10 image outputs, low/medium/auto quality, 1k/2k resolution, and supported aspect ratios. For example: “make three square 2k images of a lighthouse.” Auto quality is chosen by the provider and billed at the quality served.

Image creation/editing accepts up to five reference images. Attach a PNG, JPEG, or WebP and describe the edit, such as “make the background blue.” Single-image editing keeps the source aspect ratio; crop it before uploading to change that shape. You can also reply to an image message or Kirmy’s generated images to edit them further. New attachments take priority over replied-to sources. If you only say “edit this image,” Kirmy asks what to change. GIFs remain supported by the existing understanding path, but not editing or animation; current xAI image-understanding documentation explicitly lists JPEG/PNG, so WebP/GIF provider compatibility has not been verified by live prompts.

Video requests can select 1–15 seconds, shape, 480p/720p/1080p, and lite/standard/classic models where supported. Standard (`grok-imagine-video-1.5`) provides native 1080p; lite 1080p is upscaled. One image is animated as the first frame and keeps its source aspect ratio. Multiple supplied images automatically use standard reference-to-video; explicitly request reference mode to choose a different aspect ratio with one image. Reference mode is limited to 720p; classic reference mode supports up to ten seconds.

Attach one MP4 under 20 MB using `/ask video:...`, a message, or a reply to a generated MP4, and ask to **edit** it or **extend** it. Editing uses `/videos/edits` with `grok-imagine-video` and supports source clips up to 8.7 seconds. Extension uses `/videos/extensions`, accepts 2–15-second sources, and adds 2–10 seconds (six by default). Both inherit source shape/resolution up to 720p. Source duration is validated by xAI when Discord does not provide it. These operations do not analyze or summarize video contents. Generation-only options are rejected for editing/extension; larger outputs and the standard model can cost more.

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

**Current hosting (2026-10-21):** Kirmy runs on Railway's existing `kirmy` service with persistent `DATA_DIR=/app/data/kirmy`. The Mac LaunchAgent is a fallback and is not loaded. Keep `kirmy.sqlite` and `knowledge.sqlite` when moving so conversation memory, personas and document ownership follow the bot. Run only one hosted copy.

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

`.env.example` lists configurable limits. Defaults: 4,096 visible output tokens, 8 local tool dispatches, 4 custom-tool continuation rounds, a 180-second request deadline, 5-second per-user cooldown, and 3 concurrent requests. Tool calls and tokens incur xAI charges. These limits bound individual requests; they are **not** a monthly spending cap. Set spending controls in your provider account separately.

`MAX_TOOL_CALLS` bounds local tool dispatch and supplies the remaining provider `max_turns` ceiling. The xAI ceiling limits assistant/tool turns per Responses request, not individual hosted calls; multiple tools can run within a turn, and a custom-tool continuation starts a new provider turn budget. It is not an exact total hosted-call or spending cap. `MAX_OUTPUT_TOKENS` limits visible output, not reasoning tokens. Opaque per-conversation cache keys route requests for potential prompt-cache reuse, but changing recalled context or omitting prior reasoning can still reduce cache hits. Cache savings have not been measured.

Register new local functions in `src/tools.js` through `ToolRegistry.register(definition, execute)`. Each executor must validate arguments, enforce access using the supplied context, and bound any I/O. Only registered functions can execute; model requests cannot run shell commands or access environment variables. Python executes on xAI's sandbox, not on the Railway host.

`src/ai.js` is transport-independent and can be reused for another interface. `src/request-options.js` validates typed research controls; `src/attachments.js` separates current image/document/video sources; `src/files.js` bounds temporary document uploads and cleanup. `src/store.js` owns SQLite recent history, full-text archives, durable notes, and persona settings. `src/memory.js` bounds context and stages grounded memory updates; `src/memory-command.js` handles private memory controls. `src/persona.js` validates style choices and compiles fixed prompt text; `src/persona-command.js` handles private, actor-only commands. `src/bot.js` handles Discord, admission limits, health, and shutdown. Logs contain readiness, separate chat/media usage, job IDs, and error classifications, not prompts or credentials. Hashed user identifiers are sent as xAI `safety_identifier`; raw Discord IDs are not used for that API field.

See [the complete Grok API audit and expansion plan](docs/GROK_API_AUDIT.md) for supported, partial, and missing capabilities. Multi-agent research is deliberately excluded. Some advanced media, transport and account-management APIs remain separate from these user-facing additions.

## Verification

```sh
npm run check
npm test
```

Tests mock the provider: tool continuation, denied/invalid tools, loop bounds, sanitized provider errors, citations, persistent isolated history, typed reasoning/search options, cache identifiers, mixed attachments, bounded document uploads/cleanup, media settings, video polling, deadlines, failed/moderated output, reference selection, reference-to-video, and video edit/extension endpoints. Persona tests cover authenticated-user isolation, forged targets, private replies, persistence/reset, malformed stored data, injection rejection, concurrent requests, and prompt stability across tool rounds. They make no paid generation calls. Model catalog access and a Discord gateway login verify credentials separately; they do not establish live answer quality, successful web/code execution, or actual generated media delivery.

API references: [Grok 4.7](https://docs.x.ai/developers/grok-4-7), [web search](https://docs.x.ai/developers/tools/web-search), [code execution](https://docs.x.ai/developers/tools/code-execution), [function calling](https://docs.x.ai/developers/tools/function-calling).
