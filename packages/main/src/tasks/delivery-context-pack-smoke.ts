#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  enforceStoryOwnerLeaseGate,
  MAIN_TOOLS,
  resolveEffectiveOwnershipClass,
} from '../cli-engine.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, DeliveryCheckData, StoryInfo, VerificationEvidence } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { DeliveryContextPackReport } from '../handlers/delivery-context-pack.js';
import { acquireOwnerLease, ownerLeasePath, resetSessionIdForTest } from '../core/story-owner-lease.js';

const STORY_ID = 'B-delivctx';
const NOW = '2026-06-21T00:00:00.000Z';
const USER_SEES = 'lattice delivery_context_pack --storyId=<story> prints the delivery context pack.';
const PLAN_PROMISE = 'README documents the delivery_context_pack command surface.';
const ARTIFACT_REL = 'evidence/delivery-context-pack.json';
const TEST_FILE = 'packages/main/src/tasks/delivery-context-pack-smoke.ts';
const EVIDENCE_COMMAND = 'node packages/main/dist/tasks/delivery-context-pack-smoke.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'delivery-context-pack-smoke',
      GIT_AUTHOR_EMAIL: 'delivery-context-pack-smoke@example.com',
      GIT_COMMITTER_NAME: 'delivery-context-pack-smoke',
      GIT_COMMITTER_EMAIL: 'delivery-context-pack-smoke@example.com',
    },
  }).trim();
}

function gitStatus(root: string): string {
  return git(root, ['status', '--short']);
}

function writeConfig(root: string): void {
  writeFileSync(
    join(root, 'lattice.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }, null, 2) + '\n',
    'utf8',
  );
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'delivery-context-pack-smoke',
    title: 'Implement delivery_context_pack',
    description: 'Delivery-review context producer: read-only default, ownership-gated --write, never a signer.',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    currentReviewRound: 'r1',
  };
}

function checklistWithDeliveryContext(): ChecklistData {
  return {
    items: [
      {
        id: 'CHK-001',
        title: 'Implement delivery_context_pack with a userSees expected output',
        context: 'delivery context producer',
        status: 'done',
        startTime: null,
        endTime: null,
        userSees: USER_SEES,
        files: { modify: [], create: [], test: [TEST_FILE] },
        verificationEvidence: [
          {
            intentRef: 'CHK-001:happy:0',
            kind: 'logic_test',
            result: 'pass',
            command: EVIDENCE_COMMAND,
            note: 'smoke',
          } satisfies VerificationEvidence,
        ],
      },
    ],
  };
}

/** Seed a signed-ish delivery-check.json so the V1 reader surfaces a deliveryCheckRef. */
function seedDeliveryCheck(store: StoryStore): void {
  const data: DeliveryCheckData = {
    storyId: STORY_ID,
    checkedAt: NOW,
    reviewRound: 'r1',
    agentId: 'lattice-review-delivery',
    docsPromises: [{ docPath: 'README.md', promise: PLAN_PROMISE, status: 'verified' }],
    realMachineTests: [{ featureId: 'F1', transcript: 'ran the smoke; printed pass' }],
    closingSelfCheck: {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'delivery verified',
    },
    _hash: 'seed-delivery-hash',
  };
  store.writeDeliveryCheck(STORY_ID, data);
}

