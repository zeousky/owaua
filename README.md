# Owaua

Owaua is a Discord bot. Mention it, reply to it, or send it a DM and it talks back. Chat runs on Grok 4.7 through xAI. It can search the web and X, read pictures and documents you attach, remember things you tell it, make images and short videos, speak, and play music in a voice channel

This repository used to be called kirmy-bot

The first release is [1.0, Side A](https://github.com/zeousky/owaua/releases/tag/v1.0.0).

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

GitHub Actions checks both supported Node versions, production dependencies, and Git history for secrets. Local databases, backups, credentials, and private extensions belong outside Git; the Docker build only includes the runtime source and scripts.

[License](LICENSE) · [Security](docs/SECURITY.md) · [Changelog](CHANGELOG.md) · [Public release checklist](docs/PUBLIC_RELEASE.md)
