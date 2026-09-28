import { execFile } from 'node:child_process';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENTITLEMENTS = fileURLToPath(new URL('./runtime-entitlements.plist', import.meta.url));
const BUNDLE_SUFFIXES = ['.app', '.framework', '.xpc', '.appex', '.plugin', '.docktileplugin'];
const LOADABLE_SUFFIXES = ['.node', '.dylib', '.so'];
const MACHO_MAGIC = new Set([
  'cffaedfe', 'feedfacf', 'cefaedfe', 'feedface',
  'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
]);

export async function run(program, args, maxBuffer = 8 * 1024 * 1024) {
  return execFileAsync(program, args, { maxBuffer });
}

async function walk(root, onDirectory, onFile) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.name.endsWith('.dSYM')) continue;
      if (entry.isDirectory()) {
        onDirectory?.(path, entry);
        await visit(path);
      } else if (entry.isFile()) {
        await onFile?.(path, entry);
      }
      // Do not follow bundle symlinks or links into paths outside the copied app.
    }
  }
  await visit(root);
}

async function isMachO(path) {
  const handle = await open(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    return bytesRead === 4 && MACHO_MAGIC.has(magic.toString('hex'));
  } finally {
    await handle.close();
  }
}

export async function collectSigningTargets(app) {
  const bundles = [];
  const loadables = [];
  for (const root of [join(app, 'Contents', 'Frameworks'), join(app, 'Contents', 'PlugIns')]) {
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error(`Expected bundle directory: ${root}`);
    } catch (error) {
      if (error.code === 'ENOENT' && root.endsWith(`${sep}PlugIns`)) continue;
      throw error;
    }
    await walk(root, path => {
      if (BUNDLE_SUFFIXES.some(suffix => basename(path).endsWith(suffix))) bundles.push(path);
    }, async path => {
      if (LOADABLE_SUFFIXES.some(suffix => path.endsWith(suffix)) && await isMachO(path)) {
        loadables.push(path);
      }
    });
  }
  const unpacked = join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  await walk(unpacked, null, async path => {
    if (await isMachO(path)) loadables.push(path);
  });
  // These modules are loaded by the Electron host. Other Resources trees
  // contain libraries for separately signed CLI and CUA helper processes;
  // changing their Team ID would break those hosts' library validation.
  const native = join(app, 'Contents', 'Resources', 'native');
  await walk(native, null, async path => {
    if (LOADABLE_SUFFIXES.some(suffix => path.endsWith(suffix)) && await isMachO(path)) {
      loadables.push(path);
    }
  });
  bundles.sort((a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b));
  loadables.sort();
  return { bundles, loadables };
}

async function sign(path, identity, entitlements = null) {
  await run('/usr/bin/codesign', [
    '--force', '--sign', identity, '--timestamp=none', '--options', 'runtime',
    ...(entitlements ? ['--entitlements', entitlements] : []), path,
  ]);
}

export async function signCopiedApp(app, identity) {
  if (typeof identity !== 'string' || !identity.trim() || identity.trim() === '-') {
    throw new Error('A local Apple code-signing identity is required; ad-hoc signing is not supported');
  }
  const targets = await collectSigningTargets(app);
  // Loadable Mach-O files are signed first. Each enclosing bundle is then
  // signed from the innermost level out, so no parent seal is invalidated.
  for (const path of targets.loadables) await sign(path, identity);
  for (const path of targets.bundles) await sign(path, identity, ENTITLEMENTS);
  await sign(app, identity, ENTITLEMENTS);
  return {
    nestedBundles: targets.bundles.map(path => relative(app, path)),
    loadables: targets.loadables.map(path => relative(app, path)),
  };
}

async function signatureInfo(path) {
  const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', path]);
  const field = key => stderr.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
  return { identifier: field('Identifier'), team: field('TeamIdentifier'), flags: field('CodeDirectory') };
}

async function assertLibraryValidationEnabled(path) {
  const { stdout } = await run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', path]);
  if (stdout.includes('com.apple.security.cs.disable-library-validation')) {
    throw new Error(`Library validation was disabled in ${path}`);
  }
}

export async function verifySignedApp(app) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const outer = await signatureInfo(app);
  if (!outer.team || outer.team === 'not set') throw new Error('Output app has no Apple signing Team ID');
  await assertLibraryValidationEnabled(app);
  const targets = await collectSigningTargets(app);
  for (const path of [...targets.loadables, ...targets.bundles]) {
    await run('/usr/bin/codesign', ['--verify', '--strict', path]);
    const signature = await signatureInfo(path);
    if (signature.team !== outer.team) {
      throw new Error(`Signing Team mismatch: ${relative(app, path)} (${signature.team} != ${outer.team})`);
    }
    if (targets.bundles.includes(path)) await assertLibraryValidationEnabled(path);
  }
  return {
    team: outer.team,
    identifier: outer.identifier,
    nestedBundleCount: targets.bundles.length,
    loadableCount: targets.loadables.length,
  };
}
