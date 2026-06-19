#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import {
  REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS,
  evaluateReviewAssuranceFloor,
  formatReviewAssuranceFloorFailure,
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

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
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
    assert.match(formatted, /Submit fresh local host verdicts with autopilot_review_submit/);
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
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [verdict('round-1', 'codex-a', 'stale-material')],
      materialHash,
    });
    assert.equal(report.ok, false);
    assert.equal(report.localRounds.validRounds.length, 0);
    assert.equal(report.localRounds.ignoredVerdicts.some(v => v.reasons.some(reason => reason.includes('stale'))), true);
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

  console.log(`\nreview-assurance-floor smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
