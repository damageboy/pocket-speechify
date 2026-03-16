#!/bin/bash
# Compute and stamp version into manifest.json.
# For tagged builds: uses the tag (e.g., v0.3.0 → 0.3.0)
# For untagged builds: uses manifest version + git describe (e.g., 0.2.0-3-gabcdef1-dirty)
#
# Outputs the computed version string to stdout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

# Check if we're on an exact tag
TAG=$(git describe --tags --exact-match 2>/dev/null || echo "")

if [ -n "$TAG" ]; then
  # Tagged build: strip leading 'v' if present
  VERSION="${TAG#v}"
else
  # Untagged build: base version + short hash + dirty flag
  BASE_VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
  SHORT_HASH=$(git rev-parse --short=7 HEAD)
  DIRTY=""
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    DIRTY="-dirty"
  fi
  VERSION="${BASE_VERSION}-${SHORT_HASH}${DIRTY}"
fi

# Update manifest.json with the computed version
# Chrome manifest version must be 1-4 dot-separated integers,
# so for untagged builds we set version_name (displayed) and keep version (numeric) as-is
if [ -n "$TAG" ]; then
  python3 -c "
import json
m = json.load(open('manifest.json'))
m['version'] = '$VERSION'
m.pop('version_name', None)
json.dump(m, open('manifest.json', 'w'), indent=2)
print('Stamped manifest version: $VERSION')
" >&2
else
  python3 -c "
import json
m = json.load(open('manifest.json'))
m['version_name'] = '$VERSION'
json.dump(m, open('manifest.json', 'w'), indent=2)
print('Stamped manifest version_name: $VERSION (version: ' + m['version'] + ')')
" >&2
fi

echo "$VERSION"
