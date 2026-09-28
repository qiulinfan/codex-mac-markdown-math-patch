import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertOnlyFrameworkDigestChanged,
  integrityDictionaryDigest,
  readFrameworkIntegrity,
  sealFrameworkIntegrity,
} from './framework-integrity.mjs';

const SENTINEL = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');

test('framework sealing changes only the one embedded digest across a chunk boundary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-framework-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original-framework');
  const patched = join(directory, 'patched-framework');
  const oldHeader = 'a'.repeat(64);
  const newHeader = 'b'.repeat(64);
  const oldDigest = integrityDictionaryDigest(oldHeader);
  const newDigest = integrityDictionaryDigest(newHeader);
  assert.equal(oldDigest, createHash('sha256').update(`Resources/app.asarSHA256${oldHeader}`).digest('hex'));
  const slotStart = 4 * 1024 * 1024 - 10;
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 256, 0x43);
  SENTINEL.copy(bytes, slotStart);
  bytes[slotStart + SENTINEL.length] = 1;
  bytes[slotStart + SENTINEL.length + 1] = 1;
  Buffer.from(oldDigest, 'hex').copy(bytes, slotStart + SENTINEL.length + 2);
  await writeFile(original, bytes);
  await copyFile(original, patched);
  const result = await sealFrameworkIntegrity(patched, oldDigest, newDigest);
  assert.equal(result.offset, slotStart + SENTINEL.length + 2);
  assert.equal((await readFrameworkIntegrity(patched)).digest, newDigest);
  assert.equal((await readFrameworkIntegrity(original)).digest, oldDigest);
  await assertOnlyFrameworkDigestChanged(original, patched, result.offset);

  const handle = await open(patched, 'r+');
  try {
    await handle.write(Buffer.from([0x44]), 0, 1, slotStart - 100);
  } finally {
    await handle.close();
  }
  await assert.rejects(assertOnlyFrameworkDigestChanged(original, patched, result.offset),
    /Unexpected framework change/);
});

test('framework sealing rejects an unexpected source slot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-framework-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const framework = join(directory, 'framework');
  await writeFile(framework, Buffer.concat([SENTINEL, Buffer.from([1, 1]), Buffer.alloc(32)]));
  await assert.rejects(
    sealFrameworkIntegrity(framework, 'a'.repeat(64), 'b'.repeat(64)),
    /expected source integrity digest/,
  );
});
