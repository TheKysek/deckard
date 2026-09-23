# Deckard

Named after the original AI hunter in _Blade Runner_, Deckard is a Firefox extension that detects AI-generated text on pages you visit.

![Deckard marking passages red on EndlessWiki](docs/images/deckard-endlesswiki.jpg)

This fork targets **Firefox on Linux** (x86_64; aarch64 from source). The
original Chrome/macOS (Core ML) version lives upstream at
[sgoedecke/deckard](https://github.com/sgoedecke/deckard).

## Getting started

Install [Deckard v0.7.0](https://github.com/thekysek/deckard/releases/tag/v0.7.0)
from your terminal:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/thekysek/deckard/releases/download/v0.7.0/install.sh | bash
```

This installs the native helper and model into `~/Deckard` and registers it with
Firefox (`~/.mozilla/native-messaging-hosts/com.sgoedecke.deckard.json`). Then add
the extension to Firefox (140 or newer) in one of these ways:

- **Signed add-on (permanent).** If the release has a signed
  `deckard-v0.7.0-signed.xpi`, open it in Firefox (or drag it onto a Firefox
  window) and confirm. Release Firefox only permanently installs add-ons signed by
  Mozilla; see [signing](#signing-the-add-on) to make your own.
- **Temporary (any Firefox, no signing).** Open `about:debugging#/runtime/this-firefox`,
  choose **Load Temporary Add-on…**, and select `~/Deckard/extension/manifest.json`.
  Firefox removes temporary add-ons when it restarts, so repeat this after each restart.
- **Unsigned install (Developer Edition, Nightly or ESR).** Set
  `xpinstall.signatures.required` to `false` in `about:config`, then open the
  unsigned `deckard-v0.7.0.xpi` from the release. Regular Firefox ignores this preference.

Finally, open the Deckard toolbar popup and switch it **On**. Firefox asks you to
allow access to all websites; Deckard needs this to read pages. Pin Deckard to the
toolbar so you can see its badge.

Firefox from **Snap** (the Ubuntu default) or **Flatpak** runs in a sandbox that may
not be able to start native helpers. If the popup reports that it cannot reach
the helper, install Firefox from Mozilla's tarball or a distribution `.deb`/`.rpm`.

The installer defaults to `~/Deckard`; `--home DIR` selects a different location.
Do not move the folder manually: the native-host registration and shell PATH refer
to its installed location. For bash, the PATH block goes in `~/.bashrc`; for zsh,
in `~/.zshrc`.

## How it works

Deckard runs the [Gradient](docs/MODEL-ATTRIBUTION.md) model on your computer's CPU
with ONNX Runtime. When you visit a page, the extension splits it into chunks and
sends them to the local helper for scoring. The helper uses up to half of your CPU
cores and about 500 MB of memory while Firefox is open. A full 512-token chunk
takes roughly 1.5–3 seconds on a typical 4–8 core laptop, so long pages fill in
gradually.

## Limitations

This is obviously much less reliable than [Pangram](https://www.pangram.com/) (which at the time of writing is the only good AI detector), but (a) it runs entirely locally, and (b) you can use it as much as you want for free.

I've set the default detection threshold to 97%, which gives a low false-positive rate, but that's configurable via the extension slider. Please don't use this as proof of AI usage; if you want to do that, paste it in to Pangram.

Deckard only scans in 50 word chunks, so short AI-generated content is harder to detect (since it'll be chunked with other text on the page).

## Uninstall

Run `deckard uninstall` (or `"$HOME/Deckard/current/bin/deckard" uninstall` if PATH
was not configured). It removes Deckard's managed installation files, owned PATH
block and native-host registration. Then remove Deckard in `about:addons`; the CLI
cannot remove a Firefox add-on.

## Development

This (aside from the README above this point) is entirely vibe-coded, so contribute by hand at your own risk.

Use a current Node.js with the built-in test runner:

```sh
npm test
npm run lint:firefox   # web-ext lint (downloads web-ext through npx)
```

Extension tests need no npm dependencies. To load your working copy, use
`about:debugging` → **Load Temporary Add-on…** → `extension/manifest.json`. It uses
the same add-on ID as the release, so remove the installed copy first.

### Native helper

Building needs CMake, a C++20 compiler and curl. `native-cli/bootstrap.sh`
downloads pinned, checksum-verified dependencies into `cache/native-build`:
ONNX Runtime 1.22.0, nlohmann/json and a Rust 1.90.0 toolchain for the tokenizer.

```sh
scripts/build-native.sh                     # builds native-cli/build/dist
native-cli/build/dist/bin/deckard self-test
```

### Model

The helper runs an ONNX export of Deckard's canonical Gradient q4 checkpoint (the
same weights as the upstream Core ML release). The export is reproducible, and
`native-cli/model-assets.json` pins its SHA-256 hashes:

```sh
scripts/export-model.sh /tmp/deckard-model   # fetches the canonical q4 checkpoint,
                                             # exports, verifies parity and pins
```

`scripts/fetch-canonical-model.sh` downloads the q4 checkpoint from the pinned
upstream v0.5.0 release. `native-cli/onnx/export.py` then builds the graph and
checks it against a PyTorch reference (max score error ≤ 0.001) before writing
`model.onnx`, `model.onnx.data`, `tokenizer.json` and `fixtures.json`.

```sh
DECKARD_MODEL_DIR=/tmp/deckard-model npm run test:native
native-cli/build/dist/bin/deckard verify --model /tmp/deckard-model --fixtures native-cli/onnx/fixtures.json
scripts/package-release.sh --model-dir /tmp/deckard-model
```

Packaging writes `dist/v0.7.0/` for the build machine's architecture:
`deckard-v0.7.0-linux-<arch>.tar.gz` (with model), `…-app.tar.gz` (without
model, used when the installed model already matches), `install.sh`, the unsigned
`deckard-v0.7.0.xpi` and `SHA256SUMS`. Upload them as release assets.
`DECKARD_RELEASE_DIR=dist/v0.7.0 node --test tests/release.test.mjs` exercises the
packaged installer end to end in an isolated HOME. Without `DECKARD_MODEL_DIR`,
native model-installation tests are explicitly skipped. The separately invoked
`native-cli/tests/model-smoke.mjs` takes an installed CLI path and a new receipt
path, and reports latency and resident memory.

### Signing the add-on

Create AMO API credentials at <https://addons.mozilla.org/developers/addon/api/key/>, then:

```sh
WEB_EXT_API_KEY=user:... WEB_EXT_API_SECRET=... npm run sign:firefox
```

This signs the extension as **unlisted** (self-distributed; it is not published on
addons.mozilla.org) and writes the signed `.xpi` to `dist/signed/`. Upload it
alongside the release as `deckard-v0.7.0-signed.xpi`. The add-on ID
`deckard@thekysek.github.io` must stay stable: the native helper only answers
that ID.

See [native protocol](docs/NATIVE-PROTOCOL.md) for framing and model identity.
Research datasets, experiment outputs and model weights are not committed.

## License

Deckard is [MIT licensed](LICENSE). Gradient and its Microsoft DeBERTa-v3-large
base are MIT-licensed upstream. ONNX Runtime is MIT-licensed; its notices ship
in `share/licenses/onnxruntime`.
