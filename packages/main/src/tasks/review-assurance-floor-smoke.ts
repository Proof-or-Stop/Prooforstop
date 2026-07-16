#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { signReviewPass } from '../core/finding-verify.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { signReviewRun } from '../core/review-run.js';
import { StoryStore } from '../core/store.js';
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
import { canonicalReviewHostLauncherSpec, type CanonicalReviewHost } from '../core/host-execution-readiness.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import type { HandlerContext } from '../handlers/context.js';
import type { BugData, Finding, ProcessEvent, ReviewRun, StoryInfo } from '../core/types.js';

const STORY_ID = 'B-review-assurance-floor';
const REVIEW_ROUND = '2026-06-19T10:00:00.000Z';
const SMOKE_PROMPT = 'Reply READY and do not run tools.';

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

function concreteLauncherArgv(host: CanonicalReviewHost): string[] {
  return canonicalReviewHostLauncherSpec(host).launcherArgv.map(arg => {
    if (arg === '<prompt>') return SMOKE_PROMPT;
    if (arg === '<prompt-file>') return join(tmpdir(), `review-assurance-floor-${host}-prompt.txt`);
    return arg;
  });
}

function fallback(materialHash: string, overrides: Partial<ProcessEvent> = {}): ProcessEvent {
  return {
    type: 'review_escalation_fallback',
    command: 'review_escalation_fallback_set',
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
      launcherArgv: ready ? concreteLauncherArgv(host) : spec.launcherArgv,
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
    timestamp: '2026-06-19T11:20:00.000Z',
    probeId: `${STORY_ID}:RHP-001`,
    checkedAt: '2026-06-19T11:20:00.000Z',
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

function fakeDoneStore(metadataRoot: string, gitRoot: string, headHash: string, materialHash: string): StoryStore {
  const store = new StoryStore(metadataRoot);
  const smokeStory = story({
    currentReviewRound: REVIEW_ROUND,
    riskSignals: [],
    worktree: undefined,
  });
  const signedDeliveryCheck = deliveryCheck(STORY_ID, headHash, materialHash);
  const storyFilesHash = currentStoryFilesHash(gitRoot, 'HEAD', metadataRoot);
  assert.ok(storyFilesHash, 'wrapper gitRoot must have a storyFilesHash');

  store.writeStory(STORY_ID, smokeStory);
  store.writeChecklist(STORY_ID, { items: [] });
  store.writeTestEvidence(STORY_ID, {
    command: 'review-assurance-floor-smoke',
    output: 'smoke validation passed',
    result: 'PASS',
    timestamp: '2026-06-19T11:50:00.000Z',
    headHash,
    materialHash,
    storyFilesHash,
  });
  store.writeBugs(STORY_ID, { bugs: [] });
  store.writeDeliveryCheck(STORY_ID, signedDeliveryCheck);
  store.writeFindings(STORY_ID, { findings: [] });
  store.writeUnderstanding(STORY_ID, {
    task: 'Wrapper root smoke',
    outcome: 'DONE guard uses resolved git cwd',
    facts: [],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/index.ts'],
    timestamp: '2026-06-19T11:45:00.000Z',
  });

  const reviewers = computeActiveReviewers(smokeStory, store.readChecklist(STORY_ID), null, ['packages/main/src/index.ts']);
  const runs: ReviewRun[] = reviewers.map((reviewer, index) => {
    const agent = `lattice-review-${reviewer.name}`;
    const run: ReviewRun = {
      reviewRunId: `${STORY_ID}:RR-${index + 1}`,
      storyId: STORY_ID,
      agent,
      lane: agent,
      reviewRound: REVIEW_ROUND,
      startedAt: `2026-06-19T11:${String(index).padStart(2, '0')}:00.000Z`,
      headHash,
      materialHash,
      storyFilesHash,
      promptHash: `prompt-${reviewer.name}`,
    };
    run._hash = signReviewRun(
      run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound,
      run.startedAt, run.headHash, run.materialHash, run.promptHash,
      undefined, undefined, run.storyFilesHash,
    );
    return run;
  });
  store.writeReviewRuns(STORY_ID, { runs });
  store.writeReviewPasses(STORY_ID, { passes: runs.map((run, index) => {
    const id = `RP-${index + 1}`;
    const note = `${run.lane} wrapper-root smoke pass`;
    const createdAt = `2026-06-19T11:${String(index + 10).padStart(2, '0')}:00.000Z`;
    return {
      id,
      agent: run.agent,
      note,
      createdAt,
      reviewRound: run.reviewRound,
      reviewRunId: run.reviewRunId,
      _hash: signReviewPass(STORY_ID, id, run.agent, note, createdAt, run.reviewRound, run.reviewRunId),
    };
  }) });
  const { timestamp: _timestamp, ...hostVerdict } = verdict('round-1', 'codex-a', materialHash);
  store.appendProcessEvent(STORY_ID, hostVerdict);
  return store;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function staleRecoveryBlock(text: string): string {
  const start = text.indexOf('Stale material recovery:');
  assert.notEqual(start, -1, 'formatted floor failure must include stale material recovery guidance');
  return text.slice(start);
}

function renderedLatticeCommandFragments(text: string): string[] {
  const commands: string[] = [];
  for (const line of text.split('\n')) {
    const uncommented = line.split(' # ')[0];
    for (const segment of uncommented.split(';')) {
      const commandStart = segment.indexOf('lattice ');
      if (commandStart >= 0) {
        commands.push(segment.slice(commandStart).trim().replace(/[.,]$/, ''));
      }
    }
  }
  return commands;
}

function assertShellSafeLatticeCommandFragments(text: string): string[] {
  const commands = renderedLatticeCommandFragments(text);
  assert.ok(commands.length > 0, 'expected at least one rendered lattice command fragment');
  for (const command of commands) {
    assert.doesNotMatch(command, /<[^>\n]+>/, `angle placeholder in rendered command: ${command}`);
    execFileSync('zsh', ['-n', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return commands;
}

function assertStaleRecoveryCommandsShellSafe(formatted: string): string[] {
  const commands = assertShellSafeLatticeCommandFragments(staleRecoveryBlock(formatted));
  assert.equal(commands.length, 5, 'stale recovery must expose every inline lattice command fragment');
  assert.equal(commands.some((command) => command.startsWith('lattice validate ')), true);
  assert.equal(commands.some((command) => command.startsWith('lattice verification_evidence_refresh_stale ')), true);
  assert.equal(commands.some((command) => command.startsWith('lattice autopilot_review_submit ')), true);
  assert.equal(commands.some((command) => command.startsWith('lattice autopilot_review_status ')), true);
  assert.equal(commands.some((command) => command.startsWith('lattice review_escalation_status ')), true);
  return commands;
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
  const storyFilesHash = currentStoryFilesHash(root);
  assert.ok(storyFilesHash, 'smoke repo must have a story files hash');

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
    assert.match(formatted, new RegExp(`Legal reviewer/host only: re-submit local host verdicts over materialHash=${materialHash}`));
    assert.match(formatted, /lattice autopilot_review_submit/);
    assert.match(formatted, /--storyFilesHash=/);
    assert.match(formatted, /Do not bypass stale material checks/);
    assert.doesNotMatch(formatted, /remote receipt server|remote proof|productionDone/);
    assertStaleRecoveryCommandsShellSafe(formatted);
  });

  check('stale recovery placeholder commands are shell-safe without story or material bindings', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [verdict('round-1', 'codex-a', 'stale-material')],
      materialHash,
    });
    const { storyId: _storyId, ...reportWithoutStoryId } = report;
    const formatted = formatReviewAssuranceFloorFailure({
      ...reportWithoutStoryId,
      materialHash: null,
      storyFilesHash: null,
    });
    assert.match(formatted, /lattice validate --story=\{storyId\} --json/);
    assert.match(formatted, /Legal reviewer\/host only: re-submit local host verdicts over materialHash=\{current-materialHash\}/);
    assert.match(formatted, /--materialDigest=\{current-materialHash\}/);
    assert.doesNotMatch(staleRecoveryBlock(formatted), /<storyId>|<current-materialHash>/);
    const commands = assertStaleRecoveryCommandsShellSafe(formatted);
    assert.equal(commands.some((command) => command.includes('--storyId={storyId}')), true);
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
    assertStaleRecoveryCommandsShellSafe(formatted);
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

    const availabilityProbe = hostAvailabilityProbe(materialHash, ['codex'], { storyFilesHash });
    const degraded = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [
        ...singleHostRounds(materialHash),
        availabilityProbe,
        fallback(materialHash, { hostAvailabilityProbeId: availabilityProbe.probeId }),
      ],
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
      processEvents: [
        ...singleHostRounds(materialHash),
        availabilityProbe,
        fallback('stale-material', { hostAvailabilityProbeId: availabilityProbe.probeId }),
      ],
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
        availabilityProbe,
        fallback(materialHash, {
          eligibility: 'not-a-valid-eligibility',
          evidenceRefs: [],
          assuranceLevel: 'local-one-round',
          hostAvailabilityProbeId: availabilityProbe.probeId,
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

  check('missing host readiness probe blocks non-human high-risk degraded fallback', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [
        ...singleHostRounds(materialHash),
        fallback(materialHash),
      ],
      materialHash,
    });
    assert.equal(report.ok, false);
    assert.equal(report.degradedFallback.record?.valid, false);
    assert.match(report.reasons.join('\n'), /hostAvailabilityProbeId is required|no fresh review_host_availability_probe/);
    assertProofAdmissibilityBlocked(report);
  });

  check('temporary host unavailability also requires fresh insufficient-host proof', () => {
    const base = {
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      materialHash,
    };
    const missingProbe = evaluateReviewAssuranceFloor({
      ...base,
      processEvents: [
        ...singleHostRounds(materialHash),
        fallback(materialHash, { eligibility: 'temporary-host-unavailability' }),
      ],
    });
    assert.equal(missingProbe.ok, false);
    assert.match(missingProbe.reasons.join('\n'), /hostAvailabilityProbeId is required|no fresh review_host_availability_probe/);
    assertProofAdmissibilityBlocked(missingProbe);

    const staleProbe = hostAvailabilityProbe('stale-material', ['codex'], { storyFilesHash });
    const staleProbeReport = evaluateReviewAssuranceFloor({
      ...base,
      processEvents: [
        ...singleHostRounds(materialHash),
        staleProbe,
        fallback(materialHash, {
          eligibility: 'temporary-host-unavailability',
          hostAvailabilityProbeId: staleProbe.probeId,
        }),
      ],
    });
    assert.equal(staleProbeReport.ok, false);
    assert.match(staleProbeReport.reasons.join('\n'), /not fresh\/valid: materialHash is stale|no fresh review_host_availability_probe/);
    assertProofAdmissibilityBlocked(staleProbeReport);

    const twoHostProbe = hostAvailabilityProbe(materialHash, ['codex', 'claude'], { storyFilesHash });
    const twoHostReport = evaluateReviewAssuranceFloor({
      ...base,
      processEvents: [
        ...singleHostRounds(materialHash),
        twoHostProbe,
        fallback(materialHash, {
          eligibility: 'temporary-host-unavailability',
          hostAvailabilityProbeId: twoHostProbe.probeId,
        }),
      ],
    });
    assert.equal(twoHostReport.ok, false);
    assert.match(twoHostReport.reasons.join('\n'), /reviewReadyHostCount=2\/3; use full 3x2 or explicit-human-approval/);
    assertProofAdmissibilityBlocked(twoHostReport);
  });

  check('probe with reviewReadyHostCount below two permits high-risk degraded 3x1', () => {
    const probe = hostAvailabilityProbe(materialHash, ['codex'], { storyFilesHash });
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [
        ...singleHostRounds(materialHash),
        probe,
        fallback(materialHash, { hostAvailabilityProbeId: probe.probeId }),
      ],
      materialHash,
    });
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'degraded-single-host');
    assert.equal(report.degradedFallback.record?.hostAvailabilityProbeId, probe.probeId);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
  });

  check('probe with two executable canonical hosts blocks high-risk single-host fallback', () => {
    const probe = hostAvailabilityProbe(materialHash, ['codex', 'claude'], { storyFilesHash });
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [
        ...singleHostRounds(materialHash),
        probe,
        fallback(materialHash, { hostAvailabilityProbeId: probe.probeId }),
      ],
      materialHash,
    });
    assert.equal(report.ok, false);
    assert.equal(report.degradedFallback.record?.valid, false);
    assert.match(report.reasons.join('\n'), /reviewReadyHostCount=2\/3; use full 3x2 or explicit-human-approval/);
    assertProofAdmissibilityBlocked(report);
  });

  check('explicit-human-approval remains lower assurance without host probe', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      }),
      changedFiles: ['packages/main/src/core/machine.ts'],
      processEvents: [
        ...singleHostRounds(materialHash),
        fallback(materialHash, {
          eligibility: 'explicit-human-approval',
          approvalRef: 'approval:human-review-lead',
          evidenceRefs: ['manual:human-approval'],
        }),
      ],
      materialHash,
    });
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'degraded-single-host');
    assert.equal(report.localRounds.ok, false);
    assert.equal(report.degradedFallback.ok, true);
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
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
      const store = fakeDoneStore(wrapper.metadataRoot, wrapper.gitRoot, wrapperHeadHash, wrapperMaterialHash);
      const context: StoryMachineContext = {
        storyId: STORY_ID,
        store,
        projectRoot: wrapper.metadataRoot,
        gitCwd: wrapper.gitRoot,
      };
      assert.equal(canFinishGuard(context), true);
      assert.equal(getGuardFailureReason(STORY_ID, store, 'DONE', wrapper.metadataRoot), null);

      const transcriptPath = store.storyFilePath(STORY_ID, 'evidence/live-smoke-transcript.json');
      const deliveryHandlers = createDeliveryCheckHandlers({
        store,
        root: wrapper.metadataRoot,
        scanRoot: wrapper.gitRoot,
      } as HandlerContext);
      const invalidArtifacts: Array<[string, string]> = [
        ['write-only', JSON.stringify({ storyId: STORY_ID, mode: { runCommands: false }, actual: null })],
        ['malformed', '{'],
        ['cross-story', JSON.stringify({ storyId: 'B-other', mode: { runCommands: true }, actual: { exitCode: 0 } })],
        ['timeout', JSON.stringify({ storyId: STORY_ID, mode: { runCommands: true }, actual: { exitCode: null } })],
        ['non-zero', JSON.stringify({ storyId: STORY_ID, mode: { runCommands: true }, actual: { exitCode: 9 } })],
      ];
      for (const [label, raw] of invalidArtifacts) {
        mkdirSync(dirname(transcriptPath), { recursive: true });
        writeFileSync(transcriptPath, raw, 'utf8');
        assert.throws(() => deliveryHandlers.delivery_check_set({
          storyId: STORY_ID,
          docsPromises: [],
          realMachineTests: [],
          closingSelfCheck: {
            hasRealMachineTest: true,
            hasEdgeCaseCoverage: true,
            hasUnresolvedTodos: false,
            summary: 'Invalid live-smoke gate consumer regression.',
          },
        }), /delivery_check_set: live-smoke transcript/,
        `${label} transcript must be rejected by delivery_check_set`);
        assert.equal(canFinishGuard(context), false, `${label} transcript must block canFinishGuard`);
        assert.match(
          getGuardFailureReason(STORY_ID, store, 'DONE', wrapper.metadataRoot, wrapper.gitRoot) ?? '',
          /\[live_smoke_transcript_failed\]/,
          `${label} transcript must render the dedicated DONE failure`,
        );
      }

      writeFileSync(transcriptPath, JSON.stringify({
        storyId: STORY_ID,
        mode: { runCommands: true },
        actual: { exitCode: 0 },
      }), 'utf8');
      assert.equal(canFinishGuard(context), true, 'passing capture remains accepted by canFinishGuard');
      assert.equal(getGuardFailureReason(STORY_ID, store, 'DONE', wrapper.metadataRoot, wrapper.gitRoot), null);
    } finally {
      rmSync(wrapper.metadataRoot, { recursive: true, force: true });
    }
  });

  console.log(`\nreview-assurance-floor smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
