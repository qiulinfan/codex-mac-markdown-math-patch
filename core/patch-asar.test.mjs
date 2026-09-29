import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeHeader, entryFor, patchAsar, patchTargetJavaScript,
  planAsarPatch, readAsar, verifyAsarPatch } from './patch-asar.mjs';

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function integrity(bytes, blockSize = 8) {
  const blocks = [];
  for (let at = 0; at < bytes.length; at += blockSize) blocks.push(hash(bytes.subarray(at, at + blockSize)));
  return { algorithm: 'SHA256', hash: hash(bytes), blockSize, blocks };
}

function addEntry(root, name, entry) {
  const parts = name.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent.files[part] ??= { files: {} };
    parent = parent.files[part];
  }
  parent.files[parts.at(-1)] = entry;
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'asar-patch-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = join(dir, 'original.asar');
  const output = join(dir, 'patched.asar');
  // Entirely invented fixture source; it is not copied from any app bundle.
  const mathSpan = 'function toyMath(value){return "source";}';
  const tableSpan = 'function toyTable(row){return row.split("|");}';
  const files = [
    ['assets/math.js', Buffer.from(`const heading=1;${mathSpan}function afterMath(){}\n`)],
    ['notes/example.txt', Buffer.from('ordinary data\n')],
    ['assets/table.js', Buffer.from(`const heading=2;${tableSpan}function afterTable(){}\n`)],
    ['notes/last.txt', Buffer.from('last item\n')],
  ];
  const header = { files: {} };
  let offset = 0;
  for (const [name, bytes] of files) {
    addEntry(header, name, { size: bytes.length, offset: String(offset), integrity: integrity(bytes) });
    offset += bytes.length;
  }
  const encoded = encodeHeader(header);
  const inputBytes = Buffer.concat([encoded.bytes, ...files.map(([, bytes]) => bytes)]);
  await writeFile(input, inputBytes);
  const mathEditStart = mathSpan.indexOf('"source"');
  const tableEditStart = tableSpan.indexOf('row.split("|")');
  const spec = {
    version: 'invented-fixture',
    inputAsarSha256: hash(inputBytes),
    targets: [
      { path: 'assets/math.js', inputSha256: hash(files[0][1]), spanSha256: hash(mathSpan),
        startAnchor: 'function toyMath(value){', endAnchor: 'function afterMath()',
        edits: [{ from: mathEditStart, to: mathEditStart + '"source"'.length, insert: '"rendered formula"' }] },
      { path: 'assets/table.js', inputSha256: hash(files[2][1]), spanSha256: hash(tableSpan),
        startAnchor: 'function toyTable(row){', endAnchor: 'function afterTable()',
        edits: [{ from: tableEditStart, to: tableEditStart + 'row.split("|")'.length,
          insert: 'row.split("|").map(cell=>cell.trim())' }] },
    ],
  };
  return { dir, input, output, spec, files, header };
}

async function extract(path, entry) {
  const { bodyOffset, header } = await readAsar(path);
  const node = entryFor(header, entry);
  const archive = await readFile(path);
  return archive.subarray(bodyOffset + Number(node.offset), bodyOffset + Number(node.offset) + node.size);
}

test('small ASAR keeps untouched bytes and updates both offsets and block hashes', async t => {
  const f = await fixture(t);
  const plan = await planAsarPatch(f.input, { spec: f.spec });
  assert.equal(plan.expectedOutputSha256, null);
  assert.deepEqual(plan.targets.map(item => item.path), ['assets/math.js', 'assets/table.js']);
  const result = await patchAsar(f.input, f.output, { spec: f.spec });
  assert.deepEqual(await verifyAsarPatch(f.input, f.output, { spec: f.spec }), result);
  assert.equal(result.inputSha256, f.spec.inputAsarSha256);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0].byteDelta, '"rendered formula"'.length - '"source"'.length);
  assert.ok(result.targets[1].byteDelta > 0);

  const output = await readAsar(f.output);
  const first = entryFor(output.header, 'assets/math.js');
  const middle = entryFor(output.header, 'notes/example.txt');
  const second = entryFor(output.header, 'assets/table.js');
  const tail = entryFor(output.header, 'notes/last.txt');
  assert.equal(Number(first.offset), 0);
  assert.equal(Number(middle.offset), Number(entryFor(f.header, 'notes/example.txt').offset) + result.targets[0].byteDelta);
  assert.equal(Number(second.offset), Number(entryFor(f.header, 'assets/table.js').offset) + result.targets[0].byteDelta);
  assert.equal(Number(tail.offset), Number(entryFor(f.header, 'notes/last.txt').offset) +
    result.targets[0].byteDelta + result.targets[1].byteDelta);
  assert.equal((await extract(f.output, 'assets/math.js')).toString(),
    f.files[0][1].toString().replace('"source"', '"rendered formula"'));
  assert.equal((await extract(f.output, 'assets/table.js')).toString(),
    f.files[2][1].toString().replace('row.split("|")', 'row.split("|").map(cell=>cell.trim())'));
  for (const [path, bytes] of [f.files[1], f.files[3]]) {
    assert.ok((await extract(f.output, path)).equals(bytes));
  }
  for (const path of ['assets/math.js', 'assets/table.js']) {
    const bytes = await extract(f.output, path);
    assert.deepEqual(entryFor(output.header, path).integrity, integrity(bytes));
  }
});

