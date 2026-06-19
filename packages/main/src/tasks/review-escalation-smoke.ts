#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import {
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
  REVIEW_ESCALATION_REQUIRED_ROUNDS,
  evaluateReviewEscalation,
  formatReviewEscalationFailure,
  formatReviewEscalationReport,
} from '../core/review-escalation.js';
import type { Finding, ProcessEvent, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-review-escalation';
const ROUND_1 = '2026-06-13T10:00:00.000Z';
const ROUND_2 = '2026-06-13T11:00:00.000Z';

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
  const root = mkdtempSync(join(tmpdir(), 'review-escalation-'));
  write(root, 'README.md', 'review escalation smoke\n');
  write(root, 'docs/requirements/decisions/audit.md', '# Audit\n');
  git(root, ['init']);
  git(root, ['config', 'user.email', 'smoke@example.invalid']);
  git(root, ['config', 'user.name', 'Review Escalation Smoke']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['checkout', '-B', 'story/B-review-escalation']);
  return root;
}

function story(rounds = [ROUND_1]): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Review escalation smoke',
    description: 'Smoke test review escalation evaluator',
    type: 'feature',
    phase: 'TEST',
    priority: 'high',
    createdAt: '2026-06-13T09:00:00.000Z',
    startedAt: null,
    endedAt: null,
    events: rounds.map(timestamp => ({ phase: 'REVIEW', action: 'advance', timestamp })),
  };
}

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: `${STORY_ID}:F-${id}`,
    desc: `Finding ${id}`,
    severity: 'medium',
    category: 'missing',
    status: 'open',
    agent: 'lattice-review-quality',
    createdAt: '2026-06-13T10:05:00.000Z',
    reviewRound: ROUND_1,
    ...overrides,
  };
}

function verdict(runId: string, host: string, materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'host_verdict',
    timestamp: '2026-06-13T12:00:00.000Z',
    verdictId: `${runId}-${host}`,
    runId,
    hostId: host,
    provider: host,
    sessionId: `${host}-session`,
    keyId: `${host}-key`,
    decision: 'pass',
    materialDigest: materialHash,
    validationDigest: `validation-${runId}`,
    promptDigest: `prompt-${runId}`,
    ...overrides,
  };
}

function fullQuorum(materialHash: string): ProcessEvent[] {
  return [
    verdict('round-1', 'codex-a', materialHash),
    verdict('round-1', 'claude-a', materialHash),
    verdict('round-2', 'codex-b', materialHash),
    verdict('round-2', 'claude-b', materialHash),
    verdict('round-3', 'codex-c', materialHash),
    verdict('round-3', 'claude-c', materialHash),
  ];
}

function singleHostRounds(materialHash: string): ProcessEvent[] {
  return [
    verdict('round-1', 'codex-a', materialHash),
    verdict('round-2', 'codex-b', materialHash),
    verdict('round-3', 'codex-c', materialHash),
  ];
}

function fallback(materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'review_escalation_fallback',
    timestamp: '2026-06-13T12:30:00.000Z',
    fallbackId: `${STORY_ID}:REF-001`,
    eligibility: 'explicit-human-approval',
    reason: 'Operator approved degraded fallback because only one verifier host was available.',
    evidenceRefs: ['manual-approval:ticket-123'],
    materialHash,
    assuranceLevel: 'degraded-single-host',
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    ...overrides,
  };
}

