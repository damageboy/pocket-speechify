#!/bin/bash
# Package the extension into a .zip and .crx for distribution.
# Usage: ./scripts/package.sh [output-base]
#
# Produces:
#   pocket-speechify-{version}.zip  — for Chrome Web Store upload
#   pocket-speechify-{version}.crx  — for browsers that support direct .crx install
#
# The .crx uses a throwaway key (not for trust, just CRX3 format requirement).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

VERSION=$(bash scripts/stamp-version.sh)
BASE="${1:-pocket-speechify-${VERSION}}"
ZIP_OUTPUT="${BASE}.zip"
CRX_OUTPUT="${BASE}.crx"

echo ""
echo "=== Packaging extension v${VERSION} ==="

# Remove stale packages
rm -f "$ZIP_OUTPUT" "$CRX_OUTPUT"

# Build + zip via WXT
npx wxt zip 2>&1
# WXT outputs to .output/pocket-speechify-{version}-chrome.zip
WXT_ZIP=$(ls .output/*-chrome.zip 2>/dev/null | head -1)
if [ -z "$WXT_ZIP" ]; then
  echo "ERROR: wxt zip did not produce output"
  exit 1
fi
mv "$WXT_ZIP" "$ZIP_OUTPUT"

ZIP_SIZE=$(wc -c < "$ZIP_OUTPUT" | tr -d ' ')
ZIP_MB=$(echo "scale=1; $ZIP_SIZE / 1048576" | bc)
echo "Created: $ZIP_OUTPUT (${ZIP_MB}MB)"

# Create .crx from the built extension directory
# CRX3 format requires a key — use a throwaway one
if command -v npx &>/dev/null; then
  KEY_FILE="$EXT_DIR/key.pem"
  if [ ! -f "$KEY_FILE" ]; then
    openssl genrsa 2048 > "$KEY_FILE" 2>/dev/null
    echo "Generated throwaway CRX key: key.pem (not for trust, just format requirement)"
  fi
  npx --yes crx3 .output/chrome-mv3 --keyPath "$KEY_FILE" --crxPath "$EXT_DIR/$CRX_OUTPUT" 2>/dev/null
  if [ -f "$CRX_OUTPUT" ]; then
    CRX_SIZE=$(wc -c < "$CRX_OUTPUT" | tr -d ' ')
    CRX_MB=$(echo "scale=1; $CRX_SIZE / 1048576" | bc)
    echo "Created: $CRX_OUTPUT (${CRX_MB}MB)"
  else
    echo "Warning: .crx creation failed. .zip is still available."
  fi
else
  echo "Skipping .crx (npx not available)."
fi

echo ""
echo "=== Done ==="
