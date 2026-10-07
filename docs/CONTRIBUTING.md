# Contributing to owaua

Small, focused changes are easiest to review. Before opening a pull request:

1. Keep credentials, local databases, and server-specific settings out of Git.
2. Install dependencies with `bash scripts/setup-codex.sh`, then run
   `bash scripts/test.sh` and `.venv/bin/ruff check .`.
3. Deploy only when requested, using `./scripts/deploy-daki.sh` for Daki or
   `./scripts/deploy-local.sh` for the local profile. Editing and testing in
   Codex cloud do not require a deployment; see [cloud setup](CODEX_CLOUD.md).
4. Update the README when a command or configuration setting changes.
5. Keep persona edits conversational, clear, and respectful of consent and safety.

Please explain the reason for a behavior change in the pull request description and include a test when practical.