function createFixture(
  seedChecklist: () => ChecklistData,
  opts: { withPlan?: boolean; withLiveSmokeTranscript?: boolean; withDeliveryCheck?: boolean; phase?: StoryInfo['phase'] } = {},
): { root: string; store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-delivctx-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# delivery context pack smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);

  // Introduce a delivery-scoped change on a story branch ahead of main so the
  // diff vs main (merge-base) is non-empty — mirrors a real story's delivery
  // contribution sitting ahead of the main baseline.
  git(root, ['checkout', '-b', `story/${STORY_ID}`]);
  writeFileSync(join(root, 'packages/main/src/feature.ts'), 'export const feature = "delivery";\n', 'utf8');
  git(root, ['add', 'packages/main/src/feature.ts']);
  git(root, ['commit', '-m', 'add feature']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, { ...baseStory(), phase: opts.phase ?? 'TEST' });
  store.writeChecklist(STORY_ID, seedChecklist());
  if (opts.withPlan !== false) {
    writeFileSync(
      store.storyFilePath(STORY_ID, 'plan.md'),
      ['# Plan', '', '## CHK-001', '', `- Promise: ${PLAN_PROMISE}`, ''].join('\n'),
      'utf8',
    );
  }
  if (opts.withLiveSmokeTranscript) {
    const evidenceDir = join(store.storyDirPath(STORY_ID), 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'live-smoke-transcript.json'), '{"expected":"pass","actual":"pass"}\n', 'utf8');
  }
  if (opts.withDeliveryCheck) seedDeliveryCheck(store);
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages/main') };
  return { root, store, ctx };
}

function snapshotDir(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  function walk(abs: string): void {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[relative(root, path)] = readFileSync(path, 'utf8');
    }
  }
  walk(dir);
  return out;
}

/**
 * PRODUCER-NOT-SIGNER assertion: delivery_context_pack must NEVER write
 * delivery-check.json (or any authority/evidence/signer artifact other than the
 * read-only pack itself).
 */
function assertNoSignerOrEvidenceArtifacts(store: StoryStore): void {
  for (const artifact of [
    'test-evidence.json',
    'review-runs.json',
    'review-passes.json',
    'findings.json',
    'summary.json',
    'done-required-evidence.json',
    'authority-receipt-refs.json',
    'verification-evidence.json',
  ]) {
    assert.equal(existsSync(store.storyFilePath(STORY_ID, artifact)), false, `${artifact} must not be written by delivery_context_pack`);
  }
}

function packArtifactPath(store: StoryStore): string {
  return store.storyFilePath(STORY_ID, ARTIFACT_REL);
}

function assertOnlyPackArtifactInEvidenceDir(store: StoryStore, expectExtra: string[] = []): void {
  const evidenceDir = join(store.storyDirPath(STORY_ID), 'evidence');
  const entries = readdirSync(evidenceDir).sort();
  const expected = ['delivery-context-pack.json', ...expectExtra].sort();
  assert.deepEqual(entries, expected, 'evidence dir contains only the pack artifact (plus any seeded fixtures) after --write');
  assert.equal(entries.some((entry) => entry.includes('.tmp-')), false, 'evidence dir contains no delivery-context-pack temp residue');
}

// ---- Policy / registration assertions -------------------------------------

assert.ok(MAIN_TOOLS.some((tool) => tool.name === 'delivery_context_pack'), 'MAIN_TOOLS exposes delivery_context_pack');
const policy = getCommandPolicy('delivery_context_pack');
assert.equal(policy?.ownershipClass, 'readOnly', 'delivery_context_pack base policy is readOnly');
assert.equal(policy?.destructiveRisk, 'none', 'delivery_context_pack policy has no static destructive risk');
assert.equal(isCommandAllowed('delivery_context_pack', 'REVIEW', DEFAULT_PHASE_TOOLS), true, 'available in REVIEW');
assert.equal(isCommandAllowed('delivery_context_pack', 'TEST', DEFAULT_PHASE_TOOLS), true, 'available in TEST');
assert.equal(isCommandAllowed('delivery_context_pack', 'DONE', DEFAULT_PHASE_TOOLS), true, 'available in DONE');

// The ownership gate escalates --write only; the read-only default stays readOnly.
assert.equal(
  resolveEffectiveOwnershipClass('delivery_context_pack', { storyId: STORY_ID }, STORY_ID),
  'readOnly',
  'read-only default remains effectively readOnly',
);
assert.equal(
  resolveEffectiveOwnershipClass('delivery_context_pack', { storyId: STORY_ID, write: true }, STORY_ID),
  'storyScopedMutating',
  '--write is effectively storyScopedMutating',
);
assert.equal(
  resolveEffectiveOwnershipClass('delivery_context_pack', { storyId: STORY_ID, write: 'true' }, STORY_ID),
  'storyScopedMutating',
  '--write string truth is still owner-gated before schema-normalized callers',
);

