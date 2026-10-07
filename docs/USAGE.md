# using owaua

Ping it and it talks back. `!human on` makes it sound more like someone in the room. That starts off. DMs stay off unless you turn them on.

Personas are `rudeish` (`low`, `medium`, `high`, medium by default), `nerdish`, `flirty`, `irritating`, `cute`, and `normal`. Luna is the usual model. `!model mercury` uses Mercury for text. Searches and pictures still go through Luna, and the reply says so.

It can help with code, explain things, look things up, read images, and read PDF, text, Markdown, CSV, and JSON files. Casual replies stay short. A real question can run longer. Code tools are only for approved full-mode users.

If you like having it around, tell me. Discord `ckazros`, or `ckazros@owaua.com`.

## commands

`!help` prints these. There is a 25 second cooldown.

- `!persona rudeish low|medium|high`, or `nerdish|flirty|irritating|cute|normal`
- `!persona random` picks a hidden persona and does not say which
- `!human on|off`
- `!model luna|mercury|reset` (Mercury needs `INCEPTION_API_KEY`)
- `!context status|on|off|clear` (Manage Server, or the owner)
- `!language <full name>|reset` (Manage Server)
- `!music help`
- `!memory erase` clears this server (Manage Server)
- `!memory erase mine` clears your history and notes
- `!memory view|stats|status|pause|resume|forget`
- `!memory correct <id> <text>`
- `!memory forget <id>`
- `!reset all` (Manage Server)
- `!switch bot` runs sefbot in this server, or switches back (Manage Server)
- `!owner's note`

Replies cost money. Don't loop it, farm it, or dump huge pastes.

Switching persona keeps the chat. Notes are yours, per server, and DMs are separate. They stay after a restart. Erasing them here does not delete the Discord messages.

Channel context is on. Turning it off forgets the stored lines for that channel. It only keeps a little recent chat, for about a week.

Two files per message, 8 MB each. PDFs stop at 20 pages. Scanned or locked PDFs are skipped. The file text is not saved into memory.

Each person gets 30 model calls per 10 minutes (`API_REQUESTS_PER_USER`, `API_WINDOW_SECONDS`). Chat is also capped at eight messages a minute and three replies at once.

[MIT](../LICENSE)
