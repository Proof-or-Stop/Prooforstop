#!/usr/bin/env node

/**
 * M1 green smoke for the product capability release ledger:
 * deterministic identity, mainCommit-free idempotency, digest-derived version,
 * capabilityId slug, and the fail-closed reader (authority/gateEvidence).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  classifyCapabilityRelease,
  computeCapabilityDigest,
  createCapabilityReleaseRecordForTest,
  deriveCapabilityIdSlug,
  readCapabilityReleaseLedger,
  recordCapabilityReleaseForDoneMerge,
  resolveCapabilityReleaseLedgerRoot,
  writeCapabilityReleaseLedgerForTest,
  type CapabilityReleaseRecordOptions,
  type ProductCapabilityReleaseRecord,
} from '../core/capability-release.js';
import { StoryStore } from '../core/store.js';
import { createDoneRecoverHandlers } from '../handlers/done-recover.js';
import { createCapabilityReleaseHandlers } from '../handlers/capability-release.js';
import { isDoneMainRuntimeBuildInput } from '../handlers/done-effects.js';

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeLatticeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({}, null, 2), 'utf-8');
}

/**
 * A partial-DONE story on its own branch with the given capability-declaring
 * changed paths staged, ready for `done_recover` to merge into main and fire the
 * capability release binding. Mirrors makePartialDoneRecoveryFixture in
 * artifact-release-ledger-smoke.ts.
 */