// ---- Fail-closed boundary (no store read on side-effect / signer flags) ----

{
  const throwingStore = new Proxy({}, {
    get(_t, prop) {
      throw new Error(`store read should not happen before delivery_context_pack rejection: ${String(prop)}`);
    },
  }) as StoryStore;
  const ctx: HandlerContext = { store: throwingStore, root: '/tmp/delivctx-no-read', scanRoot: '/tmp/delivctx-no-read/packages/main' };
  const handler = createMainRegistry(ctx).get('delivery_context_pack');
  assert.ok(handler, 'registry exposes delivery_context_pack for rejection test');
  for (const flag of ['runCommands', 'writeEvidence', 'advancePhase', 'launchReviewers', 'authorityDone', 'fullAuthorityDone', 'productionDone'] as const) {
    assert.throws(
      () => handler!({ storyId: 'B-no-read', [flag]: true, json: true }),
      /refuses unsupported side effects|no story facts were read/,
      `${flag}=true fails closed before store reads`,
    );
  }
  // --write is the sanctioned opt-in and must NOT be rejected by assertBoundary.
  try {
    handler!({ storyId: 'B-no-read', write: true, json: true });
  } catch (err) {
    assert.doesNotMatch(
      err instanceof Error ? err.message : String(err),
      /refuses unsupported side effects/,
      '--write is NOT rejected by assertBoundary (sanctioned opt-in)',
    );
  }
}

// ---- (g) storyId path-traversal id is rejected before any path use ----------

