import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  validatePins, verifyAssets, copyAssets, sha256, checkArchiveSize, renderInstaller, releaseArchitectures,
  zipArchive, extensionFiles,
} from './release-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.7.0';
const arch = releaseArchitectures[process.arch];
const archiveName = `deckard-v${version}-linux-${arch}.tar.gz`;
const appArchiveName = `deckard-v${version}-linux-${arch}-app.tar.gz`;
const xpiName = `deckard-v${version}.xpi`;
const options = { '--native-dist': path.join(root, 'native-cli/build/dist'), '--output-dir': path.join(root, `dist/v${version}`) };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--model-dir', '--native-dist', '--output-dir'].includes(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) {
    throw new Error('Usage: scripts/package-release.sh --model-dir DIR [--native-dist DIR] [--output-dir DIR]');
  }
  options[key] = path.resolve(process.argv[i + 1]);
}
if (!options['--model-dir']) throw new Error('--model-dir is required; the canonical model is read-only.');
if (process.platform !== 'linux' || !arch) throw new Error('Packaging requires Linux on x86_64 or aarch64.');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, LC_ALL: 'C' } });
async function tree(directory, prefix = '') {
  const entries = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!/^[A-Za-z0-9_./-]+$/.test(relative)) throw new Error(`Unsafe package filename: ${relative}`);
    const source = path.join(directory, name);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Links and special files cannot be packaged: ${source}`);
    entries.push(relative + (stat.isDirectory() ? '/' : ''));
    if (stat.isDirectory()) entries.push(...await tree(source, relative));
  }
  return entries;
}
const pinsContent = await fs.readFile(path.join(root, 'native-cli/model-assets.json'), 'utf8');
const modelHashes = validatePins(JSON.parse(pinsContent));
await verifyAssets(options['--model-dir'], modelHashes);
const native = options['--native-dist'];
await tree(native);
for (const required of ['bin/deckard', 'lib/libonnxruntime.so.1', 'share/licenses/NLOHMANN-LICENSE', 'share/licenses/Cargo.lock',
  'share/licenses/rust-stdlib/COPYRIGHT-library.html', 'share/licenses/onnxruntime/LICENSE']) {
  if (!(await fs.stat(path.join(native, required))).isFile()) throw new Error(`Missing native distribution file: ${required}`);
}
const nativeVersion = execFileSync(path.join(native, 'bin/deckard'), ['--version'], { encoding: 'utf8' }).trim();
if (nativeVersion !== version) throw new Error(`Native version ${nativeVersion} does not match ${version}.`);
const out = options['--output-dir'];
for (const input of [native, options['--model-dir'], path.join(root, 'extension'), path.join(root, 'docs')]) {
  if (input === out || input.startsWith(out + path.sep) || out.startsWith(input + path.sep)) throw new Error('Output must not overlap package inputs.');
}
await fs.mkdir(out, { recursive: true });
const staging = path.join(out, `.staging-${process.pid}`);
await fs.mkdir(staging);
try {
  const bundle = path.join(staging, 'bundle');
  await fs.mkdir(path.join(bundle, 'bin'), { recursive: true });
  await fs.copyFile(path.join(native, 'bin/deckard'), path.join(bundle, 'bin/deckard'));
  await fs.mkdir(path.join(bundle, 'lib'));
  await fs.copyFile(path.join(native, 'lib/libonnxruntime.so.1'), path.join(bundle, 'lib/libonnxruntime.so.1'));
  await fs.cp(path.join(native, 'share/licenses'), path.join(bundle, 'share/licenses'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'share/licenses/model-assets.json'), pinsContent);
  await fs.cp(path.join(root, 'extension'), path.join(bundle, 'extension'), {
    recursive: true,
    filter: source => !['tests', '.DS_Store'].includes(path.basename(source)),
  });
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'extension/manifest.json'), 'utf8'));
  if (manifest.name !== 'Deckard' || manifest.version !== version) throw new Error('Extension branding/version does not match release.');
  await fs.mkdir(path.join(bundle, 'models'));
  await copyAssets(options['--model-dir'], path.join(bundle, 'models'), modelHashes);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(bundle, 'share/licenses/DECKARD-LICENSE'));
  await fs.cp(path.join(root, 'docs/licenses'), path.join(bundle, 'share/licenses/models'), { recursive: true });
  await fs.copyFile(path.join(root, 'docs/MODEL-ATTRIBUTION.md'), path.join(bundle, 'share/licenses/MODEL-ATTRIBUTION.md'));
  // The bundled executable must start with its bundled ONNX Runtime on this architecture.
  const bundledVersion = execFileSync(path.join(bundle, 'bin/deckard'), ['--version'], { encoding: 'utf8' }).trim();
  if (bundledVersion !== version) throw new Error('The bundled executable does not run.');
  const entries = await tree(bundle);
  const epoch = new Date('2026-01-01T00:00:00Z');
  for (const entry of [...entries].reverse()) {
    const file = path.join(bundle, entry);
    await fs.chmod(file, entry.endsWith('/') || entry === 'bin/deckard' ? 0o755 : 0o644);
    await fs.utimes(file, epoch, epoch);
  }
  async function pack(name, included) {
    const fileList = path.join(staging, `${name}.entries`);
    await fs.writeFile(fileList, included.join('\n') + '\n');
    const tarFile = path.join(staging, name.slice(0, -3));
    run('tar', ['--format=ustar', '--no-recursion', '--owner=0', '--group=0', '--numeric-owner',
      '--mtime=@1767225600', '--no-xattrs', '--no-acls', '-cf', tarFile, '-C', bundle, '-T', fileList]);
    run('gzip', ['-n', '-9', tarFile]);
    const archive = path.join(staging, name);
    const bytes = checkArchiveSize((await fs.stat(archive)).size);
    return { name, bytes, digest: await sha256(archive) };
  }
  const full = await pack(archiveName, entries);
  const app = await pack(appArchiveName, entries.filter(name => !name.startsWith('models/')));
  const template = await fs.readFile(path.join(root, 'install.sh'), 'utf8');
  const installer = renderInstaller(template, {
    archiveSha256: full.digest, appSha256: app.digest, pins: JSON.parse(pinsContent), arch,
  });
  // Unsigned .xpi of the same extension; scripts/sign-extension.sh produces the AMO-signed one.
  await fs.writeFile(path.join(staging, xpiName), zipArchive(await extensionFiles(path.join(bundle, 'extension'))));
  const xpiDigest = await sha256(path.join(staging, xpiName));
  await fs.writeFile(path.join(staging, 'install.sh'), installer, { mode: 0o755 });
  const installerDigest = await sha256(path.join(staging, 'install.sh'));
  await fs.writeFile(path.join(staging, 'SHA256SUMS'),
    `${full.digest}  ${archiveName}\n${app.digest}  ${appArchiveName}\n${installerDigest}  install.sh\n${xpiDigest}  ${xpiName}\n`);
  for (const name of [archiveName, appArchiveName, 'install.sh', xpiName, 'SHA256SUMS']) {
    await fs.rename(path.join(staging, name), path.join(out, name));
  }
  for (const archive of [full, app]) {
    console.log(`Packaged ${path.join(out, archive.name)}\nArchive bytes: ${archive.bytes} (under 2147483648)\nSHA-256: ${archive.digest}`);
  }
  console.log(`Unsigned add-on: ${path.join(out, xpiName)}. No release was published.`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
