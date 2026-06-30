#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import {
  canFinishGuard,
  getGuardFailureReason,
  type StoryMachineContext,
} from '../core/machine.js';
import {
  REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS,
  REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND,
  REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS,
  evaluateReviewAssuranceFloor,
  formatReviewAssuranceFloorFailure,
  type ReviewAssuranceFloorReport,
} from '../core/review-assurance-floor.js';
import type { BugData, Finding, ProcessEvent, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-review-assurance-floor';
const REVIEW_ROUND = '2026-06-19T10:00:00.000Z';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-assurance-floor-'));
  write(root, 'README.md', 'review assurance floor smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\n');
  write(root, 'docs/requirements/decisions/floor.md', '# Floor\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  git(root, ['config', 'user.name', 'Review Assurance Floor Smoke']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['checkout', '-B', 'story/B-review-assurance-floor']);
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const changed = true;\n');
  git(root, ['add', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'material code change']);
  return root;
}

function makeWrapperRepo(): { metadataRoot: string; gitRoot: string } {
  const metadataRoot = mkdtempSync(join(tmpdir(), 'review-assurance-floor-wrapper-'));
  const gitRoot = join(metadataRoot, 'repo');
  mkdirSync(gitRoot, { recursive: true });
  write(metadataRoot, 'lattice.config.json', JSON.stringify({ gitRoot: 'repo' }, null, 2));
  write(gitRoot, 'README.md', 'wrapper review assurance floor smoke\n');
  write(gitRoot, 'packages/main/src/index.ts', 'export const seed = true;\n');
  git(gitRoot, ['init']);
  git(gitRoot, ['config', 'user.email', 'smoke@example.invalid']);
  git(gitRoot, ['config', 'user.name', 'Review Assurance Floor Smoke']);
  git(gitRoot, ['checkout', '-B', 'main']);
  git(gitRoot, ['add', '.']);
  git(gitRoot, ['commit', '-m', 'seed']);
  git(gitRoot, ['checkout', '-B', 'story/B-review-assurance-floor']);
  write(gitRoot, 'packages/main/src/index.ts', 'export const seed = true;\nexport const changed = true;\n');
  git(gitRoot, ['add', 'packages/main/src/index.ts']);
  git(gitRoot, ['commit', '-m', 'material code change']);
  return { metadataRoot, gitRoot };
}

function story(overrides: Partial<StoryInfo> = {}): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Review assurance floor smoke',
    description: 'Smoke test review assurance floor evaluator',
    type: 'feature',
    phase: 'TEST',
    priority: 'medium',
    createdAt: '2026-06-19T09:00:00.000Z',
    startedAt: null,
    endedAt: null,
    events: [{ phase: 'DEV', action: 'advance', timestamp: '2026-06-19T09:30:00.000Z' }],
    ...overrides,
  };
}

function bugData(status: 'open' | 'fixed' = 'fixed'): BugData {
  return {
    bugs: [{
      id: `${STORY_ID}:BUG-001`,
      title: 'Validation failed before repair',
      status,
      foundAt: '2026-06-19T09:45:00.000Z',
      fixedAt: status === 'fixed' ? '2026-06-19T09:55:00.000Z' : null,
    }],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `${STORY_ID}:F-001`,
    desc: 'Reviewer found a real issue before repair',
    severity: 'medium',
    category: 'missing',
    status: 'resolved',
    evidenceState: 'verified',
    agent: 'lattice-review-quality',
    createdAt: '2026-06-19T10:05:00.000Z',
    reviewRound: REVIEW_ROUND,
    ...overrides,
  };
}

function verdict(runId: string, host: string, materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'host_verdict',
    timestamp: '2026-06-19T11:00:00.000Z',
    verdictId: `${runId}-${host}`,
    runId,
    hostId: host,
    provider: 'local-smoke',
    sessionId: `${host}-session`,
    keyId: `${host}-key`,
    decision: 'pass',
    materialDigest: materialHash,
    validationDigest: `validation-${runId}`,
    promptDigest: `prompt-${runId}`,
    ...overrides,
  };
}

function singleHostRounds(materialHash: string): ProcessEvent[] {
  return [
    verdict('round-1', 'codex-a', materialHash),
    verdict('round-2', 'codex-b', materialHash),
    verdict('round-3', 'codex-c', materialHash),
  ];
}

