import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { archiveSizeLimit, modelFiles } from "../scripts/release-assets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = process.env.DECKARD_RELEASE_DIR;
const available = !!release && fs.existsSync(path.join(release, "SHA256SUMS"));

test("real release archive installs, upgrades, uninstalls and reinstalls through a piped bootstrap in isolated HOME",
  { skip: !available }, t => {
    const scratch = fs.mkdtempSync(path.join(root, "dist/release-acceptance-"));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const user = path.join(scratch, "isolated home");
    const commands = path.join(scratch, "mock commands");
    fs.mkdirSync(user);
    fs.mkdirSync(commands);
    const profile = path.join(user, ".zshrc");
    const original = "# unrelated settings\nexport PERSONAL_TEST_SETTING=preserved";
    fs.writeFileSync(profile, original);
    const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
    const archiveName = `deckard-v0.7.0-linux-${arch}.tar.gz`;
    const appArchiveName = `deckard-v0.7.0-linux-${arch}-app.tar.gz`;
    const archive = path.resolve(release, archiveName);
    const appArchive = path.resolve(release, appArchiveName);
    assert.ok(fs.statSync(archive).size < archiveSizeLimit);
    assert.ok(fs.statSync(appArchive).size < fs.statSync(archive).size / 10);
    const listing = spawnSync("/usr/bin/tar", ["-tzf", archive], {
      encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(listing.status, 0, listing.stderr);
    const entries = new Set(listing.stdout.trim().split("\n"));
    for (const name of modelFiles) assert.ok(entries.has(`models/${name}`), `Missing packaged asset: ${name}`);
    assert.ok(entries.has("share/licenses/model-assets.json"));
    assert.ok(entries.has("lib/libonnxruntime.so.1"));
    assert.doesNotMatch(listing.stdout, /packed\.safetensors|mlpackage|libmlx\.dylib|mlx\.metallib|MLX-LICENSE/);
    const appListing = spawnSync("/usr/bin/tar", ["-tzf", appArchive], { encoding: "utf8", timeout: 120000 });
    assert.equal(appListing.status, 0, appListing.stderr);
    assert.doesNotMatch(appListing.stdout, /^models(?:\/|$)/m);
    for (const name of ["bin/deckard", "lib/libonnxruntime.so.1", "extension/popup.html", "share/licenses/model-assets.json"]) {
      assert.ok(appListing.stdout.split("\n").includes(name));
    }
    const script = fs.readFileSync(path.join(release, "install.sh"), "utf8");
    const curlLog = path.join(scratch, "curl.log");
    fs.writeFileSync(path.join(commands, "curl"), `#!/bin/bash
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    https:*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ -n "$output" ]
printf '%s\\n' "$url" >> "$CURL_LOG"
case "$url" in
  "https://github.com/thekysek/deckard/releases/download/v0.7.0/${archiveName}") cp "$RELEASE_ARCHIVE" "$output" ;;
  "https://github.com/thekysek/deckard/releases/download/v0.7.0/${appArchiveName}") cp "$APP_ARCHIVE" "$output" ;;
  *) exit 1 ;;
esac
if [ -n "\${MUTATE_MODEL:-}" ]; then printf 'changed during download' > "$MUTATE_MODEL"; fi
`, { mode: 0o700 });
    const env = { ...process.env, HOME: user, SHELL: "/bin/zsh", ZDOTDIR: user,
      PATH: `${commands}:/usr/bin:/bin:/usr/sbin:/sbin`, RELEASE_ARCHIVE: archive, APP_ARCHIVE: appArchive, CURL_LOG: curlLog };
    delete env.DECKARD_HOME;
    const run = (command, args, input) => spawnSync(command, args, {
      cwd: scratch, env, input, encoding: "utf8", timeout: 300000, maxBuffer: 1024 * 1024,
    });
    const hashes = spawnSync("sha256sum", ["-c", "SHA256SUMS"], {
      cwd: release, encoding: "utf8", timeout: 120000,
    });
    assert.equal(hashes.status, 0, hashes.stderr);
    const denied = run("/bin/bash", ["-s", "--", "--no-open", "--shell", "zsh"], script);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /No controlling terminal/);
    assert.ok(!fs.existsSync(curlLog));
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    const install = () => run("/bin/bash", ["-s", "--", "--yes", "--no-open", "--shell", "zsh"], script);
    const prefix = path.join(user, "Deckard");
    const binary = path.join(prefix, "current/bin/deckard");
    const registration = path.join(user, ".mozilla/native-messaging-hosts/com.sgoedecke.deckard.json");
    let result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /about:debugging/);
    assert.match(result.stdout, /Load Temporary Add-on/);
    const firstProfile = fs.readFileSync(profile, "utf8");
    const extension = JSON.parse(fs.readFileSync(path.join(prefix, "extension/manifest.json")));
    assert.equal(extension.name, "Deckard");
    assert.equal(extension.version, "0.7.0");
    for (const name of ["core.js", "content.js", "service-worker.js", "popup.html", "popup.js", "popup.css"]) {
      assert.equal(fs.readFileSync(path.join(prefix, "extension", name), "utf8"),
        fs.readFileSync(path.join(root, "extension", name), "utf8"), `Installed extension file is stale: ${name}`);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prefix, "current/share/licenses/model-assets.json"))),
      JSON.parse(fs.readFileSync(path.join(root, "native-cli/model-assets.json"))));
    assert.deepEqual(JSON.parse(fs.readFileSync(registration)).allowed_extensions, ["deckard@thekysek.github.io"]);
    const status = run(binary, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).installation.product, "Deckard");
    if (process.env.DECKARD_SMOKE_RECEIPT) {
      const smoke = run(process.execPath, [path.join(root, "native-cli/tests/model-smoke.mjs"),
        binary, path.resolve(process.env.DECKARD_SMOKE_RECEIPT)]);
      assert.equal(smoke.status, 0, smoke.stderr);
    }
    // A reinstall reuses the installed model through the app-only archive.
    const previous = fs.readlinkSync(path.join(prefix, "current"));
    result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed model checksums match/);
    assert.equal(fs.readlinkSync(path.join(prefix, "current")), previous);
    assert.equal(fs.readFileSync(profile, "utf8"), firstProfile);
    const current = fs.readlinkSync(path.join(prefix, "current"));
    const tokenizer = path.join(prefix, current, "models/tokenizer.json");
    const originalTokenizer = fs.readFileSync(tokenizer);
    env.MUTATE_MODEL = tokenizer;
    result = install();
    delete env.MUTATE_MODEL;
    assert.equal(result.status, 1);
    assert.match(result.stderr, /asset_mismatch/);
    assert.equal(fs.readlinkSync(path.join(prefix, "current")), current);
    fs.writeFileSync(tokenizer, originalTokenizer);
    const inode = fs.statSync(path.join(prefix, ".install.lock")).ino;
    fs.writeFileSync(path.join(prefix, "personal.txt"), "unrelated");
    result = run(binary, ["uninstall"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    assert.ok(!fs.existsSync(registration));
    assert.ok(!fs.existsSync(path.join(prefix, "extension")));
    assert.ok(!fs.existsSync(binary));
    assert.equal(fs.readFileSync(path.join(prefix, "personal.txt"), "utf8"), "unrelated");
    result = install();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(path.join(prefix, ".install.lock")).ino, inode);
    result = run(binary, ["uninstall"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    assert.ok(!fs.readdirSync(scratch).some(name => name.startsWith(".deckard-bootstrap.")));
    assert.deepEqual(fs.readFileSync(curlLog, "utf8").trim().split("\n").map(url => url.split("/").at(-1)),
      [archiveName, appArchiveName, appArchiveName, archiveName]);
  });
