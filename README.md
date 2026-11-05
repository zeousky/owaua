# Owaua

Owaua is a Discord bot. Mention it, reply to it, or send it a DM and it talks back. Chat runs on Grok 4.7 through xAI. It can search the web and X, read pictures and documents you attach, remember things you tell it, make images and short videos, speak, and play music in a voice channel

The GitHub repository is still called kirmy-bot. The bot this code runs is Owaua

## Try it

Slash commands and the same commands with a dot both work. A dot command does not need a mention.

- `/ask` or `.ask What time is it?` — ask a question. Attach a picture, a PDF, or a recording if you want.
- `/jiki` or `.jiki` — ask Jiki, when the host has that model set up.
- `/speak` or `.speak Hello` — get a spoken audio file.
- `/voice join` — talk with it in your voice channel.
- `.music song name` — play a song in the voice channel you are in. `.mp3 song name` sends the file in chat.
- `/persona`, `/memory`, `/knowledge`, `/language` — your voice, your notes, saved documents, and which language it answers in.
- `/help` — a short reminder. `/usage` — what you have left today

The longer tour is in [Using Owaua](docs/USAGE.md).

## Run a copy

You need Node.js 24, a Discord bot token, and an xAI API key. Music also needs FFmpeg and yt-dlp. Calls to xAI are billed to the key you provide.

```sh
nvm install && nvm use
npm ci
cp .env.example .env
npm start
```

Put `DISCORD_TOKEN` and `XAI_API_KEY` in `.env`. In the Discord developer portal, turn on the Message Content Intent. Invite permissions, Docker, and what the bot stores are in [Self-hosting](docs/SELF_HOSTING.md).

```sh
npm run check
npm test
```

Tests do not need tokens. They use temporary databases and mocked providers. See [Contributing](docs/CONTRIBUTING.md) if you want to change something.

[License](LICENSE) · [Security](docs/SECURITY.md) · [Changelog](CHANGELOG.md)
