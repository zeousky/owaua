#!/usr/bin/env bash
# Development dependencies only; never starts or deploys the bot.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT_DIR"
PYTHON=${OWAUA_PYTHON:-python3}
"$PYTHON" -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ required (3.12 recommended)"'

if [[ "$(uname -s)" == "Linux" ]] && ! command -v ffmpeg >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Install FFmpeg with your system package manager, then rerun this script." >&2
    exit 1
  fi
  if [[ "$(id -u)" == "0" ]]; then
    APT=(apt-get)
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    APT=(sudo -n apt-get)
  else
    echo "FFmpeg is missing. Ask the environment administrator to install it." >&2
    exit 1
  fi
  "${APT[@]}" update
  "${APT[@]}" install --no-install-recommends -y ffmpeg ca-certificates
fi

if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON" -m venv .venv
fi
# uv also works with existing virtual environments created without pip.
if command -v uv >/dev/null 2>&1; then
  uv pip install --python .venv/bin/python -r requirements-dev.txt
  uv pip check --python .venv/bin/python
else
  .venv/bin/python -m ensurepip --upgrade
  .venv/bin/python -m pip install -r requirements-dev.txt
  .venv/bin/python -m pip check
fi

echo "Development environment ready. Run: bash scripts/test.sh"
