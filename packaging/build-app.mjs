#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { patchAsar, planAsarPatch, verifyAsarPatch } from '../core/patch-asar.mjs';
import {
  assertOnlyFrameworkDigestChanged,
  integrityDictionaryDigest,
  readFrameworkIntegrity,
  sealFrameworkIntegrity,
} from './framework-integrity.mjs';
import { run, signCopiedApp, verifySignedApp } from './signing.mjs';

const execFileAsync = promisify(execFile);
const APP_ID = 'com.openai.codex';
const BUNDLE_BUILD = '11645';
const ASAR_RELATIVE = join('Contents', 'Resources', 'app.asar');
const PLIST_RELATIVE = join('Contents', 'Info.plist');
const FRAMEWORK_RELATIVE = join('Contents', 'Frameworks', 'Codex Framework.framework', 'Codex Framework');

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function validatePaths(sourceArgument, outputArgument) {
  if (!sourceArgument || !outputArgument) throw new Error('Both --source and --output are required');
  const source = resolve(sourceArgument);
  const output = resolve(outputArgument);
  if (!source.endsWith('.app') || !output.endsWith('.app')) throw new Error('Source and output must be .app bundles');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('Source must be a real app directory');
  const sourceReal = await realpath(source);
  const parentReal = await realpath(dirname(output));
  const outputReal = join(parentReal, basename(output));
  if (outputReal === sourceReal || outputReal.startsWith(sourceReal + sep) ||
      sourceReal.startsWith(outputReal + sep)) {
    throw new Error('Output must be independent of source');
  }
  if (outputReal === '/Applications' || outputReal.startsWith('/Applications/')) {
    throw new Error('Build output inside /Applications is forbidden; test an independent copy first');
  }
  return { source: sourceReal, output: outputReal, outputParent: parentReal };
}

