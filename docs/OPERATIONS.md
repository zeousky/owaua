# running owaua

The bot code is in `src/owaua/`. `personas/`, `pfps/`, and `banners/` are what people see. `scripts/` starts it and ships it. `models/` is for a local Ollama model. Tests are included in Git and run from any development checkout. `data/` is the database, so leave it alone when you deploy.

[Codex cloud setup](CODEX_CLOUD.md) covers editing and offline checks without this Mac.

The website is its own repo.

## Daki

Daki keeps the bot in `persona-test-bot`. A deploy sends the bot, its dependencies, personas, pictures, banners, and the sefbot copy used by `!switch bot`. Tests, docs, and setup scripts stay here.

Deployment needs a Daki client at `~/.config/owaua-deploy/daki_client.py`
(or `OWAUA_DEPLOY_SCRIPT`), its private configuration, a runtime environment file
(default `.env.cloud`), and the separate Sefbot checkout (`SEFBOT_ROOT`). These
are required even for the manifest dry run. They are not included in Git or
needed for development tests. In a deployment environment, set paths for that
environment instead of using the Mac paths below.

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
bash scripts/test.sh
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
