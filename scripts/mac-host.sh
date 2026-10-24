#!/bin/bash
set -euo pipefail
# Respect the caller's selected Node (for example, nvm use) before fallbacks.
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

task_root="$(cd "$(dirname "$0")/.." && pwd)"
# Keep the historical label so stop/restart controls existing installations.
label="org.kirmy.bot"
domain="gui/$(id -u)"
target="$domain/$label"
plist="$HOME/Library/LaunchAgents/$label.plist"
logs="$HOME/Library/Logs/Owaua"
health_url="http://127.0.0.1:3017/health"

wait_ready() {
  local deadline=$((SECONDS + 120))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --connect-timeout 2 --max-time 3 "$health_url" >/dev/null; then
      echo "Owaua is ready. Health: $health_url"
      return 0
    fi
    sleep 1
  done
  echo 'Owaua did not become ready within 120 seconds. Check scripts/mac-host.sh logs.' >&2
  return 1
}

unload() {
  local task_pid deadline
  if ! launchctl print "$target" >/dev/null 2>&1; then return 0; fi
  task_pid="$(launchctl print "$target" | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)"
  launchctl bootout "$target"
  # Do not launch a second gateway client while the previous one drains requests.
  if [[ -n "$task_pid" ]]; then
    deadline=$((SECONDS + 35))
    while kill -0 "$task_pid" 2>/dev/null; do
      if (( SECONDS >= deadline )); then
        echo 'Owaua has not exited after 35 seconds. Check its logs before restarting.' >&2
        return 1
      fi
      sleep 1
    done
  fi
}

case "${1:-status}" in
  start)
    if launchctl print "$target" >/dev/null 2>&1; then
      echo 'Owaua is already loaded. Use restart to restart it.'
      wait_ready
      exit
    fi
    task_node="$(command -v node)"
    "$task_node" "$task_root/src/runtime.js"
    command -v ffmpeg >/dev/null
    command -v yt-dlp >/dev/null
    umask 077
    mkdir -p "$HOME/Library/LaunchAgents" "$logs"
    OWAUA_ROOT="$task_root" OWAUA_NODE="$task_node" OWAUA_PLIST="$plist" OWAUA_LOGS="$logs" python3 - <<'PY'
import os, plistlib
from pathlib import Path
root, node, logs = (os.environ[k] for k in ('OWAUA_ROOT', 'OWAUA_NODE', 'OWAUA_LOGS'))
config = {
    'Label': 'org.kirmy.bot',
    'ProgramArguments': [node, root + '/src/bot.js'],
    'WorkingDirectory': root,
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 30,
    'ExitTimeOut': 30,
    'EnvironmentVariables': {
        'PATH': os.environ['PATH'],
        'NODE_ENV': 'production',
        'DATA_DIR': root + '/data',
        'PORT': '3017',
        'HEALTH_HOST': '127.0.0.1',
    },
    'StandardOutPath': logs + '/bot.log',
    'StandardErrorPath': logs + '/error.log',
}
with open(os.environ['OWAUA_PLIST'], 'wb') as file:
    plistlib.dump(config, file)
Path(os.environ['OWAUA_PLIST']).chmod(0o600)
PY
    plutil -lint "$plist"
    launchctl enable "$target"
    launchctl bootstrap "$domain" "$plist"
    wait_ready
    ;;
  stop)
    launchctl disable "$target"
    unload
    echo 'Owaua stopped and disabled at login. Use start to enable it again.'
    ;;
  restart)
    # Reject an unsafe replacement runtime before stopping a healthy process.
    node "$task_root/src/runtime.js"
    # bootout sends SIGTERM and allows ExitTimeOut for SQLite/request cleanup.
    # kickstart -k force-kills the process and bypasses that shutdown path.
    unload
    exec "$0" start
    ;;
  status)
    launchctl print "$target" | sed -n '/state =/p; /pid =/p; /last exit code =/p'
    curl --fail --silent --show-error --connect-timeout 2 --max-time 5 "$health_url"
    echo
    ;;
  logs)
    tail -n 50 "$logs/bot.log" "$logs/error.log"
    ;;
  *) echo 'Usage: scripts/mac-host.sh start|stop|restart|status|logs' >&2; exit 1 ;;
esac
