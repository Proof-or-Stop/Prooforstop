#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import { evaluateDeliveryCheckFreshness, signDeliveryCheck } from '../core/delivery-check-hash.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { buildStoryReadinessReport } from '../core/lifecycle-readiness.js';
import { canFinishGuard, getGuardFailureReason, type StoryMachineContext } from '../core/machine.js';
import { getProcessFactRegistryEntry, hasProcessFactSemantic } from '../core/process-fact-registry.js';
import { StoryStore } from '../core/store.js';
import type { ClosingSelfCheck, DeliveryCheckData, DocsPromise, RealMachineTest, StoryInfo } from '../core/types.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';

const STORY_ID = 'B-delivery-fresh';
const NOW = '2026-06-23T12:00:00.000Z';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'delivery-check-freshness-smoke',
      GIT_AUTHOR_EMAIL: 'delivery-check-freshness-smoke@example.invalid',
      GIT_COMMITTER_NAME: 'delivery-check-freshness-smoke',
      GIT_COMMITTER_EMAIL: 'delivery-check-freshness-smoke@example.invalid',
    },
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' },
  }, null, 2) + '\n');
  resetConfigCache();
}

// Story-owned file committed on the story branch ahead of main. Because it
// differs from main, currentStoryFilesHash is NON-EMPTY (not the empty-set
// constant the old all-on-main fixture produced), so the storyFilesHash
// drift-advisory downgrade keys on the real story-owned diff: a non-story
// whole-tree drift keeps it matching (advisory), a story-owned change breaks
// it (strict stale).
const STORY_FILE = 'packages/main/src/feature.ts';
const STORY_BRANCH = `story/${STORY_ID}`;

