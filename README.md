# owaua

Discord bot I made for hanging out in servers.

Ping it and it talks back. The person-in-the-room voice is off by default;
`!human on` turns it on. It keeps a
little of your thread and recent lines from the channel. DMs are off by default. Personas are
`rudeish` (levels `low`, `medium`, `high`; medium by default), `nerdish`, `flirty`, `irritating`, `cute`, and `normal`. Every cloud reply uses GPT-6 Luna.
Ordinary chat stays text-only. Web search and the code interpreter are available
only to approved full-mode users.

If you put this in a server and actually like it, I'd like to know. DM me on Discord (`ckazros`) or
email `ckazros@owaua.com`. (This will give me more motivation)

## Commands

`!help` prints these. 25 second cooldown.

- `!persona rudeish low|medium|high` (or `nerdish|flirty|irritating|cute|normal`)
- `!persona random` — pick a hidden persona at random; the bot won't say which
- `!human on|off` — the person-in-the-room voice (off by default), or the usual hangout-bot voice
- `!language <full name>|reset` — this server's reply language (Manage Server)
- `!music help`
- `!memory erase` — erase server memory (Manage Server)
- `!memory erase mine`
- `!reset all` — reset this bot in this server (Manage Server)
- `!switch bot` — run sefbot in this server only, or switch back (Manage Server)
- `!owner's note`

Please don't burn the API. Every reply costs real money. Looping it, farming
it, huge pastes, jailbreaks, and other token-wasting junk is abuse. We can
ignore you, wipe memory, or pull the bot without warning. Blocked users only
still use GPT-6 Luna, without full-mode tools.

MIT — see [LICENSE](LICENSE).

Chat runs on the OpenAI Responses API, model `gpt-6-luna`.

<p align="center">
  <a href="https://top.gg/bot/1442127404607737999">
    <img src="https://top.gg/api/widget/servers/1442127404607737999.svg" alt="Discord Bots">
  </a>
</p>
