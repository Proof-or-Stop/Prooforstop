#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'proof-or-stop-story6-provenance-pipeline-'));
const provenancePath = path.join(temp, 'producer-provenance.json');

try {
  const live = await exec(process.execPath, [
    path.join(here, 'story6-live.mjs'),
    '--selfcheck',
    `--selfcheck-provenance-output=${provenancePath}`,
  ]);
  assert.match(live.stdout, /story6-live selfcheck: PASS/);
  const probes = JSON.parse(await readFile(provenancePath, 'utf8'));
  assert.deepEqual(probes.map((row) => row.arm), ['legacy', 'modular']);
  for (const probe of probes) {
    assert.equal(probe.provenance.producerMode, 'full-envelope');
    assert.match(probe.provenance.envelopeId, /^[a-f0-9]{64}$/);
    assert.equal(probe.provenance.eventBinding.promptEnvelopeId, probe.provenance.envelopeId);
    assert.match(probe.provenance.eventBinding.assembledPromptDigest, /^[a-f0-9]{64}$/);
  }

  const analyzed = await exec(process.execPath, [
    path.join(here, 'story6-analyze.mjs'),
    `--provenance-selfcheck=${provenancePath}`,
  ]);
  assert.match(analyzed.stdout, /story6-analyze provenance selfcheck: PASS arms=2/);

  const reported = await exec(process.execPath, [
    path.join(here, 'story6-report.mjs'),
    `--provenance-selfcheck=${provenancePath}`,
  ]);
  assert.match(reported.stdout, /story6-report provenance selfcheck: PASS arms=2/);
  console.log('story6-provenance-pipeline-selfcheck: PASS producer=agent_prompt consumers=analyze,report arms=2');
} finally {
  await rm(temp, { recursive: true, force: true });
}
