#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hashes and short symbol anchors identify the tested build without bundling
// any original application source. Every changed upstream build must be
// inspected and tested independently before adding another specification.
export const SUPPORTED_BUILD = Object.freeze({
  version: '26.924.22138',
  inputAsarSha256: 'd0ba973179d2f717affd39e012b64a095464a54a51c6bccb7bc6b3d2a1cfba80',
  outputAsarSha256: '5b2a0c6457753060e5a02254ab8172040413d508aa59fc29221ad46e06850089',
  outputHeaderSha256: '5a82b279eddbb7ddadd6b6ff67521b13cea7a9300cbd8806ab5d384b59eb803c',
  targets: [
    {
      path: 'webview/assets/app-shared-36eae88777f2.js',
      inputSha256: 'bc90bb198f29b62bd745aa99dbfae6a81719d9739c22811a12a810f9813d6c43',
      spanSha256: '57b134385de5ee654b68999933ae39d2a90c5d0b9653709a440f0b38018bdf40',
      startAnchor: 'function aNn(e){',
      endAnchor: 'function oNn(e)',
      editsFile: 'inline-span-edits.json',
    },
    {
      path: 'webview/assets/text-file-editor-tab-content.electron-21d7439dc837.js',
      inputSha256: '620f2a64dd5b8e482676e361c81fafa09534d8ad47ea74a384a00a7166a073ec',
      spans: [
        {
          spanSha256: '3e49ba45981a135e751a7172f4898a4fde70c5ca6b8587b70e51bda8b4969460',
          startAnchor: 'function Gr(e,t,n=0,r,i=0){',
          endAnchor: 'function qr(e,t,n,r)',
          editsFile: 'table-span-edits.json',
        },
        {
          spanSha256: '4f2fb527fce146da8fdcabddade227d10a82102c8ed7f237373edd4a2bf2b350',
          startAnchor: 'Qa=131072,$a=et(ct.define(',
          endAnchor: ',eo=q.theme(',
          editsFile: 'strong-span-edits.json',
        },
      ],
      requiredStrings: ['O9 as T', 'MathInline'],
    },
  ],
});
const CHUNK = 4 * 1024 * 1024;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(path) {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  try {
    for (let pos = 0;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readExact(handle, length, position) {
  const result = Buffer.alloc(length);
  for (let at = 0; at < length;) {
    const { bytesRead } = await handle.read(result, at, length - at, position + at);
    if (!bytesRead) throw new Error(`Unexpected EOF at ${position + at}`);
    at += bytesRead;
  }
  return result;
}

export async function readAsar(path) {
  const handle = await open(path, 'r');
  try {
    const prefix = await readExact(handle, 16, 0);
    if (prefix.readUInt32LE(0) !== 4) throw new Error('Unsupported ASAR size pickle');
    const headerPickleSize = prefix.readUInt32LE(4);
    const payloadSize = prefix.readUInt32LE(8);
    const jsonSize = prefix.readUInt32LE(12);
    if (headerPickleSize !== payloadSize + 4 || payloadSize < jsonSize + 4 ||
        payloadSize - jsonSize - 4 > 3 || headerPickleSize > 64 * 1024 * 1024) {
      throw new Error('Invalid ASAR header sizes');
    }
    const jsonBytes = await readExact(handle, jsonSize, 16);
    const padding = await readExact(handle, payloadSize - jsonSize - 4, 16 + jsonSize);
    if (padding.some(byte => byte !== 0)) throw new Error('Invalid ASAR header padding');
    const text = jsonBytes.toString('utf8');
    const header = JSON.parse(text);
    if (JSON.stringify(header) !== text) throw new Error('Unexpected ASAR JSON format');
    const size = (await handle.stat()).size;
    const bodyOffset = 8 + headerPickleSize;
    if (bodyOffset > size) throw new Error('ASAR body is missing');
    return { header, bodyOffset, headerHash: sha256(jsonBytes), size };
  } finally {
    await handle.close();
  }
}

export function entryFor(header, path) {
  if (!path) throw new Error('An ASAR entry path is required');
  let node = header;
  for (const segment of path.split('/')) {
    node = node.files?.[segment];
    if (!node) throw new Error(`Missing ASAR entry: ${path}`);
  }
  return node;
}

function allFiles(header) {
  const entries = [];
  function visit(files, prefix = '') {
    for (const [name, entry] of Object.entries(files)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.files) visit(entry.files, path);
      else entries.push([path, entry]);
    }
  }
  visit(header.files);
  return entries;
}

export function encodeHeader(header) {
  const jsonBytes = Buffer.from(JSON.stringify(header));
  const paddedSize = Math.ceil(jsonBytes.length / 4) * 4;
  const result = Buffer.alloc(16 + paddedSize);
  result.writeUInt32LE(4, 0);
  result.writeUInt32LE(8 + paddedSize, 4);
  result.writeUInt32LE(4 + paddedSize, 8);
  result.writeUInt32LE(jsonBytes.length, 12);
  jsonBytes.copy(result, 16);
  return { bytes: result, headerHash: sha256(jsonBytes) };
}

function uniqueSlice(source, startAnchor, endAnchor, expectedHash) {
  const first = source.indexOf(startAnchor);
  if (first < 0 || source.indexOf(startAnchor, first + 1) >= 0) {
    throw new Error(`Expected one anchor: ${startAnchor}`);
  }
  const end = source.indexOf(endAnchor, first + startAnchor.length);
  if (end < 0) throw new Error(`Missing end anchor: ${endAnchor}`);
  const original = source.slice(first, end);
  if (sha256(Buffer.from(original)) !== expectedHash) {
    throw new Error(`Original parser anchor hash mismatch: ${startAnchor}`);
  }
  return { first, end, original };
}

export async function patchTargetJavaScript(original, target) {
  if (sha256(original) !== target.inputSha256) throw new Error(`Target JS hash mismatch: ${target.path}`);
  const source = original.toString('utf8');
  if (!Buffer.from(source).equals(original)) throw new Error('Target JS is not valid UTF-8');
  for (const required of target.requiredStrings ?? []) {
    if (!source.includes(required)) throw new Error(`Missing expected target marker: ${required}`);
  }
  const spans = [];
  for (const spec of target.spans ?? [target]) {
    const inline = uniqueSlice(source, spec.startAnchor, spec.endAnchor, spec.spanSha256);
    const payload = spec.edits ? { format: 'span-edits-v1', edits: spec.edits } :
      JSON.parse(await readFile(new URL(spec.editsFile, import.meta.url), 'utf8'));
    if (payload.format !== 'span-edits-v1' || !Array.isArray(payload.edits) || !payload.edits.length) {
      throw new Error(`Invalid authored edit list for ${target.path}`);
    }
    let revised = '';
    let cursor = 0;
    for (const edit of payload.edits) {
      if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) ||
          edit.from < cursor || edit.to < edit.from || edit.to > inline.original.length ||
          typeof edit.insert !== 'string') {
        throw new Error(`Invalid or overlapping edit in ${target.path}`);
      }
      revised += inline.original.slice(cursor, edit.from) + edit.insert;
      cursor = edit.to;
    }
    revised += inline.original.slice(cursor);
    if (!revised.startsWith(spec.startAnchor) || revised.includes(spec.endAnchor)) {
      throw new Error(`Edited parser structure is invalid: ${target.path}`);
    }
    spans.push({ ...inline, revised });
  }
  spans.sort((a, b) => a.first - b.first);
  let patched = '';
  let cursor = 0;
  for (const span of spans) {
    if (span.first < cursor) throw new Error(`Overlapping parser spans in ${target.path}`);
    patched += source.slice(cursor, span.first) + span.revised;
    cursor = span.end;
  }
  return Buffer.from(patched + source.slice(cursor));
}

