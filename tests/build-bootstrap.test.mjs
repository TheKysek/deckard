import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('production build refuses stale MLX artifacts without changing existing output', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.native-build-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['dist/lib/libmlx.dylib', 'dist/lib/mlx.metallib',
    'dist/share/licenses/MLX-LICENSE', 'licenses/MLX-LICENSE']) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'preserved');
    const result = spawnSync('/bin/bash', [path.join(root, 'scripts/build-native.sh')], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, BUILD_DIR: directory },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Choose a fresh BUILD_DIR; existing output was left untouched/);
    assert.equal(await fs.readFile(file, 'utf8'), 'preserved');
    await fs.rm(file);
  }
});

test('production bootstrap accepts a complete read-only cache without downloading', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'tests/.native-bootstrap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commands = path.join(directory, 'commands');
  const cache = path.join(directory, 'cache');
  await fs.mkdir(commands);
  const files = [
    'json/include/nlohmann/json.hpp',
    'cargo/registry/fixture',
    'rustup/toolchains/1.90.0-x86_64-unknown-linux-gnu/bin/cargo',
    'onnxruntime/onnxruntime-linux-x64-1.22.0/lib/libonnxruntime.so.1.22.0',
    'licenses/NLOHMANN-LICENSE',
  ];
  for (const name of files) {
    await fs.mkdir(path.dirname(path.join(cache, name)), { recursive: true });
    await fs.writeFile(path.join(cache, name), 'fixture');
  }
  for (const [name, content] of Object.entries({
    uname: 'case "$1" in -s) echo "${MOCK_OS:-Linux}";; -m) echo x86_64;; esac',
    cmake: 'exit 0',
    'c++': 'exit 0',
    curl: 'echo "Unexpected download" >&2; exit 99',
  })) await fs.writeFile(path.join(commands, name), `#!/bin/sh\n${content}\n`, { mode: 0o755 });
  const before = await fs.readdir(cache, { recursive: true });
  const run = (env = {}) => spawnSync('/bin/sh', [path.join(root, 'native-cli/bootstrap.sh')], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${commands}:/usr/bin:/bin`, NATIVE_CACHE: cache, ...env },
  });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /read-only native dependencies/);
  assert.deepEqual(await fs.readdir(cache, { recursive: true }), before);
  result = run({ MOCK_OS: 'Darwin' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires Linux/);
  for (const missing of ['licenses/NLOHMANN-LICENSE', 'onnxruntime/onnxruntime-linux-x64-1.22.0/lib/libonnxruntime.so.1.22.0']) {
    const saved = await fs.readFile(path.join(cache, missing));
    await fs.rm(path.join(cache, missing));
    result = run();
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`incomplete: ${missing}`), result.stderr);
    await fs.writeFile(path.join(cache, missing), saved);
  }
});
