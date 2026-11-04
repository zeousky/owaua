# Owaua Changelog

Add each user-facing update as a new dated section at the top. The first dated section is posted to the Discord changelog channel when this file changes on `main`.

## 2026-11-04

### Fixed

- Jiki can now show the model’s own reply when the bot owner runs a direct test in Discord.

### Added

- Ask Jiki, the Qwen3.5 9B model, with `/jiki prompt:…` or `.jiki …`. Each question is a separate text request with no previous chat history.

## 2026-11-02

### Changed

- Replies now use faster reasoning by default. Choose higher effort with `/ask reasoning:high` for harder questions.
- Multiple attached documents are prepared in parallel, and typing notifications no longer hold up answers.
- Spoken answers show their text first while the audio is generated.

## 2026-11-02

### Fixed

- Questions mentioning offensive or sensitive words can now receive a respectful answer instead of an automatic safety refusal. Ordinary topic corrections also work, and generic policy replies get one attempt at a useful rewrite.

## 2026-10-30

### Changed

- Owaua has returned to its earlier xAI-only behavior. Terminal start and stop commands remain available.

## 2026-10-29

### Added

- Owaua can be started and stopped with `start owaua` and `stop owaua` from the owner's Mac or Railway terminal. Stop gracefully disconnects the bot while leaving terminal controls available, and the stopped setting survives restarts.

## 2026-10-27

### Fixed

- The no-swearing rule now covers every channel and thread in the designated server.
- Harmless banter gets a natural reply when a rejected draft can be safely rewritten, instead of an unrelated safety refusal.

## 2026-10-27

### Changed

- Owaua now keeps replies clean in the designated no-swearing channel, overriding persona and full-mode settings.

## 2026-10-27

### Changed

- Full mode is now available only to the bot owner and bypasses bot usage quotas, cooldowns, request/tool budgets, and voice session time caps. Other users keep the normal limits.

## 2026-10-27

### Added

- Use `.full on` or `/full mode:on` for replies without the 600-character cap, and `.full off` to restore short replies. Your choice is saved across servers and DMs; long answers arrive as complete files.

## 2026-10-27

### Changed

- Owaua’s default persona is now exactly “act gen z ish, swear alot”.

## 2026-10-27

### Changed

- Chat replies now stay within 600 characters, with shorter, more direct answers. Requested files and JSON downloads keep their full contents.

## 2026-10-27

### Changed

- Clear image and video requests now start straight away with sensible defaults, without extra settings questions or a confirmation button. Edits only need a follow-up if the source or requested change is missing.

## 2026-10-27

### Fixed

- Mentioning Owaua without a question now gets a short reply. Requested help guides stay private instead of filling the server channel.

## 2026-10-27

### Changed

- Replies now remove emojis, including linked and custom Discord emojis.
- Owaua keeps its casual slang and swearing with a more mature tone and less forced hype or flattery.

## 2026-10-27

### Changed

- Removed the message-processing progress bar and its repeated updates from chat, dot commands, and music searches.

## 2026-10-27

### Changed

- Added daily request and voice limits, shared across channels, plus burst protection. Use `/usage` or `.usage` to privately check your allowances; help, status and cleanup remain available when a limit is reached.

## 2026-10-25

### Added

- Ask Owaua to send a song as an MP3, or use `.mp3 <song name and artist>`, to get an audio attachment in chat. SoundCloud track links work too; songs can be up to 10 minutes long.

## 2026-10-24

### Fixed

- Fixed custom personas getting stuck repeating a word instead of answering, including unsafe settings saved earlier. Past test replies are now handled as reference context.

## 2026-10-24

### Changed

- Owaua’s bot services are available again; the temporary shutdown replies have been removed.

## 2026-10-23

### Changed

- Owaua replies with a service shutdown notice until October 24 at 9:00 AM CEST.

## 2026-10-23

### Fixed

- Owaua now uses its own name throughout chat and voice prompts, help, commands, personas, and downloads.

## 2026-10-23

### Changed

- Owaua now runs Kirmy's features and commands, while Kirmy runs Owaua's. Existing memories and settings stay with their respective code.

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
