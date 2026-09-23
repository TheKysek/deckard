import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  archiveSizeLimit, checkArchiveSize, copyAssets, modelFiles, validatePins, verifyAssets, renderInstaller, zipArchive,
  extensionFiles,
} from '../scripts/release-assets.mjs';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const canonical = JSON.parse(await fs.readFile(path.join(root, 'native-cli/model-assets.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.release-assets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input');
  const destination = path.join(directory, 'output');
  const hashes = {};
  for (const name of modelFiles) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), name);
    hashes[name] = digest(name);
  }
  return { source, destination, hashes };
}

test('release asset pins are the ONNX export of the canonical q4 weights', () => {
  assert.deepEqual(Object.keys(validatePins(canonical)).sort(), [...modelFiles].sort());
  assert.equal(canonical.source_weights_sha256, '85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98');
  assert.equal(canonical.files['tokenizer.json'], '4b4f60231058db4b5794e7b124bb7945bc8ade6719282de4d2e0372ee527b929');
  for (const mutate of [
    pins => { pins.runtime = 'native-coreml'; },
    pins => { pins.format = 1; },
    pins => { pins.onnxruntime = '1.23.0'; },
    pins => { pins.files['../escape'] = '0'.repeat(64); },
    pins => { delete pins.files['tokenizer.json']; },
    pins => { pins.files['tokenizer.json'] = 'wrong'; },
    pins => { pins.model_file = '../model.onnx'; },
  ]) {
    const pins = structuredClone(canonical);
    mutate(pins);
    assert.throws(() => validatePins(pins), /Invalid ONNX/);
  }
});

test('copies only pinned nested files and checks the copied bytes', async t => {
  const { source, destination, hashes } = await fixture(t);
  await fs.writeFile(path.join(source, 'packed.safetensors'), 'do not ship');
  await copyAssets(source, destination, hashes);
  await verifyAssets(destination, hashes);
  await assert.rejects(fs.stat(path.join(destination, 'packed.safetensors')), { code: 'ENOENT' });
  for (const name of modelFiles) {
    assert.equal(await fs.readFile(path.join(destination, name), 'utf8'), name);
  }
});

test('every pinned asset must have its exact checksum', async t => {
  const { source, hashes } = await fixture(t);
  for (const name of modelFiles) {
    await fs.writeFile(path.join(source, name), 'tampered');
    await assert.rejects(verifyAssets(source, hashes), /Canonical model checksum mismatch/);
    await fs.writeFile(path.join(source, name), name);
  }
});

test('rejects symlinks in model directory, package components and leaf files', async t => {
  const { source, destination, hashes } = await fixture(t);
  await fs.symlink(source, destination);
  await assert.rejects(verifyAssets(destination, hashes), /links and special files/);
  for (const name of ['model.onnx', 'model.onnx.data', 'tokenizer.json']) {
    const file = path.join(source, name);
    const saved = `${file}.original`;
    await fs.rename(file, saved);
    await fs.symlink(saved, file);
    await assert.rejects(verifyAssets(source, hashes), /links and special files/);
    await fs.unlink(file);
    await fs.rename(saved, file);
  }
});

test('rejects traversal and absolute asset paths before copying', async t => {
  const { source, destination } = await fixture(t);
  for (const name of ['../escape', '/absolute', 'models/../escape', './tokenizer.json', 'models//file']) {
    await assert.rejects(copyAssets(source, destination, { [name]: '0'.repeat(64) }), /Unsafe model asset path/);
  }
});

test('nested copying cannot follow destination symlinks or overwrite existing files', async t => {
  const { source, destination, hashes } = await fixture(t);
  await fs.symlink(source, destination);
  await assert.rejects(copyAssets(source, destination, hashes), /Unsafe model asset destination/);
  await fs.unlink(destination);
  await fs.mkdir(destination);
  await fs.mkdir(path.join(source, 'nested'));
  await fs.writeFile(path.join(source, 'nested/file'), 'nested');
  const nested = { 'nested/file': createHash('sha256').update('nested').digest('hex') };
  await fs.symlink(source, path.join(destination, 'nested'));
  await assert.rejects(copyAssets(source, destination, nested), /Unsafe model asset destination/);
  await fs.unlink(path.join(destination, 'nested'));
  await fs.writeFile(path.join(destination, 'tokenizer.json'), 'existing');
  await assert.rejects(copyAssets(source, destination, hashes), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(destination, 'tokenizer.json'), 'utf8'), 'existing');
  await verifyAssets(source, hashes);
});

