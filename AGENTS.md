# Repository guidance

## Bot identity: Owaua (Node)

This checkout is **Owaua**, even though its historical folder/repository names suggest otherwise. Read `BOT_IDENTITY.json` before choosing files or deployment targets.

| User means | Codebase | GitHub repository | Railway project / service | Discord application ID |
| --- | --- | --- | --- | --- |
| **Owaua bot** | **Node.js**, local `kirmy/`, `src/bot.js` | `zeousky/owaua` | `bots` / `kirmy` | `1442127404607737999` |
| **Kirmy bot** | **Python**, local `owaua-persona-testbot/`, `src/owaua/bot.py` | `zeousky/owaua-n` | `bots` / `owaua` | `1562279174222385212` |

- The identity swap happened on 2026-10-23. Treat older chats, memories, project labels, repository names, source directory names, environment-variable prefixes, and service names as historical aliases. They do not reverse this mapping.
- A request to change **Owaua** belongs here. A request to change **Kirmy** belongs in the other codebase; switch to that repository before editing. Do not implement a named bot's change in whichever checkout happens to be open.
- Before an authorized live action, match the project and service IDs in `BOT_IDENTITY.json` and verify the running/target Discord application ID. Use explicit project, environment, and service selectors; do not rely on a linked CLI default. If identities disagree, resolve that mismatch before acting. Never print tokens or credentials during verification.
- Preserve existing tokens, memory filenames, database paths, and compatibility names. Do not swap tokens again, rename storage, or undo the identity swap unless the user explicitly requests it.
- **owaua.com is a separate website**, in `github-site-repos/owaua.com` / `zeousky/owaua.com`, Railway project `websites`. Its `owaua` service is not either bot service.
- These identity instructions do not authorize deployment, command registration, paid calls, production data access, or starting another bot instance. Normal development remains offline.

## Development and Codex cloud

- Use Node.js 24+ (`.nvmrc` selects 24). A fresh checkout needs `bash scripts/setup-codex.sh`; see `docs/CODEX_CLOUD.md` for cloud configuration.
- Run `npm run check` and `npm test` before completing code changes. Focused tests use `node --test test/<name>.test.js`.
- Normal development/tests need no credentials and use temporary databases and mocked providers. Do not load `.env`, read production databases, start `src/bot.js`, register Discord commands, call paid providers, or deploy as part of setup/tests.
- Preserve unrelated uncommitted work. Never commit `.env*` (except `.env.example`), tokens, `data/`, backups or logs. Stage only the files relevant to the task.
- Only one production bot instance may use the live Discord token. Hosting and live integration tests require explicit scope; cloud development does not authorize either.

## Community changelog

When a change is intended for users, add a concise entry at the top of `CHANGELOG.md` under a new `## YYYY-MM-DD` heading. Describe the user-visible result in plain language; do not list internal refactors or claim behavior that was not verified. Group entries under `Added`, `Changed`, or `Fixed` when useful.

The changelog is for the Owaua community. Whenever a Codex task changes Owaua's bot code or behavior, add a concise community-facing completion summary to the top of `CHANGELOG.md` before reporting the task as finished. Share the useful outcome, not every implementation detail: omit internal-only changes, sensitive information, credentials, private data, and operational details. Do not turn unfinished work into a release note. Describe changes plainly and only claim behavior that was implemented and verified; do not imply deployment unless it was actually deployed.

The Discord changelog workflow always posts the first dated section as a Discord embed when `CHANGELOG.md` changes on `main`. Keep that section short enough to fit in one embed.
