#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Development bootstrap only: no .env access, bot login, or deployment.
node src/runtime.js

if [[ "$(uname -s)" == Linux ]]; then
  elevated=()
  if [[ "$EUID" -ne 0 ]]; then elevated=(sudo); fi
  "${elevated[@]}" apt-get update
  "${elevated[@]}" apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core python3 python3-venv ca-certificates
  tools_dir="${XDG_CACHE_HOME:-$HOME/.cache}/owaua/music"
  python3 -m venv "$tools_dir"
  "$tools_dir/bin/pip" install --disable-pip-version-check 'yt-dlp[default]==2026.8.19'
  mkdir -p "$HOME/.local/bin"
  ln -sf "$tools_dir/bin/yt-dlp" "$HOME/.local/bin/yt-dlp"
  export PATH="$HOME/.local/bin:$PATH"
else
  for tool in ffmpeg yt-dlp; do
    command -v "$tool" >/dev/null || { echo "Install $tool before setup (see README.md)." >&2; exit 1; }
  done
fi

npm ci --no-audit --no-fund
npm run check
node -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); db.exec("CREATE VIRTUAL TABLE probe USING fts5(text)"); db.close(); console.log("SQLite + FTS5 ready");'
ffmpeg -hide_banner -encoders 2>/dev/null | awk '/libopus/ { found=1 } END { exit !found }'
yt-dlp --version
echo 'Owaua development setup ready. Run npm test. No credentials needed.'
