# Editing Owaua in Codex cloud

A fresh clone contains the bot source, persona text, pictures, banners, and
offline tests. You do not need this Mac, its `.env` files, its database, a local
AI model, or the website checkout to edit and test Owaua.

## One-time environment settings

Connect `zeousky/owaua` to Codex cloud and create/select its environment:

- Python version: **3.12**.
- Setup script: `bash scripts/setup-codex.sh`.
- Maintenance script: `bash scripts/setup-codex.sh` (refreshes dependencies
  when Codex resumes a cached environment after changing branches).
- No environment variables or secrets are needed for development.
- Agent internet access can stay **off**. Setup needs internet access to install
  packages; the offline test suite does not need provider or Discord access.

These are settings in Codex's environment UI; committing the script does not
automatically select it. See the [official cloud environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environment).

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