async function plistAt(app) {
  const path = join(app, PLIST_RELATIVE);
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function headerHashFromPlist(plist, build) {
  if (plist.CFBundleIdentifier !== APP_ID || plist.CFBundleShortVersionString !== build ||
      String(plist.CFBundleVersion) !== BUNDLE_BUILD) {
    throw new Error('Unexpected app identifier, version, or build number');
  }
  const integrity = plist.ElectronAsarIntegrity;
  if (integrity == null || Object.keys(integrity).length !== 1 ||
      integrity['Resources/app.asar']?.algorithm !== 'SHA256' ||
      !/^[0-9a-f]{64}$/.test(integrity['Resources/app.asar'].hash)) {
    throw new Error('Unexpected ElectronAsarIntegrity dictionary');
  }
  return integrity['Resources/app.asar'].hash;
}

async function assertOfficialSource(source) {
  const originalAsar = join(source, ASAR_RELATIVE);
  const plan = await planAsarPatch(originalAsar);
  const plist = await plistAt(source);
  const headerHash = headerHashFromPlist(plist, plan.build);
  if (headerHash !== plan.inputHeaderSha256) throw new Error('Source ASAR header differs from signed Info.plist');
  const originalFramework = join(source, FRAMEWORK_RELATIVE);
  const slot = await readFrameworkIntegrity(originalFramework);
  if (slot.digest !== integrityDictionaryDigest(headerHash)) {
    throw new Error('Source framework embedded digest does not match Info.plist');
  }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
  const { stderr } = await run('/usr/bin/codesign', ['-dv', '--verbose=4', source]);
  if (!/^Authority=Developer ID Application:/m.test(stderr)) {
    throw new Error('Source is not signed as an official Developer ID application');
  }
  return { plan, originalAsar, originalFramework, sourceHeaderHash: headerHash, sourceDigest: slot.digest };
}

async function setPlistHeaderHash(app, hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid replacement ASAR header hash');
  await run('/usr/libexec/PlistBuddy', [
    '-c', `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`,
    join(app, PLIST_RELATIVE),
  ]);
}

export async function verifyBuiltApp(sourceArgument, outputArgument) {
  const { source, output } = await validatePaths(sourceArgument, outputArgument);
  if (!(await exists(output))) throw new Error('Output app does not exist');
  const sourceReport = await assertOfficialSource(source);
  const asarReport = await verifyAsarPatch(sourceReport.originalAsar, join(output, ASAR_RELATIVE));
  const plist = await plistAt(output);
  const headerHash = headerHashFromPlist(plist, sourceReport.plan.build);
  if (headerHash !== asarReport.outputHeaderSha256) {
    throw new Error('Patched app Info.plist does not match ASAR header');
  }
  const slot = await readFrameworkIntegrity(join(output, FRAMEWORK_RELATIVE));
  if (slot.digest !== integrityDictionaryDigest(headerHash)) {
    throw new Error('Patched framework digest does not match Info.plist');
  }
  const signature = await verifySignedApp(output);
  if (signature.identifier !== APP_ID) throw new Error('Output signing identifier changed');
  return {
    source,
    output,
    build: asarReport.build,
    asarSha256: asarReport.outputSha256,
    asarHeaderSha256: headerHash,
    frameworkDigest: slot.digest,
    signature,
  };
}

export async function buildApp(sourceArgument, outputArgument, identity) {
  const { source, output, outputParent } = await validatePaths(sourceArgument, outputArgument);
  if (await exists(output)) throw new Error('Output app already exists');
  if (typeof identity !== 'string' || !identity.trim() || identity.trim() === '-') {
    throw new Error('Specify a local Apple signing identity with --identity');
  }
  const sourceReport = await assertOfficialSource(source);
  const stagingRoot = await mkdtemp(join(outputParent, '.codex-math-build-'));
  const stagedApp = join(stagingRoot, 'ChatGPT.app');
  try {
    await run('/usr/bin/ditto', [source, stagedApp], 16 * 1024 * 1024);
    const stagedAsar = join(stagedApp, ASAR_RELATIVE);
    await rename(stagedAsar, join(stagingRoot, 'unmodified-app.asar'));
    const patchReport = await patchAsar(sourceReport.originalAsar, stagedAsar);
    await verifyAsarPatch(sourceReport.originalAsar, stagedAsar);
    await setPlistHeaderHash(stagedApp, patchReport.outputHeaderSha256);
    const patchedPlist = await plistAt(stagedApp);
    const patchedHeader = headerHashFromPlist(patchedPlist, sourceReport.plan.build);
    if (patchedHeader !== patchReport.outputHeaderSha256) throw new Error('Plist update did not round trip');
    const stagedFramework = join(stagedApp, FRAMEWORK_RELATIVE);
    const seal = await sealFrameworkIntegrity(
      stagedFramework,
      sourceReport.sourceDigest,
      integrityDictionaryDigest(patchedHeader),
    );
    await assertOnlyFrameworkDigestChanged(sourceReport.originalFramework, stagedFramework, seal.offset);
    const signed = await signCopiedApp(stagedApp, identity);
    await verifyBuiltApp(source, stagedApp);
    await run('/usr/bin/python3', [
      fileURLToPath(new URL('./rename_excl.py', import.meta.url)), stagedApp, output,
    ]);
    const verified = await verifyBuiltApp(source, output);
    return { ...verified, signedTargets: signed, frameworkDigestByteOffset: seal.offset };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['build', 'verify'].includes(command)) throw new Error('Command must be build or verify');
  const values = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || !rest[i + 1] || values.has(rest[i])) {
      throw new Error('Expected unique --source, --output, and optional --identity values');
    }
    values.set(rest[i], rest[i + 1]);
  }
  for (const key of values.keys()) {
    if (!['--source', '--output', '--identity'].includes(key)) throw new Error(`Unknown option ${key}`);
  }
  if (!values.has('--source') || !values.has('--output')) throw new Error('Missing --source or --output');
  if (command === 'build' && !values.has('--identity')) throw new Error('Build requires --identity');
  if (command === 'verify' && values.has('--identity')) throw new Error('Verify reads identity from the signed app');
  return { command, source: values.get('--source'), output: values.get('--output'), identity: values.get('--identity') };
}

async function main(args) {
  const options = parseArgs(args);
  const report = options.command === 'build'
    ? await buildApp(options.source, options.output, options.identity)
    : await verifyBuiltApp(options.source, options.output);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
