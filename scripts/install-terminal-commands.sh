#!/bin/bash
set -euo pipefail
directory="$HOME/.local/bin"
if [[ "$#" -gt 0 ]]; then
  if [[ "$#" -ne 2 || "$1" != --directory || -z "$2" ]]; then
    echo 'Usage: scripts/install-terminal-commands.sh [--directory PATH]' >&2
    exit 1
  fi
  directory="$2"
fi
script_dir="$(cd -P "$(dirname "$0")" && pwd)"
mkdir -p "$directory"
directory="$(cd -P "$directory" && pwd)"
# Preflight every command before changing anything. Never replace another app.
for name in owaua start stop; do
  target="$directory/$name"
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ ! -L "$target" || "$(readlink "$target")" != "$script_dir/$name" ]]; then
      echo "Cannot install $name: a different command already exists at $target." >&2
      exit 1
    fi
  fi
done
created=()
rollback() {
  for target in "${created[@]}"; do rm -- "$target"; done
}
trap rollback ERR
for name in owaua start stop; do
  target="$directory/$name"
  if [[ ! -L "$target" ]]; then
    ln -s "$script_dir/$name" "$target"
    created+=("$target")
  fi
done
trap - ERR
echo "Installed: start owaua, stop owaua, owaua restart, owaua status ($directory)."