function integrityFor(buffer, blockSize) {
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error('Invalid integrity block size');
  const blocks = [];
  for (let i = 0; i < buffer.length; i += blockSize) blocks.push(sha256(buffer.subarray(i, i + blockSize)));
  return { algorithm: 'SHA256', hash: sha256(buffer), blockSize, blocks };
}

function mutateHeader(header, patches) {
  const targetPaths = new Set(patches.map(patch => patch.path));
  const delta = patches.reduce((sum, patch) => sum + patch.delta, 0);
  for (const [path, entry] of allFiles(header)) {
    if (entry.offset == null) continue;
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset)) throw new Error(`Invalid offset: ${path}`);
    if (!targetPaths.has(path)) {
      for (const patch of patches) {
        if (offset < patch.offset + patch.originalSize && offset + entry.size > patch.offset) {
          throw new Error(`File overlaps patched JS: ${path}`);
        }
      }
    }
    const shift = patches.reduce((sum, patch) => sum + (offset >= patch.offset + patch.originalSize ? patch.delta : 0), 0);
    entry.offset = String(offset + shift);
  }
  for (const patch of patches) {
    const target = entryFor(header, patch.path);
    target.size = patch.patched.length;
    target.integrity = integrityFor(patch.patched, target.integrity?.blockSize);
  }
  return delta;
}

