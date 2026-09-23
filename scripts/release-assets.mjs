import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

export const archiveSizeLimit = 2 * 1024 ** 3;
export const modelFiles = ['model.onnx', 'model.onnx.data', 'tokenizer.json'];
export const releaseArchitectures = { x64: 'x86_64', arm64: 'aarch64' };

export function validatePins(pins) {
  if (pins?.format !== 2 || pins.runtime !== 'native-onnx' ||
      pins.onnxruntime !== '1.22.0' || pins.model_file !== 'model.onnx' ||
      !pins.files || typeof pins.files !== 'object' || Array.isArray(pins.files) ||
      JSON.stringify(Object.keys(pins.files).sort()) !== JSON.stringify([...modelFiles].sort()) ||
      Object.values(pins.files).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('Invalid ONNX model asset pins.');
  }
  return pins.files;
}

export function renderInstaller(template, { archiveSha256, appSha256, pins, arch }) {
  const files = validatePins(pins);
  for (const digest of [archiveSha256, appSha256]) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid archive SHA-256.');
  }
  if (!Object.values(releaseArchitectures).includes(arch)) throw new Error('Invalid release architecture.');
  const values = {
    '@ARCH@': arch,
    '@ARCHIVE_SHA256@': archiveSha256,
    '@APP_ARCHIVE_SHA256@': appSha256,
    '@MODEL_SHA256SUMS@': Object.entries(files).map(([name, digest]) => `${digest}  ${name}`).join('\n'),
  };
  for (const [placeholder, value] of Object.entries(values)) {
    if (template.split(placeholder).length !== 2) throw new Error(`Installer must contain exactly one ${placeholder} placeholder.`);
    template = template.replace(placeholder, value);
  }
  return template;
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularAsset(directory, name) {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) ||
      name.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`Unsafe model asset path: ${name}`);
  }
  const parts = name.split('/');
  let current = directory;
  for (let i = 0; i <= parts.length; ++i) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Model asset links and special files are not permitted: ${name}`);
    }
    if (i < parts.length) current = path.join(current, parts[i]);
  }
  return current;
}

export async function verifyAssets(directory, hashes) {
  for (const [name, expected] of Object.entries(hashes)) {
    const source = await regularAsset(directory, name);
    if (await sha256(source) !== expected) throw new Error(`Canonical model checksum mismatch: ${name}`);
  }
}

export async function copyAssets(source, destination, hashes) {
  await verifyAssets(source, hashes);
  await fs.mkdir(destination, { recursive: true });
  for (const name of Object.keys(hashes)) {
    const file = await regularAsset(source, name);
    const target = path.join(destination, name);
    let directory = destination;
    for (const part of ['', ...name.split('/').slice(0, -1)]) {
      if (part) {
        directory = path.join(directory, part);
        await fs.mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe model asset destination: ${directory}`);
      }
    }
    await fs.copyFile(file, target, constants.COPYFILE_EXCL);
  }
  // Verify what will actually ship, including changes to a source during copying.
  await verifyAssets(destination, hashes);
}

export function checkArchiveSize(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes >= archiveSizeLimit) {
    throw new Error(`Release archive is ${bytes} bytes; GitHub assets must be under ${archiveSizeLimit} bytes (2 GiB).`);
  }
  return bytes;
}

// CRC-32 (IEEE) for ZIP entries.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A reproducible .xpi (ZIP): sorted entries, fixed 2026-01-01 timestamps, raw deflate,
// no extra fields. `files` is [[name, Buffer], ...] with forward-slash relative names.
export function zipArchive(files) {
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [], centrals = [];
  let offset = 0;
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, data] of sorted) {
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) ||
        name.split('/').some(part => part === '.' || part === '..')) throw new Error(`Unsafe archive name: ${name}`);
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Files of an unpacked extension directory for the .xpi, excluding tests and OS litter.
export async function extensionFiles(directory, prefix = '') {
  const files = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (['tests', '.DS_Store'].includes(name)) continue;
    const source = path.join(directory, name);
    const stat = await fs.lstat(source);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (stat.isDirectory()) files.push(...await extensionFiles(source, relative));
    else if (stat.isFile()) files.push([relative, await fs.readFile(source)]);
    else throw new Error(`Links and special files cannot be packaged: ${source}`);
  }
  return files;
}