function twoHostRounds(materialHash: string): ProcessEvent[] {
  return [
    verdict('round-1', 'codex-a', materialHash),
    verdict('round-1', 'claude-a', materialHash),
    verdict('round-2', 'codex-b', materialHash),
    verdict('round-2', 'claude-b', materialHash),
    verdict('round-3', 'codex-c', materialHash),
    verdict('round-3', 'claude-c', materialHash),
  ];
}

function fallback(materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'review_escalation_fallback',
    timestamp: '2026-06-19T11:30:00.000Z',
    fallbackId: `${STORY_ID}:REF-001`,
    eligibility: 'single-host-environment',
    reason: 'Operator approved degraded fallback because only one verifier host was available.',
    evidenceRefs: ['manual:smoke-single-host-only'],
    materialHash,
    assuranceLevel: 'degraded-single-host',
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    ...overrides,
  };
}

function deliveryCheck(storyId: string, headHash: string, materialHash: string, reviewRound = REVIEW_ROUND) {
  const docsPromises: [] = [];
  const realMachineTests: [] = [];
  const closingSelfCheck = {
    hasRealMachineTest: true,
    hasEdgeCaseCoverage: true,
    hasUnresolvedTodos: false,
    summary: 'Smoke delivery self-check covers the synthetic guard path.',
  };
  return {
    storyId,
    checkedAt: '2026-06-19T12:00:00.000Z',
    headHash,
    materialHash,
    reviewRound,
    agentId: 'lattice-review-delivery',
    docsPromises,
    realMachineTests,
    closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, reviewRound, materialHash),
  };
}

