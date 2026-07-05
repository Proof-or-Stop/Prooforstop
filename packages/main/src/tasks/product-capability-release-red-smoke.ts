#!/usr/bin/env node

/**
 * M0 REPRO-FIRST smoke (hermetic) — GREEN after B-8128 M4.
 *
 * Proves the desired post-state on a controlled mkdtemp fixture: a B-785e-shaped
 * DONE produced an artifact release AND a product capability release (M1/M3), and
 * the candidate playbook distilled from that story now BINDS its lineage to the
 * capability release. Instead of hand-writing a candidate WITHOUT the field (the
 * former RED state), this runs the REAL M4 enrichment path
 * (`enrichSeedWithCapabilityLineage` -> `lineageFromSeed`) over a done_experience
 * seed with the capability release present, and asserts
 * `candidate.lineage.capabilityReleaseId === capabilityRelease.id`.
 *
 * It reads no live repo-root .lattice state, so it is hermetic and re-runnable.
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
import {
  candidatePlaybookFromProposal,
  enrichSeedWithCapabilityLineage,
  lineageFromSeed,
  type PlaybookSeedCandidate,
} from '../core/playbook-seed.js';

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

// A B-785e done_experience seed, exactly as the DONE ingest observation produces
// it (3-field lineage material, no capability binding yet).
const seed: PlaybookSeedCandidate = {
  seedId: 'PBS-b785edoneexp001',
  sourceArtifactKind: 'done_experience',
  sourceArtifactId: 'B-785e',
  sourceRef: 'done-experience/B-785e',
  canonicalSourceKey: 'done_experience:B-785e',
  canonicalSourceKeyVersion: 'v1',
  canonicalizationPolicyHash: 'sha256:policy-hash',
  sourceStoryId: 'B-785e',
  sourceFindingId: 'B-785e:DONE-EXPERIENCE',
  sourceSignature: 'done_experience',
  sourceSummary: 'DONE experience for B-785e',
  priority: 3,
  priorityReason: 'DONE experience source priority 3',
};

// THE REAL M4 PATH: enrich the seed against the capability release ledger, then
// derive the lineage exactly as proposalFromSeed does, and build the candidate
// via the real candidatePlaybookFromProposal shape.
const enriched = enrichSeedWithCapabilityLineage(root, seed);
const lineage = lineageFromSeed(enriched);
const candidate = candidatePlaybookFromProposal({
  id: 'PBP-882',
  title: 'Playbook: DONE experience B-785e',
  trigger: { keywords: ['b-785e'], fileKinds: [], storyPhases: ['DONE', 'REVIEW'] },
  check: 'Before similar work, apply this DONE experience.',
  pitfalls: ['Do not treat DONE experience seed material as authoritative gate evidence.'],
  verification: ['Confirm the source condition behind B-785e:DONE-EXPERIENCE cannot recur'],
  lineage,
  seed: {
    sourceArtifactKind: seed.sourceArtifactKind,
    sourceArtifactId: seed.sourceArtifactId,
    sourceRef: seed.sourceRef,
    canonicalSourceKey: seed.canonicalSourceKey,
    canonicalSourceKeyVersion: seed.canonicalSourceKeyVersion,
    canonicalizationPolicyHash: seed.canonicalizationPolicyHash,
  },
  status: 'proposed',
  proposalDigest: '',
});

// GREEN (M4): the DONE candidate for B-785e now references its product capability
// release — lineage.capabilityReleaseId === the capability release id.
assert.equal(
  candidate.lineage.capabilityReleaseId,
  capabilityRelease.id,
  `M4: DONE candidate for B-785e (PBP-882) must bind its capability release; ` +
    `expected lineage.capabilityReleaseId === ${capabilityRelease.id}, got ${candidate.lineage.capabilityReleaseId}.`,
);
assert.equal(candidate.lineage.capabilityId, capabilityRelease.capabilityId);
assert.equal(candidate.lineage.capabilityVersion, capabilityRelease.capabilityVersion);
assert.equal(candidate.lineage.artifactReleaseId, capabilityRelease.artifactReleaseId);
assert.equal(candidate.lineage.artifactSetDigest, capabilityRelease.artifactSetDigest);

console.log('ok product-capability-release M4 lineage binding (candidate binds capability release)');
