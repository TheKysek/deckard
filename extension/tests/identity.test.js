import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../core.js";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../manifest.json"));
const extensionId = "deckard@thekysek.github.io";

test("Firefox manifest pins the stable add-on ID shared with the native host", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.browser_specific_settings.gecko.id, extensionId);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "140.0");
  assert.deepEqual(manifest.background, { scripts: ["service-worker.js"], type: "module" });
  const nativeId = read("../../native-cli/src/support.hpp")
    .match(/\bdefault_extension_id\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(nativeId, extensionId);
});

test("Deckard brand, release version and native host remain consistent", () => {
  assert.equal(manifest.name, "Deckard");
  assert.equal(manifest.description, "Local AI-text detection for your browser.");
  assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.version, "0.7.0");
  const pkg = JSON.parse(read("../../package.json"));
  assert.equal(pkg.name, "deckard");
  assert.equal(pkg.version, manifest.version);
  const native = read("../../native-cli/src/support.hpp");
  assert.match(native, /app_version = "0\.7\.0"/);
  assert.match(native, /host_name = "com\.sgoedecke\.deckard"/);
  assert.match(read("../service-worker.js"), /connectNative\("com\.sgoedecke\.deckard"\)/);
  assert.match(read("../popup.html"), /<title>Deckard<\/title>/);
  assert.match(read("../icons/icon.svg"), /<title>Deckard<\/title>/);
});

test("public branding does not alter model identity, marking floor or page budget", () => {
  const C = globalThis.DeckardCore;
  assert.equal(C.PROTOCOL_VERSION, 3);
  assert.equal(C.MIN_WORDS, 50);
  assert.equal(C.MAX_PAGE_WORDS, 25000);
  assert.equal(C.FLAG_THRESHOLD, 0.97);
  assert.equal(C.MODEL_REVISION, "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f");
  assert.equal(C.validThreshold(0.7), true);
  assert.equal(C.validThreshold(0.99), true);
  assert.equal(C.validThreshold(0.699), false);
  assert.equal(C.validThreshold(0.991), false);
});
