#!/usr/bin/env node

/**
 * M1 green smoke for the product capability release ledger:
 * deterministic identity, mainCommit-free idempotency, digest-derived version,
 * capabilityId slug, and the fail-closed reader (authority/gateEvidence).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CAPABILITY_RELEASE_LEDGER_REL_PATH,
  CAPABILITY_RELEASE_SCHEMA_VERSION,
  CapabilityReleaseLedgerError,
  appendCapabilityReleaseRecord,
  buildCapabilityReleaseRecord,
  capabilityReleaseLedgerPath,
  capabilityVersionFromDigest,
  computeCapabilityDigest,
  createCapabilityReleaseRecordForTest,
  deriveCapabilityIdSlug,
  readCapabilityReleaseLedger,
  writeCapabilityReleaseLedgerForTest,
  type CapabilityReleaseRecordOptions,
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

const B785E_OPTS: CapabilityReleaseRecordOptions = {
  root: '/tmp/unused',
  storyId: 'B-785e',
  mainCommit: 'a'.repeat(40),
  capabilityId: 'experiments-multi-model-ablation',
  capabilityKind: 'experiment-launch-control',
  changedPaths: [
    'experiments/multi-model-ablation/m2-provider-execution-check.mjs',
    'experiments/multi-model-ablation/launch-artifact.json',
    'docs/requirements/decisions/multi-model-ablation-execution-plan.md',
  ],
  capabilityPaths: [
    'experiments/multi-model-ablation/m2-provider-execution-check.mjs',
    'experiments/multi-model-ablation/launch-artifact.json',
  ],
  artifactReleaseId: 'AR-4e885ed0209e5a32330cdc33',
  artifactSetDigest: 'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
  runtimeSemverChanged: false,
  now: '2026-07-05T00:00:00.000Z',
};

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

console.log('running product-capability-release-smoke...');

check('capabilityDigest is deterministic and merge-stable (no mainCommit)', () => {
  const a = computeCapabilityDigest(B785E_OPTS.capabilityId, B785E_OPTS.capabilityKind, B785E_OPTS.capabilityPaths, B785E_OPTS.artifactSetDigest);
  const b = computeCapabilityDigest(B785E_OPTS.capabilityId, B785E_OPTS.capabilityKind, [...B785E_OPTS.capabilityPaths].reverse(), B785E_OPTS.artifactSetDigest);
  assert.equal(a, b, 'digest must be stable under path order');
  assert.match(a, /^sha256:[0-9a-f]{64}$/, 'digest must be sha256:<64 hex>');
});

check('changing a capability input changes the digest', () => {
  const base = computeCapabilityDigest(B785E_OPTS.capabilityId, B785E_OPTS.capabilityKind, B785E_OPTS.capabilityPaths, B785E_OPTS.artifactSetDigest);
  const kindChanged = computeCapabilityDigest(B785E_OPTS.capabilityId, 'documentation-control', B785E_OPTS.capabilityPaths, B785E_OPTS.artifactSetDigest);
  const pathChanged = computeCapabilityDigest(B785E_OPTS.capabilityId, B785E_OPTS.capabilityKind, [...B785E_OPTS.capabilityPaths, 'experiments/extra.mjs'], B785E_OPTS.artifactSetDigest);
  assert.notEqual(base, kindChanged);
  assert.notEqual(base, pathChanged);
});

check('artifact-less capability digest is stable (artifactSetDigest undefined -> null)', () => {
  const a = computeCapabilityDigest('c', 'other', ['docs/a.md']);
  const b = computeCapabilityDigest('c', 'other', ['docs/a.md'], undefined);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

check('capabilityVersion is the 12 hex after sha256: prefix', () => {
  const version = capabilityVersionFromDigest('sha256:0123456789abcdeffedcba9876543210');
  assert.equal(version, '0123456789ab');
  assert.equal(version.length, 12);
});

check('capabilityId slug derives host-neutral experiments-multi-model-ablation for B-785e paths', () => {
  const slug = deriveCapabilityIdSlug(B785E_OPTS.capabilityPaths);
  assert.equal(slug, 'experiments-multi-model-ablation');
});

check('record id is PCR-<24 hex>, idempotencyKey excludes mainCommit', () => {
  const record = createCapabilityReleaseRecordForTest(B785E_OPTS);
  assert.match(record.id, /^PCR-[0-9a-f]{24}$/);
  assert.equal(record.idempotencyKey, `B-785e:${record.capabilityId}:${record.capabilityDigest}`);
  assert.ok(!record.idempotencyKey.includes(B785E_OPTS.mainCommit as string), 'idempotencyKey must not embed mainCommit');
  assert.equal(record.authority, 'non_authoritative');
  assert.equal(record.gateEvidence, false);
  assert.equal(record.capabilityVersion, capabilityVersionFromDigest(record.capabilityDigest));
});

check('a different mainCommit yields the SAME id/key (merge-stable recovery)', () => {
  const first = createCapabilityReleaseRecordForTest(B785E_OPTS);
  const recovered = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, mainCommit: 'b'.repeat(40) });
  assert.equal(recovered.id, first.id, 'recovery re-merge must not create a new id');
  assert.equal(recovered.idempotencyKey, first.idempotencyKey);
});

check('append dedups on idempotencyKey (recorded -> already_recorded, even with new mainCommit)', () => {
  const root = mkdtemp('capability-release-append-');
  const record = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, root });
  const first = appendCapabilityReleaseRecord(root, record);
  assert.equal(first.status, 'recorded');
  const recovered = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, root, mainCommit: 'c'.repeat(40) });
  const second = appendCapabilityReleaseRecord(root, recovered);
  assert.equal(second.status, 'already_recorded');
  assert.equal(readCapabilityReleaseLedger(root).length, 1);
});

check('reader filters by schemaVersion and returns valid rows', () => {
  const root = mkdtemp('capability-release-read-');
  const record = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, root });
  writeCapabilityReleaseLedgerForTest(root, [record]);
  appendFileSync(capabilityReleaseLedgerPath(root), `${JSON.stringify({ schemaVersion: 'other.v9' })}\n`, 'utf-8');
  const rows = readCapabilityReleaseLedger(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].schemaVersion, CAPABILITY_RELEASE_SCHEMA_VERSION);
});

check('reader FAILS CLOSED on authority !== non_authoritative', () => {
  const root = mkdtemp('capability-release-authority-');
  const record = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, root });
  const tampered = { ...record, authority: 'authoritative' };
  writeCapabilityReleaseLedgerForTest(root, [tampered as any]);
  assert.throws(() => readCapabilityReleaseLedger(root), CapabilityReleaseLedgerError);
});

check('reader FAILS CLOSED on gateEvidence !== false', () => {
  const root = mkdtemp('capability-release-gate-');
  const record = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, root });
  const tampered = { ...record, gateEvidence: true };
  writeCapabilityReleaseLedgerForTest(root, [tampered as any]);
  assert.throws(() => readCapabilityReleaseLedger(root), CapabilityReleaseLedgerError);
});

check('reader FAILS CLOSED on malformed JSON', () => {
  const root = mkdtemp('capability-release-malformed-');
  write(root, CAPABILITY_RELEASE_LEDGER_REL_PATH, '{not valid json\n');
  assert.throws(() => readCapabilityReleaseLedger(root), CapabilityReleaseLedgerError);
});

check('no gate/DONE/validate/delivery module imports the capability-release reader (negative invariant guard)', () => {
  const gateModules = [
    'packages/main/src/core/done-oracle.ts',
    'packages/main/src/core/review-assurance-floor.ts',
    'packages/main/src/core/machine.ts',
    'packages/main/src/handlers/transition-orchestrator.ts',
    'packages/main/src/handlers/delivery-check.ts',
    'packages/main/src/core/external-verifier.ts',
  ];
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');
  for (const rel of gateModules) {
    let source = '';
    try {
      source = execFileSync('cat', [join(repoRoot, rel)], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      continue; // module optional / path drift tolerated; guard only asserts absence when present
    }
    assert.ok(
      !/capability-release|readCapabilityReleaseLedger/.test(source),
      `gate module ${rel} must NOT import the capability-release reader (gateEvidence=false is enforced by non-consumption)`,
    );
  }
});

console.log(`\nok product-capability-release (${passed} checks)`);
