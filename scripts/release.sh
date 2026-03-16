#!/bin/bash
# Cut a release: update manifest.json version, commit, and create the git tag.
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.3.0
#
# After running, push to trigger CI:
#   git push && git push --tags

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$EXT_DIR"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.3.0"
  exit 1
fi

# Chrome extension versions must be a.b, a.b.c, or a.b.c.d with numeric parts
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+(\.[0-9]+)?(\.[0-9]+)?$'; then
  echo "ERROR: Version must be numeric (e.g., 0.3.0 or 1.0.0.1)"
  exit 1
fi

TAG="v${VERSION}"

# Require clean working tree
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes present. Commit or stash first."
  exit 1
fi

# Require tag to not already exist
if git tag | grep -qx "${TAG}"; then
  echo "ERROR: Tag ${TAG} already exists."
  exit 1
fi

echo "=== Releasing ${TAG} ==="

# Stamp version into manifest.json
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  m.version = '$VERSION';
  delete m.version_name;
  fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
"
echo "Stamped manifest.json: version = ${VERSION}"

git add manifest.json
git commit -m "chore: release ${TAG}"
git tag "${TAG}"

echo ""
echo "Done. Push the release with:"
echo "  git push && git push --tags"