test('guards refuse source drift, span drift, overlap, and existing output', async t => {
  const f = await fixture(t);
  await assert.rejects(planAsarPatch(f.input, { spec: { ...f.spec, inputAsarSha256: '0'.repeat(64) } }),
    /not the verified/);
  const wrongTarget = structuredClone(f.spec);
  wrongTarget.targets[0].inputSha256 = '0'.repeat(64);
  await assert.rejects(planAsarPatch(f.input, { spec: wrongTarget }), /metadata/);
  const wrongSpan = structuredClone(f.spec);
  wrongSpan.targets[0].spanSha256 = '0'.repeat(64);
  await assert.rejects(planAsarPatch(f.input, { spec: wrongSpan }), /anchor hash mismatch/);
  const overlap = structuredClone(f.spec);
  overlap.targets[0].edits.push({ from: 5, to: 9, insert: 'bad' });
  await assert.rejects(planAsarPatch(f.input, { spec: overlap }), /overlapping edit/);
  await patchAsar(f.input, f.output, { spec: f.spec });
  await assert.rejects(patchAsar(f.input, f.output, { spec: f.spec }), /EEXIST/);
  await assert.rejects(patchAsar(f.input, f.input, { spec: f.spec }), /must differ/);
  assert.equal(hash(await readFile(f.input)), f.spec.inputAsarSha256);
});

test('span editing retains original source outside edited bytes', async () => {
  const source = Buffer.from('prefix function toy(value){return "before";}function next(){} suffix');
  const span = 'function toy(value){return "before";}';
  const at = span.indexOf('"before"');
  const target = {
    path: 'invented.js', inputSha256: hash(source), spanSha256: hash(span),
    startAnchor: 'function toy(value){', endAnchor: 'function next()',
    edits: [{ from: at, to: at + '"before"'.length, insert: '"after"' }],
  };
  const patched = await patchTargetJavaScript(source, target);
  assert.equal(patched.toString(), 'prefix function toy(value){return "after";}function next(){} suffix');
});

test('separate pinned spans in one asset preserve code between parser and style edits', async () => {
  const source = Buffer.from('before function parser(){return "old";}function next(){} middle '
    + 'const style=["links"];const after=1; end');
  const parser = 'function parser(){return "old";}';
  const style = 'const style=["links"];';
  const target = {
    path: 'invented.js', inputSha256: hash(source),
    spans: [
      { startAnchor: 'function parser(){', endAnchor: 'function next()', spanSha256: hash(parser),
        edits: [{ from: parser.indexOf('"old"'), to: parser.indexOf('"old"') + 5, insert: '"new"' }] },
      { startAnchor: 'const style=', endAnchor: 'const after=', spanSha256: hash(style),
        edits: [{ from: style.indexOf(']'), to: style.indexOf(']'), insert: ',"strong"' }] },
    ],
  };
  const patched = await patchTargetJavaScript(source, target);
  assert.equal(patched.toString(), 'before function parser(){return "new";}function next(){} middle '
    + 'const style=["links","strong"];const after=1; end');
  const overlap = structuredClone(target);
  overlap.spans[1] = { ...overlap.spans[0] };
  await assert.rejects(patchTargetJavaScript(source, overlap), /Overlapping parser spans/);
});
