# Using Owaua

You can talk to Owaua with a slash command, a dot command, a mention, a reply, or a DM. Slash commands and dot commands take the same names. For `.ask` and `.speak`, write the free text first and put named options after it.

```
.ask What time is it?
.ask Summarize the news reasoning:high web_domains:example.com
```

Quote a value when it contains words like `voice:` or `output:`, so those stay part of the sentence. Attach files to the same message. `audio:1` means the first attachment. Pasted URLs are not treated as uploads.

Some replies are private and arrive by DM, still tied to the server and channel you were in. If DMs are closed, use the slash command instead. A dot command's text stays visible in the channel.

## Asking

`/ask` and `.ask` send your question to Grok. Replies use a lower reasoning effort by default so they come back sooner. Add `reasoning:low`, `medium`, `high`, or `xhigh` when you want a different effort for that one question. Higher effort can take longer and cost more.

A few useful options:

- `web_domains:docs.x.ai,example.com` limits web search to those domains, up to five.
- `x_handles:xai` limits X search to those accounts, up to twenty. `from_date` and `to_date` narrow the dates. The end date is not included.
- `visual_search:true` also allows image search, and lets it look at images and video inside search results.
- `output:json` sends a JSON file. You can pass your own object `schema`.
- `library:true` includes documents you saved in this channel.
- `integrations:xai_docs,deepwiki` turns on a read-only integration for this request. `/integrations` lists the ones you can use, in a private reply.
- `spoken:true` with an `audio` attachment transcribes the recording and can speak the answer back.
- `file`, `image`, and `video` pick an attachment on `/ask`.

Grok chooses its tools. Those include web search, X search, sandboxed Python, and the current time. You can also ask for a downloadable CSV, JSON, Markdown, text file, or a simple chart.

Search filters shape the search. They do not hide the rest of the internet from the bot, and an X thread can still include posts outside the handle or date you set.

## Pictures, video, and files

Ask in a mention, a reply, a DM, or `/ask`.

- "generate an image of a cat"
- "generate a video of waves at sunset"
- Attach a PNG, JPEG, or WebP and say what to change, such as "make the background blue."
- Attach an MP4 and ask to edit it or extend it.

A clear request starts on its own. If you only say "edit this image," it asks what you want changed. One image is the usual default, at medium quality. One video is usually six seconds at 720p. You can ask for more images, a different shape, or a longer clip when you want that. Bigger settings can cost more.

Images show up as pictures. Videos come back as a direct MP4 link. Those links expire, so save anything you want to keep. Finished pictures and videos are not stored in the chat memory.

PNG, JPEG, WebP, and GIF uploads can be up to 20 MB, five images at a time. Documents can be PDF or UTF-8 text and code, up to four files, 20 MB each and 40 MB combined. `/ask` takes one document. A normal message can take several, mixed with images and audio. Office files such as Word and Excel are not read on this path.

`/jobs` shows your last ten media requests in this server or DM, including links that are still available.

## Jiki

`/jiki` and `.jiki` send one text question to Jiki, a separate model, when `QWEN_API_URL` and `QWEN_API_KEY` are set. Each prompt can be up to 2,000 characters. A Jiki question stands on its own.

## Voice and speech

`/speak` or `.speak Hello there voice:eve speed:1.1` makes an audio file. Text can be up to 4,000 characters. `/transcribe` turns a recording into a transcript and word timings. You can hint a language, and you can ask it to guess speakers.

`/voice join` starts a live conversation with Grok Voice. Only the person who started it has their microphone sent to xAI. Everyone in the channel can hear the replies. That same person leaves with `/voice leave`. `/voice voices` lists voices. A session lasts up to ten minutes, and it ends after a couple of quiet minutes, when that person leaves, or when the bot is disconnected.

There is one music or voice connection per server. Stop the music before you join voice, and leave voice before you start music.

A voice message or audio attachment on a normal question is transcribed first. The audio file itself is not kept. The transcript is, when it becomes part of the chat.

