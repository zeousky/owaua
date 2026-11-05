# Contributing

Issues and pull requests are welcome.

1. Keep `.env`, tokens, `data/`, logs, and conversation backups out of Git.
2. Use the Node version in `.nvmrc`. On a fresh machine, `bash scripts/setup-codex.sh` installs the locked dependencies and, on Debian or Ubuntu, FFmpeg and yt-dlp.
3. Run `npm run check` and `npm test` before you open a pull request. A single file is `node --test test/<name>.test.js`.
4. If people will notice the change in Discord, add a short dated note at the top of `CHANGELOG.md`.
5. Update the docs when a command or an environment variable changes.

Tests are supposed to stay offline. They get temporary databases and mocked providers. A change that needs a real Discord login or a paid API call should say so in the pull request.

Be decent in issues and reviews. Do not post someone else's private messages, a token, or a database dump.

The capability checklist in [Grok API coverage](GROK_API_AUDIT.md) is a developer note about what the xAI API surface already reaches. [Codex cloud](CODEX_CLOUD.md) is only for that development environment.
