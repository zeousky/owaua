# Owaua

> **Agent routing:** This is **Owaua (Node)**. Historical checkout: `kirmy`; GitHub: `zeousky/kirmy-bot`; Railway: `bots / kirmy`; Discord application: `1442127404607737999`. Read [`BOT_IDENTITY.json`](BOT_IDENTITY.json) and [`AGENTS.md`](AGENTS.md) before choosing a bot or deployment target. **Kirmy is the separate Python bot.**

Discord AI core using **Grok 4.7** directly through the official xAI Responses API (`https://api.x.ai/v1/responses`).

Chat uses `low` reasoning effort by default to favor reply speed. [xAI's reasoning guide](https://docs.x.ai/developers/model-capabilities/text/reasoning) documents that these models otherwise default to `high`. Set `XAI_REASONING_EFFORT` to change the default for `grok-4.5`, `grok-4.6`, or `grok-4.7`; `/ask reasoning:...` overrides it for one request. Full mode still removes its existing caps. Other model names keep their provider defaults. Lower effort can reduce depth on difficult questions, so select `high` or `xhigh` when needed.

## Use

Every slash command also works with the `.` prefix, without a mention. Use the same subcommands and `option:value` names:

- `.ask What time is it?` or `.ask prompt:"Summarize the news" reasoning:high web_domains:example.com`
- `.jiki Explain how a sundial works` — send a text question to Jiki.
- `.speak Hello there voice:eve speed:1.1` and `.transcribe language:hu` (attach audio)
- `.voice join`, `.voice leave`, `.voice status`, `.voice voices`
- `.persona set description:"Talk like a pirate"`, `.persona view`, `.persona reset`
- `.language Hungarian`, `.memory view`, `.memory remember key:hobby text:"I like hiking"`, `.memory forget id:3`, `.memory pause`, `.memory resume`, `.memory clear`
- `.knowledge add` (attach a document), `.knowledge list`, `.knowledge forget id:3`, `.knowledge clear`
- `.jobs`, `.usage` (your allowance; owner-only `user` and `server` filters), `.integrations`, `.reset`, `.help`

For `.ask` and `.speak`, put free text first, then named options. Quote values containing text such as `voice:` or `output:` so it stays literal. Structured options work too: `.ask List three colors output:json schema:{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}`. Attach files directly to the command message. Attachment options select an attached filename or a 1-based number, such as `audio:1`; typed URLs are not attachment inputs.

Private command results are sent by DM, with the original server/channel scope preserved. Enable DMs or use slash commands if DMs are blocked. Your prefix command message remains visible in its channel; use slash commands for private input.

- `.mp3 <song name and artist or SoundCloud track link>` — get an MP3 attachment in chat, without joining voice. You can also mention Owaua and ask “can you attach an MP3 of this song: ...”.
- `.music <song name or SoundCloud track link>` — join your current voice channel and play music, for example `.music go away`. No mention needed. More requests queue up (20 waiting songs per server).
- `.music queue`, `.music skip`, `.music pause`, `.music resume`, `.music stop` (or `leave`) — control playback from the same voice channel.
- `/ask prompt:...` — ask a question, optionally with an image, a PDF/text/code document (`file`), or an MP4 (`video`) to edit or extend.
- `/jiki prompt:...` — ask Jiki, a Qwen3.5 9B model hosted on Modal. Each text prompt can contain up to 2,000 characters.
- `/ask reasoning:low|medium|high|xhigh` — choose reasoning effort for that request. Replies default to `low` for speed, including full mode; higher effort can take longer and cost more.
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
- Mention Owaua with “generate an image of a cat” or “generate a video of a cat” to create media.
- Mention Owaua, reply to one of its messages, or send it a DM.
- `/memory view` — privately inspect your saved notes and archive count here.
- `/memory remember key:hosting text:...` — save a fact, or correct it by reusing its key.
- `/memory forget id:...` — remove a saved note and its recorded source exchanges.
- `/memory pause` / `/memory resume` — disable / enable reading and saving conversation context here.
- `/reset` or `/memory clear` — erase your history, searchable archive, and saved notes in the current channel.
- `/persona set` — customize Owaua’s character, tone, detail, and format only for yourself; choose `character:custom` and a `description` (max 120 characters) for a custom persona.
- `/persona view` — privately view your choices; `/persona reset` — restore your default style.
- `/help` — show capabilities and data handling.
- In DMs or when mentioning Owaua, `!reset` and `!help` also work.

Tools are selected automatically by Grok: web search and browsing, X search, xAI-hosted sandboxed Python, and a local `current_time` function. PNG, JPEG, WebP, and GIF attachments up to 20 MB are accepted, up to five per message. Long answers are sent as Markdown files. Source citations are preserved. Search filters affect their respective search tools; X thread retrieval can fetch posts outside handle/date filters, and ordinary web search remains available alongside filtered X search. These are research controls, not access restrictions.

Jiki receives the prompt you enter and normally gets the bot’s reply instructions. When the bot owner uses Jiki outside the server with a clean-language rule, the command sends only the current prompt and displays the model’s reply directly. Each request is independent and uses text only. Jiki has no access to chat history, saved memory, attachments, or tools. It shares Owaua’s request limits. Configure `QWEN_API_URL` with the HTTPS root of the private gateway and `QWEN_API_KEY` with its bearer key to enable the command.

Attach up to four PDF or UTF-8 text/code documents (20 MiB each, 40 MiB total) through Discord to summarize, compare, or ask questions about them. `/ask` accepts one document; message requests support multiple documents and mixed image/document/audio attachments. Current attachments take priority over replied-to attachments. Ordinary documents are uploaded to xAI Files for the current request and deletion is attempted afterward, including on failures; a one-hour provider expiry is a fallback if cleanup fails or the process stops. Raw documents and temporary file IDs are not saved locally or carried into future requests. Normal answers derived from them remain in text history. Reattach or reply to the source document for a new analysis, or explicitly save it using `/knowledge add`. Binary Office documents are not supported by this attachment path.

## Reply safety

Owaua's default persona is exactly "act gen z ish, swear alot". Personal persona settings still take precedence. Ordinary profanity is allowed in text and speech; explicit sexual content, hateful slurs, targeted abuse, and private information remain restricted. The reply and privacy policy applies across personas and output formats. Deterministic text safeguards supplement the model policy: they check current requests and returned replies, common encoded or obfuscated text, local tool arguments, text exports, and chart labels. Benign decoding remains allowed. Documents, images, transcripts, retrieved pages, tool results, and saved context are treated as untrusted reference data rather than authority to change instructions or permissions. Media generation still follows these checks.

These bounded checks cannot recognize every jailbreak or harmful meaning. Arbitrary binary image, PDF, and XLSX contents are not semantically verified by the application, and provider audio/transcript accuracy is not independently verified. Unsafe legacy history and notes are withheld from new requests without deleting stored data; `/memory view` hides affected note text while retaining its ID for removal.

## Voice and spoken replies

Audio attachments and Discord voice messages in mentions, replies or DMs are transcribed before the normal chat request. Audio is limited to one recording up to 20 MiB per question. Transcripts over 24,000 characters must use `/transcribe` instead. The audio bytes are not saved locally; the transcript becomes normal conversation text when used with `/ask` or ordinary chat. Standalone `/transcribe` delivers files without saving a conversation. `/speak` accepts up to 4,000 characters; speech output is capped at 8 MiB. `/ask spoken:true` shows the validated text answer first, then adds speech covering its first 4,000 characters to the same message when ready. JSON answers are file-only.

`/voice join` starts a native `grok-voice-3.0` conversation and sends **only the initiating user's microphone audio** to xAI. Replies are audible to everyone in that voice channel. Only that user can control the session from the same channel. Voice sessions use the user's current persona, with custom descriptions kept in a separate user message, but do not read or save SQLite conversation history or knowledge libraries. Web/X search is available inside the voice session. Barge-in cancels the current spoken answer before starting the next one.

Realtime speech is held until the response finishes and its completed transcript passes the text safeguards. Missing, incomplete, or rejected transcripts prevent playback; interruption discards the pending audio. This introduces a wait before speech starts and relies on the provider's transcript accurately representing its audio.

There is one music or voice connection per server, at most three voice sessions across the bot, and a ten-minute maximum per session. Sessions end after two minutes without speech, when the creator leaves, when Owaua is moved/disconnected, or during shutdown. Stop music before joining voice; end voice before starting music. Voice/audio requests incur normal xAI charges; raw audio and realtime transcripts are not written to local logs. Built-in and eligible existing custom voice IDs can be selected; custom-voice creation and regional/account eligibility are not changed by this integration.

## Saved knowledge and MCP integrations

`/knowledge add` deliberately stores a document at xAI until `/knowledge forget` or `/knowledge clear`. Local `knowledge.sqlite` stores private filename/size/provider-ID metadata in the same persistent `DATA_DIR` as conversation memory. The library is scoped to **server + channel + user**. Each scope holds up to 20 PDF/text/code documents, 20 MiB per file and 40 MiB total. `/knowledge` replies are private. Use `/ask library:true` to make saved documents available for that question; normal `/ask` answers remain visible in the channel. `/reset`, `/memory clear` and `/memory pause` affect conversation memory, while document libraries have their own explicit deletion controls. Earlier text answers can retain information derived from deleted documents.

The normal `XAI_API_KEY` supports persistent Files and native attachment search immediately. If `XAI_MANAGEMENT_API_KEY` is configured with collection permissions, Owaua additionally creates a private collection per scope, indexes documents and uses hosted `file_search` when the full index is ready. Pending or failed indexing keeps the stored Files usable. Removing a configured management key can prevent deletion of an associated collection; restore its permissions before deleting that library. Back up both SQLite databases when migrating hosting. The backup helper also accepts `--source ./data/knowledge.sqlite` for a separate consistent snapshot.

MCP is opt-in for each request. `xai_docs` reads official xAI documentation; `deepwiki` reads public GitHub repository documentation. These public read-only endpoints need no extra account credentials. Custom integrations are deployment-owned `MCP_SERVERS_JSON` entries with an explicit tool allowlist and `readOnly:true`. Requests select labels, never URLs, headers or credentials. Authenticated entries must also restrict `guildIds` or `userIds`, and refer to a token using `authorizationEnv`; never put a token in the JSON or a Discord prompt. Provider approval flags are unsupported, so write tools are not exposed by this registry. Selected integrations receive relevant request data through xAI.

Example deployment configuration (the referenced token stays in a separate environment variable):

```json
[{"label":"manuals","url":"https://mcp.example.com/mcp","readOnly":true,"allowedTools":["search_docs"],"authorizationEnv":"MANUALS_MCP_TOKEN","userIds":["123456789012345678"]}]
```

## Structured answers and downloadable analysis

`/ask output:json` attaches valid JSON with `answer` and `sources` fields by default. The optional `schema` accepts a bounded JSON object schema, up to 4,000 characters, eight levels and 64 properties per object. Basic types, objects/arrays, required fields, enum/const/anyOf and numeric/length bounds are supported; remote references and regular expressions are rejected. Results are parsed and validated locally before delivery. Incomplete or invalid provider JSON produces a clear error, with no automatic paid retry. Notices and additional attachments never alter the JSON file's schema.

Ask for a downloadable CSV, JSON, Markdown, text/code file or PNG chart. Hosted Python can compute the data; the application renders line/bar chart files from validated numeric data. Genuine Python-generated PNG/PDF/XLSX/CSV files can also be delivered through bounded provider stdout exports. Only actual returned bytes are attached; sandbox paths and invented URLs do not establish a downloadable file. Exports are capped at three files, 1 MiB each and 3 MiB combined. Unsupported or oversized exports are reported; a successful text answer is retained. Export bytes are replaced by small metadata before tool continuations to avoid resending binary content as paid context.

Conversation memory is scoped to **server + channel + user**, so another user's history is never included in your prompt. Recent context uses up to 16 exchanges within a 32,000-character budget. A separate archive keeps up to 1,000 exchanges for 180 days by default. Local full-text search ranks relevant older conversations using topic matches and stemming, returning dated excerpts. Important preferences, projects, constraints, and plans can be saved as durable notes (up to 200 per scope, 1,000 characters each), including through ordinary conversation. Automatic saves must quote the current user's typed message; attached or transcribed content, invented facts, assistant replies, and retrieved web text are not accepted as quote sources. Reusing a topic key corrects the existing note. Notes remain until forgotten or cleared, independently of archive expiry.

Retrieval and saved data are supplied as untrusted context, with instructions to prefer current corrections and newer evidence. These boundaries reduce risk but do not make model judgment or recall perfect. Retrieval is lexical, without paid embedding or background summarization calls; related ideas without overlapping topic words may require alternate searches. Previously deleted exchanges cannot be recovered by this upgrade. Attached and replied-to image URLs are used for the current request and are not saved in history. Prompts, recalled context, saved notes used in answers, and attachments are sent to xAI; `store: false` disables Responses storage for these requests, but is not a claim about all provider retention policies.

All `/memory` command replies are private and make no provider calls. Memory stays within this channel, including in DMs; persona settings remain user-wide. Pause keeps existing data for inspection/deletion but supplies no history or notes to chat and stores no new exchanges or automatic notes until resumed. Forget removes the note, its recorded revisions/source exchanges, and exchanges repeating the saved quotes; paraphrases in other exchanges may remain. Clear/reset removes all conversation memory in this scope and its search entries, while preserving persona and the pause setting. Memory changes wait until an active request in the same scope finishes. Automatic note changes commit atomically with a successful conversation; a failed request does not save partial changes.

## Personal personas

Use `/persona set character:pirate tone:playful detail:brief format:paragraphs`, or change any one option. Omitted options keep your saved choices. Characters include Owaua, pirate, robot, wizard, detective, teacher, and custom; combine them with friendly, calm, playful, formal, or direct tones. Detail can match the question, be brief, or be detailed; formatting can match the question, prefer paragraphs, or prefer bullet points.

Set your own default persona with `/persona set description:cute discordian`. Owaua adopts that persona automatically in replies to you until you change or reset it; this does not create a shared preset. Descriptions must contain 1–120 characters and describe only character or speaking style. Supplying a description alone automatically selects Custom. The description replaces the usual assistant voice and preset tone, detail, and format defaults, including values saved by earlier versions. Include any desired style preferences in the description itself; separate tone/detail/format options apply only to built-in characters. Switching to a preset or resetting removes the saved description. Existing saved descriptions become the user's active default persona without needing to be entered again.

Personas belong to the authenticated Discord user, apply to that user's future requests across servers, channels, and DMs, and persist in SQLite until `/persona reset`. There is no target-user parameter or admin override. All persona command replies are ephemeral. The bot's answers in a server channel remain visible to people who can read that channel. Changing a persona does not erase history, and `/reset` does not erase persona settings. An already-running request keeps its original style.

Preset choices are checked against an allowlist before storage and again before prompt construction. Custom descriptions are checked for length, malformed/hidden characters, role delimiters, links, mentions, and common attempts to override rules or access private data. Rejected changes leave the previous settings intact. These checks are conservative filters, not a complete jailbreak detector, and may reject otherwise harmless phrasing. Only fixed application-owned style phrases enter privileged instructions; custom text is JSON-encoded in a separate user message as untrusted style data. Malformed stored settings fall back to defaults. The model has no persona-management tool. Persona settings do not grant permissions or access to another user's history/settings; tools and request limits remain unchanged. Free text still creates prompt-injection risk: neither the filter nor the prompt boundary guarantees that the model will reject every jailbreak or harmful request. Style choices and custom descriptions are sent to xAI with your request; persona command handling itself makes no AI calls.

## Discord presentation

Finished replies, help, confirmations, music updates, queues, and errors use plain messages with no branded embed headings or footers. Generated images display on their own, and video URLs retain Discord's native player. AI replies avoid emojis and default to a 600-character cap. Only the bot owner can use `.full on` or `/full mode:on`; `.full off` restores normal limits, and `.full` shows the setting. This setting persists across restarts, servers, and DMs, independently of persona and memory. In full mode, replies over Discord's 2,000-character message limit arrive as complete Markdown attachments. Owner full mode bypasses daily/minute request and voice quotas, cooldowns, shared request/session capacity, bot output-token/tool/round budgets and request deadlines. It also bypasses recent-history context caps, attachment counts (except the provider’s single-video input), combined document upload budgets, transcript chat caps, library count/total-size/input budgets, automatic-memory search/update/count budgets, and voice session/idle deadlines. Exempt requests are recorded without consuming shared allowances. Discord/provider limits, file/stream memory protections, validation, safety, shutdown cancellation, data-retention rules and locks protecting the same conversation/library/voice connection remain in effect. Requested exports and JSON downloads retain their full contents in either mode.

Chat, media generation, and music lookup show only a moving loading bar as a plain message without an embed border or color, edited in place every second, with the slider bouncing continuously between the ends. It is replaced by the plain result when work finishes, leaving no loading embed behind. The bar indicates activity rather than a completion percentage. During Grok requests it uses live provider streaming events to show `WEB`, `X`, or `WEB+X` inside the bar while those searches run, then returns to the normal sliding pattern. Very short stages may finish between the one-second Discord updates. Final answers are still sent as plain messages.

## Image and video generation

Clear image/video creation, edit and extension requests start immediately using defaults and reasonable creative choices for missing details. Owaua does not ask about optional settings or show a confirmation button for recognized direct requests. Ambiguous proposals still require requester confirmation; model output, attachments and history cannot approve spending. Edits still need source media and a description of what to change. JSON-output requests cannot execute media tools.

Ask Owaua in a mention, reply, DM, or `/ask`: “generate an image of a cat” or “make a video of waves at sunset.” Both use the existing `XAI_API_KEY`. Defaults remain one `grok-imagine-image-2.0` image at medium quality / 1k, or a six-second 720p `grok-imagine-video-1.5-lite` video. Explicit requests can select 1–10 image outputs, low/medium/auto quality, 1k/2k resolution, and supported aspect ratios. For example: “make three square 2k images of a lighthouse.” Auto quality is chosen by the provider and billed at the quality served.

Image creation/editing accepts up to five reference images. Attach a PNG, JPEG, or WebP and describe the edit, such as “make the background blue.” Single-image editing keeps the source aspect ratio; crop it before uploading to change that shape. You can also reply to an image message or Owaua’s generated images to edit them further. New attachments take priority over replied-to sources. If you only say “edit this image,” Owaua asks what to change. GIFs remain supported by the existing understanding path, but not editing or animation; current xAI image-understanding documentation explicitly lists JPEG/PNG, so WebP/GIF provider compatibility has not been verified by live prompts.

Video requests can select 1–15 seconds, shape, 480p/720p/1080p, and lite/standard/classic models where supported. Standard (`grok-imagine-video-1.5`) provides native 1080p; lite 1080p is upscaled. One image is animated as the first frame and keeps its source aspect ratio. Multiple supplied images automatically use standard reference-to-video; explicitly request reference mode to choose a different aspect ratio with one image. Reference mode is limited to 720p; classic reference mode supports up to ten seconds.

Attach one MP4 under 20 MB using `/ask video:...`, a message, or a reply to a generated MP4, and ask to **edit** it or **extend** it. Editing uses `/videos/edits` with `grok-imagine-video` and supports source clips up to 8.7 seconds. Extension uses `/videos/extensions`, accepts 2–15-second sources, and adds 2–10 seconds (six by default). Both inherit source shape/resolution up to 720p. Source duration is validated by xAI when Discord does not provide it. These operations do not analyze or summarize video contents. Generation-only options are rejected for editing/extension; larger outputs and the standard model can cost more.

Images display in Discord as image previews without a visible source link; videos are returned as direct MP4 links. Provider links are temporary, so save results promptly. Media URLs are not saved in conversation history. Generation shares the existing per-user cooldown, per-conversation lock, and global request limit. Each request attempts at most one generation, with no automatic submission retries. Videos are polled every five seconds with a separate ten-minute deadline (`MEDIA_TIMEOUT_MS`). A timeout or restart does not cancel an already-submitted provider job. Provider video IDs are saved to SQLite immediately before polling and resume checking on startup and every 30 seconds. `/jobs` privately retrieves your last ten media requests and completed links in the current server or DM. Recovery never resubmits a paid request. Provider links still expire; this does not archive the video files. A lost POST response without a job ID is marked unknown and must not be blindly retried.

API references: [image quality and resolution](https://docs.x.ai/developers/model-capabilities/images/generation), [video generation and polling](https://docs.x.ai/developers/model-capabilities/video/generation).

## Local setup

Requires Node.js 24.22.1+ on 24.x or 26.12.1+ on 26.x, FFmpeg with libopus, and `yt-dlp[default]` (2026.8.19) with Python 3.10+. `.nvmrc` and Docker select 24.22.1, the October 21 security release. Startup rejects older or unreviewed Node release lines before loading credentials. For local development, install FFmpeg and yt-dlp and put them on PATH (or set `FFMPEG_PATH` / `YTDLP_PATH`).

```sh
nvm install && nvm use # When using nvm; reads .nvmrc.
npm ci
cp .env.example .env
# Fill in DISCORD_TOKEN and XAI_API_KEY locally.
npm start
```

Enable **Message Content Intent** in the Discord Developer Portal for ordinary messages, replies, and DMs. Invite the bot with `bot` and `applications.commands` scopes and View Channels, Send Messages, Read Message History, Attach Files, Embed Links, Connect, and Speak permissions. Music also needs View Channel in the selected voice channel. It registers `/ask`, `/help`, `/reset`, `/persona`, and `/memory` on startup. Slash commands may take time to appear globally.

`ALLOWED_GUILD_IDS` can restrict server access; empty allows every server the bot joins. DMs remain enabled. API tokens, SQLite data, and `.env` files are excluded from Git and Docker build context. Never commit them.

## Run in the background on macOS

**Current hosting (2026-10-23):** This Node code runs as **Owaua** on Railway's `kirmy` service with persistent `DATA_DIR=/app/data/kirmy`. The Python code runs as **Kirmy** on Railway's `owaua` service. Prompts, commands and downloads use their current bot identities. Databases, settings and provider configuration remain with each service. Historical database filenames, service names, repository paths and the Mac LaunchAgent label are retained for compatibility. The Mac LaunchAgent is stopped and disabled at login. Before using the Mac fallback, check its Discord token and stop the Railway service using that same Discord account. Keep `kirmy.sqlite` and `knowledge.sqlite` when moving this code so conversation memory, personas and document ownership stay together. Run only one copy per Discord account.

With a supported patched Node version, FFmpeg, yt-dlp, and the local `.env` ready, run:

```sh
./scripts/mac-host.sh start
./scripts/mac-host.sh status
./scripts/mac-host.sh logs
```

This installs the `org.kirmy.bot` LaunchAgent, starts Owaua in the background, restarts it after a crash, and launches it when you log in. It runs directly from this checkout, so keep the folder in place. Data stays in `data/kirmy.sqlite`; credentials stay in `.env`. Logs are in `~/Library/Logs/Owaua/`. The local readiness endpoint is `http://127.0.0.1:3017/health`.

Use `./scripts/mac-host.sh restart` after source changes. `./scripts/mac-host.sh stop` stops it and disables automatic launch until you run `start` again. Keep the Mac awake and online for the bot to respond. Log out, shutdown, and sleep interrupt service. Stop any hosted copy before starting locally to prevent duplicate replies. AI requests still use xAI and its normal API billing.

Restarts now send a graceful shutdown, cancel pending client requests, let SQLite checkpoint, wait for the old process to exit, and then wait for readiness. Cancelling a submitted media request does not cancel the provider's job. The LaunchAgent explicitly uses this checkout's `data/` directory, regardless of a different `DATA_DIR` in `.env`.

## Personal reply language

Use `.language Hungarian` in a server or DM; no mention is needed. `/language name:Hungarian` also works and confirms privately. The preference applies only to your AI replies across servers and DMs and to new voice sessions. Rejoin an existing voice session to apply a changed preference. Command confirmations and operational notices remain in English.

Use `.language` to view your setting, `.language list` for supported names, and `.language auto` (or `.language reset`) to return to matching your message. Names are case-insensitive; common aliases such as `Magyar` are accepted. Language quality depends on the model. Programming languages, invented names, and names with added instructions are rejected using exact lookup in a fixed human-language catalogue. Saved settings are revalidated before use; language selection never changes safety rules or tool permissions.

## Memory backups and returning to Railway

Create a consistent, private SQLite snapshot while the bot is running:

```sh
npm run memory:backup
# Prints a private snapshot path and its SHA-256; no conversation content.
npm run memory:verify -- --file ./data/backups/<snapshot>.sqlite --sha256 <printed-hash>
```

The backup includes uncheckpointed WAL writes, checks SQLite integrity, uses private file permissions, and refuses to replace an existing file. Keep snapshots private; they contain conversation history and persona settings. A raw copy of only a live `kirmy.sqlite` can miss recent writes held in its WAL sidecar.

To return from Mac fallback hosting, stop the Mac bot and create final snapshots of both `kirmy.sqlite` and `knowledge.sqlite` (pass `--source ./data/knowledge.sqlite` for the latter). Transfer those verified files to Railway's configured persistent `DATA_DIR`, currently `/app/data/kirmy`, while its bot is stopped. Preserve its previous databases and WAL/SHM sidecars as private backups before replacing them. Verify both transferred hashes and SQLite integrity, and ensure the runtime user can write the files and directory before startup. Then start only Railway, check a fresh `discord_ready`, `commands_registered`, and `/health` success, and keep the Mac snapshots for recovery. Changing `DATA_DIR` alone does not transfer memory. No Railway migration is performed automatically.

## Railway

Use the same commands in your Mac terminal and in Owaua's Railway terminal:

```sh
start owaua
stop owaua
owaua status
owaua restart
```

On the Mac, install them once from this checkout with `bash scripts/install-terminal-commands.sh`. It adds links in `~/.local/bin` and preserves existing commands. Keep this checkout in place and ensure that directory is on your `PATH`. The Mac commands connect to the production Owaua service using the authenticated Railway CLI and its explicit project, environment and service IDs. They do not start another Discord client on the Mac. The first SSH connection may ask you to register a key; see [Railway SSH](https://docs.railway.com/cli/ssh). Inside Owaua's Railway terminal, the same commands control that container directly. `owaua start` and `owaua stop` are equivalent alternatives.

Stopping Owaua gracefully disconnects the Discord bot while leaving its small host process and Railway terminal available for the next `start`. The stopped setting survives a container restart or deployment. Starting is idempotent, and restarting waits for the previous child to exit. Normal crashes restart the child with a delay. Control requests use a private Unix socket; there is no public start/stop endpoint. These commands require terminal access to the service, not a Discord command or an AI prompt. The legacy `scripts/mac-host.sh` controls the separate local fallback and must only be used after stopping the hosted bot.

The Dockerfile installs locked production dependencies on Node 24.22.1 and starts `node scripts/owaua-host.js`. Runtime security updates require a new image build and deployment. The Railway service uses that same start command and `/live` for deployment health: it succeeds when the bot is ready or deliberately stopped. `/health` still returns 200 only when the Discord gateway is ready, and 503 while the bot is stopped or starting. The supervisor proxies the bot's other HTTP routes, including private integration routes.

In a Railway project with available capacity:

1. Create a service from this private repository, branch `main`.
2. Add a persistent volume mounted at `/app/data`. If reusing Sefbot's volume, set `DATA_DIR=/app/data/kirmy` to preserve its database separately.
3. Set `DISCORD_TOKEN`, `XAI_API_KEY`, `XAI_MODEL=grok-4.7`, and `DATA_DIR=/app/data` as Railway variables. Use the values in your local `.env`; do not upload that file.
4. Keep one replica, start command `node scripts/owaua-host.js`, deployment healthcheck `/live`, startup timeout 180 seconds, overlap zero, draining time 45 seconds, and restart on failure (10 retries). Deploy and verify `discord_ready`, `commands_registered`, `/live` and `/health` when the bot is enabled. These settings are configured on the existing Owaua service; Railway no longer accepts a new `railway.json` config-file setting.

For CLI deployment after linking the project/service:

```sh
railway up --detach
railway logs --lines 100
```

Run one replica to avoid duplicate Discord replies and concurrent SQLite writers. The database is `/app/data/kirmy.sqlite`; keep backups private. No public domain is required for this gateway bot.

## Music

Music runs independently of xAI and makes no AI generation calls. Song-name searches use the first public SoundCloud result. Include the artist for a more precise match. Full SoundCloud track links are also accepted. Playlists, live streams, tracks over one hour, and Stage channels are unsupported. Unavailable or restricted tracks can prevent playback; the bot reports a failure so you can try another song. No cookies or account credentials are used. Music searches and streaming requests go to SoundCloud.

MP3 downloads use the same public SoundCloud search. `.mp3` and explicit “attach an MP3 of ...” requests download directly; other natural song-file requests can use the AI's `download_song` tool. Downloads accept recorded tracks up to 10 minutes, encode an actual MP3 capped at 9 MiB, and include the track's source link. Each request has a two-minute deadline; up to three downloads can run at once, within normal chat admission limits. Partial or failed encodes are never attached. Temporary metadata/fragments are removed after conversion; MP3 bytes are held in memory for Discord delivery. Binary music content is not transcribed or semantically checked.

There is one player per server. Only members in its voice channel can enqueue or control playback. Owaua leaves after 60 seconds without queued music, when the voice channel has no human listeners, or on `.music stop`. Queues are in memory and reset on restart. Disconnects and shutdown clean up child audio processes. Keep yt-dlp updated when SoundCloud changes.

## Limits and extension

`.env.example` lists configurable limits. Defaults: 4,096 visible output tokens, 8 local tool dispatches, 4 custom-tool continuation rounds, a 180-second request deadline, 5-second per-user cooldown, one active request per user across channels, and 3 concurrent requests. Tool calls and tokens incur xAI charges. These limits bound individual requests; they are **not** a monthly spending cap. Set spending controls in your provider account separately.

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

### Daily media allowances

Allowances reset at midnight Europe/Budapest. Each user has 1 video and 2 images daily across all servers and DMs; each server shares 3 videos and 5 images daily. Image batches count each requested image; editing and extension count toward their media type. Owner `1172433512364769342` is recorded as exempt and consumes neither allowance. A SQLite transaction reserves allowance after authorization and before the provider POST, including simultaneous requests. Definite rejected POSTs release their reservation; failed or uncertain submitted generations remain counted because they may have incurred cost. Reservations and jobs survive restarts in `data/kirmy.sqlite`, which must be included in backups.

`/usage` privately shows your daily request, voice session and media allowances. Only the owner can use the `user` and `server` filters to inspect other users/servers. General request limits apply to the owner while full mode is off. Only the owner can enable full mode to bypass these limits; the existing owner media exemption remains available in either mode.

General limits are persisted atomically in the existing SQLite database and shared across slash commands, dot commands, mentions, replies and DMs. A user gets 60 requests/day, a server shares 300, and the whole bot shares 1,000. Rolling one-minute limits are 5/user, 30/server and 60/bot. Voice session starts also have daily caps of 3/user, 10/server and 20/bot; each session lasts at most ten minutes. Every admitted chat, MP3 download, speech, transcription, document upload or voice start uses one request; tools and attached-input processing within that request retain their existing per-request bounds. Invalid chat input/options are rejected before admission; admitted attempts count even when a later validation, provider call or delivery fails. Rejected admissions never use an allowance. Switching channels/servers, resetting memory and restarting the bot do not clear counts. Counts start when this feature is deployed and reset at midnight Europe/Budapest, including daylight-saving changes. Admission records are retained for up to 31 days and pruned on startup/day changes.

Help, usage, jobs, voice status/leave, and library listing/deletion remain available after exhausting quotas. Library deletion still waits for active work to finish. Configure positive `USER|SERVER|BOT` + `_DAILY_REQUEST_LIMIT`, `_MINUTE_REQUEST_LIMIT`, or `_VOICE_REQUEST_LIMIT` values in the environment (see `.env.example`). Keep provider spending controls too: request counts are not a currency cap, and models, tools, indexing, media settings and duration affect cost. No automatic paid media submission retries are performed.
