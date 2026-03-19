#!/bin/bash
# Build pocket-tts WASM binary and vendor into the extension.
# Prerequisites: Rust toolchain, wasm-pack (or wasm-bindgen-cli)
#
# Usage: ./scripts/build-wasm.sh
#
# This script:
# 1. Clones babybirdprd/pocket-tts to a temp directory
# 2. Builds the WASM target
# 3. Copies the WASM binary + JS glue into wasm/
# 4. Downloads the tokenizer model from HuggingFace

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR=$(mktemp -d)

echo "=== Building pocket-tts WASM ==="
echo "Extension dir: $EXT_DIR"
echo "Temp dir: $TMP_DIR"

# Step 1: Clone
echo ""
echo "--- Cloning babybirdprd/pocket-tts ---"
git clone --depth 1 https://github.com/babybirdprd/pocket-tts "$TMP_DIR/pocket-tts"

# Step 2: Build WASM
echo ""
echo "--- Building WASM (release) ---"
cd "$TMP_DIR/pocket-tts"

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
    target/wasm32-unknown-unknown/release/pocket_tts.wasm \
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

# Step 4: Download tokenizer
echo ""
echo "--- Downloading tokenizer model ---"
if [ ! -f "$EXT_DIR/public/tokenizer.model" ]; then
  curl -L -o "$EXT_DIR/public/tokenizer.model" \
    "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main/tokenizer.model"
  echo "Downloaded tokenizer.model ($(wc -c < "$EXT_DIR/public/tokenizer.model") bytes)"
else
  echo "tokenizer.model already exists, skipping"
fi

# Cleanup
echo ""
echo "--- Cleaning up ---"
rm -rf "$TMP_DIR"

echo ""
echo "=== Done! WASM artifacts vendored to public/wasm/ ==="
echo "Next steps:"
echo "  1. Uncomment WASM integration in src/tts-worker.js"
echo "  2. Test the extension in Chrome"
