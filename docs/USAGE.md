# Using Owaua

Discord bot I made for hanging out in servers.

Ping it and it talks back. The person-in-the-room voice is off by default;
`!human on` turns it on. It keeps a
little of your thread and recent lines from the channel. DMs are off by default. Personas are
`rudeish` (levels `low`, `medium`, `high`; medium by default), `nerdish`, `flirty`, `irritating`, `cute`, and `normal`. GPT-6 Luna is the default; `!model mercury` selects Mercury 2.5 for text chat.
Ordinary chat gives useful coding help, explanations and research in your chosen persona.
Casual replies stay short; substantive requests have up to 1,200 output tokens.
It can read images and PDF/TXT/Markdown/CSV/JSON attachments, and
automatically offers web search for current facts, weather, news and links.
Mercury selections use Luna for searches and images and say so in the reply.
Code interpreter remains available only to approved full-mode users. Local full mode can use
web tools when `OWAUA_LOCAL_ENABLE_TOOLS=1`; local Python execution is disabled
until an isolated sandbox is available.

If you put this in a server and actually like it, I'd like to know. DM me on Discord (`ckazros`) or
email `ckazros@owaua.com`. (This will give me more motivation)

## Commands

`!help` prints these. 25 second cooldown.

- `!persona rudeish low|medium|high` (or `nerdish|flirty|irritating|cute|normal`)
- `!persona random` — pick a hidden persona at random; the bot won't say which
- `!human on|off` — the person-in-the-room voice (off by default), or the usual hangout-bot voice
- `!model luna|mercury|reset` — your chat model; Mercury requires `INCEPTION_API_KEY`
- `!context status|on|off|clear` — control surrounding channel chat (Manage Server or bot owner to change)
- `!language <full name>|reset` — this server's reply language (Manage Server)
- `!music help`
- `!memory erase` — erase server memory (Manage Server)
- `!memory erase mine`
- `!memory view|stats|status|pause|resume|forget` — inspect or control your durable notes in this server/DM context; server notes are sent privately by DM
- `!memory correct <id> <replacement text>` — correct one of your notes
- `!memory forget <id>` — remove one of your notes
- `!reset all` — reset this bot in this server (Manage Server)
- `!switch bot` — run sefbot in this server only, or switch back (Manage Server)
- `!owner's note`

Please don't burn the API. Every reply costs real money. Looping it, farming
it, huge pastes, jailbreaks, and other token-wasting junk is abuse. We can
ignore you, wipe memory, or pull the bot without warning. Blocked users only
still use GPT-6 Luna, without full-mode tools.

MIT — see [LICENSE](../LICENSE).

Persona changes preserve conversation history and use one shared durable
notebook. Durable notes are isolated by user and server (DMs have a separate
scope), survive restarts and are recalled using normalized keyword/phrase relevance plus
a small preference baseline. Unrelated recent facts are not automatically injected. Luna extracts only directly stated lasting facts from
batches of up to six successful user messages, after six messages or five minutes idle;
a background worker checks every 30 seconds. The persisted extraction queue
survives restarts. Transient failures get at most two retries with backoff; malformed
results are quarantined and shown in memory status. Background work uses spare
capacity and processes one job at a time. Documents, quoted reply context and assistant answers are
excluded from fact extraction. No embedding calls are used. Conversation summaries refresh after 20 new
messages, keep at most 2,000 characters, and stay scoped to your conversation. Each scope keeps
at most 200 notes. View shows stable IDs, dates and source channels. Corrections preserve the note ID. Pause keeps notes
but stops recall and new extraction; forgetting also invalidates pending writes and clears conversation summaries.
`!memory erase mine` erases conversation history and durable notes across your
scopes; server erasure removes all server notes too. Extraction uses additional
Luna calls and respects owner API pause and deletion cancellation.

Channel context remains on by default to preserve existing behavior. Turning
it off clears stored lines and stops collecting and using them for that channel;
clear empties the window without changing its setting. Context holds the latest
12 lines for replies, from up to 40 stored lines with seven-day retention.

Documents are limited to two files per request, 8 MiB per file, 20 PDF pages and
16,000 extracted characters per file. PDF parsing runs in a separate process
with a deadline and Linux resource limits. Only Discord attachment URLs are
accepted. Scanned PDFs require OCR first; encrypted PDFs are unsupported. Page
and line markers support citations. Raw document text is not saved in chat
history or durable notes. Document output reports character-limit truncation. Quoted messages, saved notes
and documents are separate untrusted context; the user message keeps its own budget.
Research/document answers have more room than casual chat, while keeping the chosen persona.

Every provider attempt, including repair calls and background memory work, shares
a persistent per-user quota: 30 attempts per 10 minutes by default. Configure
`API_REQUESTS_PER_USER` and `API_WINDOW_SECONDS`; zero requests disables the quota.
Admission remains eight chat messages per minute and three concurrent AI requests.
Ordinary research permits at most two search calls; full mode permits four tool
calls. No daily shutdown limit is enabled. Provider telemetry records model,
tokens, latency and tool activity without message contents. Explicit verification
requests require search when cloud web tools are available.

Luna runs on the OpenAI Responses API (`gpt-6-luna`); Mercury uses Inception's
Chat Completions API (`mercury-2.5`).