async function copyRange(from, to, sourcePosition, targetPosition, length) {
  const buffer = Buffer.allocUnsafe(CHUNK);
  let copied = 0;
  while (copied < length) {
    const amount = Math.min(buffer.length, length - copied);
    const { bytesRead } = await from.read(buffer, 0, amount, sourcePosition + copied);
    if (bytesRead !== amount) throw new Error('Source ASAR truncated during copy');
    for (let written = 0; written < amount;) {
      const result = await to.write(buffer, written, amount - written, targetPosition + copied + written);
      if (!result.bytesWritten) throw new Error('Could not write output ASAR');
      written += result.bytesWritten;
    }
    copied += amount;
  }
}

async function writeExact(handle, buffer, position) {
  for (let written = 0; written < buffer.length;) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Could not write output ASAR');
    written += result.bytesWritten;
  }
}

async function compareRange(left, right, leftPosition, rightPosition, length) {
  const a = Buffer.allocUnsafe(CHUNK);
  const b = Buffer.allocUnsafe(CHUNK);
  for (let compared = 0; compared < length;) {
    const size = Math.min(CHUNK, length - compared);
    const [x, y] = await Promise.all([
      left.read(a, 0, size, leftPosition + compared),
      right.read(b, 0, size, rightPosition + compared),
    ]);
    if (x.bytesRead !== size || y.bytesRead !== size || !a.subarray(0, size).equals(b.subarray(0, size))) {
      throw new Error(`ASAR body differs outside target at byte ${compared}`);
    }
    compared += size;
  }
}

async function prepare(input, spec) {
  const sourceHash = await hashFile(input);
  if (sourceHash !== spec.inputAsarSha256) {
    throw new Error(`Input is not the verified ${spec.version} ASAR: ${sourceHash}`);
  }
  const source = await readAsar(input);
  const handle = await open(input, 'r');
  const patches = [];
  try {
    for (const target of spec.targets) {
      const entry = entryFor(source.header, target.path);
      if (entry.unpacked || !entry.integrity || entry.integrity.hash !== target.inputSha256) {
        throw new Error(`Unexpected target JS metadata: ${target.path}`);
      }
      const offset = Number(entry.offset);
      const filePosition = source.bodyOffset + offset;
      if (!Number.isSafeInteger(offset) || filePosition + entry.size > source.size) {
        throw new Error(`Target JS is outside ASAR: ${target.path}`);
      }
      const original = await readExact(handle, entry.size, filePosition);
      const patched = await patchTargetJavaScript(original, target);
      const delta = patched.length - entry.size;
      if (delta <= 0) throw new Error(`Patch did not enlarge target JS: ${target.path}`);
      patches.push({ path: target.path, offset, filePosition, originalSize: entry.size,
        beforeHash: target.inputSha256, afterHash: sha256(patched), patched, delta });
    }
  } finally {
    await handle.close();
  }
  patches.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < patches.length; i++) {
    if (patches[i - 1].offset + patches[i - 1].originalSize > patches[i].offset) {
      throw new Error('Patched files overlap in source ASAR');
    }
  }
  const header = structuredClone(source.header);
  const delta = mutateHeader(header, patches);
  const encoded = encodeHeader(header);
  if (spec.outputHeaderSha256 && encoded.headerHash !== spec.outputHeaderSha256) {
    throw new Error(`Patched header differs from the verified ${spec.version} output`);
  }
  return { source, sourceHash, patches, delta, header, encoded };
}

function targetReport(patches) {
  return patches.map(patch => ({ path: patch.path, inputSha256: patch.beforeHash,
    outputSha256: patch.afterHash, byteDelta: patch.delta }));
}

export async function planAsarPatch(input, options = {}) {
  const spec = options.spec ?? SUPPORTED_BUILD;
  const plan = await prepare(resolve(input), spec);
  return {
    build: spec.version,
    input: resolve(input),
    inputSha256: plan.sourceHash,
    inputHeaderSha256: plan.source.headerHash,
    outputHeaderSha256: plan.encoded.headerHash,
    expectedOutputSha256: spec.outputAsarSha256 ?? null,
    targets: targetReport(plan.patches),
  };
}

