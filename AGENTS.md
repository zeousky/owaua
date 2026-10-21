# Repository guidance

When a change is intended for users, add a concise entry at the top of `CHANGELOG.md` under a new `## YYYY-MM-DD` heading. Describe the user-visible result in plain language; do not list internal refactors or claim behavior that was not verified. Group entries under `Added`, `Changed`, or `Fixed` when useful.

The changelog is for the Kirmy community. Whenever a Codex task changes Kirmy's bot code or behavior, add a concise community-facing completion summary to the top of `CHANGELOG.md` before reporting the task as finished. Share the useful outcome, not every implementation detail: omit internal-only changes, sensitive information, credentials, private data, and operational details. Do not turn unfinished work into a release note. Describe changes plainly and only claim behavior that was implemented and verified; do not imply deployment unless it was actually deployed.

The Discord changelog workflow always posts the first dated section as a Discord embed when `CHANGELOG.md` changes on `main`. Keep that section short enough to fit in one embed.
