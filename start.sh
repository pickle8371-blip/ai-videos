#!/usr/bin/env sh
# Voidcraft.Video launcher for macOS/Linux.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js 20.10+ is required (https://nodejs.org)"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || [ -n "$FFMPEG_PATH" ] || echo "WARNING: FFmpeg not found on PATH; exports and previews will not work."
[ -d node_modules ] || npm install
{ [ -f dist-server/server/index.js ] && [ -f dist-web/index.html ]; } || npm run build
export VOIDCRAFT_PORT="${VOIDCRAFT_PORT:-5174}"
echo "Voidcraft.Video on http://localhost:$VOIDCRAFT_PORT"
exec node dist-server/server/index.js
