#!/bin/bash
# Verify the Chrome extension has all required files and no obvious issues.
# Run by pre-commit hook and can be run standalone: ./scripts/verify-build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

ERRORS=0

check() {
  if [ ! -f "$1" ]; then
    echo "MISSING: $1"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "=== Verifying extension build ==="

# Core files
check "entrypoints/content.js"
check "entrypoints/background.js"
check "public/config.yaml"

# Source modules
check "src/remote-tts.js"
check "src/mock-tts.js"
check "src/state.js"
check "src/voices.js"
check "src/pill-player.js"
check "src/side-panels.js"
check "src/highlight.js"
check "src/hover-player.js"
check "src/scroll-nav.js"
check "src/content-extractor.js"
check "src/icons.js"
check "src/dom-utils.js"
check "src/logger.js"
check "src/word-timing-estimator.js"
check "public/tts-worker.js"

# CSS
check "public/css/player.css"

# WASM artifacts — rebuild if missing
if [ ! -f "public/wasm/pocket_tts_bg.wasm" ] || [ ! -f "public/wasm/pocket_tts.js" ]; then
  echo "WASM artifacts missing — attempting rebuild..."
  if command -v cargo &>/dev/null && command -v wasm-pack &>/dev/null; then
    bash scripts/build-wasm.sh
    if [ ! -f "public/wasm/pocket_tts_bg.wasm" ]; then
      echo "ERROR: WASM rebuild failed"
      ERRORS=$((ERRORS + 1))
    else
      echo "WASM rebuilt successfully"
    fi
  else
    echo "ERROR: public/wasm/pocket_tts_bg.wasm missing and cannot rebuild (need cargo + wasm-pack)"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "WASM artifacts present"
fi

# Tokenizer — download if missing
if [ ! -f "public/tokenizer.model" ]; then
  echo "public/tokenizer.model missing — downloading..."
  curl -sL -o public/tokenizer.model \
    "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main/tokenizer.model"
  echo "Downloaded tokenizer.model"
fi
check "public/tokenizer.model"

# Voice avatars
for voice in alba marius javert jean fantine cosette eponine azelma; do
  check "public/assets/voices/${voice}.webp"
done

# Check JS files for syntax errors (using node if available)
if command -v node &>/dev/null; then
  for js in entrypoints/content.js entrypoints/background.js src/*.js; do
    if ! node --check "$js" 2>/dev/null; then
      echo "SYNTAX ERROR: $js"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# Check package.json version
VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")
echo "Extension version: $VERSION"

# Check WASM binary size (should be > 1MB)
WASM_SIZE=$(wc -c < public/wasm/pocket_tts_bg.wasm)
if [ "$WASM_SIZE" -lt 1000000 ]; then
  echo "ERROR: wasm/pocket_tts_bg.wasm is too small ($WASM_SIZE bytes) — may be corrupt"
  ERRORS=$((ERRORS + 1))
fi

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "=== FAILED: $ERRORS error(s) found ==="
  exit 1
fi

echo "=== All checks passed ==="
