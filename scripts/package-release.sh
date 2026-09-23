#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec nice -n 10 node "$ROOT/scripts/package-release.mjs" "$@"
