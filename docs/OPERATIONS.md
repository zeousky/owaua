# Owaua operations

## Project layout

- `src/owaua/` contains the bot runtime package.
- `personas/`, `pfps/`, and `banners/` are runtime content.
- `scripts/` contains local startup, validation, and deployment commands.
- `models/` contains local Ollama model definitions.
- `docs/` contains operator, contributing, and security documentation.
- `tests/` is local/CI-only and is never uploaded to Daki.
- `owaua.com/` is the static website and is separate from the bot runtime.
- `data/` contains persistent SQLite and audit state; it must survive deploys.

## Daki deployment

The Daki server keeps the bot under `persona-test-bot`. Deployments upload only
the runtime manifest: bot modules, pinned dependencies, startup checks, persona
files, profile pictures, banners, and the sefbot engine used by `!switch bot`.
Tests, website files, docs, and setup
utilities stay local.

Preview the exact upload without contacting Daki:

```sh
OWAUA_DAKI_DRY_RUN=1 ./scripts/deploy-daki.sh
```

Deploy the cloud profile:

```sh
SEFBOT_ROOT="/Users/ckazro/Downloads/my projects/opsef/ai-bot" OWAUA_DAKI_ENV_FILE=.env.cloud ./scripts/deploy-daki.sh
```

The deploy script snapshots previous runtime files privately under local
`data/improvement-backups/`, stops the bot, byte-verifies each upload, and
restarts the cloud command. Existing credentials stay outside the source
snapshot. On upload/startup failure it restores previous files and startup
variables, then requests a restart. Remote databases are never replaced.

Cloud startup runs `scripts/check-runtime.py`: Linux, unprivileged execution,
FFmpeg pipe decoding, Deno, effective quotas, and SQLite migration version.
Deployment requires fresh `data/runtime-check.json` and `data/readiness.json`
with the exact source digest and Discord login identity. Container `running`
alone is insufficient. The readiness record is startup evidence, not an ongoing
health monitor or proof of paid AI/voice behavior.

SQLite schema migration is additive and transactional. Existing databases get a
private `memory.sqlite3.pre-v1.backup` before migration; runtime rollback keeps the
compatible migrated database. Backups can retain erased information and should
be handled as private operational artifacts. User erasure affects live memory,
not Discord, external providers or private backups.

Run `PYTHONPATH=src/owaua:tests .venv/bin/python -m unittest discover -s tests -q`
before deployment. Tests use a separate offline profile with dummy keys and mocked
AI requests; production credentials and local-only settings are not loaded.
Local macOS skips Linux decoder checks; cloud startup must pass them.
Startup resolves the pinned Deno package's executable explicitly, so it works
when the container omits Python's user script directory from `PATH`. The native
check decodes audio and checks cleanup after both success and playback failure.

Memory status reports pending/quarantined jobs. Temporary provider failures
retry twice; malformed extraction is quarantined. Pause stops recall and new
background work; erase/correct/forget invalidate pending writes and summaries.
API quotas cover foreground, repairs, summaries and extraction. Provider failures
are charged attempts, with no automatic retry of an ambiguous paid response.

For local-only work, use `./scripts/deploy-local.sh`; it never contacts Daki.

## Persona updates

`update persona [rudeish-low|rudeish-medium|rudeish-high|nerdish|flirty|irritating|cute|normal]` (from `~/.local/bin/update`)
keeps the local `personas/*.txt` files live for the Mac bot and uploads the
same files to Daki. Bare `rudeish` updates all three rudeish levels.
`OWAUA_LOCAL_ONLY` does not skip the Daki upload. Preview
with `OWAUA_DAKI_DRY_RUN=1 update persona rudeish`. Neither side needs a
restart; personas reload on the next reply.
