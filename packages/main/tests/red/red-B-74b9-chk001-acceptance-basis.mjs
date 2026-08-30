#!/usr/bin/env node
/**
 * RED (repro-first) for B-74b9 CHK-001.
 *
 * proofstory-acceptance-basis-smoke.ts's writeCanonicalAcceptanceRegistration builds a
 * synthetic pureRoot workspace that stubs every file the acceptance_basis/acceptance_basis_generate
 * process-fact family touches -- EXCEPT two files that PROCESS_FACT_REGISTRY's
 * artifact:acceptance-rollout-report.json entry now also lists as producerSourceRefs
 * alongside handlers/proofstory.ts (which the fixture DOES stub):
 *   - packages/main/src/core/acceptance-rollout.ts
 *   - scripts/run-proofstory-acceptance-rollout-cohort.mjs
 *
 * buildBoundedSourceGraph (acceptance-discovery-adapters.ts:1092) pulls ALL of a registry
 * entry's source refs into the required snapshot closure once one of them (handlers/proofstory.ts)
 * is relevant. Because pureRoot never stubs the other two, they surface as snapshot_missing blind
 * spots, flipping deriveAcceptanceCoverageBasis's plannedBeforeCode.basis.status from 'complete' to
 * 'partial' -- a fixture staleness bug (production PROCESS_FACT_REGISTRY is correct).
 *
 * Before the fix: FAILS at the 'partial' vs 'complete' assertion, mentioning both missing paths.
 * After the fix (both files stubbed in writeCanonicalAcceptanceRegistration): PASSES.
 *
 * Uses spawnSync with the child's stderr redirected to a real file descriptor (not a pipe) --
 * execFileSync's pipe-based capture truncates this fixture's large synchronous crash dump at
 * 8192 bytes on macOS (confirmed empirically), well before the 'actual: ...'/'expected: ...' and
 * blindSpots lines this RED proof depends on.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-B-74b9-chk001-acceptance-basis.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && !existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')) || existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const target = join(repoRoot, 'packages/main/dist/tasks/proofstory-acceptance-basis-smoke.js');
const captureDir = mkdtempSync(join(tmpdir(), 'red-b74b9-chk001-'));
const stderrPath = join(captureDir, 'stderr.txt');

try {
  const fd = openSync(stderrPath, 'w');
  const result = spawnSync(process.execPath, [target], { cwd: repoRoot, stdio: ['ignore', 'ignore', fd] });
  closeSync(fd);

  const stderr = readFileSync(stderrPath, 'utf8');

  assert.notEqual(result.status, 0, 'RED: proofstory-acceptance-basis-smoke.js is expected to fail (still exhibits the pre-fix fixture-staleness defect)');
  assert.match(stderr, /valid PLAN endpoints are structurally complete before implementation files exist/, 'RED: expected the plannedBeforeCode assertion message');
  assert.match(stderr, /actual:\s*'partial'/, 'RED: expected an actual: \'partial\' assertion mismatch');
  assert.match(stderr, /expected:\s*'complete'/, 'RED: expected an expected: \'complete\' assertion mismatch');
  assert.match(stderr, /acceptance-rollout\.ts/, 'RED: expected the acceptance-rollout.ts snapshot_missing blind spot to be visible in output');
  assert.match(stderr, /run-proofstory-acceptance-rollout-cohort\.mjs/, 'RED: expected the run-proofstory-acceptance-rollout-cohort.mjs snapshot_missing blind spot to be visible in output');

  console.log('RED red-B-74b9-chk001-acceptance-basis: confirmed pre-fix defect (partial vs complete, both blind spots present)');
} finally {
  rmSync(captureDir, { recursive: true, force: true });
}
