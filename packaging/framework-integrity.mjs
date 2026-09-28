import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const SENTINEL = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');
const CHUNK_SIZE = 4 * 1024 * 1024;
const DIGEST_BYTES = 32;

export function integrityDictionaryDigest(headerHash) {
  if (!/^[0-9a-f]{64}$/.test(headerHash)) throw new Error('Invalid ASAR header SHA-256');
  // Electron integrity_digest.mm hashes the dictionary key, algorithm, and
  // header hash as UTF-8, in that order. This build has one dictionary entry.
  return createHash('sha256')
    .update(`Resources/app.asarSHA256${headerHash}`)
    .digest('hex');
}

async function readExact(handle, position, length) {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('Truncated Electron framework integrity slot');
    offset += result.bytesRead;
  }
  return bytes;
}

async function locateSlot(handle) {
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  let carry = Buffer.alloc(0);
  let count = 0;
  let match = -1;
  for (let position = 0;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (!bytesRead) break;
    const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
    for (let index = data.indexOf(SENTINEL); index >= 0; index = data.indexOf(SENTINEL, index + 1)) {
      count++;
      match = position - carry.length + index;
    }
    carry = data.subarray(Math.max(0, data.length - SENTINEL.length + 1));
    position += bytesRead;
  }
  if (count !== 1) throw new Error(`Expected exactly one Electron integrity slot; found ${count}`);
  const state = await readExact(handle, match + SENTINEL.length, 2 + DIGEST_BYTES);
  if (state[0] !== 1 || state[1] !== 1) {
    throw new Error(`Unexpected Electron integrity slot state ${state[0]}/${state[1]}`);
  }
  return {
    offset: match + SENTINEL.length + 2,
    digest: state.subarray(2).toString('hex'),
  };
}

export async function readFrameworkIntegrity(frameworkPath) {
  const handle = await open(frameworkPath, 'r');
  try {
    return await locateSlot(handle);
  } finally {
    await handle.close();
  }
}

export async function sealFrameworkIntegrity(frameworkPath, oldDigest, newDigest) {
  for (const value of [oldDigest, newDigest]) {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid embedded digest');
  }
  if (oldDigest === newDigest) throw new Error('Patched integrity digest must change');
  const handle = await open(frameworkPath, 'r+');
  try {
    const before = await locateSlot(handle);
    if (before.digest !== oldDigest) throw new Error('Framework does not contain the expected source integrity digest');
    const bytes = Buffer.from(newDigest, 'hex');
    const { bytesWritten } = await handle.write(bytes, 0, bytes.length, before.offset);
    if (bytesWritten !== bytes.length) throw new Error('Short write to framework integrity slot');
    await handle.sync();
    const after = await locateSlot(handle);
    if (after.offset !== before.offset || after.digest !== newDigest) {
      throw new Error('Framework integrity digest did not round trip');
    }
    return { offset: before.offset, before: before.digest, after: after.digest };
  } finally {
    await handle.close();
  }
}

export async function assertOnlyFrameworkDigestChanged(sourcePath, patchedPath, digestOffset) {
  const [source, patched] = await Promise.all([open(sourcePath, 'r'), open(patchedPath, 'r')]);
  const left = Buffer.allocUnsafe(CHUNK_SIZE);
  const right = Buffer.allocUnsafe(CHUNK_SIZE);
  try {
    const [a, b] = await Promise.all([source.stat(), patched.stat()]);
    if (a.size !== b.size) throw new Error('Framework binary size changed');
    if (digestOffset < 0 || digestOffset + DIGEST_BYTES > a.size) throw new Error('Digest offset outside framework');
    for (let position = 0; position < a.size; position += CHUNK_SIZE) {
      const amount = Math.min(CHUNK_SIZE, a.size - position);
      const [x, y] = await Promise.all([
        source.read(left, 0, amount, position),
        patched.read(right, 0, amount, position),
      ]);
      if (x.bytesRead !== amount || y.bytesRead !== amount) throw new Error('Framework truncated during comparison');
      const slotStart = digestOffset - position;
      const slotEnd = digestOffset + DIGEST_BYTES - position;
      if (slotEnd <= 0 || slotStart >= amount) {
        if (!left.subarray(0, amount).equals(right.subarray(0, amount))) {
          throw new Error(`Unexpected framework change near byte ${position}`);
        }
      } else {
        const before = Math.max(0, slotStart);
        const after = Math.min(amount, slotEnd);
        if (!left.subarray(0, before).equals(right.subarray(0, before)) ||
            !left.subarray(after, amount).equals(right.subarray(after, amount))) {
          throw new Error(`Unexpected framework change near byte ${position}`);
        }
      }
    }
  } finally {
    await Promise.allSettled([source.close(), patched.close()]);
  }
}
