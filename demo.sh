#!/usr/bin/env bash
# One command for a judge: runs the whole order flow on the real engine (see demo/README.md).
#   ./demo.sh [--json <file>] [--serve]        DEMO_PORT (default 8790), PERCEPTION=recorded
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "demo: Node.js 20 or newer is required (node not found)." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "demo: Node.js 20 or newer is required (found $(node --version))." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies (npm ci)…"
  npm ci
fi
exec node demo/run.mjs "$@"
