#!/usr/bin/env bash
# Package app/ into dist/application.zip (manifest.webapp must sit at the zip root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/app"
DIST_DIR="$ROOT/dist"
ZIP_PATH="$DIST_DIR/application.zip"

python3 "$ROOT/scripts/make_icons.py" >/dev/null
python3 -c "import json,sys; json.load(open('$APP_DIR/manifest.webapp'))" \
  || { echo "manifest.webapp is not valid JSON" >&2; exit 1; }

mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"

# -X drops extra file attributes so the zip is reproducible across machines.
( cd "$APP_DIR" && zip -q -r -X "$ZIP_PATH" . -x '.*' -x '*/.*' )
cp "$APP_DIR/manifest.webapp" "$DIST_DIR/manifest.webapp"

echo "built $ZIP_PATH ($(wc -c < "$ZIP_PATH" | tr -d ' ') bytes)"
unzip -l "$ZIP_PATH"