{
  const { root, store, ctx } = createFixture(checklistWithDeliveryContext, { withDeliveryCheck: true });
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for invalid storyId test');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const invalidCases = [
      { storyId: '../../outside', rogueDir: join(root, '.lattice', 'outside') },
      { storyId: 'B-bad/leaf', rogueDir: join(root, '.lattice', 'story', 'actives', 'B-bad', 'leaf') },
    ];

    for (const { storyId, rogueDir } of invalidCases) {
      mkdirSync(rogueDir, { recursive: true });
      writeFileSync(join(rogueDir, 'index.json'), JSON.stringify({ ...baseStory(), storyId }, null, 2) + '\n', 'utf8');
      assert.throws(
        () => handler!({ storyId, write: true, json: true }),
        /delivery_context_pack: invalid storyId .*path traversal/,
        `invalid storyId ${storyId} is rejected before path-derived writes`,
      );
      assert.equal(existsSync(join(rogueDir, ARTIFACT_REL)), false, `invalid storyId ${storyId} writes no outside pack`);
    }

    assert.equal(existsSync(packArtifactPath(store)), false, 'invalid storyId attempts do not write the real story artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'invalid storyId attempts leave the real story metadata unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (a)+(b) default read-only: prints the pack, consumes V1 deliveryCheckRef -

{
  const { root, store, ctx } = createFixture(checklistWithDeliveryContext, { withLiveSmokeTranscript: true, withDeliveryCheck: true });
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack');

    const storyDir = store.storyDirPath(STORY_ID);
    const beforeSnapshot = snapshotDir(root, storyDir);
    const beforeStatus = gitStatus(root);

    const report = handler!({ storyId: STORY_ID, json: true }) as DeliveryContextPackReport;
    assert.equal(report.storyId, STORY_ID);
    assert.equal(report.generatedFor, 'delivery-review');
    assert.equal(report.mode.runCommands, false, 'default runs no command');
    assert.equal(report.mode.writeEvidence, false, 'default writes nothing');
    assert.equal(report.isSigner, false, 'is a context producer, never a signer');

    // (a) the pack carries the diff + docs-promises + real-machine test refs.
    assert.ok(report.diff.changedFiles.includes('packages/main/src/feature.ts'), 'diff includes the delivery-scoped changed file');
    assert.ok(report.docsPromises.some((p) => p.source === 'plan.md' && p.promise === PLAN_PROMISE), 'docs-promises include the plan.md promise');
    assert.ok(report.docsPromises.some((p) => p.source === 'userSees' && p.promise === USER_SEES), 'docs-promises include the userSees promise');
    assert.equal(report.realMachineTests.transcriptDiff, true, 'real-machine tests detect the canonical live-smoke transcript');
    assert.ok(report.realMachineTests.testFiles.includes(TEST_FILE), 'real-machine tests include the story test file');
    assert.ok(report.realMachineTests.evidenceCommands.includes(EVIDENCE_COMMAND), 'real-machine tests include the verificationEvidence command');

    // (b) the pack embeds the delivery-check status from the V1 deliveryCheckRef.
    assert.ok(report.deliveryCheck.ref, 'delivery-check ref is consumed from the V1 readiness report');
    assert.equal((report.deliveryCheck.ref as Record<string, unknown>).source, 'delivery-check.json', 'ref is the V1 deliveryCheckRef');
    assert.notEqual(report.deliveryCheck.status, 'missing', 'with a seeded delivery-check the status is not missing');
    assert.ok(['present', 'stale', 'blocking'].includes(report.deliveryCheck.status), 'delivery-check status is a consumed V1 classification');

    assert.equal(report.claims.authorityDone, false);
    assert.equal(report.claims.fullAuthorityDone, false);
    assert.equal(report.claims.productionDone, false);

    // text render is coherent and read-only.
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /Delivery context pack \(B-delivctx\)/);
    assert.match(text, /mode: read-only context producer \(NOT a delivery signer/);
    assert.match(text, /Diff vs main/);
    assert.match(text, /Docs-promises/);
    assert.match(text, /live-smoke-transcript\.json present: true/);
    assert.match(text, /Delivery-check \(consumed from V1 readiness deliveryCheckRef\)/);
    assert.match(text, /isSigner: false/);

    // (a) no command run, no artifact written, snapshot+git unchanged.
    assert.equal(existsSync(packArtifactPath(store)), false, 'default writes no pack artifact');
    assert.deepEqual(snapshotDir(root, storyDir), beforeSnapshot, 'default must not mutate story metadata files');
    assert.equal(gitStatus(root), beforeStatus, 'default must leave git status unchanged');
    // (d) PRODUCER-NOT-SIGNER: delivery-check.json remains exactly the seeded fixture, never re-written.
    assert.deepEqual(store.readDeliveryCheck(STORY_ID)?._hash, 'seed-delivery-hash', 'delivery-check.json is read but never re-written by the pack');
    assertNoSignerOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'default must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (b') missing delivery-check → V1 row reports missing (consumed) --------

{
  const { root, store, ctx } = createFixture(checklistWithDeliveryContext, { withDeliveryCheck: false });
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for missing-delivery-check test');

    const report = handler!({ storyId: STORY_ID, json: true }) as DeliveryContextPackReport;
    assert.equal(report.deliveryCheck.ref, null, 'no delivery-check seeded → ref is null (consumed from V1)');
    assert.equal(report.deliveryCheck.status, 'missing', 'no delivery-check seeded → V1 classifies it missing');
    assert.equal(existsSync(packArtifactPath(store)), false, 'read-only missing-delivery-check writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (c)+(d) --write persists exactly one pack; no delivery-check is written -

{
  const { root, store, ctx } = createFixture(checklistWithDeliveryContext, { withLiveSmokeTranscript: true, withDeliveryCheck: true });
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for write test');

    const deliveryCheckBefore = store.readDeliveryCheck(STORY_ID);

    const report = handler!({ storyId: STORY_ID, write: true, json: true }) as DeliveryContextPackReport;
    assert.equal(report.mode.writeEvidence, true, '--write persisted the artifact');
    assert.equal(report.mode.runCommands, false, '--write runs no command');
    assert.equal(report.write.requested, true);
    assert.equal(report.write.persisted, true);
    assert.equal(report.write.artifactPath, packArtifactPath(store), 'reports the persisted artifact path');
    assert.equal(report.isSigner, false, '--write is still a producer, never a signer');

    // (c) exactly one pack artifact, no .tmp residue (plus the seeded canonical transcript fixture).
    assert.equal(existsSync(packArtifactPath(store)), true, '--write created the pack artifact');
    assertOnlyPackArtifactInEvidenceDir(store, ['live-smoke-transcript.json']);

    const persisted = JSON.parse(readFileSync(packArtifactPath(store), 'utf8'));
    assert.equal(persisted.storyId, STORY_ID, 'artifact records storyId');
    assert.equal(persisted.generatedFor, 'delivery-review', 'artifact records generatedFor');
    assert.equal(persisted.isSigner, false, 'artifact records isSigner=false');
    assert.ok(Array.isArray(persisted.diff.changedFiles) && persisted.diff.changedFiles.includes('packages/main/src/feature.ts'), 'artifact embeds the diff');
    assert.ok(persisted.docsPromises.some((p: { promise: string }) => p.promise === PLAN_PROMISE), 'artifact embeds the docs-promises');
    assert.equal(persisted.realMachineTests.transcriptDiff, true, 'artifact embeds the real-machine test refs');
    assert.ok(persisted.deliveryCheck.ref, 'artifact embeds the consumed V1 deliveryCheckRef');
    assert.equal(persisted.claims.authorityDone, false, 'artifact claims authorityDone=false');
    assert.equal(persisted.claims.fullAuthorityDone, false, 'artifact claims fullAuthorityDone=false');
    assert.equal(persisted.claims.productionDone, false, 'artifact claims productionDone=false');

    // (d) PRODUCER-NOT-SIGNER: delivery-check.json must be byte-identical (never re-written / signed).
    assert.deepEqual(store.readDeliveryCheck(STORY_ID), deliveryCheckBefore, '--write never re-writes / signs delivery-check.json');
    assertNoSignerOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', '--write must not advance phase');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (d) PRODUCER-NOT-SIGNER by spy: writeDeliveryCheck is never invoked -----

{
  const { root, store } = createFixture(checklistWithDeliveryContext, { withDeliveryCheck: true });
  try {
    let called = false;
    const spied = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'writeDeliveryCheck') {
          return () => {
            called = true;
            throw new Error('delivery_context_pack must NEVER call writeDeliveryCheck');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as StoryStore;
    const ctx: HandlerContext = { store: spied, root, scanRoot: join(root, 'packages/main') };
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for signer-spy test');

    // Both read-only and --write must leave writeDeliveryCheck untouched.
    handler!({ storyId: STORY_ID, json: true });
    handler!({ storyId: STORY_ID, write: true, json: true });
    assert.equal(called, false, 'the delivery-check setter (writeDeliveryCheck) is never invoked by the producer');
    assert.equal(existsSync(store.storyFilePath(STORY_ID, 'delivery-check.json')) && store.readDeliveryCheck(STORY_ID)?._hash === 'seed-delivery-hash', true, 'delivery-check.json is the seeded fixture, unmodified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (e) no waiver-acceptance / phase-advance / reviewer-launch side effects -

{
  const { root, store, ctx } = createFixture(checklistWithDeliveryContext, { withDeliveryCheck: true });
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for side-effect test');

    const report = handler!({ storyId: STORY_ID, write: true, json: true }) as DeliveryContextPackReport;
    // Waiver is SURFACED only, never accepted/rejected.
    assert.ok(report.waiver.status === 'none' || report.waiver.status === 'surfaced', 'waiver is surfaced-only (never accepted)');
    assertNoSignerOrEvidenceArtifacts(store);
    assert.equal(store.readStory(STORY_ID).phase, 'TEST', 'no phase advance');
    assert.equal(store.readStory(STORY_ID).currentReviewRound, 'r1', 'review round is read, not mutated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- (f) --write through a FAILING owner/scope gate leaves state unchanged ---

{
  const { root, store } = createFixture(checklistWithDeliveryContext, { withDeliveryCheck: true });
  const savedSession = process.env.LATTICE_SESSION_ID;
  try {
    const storyDir = store.storyDirPath(STORY_ID);
    process.env.LATTICE_SESSION_ID = 'sess-owner';
    resetSessionIdForTest();
    acquireOwnerLease(storyDir, { command: 'checklist_add', cwd: '/tmp/owner-worktree' });
    const leaseBefore = readFileSync(ownerLeasePath(storyDir), 'utf8');
    const snapshotBefore = snapshotDir(root, storyDir);
    const statusBefore = gitStatus(root);

    process.env.LATTICE_SESSION_ID = 'sess-intruder';
    resetSessionIdForTest();

    // Default read-only is ungated even on a foreign-owned story.
    assert.doesNotThrow(
      () => enforceStoryOwnerLeaseGate('delivery_context_pack', { storyId: STORY_ID }, store, null, root),
      'read-only default is not owner-gated on a foreign-owned story',
    );
    // --write is owner-gated and must throw before any write.
    assert.throws(
      () => enforceStoryOwnerLeaseGate('delivery_context_pack', { storyId: STORY_ID, write: true }, store, null, root),
      /owner|owned by another/i,
      '--write is owner-gated on a foreign-owned story',
    );

    assert.equal(readFileSync(ownerLeasePath(storyDir), 'utf8'), leaseBefore, 'rejected --write leaves the foreign owner lease untouched');
    assert.equal(existsSync(packArtifactPath(store)), false, 'rejected owner gate leaves no pack artifact (no partial write)');
    assert.deepEqual(snapshotDir(root, storyDir), snapshotBefore, 'rejected owner gate leaves story metadata unchanged');
    assert.equal(gitStatus(root), statusBefore, 'rejected owner gate leaves git status unchanged');
    assertNoSignerOrEvidenceArtifacts(store);
  } finally {
    if (savedSession === undefined) delete process.env.LATTICE_SESSION_ID;
    else process.env.LATTICE_SESSION_ID = savedSession;
    resetSessionIdForTest();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- degenerate input: no plan / no userSees / no delivery-check → no crash --

{
  const { root, store, ctx } = createFixture(
    () => ({
      items: [
        { id: 'CHK-001', title: 'no userSees, no test files', context: 'degenerate', status: 'done', startTime: null, endTime: null },
      ],
    }),
    { withPlan: false, withDeliveryCheck: false },
  );
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for degenerate test');

    const report = handler!({ storyId: STORY_ID, json: true }) as DeliveryContextPackReport;
    assert.deepEqual(report.docsPromises, [], 'no plan/userSees → no docs-promises (no crash)');
    assert.equal(report.realMachineTests.transcriptDiff, false, 'no live-smoke transcript → false (no crash)');
    assert.deepEqual(report.realMachineTests.testFiles, [], 'no test files declared (no crash)');
    assert.equal(report.deliveryCheck.status, 'missing', 'no delivery-check → missing (consumed from V1)');
    const text = handler!({ storyId: STORY_ID, format: 'text' }) as string;
    assert.match(text, /\(none authored in plan\.md or checklist userSees\)/, 'renders the no-docs-promises case');
    assertNoSignerOrEvidenceArtifacts(store);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- nonexistent story errors clearly and writes nothing -------------------

{
  const { root, store, ctx } = createFixture(checklistWithDeliveryContext, { withDeliveryCheck: true });
  try {
    const handler = createMainRegistry(ctx).get('delivery_context_pack');
    assert.ok(handler, 'registry exposes delivery_context_pack for nonexistent-story test');

    const MISSING_ID = 'B-nonexistent';
    assert.equal(store.storyExists(MISSING_ID), false, 'precondition: the missing story id does not exist');
    const statusBefore = gitStatus(root);

    for (const extra of [{}, { write: true }] as const) {
      assert.throws(
        () => handler!({ storyId: MISSING_ID, ...extra, json: true }),
        /delivery_context_pack: story B-nonexistent not found/,
        `nonexistent story (${JSON.stringify(extra)}) throws a clear not-found error`,
      );
    }
    assert.equal(existsSync(store.storyDirPath(MISSING_ID)), false, 'no story directory was created for the missing id');
    assert.equal(gitStatus(root), statusBefore, 'nonexistent-story rejection leaves git status unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('delivery_context_pack smoke passed\n');
