# Working on Owaua

This repository is the Python Owaua Discord bot, not the separate Sefbot or
website repositories. Work from the repository root; use relative paths.

## Setup and checks

- Python 3.12 is recommended; CI also tests 3.11 and 3.13.
- Install dependencies: `bash scripts/setup-codex.sh`. On Linux this also
  installs FFmpeg if needed. It creates `.venv` without reading `.env` or
  starting any services. Run it as the cloud setup and maintenance script.
- Run offline tests: `bash scripts/test.sh`.
- Run focused tests: `bash scripts/test.sh test_ask test_memory` (module names).
- Run lint: `.venv/bin/ruff check .`.
- The repository currently has existing lint findings. Compare with the base
  revision and report existing versus introduced issues; avoid broad automatic
  fixes, especially removal of `offline_test_config` imports with side effects.
- Ubuntu CI also has a pre-existing failure in
  `test_security.NativeAudioTests.test_valid_wave_decodes_with_pipe_only_protocols`
  (the restricted FFmpeg decoder returns empty audio). Keep that test enabled
  and report it if it still fails; see the evidence in `docs/CODEX_CLOUD.md`.
- These checks need no Discord token or provider API keys. Tests mock provider
  requests and use temporary databases. The native decoder test runs on Linux
  with FFmpeg. The optional real Sefbot host test skips if that checkout or Node
  is absent; the mocked switching tests still run.

## Where to edit

- `src/owaua/bot.py`: Discord commands, event handling, and visible replies.
- `src/owaua/ask.py`: provider requests, prompts, attachments, and tool routing.
- `src/owaua/intelligence.py`: request planning and document/memory processing.
- `src/owaua/memory.py` and `security.py`: SQLite storage and access/usage limits.
- `src/owaua/music.py`, `music_worker.py`, `media_exec.py`: music and decoder limits.
- `src/owaua/sefbot_host.py`: optional Sefbot child-process integration.
- `personas/`, `pfps/`, `banners/`: persona text and visible assets.
- `tests/`: offline regression coverage. Keep assets and fixtures in Git.

## Boundaries

- Keep `.env*` credentials, `data/`, databases, backups, virtual environments,
  downloaded models, and caches out of Git. `.env.example` stays tracked.
- Preserve bot memory and existing security boundaries. Local code execution
  tools must remain disabled at the shared executor boundary.
- Editing and testing do not require a deployment. Only start Discord, make
  paid model calls, configure Cloudflare, or deploy/restart when requested.
- Daki deployment additionally needs a private Daki client/config, a runtime
  environment file, and the separate Sefbot checkout. See `docs/OPERATIONS.md`.
  Never copy these private credentials into repository files or output.
- Do not run `scripts/check-runtime.py` as a development check: it requires an
  unprivileged production Linux process and writes production readiness data.
- Report tests, uploads, restarts, and Discord login readiness as separate facts.

Cloud environment settings and commands are in `docs/CODEX_CLOUD.md`.
