# Kirmy Changelog

Add each user-facing update as a new dated section at the top. The first dated section is posted to the Discord changelog channel when this file changes on `main`.

## 2026-10-24

### Changed

- Owaua’s bot services are available again; the temporary shutdown replies have been removed.

## 2026-10-23

### Changed

- Owaua replies with a service shutdown notice until October 24 at 9:00 AM CEST.

## 2026-10-23

### Added

- Every slash command now also works with `.` — try `.ask Hello`, `.voice join`, `.memory view`, or `.help`. Subcommands, settings, and attached files are supported. Private results arrive by DM.

## 2026-10-23

### Changed

- Help, usage, and everyday command replies sound more conversational, with clearer next steps.
- `/help` now shows the quick start right in chat, with a separate guide for the details.

## 2026-10-23

### Changed

- Invalid language selections now show a randomly chosen supported language as the example.

## 2026-10-23

### Added

- `.language Hungarian` (or `/language`) saves your personal AI reply language across servers and DMs, including new voice sessions. Use `.language list` for names or `.language auto` to reset. Only listed human languages are accepted; safety rules still apply.

## 2026-10-23

### Fixed

- Kirmy now requires a security-patched Node.js runtime and refuses to start on affected older versions.

## 2026-10-22

### Added

- Daily media allowances: 3 videos and 5 images per server; 1 video and 2 images per user. The bot owner is exempt. Limits reset at midnight Budapest time.
- `/jobs` privately retrieves recent media results. Saved video jobs resume checking after a restart.
- Owner-only `/usage` shows daily media reservations.

### Changed

- Paid media requests require the requester's confirmation of the final prompt and settings. Simultaneous requests share the same stored allowance.

## 2026-10-22

### Changed

- Image and video requests generate directly, using defaults for unspecified settings.
- Kirmy's default persona uses casual Gen Z language and frequent swearing. Personal persona choices still apply.
- Ordinary swearing is allowed in text and voice; casual insults directed at Kirmy can reach chat.
- Source links remain clickable without large webpage preview cards.

### Fixed

- Reply checks cover common text encodings, downloadable text, and chart labels. Voice playback waits for a completed transcript to pass these checks.
- JSON answers cannot run media generation tools.
- Automatic memory saves use your typed words rather than attached or transcribed content.

## 2026-10-21

### Added

- Voice conversations, recording transcription, and spoken replies with `/voice`, `/transcribe`, and `/speak`.
- Private saved document libraries with `/knowledge`, available through `/ask library:true`.
- Read-only documentation integrations, downloadable charts/data/code files, and schema-validated JSON answers.
- Reasoning and research controls, more image/video settings, five-image references, and video editing/extension.

## 2026-10-21 — Test: current Kirmy development list, embed retry

- Plan a full Kirmy Discord server
- Audit Grok API features and capabilities
- Improve bot memory and reliability
- Add safe personal personas
- Add polished embeds and animation
- Add image and video generation
- Find the fix
- Add bot voice music playback
- Build and deploy Grok bot core
