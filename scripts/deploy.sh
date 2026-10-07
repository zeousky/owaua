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
import json
import urllib.parse
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
        "memory.py", "intelligence.py", "music.py", "music_worker.py", "security.py", "sefbot_host.py",
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
    os.environ.get("SEFBOT_ROOT", root.parent / "opsef" / "ai-bot")
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
def read_remote(relative):
    encoded = urllib.parse.quote("/persona-test-bot/" + relative, safe="")
    return client.request("GET",client.server_path(f"/files/contents?file={encoded}"),expect_json=False)


def read_json(relative):
    try:
        return json.loads(read_remote(relative))
    except Exception:
        return {}


# Freeze exactly the bytes that will be uploaded and hashed before network I/O.
# Local edits during a deploy must not invalidate a healthy release's digest.
payloads = {relative: local.read_bytes() for local, relative in uploads}
release = hashlib.sha256(b"".join(payloads[f"src/owaua/{name}"] for name in ("ask.py","bot.py","memory.py","intelligence.py"))).hexdigest()


def stop_server():
    if client.state() != "offline":
        client.request("POST",client.server_path("/power"),{"signal":"stop"})
        deadline = time.monotonic()+90
        while client.state()!="offline":
            if time.monotonic()>=deadline:
                raise RuntimeError("Bot did not stop; replacement was cancelled")
            time.sleep(2)


state = client.state()
if state not in {"running","offline","starting"}:
    raise RuntimeError(f"Daki server is {state}; deployment was not uploaded")
backup_dir = root / "data" / "improvement-backups" / ("daki-"+time.strftime("%Y%m%d-%H%M%S",time.gmtime()))
backup_dir.mkdir(parents=True,mode=0o700)
previous = {}
print("Saving the previous Daki runtime before replacement...",flush=True)
for _,relative in uploads:
    try:
        previous[relative] = read_remote(relative)
    except Exception as exc:
        if getattr(exc,"status",None)!=404:
            raise
        previous[relative] = None
    if previous[relative] is not None:
        target = backup_dir / relative
        target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        target.write_bytes(previous[relative])
        target.chmod(0o600)
# Credentials stay in memory only, never in the runtime snapshot or output.
previous_env = read_remote(".env")
startup = client.request("GET",client.server_path("/startup"))
old_variables = {entry["attributes"]["env_variable"]:entry["attributes"]["server_value"]
                 for entry in startup.get("data",[]) if entry.get("attributes",{}).get("env_variable") in {"STARTUP_CMD","SECOND_CMD"}}
if set(old_variables)!={"STARTUP_CMD","SECOND_CMD"}:
    raise RuntimeError("Could not capture the existing startup variables for rollback")
changed = []
started_at = time.time()
try:
    stop_server()
    for local_path,relative_path in uploads:
        changed.append(relative_path)
        client.write_file(f"persona-test-bot/{relative_path}",payloads[relative_path])
        print(f"Uploaded {relative_path} (byte-verified)",flush=True)
    client.write_file("persona-test-bot/.env",env_payload)
    print("Cloud environment uploaded (byte-verified)",flush=True)
    client.update_startup_variable("STARTUP_CMD","")
    client.update_startup_variable("SECOND_CMD","cd persona-test-bot && bash scripts/run-bots.sh")
    client.restart()
    print("Restart requested; waiting for fresh native checks and Discord login...",flush=True)
    deadline = time.monotonic()+420
    restart_at = time.monotonic()
    while time.monotonic()<deadline:
        ready,checks = read_json("data/readiness.json"),read_json("data/runtime-check.json")
        if ready.get("release")==release and ready.get("timestamp",0)>started_at and checks.get("timestamp",0)>started_at and checks.get("native_decoder")=="passed" and ready.get("bot_id"):
            print("OWAUA_DEPLOYMENT_HEALTHY "+json.dumps({"logged_in_as":ready["logged_in_as"],"bot_id":ready["bot_id"],"release":release,"runtime_checks":checks}),flush=True)
            break
        if time.monotonic()-restart_at > 30 and client.state()=="offline":
            raise RuntimeError("Production runtime stopped during startup")
        time.sleep(5)
    else:
        raise RuntimeError("Fresh runtime checks and Discord login were not observed")
except BaseException:
    print("Deployment failed; restoring the previous runtime...",flush=True)
    stop_server()
    for relative in changed:
        contents = previous[relative]
        if contents is not None:
            client.write_file("persona-test-bot/"+relative,contents)
        else:
            client.request("POST",client.server_path("/files/delete"),{"root":"/persona-test-bot","files":[relative]})
    client.write_file("persona-test-bot/.env",previous_env)
    for name,value in old_variables.items():
        client.update_startup_variable(name,value)
    client.restart()
    print("Previous runtime restored and restart requested; persistent databases preserved.",flush=True)
    raise
PY
