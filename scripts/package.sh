#!/bin/bash
# Package the extension into a .zip and .crx for distribution.
# Usage: ./scripts/package.sh [output-base]
#
# Produces:
#   pocket-speechify-{version}.zip  — for Chrome Web Store upload
#   pocket-speechify-{version}.crx  — for direct installation
#
# The .crx signing key is auto-generated on first run (key.pem).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

# Verify build first
bash scripts/verify-build.sh

# Stamp version into manifest
VERSION=$(bash scripts/stamp-version.sh)
BASE="${1:-pocket-speechify-${VERSION}}"
ZIP_OUTPUT="${BASE}.zip"
CRX_OUTPUT="${BASE}.crx"

echo ""
echo "=== Packaging extension v${VERSION} ==="

# Remove stale packages
rm -f "$ZIP_OUTPUT" "$CRX_OUTPUT"

# Stage extension files into a temp directory for clean packaging
STAGING=$(mktemp -d)
trap "rm -rf $STAGING" EXIT

cp manifest.json content.js service-worker.js offscreen.html offscreen.js config.yaml tokenizer.model "$STAGING/"
cp -r src css wasm assets lib "$STAGING/"
find "$STAGING" -name '.DS_Store' -delete 2>/dev/null || true

# Create .zip
(cd "$STAGING" && zip -r "$EXT_DIR/$ZIP_OUTPUT" .)

ZIP_SIZE=$(wc -c < "$ZIP_OUTPUT" | tr -d ' ')
ZIP_MB=$(echo "scale=1; $ZIP_SIZE / 1048576" | bc)
echo "Created: $ZIP_OUTPUT (${ZIP_MB}MB)"

# Create .crx (requires npx crx3 or chrome CLI)
if command -v npx &>/dev/null; then
  # Generate signing key if it doesn't exist
  KEY_FILE="$EXT_DIR/key.pem"
  if [ ! -f "$KEY_FILE" ]; then
    openssl genrsa 2048 > "$KEY_FILE" 2>/dev/null
    echo "Generated new signing key: key.pem (keep this secret, add to .gitignore)"
  fi
  npx --yes crx3 "$STAGING" --keyPath "$KEY_FILE" --crxPath "$EXT_DIR/$CRX_OUTPUT" 2>/dev/null
  if [ -f "$CRX_OUTPUT" ]; then
    CRX_SIZE=$(wc -c < "$CRX_OUTPUT" | tr -d ' ')
    CRX_MB=$(echo "scale=1; $CRX_SIZE / 1048576" | bc)
    echo "Created: $CRX_OUTPUT (${CRX_MB}MB)"
  else
    echo "Warning: .crx creation failed (npx crx3 error). .zip is still available."
  fi
else
  echo "Skipping .crx (npx not available). Install Node.js for .crx packaging."
fi

echo ""
echo "=== Done ==="
