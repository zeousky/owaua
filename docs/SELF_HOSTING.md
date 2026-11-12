# Self-hosting

A copy of Owaua needs your own Discord application and your own xAI account. This repository does not include tokens, a hosted invite, or a shared database. Provider calls can cost money. Read the current xAI and Discord terms before you point real people at it.

## What you need

- Node.js 24.22.1 or newer on the 24 line, or Node.js 26.12.1 or newer on the 26 line. `.nvmrc` selects 24.22.1.
- A Discord bot token, with the Message Content Intent turned on.
- An xAI API key.
- FFmpeg built with libopus, and yt-dlp 2026.8.19, if you want music or MP3 downloads. Python 3.10 or newer is used to install that yt-dlp.

## First run

```sh
nvm install && nvm use
npm ci
if [ ! -e .env ]; then
  (umask 077 && set -C && cat .env.example > .env)
fi
chmod 600 .env
```

Fill in `DISCORD_TOKEN` and `XAI_API_KEY`, then run `npm start`. Set `OWAUA_OWNER_ID` if you want owner-only controls. `XAI_MODEL` defaults to `grok-4.7` and `XAI_REASONING_EFFORT` defaults to `low`.

Invite the bot with the `bot` and `applications.commands` scopes. It needs permission to view channels, send messages, read message history, attach files, embed links, connect, and speak. Music also needs to see the voice channel.

Slash commands are registered when the bot logs in. Discord can take a while to show them in every server.

`ALLOWED_GUILD_IDS` can be a comma-separated list of server IDs. Leave it empty and every server the bot joins is allowed. Direct messages stay open either way.

Run one process per Discord token. Two copies answer twice and can corrupt the SQLite files.

## Docker

The Dockerfile builds a production image on Node 24.22.1, with FFmpeg and yt-dlp, and starts `node scripts/owaua-host.js`. Give it the environment from `.env` at run time. Do not copy `.env` into the image.

```sh
docker build -t owaua .
docker run --env-file .env -v owaua-data:/app/data -p 127.0.0.1:3000:3000 owaua
```

The data directory inside the container is `/app/data`. Keep that volume. It holds the conversation database and the document-library index. Use a data directory the bot account can write without granting write access to other local accounts.

The release workflow publishes containers to `ghcr.io/<owner>/<repository>`, with version tags and `latest`. For `v1.0.0`, it also assigns `side-a`. Package visibility is separate from repository visibility, so a public source repository does not guarantee anonymous image pulls. Build from source above if a release image is unavailable.

`/live` on port 3000 answers when the process is up, including when the bot has been stopped on purpose. `/health` answers only while Discord is connected.

## Optional pieces

| Variable | What it does |
| --- | --- |
| `QWEN_API_URL`, `QWEN_API_KEY` | Turns on `/jiki`. The URL is the HTTPS root of that model. The key is a bearer token. |
| `XAI_MANAGEMENT_API_KEY` | Lets saved documents use xAI collections and file search. Libraries still work as stored files without it. |
| `MCP_SERVERS_JSON` | Extra read-only MCP integrations, chosen by label. Put any token in its own environment variable, not in this JSON and not in a Discord message. |
| `DATA_DIR` | Where SQLite files live. Defaults to `./data`. |
| `PORT` | Health port for `npm start`. Defaults to 3000. |
| `OWAUA_CONTROL_SOCKET` | Overrides the managed host's Unix socket. Choose a path in a directory owned by the bot account with mode `0700`. The default is `.owaua/control.sock` under the bot account's home. |

The rest of `.env.example` is limits: output length, how many requests can run at once, daily and per-minute allowances, and voice caps. Set a real spending limit on the xAI account as well. These numbers only count requests.

## Data and privacy

The bot keeps a SQLite database in `DATA_DIR`. That file has conversation history, notes, persona choices, language choices, usage counts, and media job ids. `knowledge.sqlite` beside it stores filenames and provider ids for saved documents. Both belong in your backups. A live copy can miss the newest writes if you only copy the `.sqlite` file and skip its WAL sidecar. `npm run memory:backup` takes a consistent snapshot and prints a hash, without printing the conversations.

`.env`, `data/`, and logs are gitignored. Leave them that way.

People's prompts and attachments are sent to xAI. Saved documents stay there until a `/knowledge` delete. Music requests go to SoundCloud and do not use an account cookie. Configure Jiki only if you are comfortable sending those prompts to that host.

`/reset` deletes the bot's memory for that person in that channel. It does not delete Discord messages, provider records, or backups you already stored.

## Owner commands

Set `OWAUA_OWNER_ID` to the Discord user ID you want to grant access to `.full`, quota exemptions, and usage filters for other users and servers. Leave it empty to disable owner privileges on your installation.

## A local backup process on a Mac

`./scripts/mac-host.sh start` installs a LaunchAgent, runs this checkout in the background, and brings it back after a crash or a login. `status`, `logs`, `restart`, and `stop` do what they say. Data stays in `data/` inside the checkout. The health check for that local process is `http://127.0.0.1:3017/health`.

Stop any other copy that uses the same Discord token before you start this one. The Mac has to be awake and online. `stop` also disables the automatic launch until you `start` again.

Notes for the original hosted bot are in [Operations](OPERATIONS.md). A new install can ignore that page.
