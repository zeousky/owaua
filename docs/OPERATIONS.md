# running owaua

The bot code is in `src/owaua/`. `personas/`, `pfps/`, and `banners/` are what people see. `scripts/` starts it and ships it. `models/` is for a local Ollama model. Tests stay on this machine. `data/` is the database, so leave it alone when you deploy.

The website is its own repo.

## Daki

Daki keeps the bot in `persona-test-bot`. A deploy sends the bot, its dependencies, personas, pictures, banners, and the sefbot copy used by `!switch bot`. Tests, docs, and setup scripts stay here.

See what would upload:

```sh
OWAUA_DAKI_DRY_RUN=1 ./scripts/deploy-daki.sh
```

Ship it:

```sh
SEFBOT_ROOT="/Users/ckazro/Downloads/my projects/opsef/ai-bot" OWAUA_DAKI_ENV_FILE=.env.cloud ./scripts/deploy-daki.sh
```

That saves a private copy of the old runtime, stops the bot, uploads, and starts it again. If startup fails, the old files come back. The database on the server is not replaced. Don't delete `data/memory.sqlite3`. Erasing memory here does not delete Discord messages or copies a provider already has.

Run the tests first:

```sh
PYTHONPATH=src/owaua:tests .venv/bin/python -m unittest discover -s tests -q
```

A Mac skips the Linux audio check. The server still has to pass it.

This laptop only, no Daki: `./scripts/deploy-local.sh`.

## personas

`update persona rudeish` updates all three rudeish levels here and on Daki. Or name one: `rudeish-low`, `rudeish-medium`, `rudeish-high`, `nerdish`, `flirty`, `irritating`, `cute`, `normal`. The command lives at `~/.local/bin/update`.

`OWAUA_LOCAL_ONLY` still uploads to Daki. To preview:

```sh
OWAUA_DAKI_DRY_RUN=1 update persona rudeish
```

No restart. The next reply uses the new text.
