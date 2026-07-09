#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import {
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
  REVIEW_ESCALATION_REQUIRED_ROUNDS,
  evaluateReviewEscalation,
  formatReviewEscalationFailure,
  formatReviewEscalationReport,
} from '../core/review-escalation.js';
import type { Finding, ProcessEvent, StoryInfo } from '../core/types.js';
import { StoryStore } from '../core/store.js';
import { createVerdictHandlers } from '../handlers/verdict.js';
import { createReviewEscalationHandlers } from '../handlers/review-escalation.js';
import { canonicalReviewHostLauncherSpec, type CanonicalReviewHost } from '../core/host-execution-readiness.js';

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

function writeExecutable(root: string, path: string, content: string): void {
  write(root, path, content);
  chmodSync(join(root, path), 0o755);
}

function withFakeCanonicalHostPath(root: string, hosts: string[], fn: () => void): void {
  const bin = join(root, 'fake-host-bin');
  mkdirSync(bin, { recursive: true });
  for (const host of hosts) {
    writeExecutable(root, `fake-host-bin/${host}`, `#!/bin/sh\necho "${host} 1.0.0"\n`);
  }
  const oldPath = process.env.PATH;
  process.env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  try {
    fn();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
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

function withStoryFilesHash(events: ProcessEvent[], storyFilesHash: string): ProcessEvent[] {
  return events.map(event => ({ ...event, storyFilesHash }));
}

function fallback(materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'review_escalation_fallback',
    command: 'review_escalation_fallback_set',
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

function hostAvailabilityProbe(materialHash: string, availableHosts: string[], overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  const available = new Set(availableHosts);
  const hosts = (['codex', 'claude', 'agy'] as CanonicalReviewHost[]).map(host => {
    const spec = canonicalReviewHostLauncherSpec(host);
    const ready = available.has(host);
    return {
      host,
      command: host,
      ...(ready ? { executablePath: `/fake/bin/${host}` } : {}),
      versionOk: ready,
      available: ready,
      launcher: spec.launcher,
      launcherArgv: spec.launcherArgv,
      launcherSupport: ready ? 'supported' : 'unverified',
      launcherOk: ready,
      executionReady: ready,
      reviewReady: ready,
      progressMode: spec.progressMode,
      failureKind: ready ? 'none' : 'missing_executable',
      durationMs: ready ? 12 : 0,
      ...(ready ? { firstProgressMs: 12, exitCode: 0 } : {}),
      ...(ready ? {} : { error: 'executable not found in PATH' }),
      remediation: ready ? '' : `Install or expose ${host} in PATH.`,
    };
  });
  return {
    type: 'review_host_availability_probe',
    command: 'review_host_availability_probe',
    timestamp: '2026-06-13T12:20:00.000Z',
    probeId: `${STORY_ID}:RHP-001`,
    checkedAt: '2026-06-13T12:20:00.000Z',
    materialHash,
    hosts,
    availableHostCount: availableHosts.length,
    unavailableHostCount: 3 - availableHosts.length,
    executionReadyHostCount: availableHosts.length,
    reviewReadyHostCount: availableHosts.length,
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

  check('producer commands persist storyFilesHash on host verdict and degraded fallback records', () => {
    const commandRoot = makeRepo();
    try {
      write(commandRoot, 'packages/main/src/story.ts', 'export const story = 1;\n');
      git(commandRoot, ['add', '.']);
      git(commandRoot, ['commit', '-m', 'story file']);
      const store = new StoryStore(commandRoot);
      store.writeStory(STORY_ID, story());
      const material = currentMaterialHash(commandRoot)!;
      const storyFilesHash = currentStoryFilesHash(commandRoot)!;
      const ctx = { store, root: commandRoot, scanRoot: join(commandRoot, 'packages/main') };

      const verdict = createVerdictHandlers(ctx).autopilot_review_submit({
        storyId: STORY_ID,
        runId: 'round-command',
        hostId: 'codex-command',
        provider: 'codex',
        sessionId: 'codex-command-session',
        keyId: 'codex-command-key',
        decision: 'pass',
        materialDigest: material,
        validationDigest: 'validation-command',
        promptDigest: 'prompt-command',
        json: true,
      }) as any;
      assert.equal(verdict.storyFilesHash, storyFilesHash);

      withFakeCanonicalHostPath(commandRoot, ['codex'], () => {
        const probeResult = createReviewEscalationHandlers(ctx).review_host_availability_probe({
          storyId: STORY_ID,
          json: true,
        }) as any;
        assert.equal(probeResult.storyFilesHash, storyFilesHash);
        assert.equal(probeResult.availableHostCount, 1);

        const fallbackResult = createReviewEscalationHandlers(ctx).review_escalation_fallback_set({
          storyId: STORY_ID,
          eligibility: 'single-host-environment',
          reason: 'Operator approved degraded fallback because only one verifier host was available.',
          evidenceRefs: ['manual-approval:ticket-456'],
          json: true,
        }) as any;
        assert.equal(fallbackResult.storyFilesHash, storyFilesHash);
        assert.equal(fallbackResult.hostAvailabilityProbeId, probeResult.probeId);
      });

      const events = store.readProcessEvents(STORY_ID);
      assert.equal(events.find(event => event.type === 'host_verdict')?.storyFilesHash, storyFilesHash);
      assert.equal(events.find(event => event.type === 'review_host_availability_probe')?.storyFilesHash, storyFilesHash);
      assert.equal(events.find(event => event.type === 'review_escalation_fallback')?.storyFilesHash, storyFilesHash);
      assert.equal(events.find(event => event.type === 'review_escalation_fallback')?.hostAvailabilityProbeId, events.find(event => event.type === 'review_host_availability_probe')?.probeId);
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
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

  check('explicit-human-approval remains lower assurance degraded fallback', () => {
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

  check('missing host readiness probe blocks non-human degraded fallback', () => {
    const fresh = currentMaterialHash(root)!;
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('032'), finding('033')],
      processEvents: [
        ...singleHostRounds(fresh),
        fallback(fresh, {
          eligibility: 'single-host-environment',
          hostAvailabilityProbeId: '',
        }),
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.degradedFallback.record?.valid, false);
    assert.match(report.reasons.join('\n'), /hostAvailabilityProbeId is required|no fresh review_host_availability_probe/);
  });

  check('temporary host unavailability also requires fresh insufficient-host proof', () => {
    const fresh = currentMaterialHash(root)!;
    const storyFilesHash = currentStoryFilesHash(root)!;
    const missingProbe = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('032-temp-a'), finding('033-temp-a')],
      processEvents: [
        ...singleHostRounds(fresh),
        fallback(fresh, {
          eligibility: 'temporary-host-unavailability',
          hostAvailabilityProbeId: '',
        }),
      ],
    });
    assert.equal(missingProbe.ok, false);
    assert.match(missingProbe.reasons.join('\n'), /hostAvailabilityProbeId is required|no fresh review_host_availability_probe/);

    const staleProbe = hostAvailabilityProbe('stale-material', ['codex'], { storyFilesHash });
    const staleProbeReport = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('032-temp-b'), finding('033-temp-b')],
      processEvents: [
        ...singleHostRounds(fresh),
        staleProbe,
        fallback(fresh, {
          eligibility: 'temporary-host-unavailability',
          hostAvailabilityProbeId: staleProbe.probeId,
        }),
      ],
    });
    assert.equal(staleProbeReport.ok, false);
    assert.match(staleProbeReport.reasons.join('\n'), /not fresh\/valid: materialHash is stale|no fresh review_host_availability_probe/);

    const twoHostProbe = hostAvailabilityProbe(fresh, ['codex', 'claude'], { storyFilesHash });
    const twoHostReport = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('032-temp-c'), finding('033-temp-c')],
      processEvents: [
        ...singleHostRounds(fresh),
        twoHostProbe,
        fallback(fresh, {
          eligibility: 'temporary-host-unavailability',
          hostAvailabilityProbeId: twoHostProbe.probeId,
        }),
      ],
    });
    assert.equal(twoHostReport.ok, false);
    assert.match(twoHostReport.reasons.join('\n'), /reviewReadyHostCount=2\/3; use full 3x2 or explicit-human-approval/);
  });

  check('probe with reviewReadyHostCount below two permits degraded 3x1', () => {
    const fresh = currentMaterialHash(root)!;
    const probe = hostAvailabilityProbe(fresh, ['codex'], { storyFilesHash: currentStoryFilesHash(root)! });
    const report = evaluateReviewEscalation({
      projectRoot: root,
      story: story(),
      findings: [finding('034'), finding('035')],
      processEvents: [
        ...singleHostRounds(fresh),
        probe,
        fallback(fresh, {
          eligibility: 'single-host-environment',
          hostAvailabilityProbeId: probe.probeId,
        }),
      ],
    });
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'degraded-single-host');
    assert.equal(report.degradedFallback.record?.hostAvailabilityProbeId, probe.probeId);
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
  });

  check('probe with two executable canonical hosts blocks single-host fallback', () => {
    const commandRoot = makeRepo();
    try {
      write(commandRoot, 'packages/main/src/story.ts', 'export const story = 1;\n');
      git(commandRoot, ['add', '.']);
      git(commandRoot, ['commit', '-m', 'story file']);
      const store = new StoryStore(commandRoot);
      store.writeStory(STORY_ID, story());
      const ctx = { store, root: commandRoot, scanRoot: join(commandRoot, 'packages/main') };
      withFakeCanonicalHostPath(commandRoot, ['codex', 'claude'], () => {
        const handlers = createReviewEscalationHandlers(ctx);
        const probeResult = handlers.review_host_availability_probe({
          storyId: STORY_ID,
          json: true,
        }) as any;
        assert.equal(probeResult.availableHostCount, 2);
        assert.throws(() => handlers.review_escalation_fallback_set({
          storyId: STORY_ID,
          eligibility: 'single-host-environment',
          reason: 'Operator requested degraded fallback even though two hosts are available.',
          evidenceRefs: ['manual:should-block'],
          json: true,
        }), /reviewReadyHostCount=2\/3; use full 3x2 or explicit-human-approval/);
      });
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
    }
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

  check('unrelated main merge keeps escalation host verdicts valid with storyFilesHash advisory', () => {
    const driftRoot = makeRepo();
    try {
      write(driftRoot, 'packages/main/src/story.ts', 'export const story = 1;\n');
      git(driftRoot, ['add', '.']);
      git(driftRoot, ['commit', '-m', 'story file']);
      const recordedMaterial = currentMaterialHash(driftRoot)!;
      const recordedStoryFiles = currentStoryFilesHash(driftRoot)!;

      git(driftRoot, ['checkout', 'main']);
      write(driftRoot, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
      git(driftRoot, ['add', '.']);
      git(driftRoot, ['commit', '-m', 'unrelated main file']);
      git(driftRoot, ['checkout', 'story/B-review-escalation']);
      git(driftRoot, ['merge', 'main', '--no-edit']);

      assert.notEqual(currentMaterialHash(driftRoot), recordedMaterial, 'unrelated main merge changes whole-tree materialHash');
      assert.equal(currentStoryFilesHash(driftRoot), recordedStoryFiles, 'story-owned file hash remains stable after unrelated main merge');

      const report = evaluateReviewEscalation({
        projectRoot: driftRoot,
        story: story(),
        findings: [finding('050'), finding('051')],
        processEvents: withStoryFilesHash(fullQuorum(recordedMaterial), recordedStoryFiles),
      });
      assert.equal(report.ok, true);
      assert.equal(report.assuranceLevel, 'full-3x2');
      assert.equal(report.advisories?.some(line => line.includes('storyFilesHash matches')), true);
      assert.equal(report.fullQuorum.ignoredVerdicts.some(v => v.reasons.some(r => r.includes('stale'))), false);
      assert.match(formatReviewEscalationReport(report), /advisory: .*storyFilesHash matches/);
    } finally {
      rmSync(driftRoot, { recursive: true, force: true });
    }
  });

  check('story-owned file change still rejects escalation host verdicts despite storyFilesHash support', () => {
    const driftRoot = makeRepo();
    try {
      write(driftRoot, 'packages/main/src/story.ts', 'export const story = 1;\n');
      git(driftRoot, ['add', '.']);
      git(driftRoot, ['commit', '-m', 'story file']);
      const recordedMaterial = currentMaterialHash(driftRoot)!;
      const recordedStoryFiles = currentStoryFilesHash(driftRoot)!;

      write(driftRoot, 'packages/main/src/story.ts', 'export const story = 2;\n');
      git(driftRoot, ['add', '.']);
      git(driftRoot, ['commit', '-m', 'story file changed']);

      assert.notEqual(currentStoryFilesHash(driftRoot), recordedStoryFiles, 'story-owned file change must change storyFilesHash');
      const report = evaluateReviewEscalation({
        projectRoot: driftRoot,
        story: story(),
        findings: [finding('060'), finding('061')],
        processEvents: withStoryFilesHash(fullQuorum(recordedMaterial), recordedStoryFiles),
      });
      assert.equal(report.ok, false);
      assert.equal(report.fullQuorum.ignoredVerdicts.some(v => v.reasons.some(r => r.includes('stale'))), true);
      assert.equal(report.advisories?.length ?? 0, 0);
    } finally {
      rmSync(driftRoot, { recursive: true, force: true });
    }
  });

  check('degraded fallback accepts whole-tree drift only with matching storyFilesHash advisory', () => {
    const driftRoot = makeRepo();
    try {
      write(driftRoot, 'packages/main/src/story.ts', 'export const story = 1;\n');
      git(driftRoot, ['add', '.']);
      git(driftRoot, ['commit', '-m', 'story file']);
      const recordedMaterial = currentMaterialHash(driftRoot)!;
      const recordedStoryFiles = currentStoryFilesHash(driftRoot)!;

      git(driftRoot, ['checkout', 'main']);
      write(driftRoot, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
      git(driftRoot, ['add', '.']);
      git(driftRoot, ['commit', '-m', 'unrelated main file']);
      git(driftRoot, ['checkout', 'story/B-review-escalation']);
      git(driftRoot, ['merge', 'main', '--no-edit']);

      const report = evaluateReviewEscalation({
        projectRoot: driftRoot,
        story: story(),
        findings: [finding('070'), finding('071')],
        processEvents: [
          ...withStoryFilesHash(singleHostRounds(recordedMaterial), recordedStoryFiles),
          fallback(recordedMaterial, { storyFilesHash: recordedStoryFiles }),
        ],
      });
      assert.equal(report.ok, true);
      assert.equal(report.assuranceLevel, 'degraded-single-host');
      assert.equal(report.degradedFallback.record?.valid, true);
      assert.equal(report.degradedFallback.record?.advisories?.some(line => line.includes('storyFilesHash matches')), true);
      assert.match(formatReviewEscalationReport(report), /fallback advisory: .*storyFilesHash matches/);
    } finally {
      rmSync(driftRoot, { recursive: true, force: true });
    }
  });

  console.log(`\nreview-escalation smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
