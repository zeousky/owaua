# Operations

These notes are for the original hosted bot. A new install should follow [Self-hosting](SELF_HOSTING.md) and can ignore this page.

The hosted process runs on Railway from this repository. One replica only. The persistent data directory is the service volume, and the database files inside it should move with the bot if you ever relocate it. Keep `kirmy.sqlite` and `knowledge.sqlite` together so memory, personas, and document ownership stay in sync.

## Start and stop

The same words work in a Mac terminal and in the Railway shell, after `bash scripts/install-terminal-commands.sh` on the Mac:

```sh
start owaua
stop owaua
owaua status
owaua restart
```

On the Mac, those commands talk to the hosted service. They do not log a second Discord client in from the laptop. Inside the Railway shell they control that container. `stop` disconnects Discord and leaves the small supervisor running, so a later `start` works. The stopped choice survives a restart. A normal crash starts the bot again after a short delay.

`./scripts/mac-host.sh` is the other switch. It runs a copy on the Mac itself. Stop the hosted bot first if both would use the same token.

## Health

`/live` succeeds when the bot is ready or deliberately stopped. `/health` succeeds only when the Discord gateway is ready. After a move, look for a fresh ready log, commands registering, and those two checks before you call it done.

## Moving the database

Stop the bot that is writing the files. Take a snapshot of both databases:

```sh
npm run memory:backup
npm run memory:verify -- --file ./data/backups/<snapshot>.sqlite --sha256 <printed-hash>
```

For the document library, pass `--source ./data/knowledge.sqlite`. Copy the verified files into the volume's data directory while the bot is stopped. Keep the previous files, including WAL and SHM sidecars, until the new process has logged in cleanly. The runtime user has to be able to write the directory. Changing `DATA_DIR` does not move the files for you.

Snapshots contain conversation history and persona text. Keep them private.

## What not to run twice

One live token, one process. The Mac LaunchAgent is a fallback, and it is meant to stay off while Railway is serving that same bot. Logs should contain readiness, usage totals, job ids, and error types. They should not contain prompts or tokens.
