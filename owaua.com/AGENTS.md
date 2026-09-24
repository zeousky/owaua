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

## secret/

`secret/` is a static build of the owaua app-builder workspace (React/TanStack),
published at `https://owaua.com/secret/`. It is generated output: a single-page
export with prerendered HTML per route, plus `404.html` (the app's own not-found
page) for paths outside its three routes. Do not hand-edit it — rebuild it in
the source workspace with `node scripts/build-static.mjs` and copy
`dist/secret/public/` here.