export async function patchAsar(input, output, options = {}) {
  const spec = options.spec ?? SUPPORTED_BUILD;
  const inputPath = resolve(input), outputPath = resolve(output);
  if (inputPath === outputPath) throw new Error('Input and output must differ');
  const plan = await prepare(inputPath, spec);
  // O_EXCL protects an existing app or previous patch from accidental overwrite.
  const inputFd = await open(inputPath, 'r');
  let outputFd;
  let wroteOutput = false;
  try {
    try {
      outputFd = await open(outputPath, 'wx', 0o644);
      wroteOutput = true;
      await writeExact(outputFd, plan.encoded.bytes, 0);
      let sourcePosition = plan.source.bodyOffset;
      let outputPosition = plan.encoded.bytes.length;
      for (const patch of plan.patches) {
        const gap = patch.filePosition - sourcePosition;
        await copyRange(inputFd, outputFd, sourcePosition, outputPosition, gap);
        outputPosition += gap;
        await writeExact(outputFd, patch.patched, outputPosition);
        outputPosition += patch.patched.length;
        sourcePosition = patch.filePosition + patch.originalSize;
      }
      await copyRange(inputFd, outputFd, sourcePosition, outputPosition, plan.source.size - sourcePosition);
      await outputFd.sync();
    } finally {
      await Promise.allSettled([inputFd.close(), outputFd?.close()]);
    }
    return await verifyAsarPatch(inputPath, outputPath, options);
  } catch (error) {
    if (wroteOutput) await unlink(outputPath).catch(() => {});
    throw error;
  }
}

export async function verifyAsarPatch(input, output, options = {}) {
  const spec = options.spec ?? SUPPORTED_BUILD;
  const inputPath = resolve(input), outputPath = resolve(output);
  if (inputPath === outputPath) throw new Error('Input and output must differ');
  const plan = await prepare(inputPath, spec);
  const result = await readAsar(outputPath);
  if (result.headerHash !== plan.encoded.headerHash ||
      JSON.stringify(result.header) !== JSON.stringify(plan.header) ||
      result.size !== plan.source.size + plan.delta + result.bodyOffset - plan.source.bodyOffset) {
    throw new Error('Patched ASAR header or size differs from expected');
  }
  const left = await open(inputPath, 'r');
  const right = await open(outputPath, 'r');
  try {
    let sourcePosition = plan.source.bodyOffset;
    let outputPosition = result.bodyOffset;
    for (const patch of plan.patches) {
      const gap = patch.filePosition - sourcePosition;
      await compareRange(left, right, sourcePosition, outputPosition, gap);
      outputPosition += gap;
      const outputTarget = await readExact(right, patch.patched.length, outputPosition);
      if (!outputTarget.equals(patch.patched)) throw new Error(`Patched JS differs from expected: ${patch.path}`);
      outputPosition += patch.patched.length;
      sourcePosition = patch.filePosition + patch.originalSize;
    }
    await compareRange(left, right, sourcePosition, outputPosition, plan.source.size - sourcePosition);
  } finally {
    await Promise.allSettled([left.close(), right.close()]);
  }
  const originalStill = await hashFile(inputPath);
  if (originalStill !== plan.sourceHash) throw new Error('Input ASAR changed during patch');
  const outputSha256 = await hashFile(outputPath);
  if (spec.outputAsarSha256 && outputSha256 !== spec.outputAsarSha256) {
    throw new Error(`Patched ASAR differs from the verified ${spec.version} output: ${outputSha256}`);
  }
  return {
    build: spec.version,
    input: inputPath,
    output: outputPath,
    inputSha256: originalStill,
    outputSha256,
    inputHeaderSha256: plan.source.headerHash,
    outputHeaderSha256: result.headerHash,
    targets: targetReport(plan.patches),
    rollback: `Restore the original app.asar and set Info.plist ElectronAsarIntegrity Resources/app.asar hash to ${plan.source.headerHash}.`,
  };
}

async function main(argv) {
  const [command, ...args] = argv;
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Expected --input PATH [--output PATH] [--report PATH]');
    options.set(args[i], args[i + 1]);
  }
  const input = options.get('--input');
  const output = options.get('--output');
  if (!input) throw new Error('Missing --input');
  let report;
  if (command === 'dry-run') {
    report = await planAsarPatch(input);
  } else if (command === 'apply') {
    if (!output) throw new Error('Missing --output');
    report = await patchAsar(input, output);
  } else if (command === 'verify') {
    if (!output) throw new Error('Missing --output');
    report = await verifyAsarPatch(input, output);
  } else throw new Error('Usage: node core/patch-asar.mjs dry-run|apply|verify --input SOURCE_ASAR [--output NEW_ASAR] [--report NEW_JSON]');
  if (options.get('--report')) await writeFile(options.get('--report'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
