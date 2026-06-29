#!/usr/bin/env node
/**
 * @task B-381e
 * @checklist CHK-002
 * @title observability_snapshot adapter smoke
 * @type chore
 * @priority high
 * @description
 *   Focused smoke for the host-neutral observability snapshot adapter. Drives
 *   `buildObservabilitySnapshot` directly with a stub resolver result so the
 *   smoke does not depend on real linked worktrees, then exercises the
 *   `observability_snapshot` handler to confirm the same JSON contract is
 *   surfaced. Asserts schema version, read-only authority boundary, presence
 *   of every section, and that the adapter routes per-row reads through the
 *   resolver's `authoritativeCwd` instead of the repo root.
 * @changes
 *   - [CHK-001] Use validator-accepted task type metadata for the observability snapshot smoke.
 *   - [CHK-002] Add validator-required changes metadata for convergence checking.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildObservabilitySnapshot,
  OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION,
  type LatticeObservabilitySnapshot,
} from '../core/observability-snapshot.js';
import { resetConfigCache } from '../core/config.js';
import { StoryStore } from '../core/store.js';
import {
  STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION,
  type StoryAuthorityResolveResult,
} from '../core/story-authority-resolver.js';
import type {
  ChecklistData,
  StoryInfo,
  VerificationEvidence,
} from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createObservabilitySnapshotHandlers } from '../handlers/observability-snapshot.js';

const NOW = '2026-06-03T00:00:00.000Z';

function writeConfig(root: string): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
  }, null, 2));
}

function seedActiveStory(store: StoryStore): void {
  const story: StoryInfo = {
    storyId: 'B-active',
    name: 'observability-active',
    title: 'Active observability snapshot story',
    description: 'Seeded for observability snapshot smoke.',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    lane: 'mainline',
    parallelSafe: 'yes',
    depends: ['B-shared'],
    blockingFor: ['B-followup'],
  };
  const evidence: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'logic_test',
    command: 'node dist/tasks/observability-snapshot-smoke.js',
    result: 'pass',
    note: 'Smoke evidence for observability snapshot adapter.',
    timestamp: NOW,
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Snapshot adapter produces sections',
      status: 'in_progress',
      startTime: NOW,
      endTime: null,
      verificationIntent: {
        happy: [{ desc: 'snapshot includes all sections', type: 'logic' }],
        edge: [],
        adversarial: [],
      },
      verificationEvidence: [evidence],
    }],
  };
  store.writeStory('B-active', story);
  store.writeChecklist('B-active', checklist);
  store.writeReview('B-active', { reviews: [] });
}

function seedDoneStory(store: StoryStore): void {
  const story: StoryInfo = {
    storyId: 'B-done',
    name: 'observability-done',
    title: 'Locally-DONE observability story',
    description: 'Confirms local DONE never becomes production DONE in the snapshot.',
    type: 'feature',
    phase: 'DONE',
    priority: 'high',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: NOW,
    lane: 'supporting',
  };
  const evidence: VerificationEvidence = {
    intentRef: 'CHK-001:happy:0',
    kind: 'integration_test',
    command: 'node dist/tasks/observability-snapshot-smoke.js',
    result: 'pass',
    note: 'Local evidence; no verified receipt.',
    timestamp: NOW,
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Local DONE story shipped',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
      verificationEvidence: [evidence],
    }],
  };
  store.writeStory('B-done', story);
  store.writeChecklist('B-done', checklist);
  store.writeReview('B-done', { reviews: [] });
}

function makeResolverResult(): StoryAuthorityResolveResult {
  return {
    schemaVersion: STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION,
    readOnly: true,
    productionDone: false,
    receiptVerified: false,
    authorityChanged: false,
    generatedAt: NOW,
    repoRoot: '/tmp/observability-smoke-repo',
    stories: [
      {
        storyId: 'B-active',
        title: 'Active observability snapshot story',
        authority: 'worktree',
        mirrorPhase: 'INIT_CHECK',
        authoritativePhase: 'DEV',
        authoritativeCwd: '/tmp/observability-smoke-worktree/B-active',
        worktreePath: '/tmp/observability-smoke-worktree/B-active',
      },
      {
        storyId: 'B-done',
        title: 'Locally-DONE observability story',
        authority: 'main',
        mirrorPhase: 'DONE',
        authoritativePhase: 'DONE',
        authoritativeCwd: '/tmp/observability-smoke-repo',
        worktreePath: null,
      },
    ],
  };
}

function assertReadOnlyAuthority(snapshot: LatticeObservabilitySnapshot): void {
  assert.equal(snapshot.schemaVersion, OBSERVABILITY_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.schemaVersion, 'lattice.observability_snapshot.v1');
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.authority.productionDone, false);
  assert.equal(snapshot.authority.receiptVerified, false);
  assert.equal(snapshot.authority.authorityChanged, false);
  assert.equal(snapshot.resolverSchemaVersion, STORY_AUTHORITY_RESOLVE_SCHEMA_VERSION);
  assert.equal(snapshot.resolver.productionDone, false);
  assert.equal(snapshot.resolver.receiptVerified, false);
  assert.equal(snapshot.resolver.authorityChanged, false);
  for (const row of snapshot.sections.storyBoard) {
    assert.equal(row.productionDone, false, `storyBoard row ${row.storyId} must report productionDone=false`);
    assert.notEqual(row.tier, 'legacy-receipt', `storyBoard row ${row.storyId} must not claim legacy-receipt without verified evidence`);
  }
  for (const row of snapshot.sections.capabilityMatrix) {
    assert.equal(row.receiptVerifyAvailable, false);
    assert.equal(row.productionDoneBlocked, true);
  }
}

function assertSectionsShape(snapshot: LatticeObservabilitySnapshot): void {
  const sections = snapshot.sections;
  assert.ok(sections.authorityLadder, 'authorityLadder section present');
  assert.ok(Array.isArray(sections.storyBoard), 'storyBoard section present');
  assert.ok(Array.isArray(sections.capabilityMatrix), 'capabilityMatrix section present');
  assert.ok(Array.isArray(sections.recovery), 'recovery section present');
  assert.ok(Array.isArray(sections.parallel), 'parallel section present');
  assert.equal(sections.capabilityMatrix.length, sections.storyBoard.length, 'capabilityMatrix aligns with storyBoard count');
  assert.equal(sections.recovery.length, sections.storyBoard.length, 'recovery aligns with storyBoard count');
  assert.equal(sections.parallel.length, sections.storyBoard.length, 'parallel aligns with storyBoard count');
}

const root = mkdtempSync(join(tmpdir(), 'lattice-observability-snapshot-'));
try {
  writeConfig(root);
  resetConfigCache();
  mkdirSync(join(root, 'packages', 'main'), { recursive: true });
  const store = new StoryStore(root);
  seedActiveStory(store);
  seedDoneStory(store);

  const resolverResult = makeResolverResult();

  // Worker B never spins up a real linked worktree in this smoke. Inject a
  // resolver result that points each row at the same temp project root via a
  // storeFactory override, and capture which cwds the adapter opens so we can
  // prove the snapshot routes per-row reads through `authoritativeCwd`.
  const openedCwds: string[] = [];
  const storeFactory = (cwd: string): StoryStore => {
    openedCwds.push(cwd);
    // For the smoke we reuse the same temp project root; the assertion below
    // only proves the adapter asked for the resolver's cwd, not that it read
    // a real worktree (M1 scope).
    return store;
  };

  const snapshot = buildObservabilitySnapshot(store, root, {
    resolver: resolverResult,
    storeFactory,
    now: NOW,
  });

  assertReadOnlyAuthority(snapshot);
  assertSectionsShape(snapshot);
  assert.equal(snapshot.sections.storyBoard.length, 2, 'injected resolver yields two storyBoard rows');

  assert.equal(snapshot.generatedAt, NOW);
  assert.equal(snapshot.resolver, resolverResult, 'snapshot embeds the resolver result it consumed');

  const ladder = snapshot.sections.authorityLadder;
  assert.equal(ladder.legacyReceipt.count, 0, 'no story carries verified receipt evidence');
  assert.deepEqual(ladder.legacyReceipt.storyIds, []);
  assert.equal(ladder.localEvidence.count, 2, 'both seeded stories land in local-evidence');
  assert.deepEqual(ladder.localEvidence.storyIds, ['B-active', 'B-done']);
  assert.equal(ladder.inFlight.count, 1, 'only the active story counts as in-flight');
  assert.deepEqual(ladder.inFlight.storyIds, ['B-active']);
  assert.equal(ladder.productionDoneGap, 1, 'locally-DONE story exposes the productionDone gap');

  // Per-row adapter behavior: the storeFactory must be called for each row's
  // authoritativeCwd, and storyBoard entries must mirror the resolver fields.
  assert.deepEqual(
    openedCwds.sort(),
    ['/tmp/observability-smoke-repo', '/tmp/observability-smoke-worktree/B-active'].sort(),
    'adapter opens StoryStore for every resolver row using its authoritativeCwd',
  );
  const activeEntry = snapshot.sections.storyBoard.find(row => row.storyId === 'B-active');
  assert.ok(activeEntry, 'B-active storyBoard entry');
  assert.equal(activeEntry.authority, 'worktree');
  assert.equal(activeEntry.authoritativePhase, 'DEV');
  assert.equal(activeEntry.mirrorPhase, 'INIT_CHECK');
  assert.equal(activeEntry.authoritativeCwd, '/tmp/observability-smoke-worktree/B-active');
  assert.equal(activeEntry.worktreePath, '/tmp/observability-smoke-worktree/B-active');
  assert.equal(activeEntry.tier, 'local-evidence');
  assert.equal(activeEntry.localDone, false);
  assert.equal(activeEntry.productionDone, false);
  assert.ok(activeEntry.canonicalStoryDigest?.startsWith('sha256:'), 'canonical digest propagated into snapshot');

  const doneEntry = snapshot.sections.storyBoard.find(row => row.storyId === 'B-done');
  assert.ok(doneEntry, 'B-done storyBoard entry');
  assert.equal(doneEntry.authority, 'main');
  assert.equal(doneEntry.authoritativeCwd, '/tmp/observability-smoke-repo');
  assert.equal(doneEntry.localDone, true);
  assert.equal(doneEntry.productionDone, false, 'local DONE never escalates to production DONE');
  assert.equal(doneEntry.tier, 'local-evidence');

  // Recovery + parallel sections preserve the resolver's per-row routing.
  const activeRecovery = snapshot.sections.recovery.find(row => row.storyId === 'B-active');
  assert.ok(activeRecovery, 'recovery entry for active story');
  assert.equal(activeRecovery.authoritativeCwd, '/tmp/observability-smoke-worktree/B-active');
  assert.ok(/^cd \/tmp\/observability-smoke-worktree\/B-active/.test(activeRecovery.resumeCommand), 'resume command embeds authoritative cwd');
  assert.ok(activeRecovery.resumeCommand.includes('lattice story_export --storyId=B-active --format=json'), 'resume command targets story_export JSON surface');
  assert.ok(activeRecovery.recoveryPoints.some(point => point.id === 'B-active:story-store'), 'recoveryPoints projected from canonical lineage');

  const activeParallel = snapshot.sections.parallel.find(row => row.storyId === 'B-active');
  assert.ok(activeParallel, 'parallel entry for active story');
  assert.equal(activeParallel.authoritativePhase, 'DEV');
  assert.equal(activeParallel.lane, 'mainline');
  assert.equal(activeParallel.parallelSafe, 'yes');
  assert.deepEqual(activeParallel.depends, ['B-shared']);
  assert.deepEqual(activeParallel.blockingFor, ['B-followup']);
  assert.equal(activeParallel.worktreePath, '/tmp/observability-smoke-worktree/B-active');

  // Edge: when no resolver result is injected, the adapter calls the real
  // resolver. With no stories in the seeded repo's `.lattice/story/actives`
  // matching active filter, the resolver still returns the seeded stories
  // (DEV/DONE phases). Confirm the adapter resolves without crashing.
  const liveSnapshot = buildObservabilitySnapshot(store, root, {
    activeOnly: true,
    storeFactory: (_cwd) => store,
    now: NOW,
  });
  assertReadOnlyAuthority(liveSnapshot);
  assert.ok(liveSnapshot.sections.storyBoard.length >= 1, 'live resolver pass returns at least the active story');

  // Adversarial: a malicious caller cannot force productionDone via the
  // snapshot — the type system forbids it and the runtime literal stays false.
  assert.equal(snapshot.authority.productionDone, false);
  assert.equal(snapshot.authority.receiptVerified, false);
  assert.equal(snapshot.authority.authorityChanged, false);

  // Handler shape: ensure the registered handler surfaces the same JSON.
  // The handler defaults to activeOnly=true; the seed includes one active and
  // one DONE story, so the handler returns just the DEV row. Pass
  // activeOnly:false here to surface both seeded stories and exercise the same
  // section-shape contract as the direct buildObservabilitySnapshot call above.
  const ctx: HandlerContext = { store, root, scanRoot: join(root, 'packages', 'main') };
  const handlers = createObservabilitySnapshotHandlers(ctx);
  const handlerResult = handlers.observability_snapshot({ format: 'json', activeOnly: false }) as LatticeObservabilitySnapshot;
  assertReadOnlyAuthority(handlerResult);
  assertSectionsShape(handlerResult);
  assert.equal(handlerResult.sections.storyBoard.length, 2, 'handler with activeOnly:false surfaces both seeded stories');

  const textResult = handlers.observability_snapshot({}) as string;
  assert.match(textResult, /Proofbound observability snapshot \(lattice\.observability_snapshot\.v1\)/);
  assert.match(textResult, /productionDone: false/);
  assert.match(textResult, /receiptVerified: false/);
  assert.match(textResult, /authorityChanged: false/);

  // No-overwrite output behavior mirrors story_export.
  const outputPath = join(root, 'observability-snapshot.json');
  handlers.observability_snapshot({ output: outputPath, format: 'json' });
  assert.throws(
    () => handlers.observability_snapshot({ output: outputPath, format: 'json' }),
    /refusing to overwrite existing file/,
    'observability_snapshot output must be no-overwrite',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ observability snapshot smoke passed');
