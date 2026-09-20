#!/usr/bin/env bash
set -euo pipefail

exec "$(cd "$(dirname "$0")" && pwd -P)/deploy.sh" "$@"
