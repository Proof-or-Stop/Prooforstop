#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalDigest } from '../core/authority-signing.js';
import { resetConfigCache } from '../core/config.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';
import { StoryStore } from '../core/store.js';
import { listVerdicts, summarizeVerdicts } from '../core/verdicts.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-quorum-smoke';
const REVIEW_ROUND = '2026-06-22T10:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=quorum-smoke@example.test', '-c', 'user.name=Quorum Submit Smoke'];
const REVIEW_LANES = [
  'lattice-review-concept',
  'lattice-review-quality',
  'lattice-review-test-coverage',
] as const;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    proofAdmissibility: {
      mode: 'enforce',
      enforcedConsumers: ['REVIEW'],
    },
  }, null, 2) + '\n');
  resetConfigCache();
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'quorum-submit-smoke',
    title: 'quorum_submit smoke',
    description: 'Synthetic REVIEW story for quorum_submit smoke coverage.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    currentReviewRound: REVIEW_ROUND,
    riskSignals: [],
    createdAt: '2026-06-22T09:00:00.000Z',
    startedAt: '2026-06-22T09:10:00.000Z',
    endedAt: null,
    events: [
      { phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND },
    ],
  } as StoryInfo;
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'submit local quorum',
      context: 'Smoke fixture item already implemented.',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
}

