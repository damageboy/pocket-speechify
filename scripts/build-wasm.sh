#!/bin/bash
# Build pocket-tts WASM binary and vendor into the extension.
# Prerequisites: Rust toolchain, wasm-pack (or wasm-bindgen-cli)
#
# Usage: ./scripts/build-wasm.sh
#
# This script:
# 1. Clones damageboy/pocket-tts to a temp directory
# 2. Builds the WASM target
# 3. Copies the WASM binary + JS glue into wasm/
#
# Per-language model, tokenizer, and voice assets are downloaded and cached
# lazily by the offscreen document at runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR=$(mktemp -d)

echo "=== Building pocket-tts WASM ==="
echo "Extension dir: $EXT_DIR"

# Step 1: Source — use local override if POCKET_TTS_REPO is set
if [ -n "${POCKET_TTS_REPO:-}" ]; then
  SRC_DIR="$(cd "$POCKET_TTS_REPO" && pwd)"
  echo "Using local repo: $SRC_DIR  (POCKET_TTS_REPO override)"
else
  SRC_DIR="$TMP_DIR/pocket-tts"
  echo "Temp dir: $TMP_DIR"
  echo ""
  echo "--- Cloning damageboy/pocket-tts ---"
  git clone --depth 1 https://github.com/damageboy/pocket-tts "$SRC_DIR"
fi

# Step 2: Build WASM
echo ""
echo "--- Building WASM (release) ---"
cd "$SRC_DIR"

# Check if wasm-pack is available, fall back to cargo + wasm-bindgen
if command -v wasm-pack &> /dev/null; then
  echo "Using wasm-pack..."
  wasm-pack build crates/pocket-tts --target web --release --out-dir "$TMP_DIR/wasm-out"
else
  echo "wasm-pack not found, using cargo + wasm-bindgen..."

  # Ensure wasm32 target is installed
  rustup target add wasm32-unknown-unknown 2>/dev/null || true

  # Build
  cargo build --target wasm32-unknown-unknown --release --features wasm -p pocket-tts

  # Check if wasm-bindgen is available
  if ! command -v wasm-bindgen &> /dev/null; then
    echo "ERROR: wasm-bindgen-cli not found. Install with:"
    echo "  cargo install wasm-bindgen-cli"
    exit 1
  fi

  mkdir -p "$TMP_DIR/wasm-out"
  wasm-bindgen \
    "$SRC_DIR/target/wasm32-unknown-unknown/release/pocket_tts.wasm" \
    --out-dir "$TMP_DIR/wasm-out" \
    --target web \
    --no-typescript
fi

# Step 3: Copy artifacts
echo ""
echo "--- Copying WASM artifacts ---"
mkdir -p "$EXT_DIR/public/wasm"
cp "$TMP_DIR/wasm-out/"*.wasm "$EXT_DIR/public/wasm/pocket_tts_bg.wasm"
cp "$TMP_DIR/wasm-out/"*.js "$EXT_DIR/public/wasm/pocket_tts.js"

echo "Copied:"
ls -lh "$EXT_DIR/public/wasm/"

# Cleanup
echo ""
echo "--- Cleaning up ---"
rm -rf "$TMP_DIR"

echo ""
echo "=== Done! WASM artifacts vendored to public/wasm/ ==="
echo "Next steps:"
echo "  1. Run npm run build"
echo "  2. Test multilingual playback in Chrome"