test('archive is strictly below the GitHub 2 GiB asset limit', () => {
  assert.equal(checkArchiveSize(archiveSizeLimit - 1), archiveSizeLimit - 1);
  assert.equal(checkArchiveSize(933 * 1024 ** 2), 933 * 1024 ** 2);
  for (const bytes of [0, -1, archiveSizeLimit, archiveSizeLimit + 1, NaN]) {
    assert.throws(() => checkArchiveSize(bytes), /must be under 2147483648 bytes/);
  }
});

test('installer embeds independent archive hashes and canonical model checksums', async () => {
  const template = await fs.readFile(path.join(root, 'install.sh'), 'utf8');
  const values = { archiveSha256: 'a'.repeat(64), appSha256: 'b'.repeat(64), pins: canonical, arch: 'x86_64' };
  const installer = renderInstaller(template, values);
  assert.ok(installer.includes(`expected='${values.archiveSha256}'`));
  assert.ok(installer.includes(`app_expected='${values.appSha256}'`));
  assert.ok(installer.includes(`release_arch='x86_64'`));
  for (const [name, hash] of Object.entries(canonical.files)) assert.ok(installer.includes(`${hash}  ${name}`));
  assert.doesNotMatch(installer, /@[A-Z_]+@/);
  for (const placeholder of ['@ARCH@', '@ARCHIVE_SHA256@', '@APP_ARCHIVE_SHA256@', '@MODEL_SHA256SUMS@']) {
    assert.throws(() => renderInstaller(template.replace(placeholder, ''), values), /exactly one/);
    assert.throws(() => renderInstaller(template + placeholder, values), /exactly one/);
  }
  assert.throws(() => renderInstaller(template, { ...values, appSha256: 'invalid' }), /Invalid archive/);
  assert.throws(() => renderInstaller(template, { ...values, pins: {} }), /Invalid ONNX/);
  assert.throws(() => renderInstaller(template, { ...values, arch: 'arm64' }), /Invalid release architecture/);
});

test('release versions and production packaging remain aligned', async () => {
  for (const name of ['package.json', 'extension/manifest.json']) {
    assert.equal(JSON.parse(await fs.readFile(path.join(root, name), 'utf8')).version, '0.7.0');
  }
  const script = await fs.readFile(path.join(root, 'scripts/package-release.mjs'), 'utf8');
  assert.match(script, /const version = '0\.7\.0'/);
  assert.match(script, /lib\/libonnxruntime\.so\.1/);
  assert.match(script, /zipArchive\(await extensionFiles/);
  assert.match(script, /native-cli\/model-assets\.json/);
  assert.match(script, /share\/licenses\/model-assets\.json/);
  assert.match(script, /checkArchiveSize\(\(await fs.stat\(archive\)\).size\)/);
  assert.match(script, /entries\.filter\(name => !name\.startsWith\('models\/'\)\)/);
  assert.match(script, /renderInstaller\(template/);
  assert.doesNotMatch(script, /libmlx\.dylib|mlx\.metallib|packed\.safetensors|codesign|mlpackage/);
});

test('the .xpi is a reproducible ZIP of the extension without tests', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.xpi-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = await extensionFiles(path.join(root, 'extension'));
  const names = files.map(([name]) => name);
  assert.ok(names.includes('manifest.json') && names.includes('icons/icon-16.png'));
  assert.ok(!names.some(name => name.startsWith('tests/')));
  const first = zipArchive(files);
  assert.deepEqual(zipArchive([...files].reverse()), first);
  const xpi = path.join(directory, 'deckard.xpi');
  await fs.writeFile(xpi, first);
  // Parse the central directory independently and inflate each entry.
  const end = first.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = first.readUInt16LE(end + 10);
  let offset = first.readUInt32LE(end + 16);
  const seen = new Map();
  for (let i = 0; i < count; i++) {
    const nameLength = first.readUInt16LE(offset + 28);
    const name = first.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = first.readUInt32LE(offset + 42);
    const size = first.readUInt32LE(offset + 20);
    const start = local + 30 + first.readUInt16LE(local + 26);
    seen.set(name, zlib.inflateRawSync(first.subarray(start, start + size)));
    offset += 46 + nameLength;
  }
  assert.deepEqual([...seen.keys()], [...names].sort());
  for (const [name, data] of files) assert.deepEqual(seen.get(name), data);
  const unzip = spawnSync('unzip', ['-tq', xpi], { encoding: 'utf8' });
  if (!unzip.error) assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
  assert.throws(() => zipArchive([['../escape', Buffer.from('x')]]), /Unsafe archive name/);
});
