#!/bin/bash
# Sign the Firefox add-on through addons.mozilla.org as an unlisted (self-distributed)
# extension, so release Firefox can install it permanently. Requires AMO API
# credentials: https://addons.mozilla.org/developers/addon/api/key/
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${WEB_EXT_API_KEY:?Set WEB_EXT_API_KEY (AMO JWT issuer).}"
: "${WEB_EXT_API_SECRET:?Set WEB_EXT_API_SECRET (AMO JWT secret).}"
OUTPUT="${1:-$ROOT/dist/signed}"
mkdir -p "$OUTPUT"
exec npx --yes web-ext@10 sign --channel unlisted \
  --source-dir "$ROOT/extension" --ignore-files 'tests/**' \
  --artifacts-dir "$OUTPUT"
