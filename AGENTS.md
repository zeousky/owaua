# Repository guidance

## Development and Codex cloud

- Use Node.js 24+ (`.nvmrc` selects 24). A fresh checkout needs `bash scripts/setup-codex.sh`; see `docs/CODEX_CLOUD.md` for cloud configuration.
- Run `npm run check` and `npm test` before completing code changes. Focused tests use `node --test test/<name>.test.js`.
- Normal development/tests need no credentials and use temporary databases and mocked providers. Do not load `.env`, read production databases, start `src/bot.js`, register Discord commands, call paid providers, or deploy as part of setup/tests.
- Preserve unrelated uncommitted work. Never commit `.env*` (except `.env.example`), tokens, `data/`, backups or logs. Stage only the files relevant to the task.
- Only one production bot instance may use the live Discord token. Hosting and live integration tests require explicit scope; cloud development does not authorize either.

## Community changelog

When a change is intended for users, add a concise entry at the top of `CHANGELOG.md` under a new `## YYYY-MM-DD` heading. Describe the user-visible result in plain language; do not list internal refactors or claim behavior that was not verified. Group entries under `Added`, `Changed`, or `Fixed` when useful.

The changelog is for the Kirmy community. Whenever a Codex task changes Kirmy's bot code or behavior, add a concise community-facing completion summary to the top of `CHANGELOG.md` before reporting the task as finished. Share the useful outcome, not every implementation detail: omit internal-only changes, sensitive information, credentials, private data, and operational details. Do not turn unfinished work into a release note. Describe changes plainly and only claim behavior that was implemented and verified; do not imply deployment unless it was actually deployed.

The Discord changelog workflow always posts the first dated section as a Discord embed when `CHANGELOG.md` changes on `main`. Keep that section short enough to fit in one embed.