function makeFixture(): { root: string; store: StoryStore; ctx: HandlerContext; registry: ReturnType<typeof createMainRegistry> } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-quorum-submit-'));
  writeConfig(root);
  write(root, 'README.md', 'quorum submit smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'seed']);
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const changed = 1;\n');
  git(root, ['add', 'packages/main/src/index.ts']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story code change']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, story());
  store.writeChecklist(STORY_ID, checklist());
  store.writeTestEvidence(STORY_ID, {
    result: 'PASS',
    command: 'quorum-submit-smoke-validation',
    output: 'synthetic validation passed',
    timestamp: '2026-06-22T09:30:00.000Z',
  });
  git(root, ['add', '.lattice/story', 'lattice.config.json']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story review metadata']);

  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  return { root, store, ctx, registry };
}

function hostVerdictEventCount(store: StoryStore): number {
  return store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict').length;
}

function verdictFileCount(root: string): number {
  return listVerdicts(root, 'local', STORY_ID).length;
}

function assertQuorumRefuses(registry: ReturnType<typeof createMainRegistry>, store: StoryStore, root: string, label: string): void {
  const beforeEvents = hostVerdictEventCount(store);
  const beforeVerdicts = verdictFileCount(root);
  const handler = registry.get('quorum_submit');
  assert.ok(handler, 'quorum_submit handler is registered');
  assert.throws(
    () => handler({
      storyId: STORY_ID,
      hostA: 'host-a',
      hostB: 'host-b',
      format: 'json',
    }),
    /quorum_submit refuses: no current reviewer pass evidence for the required lanes/,
    label,
  );
  assert.equal(hostVerdictEventCount(store), beforeEvents, `${label}: no host_verdict process events written`);
  assert.equal(verdictFileCount(root), beforeVerdicts, `${label}: no verdict files written`);
}

function startRunAndPass(registry: ReturnType<typeof createMainRegistry>, lane: string): void {
  const start = registry.get('review_run_start');
  const pass = registry.get('review_pass_set');
  assert.ok(start, 'review_run_start handler is registered');
  assert.ok(pass, 'review_pass_set handler is registered');
  const output = String(start({
    storyId: STORY_ID,
    agent: lane,
    promptHash: canonicalDigest({ lane, kind: 'quorum-submit-smoke-review-prompt' }),
  }));
  const match = output.match(/Review run (\S+) started/);
  assert.ok(match?.[1], `review_run_start output contains reviewRunId for ${lane}`);
  pass({
    storyId: STORY_ID,
    agent: lane,
    reviewRunId: match[1],
    note: `No blocking issue found by ${lane} for quorum_submit smoke.`,
  });
}

function recordReviewerPasses(registry: ReturnType<typeof createMainRegistry>): void {
  for (const lane of REVIEW_LANES) startRunAndPass(registry, lane);
}

let materialChangeCounter = 1;
function commitMaterialChange(root: string): void {
  // Each call must produce a DISTINCT materialDigest (a new commit with new content), so the
  // counter guarantees the file content actually changes even across repeated calls.
  materialChangeCounter += 1;
  write(root, 'packages/main/src/index.ts', `export const seed = true;\nexport const changed = ${materialChangeCounter};\n`);
  // Stage the whole tree so any verdict/process-event files written by a prior quorum are
  // committed too, leaving a clean working tree for the next review_run_start preflight.
  git(root, ['add', '-A']);
  git(root, [...COMMIT_ENV, 'commit', '-m', `material change ${materialChangeCounter}`]);
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const previousCwd = process.cwd();
const { root, store, registry } = makeFixture();

try {
  process.chdir(root);

  check('refuses when required reviewer passes are absent and writes no verdicts', () => {
    assertQuorumRefuses(registry, store, root, 'absent reviewer pass refusal');
  });

  check('refuses when reviewer passes are stale and writes no verdicts', () => {
    recordReviewerPasses(registry);
    commitMaterialChange(root);
    assertQuorumRefuses(registry, store, root, 'stale reviewer pass refusal');
  });

  let result: any;
  check('emits exactly rounds x 2 verdicts after current reviewer passes', () => {
    recordReviewerPasses(registry);
    const handler = registry.get('quorum_submit');
    assert.ok(handler, 'quorum_submit handler is registered');
    result = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke local voluntary quorum',
      format: 'json',
    });
    assert.equal(result.schemaVersion, 'lattice.quorum_submit.v1');
    assert.equal(result.emittedCount, 6);
    assert.equal(result.verdictIds.length, 6);
    assert.deepEqual(result.runIds, [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`, `${STORY_ID}-q-r3`]);
    assert.equal(listVerdicts(root, 'local', STORY_ID).length, 6);
  });

  check('review_escalation_status and review assurance floor report complete voluntary 3x2 rounds', () => {
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.validRoundCount, 3);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.requiredRounds, 3);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.requiredPassingHostsPerRound, 2);
    assert.equal(result.reviewEscalationStatus.voluntaryLocalRounds.complete, true);

    const materialHash = currentMaterialHash(root);
    assert.ok(materialHash, 'current material hash exists');
    store.appendProcessEvent(STORY_ID, {
      type: 'review_escalation_policy',
      storyId: STORY_ID,
      command: 'quorum-submit-smoke',
      timestamp: '2026-06-22T10:10:00.000Z',
      policyId: `${STORY_ID}:POL-quorum-smoke`,
      predicate: 'explicitlyConfiguredHighRiskPolicyRequires3x2',
      requires3x2: true,
      policyVersion: 'quorum-submit-smoke.v1',
      riskClass: 'process-fact',
      sourcePolicyRef: 'packages/main/src/tasks/quorum-submit-smoke.ts',
      rolloutStage: 'enforced',
      degradedFallbackAllowed: true,
      issuer: 'quorum-submit-smoke',
      issuedAt: '2026-06-22T10:10:00.000Z',
      headHash: git(root, ['rev-parse', 'HEAD']),
      materialHash,
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
    });
    const status = registry.get('review_escalation_status');
    assert.ok(status, 'review_escalation_status handler is registered');
    const escalation = status({ storyId: STORY_ID, json: true }) as any;
    assert.equal(escalation.required, true);
    assert.equal(escalation.ok, true);
    assert.equal(escalation.assuranceLevel, 'full-3x2');
    assert.equal(escalation.proofAdmissibility.allowed, true);
    assert.equal(escalation.proofAdmissibility.overall, 'pass');

    const assurance = evaluateReviewAssuranceFloor({
      projectRoot: root,
      storyId: STORY_ID,
      store,
      changedFiles: ['packages/main/src/core/process-fact-registry.ts'],
      materialHash,
    });
    assert.equal(assurance.localRounds.validRounds.length, 3);
    assert.equal(assurance.localRounds.requiredRounds, 3);
    assert.equal(assurance.localRounds.requiredPassingHostsPerRound, 2);
    assert.equal(assurance.localRounds.ok, true);
  });

  check('auto-computed materialDigest and storyFilesHash match current helpers', () => {
    assert.equal(result.materialDigest, currentMaterialHash(root));
    assert.equal(result.storyFilesHash, currentStoryFilesHash(root, 'HEAD', root));
    assert.match(result.validationDigest, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostA, /^[0-9a-f]{64}$/);
    assert.match(result.promptDigests.hostB, /^[0-9a-f]{64}$/);
  });

  check('hosts are independent by hostId, sessionId, and keyId', () => {
    const { hostA, hostB } = result.hosts;
    assert.notEqual(hostA.hostId.toLowerCase(), hostB.hostId.toLowerCase());
    assert.notEqual(hostA.sessionId.toLowerCase(), hostB.sessionId.toLowerCase());
    assert.notEqual(hostA.keyId.toLowerCase(), hostB.keyId.toLowerCase());
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
      assert.equal(summary.duplicateVerdicts, 0);
    }
  });

  check('never sets authorityDone, fullAuthorityDone, or productionDone', () => {
    assert.equal(result.authorityDone, false);
    assert.equal(result.fullAuthorityDone, false);
    assert.equal(result.productionDone, false);
    assert.equal(result.reviewEscalationStatus.authorityDone, false);
    assert.equal(result.reviewEscalationStatus.fullAuthorityDone, false);
    assert.equal(result.reviewEscalationStatus.productionDone, false);
    for (const runId of result.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.authorityDone, false);
      assert.equal(summary.fullAuthorityDone, false);
      assert.equal(summary.multiHostVerified, false);
    }
  });

  check('refuses a same-material re-submit and writes no new verdicts', () => {
    // No material change since the rounds=3 quorum above, so runIds r1..r3 already carry
    // verdicts at the current materialDigest. A second quorum_submit must refuse instead of
    // silently piling duplicate verdicts onto the same runIds.
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    assert.throws(
      () => handler({
        storyId: STORY_ID,
        hostA: 'claude-host',
        hostB: 'codex-host',
        rounds: 3,
        providerA: 'claude',
        providerB: 'codex',
        note: 'quorum_submit smoke same-material re-submit',
        format: 'json',
      }),
      /quorum_submit refuses: verdicts already exist for runId/,
      'same-material re-submit is refused',
    );
    assert.equal(hostVerdictEventCount(store), beforeEvents, 'same-material refusal writes no host_verdict events');
    assert.equal(verdictFileCount(root), beforeVerdicts, 'same-material refusal writes no verdict files');
  });

  check('allows a fresh quorum after a material change', () => {
    // A real material change (new commit) yields a different materialDigest, so the guard
    // does not collide and a fresh quorum is allowed for the same runIds.
    commitMaterialChange(root);
    recordReviewerPasses(registry);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    const freshResult: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: 3,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke fresh-material re-quorum',
      format: 'json',
    });
    assert.equal(freshResult.emittedCount, 6, 'fresh-material re-quorum emits rounds x 2 verdicts');
    assert.equal(verdictFileCount(root) - beforeVerdicts, 6, 'fresh-material re-quorum writes new verdict files');
    for (const runId of freshResult.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2, {
        currentAnchor: { materialDigest: freshResult.materialDigest },
      });
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
    }
  });

  check('--rounds=N (N != 3) emits exactly N x 2 verdicts with N runIds', () => {
    // INIT product-reviewer advisory: prove the rounds knob is honored for N != 3.
    // Advance the material first so the rounds=2 quorum runs at a fresh materialDigest and
    // does not collide with the r1/r2 verdicts already written at earlier materials.
    commitMaterialChange(root);
    recordReviewerPasses(registry);
    const customRounds = 2;
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    const customResult: any = handler({
      storyId: STORY_ID,
      hostA: 'claude-host',
      hostB: 'codex-host',
      rounds: customRounds,
      providerA: 'claude',
      providerB: 'codex',
      note: 'quorum_submit smoke custom-rounds quorum',
      format: 'json',
    });
    assert.equal(customResult.rounds, customRounds, '--rounds=N is reflected in result.rounds');
    assert.equal(customResult.emittedCount, customRounds * 2, '--rounds=N emits N x 2 verdicts');
    assert.equal(customResult.verdictIds.length, customRounds * 2);
    assert.deepEqual(customResult.runIds, [`${STORY_ID}-q-r1`, `${STORY_ID}-q-r2`]);
    // exactly N x 2 new host_verdict events and verdict files were added by this call.
    assert.equal(hostVerdictEventCount(store) - beforeEvents, customRounds * 2, '--rounds=N writes N x 2 host_verdict events');
    assert.equal(verdictFileCount(root) - beforeVerdicts, customRounds * 2, '--rounds=N writes N x 2 verdict files');
    for (const runId of customResult.runIds) {
      const summary = summarizeVerdicts(root, 'local', STORY_ID, runId, 2);
      assert.equal(summary.status, 'pass');
      assert.equal(summary.passingIndependentHosts, 2);
    }
    assert.equal(customResult.authorityDone, false);
    assert.equal(customResult.fullAuthorityDone, false);
    assert.equal(customResult.productionDone, false);
  });

  check('rejects non-independent host identity before writing additional verdicts', () => {
    const beforeEvents = hostVerdictEventCount(store);
    const beforeVerdicts = verdictFileCount(root);
    const handler = registry.get('quorum_submit')!;
    assert.throws(
      () => handler({
        storyId: STORY_ID,
        hostA: 'same-host',
        hostB: 'different-host',
        sessionA: 'shared-session',
        sessionB: 'shared-session',
        format: 'json',
      }),
      /hostA and hostB must be independent/,
    );
    assert.equal(hostVerdictEventCount(store), beforeEvents);
    assert.equal(verdictFileCount(root), beforeVerdicts);
  });

  console.log(`\n✓ quorum_submit smoke passed (${passed} checks)`);
} finally {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}
