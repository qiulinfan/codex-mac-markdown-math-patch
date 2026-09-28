import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { patchAsar, planAsarPatch, SUPPORTED_BUILD, verifyAsarPatch } from './patch-asar.mjs';

test('opt-in installed Codex build reproduces the visually verified ASAR',
  { skip: !process.env.CODEX_ORIGINAL_APP }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-public-patch-integration-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = join(process.env.CODEX_ORIGINAL_APP, 'Contents', 'Resources', 'app.asar');
    const output = join(directory, 'app.patched.asar');
    const plan = await planAsarPatch(input);
    assert.equal(plan.build, SUPPORTED_BUILD.version);
    assert.equal(plan.expectedOutputSha256, SUPPORTED_BUILD.outputAsarSha256);
    const report = await patchAsar(input, output);
    assert.equal(report.outputSha256, SUPPORTED_BUILD.outputAsarSha256);
    assert.equal(report.outputHeaderSha256, SUPPORTED_BUILD.outputHeaderSha256);
    assert.deepEqual(await verifyAsarPatch(input, output), report);
  });