function createFixture(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'delivery-check-freshness-'));
  writeConfig(root);
  write(root, 'README.md', '# delivery check freshness smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const deliveryFreshness = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  // STORY-BRANCH topology: HEAD is ahead of main with a story-owned source file
  // so currentStoryFilesHash is non-empty and tracks story-owned changes.
  git(root, ['checkout', '-b', STORY_BRANCH]);
  write(root, STORY_FILE, 'export const feature = "v1";\n');
  git(root, ['add', STORY_FILE]);
  git(root, ['commit', '-m', 'story feature']);

  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId: STORY_ID,
    name: 'delivery-check-freshness-smoke',
    title: 'Delivery check freshness smoke',
    description: 'Synthetic story for delivery-check material freshness.',
    type: 'chore',
    phase: 'TEST',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: 'round-1',
  };
  store.writeStory(STORY_ID, story);
  store.writeChecklist(STORY_ID, {
    items: [{
      id: 'CHK-001',
      title: 'Synthetic delivery item',
      context: 'Synthetic delivery context',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
      verificationIntent: {
        happy: [{ desc: 'delivery smoke proof exists', type: 'logic', priority: 'must' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [{
        intentRef: 'CHK-001:happy:0',
        kind: 'logic_test',
        result: 'pass',
        note: 'synthetic proof for delivery-check freshness smoke',
      }],
    }],
  });
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(headHash, 'fixture must have a git HEAD');
  assert.ok(materialHash, 'fixture must have a materialHash');
  store.writeTestEvidence(STORY_ID, {
    command: 'delivery-check-freshness-smoke',
    output: JSON.stringify({ allPass: true, summary: 'delivery-check-freshness smoke validation passed' }),
    result: 'PASS',
    timestamp: NOW,
    headHash,
    materialHash,
    verificationCoverage: {
      total: 1,
      required: 1,
      covered: 1,
      missingRequired: 0,
      entries: [],
    },
  });
  return { root, store };
}

function closingSelfCheck(): ClosingSelfCheck {
  return {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Delivery freshness smoke checked real machine behavior.',
  };
}

function realMachineTests(): RealMachineTest[] {
  return [{
    featureId: 'CHK-001',
    transcript: 'delivery-check-freshness smoke transcript: current material binding was exercised.',
  }];
}

function deliveryCheckSet(root: string, store: StoryStore, docsPromises: DocsPromise[] = []): DeliveryCheckData {
  const handlers = createDeliveryCheckHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const output = handlers.delivery_check_set({
    storyId: STORY_ID,
    docsPromises,
    realMachineTests: realMachineTests(),
    closingSelfCheck: closingSelfCheck(),
    agentId: 'lattice-review-delivery',
  });
  assert.match(output, /Delivery check saved/, 'delivery_check_set should save the check');
  const data = store.readDeliveryCheck(STORY_ID);
  assert.ok(data, 'delivery_check_set must write delivery-check.json');
  if (git(root, ['status', '--porcelain', '--', '.lattice'])) {
    git(root, ['add', '.lattice']);
    git(root, ['commit', '-m', 'delivery metadata']);
  }
  return data;
}

function legacyDeliveryCheck(): DeliveryCheckData {
  const docsPromises: DocsPromise[] = [];
  const machineTests = realMachineTests();
  const selfCheck = closingSelfCheck();
  return {
    storyId: STORY_ID,
    checkedAt: NOW,
    reviewRound: 'round-1',
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests: machineTests,
    closingSelfCheck: selfCheck,
    _hash: signDeliveryCheck(STORY_ID, docsPromises, machineTests, selfCheck, 'round-1'),
  };
}

function doneRow(store: StoryStore, root: string) {
  const row = buildDoneChecklist(STORY_ID, store, root, { gitCwd: root, auditWriter: null })
    .find(candidate => candidate.id === 'delivery-check');
  assert.ok(row, 'DONE checklist must include delivery-check row');
  return row;
}

function lifecycleDeliveryRow(store: StoryStore, root: string) {
  const report = buildStoryReadinessReport({ storyId: STORY_ID, target: 'DONE', store, root, gitCwd: root });
  const row = report.readiness.find(candidate => candidate.id === 'done.delivery-check');
  assert.ok(row, 'lifecycle readiness must include done.delivery-check row');
  return { report, row };
}

function machineContext(store: StoryStore, root: string): StoryMachineContext {
  return { storyId: STORY_ID, store, projectRoot: root, gitCwd: root };
}

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  pass: ${name}`);
}

check('delivery_check_set records materialHash as binding and headHash as audit metadata', () => {
  const { root, store } = createFixture();
  try {
    const beforeHead = currentGitHead(root);
    const beforeMaterial = currentMaterialHash(root, 'HEAD', root);
    const delivery = deliveryCheckSet(root, store);
    const afterHead = currentGitHead(root);
    const afterMaterial = currentMaterialHash(root, 'HEAD', root);

    assert.ok(delivery.headHash, 'delivery-check records headHash');
    assert.ok(delivery.materialHash, 'delivery-check records materialHash');
    assert.equal(delivery.headHash, beforeHead, 'headHash captures the reviewed HEAD for audit');
    assert.equal(delivery.materialHash, beforeMaterial, 'materialHash captures reviewed material');
    assert.notEqual(afterHead, delivery.headHash, 'metadata-only delivery-check commit may move HEAD');
    assert.equal(afterMaterial, delivery.materialHash, 'metadata-only head drift leaves material unchanged');
    assert.equal(evaluateDeliveryCheckFreshness(STORY_ID, store, root, root).ok, true, 'metadata-only head drift must remain fresh');
    assert.equal(doneRow(store, root).status, 'pass', 'DONE oracle accepts fresh material binding');
    // The story-branch topology carries a real material code diff (feature.ts vs
    // main), so the machine guard legitimately blocks on the review-assurance
    // floor (a synthetic fixture submits no review round). That is an UNRELATED
    // gate — assert only that the delivery-check itself is not the blocker, so
    // this regression guard stays scoped to delivery-check freshness without
    // weakening any gate by faking a review round.
    const happyReason = getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '';
    assert.doesNotMatch(happyReason, /stale_delivery_check|delivery_check_tampered|missing_delivery_check/, 'fresh delivery-check must not be the guard blocker');

    const { report, row } = lifecycleDeliveryRow(store, root);
    assert.equal(row.code, 'delivery_check_passed', 'lifecycle readiness accepts fresh delivery check');
    assert.equal(report.artifacts.deliveryCheckRef?.materialHash, delivery.materialHash, 'readiness exposes materialHash binding');
    assert.equal(report.artifacts.deliveryCheckRef?.headHash, delivery.headHash, 'readiness exposes headHash audit metadata');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The exact, asserted advisory wording surfaced on the DONE delivery-check row
// for a non-story whole-tree drift (CHK-003 + CHK-004 happy intent). Pinning the
// literal text guards against the advisory being silently dropped or reworded.
const EXPECTED_ADVISORY =
  'whole-tree materialHash drift detected while the signed delivery-check storyFilesHash matches; the story diff the reviewer attested is unchanged. Re-attestation advisory: re-run the lattice-review-delivery reviewer if the merged-in (non-story) code could affect the real-machine test claims.';

check('non-story whole-tree drift downgrades to a mandatory re-attestation advisory (DONE row passes with the advisory text)', () => {
  const { root, store } = createFixture();
  try {
    // Sanity: the story-branch fixture yields a non-empty storyFilesHash so the
    // downgrade keys on the real story diff (not the empty-set constant).
    const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
    assert.ok(storyFilesHash, 'story-branch fixture must produce a storyFilesHash');
    assert.notEqual(
      storyFilesHash,
      currentStoryFilesHash(root, 'main', root),
      'story-branch HEAD must differ from main so storyFilesHash is non-empty',
    );

    const delivery = deliveryCheckSet(root, store);
    assert.ok(delivery.storyFilesHash, 'delivery_check_set must persist a signed storyFilesHash');

    // Non-story whole-tree drift: change a NON-story file on main, then merge
    // main into the story branch. The whole-tree materialHash changes, but the
    // story-owned diff vs main is byte-identical (the changed file lives on both
    // branches), so storyFilesHash still matches the recorded signed value.
    const storyTip = currentGitHead(root);
    git(root, ['checkout', 'main']);
    write(root, 'README.md', '# delivery check freshness smoke\n\nunrelated main change\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'unrelated main drift']);
    git(root, ['checkout', STORY_BRANCH]);
    git(root, ['merge', '--no-edit', 'main']);

    assert.notEqual(currentMaterialHash(root, 'HEAD', root), delivery.materialHash, 'whole-tree material drift must change materialHash');
    assert.equal(currentStoryFilesHash(root, 'HEAD', root), delivery.storyFilesHash, 'non-story drift leaves the story-owned diff (storyFilesHash) unchanged');
    assert.notEqual(currentGitHead(root), storyTip, 'merge must advance HEAD');

    const freshness = evaluateDeliveryCheckFreshness(STORY_ID, store, root, root);
    assert.equal(freshness.ok, true, 'non-story drift with matching signed storyFilesHash must downgrade to advisory (not stale)');
    assert.equal(freshness.code, 'delivery_check_drift_advisory', 'freshness code is the drift-advisory downgrade');
    assert.equal(freshness.advisory, EXPECTED_ADVISORY, 'freshness carries the mandatory advisory text');
    assert.equal(store.readDeliveryCheck(STORY_ID)?.materialHash, delivery.materialHash, 'advisory downgrade must NOT rebind the stored materialHash');

    const row = doneRow(store, root);
    assert.equal(row.status, 'pass', 'DONE oracle passes the delivery-check row on the advisory downgrade');
    assert.ok((row.detail ?? '').includes(`— ADVISORY: ${EXPECTED_ADVISORY}`), 'DONE row detail must surface the literal advisory text (never swallowed)');
    // As in the happy case the synthetic story-branch fixture has no review
    // round, so the guard blocks on the review-assurance floor, not on the
    // delivery-check: assert the advisory downgrade did NOT introduce a
    // delivery-check blocker (it must pass freshness like a fresh binding).
    const advisoryReason = getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '';
    assert.doesNotMatch(advisoryReason, /stale_delivery_check|delivery_check_tampered|missing_delivery_check/, 'advisory downgrade must not make delivery-check the guard blocker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('story-owned change after delivery-check is stale across DONE consumers', () => {
  const { root, store } = createFixture();
  try {
    const delivery = deliveryCheckSet(root, store);
    // Story-owned change: edit the story file on the story branch. Both the
    // whole-tree materialHash and the story-owned storyFilesHash change, so the
    // downgrade does NOT apply — strict stale.
    write(root, STORY_FILE, 'export const feature = "v2-story-owned-change";\n');
    git(root, ['add', STORY_FILE]);
    git(root, ['commit', '-m', 'story-owned material drift']);
    assert.notEqual(currentMaterialHash(root, 'HEAD', root), delivery.materialHash, 'story-owned drift must change materialHash');
    assert.notEqual(currentStoryFilesHash(root, 'HEAD', root), delivery.storyFilesHash, 'story-owned drift must change storyFilesHash');

    const row = doneRow(store, root);
    assert.equal(row.status, 'fail', 'DONE oracle rejects a story-owned stale delivery check');
    assert.match(row.detail ?? '', /stale delivery-check: materialHash mismatch/);
    assert.equal(canFinishGuard(machineContext(store, root)), false, 'machine guard blocks stale delivery check');
    assert.match(getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '', /\[stale_delivery_check\]/);

    const { row: readinessRow } = lifecycleDeliveryRow(store, root);
    assert.equal(readinessRow.status, 'blocked', 'lifecycle readiness blocks stale delivery check');
    assert.equal(readinessRow.code, 'stale_delivery_check', 'lifecycle readiness classifies stale delivery check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('forged storyFilesHash breaks the delivery-check integrity hash (signed)', () => {
  const { root, store } = createFixture();
  try {
    const delivery = deliveryCheckSet(root, store);
    assert.ok(delivery.storyFilesHash, 'delivery_check_set must persist a storyFilesHash to forge');
    const forged: DeliveryCheckData = {
      ...delivery,
      storyFilesHash: 'f'.repeat(64),
    };
    assert.notEqual(
      signDeliveryCheck(
        forged.storyId,
        forged.docsPromises,
        forged.realMachineTests,
        forged.closingSelfCheck,
        forged.reviewRound,
        forged.materialHash,
        forged.storyFilesHash,
      ),
      delivery._hash,
      'storyFilesHash must be part of the integrity hash (forging it breaks the signature)',
    );
    store.writeDeliveryCheck(STORY_ID, forged);

    const row = doneRow(store, root);
    assert.equal(row.status, 'fail', 'DONE oracle rejects a forged storyFilesHash');
    assert.match(row.detail ?? '', /_hash mismatch/);
    assert.equal(canFinishGuard(machineContext(store, root)), false);
    assert.match(getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '', /\[delivery_check_tampered\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('legacy delivery-check with no storyFilesHash falls back to strict materialHash stale', () => {
  const { root, store } = createFixture();
  try {
    // Legacy record carries neither materialHash nor storyFilesHash; under a
    // whole-tree drift it must NOT take the advisory downgrade (no signed
    // storyFilesHash to match) and instead fail closed as strict stale.
    store.writeDeliveryCheck(STORY_ID, legacyDeliveryCheck());
    git(root, ['checkout', 'main']);
    write(root, 'README.md', '# delivery check freshness smoke\n\nunrelated main change\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'unrelated main drift']);
    git(root, ['checkout', STORY_BRANCH]);
    git(root, ['merge', '--no-edit', 'main']);

    const freshness = evaluateDeliveryCheckFreshness(STORY_ID, store, root, root);
    assert.equal(freshness.ok, false, 'legacy delivery-check (no storyFilesHash) must fail closed under drift');
    assert.equal(freshness.code, 'stale_delivery_check', 'legacy missing-binding stays strict stale');

    const row = doneRow(store, root);
    assert.equal(row.status, 'fail');
    assert.match(row.detail ?? '', /missing materialHash binding/);
    assert.equal(canFinishGuard(machineContext(store, root)), false);
    assert.match(getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '', /\[stale_delivery_check\]/);
    assert.equal(lifecycleDeliveryRow(store, root).row.code, 'stale_delivery_check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('missing material binding fails closed as stale delivery-check', () => {
  const { root, store } = createFixture();
  try {
    store.writeDeliveryCheck(STORY_ID, legacyDeliveryCheck());

    const row = doneRow(store, root);
    assert.equal(row.status, 'fail');
    assert.match(row.detail ?? '', /missing materialHash binding/);
    assert.equal(canFinishGuard(machineContext(store, root)), false);
    assert.match(getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '', /\[stale_delivery_check\]/);
    assert.equal(lifecycleDeliveryRow(store, root).row.code, 'stale_delivery_check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('tampered material binding breaks delivery-check integrity hash', () => {
  const { root, store } = createFixture();
  try {
    const delivery = deliveryCheckSet(root, store);
    const tampered: DeliveryCheckData = {
      ...delivery,
      materialHash: '0'.repeat(64),
    };
    assert.notEqual(
      signDeliveryCheck(
        tampered.storyId,
        tampered.docsPromises,
        tampered.realMachineTests,
        tampered.closingSelfCheck,
        tampered.reviewRound,
        tampered.materialHash,
        tampered.storyFilesHash,
      ),
      delivery._hash,
      'materialHash must be part of the integrity hash',
    );
    store.writeDeliveryCheck(STORY_ID, tampered);

    const row = doneRow(store, root);
    assert.equal(row.status, 'fail');
    assert.match(row.detail ?? '', /_hash mismatch/);
    assert.equal(canFinishGuard(machineContext(store, root)), false);
    assert.match(getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '', /\[delivery_check_tampered\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('docsPromise validation remains independent after fresh material binding', () => {
  const { root, store } = createFixture();
  try {
    deliveryCheckSet(root, store, [{
      docPath: 'docs/requirements/decisions/delivery-check-freshness.md',
      promise: 'The smoke must preserve unverified docsPromise blocking behavior.',
      status: 'unverified',
    }]);

    const row = doneRow(store, root);
    assert.equal(row.status, 'fail');
    assert.match(row.detail ?? '', /docsPromise entries are unverified/);
    assert.equal(lifecycleDeliveryRow(store, root).row.code, 'docs_promise_unresolved');
    assert.match(getGuardFailureReason(STORY_ID, store, 'DONE', root, root) ?? '', /\[unverified_promise\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('process-fact registry keeps delivery-check as L4 signed gate evidence produced by delivery_check_set', () => {
  const command = getProcessFactRegistryEntry('delivery_check_set');
  assert.equal(command?.level, 'L4');
  assert.equal(command?.producer, 'handlers/delivery-check');
  assert.equal(command?.artifact?.path, 'delivery-check.json');
  assert.equal(command?.artifact?.signed, true);
  assert.equal(command?.artifact?.producerCommand, 'delivery_check_set');
  assert.equal(command?.artifact?.reviewerLane, 'lattice-review-delivery');
  assert.equal(hasProcessFactSemantic('delivery_check_set', 'gate-evidence'), true);

  const artifact = getProcessFactRegistryEntry('artifact:delivery-check.json');
  assert.equal(artifact?.level, 'L4');
  assert.equal(artifact?.kind, 'signed-artifact');
  assert.equal(artifact?.artifact?.producerCommand, 'delivery_check_set');
  assert.equal(hasProcessFactSemantic('artifact:delivery-check.json', 'signed-artifact'), true);
  assert.equal(hasProcessFactSemantic('artifact:delivery-check.json', 'gate-evidence'), true);
});

console.log('delivery-check-freshness smoke passed');
