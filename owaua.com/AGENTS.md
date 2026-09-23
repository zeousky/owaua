# owaua.com

Static site for the official owaua Discord bot. Edit here, then deploy through GitHub Pages.

## Deploy

1. Commit and push the website changes to the repository's `main` branch.
2. GitHub Actions publishes `owaua.com/` to GitHub Pages when `main` changes.
3. Confirm the live page on `https://owaua.com/` and any changed localized path after the workflow completes.

Do not use the Daki deployment client for this website; Daki is for the bot runtime only.

## Partnerships

The E.R.G.O block in `partnerships/index.html` is generated from
`partnerships/ergo.json` by `scripts/render-partnerships.py`, which the Pages
workflow runs before upload. Edit the JSON, not the generated HTML. The
partner-facing instructions live in `partnerships/README.md`.
