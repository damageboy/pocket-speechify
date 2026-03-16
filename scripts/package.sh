#!/bin/bash
# Package the extension into a .zip for Chrome Web Store or direct distribution.
# Usage: ./scripts/package.sh [output-path]
#
# Stamps the version from git tags/commit hash into manifest.json before packaging.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

# Verify build first
bash scripts/verify-build.sh

# Stamp version into manifest
VERSION=$(bash scripts/stamp-version.sh)
OUTPUT="${1:-pocket-speechify-${VERSION}.zip}"

echo ""
echo "=== Packaging extension v${VERSION} ==="

# Remove stale package if it exists
rm -f "$OUTPUT"

# Create zip with only extension files
zip -r "$OUTPUT" \
  manifest.json \
  content.js \
  service-worker.js \
  offscreen.html \
  offscreen.js \
  config.yaml \
  tokenizer.model \
  src/ \
  css/ \
  wasm/ \
  assets/ \
  -x "*.DS_Store" \
  -x "__MACOSX/*"

SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
SIZE_MB=$(echo "scale=1; $SIZE / 1048576" | bc)

echo ""
echo "=== Packaged: $OUTPUT (${SIZE_MB}MB) ==="
echo "Contents:"
unzip -l "$OUTPUT" | tail -1
