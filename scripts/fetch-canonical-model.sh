#!/bin/bash
# Fetch Deckard's canonical Gradient q4 checkpoint (packed.safetensors) and
# tokenizer from the pinned v0.5.0 release. They are the source for the ONNX
# export (native-cli/onnx/export.py). The q4 file cannot be regenerated
# bit-for-bit on Linux, so it is reused verbatim and verified by SHA-256.
set -euo pipefail
[ "$#" -eq 1 ] || { echo 'Usage: scripts/fetch-canonical-model.sh OUTPUT_DIR' >&2; exit 1; }
OUTPUT=$1
[ ! -e "$OUTPUT" ] || { echo "Refusing to overwrite $OUTPUT" >&2; exit 1; }
URL='https://github.com/sgoedecke/deckard/releases/download/v0.5.0/deckard-v0.5.0-macos-arm64.tar.gz'
ARCHIVE_SHA256=ea2f77d4e63e1e6b5682f6afec757a8b486414622e75bbba0ac4e9442434a96f
PACKED_SHA256=85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98
TOKENIZER_SHA256=4b4f60231058db4b5794e7b124bb7945bc8ade6719282de4d2e0372ee527b929

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --connect-timeout 30 --max-time 1800 --output "$WORK/release.tar.gz" "$URL"
echo "$ARCHIVE_SHA256  $WORK/release.tar.gz" | sha256sum --check --quiet
tar -xzf "$WORK/release.tar.gz" -C "$WORK" models/packed.safetensors models/tokenizer.json
echo "$PACKED_SHA256  $WORK/models/packed.safetensors" | sha256sum --check --quiet
echo "$TOKENIZER_SHA256  $WORK/models/tokenizer.json" | sha256sum --check --quiet
mkdir -p "$(dirname -- "$OUTPUT")"
mv "$WORK/models" "$OUTPUT"
echo "Canonical Gradient q4 checkpoint ready in $OUTPUT"
