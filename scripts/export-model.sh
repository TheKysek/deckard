#!/bin/bash
# Maintainer step: produce the pinned ONNX model directory from the canonical q4
# checkpoint. Creates a private virtualenv with native-cli/onnx/requirements.txt.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -eq 1 ] || { echo 'Usage: scripts/export-model.sh OUTPUT_DIR' >&2; exit 1; }
OUTPUT=$(realpath -m -- "$1")
[ ! -e "$OUTPUT" ] || { echo "Refusing to overwrite $OUTPUT" >&2; exit 1; }
VENV="$ROOT/native-cli/onnx/.venv"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --extra-index-url https://download.pytorch.org/whl/cpu \
    -r "$ROOT/native-cli/onnx/requirements.txt"
fi
CANONICAL="$OUTPUT.canonical"
[ -d "$CANONICAL" ] || "$ROOT/scripts/fetch-canonical-model.sh" "$CANONICAL"
(cd "$ROOT/native-cli/onnx" && "$VENV/bin/python" export.py --canonical "$CANONICAL" --output "$OUTPUT")
node -e '
  const fs = require("node:fs");
  const pins = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).files;
  const made = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).files;
  if (JSON.stringify(pins) !== JSON.stringify(made)) {
    console.error("Exported files differ from native-cli/model-assets.json pins:", made);
    process.exit(1);
  }' "$ROOT/native-cli/model-assets.json" "$OUTPUT/export.json"
echo "Model directory matches the pinned assets: $OUTPUT"
