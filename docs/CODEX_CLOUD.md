# Editing Owaua in Codex cloud

A fresh clone contains the bot source, persona text, pictures, banners, and
offline tests. You do not need this Mac, its `.env` files, its database, a local
AI model, or the website checkout to edit and test Owaua.

## One-time environment settings

Open **Settings > Codex Cloud > Environments** and select or edit the private
`owaua` environment connected to `zeousky/owaua`. Its install script should be:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd /workspace/owaua
bash scripts/setup-codex.sh
```

The **Start skill** should tell Codex to read `AGENTS.md`, work from
`/workspace/owaua`, use `.venv`, and run `bash scripts/test.sh` for offline checks.
No long-running service, environment variables, or secrets are needed for
development. Python **3.12** is recommended. Installation needs package registry
access; the offline tests do not need provider or Discord access.

Save the draft and **Publish**, then choose **Work in > Cloud > owaua** in a new
chat. Existing chats keep their own state. Repository refreshes do not rerun
installation commands automatically: rerun `bash scripts/setup-codex.sh` when
dependencies change or `.venv` is missing. See the
[official cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environments).

The separate **Legacy Codex Cloud** interface uses **Setup** and **Maintenance**
fields instead; set both to `bash scripts/setup-codex.sh` if using that interface.

## Normal workflow

Ask Codex to edit the bot or its personas. `AGENTS.md` explains the repository
and check commands. Verify a change with:

```sh
bash scripts/test.sh
.venv/bin/ruff check .
```

The existing code has lint findings; compare lint output with the base revision
when reviewing a change. Do not automatically remove `offline_test_config`
imports: they configure the credential-free test profile.

Ubuntu CI also has an existing failure in
`test_security.NativeAudioTests.test_valid_wave_decodes_with_pipe_only_protocols`:
the restricted FFmpeg decoder returns empty audio. It failed on the
[previous commit](https://github.com/zeousky/owaua/actions/runs/37663407584) and
on the [cloud setup commit](https://github.com/zeousky/owaua/actions/runs/37682474033).
Dependency setup succeeds; this runtime regression is separate from the cloud
bootstrap. Keep the test enabled and report its result. The clean macOS copy
passed all 359 tests, with four platform/optional checks skipped.

For a focused change, use test module names, for example:

```sh
bash scripts/test.sh test_ask test_memory
```

The setup script is safe to rerun and never logs in to Discord, calls a model,
loads credentials, or deploys. It installs FFmpeg on Debian/Ubuntu Linux for
the native audio regression tests. Tests also run on macOS, with Linux-only
audio checks skipped. Python packages are pinned in `requirements.txt` and
`requirements-dev.txt`.

## Files outside this repository

`.gitignore` excludes local secrets, bot databases/logs/backups, downloaded
models/runtimes, Python caches, build output, and the separate website folder.
Nothing in those folders is needed for normal Owaua editing.

`!switch bot` uses the separate Sefbot engine. Owaua's wrapper and mocked tests
are included here. Its optional real host test requires the separate Sefbot
checkout and Node.js 22+; set `SEFBOT_ROOT` to that checkout and install its
dependencies if you specifically want to work on that integration. Without it,
that one test skips.

Daki deployment additionally requires a private deployment client/config,
`.env.cloud`, and the Sefbot checkout. Those are not development dependencies.
Use an explicitly configured deployment environment when you request a deploy;
do not commit credentials or use the production Discord token for tests.
See [operations](OPERATIONS.md) for the deployment workflow.