function explicitHighRiskPolicy(materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'review_escalation_policy',
    timestamp: '2026-06-13T12:15:00.000Z',
    policyId: `${STORY_ID}:POL-001`,
    predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
    requires3x2: true,
    policyVersion: 'M8.explicit-high-risk-policy.v1',
    riskClass: 'process-fact',
    sourcePolicyRef: 'docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md#M8',
    rolloutStage: 'enforced',
    degradedFallbackAllowed: true,
    issuer: 'lattice-policy-smoke',
    issuedAt: '2026-06-13T12:15:00.000Z',
    materialHash,
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    ...overrides,
  };
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

  check('ordinary documentation audit changes do not require escalation by themselves', () => {
    write(root, 'docs/requirements/decisions/audit.md', '# Audit\n\nDiagnostic-only edit.\n');
    git(root, ['add', 'docs/requirements/decisions/audit.md']);
    git(root, ['commit', '-m', 'decision doc edit']);
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [],
      processEvents: [],
    });
    assert.equal(report.ok, true);
    assert.equal(report.required, false);
    assert.equal(report.assuranceLevel, 'ordinary-review');
    assert.equal(report.voluntaryLocalRounds.complete, false);
    assert.equal(report.voluntaryLocalRounds.validRoundCount, 0);
    assert.equal(report.voluntaryLocalRounds.submittedRoundCount, 0);
    assert.match(formatReviewEscalationReport(report), /voluntaryLocalRounds: 0\/3/);
  });

  check('voluntary local 3x2 rounds are visible when escalation is not required', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [],
      processEvents: fullQuorum(fresh),
    });
    assert.equal(report.ok, true, 'voluntary rounds must not change required=false ok semantics');
    assert.equal(report.required, false);
    assert.equal(report.assuranceLevel, 'ordinary-review');
    assert.equal(report.fullQuorum.ok, true, 'existing non-required fullQuorum compatibility remains');
    assert.equal(report.fullQuorum.validRounds.length, 0, 'non-required fullQuorum remains the historical empty compatibility view');
    assert.equal(report.voluntaryLocalRounds.complete, true);
    assert.equal(report.voluntaryLocalRounds.validRoundCount, REVIEW_ESCALATION_REQUIRED_ROUNDS);
    assert.equal(report.voluntaryLocalRounds.submittedRoundCount, REVIEW_ESCALATION_REQUIRED_ROUNDS);
    assert.equal(report.voluntaryLocalRounds.ignoredVerdicts.length, 0);
    assert.match(formatReviewEscalationReport(report), /voluntaryLocalRounds: 3\/3/);
  });

  check('valid explicit high-risk policy fact requires 3x2 without first-round problems', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [],
      processEvents: [explicitHighRiskPolicy(fresh), ...fullQuorum(fresh)],
    });
    assert.equal(report.required, true);
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'full-3x2');
    assert.equal(report.trigger.countableProblems.length, 0);
    assert.equal(report.trigger.explicitHighRiskPolicy.required, true);
    assert.equal(report.trigger.explicitHighRiskPolicy.validPolicy?.policyVersion, 'M8.explicit-high-risk-policy.v1');
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
    assert.match(formatReviewEscalationReport(report), /explicitHighRiskPolicy: required/);
    assert.match(formatReviewEscalationReport(report), new RegExp(REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE));
  });

  check('policy-only escalation failure text names explicit high-risk policy', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [],
      processEvents: [explicitHighRiskPolicy(fresh)],
    });
    assert.equal(report.required, true);
    assert.equal(report.ok, false);
    assert.equal(report.trigger.countableProblems.length, 0);
    const failure = formatReviewEscalationFailure(report);
    const firstLine = failure.split('\n')[0] ?? '';
    assert.match(firstLine, /explicit high-risk policy/);
    assert.doesNotMatch(firstLine, /first REVIEW round recorded multiple countable reviewer problems/);
  });

  check('high-risk prose or paths do not trigger without explicit policy fact', () => {
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: {
        ...story(),
        title: 'High-risk process-fact gate and decision-doc work',
        description: 'Mentions lifecycle gate Authority and process-fact work, but has no explicit policy fact.',
      },
      findings: [],
      processEvents: [],
    });
    assert.equal(report.ok, true);
    assert.equal(report.required, false);
    assert.equal(report.trigger.explicitHighRiskPolicy.required, false);
    assert.equal(report.assuranceLevel, 'ordinary-review');
  });

  check('explicit high-risk policy can disallow degraded single-host fallback', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [],
      processEvents: [
        explicitHighRiskPolicy(fresh, { policyId: `${STORY_ID}:POL-NO-DEGRADED`, degradedFallbackAllowed: false }),
        ...singleHostRounds(fresh),
        fallback(fresh),
      ],
    });
    assert.equal(report.required, true);
    assert.equal(report.ok, false);
    assert.equal(report.fullQuorum.ok, false);
    assert.equal(report.degradedFallback.ok, false);
    assert.equal(report.degradedFallback.allowed, false);
    assert.equal(report.assuranceLevel, 'ordinary-review');
    assert.equal(report.reasons.some(reason => reason.includes('disallows degraded single-host fallback')), true);
    assert.equal(report.productionDone, false);
  });

  check('two first-round verified reviewer problems trigger and full 3x2 passes', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('001'), finding('002', { agent: 'lattice-review-concept', evidenceState: 'verified' })],
      processEvents: fullQuorum(fresh),
    });
    assert.equal(report.required, true);
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'full-3x2');
    assert.equal(report.fullQuorum.validRounds.length, REVIEW_ESCALATION_REQUIRED_ROUNDS);
  });

  check('suspected, disproven, low, non-reviewer, and later-round findings do not trigger', () => {
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story([ROUND_1, ROUND_2]),
      findings: [
        finding('010', { evidenceState: 'suspected' }),
        finding('011', { evidenceState: 'disproven' }),
        finding('012', { severity: 'low' }),
        finding('013', { agent: 'main' }),
        finding('014', { reviewRound: ROUND_2 }),
        finding('015'),
      ],
      processEvents: [],
    });
    assert.equal(report.required, false);
    assert.equal(report.trigger.countableProblems.length, 1);
  });

  check('stale, duplicate-identity, and non-pass host verdicts fail closed', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('020'), finding('021')],
      processEvents: [
        verdict('round-1', 'codex-a', fresh),
        verdict('round-1', 'claude-a', fresh, { sessionId: 'codex-a-session' }),
        verdict('round-2', 'codex-b', 'stale-material'),
        verdict('round-2', 'claude-b', fresh),
        verdict('round-3', 'codex-c', fresh),
        verdict('round-3', 'claude-c', fresh, { decision: 'blocked' }),
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.fullQuorum.validRounds.length, 0);
    assert.equal(report.fullQuorum.invalidRounds.length >= 2, true);
    assert.equal(report.fullQuorum.ignoredVerdicts.some(v => v.reasons.some(r => r.includes('stale'))), true);
    assert.equal(report.fullQuorum.ignoredVerdicts.some(v => v.reasons.some(r => r.includes('decision is blocked'))), true);
  });

  check('explicit degraded 3x1 fallback passes as degraded only', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('030'), finding('031')],
      processEvents: [...singleHostRounds(fresh), fallback(fresh)],
    });
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'degraded-single-host');
    assert.equal(report.fullQuorum.ok, false);
    assert.equal(report.degradedFallback.ok, true);
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
  });

  check('degraded fallback requires approval or evidence and fresh material binding', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('040'), finding('041')],
      processEvents: [
        ...singleHostRounds(fresh),
        fallback('stale-material', { evidenceRefs: [], approvalRef: '' }),
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.degradedFallback.record?.valid, false);
    assert.equal(report.degradedFallback.record?.reasons.some(r => r.includes('materialHash is stale')), true);
    assert.equal(report.degradedFallback.record?.reasons.some(r => r.includes('evidenceRefs or approvalRef')), true);
  });

  console.log(`\nreview-escalation smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
