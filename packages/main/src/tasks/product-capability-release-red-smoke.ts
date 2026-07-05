#!/usr/bin/env node

/**
 * M0 REPRO-FIRST RED smoke (hermetic).
 *
 * Proves the gap on a controlled mkdtemp fixture: a B-785e-shaped DONE produced
 * an artifact release AND a product capability release (M1), plus a candidate
 * playbook — but the candidate's lineage carries only the current 3 fields and
 * does NOT reference the capability release. This test asserts the desired
 * post-state (candidate.lineage.capabilityReleaseId === the capability release
 * id) and therefore FAILS RED until M4 lineage binding produces the fixture
 * candidate via the real enrichment path. It reads no live repo-root .lattice
 * state, so it is hermetic and re-runnable (and does not self-invalidate against
 * the backfill proof).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createCapabilityReleaseRecordForTest,
  writeCapabilityReleaseLedgerForTest,
} from '../core/capability-release.js';

function mkdtemp(prefix: string): string {
  return execFileSync('mktemp', ['-d', join(tmpdir(), `${prefix}XXXXXX`)], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

console.log('running product-capability-release-red-smoke...');

const root = mkdtemp('capability-release-red-');

// A B-785e-shaped artifact release row (fixture, not live).
write(
  root,
  '.lattice/artifact-releases.jsonl',
  JSON.stringify({
    schemaVersion: 'proofbound.artifact-release.v1',
    id: 'AR-4e885ed0209e5a32330cdc33',
    idempotencyKey: 'B-785e:main:sha256:9896bd',
    storyId: 'B-785e',
    artifactSetDigest: 'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
    paths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
  }) + '\n',
);

// The product capability release M1/M3 records for the same story.
const capabilityRelease = createCapabilityReleaseRecordForTest({
  root,
  storyId: 'B-785e',
  mainCommit: 'a'.repeat(40),
  capabilityId: 'experiments-multi-model-ablation',
  capabilityKind: 'experiment-launch-control',
  changedPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
  capabilityPaths: ['experiments/multi-model-ablation/m2-provider-execution-check.mjs'],
  artifactReleaseId: 'AR-4e885ed0209e5a32330cdc33',
  artifactSetDigest: 'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
  runtimeSemverChanged: false,
  now: '2026-07-05T00:00:00.000Z',
});
writeCapabilityReleaseLedgerForTest(root, [capabilityRelease]);

// A PBP-882-shaped candidate as the CURRENT DONE ingest produces it: 3-field
// lineage, no capability binding. (At M4 this candidate will instead be produced
// by the real enrichment path, which attaches capabilityReleaseId.)
const candidate = {
  id: 'PBP-882',
  title: 'Playbook: DONE experience B-785e',
  status: 'candidate',
  lineage: {
    sourceStoryId: 'B-785e',
    sourceFindingId: 'B-785e:DONE-EXPERIENCE',
    sourceSignature: 'done_experience',
  },
  usage: { surfacedCount: 0 },
};
write(root, '.lattice/learning/playbooks.json', JSON.stringify([candidate], null, 2) + '\n');

// THE GAP (RED until M4): the DONE candidate for B-785e must reference its
// product capability release, but current lineage does not carry it.
assert.equal(
  (candidate.lineage as { capabilityReleaseId?: string }).capabilityReleaseId,
  capabilityRelease.id,
  `RED: DONE candidate for B-785e (PBP-882) lacks capability release lineage; ` +
    `expected lineage.capabilityReleaseId === ${capabilityRelease.id}. ` +
    `Goes green when M4 binds capability lineage on the same fixture.`,
);

console.log('ok product-capability-release-red (unexpected: gap already closed)');