function fakeDoneStore(metadataRoot: string, headHash: string, materialHash: string) {
  const smokeStory = story({
    currentReviewRound: REVIEW_ROUND,
    riskSignals: [],
    worktree: undefined,
  });
  const signedDeliveryCheck = deliveryCheck(STORY_ID, headHash, materialHash);
  return {
    readTestEvidence: () => ({ result: 'PASS', output: 'smoke validation passed' }),
    readBugs: () => ({ bugs: [] }),
    readDeliveryCheck: () => signedDeliveryCheck,
    readStory: () => smokeStory,
    readFindings: () => ({ findings: [] }),
    readProcessEvents: () => [verdict('round-1', 'codex-a', materialHash)],
    readUnderstanding: () => ({
      task: 'Wrapper root smoke',
      outcome: 'DONE guard uses resolved git cwd',
      facts: [],
      constraints: [],
      unknowns: [],
      touchpoints: ['packages/main/src/index.ts'],
      timestamp: '2026-06-19T11:45:00.000Z',
    }),
    storyDirPath: () => join(metadataRoot, '.lattice/story/actives', STORY_ID),
  };
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function assertProofAdmissibilityBlocked(report: ReviewAssuranceFloorReport): void {
  assert.equal(report.proofAdmissibility.blocking, true);
  assert.equal(report.proofAdmissibility.allowed, false);
  assert.equal(report.proofAdmissibility.mode, 'enforce');
  assert.equal(report.proofAdmissibility.enforcedConsumer, true);
  assert.match(report.reasons.join('\n'), /proof_admissibility_blocked/);
}

const root = makeRepo();
try {
  const materialHash = currentMaterialHash(root);
  assert.ok(materialHash, 'smoke repo must have a material hash');

  check('docs-only markdown is not overblocked', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['docs/requirements/decisions/floor.md', 'README.md'],
      processEvents: [],
      materialHash,
    });
    assert.equal(report.ok, true);
    assert.equal(report.required, false);
    assert.equal(report.requiredAssurance, 'none');
    assert.equal(report.authorityDone, false);
    assert.equal(report.productionDone, false);
  });

  check('zero-review material code is blocked', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [],
      materialHash,
    });
    assert.equal(report.ok, false);
    assert.equal(report.required, true);
    assert.equal(report.requiredAssurance, 'one-local-round');
    assert.match(report.reasons.join('\n'), /requires 1 fresh local PASS/);
    const formatted = formatReviewAssuranceFloorFailure(report);
    assert.match(formatted, /Cannot enter DONE: material code diff requires review assurance floor/);
    assert.match(formatted, /Stale material recovery:/);
    assert.match(formatted, /autopilot_review_submit/);
  });

  check('one fresh local review round passes clean material code', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [verdict('round-1', 'codex-a', materialHash)],
      materialHash,
    });
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'local-one-round');
    assert.equal(report.localRounds.validRounds.length, 1);
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
  });

  check('stale local review evidence does not count', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [verdict('round-1', 'codex-a', 'stale-material')],
      materialHash,
    });
    assert.equal(report.ok, false);
    assert.equal(report.localRounds.validRounds.length, 0);
    assert.equal(report.localRounds.ignoredVerdicts.some(v => v.reasons.some(reason => reason.includes('stale'))), true);
    const formatted = formatReviewAssuranceFloorFailure(report);
    assert.match(formatted, /stale host verdicts: round-1-codex-a@round-1 materialDigest=stale-material/);
    assert.match(formatted, new RegExp(`lattice validate --story=${STORY_ID} --json`));
    assert.match(formatted, new RegExp(`lattice verification_evidence_refresh_stale --storyId=${STORY_ID} --dryRun`));
    assert.match(formatted, new RegExp(`Re-submit local host verdicts over materialHash=${materialHash}`));
    assert.match(formatted, /lattice autopilot_review_submit/);
    assert.match(formatted, /Do not bypass stale material checks/);
    assert.doesNotMatch(formatted, /remote receipt server|remote proof|productionDone/);
  });

  check('stale recovery output truncates ignored verdict details', () => {
    const staleVerdicts = Array.from({ length: 12 }, (_, index) =>
      verdict(`round-${index + 1}`, `codex-${index + 1}`, `stale-material-${index + 1}`),
    );
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: staleVerdicts,
      materialHash,
    });
    const formatted = formatReviewAssuranceFloorFailure(report);
    assert.match(formatted, /\(\+8 more\)/);
    assert.match(formatted, /4 more ignored host verdict\(s\) omitted/);
    assert.equal((formatted.match(/ignored host verdict /g) ?? []).length, 8);
    assert.match(formatted, /Stale material recovery:/);
    assert.match(formatted, /lattice autopilot_review_status --storyId=B-review-assurance-floor/);
    assert.doesNotMatch(formatted, /skip stale|force DONE|override stale/i);
  });

  check('failure signals require sticky 3x1 local rounds', () => {
    const oneRound = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      bugs: bugData('fixed'),
      findings: [finding()],
      processEvents: [verdict('round-1', 'codex-a', materialHash)],
      materialHash,
    });
    assert.equal(oneRound.ok, false);
    assert.equal(oneRound.requiredAssurance, 'three-local-rounds');
    assert.equal(oneRound.localRounds.requiredRounds, REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS);
    assert.equal(oneRound.failureSignals.some(signal => signal.kind === 'bug'), true);
    assert.equal(oneRound.failureSignals.some(signal => signal.kind === 'verified-reviewer-finding'), true);

    const threeRounds = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      bugs: bugData('fixed'),
      processEvents: singleHostRounds(materialHash),
      materialHash,
    });
    assert.equal(threeRounds.ok, true);
    assert.equal(threeRounds.assuranceLevel, 'degraded-single-host');
    assert.equal(threeRounds.authorityDone, false);
    assert.equal(threeRounds.fullAuthorityDone, false);
    assert.equal(threeRounds.productionDone, false);
  });

  check('high-risk lifecycle gate work requires 3x2 or explicit degraded fallback', () => {
    write(root, 'lattice.config.json', JSON.stringify({
      proofAdmissibility: {
        mode: 'enforce',
        enforcedConsumers: ['REVIEW'],
      },
    }, null, 2));
    resetConfigCache();

    const oneRound = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [verdict('round-1', 'codex-a', materialHash)],
      materialHash,
    });
    assert.equal(oneRound.ok, false);
    assert.equal(oneRound.requiredAssurance, 'three-round-two-hosts-or-degraded-single-host');
    assert.equal(oneRound.localRounds.requiredRounds, REVIEW_ASSURANCE_FLOOR_HIGH_RISK_REQUIRED_ROUNDS);
    assert.equal(oneRound.localRounds.requiredPassingHostsPerRound, REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND);
    assert.match(oneRound.reasons.join('\n'), /3 rounds x 2 independent PASS hosts/);
    assert.match(oneRound.reasons.join('\n'), /no review_escalation_fallback record found/);
    assertProofAdmissibilityBlocked(oneRound);

    const full = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: twoHostRounds(materialHash),
      materialHash,
    });
    assert.equal(full.ok, true);
    assert.equal(full.assuranceLevel, 'full-3x2');
    assert.equal(full.authorityDone, false);
    assert.equal(full.fullAuthorityDone, false);
    assert.equal(full.productionDone, false);

    const degraded = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [...singleHostRounds(materialHash), fallback(materialHash)],
      materialHash,
    });
    assert.equal(degraded.ok, true);
    assert.equal(degraded.assuranceLevel, 'degraded-single-host');
    assert.equal(degraded.localRounds.ok, false);
    assert.equal(degraded.degradedFallback.ok, true);
    assert.equal(degraded.localRounds.requiredPassingHostsPerRound, REVIEW_ASSURANCE_FLOOR_HIGH_RISK_HOSTS_PER_ROUND);
    assert.equal(degraded.proofAdmissibility.allowed, true);
    assert.equal(degraded.proofAdmissibility.blocking, false);
    assert.equal(degraded.authorityDone, false);
    assert.equal(degraded.fullAuthorityDone, false);
    assert.equal(degraded.productionDone, false);

    const staleFallback = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [...singleHostRounds(materialHash), fallback('stale-material')],
      materialHash,
    });
    assert.equal(staleFallback.ok, false);
    assert.equal(staleFallback.degradedFallback.ok, false);
    assert.equal(staleFallback.degradedFallback.record?.valid, false);
    assert.match(staleFallback.reasons.join('\n'), /fallback invalid: materialHash is stale/);
    assertProofAdmissibilityBlocked(staleFallback);

    const invalidFallbackShape = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [
        ...singleHostRounds(materialHash),
        fallback(materialHash, {
          eligibility: 'not-a-valid-eligibility',
          evidenceRefs: [],
          assuranceLevel: 'local-one-round',
        }),
      ],
      materialHash,
    });
    assert.equal(invalidFallbackShape.ok, false);
    assert.equal(invalidFallbackShape.degradedFallback.ok, false);
    assert.equal(invalidFallbackShape.degradedFallback.record?.valid, false);
    assert.match(invalidFallbackShape.reasons.join('\n'), /fallback invalid: eligibility must be one of/);
    assert.match(invalidFallbackShape.reasons.join('\n'), /fallback invalid: fallback requires evidenceRefs or approvalRef/);
    assert.match(invalidFallbackShape.reasons.join('\n'), /fallback invalid: assuranceLevel must be degraded-single-host/);
    assertProofAdmissibilityBlocked(invalidFallbackShape);
  });

  check('forged local Authority completion fields remain non-authority', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [
        verdict('round-1', 'codex-a', materialHash, {
          authorityDone: true,
          fullAuthorityDone: true,
          productionDone: true,
        }),
      ],
      materialHash,
    });
    assert.equal(report.ok, true);
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
  });

  check('git diff classification detects material code without injected changedFiles', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      processEvents: [verdict('round-1', 'codex-a', materialHash)],
      materialHash,
    });
    assert.equal(report.required, true);
    assert.deepEqual(report.materialCodePaths, ['packages/main/src/index.ts']);
    assert.equal(report.ok, true);
  });

  check('wrapper-root machine DONE guard uses resolved gitCwd', () => {
    const wrapper = makeWrapperRepo();
    try {
      const wrapperHeadHash = currentGitHead(wrapper.gitRoot);
      const wrapperMaterialHash = currentMaterialHash(wrapper.gitRoot);
      assert.ok(wrapperHeadHash, 'wrapper gitRoot must have a git HEAD');
      assert.ok(wrapperMaterialHash, 'wrapper gitRoot must have a material hash');
      const store = fakeDoneStore(wrapper.metadataRoot, wrapperHeadHash, wrapperMaterialHash);
      const context: StoryMachineContext = {
        storyId: STORY_ID,
        store: store as any,
        projectRoot: wrapper.metadataRoot,
        gitCwd: wrapper.gitRoot,
      };
      assert.equal(canFinishGuard(context), true);
      assert.equal(getGuardFailureReason(STORY_ID, store as any, 'DONE', wrapper.metadataRoot), null);
    } finally {
      rmSync(wrapper.metadataRoot, { recursive: true, force: true });
    }
  });

  console.log(`\nreview-assurance-floor smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
