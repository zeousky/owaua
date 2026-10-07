#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT_DIR"
PYTHON=${OWAUA_PYTHON:-"$ROOT_DIR/.venv/bin/python"}
if [[ ! -x "$PYTHON" ]] && ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python environment missing. Run: bash scripts/setup-codex.sh" >&2
  exit 1
fi

# Ignore local profiles and inherited production credentials for offline checks.
export OWAUA_ENV_FILE=/dev/null
export DISCORD_TOKEN=
export OPENAI_API_KEY=offline-test-key
export INCEPTION_API_KEY=offline-test-key
export PERPLEXITY_API_KEY=
export DEEPSEEK_API_KEY=
export GROQ_API_KEY=
export CLOUDFLARE_AI_GATEWAY_TOKEN=
export CLOUDFLARE_LOG_TOKEN=
export PYTHONPATH="$ROOT_DIR/src/owaua:$ROOT_DIR/tests"

if [[ $# -eq 0 ]]; then
  exec "$PYTHON" -m unittest discover -s tests -v
fi
# Example: bash scripts/test.sh test_ask test_memory
exec "$PYTHON" -m unittest -v "$@"
