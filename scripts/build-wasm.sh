#!/bin/bash
# Build pocket-tts WASM binary into the extension's generated public/wasm directory.
# Prerequisites: Rust toolchain, wasm-pack (or wasm-bindgen-cli)
#
# Usage: ./scripts/build-wasm.sh
#
# This script:
# 1. Uses a local pocket-tts checkout if POCKET_TTS_DIR (or legacy POCKET_TTS_REPO) is set
# 2. Otherwise clones damageboy/pocket-tts and checks out POCKET_TTS_REF
# 3. Builds the WASM target
# 4. Copies the WASM binary + JS glue into public/wasm/
#
# Per-language model, tokenizer, and voice assets are downloaded and cached
# lazily by the offscreen document at runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

POCKET_TTS_REPO_URL="${POCKET_TTS_REPO_URL:-https://github.com/damageboy/pocket-tts}"
POCKET_TTS_REF="${POCKET_TTS_REF:-d5159887defad3ac9694433c6c1047c065869b1d}"
LOCAL_POCKET_TTS_DIR="${POCKET_TTS_DIR:-${POCKET_TTS_REPO:-}}"

echo "=== Building pocket-tts WASM ==="
echo "Extension dir: $EXT_DIR"

# Step 1: Source — use local override if provided, otherwise clone pinned ref
if [ -n "$LOCAL_POCKET_TTS_DIR" ]; then
	SRC_DIR="$(cd "$LOCAL_POCKET_TTS_DIR" && pwd)"
	if [ -n "${POCKET_TTS_DIR:-}" ]; then
		echo "Using local repo: $SRC_DIR  (POCKET_TTS_DIR override)"
	else
		echo "Using local repo: $SRC_DIR  (legacy POCKET_TTS_REPO override)"
	fi
else
	SRC_DIR="$TMP_DIR/pocket-tts"
	echo "Temp dir: $TMP_DIR"
	echo ""
	echo "--- Cloning $POCKET_TTS_REPO_URL at $POCKET_TTS_REF ---"
	git init "$SRC_DIR"
	git -C "$SRC_DIR" remote add origin "$POCKET_TTS_REPO_URL"
	git -C "$SRC_DIR" fetch --depth 1 origin "$POCKET_TTS_REF"
	git -C "$SRC_DIR" checkout --detach FETCH_HEAD
fi

# Step 2: Build WASM
echo ""
echo "--- Building WASM (release) ---"
cd "$SRC_DIR"

# Check if wasm-pack is available, fall back to cargo + wasm-bindgen
if command -v wasm-pack &>/dev/null; then
	echo "Using wasm-pack..."
	wasm-pack build crates/pocket-tts --target web --release --out-dir "$TMP_DIR/wasm-out"
else
	echo "wasm-pack not found, using cargo + wasm-bindgen..."

	# Ensure wasm32 target is installed
	rustup target add wasm32-unknown-unknown 2>/dev/null || true

	# Build
	cargo build --target wasm32-unknown-unknown --release --features wasm -p pocket-tts

	# Check if wasm-bindgen is available
	if ! command -v wasm-bindgen &>/dev/null; then
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

echo ""
echo "=== Done! WASM artifacts generated in public/wasm/ ==="
echo "Next steps:"
echo "  1. Run npm run build"
echo "  2. Test multilingual playback in Chrome"
