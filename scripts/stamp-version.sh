#!/bin/bash
# Compute version string for packaging.
# For tagged builds: uses the tag (e.g., v0.3.0 → 0.3.0)
# For untagged builds: uses package.json version + git hash (e.g., 0.2.0-abcdef1-dirty)
#
# Outputs the computed version string to stdout.
# WXT generates manifest.json at build time from wxt.config.js — no manifest stamping needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

# Check if we're on an exact tag
TAG=$(git describe --tags --exact-match 2>/dev/null || echo "")

if [ -n "$TAG" ]; then
  VERSION="${TAG#v}"
else
  BASE_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")
  SHORT_HASH=$(git rev-parse --short=7 HEAD)
  DIRTY=""
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    DIRTY="-dirty"
  fi
  VERSION="${BASE_VERSION}-${SHORT_HASH}${DIRTY}"
fi

echo "$VERSION"
