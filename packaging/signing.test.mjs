import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectSigningTargets } from './signing.mjs';
import { validatePaths } from './build-app.mjs';

const execFileAsync = promisify(execFile);

test('signing target inventory finds native loadables and nested bundles without traversing debug files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-signing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'Source.app');
  const files = {
    'Contents/Frameworks/Test.framework/Versions/A/libtest.dylib': Buffer.from('cffaedfe00112233', 'hex'),
    'Contents/Frameworks/Test.framework/Versions/A/Helpers/Helper.app/Contents/MacOS/Helper': Buffer.from('cffaedfe00112233', 'hex'),
    'Contents/Resources/app.asar.unpacked/addon.node': Buffer.from('cafebabe00112233', 'hex'),
    'Contents/Resources/app.asar.unpacked/linux-addon.node': Buffer.from('7f454c4600112233', 'hex'),
    'Contents/Resources/app.asar.unpacked/addon.node.dSYM/Contents/Resources/DWARF/addon.node': Buffer.from('cffaedfe00112233', 'hex'),
    'Contents/Resources/native/desktop.node': Buffer.from('cffaedfe00112233', 'hex'),
    'Contents/Resources/codex-cli/plugins/voice/libvoice.dylib': Buffer.from('cffaedfe00112233', 'hex'),
  };
  for (const [path, bytes] of Object.entries(files)) {
    const full = join(app, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, bytes);
  }
  await mkdir(join(app, 'Contents', 'PlugIns'), { recursive: true });
  const found = await collectSigningTargets(app);
  assert.deepEqual(found.bundles.map(path => path.slice(app.length + 1)), [
    'Contents/Frameworks/Test.framework/Versions/A/Helpers/Helper.app',
    'Contents/Frameworks/Test.framework',
  ]);
  assert.deepEqual(found.loadables.map(path => path.slice(app.length + 1)), [
    'Contents/Frameworks/Test.framework/Versions/A/libtest.dylib',
    'Contents/Resources/app.asar.unpacked/addon.node',
    'Contents/Resources/native/desktop.node',
  ]);
});

test('path gate protects the source bundle and Applications', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-path-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'Source.app');
  await mkdir(source);
  const output = join(root, 'Patched.app');
  assert.equal((await validatePaths(source, output)).output, join(await realpath(root), 'Patched.app'));
  await assert.rejects(validatePaths(source, source), /independent/);
  await assert.rejects(validatePaths(source, '/Applications/ChatGPT.app'), /Applications/);
});

test('final app commit refuses an existing destination without replacing it',
  { skip: process.platform !== 'darwin' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rename-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'staged.app');
    const existing = join(root, 'existing.app');
    await mkdir(source);
    await mkdir(existing);
    await writeFile(join(existing, 'sentinel'), 'keep');
    const script = fileURLToPath(new URL('./rename_excl.py', import.meta.url));
    await assert.rejects(execFileAsync('/usr/bin/python3', [script, source, existing]));
    assert.equal(await readFile(join(existing, 'sentinel'), 'utf8'), 'keep');
    assert.equal((await lstat(source)).isDirectory(), true);
    await execFileAsync('/usr/bin/python3', [script, source, join(root, 'finished.app')]);
    assert.equal((await realpath(join(root, 'finished.app'))), join(await realpath(root), 'finished.app'));
  });
