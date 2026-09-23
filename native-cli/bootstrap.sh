#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CACHE="${NATIVE_CACHE:-$ROOT/cache/native-build}"
DOWNLOADS="$CACHE/downloads"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    TRIPLE=x86_64-unknown-linux-gnu; ORT_ARCH=x64
    ORT_SHA256=8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3 ;;
  Linux/aarch64|Linux/arm64)
    TRIPLE=aarch64-unknown-linux-gnu; ORT_ARCH=aarch64
    ORT_SHA256=bb76395092d150b52c7092dc6b8f2fe4d80f0f3bf0416d2f269193e347e24702 ;;
  *) echo "Deckard's native host requires Linux on x86_64 or aarch64." >&2; exit 1 ;;
esac
ORT_NAME="onnxruntime-linux-$ORT_ARCH-1.22.0"
command -v cmake >/dev/null || { echo "Install CMake first (for example: sudo apt install cmake)." >&2; exit 1; }
command -v c++ >/dev/null || { echo "Install a C++20 compiler first (for example: sudo apt install g++)." >&2; exit 1; }
if [ "$CACHE" != "$ROOT/cache/native-build" ]; then
  for required in json/include/nlohmann/json.hpp cargo/registry \
    "rustup/toolchains/1.90.0-$TRIPLE/bin/cargo" \
    "onnxruntime/$ORT_NAME/lib/libonnxruntime.so.1.22.0" \
    licenses/NLOHMANN-LICENSE; do
    [ -e "$CACHE/$required" ] || {
      echo "External NATIVE_CACHE is read-only and incomplete: $required" >&2
      exit 1
    }
  done
  echo "Using existing read-only native dependencies in $CACHE"
  exit 0
fi
mkdir -p "$DOWNLOADS"
mkdir -p "$CACHE/json/include/nlohmann" "$CACHE/licenses" "$CACHE/onnxruntime"

fetch() {
  url=$1
  file=$2
  expected=$3
  if [ ! -f "$file" ]; then
    curl --fail --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 30 --max-time 900 --output "$file.partial" "$url"
    actual=$(sha256sum "$file.partial" | cut -d' ' -f1)
    [ "$actual" = "$expected" ] || { echo "Download checksum mismatch." >&2; exit 1; }
    mv "$file.partial" "$file"
  fi
  actual=$(sha256sum "$file" | cut -d' ' -f1)
  [ "$actual" = "$expected" ] || { echo "Cached dependency checksum mismatch: $file" >&2; exit 1; }
}

fetch 'https://raw.githubusercontent.com/nlohmann/json/9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03/single_include/nlohmann/json.hpp' \
  "$CACHE/json/include/nlohmann/json.hpp" 9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6
fetch 'https://raw.githubusercontent.com/nlohmann/json/9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03/LICENSE.MIT' \
  "$CACHE/licenses/NLOHMANN-LICENSE" 86b998c792894ccb911a1cb7994f7a9652894e7a094c0b5e45be2f553f45cf14
fetch 'https://huggingface.co/ShantanuT01/gradient-ai-text-detector/raw/c2e8b6df87f8a211cbffb713fa9873a0c3a9713f/README.md' \
  "$CACHE/licenses/GRADIENT-MODEL-CARD.md" a147869ab24ad59172bcdc7cc69cf716c646ddf0745a0e1fbb12515a2c6e752a
fetch "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/$ORT_NAME.tgz" \
  "$DOWNLOADS/$ORT_NAME.tgz" "$ORT_SHA256"
if [ ! -f "$CACHE/onnxruntime/$ORT_NAME/lib/libonnxruntime.so.1.22.0" ]; then
  rm -rf "$CACHE/onnxruntime/$ORT_NAME"
  tar -xzf "$DOWNLOADS/$ORT_NAME.tgz" -C "$CACHE/onnxruntime"
fi

export CARGO_HOME="$CACHE/cargo"
export RUSTUP_HOME="$CACHE/rustup"
export RUSTUP_TOOLCHAIN=1.90.0
export CARGO_BUILD_JOBS=2
if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  rustup_url="https://static.rust-lang.org/rustup/archive/1.28.2/$TRIPLE/rustup-init"
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$DOWNLOADS/rustup-init.sha256" "$rustup_url.sha256"
  rustup_sha=$(cut -d' ' -f1 "$DOWNLOADS/rustup-init.sha256")
  [ "${#rustup_sha}" -eq 64 ] || { echo "Invalid Rust bootstrap checksum." >&2; exit 1; }
  case "$rustup_sha" in *[!0-9a-f]*) echo "Invalid Rust bootstrap checksum." >&2; exit 1 ;; esac
  fetch "$rustup_url" "$DOWNLOADS/rustup-init" "$rustup_sha"
  chmod 700 "$DOWNLOADS/rustup-init"
  "$DOWNLOADS/rustup-init" -y --no-modify-path --profile minimal --default-toolchain 1.90.0
fi
"$CARGO_HOME/bin/rustc" --version
"$CARGO_HOME/bin/cargo" fetch --locked --manifest-path "$ROOT/native-cli/tokenizer/Cargo.toml"
echo "Native dependencies ready in $CACHE"
