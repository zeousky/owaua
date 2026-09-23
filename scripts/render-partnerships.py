#!/usr/bin/env python3
"""Render the partnership page from its data file.

The E.R.G.O partnership block in ``owaua.com/partnerships/index.html`` is
generated from ``owaua.com/partnerships/ergo.json``. Editors change the JSON;
this script turns it into the HTML that GitHub Pages deploys.

Usage:
    python3 scripts/render-partnerships.py          # write the page
    python3 scripts/render-partnerships.py --check  # fail if the page is stale
"""

from __future__ import annotations

import json
import re
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "owaua.com" / "partnerships"
DATA_FILE = SITE / "ergo.json"
PAGE_FILE = SITE / "index.html"

START = "<!-- ERGO:START generated from ergo.json -->"
END = "<!-- ERGO:END -->"

#: Inline code spans written with backticks, e.g. "type `!menu` here".
_INLINE_CODE = re.compile(r"`([^`]+)`")
_EXISTING_BLOCK = re.compile(
    r'<article class="partner" id="ergo">.*?</article>', re.DOTALL
)

REQUIRED_KEYS = (
    "name",
    "meta",
    "mark",
    "intro",
    "note",
    "commands_summary",
    "commands_note",
    "groups",
)


def inline(text: str) -> str:
    """Escape untrusted text, then turn ``backticks`` into <code> spans."""
    return _INLINE_CODE.sub(r"<code>\1</code>", escape(str(text)))


def load_data() -> dict:
    try:
        payload = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"error: missing data file {DATA_FILE}") from None
    except json.JSONDecodeError as error:
        raise SystemExit(f"error: {DATA_FILE} is not valid JSON: {error}") from None
    if not isinstance(payload, dict):
        raise SystemExit(f"error: {DATA_FILE} must contain a JSON object")
    for key in REQUIRED_KEYS:
        if key not in payload:
            raise SystemExit(f"error: {DATA_FILE} is missing '{key}'")
    groups = payload["groups"]
    if not isinstance(groups, list) or not groups:
        raise SystemExit(f"error: {DATA_FILE} 'groups' must be a non-empty list")
    for index, group in enumerate(groups):
        if not isinstance(group, dict) or "title" not in group:
            raise SystemExit(f"error: group {index} needs a 'title'")
        commands = group.get("commands")
        if not isinstance(commands, list) or not commands:
            raise SystemExit(f"error: group {index} needs a non-empty 'commands' list")
        for position, command in enumerate(commands):
            if not isinstance(command, dict) or "cmd" not in command or "desc" not in command:
                raise SystemExit(
                    f"error: group {index} command {position} needs 'cmd' and 'desc'"
                )
    return payload


def render(data: dict) -> str:
    lines = [
        '<article class="partner" id="ergo">',
        '<div class="partner-top">',
        (
            f'<img class="partner-mark" src="{escape(str(data["mark"]))}"'
            ' width="40" height="40" alt="">'
        ),
        "<div>",
        f'<h2>{inline(data["name"])}</h2>',
        f'<p class="meta">{inline(data["meta"])}</p>',
        "</div>",
        "</div>",
        f'<p>{inline(data["intro"])}</p>',
        f'<p class="note">{inline(data["note"])}</p>',
        '<details class="partner-cmds">',
        f'<summary>{inline(data["commands_summary"])}</summary>',
        f'<p class="note">{inline(data["commands_note"])}</p>',
    ]
    for group in data["groups"]:
        lines.append("")
        lines.append('<section class="cmd-group">')
        lines.append(f'<h3>{inline(group["title"])}</h3>')
        for command in group["commands"]:
            lines.append(
                f'<div class="pcmd"><code>{inline(command["cmd"])}</code>'
                f'<p>{inline(command["desc"])}</p></div>'
            )
        lines.append("</section>")
    lines.append("</details>")
    lines.append("</article>")
    return "\n".join(lines)


def apply(page: str, block: str) -> str:
    """Replace the marked region, or bootstrap it from the existing article."""
    marked = re.compile(
        re.escape(START) + r".*?" + re.escape(END), re.DOTALL
    )
    replacement = f"{START}\n{block}\n{END}"
    if marked.search(page):
        return marked.sub(lambda _match: replacement, page, count=1)
    if not _EXISTING_BLOCK.search(page):
        raise SystemExit(f"error: no E.R.G.O block or markers found in {PAGE_FILE}")
    return _EXISTING_BLOCK.sub(lambda _match: replacement, page, count=1)


def main(argv: list[str]) -> int:
    data = load_data()
    page = PAGE_FILE.read_text(encoding="utf-8")
    updated = apply(page, render(data))

    if "--check" in argv:
        if updated != page:
            print(
                "partnerships/index.html is out of sync; "
                "run python3 scripts/render-partnerships.py",
                file=sys.stderr,
            )
            return 1
        print("partnerships/index.html is in sync with ergo.json")
        return 0

    if updated != page:
        PAGE_FILE.write_text(updated, encoding="utf-8")
        print(f"rendered {PAGE_FILE.relative_to(ROOT)} from {DATA_FILE.relative_to(ROOT)}")
    else:
        print("partnerships page already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
