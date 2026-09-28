#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
if [[ -z "${OWAUA_DEPLOY_SCRIPT:-}" ]]; then
  for candidate in \
    "$HOME/.config/owaua-deploy/daki_client.py" \
    "$ROOT_DIR/../owaua/scripts/deploy"
  do
    if [[ -f "$candidate" ]]; then
      OWAUA_DEPLOY_SCRIPT=$candidate
      break
    fi
  done
fi
OWAUA_DEPLOY_SCRIPT=${OWAUA_DEPLOY_SCRIPT:-"$HOME/.config/owaua-deploy/daki_client.py"}

if [[ ! -f "$OWAUA_DEPLOY_SCRIPT" ]]; then
  echo "Cannot find the Daki deployment client: $OWAUA_DEPLOY_SCRIPT" >&2
  exit 1
fi

ROOT_DIR="$ROOT_DIR" OWAUA_DEPLOY_SCRIPT="$OWAUA_DEPLOY_SCRIPT" python3 - <<'PY'
import hashlib
import importlib.machinery
import importlib.util
import os
import time
from pathlib import Path

root = Path(os.environ["ROOT_DIR"])
deploy_path = Path(os.environ["OWAUA_DEPLOY_SCRIPT"])

env_file = Path(os.environ.get("OWAUA_DAKI_ENV_FILE", root / ".env.cloud"))
if not env_file.is_file():
    raise RuntimeError(f"Daki env file is missing: {env_file}")
env_payload = env_file.read_bytes()

runtime_root_files = {
    Path("requirements.txt"),
}
runtime_package_files = {
    Path("src/owaua") / name
    for name in (
        "__init__.py", "ask.py", "bot.py", "cloudflare.py", "media_exec.py",
        "memory.py", "music.py", "music_worker.py", "security.py", "sefbot_host.py",
    )
}
runtime_script_files = {Path("scripts/check-runtime.py"), Path("scripts/run-bots.sh")}
required_runtime = {
    *runtime_root_files,
    *runtime_package_files,
    *runtime_script_files,
    Path("personas/rudeish-low.txt"),
    Path("personas/rudeish-medium.txt"),
    Path("personas/rudeish-high.txt"),
    Path("personas/nerdish.txt"),
    Path("personas/flirty.txt"),
    Path("personas/irritating.txt"),
    Path("personas/cute.txt"),
    Path("personas/normal.txt"),
    Path("requirements.txt"),
    Path("scripts/run-bots.sh"),
    Path("scripts/check-runtime.py"),
}
files = sorted(
    path
    for path in root.rglob("*")
    if path.is_file()
    and not any(part.startswith(".") for part in path.relative_to(root).parts)
    and (
        path.relative_to(root) in runtime_root_files
        or path.relative_to(root) in runtime_package_files
        or path.relative_to(root) in runtime_script_files
        or path.relative_to(root).parts[0] in {"personas", "pfps", "banners"}
    )
)
if not files:
    raise RuntimeError("No deployable runtime files found")
relative_files = {path.relative_to(root) for path in files}
missing_runtime = required_runtime - relative_files
if missing_runtime:
    raise RuntimeError(
        "Deployment is incomplete; missing required runtime file(s): "
        + ", ".join(sorted(map(str, missing_runtime)))
    )

sefbot_root = Path(
    os.environ.get("SEFBOT_ROOT", Path.home() / "Downloads" / "opsef" / "ai-bot")
)
sefbot_uploads: list[tuple[Path, str]] = []
if not (sefbot_root / "src" / "host-stdio.js").is_file():
    raise RuntimeError(f"sefbot engine is missing: {sefbot_root}")
for directory in ("src", "personas", "assets"):
    base = sefbot_root / directory
    if not base.is_dir():
        continue
    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        if any(part.startswith(".") for part in path.relative_to(sefbot_root).parts):
            continue
        if path.stat().st_size > 5 * 1024 * 1024:
            continue
        sefbot_uploads.append((path, f"sefbot/{path.relative_to(sefbot_root).as_posix()}"))
for name in ("package.json", "package-lock.json"):
    path = sefbot_root / name
    if not path.is_file():
        raise RuntimeError(f"sefbot engine is missing {name}")
    sefbot_uploads.append((path, f"sefbot/{name}"))
required_sefbot = {
    "sefbot/src/host-stdio.js",
    "sefbot/src/host.js",
    "sefbot/src/incoming.js",
    "sefbot/package.json",
    "sefbot/package-lock.json",
}
missing_sefbot = required_sefbot - {remote for _, remote in sefbot_uploads}
if missing_sefbot:
    raise RuntimeError(
        "sefbot engine upload is incomplete; missing: "
        + ", ".join(sorted(missing_sefbot))
    )

uploads = [(path, path.relative_to(root).as_posix()) for path in files]
uploads.extend(sefbot_uploads)

print(f"Daki runtime manifest: {len(uploads)} files")
if os.getenv("OWAUA_DAKI_DRY_RUN", "0").strip().lower() in {"1", "true", "yes", "on"}:
    for _, remote in uploads:
        print(f"  {remote}")
    raise SystemExit(0)

loader = importlib.machinery.SourceFileLoader("daki_deploy", str(deploy_path))
spec = importlib.util.spec_from_loader(loader.name, loader)
if spec is None:
    raise RuntimeError("could not load the Daki deployment client")
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

config = module.load_config()
client = module.DakiClient(config["panel_url"], config["api_key"], config["server_id"])
state = client.state()
if state not in {"running", "offline", "starting"}:
    raise RuntimeError(
        f"Daki Bots server is {state}; deployment was not uploaded"
    )
if state != "offline":
    print("Stopping the bot before replacing runtime files...", flush=True)
    client.request("POST", client.server_path("/power"), {"signal": "stop"})
    deadline = time.monotonic() + 90
    while client.state() != "offline":
        if time.monotonic() >= deadline:
            raise RuntimeError("Bot did not stop; no runtime files were replaced")
        time.sleep(2)

for local_path, relative_path in uploads:
    remote_path = f"persona-test-bot/{relative_path}"
    payload = local_path.read_bytes()
    client.write_file(remote_path, payload)
    encoded = remote_path.replace("/", "%2F")
    readback = client.request(
        "GET",
        client.server_path(f"/files/contents?file=%2F{encoded}"),
        expect_json=False,
    )
    if readback != payload:
        raise RuntimeError(f"Daki verification failed for {remote_path}")
    print(f"Uploaded {remote_path} (sha256={hashlib.sha256(payload).hexdigest()[:12]})")

remote_env_path = "persona-test-bot/.env"
client.write_file(remote_env_path, env_payload)
encoded_env_path = remote_env_path.replace("/", "%2F")
env_readback = client.request(
    "GET",
    client.server_path(f"/files/contents?file=%2F{encoded_env_path}"),
    expect_json=False,
)
if env_readback != env_payload:
    raise RuntimeError("Daki verification failed for persona-test-bot/.env")
print("Uploaded persona-test-bot/.env from .env.cloud (verified)")

client.update_startup_variable("STARTUP_CMD", "")
client.update_startup_variable(
    "SECOND_CMD",
    "cd persona-test-bot && bash scripts/run-bots.sh",
)
print(f"Restarting {config.get('server_name', config['server_id'])}...")
client.restart()
deadline = time.monotonic() + 180
while time.monotonic() < deadline:
    if client.state() == "running":
        print("Container started with the Daki profile. Verify the Discord readiness event in its console before declaring deployment healthy.")
        break
    time.sleep(2)
else:
    raise RuntimeError("Daki server did not return to running state within 180 seconds")
PY
