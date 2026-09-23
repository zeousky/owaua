# Partnership content

The E.R.G.O block on the [partners page](index.html) is generated from
[`ergo.json`](ergo.json). Edit the JSON, not the HTML: the page is rewritten
from the JSON on every website deploy, so changes made directly to
`index.html` are overwritten.

## How to change it

1. Fork [`zeousky/owaua`](https://github.com/zeousky/owaua).
2. Edit `owaua.com/partnerships/ergo.json`.
3. Open a pull request.

When the pull request is merged, CI regenerates the HTML and GitHub Pages
publishes it. You only ever need to touch `ergo.json`.

## The format

| field | what it is |
| --- | --- |
| `name` | the heading, e.g. `E.R.G.O` |
| `meta` | the small line under the heading |
| `mark` | path to the avatar image |
| `intro` | the opening paragraph |
| `note` | the note under the intro |
| `commands_summary` | the text on the collapsible summary |
| `commands_note` | the note above the command list |
| `groups` | the command groups, in display order |

Each group is `{ "title": "...", "commands": [...] }`, and each command is
`{ "cmd": "!play <song/url>", "desc": "queue and play. alias `!p`" }`.

### Inline code

Wrap anything that should render as code in backticks, for example
`` `!menu` `` or `` `1h30m` ``. Everything else is plain text. Angle brackets
are escaped for you, so write `<page>` and `<@user>` naturally.

### Adding and removing

- New group: add another `{ "title": ..., "commands": [...] }` object to `groups`.
- New command: add a `{ "cmd": ..., "desc": ... }` object to a group's
  `commands` array.
- Removing: delete the object. Keep the JSON valid — double quotes, commas
  between items, no trailing comma on the last one.

## Preview locally (optional)

```sh
python3 scripts/render-partnerships.py
```

That regenerates `index.html`; open it in a browser to check your work. CI runs
the same command on deploy, so this step is only for previewing.

If you would rather not touch JSON at all, send the changes to
`ckazros@owaua.com` and they can be applied for you.