## Music

Music does not call the AI. `.music` plus a song name, or a SoundCloud track link, joins your voice channel and plays it. A name search uses the first public SoundCloud result, so the artist helps. More requests queue, up to 20 waiting songs. From that same voice channel:

- `.music queue`
- `.music skip`
- `.music pause`
- `.music resume`
- `.music stop`

`.mp3` plus a song name or SoundCloud link sends an MP3 in the chat and does not join voice. You can also mention Owaua and ask it to attach an MP3. Downloads are for tracks up to about 10 minutes.

Playlists, live streams, and very long tracks are skipped. If SoundCloud will not give the bot a track, it says so.

## Memory, documents, and language

Memory stays with you, in one server and channel. A DM is its own place. The recent conversation is what it sees while answering. Older chats can be searched when the words overlap. It can also keep notes you care about, from the conversation or from a command.

- `/memory view` shows your notes in private.
- `/memory remember key:hobby text:"I like hiking"` saves a fact. The same key updates it.
- `/memory forget id:3` removes one note and its tracked copies in chat history. A note can track up to 64 revisions. If an older note exceeds that limit, use `/memory clear` to erase it and the conversation history in that channel.
- `/memory pause` and `/memory resume` turn memory off and on here. Pausing keeps the old notes in storage and stops new ones.
- `/memory clear` or `/reset` erases your history and notes in this channel. Your persona stays.

`/knowledge add` saves a document for later questions in this channel. The library is private to your account in that server and channel. Saved documents also count toward shared storage limits across channels. `/knowledge list`, `/knowledge forget`, and `/knowledge clear` manage it. Nothing is included in an answer until you ask with `library:true`. Deleting a document does not rewrite answers that were already sent.

`/language Hungarian` or `.language Hungarian` makes later AI replies to you use that language, including a new voice session. Command replies stay in English. `.language` shows the current choice, `.language list` shows names it accepts, and `.language auto` goes back to matching your message.

## How it sounds

`/persona set` changes the character, tone, length, and layout of replies to you. Built-in characters include the usual Owaua voice, plus pirate, robot, wizard, detective, and teacher. You can also set a custom description, up to 120 characters, such as `/persona set description:"talk like a tired librarian"`. That description applies only to you, everywhere you talk to the bot. `/persona view` shows it in private. `/persona reset` restores the default.

The default voice is casual, and it swears. Your persona replaces that for your own requests. Ordinary swearing is fine. Explicit sexual content, slurs, targeted abuse, and other people's private information are not.

Replies are plain messages. They skip emojis and stay fairly short. The bot owner can turn on a longer mode for themselves with `.full on`. Everyone else keeps the short replies. A long answer in that mode arrives as a Markdown file.

Chat, image and video work, and music search show a small loading line while they run. When a web or X search is actually in progress, the line says so.

## Allowances

Defaults, if the host has not changed them:

- 60 requests a day for one person, 5 in a rolling minute
- 300 a day shared by a server, 30 in a minute
- 1,000 a day for the whole bot
- 3 live voice sessions a day for one person, each up to ten minutes
- 2 images and 1 video a day for one person, with a smaller shared pool per server

The day resets at midnight in Europe/Budapest. `/usage` shows your own remaining allowance in private. Help, usage, job history, leaving voice, and deleting saved documents still work after the allowance is used up.

These counts are not a spending cap. The host should also set a budget on the xAI account. Models, tools, and video length change the cost.

## What gets sent out

Questions, recalled notes, and attachments you give it are sent to xAI. Saved documents that you add to the library stay with xAI until you delete them. Music lookups go to SoundCloud. Jiki, when it is configured, receives the prompt for that command.

Chat text is stored locally so it can remember the channel. Raw audio, raw uploads for a one-off question, and generated media links are not kept in that history. A transcript used in chat becomes normal text. `/reset` clears the bot's copy of your history in that channel. It cannot delete the Discord messages, a provider's own logs, or a backup the host already made.
