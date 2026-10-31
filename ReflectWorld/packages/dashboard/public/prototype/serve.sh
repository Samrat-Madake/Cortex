#!/bin/bash
# Quick serve the prototype on port 3212
# Usage: bash serve.sh [port]
PORT=${1:-3212}
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Serving prototype at http://0.0.0.0:$PORT"
echo "  LAN: http://$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$DIR"
