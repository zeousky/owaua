# Codex cloud development

This page is for Codex cloud setup. Running the bot starts in the README and [Self-hosting](SELF_HOSTING.md).

**Bot identity:** This repository develops **Owaua (Node)**. Its historical checkout/repository labels are not the bot's current name. Read `../BOT_IDENTITY.json` and the root `AGENTS.md` first. Owaua = Node.js / `zeousky/kirmy-bot`; Kirmy = Python / `zeousky/owaua`. Cloud development does not authorize live deployment.

Use a private Codex cloud environment connected to `zeousky/kirmy-bot`.
Select Node.js 24.22.1 (also recorded in `.nvmrc`). The bot uses built-in
`node:sqlite`, including FTS5, and native PNG rendering dependencies.

## Install and verify

```sh
bash scripts/setup-codex.sh
npm test
```

The setup command installs locked npm dependencies and, on Debian/Ubuntu Linux,
FFmpeg with Opus, DejaVu fonts, Python and the same pinned yt-dlp as the production
Dockerfile. Linux installation needs root or sudo and package-download access.
Add `$HOME/.local/bin` to PATH for later shells to use the installed yt-dlp.
Setup is repeatable and can also be used as the legacy maintenance command.

In the environment's Install script, select Node 24.22.1 using the cloud runtime's
version manager (`nvm install && nvm use` reads `.nvmrc`), run the setup command
above and then `npm test`. Supported runtimes are Node 24.22.1+ on 24.x or
26.12.1+ on 26.x; setup, tests, and bot startup reject older or unreviewed lines.
The Start skill
should say that this is a development workspace: run checks and tests, with no
long-running service required. Save the tested configuration and publish it.

Use `npm run check` for syntax checking, `npm test` for the test suite, and, for
example, `node --test test/memory.test.js` for focused checks. Tests use fixtures,
temporary databases and mocked provider/Discord clients; they need no `.env`,
API keys, real Discord login, production database or sibling repositories.
Dependency downloads need package-manager access; normal checks/tests do not
need access to Discord, xAI, SoundCloud or Railway.

## Everyday work

Choose **Work in > Cloud**, select the existing Kirmy environment (the historical name for this Node codebase) and describe your change.
Commit or push work you need to keep. Cloud tasks see GitHub source, so local
uncommitted edits are not automatically available there. After changing runtime
versions or dependencies, edit the environment, repeat setup/checks, and republish
for new tasks.

Keep the environment private. Leave production credentials and databases out of
this environment. `npm start` logs into Discord, registers commands and opens
production-style data stores; it is not a development preview command. A live
integration test needs a separate test bot/token and explicit authorization for
provider spending. Do not start another copy of the production bot.

Official setup guide: <https://learn.chatgpt.com/docs/environments/cloud-environments>.