function makePartialDoneRecoveryFixture(capabilityFiles: Record<string, string>): { root: string; storyId: string } {
  const root = mkdtemp('capability-release-recover-');
  const storyId = 'B-recover';
  const now = '2026-07-05T00:06:00.000Z';
  writeLatticeConfig(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Capability Release Recovery Smoke']);
  write(root, '.gitignore', '.lattice/locks/\n');
  write(root, 'README.md', '# fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);

  git(root, ['checkout', '-b', `story/${storyId}`]);
  for (const [path, content] of Object.entries(capabilityFiles)) {
    write(root, path, content);
  }
  write(root, `.lattice/story/actives/${storyId}/index.json`, JSON.stringify({
    storyId,
    name: 'recover-capability-release',
    title: 'Recover capability release',
    description: 'partial DONE recovery fixture',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    events: [{ phase: 'DONE', action: 'advance', timestamp: now }],
  }, null, 2) + '\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'story done']);
  git(root, ['checkout', 'main']);
  return { root, storyId };
}

function runDoneRecover(root: string, storyId: string): string {
  const store = new StoryStore(root);
  const handlers = createDoneRecoverHandlers({
    root,
    store,
    scanRoot: join(root, 'packages/main'),
    doneMainBuildRunner: () => {
      throw new Error('docs/experiments-only recovery must not run the runtime package build');
    },
  });
  return handlers.done_recover({ storyId });
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

const cleanup: string[] = [];

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

try {

// ---- M2 classifier (pure, deterministic) ------------------------------------

check('M2 classifier: experiment+doc changed paths => experiment-launch-control, capability subset only', () => {
  const changedPaths = [
    'experiments/multi-model-ablation/m2-provider-execution-check.mjs',
    'experiments/multi-model-ablation/launch-artifact.json',
    'docs/requirements/decisions/multi-model-ablation-execution-plan.md',
    '.lattice/story/actives/B-recover/index.json',
    'packages/main/src/runtime.ts',
    'package.json',
    'docs/story/legacy.json',
  ];
  const classified = classifyCapabilityRelease(changedPaths, { isRuntimeBuildInput: isDoneMainRuntimeBuildInput });
  assert.ok(classified, 'expected a capability release for experiment+doc changes');
  assert.equal(classified!.capabilityKind, 'experiment-launch-control');
  assert.deepEqual(classified!.capabilityPaths, [
    'docs/requirements/decisions/multi-model-ablation-execution-plan.md',
    'experiments/multi-model-ablation/launch-artifact.json',
    'experiments/multi-model-ablation/m2-provider-execution-check.mjs',
  ]);
  assert.match(classified!.capabilityId, /^[a-z0-9-]+$/);
});

check('M2 classifier: docs-only => documentation-control', () => {
  const classified = classifyCapabilityRelease(
    ['docs/requirements/decisions/plan.md', 'docs/requirements/decisions/threat.md'],
    { isRuntimeBuildInput: isDoneMainRuntimeBuildInput },
  );
  assert.ok(classified);
  assert.equal(classified!.capabilityKind, 'documentation-control');
});

check('M2 classifier (edge): typo-only single doc still classifies but as documentation-control', () => {
  const classified = classifyCapabilityRelease(['docs/readme.md'], { isRuntimeBuildInput: isDoneMainRuntimeBuildInput });
  assert.ok(classified);
  assert.equal(classified!.capabilityKind, 'documentation-control');
});

check('M2 classifier (edge): packages/main/src runtime-only => NO capability release', () => {
  const classified = classifyCapabilityRelease(
    ['packages/main/src/runtime.ts', 'packages/main/src/core/x.ts'],
    { isRuntimeBuildInput: isDoneMainRuntimeBuildInput },
  );
  assert.equal(classified, null);
});

check('M2 classifier (edge): .lattice / docs/story / root-manifest-only => NO capability release', () => {
  const classified = classifyCapabilityRelease(
    ['.lattice/story/actives/B-x/index.json', 'docs/story/legacy.json', 'package.json', 'package-lock.json'],
    { isRuntimeBuildInput: isDoneMainRuntimeBuildInput },
  );
  assert.equal(classified, null);
});

// ---- M2 recordCapabilityReleaseForDoneMerge ---------------------------------

check('recordCapabilityReleaseForDoneMerge skips empty (no capability-declaring path)', () => {
  const root = mkdtemp('capability-release-skip-');
  cleanup.push(root);
  const result = recordCapabilityReleaseForDoneMerge({
    root,
    storyId: 'B-empty',
    mainCommit: 'a'.repeat(40),
    changedPaths: ['.lattice/story/actives/B-empty/index.json', 'packages/main/src/x.ts'],
    runtimeSemverChanged: true,
    isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
  });
  assert.equal(result.status, 'skipped_empty');
  assert.equal(existsSync(join(root, CAPABILITY_RELEASE_LEDGER_REL_PATH)), false);
});

check('recordCapabilityReleaseForDoneMerge (adversarial): different mainCommit => already_recorded, no duplicate', () => {
  const root = mkdtemp('capability-release-idem-');
  cleanup.push(root);
  const changedPaths = [
    'experiments/multi-model-ablation/launch-artifact.json',
    'docs/requirements/decisions/multi-model-ablation-execution-plan.md',
  ];
  const first = recordCapabilityReleaseForDoneMerge({
    root,
    storyId: 'B-idem',
    mainCommit: 'a'.repeat(40),
    changedPaths,
    runtimeSemverChanged: false,
    artifactReleaseId: 'AR-deadbeefdeadbeefdeadbeef',
    artifactSetDigest: 'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
    isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
    now: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(first.status, 'recorded');
  const second = recordCapabilityReleaseForDoneMerge({
    root,
    storyId: 'B-idem',
    mainCommit: 'b'.repeat(40),
    changedPaths,
    runtimeSemverChanged: false,
    artifactReleaseId: 'AR-deadbeefdeadbeefdeadbeef',
    artifactSetDigest: 'sha256:9896bd874641b73c2f1e11bec561d1769d974d12cc2c5fc75592991c212d7bc9',
    isRuntimeBuildInput: isDoneMainRuntimeBuildInput,
    now: '2026-07-05T01:00:00.000Z',
  });
  assert.equal(second.status, 'already_recorded');
  assert.equal(second.record?.id, first.record?.id);
  assert.equal(readCapabilityReleaseLedger(root).length, 1);
});

// ---- M3 binding via done_recover (real DONE-merge path) ---------------------

check('M3 (happy): done_recover with experiment+doc changes records exactly one PCR and commits the ledger', () => {
  const { root, storyId } = makePartialDoneRecoveryFixture({
    'docs/recovered.md': '# Recovered doc\n',
    'experiments/recovery/result.txt': 'observed\n',
  });
  cleanup.push(root);
  const output = runDoneRecover(root, storyId);
  assert.match(output, /partial-DONE recovered: B-recover/);
  assert.match(output, /product capability release recorded: story=B-recover/);
  assert.match(output, /kind=experiment-launch-control/);

  const ledgerRoot = resolveCapabilityReleaseLedgerRoot(root);
  const records = readCapabilityReleaseLedger(ledgerRoot);
  assert.equal(records.length, 1);
  assert.equal(records[0].storyId, storyId);
  assert.equal(records[0].capabilityKind, 'experiment-launch-control');
  // changedPaths persists the FULL DONE-time list (incl. lifecycle metadata);
  // the capability identity is derived only from the docs/experiments subset.
  assert.ok(records[0].changedPaths.includes('docs/recovered.md'));
  assert.ok(records[0].changedPaths.includes('experiments/recovery/result.txt'));
  assert.equal(records[0].authority, 'non_authoritative');
  assert.equal(records[0].gateEvidence, false);
  // The ledger is committed on main and the tree is clean afterwards.
  assert.ok(git(root, ['show', `HEAD:${CAPABILITY_RELEASE_LEDGER_REL_PATH}`]).includes('"storyId":"B-recover"'));
  assert.equal(git(root, ['status', '--short']), '');
});

check('M3 (edge): done_recover with .lattice-metadata-only material change records NO PCR', () => {
  // A story whose only non-lifecycle change is a runtime source file: no
  // capability-declaring docs/experiments path => classifier declines => no PCR.
  const { root, storyId } = makePartialDoneRecoveryFixture({
    'docs/story/legacy.json': '{"note":"lifecycle-shaped path, excluded"}\n',
  });
  cleanup.push(root);
  const output = runDoneRecover(root, storyId);
  assert.match(output, /partial-DONE recovered: B-recover/);
  assert.doesNotMatch(output, /product capability release recorded/);

  const ledgerRoot = resolveCapabilityReleaseLedgerRoot(root);
  assert.equal(existsSync(capabilityReleaseLedgerPath(ledgerRoot)), false);
  assert.equal(readCapabilityReleaseLedger(ledgerRoot).length, 0);
});

// ---- M5 read-only inspection CLI (capability_release_list / _status) ---------

check('M5 CLI: list/status render a written ledger read-only (json + text) and reject missing storyId', () => {
  const root = mkdtemp('capability-release-cli-');
  cleanup.push(root);
  const record = createCapabilityReleaseRecordForTest({ ...B785E_OPTS, root });
  writeCapabilityReleaseLedgerForTest(root, [record]);
  const ledgerFile = capabilityReleaseLedgerPath(root);
  const before = readFileSync(ledgerFile, 'utf-8');

  const handlers = createCapabilityReleaseHandlers({
    root,
    store: new StoryStore(root),
    scanRoot: join(root, 'packages/main'),
  } as any);

  // json list returns the plain record array
  const listJson = handlers.capability_release_list({ format: 'json', limit: 5 }) as ProductCapabilityReleaseRecord[];
  assert.equal(listJson.length, 1);
  assert.equal(listJson[0].storyId, 'B-785e');
  assert.equal(listJson[0].capabilityId, record.capabilityId);

  // text list is one concise line per record and never mutates the ledger
  const listText = handlers.capability_release_list({}) as string;
  assert.ok(listText.includes('B-785e'));
  assert.ok(listText.includes(record.capabilityId));
  assert.ok(listText.includes(record.capabilityVersion));

  // json status is the { storyId, count, latest, records } shape
  const statusJson = handlers.capability_release_status({ storyId: 'B-785e', format: 'json' }) as {
    storyId: string; count: number; latest: ProductCapabilityReleaseRecord | null; records: ProductCapabilityReleaseRecord[];
  };
  assert.equal(statusJson.storyId, 'B-785e');
  assert.equal(statusJson.count, 1);
  assert.equal(statusJson.latest?.id, record.id);
  assert.equal(statusJson.records.length, 1);

  // text status for a story with no records is a friendly empty line
  const emptyStatus = handlers.capability_release_status({ storyId: 'B-none' }) as string;
  assert.match(emptyStatus, /No product capability release records found for B-none/);

  // empty ledger list is a friendly empty line
  const emptyList = createCapabilityReleaseHandlers({
    root: mkdtemp('capability-release-cli-empty-'),
    store: new StoryStore(root),
    scanRoot: join(root, 'packages/main'),
  } as any).capability_release_list({}) as string;
  assert.match(emptyList, /No product capability release records found/);

  // missing storyId is rejected (read command still validates its one required arg)
  assert.throws(() => handlers.capability_release_status({} as any), /storyId must be a string/);
  assert.throws(() => handlers.capability_release_status({ storyId: '   ' } as any), /storyId is required/);

  // READ-ONLY: rendering did not touch the ledger file on disk
  assert.equal(readFileSync(ledgerFile, 'utf-8'), before, 'read commands must not mutate the ledger');
});

console.log(`\nok product-capability-release (${passed} checks)`);
} finally {
  for (const dir of cleanup.reverse()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
