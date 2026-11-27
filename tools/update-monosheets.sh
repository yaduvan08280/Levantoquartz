#!/usr/bin/env bash
# Bring in the latest Mono Sheets. Run from this repository's root:
#
#   tools/update-monosheets.sh /path/to/monosheets
#
# server/monosheets is a straight copy of the monosheets project's public/
# folder — nothing in it is edited here, so updating is replacing it.
set -euo pipefail
src="${1:?Usage: tools/update-monosheets.sh /path/to/monosheets}"
[ -f "$src/public/index.html" ] || { echo "No public/index.html under $src" >&2; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$here/server/monosheets"
cp -r "$src/public" "$here/server/monosheets"
(cd "$src" && git rev-parse HEAD 2>/dev/null || echo unknown) > "$here/server/monosheets/.source-commit"
echo "Mono Sheets updated to $(cat "$here/server/monosheets/.source-commit")"
