#!/bin/bash
# Install pocket-tts WASM into the extension's generated public/wasm directory.
# Default prerequisites: Node.js, curl, tar, shasum.
# Source override prerequisites: Bun, Rust toolchain, wasm-pack (or wasm-bindgen-cli).
#
# Usage: ./scripts/build-wasm.sh
#
# This script:
# 1. Uses a local pocket-tts checkout if POCKET_TTS_DIR (or legacy POCKET_TTS_REPO) is set
# 2. Builds from source when POCKET_TTS_REF or POCKET_TTS_REPO_URL is set
# 3. Otherwise downloads the pinned public release and verifies its hash
# 4. Installs matching WASM + JS + models.json from the same package
#    (source builds generate the catalog from their own model definitions)
#
# Per-language model, tokenizer, and voice assets are downloaded and cached
# lazily by the offscreen document at runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

LOCAL_POCKET_TTS_DIR="${POCKET_TTS_DIR:-${POCKET_TTS_REPO:-}}"

if [ -z "$LOCAL_POCKET_TTS_DIR" ] && [ -z "${POCKET_TTS_REF:-}" ] && [ -z "${POCKET_TTS_REPO_URL:-}" ]; then
	# Republished v3.3.0 with timestamped streaming, source 1e0500de641338ba2c87f609ff47f7a10006f60f.
	RELEASE_URL=https://github.com/damageboy/pocket-tts/releases/download/v3.3.0/pocket-tts-v3.3.0-wasm-web.tar.gz
	RELEASE_SHA256=d03e1f6d770d81441144358718ae43fa73c1e945f33c1ce6c796b38df3fdd621
	echo "=== Downloading pinned pocket-tts v3.3.0 WASM release ==="
	if ! curl --fail --location --silent --show-error "$RELEASE_URL" > "$TMP_DIR/wasm-web.tar.gz"; then
		echo "ERROR: WASM release download failed. Check network access, or set POCKET_TTS_REF to build from source." >&2
		exit 1
	fi
	if ! echo "$RELEASE_SHA256  $TMP_DIR/wasm-web.tar.gz" | shasum -a 256 -c -; then
		echo "ERROR: WASM package checksum mismatch." >&2
		exit 1
	fi
	tar -xzf "$TMP_DIR/wasm-web.tar.gz" -C "$TMP_DIR" pocket_tts.js pocket_tts_bg.wasm models.json
	node -e 'const c = require(process.argv[1]); if (c.schemaVersion !== 1) throw new Error("Unsupported model catalog schema")' "$TMP_DIR/models.json"
	mkdir -p "$EXT_DIR/public/wasm"
	cp "$TMP_DIR/pocket_tts.js" "$TMP_DIR/pocket_tts_bg.wasm" "$TMP_DIR/models.json" "$EXT_DIR/public/wasm/"
	echo "=== Installed upstream WASM release in public/wasm/ ==="
	exit 0
fi

POCKET_TTS_REPO_URL="${POCKET_TTS_REPO_URL:-https://github.com/damageboy/pocket-tts}"
# Match the source commit used to build the pinned release above.
POCKET_TTS_REF="${POCKET_TTS_REF:-1e0500de641338ba2c87f609ff47f7a10006f60f}"

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

if ! command -v bun &>/dev/null || [ ! -f scripts/generate-model-catalog.ts ]; then
	echo "ERROR: Source builds require Bun and a pocket-tts checkout with the model catalog generator." >&2
	exit 1
fi

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

bun scripts/generate-model-catalog.ts "$TMP_DIR/wasm-out/models.json"

# Step 3: Copy artifacts
echo ""
echo "--- Copying WASM artifacts ---"
mkdir -p "$EXT_DIR/public/wasm"
cp "$TMP_DIR/wasm-out/"*.wasm "$EXT_DIR/public/wasm/pocket_tts_bg.wasm"
cp "$TMP_DIR/wasm-out/"*.js "$EXT_DIR/public/wasm/pocket_tts.js"
cp "$TMP_DIR/wasm-out/models.json" "$EXT_DIR/public/wasm/models.json"

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
