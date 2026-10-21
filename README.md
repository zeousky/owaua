# Kirmy

Discord AI core using **Grok 4.7** directly through the official xAI Responses API (`https://api.x.ai/v1/responses`).

## Use

- `.music <song name or YouTube video link>` — join your current voice channel and play music, for example `.music go away`. No mention needed. More requests queue up (20 waiting songs per server).
- `.music queue`, `.music skip`, `.music pause`, `.music resume`, `.music stop` (or `leave`) — control playback from the same voice channel.
- `/ask prompt:...` — ask a question, optionally with an image.
- Mention Kirmy, reply to one of its messages, or send it a DM.
- `/reset` — erase your history in the current channel.
- `/help` — show capabilities and data handling.
- In DMs or when mentioning Kirmy, `!reset` and `!help` also work.

Tools are selected automatically by Grok: web search and browsing, X search, xAI-hosted sandboxed Python, and a local `current_time` function. PNG, JPEG, WebP, and GIF attachments up to 20 MB are accepted, up to four per message. Long answers are sent as Markdown files. Source citations are preserved.

Conversation history is scoped to **server + channel + user**, so another user's history is never included in your prompt. It stores the last 16 exchanges by default, expires after 30 days, and can be reset. Image URLs are used for the current request and are not saved in history. Prompts and attachments are sent to xAI; `store: false` disables Responses storage for these requests, but is not a claim about all provider retention policies.

## Local setup

Requires Node.js 24 or later, FFmpeg with libopus, and `yt-dlp[default]` (2026.8.19) with Python 3.10+. The Dockerfile includes the music dependencies. For local development, install FFmpeg and yt-dlp and put them on PATH (or set `FFMPEG_PATH` / `YTDLP_PATH`). yt-dlp uses Node for YouTube JavaScript challenges.

```sh
npm ci
cp .env.example .env
# Fill in DISCORD_TOKEN and XAI_API_KEY locally.
npm start
```

Enable **Message Content Intent** in the Discord Developer Portal for ordinary messages, replies, and DMs. Invite the bot with `bot` and `applications.commands` scopes and View Channels, Send Messages, Read Message History, Attach Files, Connect, and Speak permissions. Music also needs View Channel in the selected voice channel. It registers `/ask`, `/help`, and `/reset` on startup. Slash commands may take time to appear globally.

`ALLOWED_GUILD_IDS` can restrict server access; empty allows every server the bot joins. DMs remain enabled. API tokens, SQLite data, and `.env` files are excluded from Git and Docker build context. Never commit them.

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

Music runs independently of xAI and makes no AI generation calls. Search uses the first YouTube result; include the artist for a more precise match. Only single YouTube videos are accepted as links. Playlists, live streams, tracks over one hour, and Stage channels are unsupported. Restricted videos or YouTube bot checks can prevent playback; the bot reports a failure so you can try another song. No cookies or account credentials are used. Music searches and streaming requests go to YouTube.

There is one player per server. Only members in its voice channel can enqueue or control playback. Kirmy leaves after 60 seconds without queued music, when the voice channel has no human listeners, or on `.music stop`. Queues are in memory and reset on restart. Disconnects and shutdown clean up child audio processes. Keep yt-dlp updated when YouTube changes.

## Limits and extension

`.env.example` lists configurable limits. Defaults: 4,096 output tokens, 8 tool calls, 4 custom-tool continuation rounds, a 180-second request deadline, 5-second per-user cooldown, and 3 concurrent requests. Tool calls and tokens incur xAI charges. These limits bound individual requests; they are **not** a monthly spending cap. Set spending controls in your provider account separately.

Register new local functions in `src/tools.js` through `ToolRegistry.register(definition, execute)`. Each executor must validate arguments, enforce access using the supplied context, and bound any I/O. Only registered functions can execute; model requests cannot run shell commands or access environment variables. Python executes on xAI's sandbox, not on the Railway host.

`src/ai.js` is transport-independent and can be reused for another interface. `src/store.js` owns SQLite history. `src/bot.js` handles Discord, admission limits, health, and shutdown. Logs contain readiness, usage, and error classifications, not prompts or credentials.

## Verification

```sh
npm run check
npm test
```

Tests mock the provider: tool continuation, denied/invalid tools, loop bounds, sanitized provider errors, citations, and persistent isolated history. They make no paid generation calls. Model catalog access and a Discord gateway login verify credentials separately; they do not establish live answer quality or successful web/code execution.

API references: [Grok 4.7](https://docs.x.ai/developers/grok-4-7), [web search](https://docs.x.ai/developers/tools/web-search), [code execution](https://docs.x.ai/developers/tools/code-execution), [function calling](https://docs.x.ai/developers/tools/function-calling).
