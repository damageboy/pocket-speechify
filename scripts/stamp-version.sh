#!/bin/bash
# Compute and stamp version into manifest.json.
# For tagged builds: uses the tag (e.g., v0.3.0 → 0.3.0)
# For untagged builds: uses manifest version + git hash (e.g., 0.2.0-abcdef1-dirty)
#
# Outputs the computed version string to stdout.
# No Python dependency — uses node for JSON manipulation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

# Check if we're on an exact tag
TAG=$(git describe --tags --exact-match 2>/dev/null || echo "")

if [ -n "$TAG" ]; then
  VERSION="${TAG#v}"
else
  BASE_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
  SHORT_HASH=$(git rev-parse --short=7 HEAD)
  DIRTY=""
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    DIRTY="-dirty"
  fi
  VERSION="${BASE_VERSION}-${SHORT_HASH}${DIRTY}"
fi

# Stamp into manifest.json
if [ -n "$TAG" ]; then
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('manifest.json','utf8'));
    m.version = '$VERSION';
    delete m.version_name;
    fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
    process.stderr.write('Stamped manifest version: $VERSION\n');
  "
else
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('manifest.json','utf8'));
    m.version_name = '$VERSION';
    fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
    process.stderr.write('Stamped manifest version_name: $VERSION (version: ' + m.version + ')\n');
  "
fi

echo "$VERSION"
