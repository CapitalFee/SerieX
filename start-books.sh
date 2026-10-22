#!/bin/sh
# Builds and starts SerieX Books at http://127.0.0.1:8080 (or the port given as the
# first argument). Company files live in the same folder the SerieX desktop app uses,
# so both show the same companies (do not run both at the same time).
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-8080}"
case "$(uname -s)" in
  Darwin) BASE="${SERIEX_DATA_DIR:-$HOME/Library/Application Support/SerieX}" ;;
  *) BASE="${SERIEX_DATA_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/SerieX}" ;;
esac
DATA="$BASE/books"
mkdir -p "$DATA"

cd "$ROOT/web"
[ -d node_modules ] || npm install
npm run build

cd "$ROOT/server"
go build -o seriex .
echo "SerieX Books: http://127.0.0.1:$PORT  (company files: $DATA)"
exec ./seriex -port "$PORT" -data "$DATA" -web "$ROOT/web/dist"
