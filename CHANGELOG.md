# Kirmy Changelog

Add each user-facing update as a new dated section at the top. The first dated section is posted to the Discord changelog channel when this file changes on `main`.

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
