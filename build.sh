#!/bin/bash
# PhoneSocial build script — concatenates src/*.js into index.js
# Run from the repo root: ./build.sh
set -euo pipefail

cd "$(dirname "$0")"

SRC="src"
OUT="index.js"
ORDER=(
    "00-head.js"
    "01-core.js"
    "02-harvest.js"
    "03-ui-panel.js"
    "04-views.js"
    "05-bindings.js"
    "06-api-sms.js"
    "07-narrative.js"
    "08-memories.js"
    "09-chirp-api.js"
    "10-schedule.js"
    "11-misc.js"
    "12-init.js"
)

# Build
{
    for f in "${ORDER[@]}"; do
        cat "$SRC/$f"
    done
} > "$OUT"

# Verify syntax
if command -v node &>/dev/null; then
    node -c "$OUT" || { echo "❌ Syntax check failed"; exit 1; }
    echo "✅ Syntax OK"
fi

# Show stats
LINES=$(wc -l < "$OUT")
SIZE=$(du -h "$OUT" | cut -f1)
echo "✅ Built $OUT: $LINES lines, $SIZE"
