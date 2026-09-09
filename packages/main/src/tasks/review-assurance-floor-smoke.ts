#!/usr/bin/env node

import assert from 'node:assert/strict';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { signReviewPass } from '../core/finding-verify.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import { hashReviewPrompt, signReviewRun } from '../core/review-run.js';
import { PROMPT_ENVELOPE_ROLLOUT_VERSION, resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
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
  buildReviewAssuranceFloorGuidance,
  formatReviewAssuranceFloorFailure,
  type ReviewAssuranceFloorReport,
} from '../core/review-assurance-floor.js';
import { canonicalReviewHostLauncherSpec, type CanonicalReviewHost } from '../core/host-execution-readiness.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import { createDeliveryCheckHandlers } from '../handlers/delivery-check.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import type { HandlerContext } from '../handlers/context.js';
import type { BugData, Finding, ProcessEvent, ReviewRun, StoryInfo } from '../core/types.js';
import { listVerdicts } from '../core/verdicts.js';

const RETIRED_STATE_DIR = ['.', 'lat', 'tice'].join('');

const STORY_ID = 'B-review-assurance-floor';
const REVIEW_ROUND = '2026-06-19T10:00:00.000Z';
const SMOKE_PROMPT = 'Reply READY and do not run tools.';
const DIST_CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

function legacyPromptHash(agent: string): string {
  return hashReviewPrompt(resolvePromptRoleBody(agent, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [agent]: 'legacy-full-context' },
  }).body);
}

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
  write(metadataRoot, 'proof-or-stop.config.json', JSON.stringify({ gitRoot: 'repo' }, null, 2));
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
    agent: 'proof-or-stop-review-quality',
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
    agentId: 'proof-or-stop-review-delivery',
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
  // B-a7c5 CHK-003: canFinishGuard now ALSO requires a dev_memory_finish_decision
  // record. This write lands under metadataRoot (.proof-or-stop/dev-memory/), never
  // gitRoot, so it cannot perturb the wrapper-root materialHash computed above.
  createPlaybookRuntimeMemoryHandlers({ store, root: metadataRoot, scanRoot: gitRoot })
    .dev_memory_finish_decision({ storyId: STORY_ID, decision: 'no-reusable-lesson', reason: 'review-assurance-floor-smoke fixture; no lesson to capture' });

  check('B-3f3d F-096/F-097: reviewer_forced replay mounts durably, ignores the auto-init writer, and tolerates a malformed reviewer', () => {
    // B-3f3d F-096/F-097: the persisted `reviewer_forced` replay must (a) mount a real
    // operator force durably, (b) ignore review-run.ts's ensureCurrentReviewRound events,
    // which reuse the SAME action string but carry no `reviewer` — the non-empty check is
    // the load-bearing disambiguation between the two writers, not incidental hygiene —
    // and (c) stay inert rather than throwing on a malformed persisted value, since every
    // gate consumer (canPassReviewGuard, epoch requiredLanes, quorum-submit, ...) calls this.
    const forcedReplayStory = {
      riskSignals: [],
      events: [
        { phase: 'REVIEW', action: 'reviewer_forced', timestamp: '2026-06-19T11:00:00.000Z', reason: 'auto-init', agent: 'main' },
        { phase: 'REVIEW', action: 'reviewer_forced', timestamp: '2026-06-19T11:01:00.000Z', reviewer: 'behavior', reason: 'manual', agent: 'main' },
        { phase: 'REVIEW', action: 'advance', timestamp: '2026-06-19T11:02:00.000Z', reviewer: 'docs', agent: 'main' },
        { phase: 'REVIEW', action: 'reviewer_forced', timestamp: '2026-06-19T11:03:00.000Z', reviewer: 12345 as unknown as string, agent: 'main' },
      ],
    } as unknown as Parameters<typeof computeActiveReviewers>[0];
    const replayed = computeActiveReviewers(forcedReplayStory, { items: [] }, null, []);
    const replayedNames = replayed.map(row => row.name);
    assert.ok(replayedNames.includes('behavior'), 'a persisted reviewer_forced event must durably mount its lane');
    assert.equal(
      replayed.find(row => row.name === 'behavior')?.forced, true,
      'a replayed forced lane must be marked forced, not merely present',
    );
    assert.ok(
      !replayedNames.includes('docs'),
      'a non-reviewer_forced event carrying a reviewer field must not mount a lane',
    );
    // The auto-init writer's event carries NO `reviewer`. Two independent guards keep it
    // inert: the `.filter(name => name.length > 0)` on the replay and the `if (!name)
    // continue` in the mount loop. Either alone suffices, so removing just one is not
    // observable — this asserts the OBSERVABLE property (no empty lane is ever mounted)
    // rather than pinning a single line, and still fails if both guards were dropped.
    assert.ok(
      replayedNames.every(name => typeof name === 'string' && name.trim().length > 0),
      'the reviewer_forced replay must never admit an empty lane name from the auto-init writer',
    );
    assert.equal(
      replayed.filter(row => row.name === 'behavior').length, 1,
      'replaying reviewer_forced events must not duplicate a lane',
    );
  });

  const reviewers = computeActiveReviewers(smokeStory, store.readChecklist(STORY_ID), null, ['packages/main/src/index.ts']);
  const runs: ReviewRun[] = reviewers.map((reviewer, index) => {
    const agent = `proof-or-stop-review-${reviewer.name}`;
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
      promptHash: legacyPromptHash(agent),
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

/**
 * Extract rendered CLI command fragments so each can be shell-linted.
 *
 * Recognizes the canonical `proof-or-stop` bin FIRST and the deprecated `proof-or-stop`
 * spelling as a fallback (B-cdf6 CHK-006). Matching only `proofOrStop ` silently found
 * just 1 of the 5 fragments once the guidance text was rebranded, which turned a
 * shell-safety check into a near-no-op instead of a failure.
 */
function renderedProofOrStopCommandFragments(text: string): string[] {
  const commands: string[] = [];
  const prefixes = [
    'node bin/proof-or-stop.js ',
    'node bin/proofOrStop.js ',
    'proof-or-stop ',
    'proofOrStop ',
  ];
  for (const line of text.split('\n')) {
    const uncommented = line.split(' # ')[0];
    for (const segment of uncommented.split(';')) {
      const commandStart = prefixes
        .map((prefix) => segment.indexOf(prefix))
        .filter((index) => index >= 0)
        .reduce((earliest, index) => (earliest < 0 ? index : Math.min(earliest, index)), -1);
      if (commandStart >= 0) {
        commands.push(segment.slice(commandStart).trim().replace(/[.,]$/, ''));
      }
    }
  }
  return commands;
}

function assertShellSafeProofOrStopCommandFragments(text: string): string[] {
  const commands = renderedProofOrStopCommandFragments(text);
  assert.ok(commands.length > 0, 'expected at least one rendered proof-or-stop command fragment');
  for (const command of commands) {
    assert.doesNotMatch(command, /<[^>\n]+>/, `angle placeholder in rendered command: ${command}`);
    execFileSync('zsh', ['-n', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return commands;
}

function assertStaleRecoveryCommandsShellSafe(formatted: string): string[] {
  const commands = assertShellSafeProofOrStopCommandFragments(staleRecoveryBlock(formatted));
  assert.equal(commands.length, 5, 'stale recovery must expose every inline proof-or-stop command fragment');
  assert.equal(commands.some((command) => command.startsWith('proof-or-stop validate ')), true);
  assert.equal(commands.some((command) => command.startsWith('proof-or-stop verification_evidence_refresh_stale ')), true);
  // B-cc10 F-077: the runtime emits the CANONICAL wrapper name; `bin/proofOrStop.js` was deleted
  // by this story, so pinning it made this assertion unsatisfiable. Accepts either spelling so
  // a teammate branch still emitting the deprecated wrapper keeps passing.
  assert.equal(commands.some((command) => command.startsWith('node bin/proof-or-stop.js autopilot_review_submit ') || command.startsWith('node bin/proofOrStop.js autopilot_review_submit ')), true);
  assert.equal(commands.some((command) => command.startsWith('proof-or-stop autopilot_review_status ')), true);
  assert.equal(commands.some((command) => command.startsWith('proof-or-stop review_escalation_status ')), true);
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
      storyId: STORY_ID,
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
    const submitCommands = buildReviewAssuranceFloorGuidance(report).legalWriterPaths.reviewerHost
      .filter(recipe => recipe.command.includes('autopilot_review_submit'));
    assert.equal(submitCommands.length, 1, 'ordinary material requires exactly one local round');
    assert.match(submitCommands[0]!.command, new RegExp(`--runId=${STORY_ID}-degraded-r1(?: |$)`));
  });

  check('one fresh local review round passes clean material code', () => {
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      processEvents: [verdict(`${STORY_ID}-degraded-r1`, 'codex-a', materialHash)],
      materialHash,
    });
    assert.equal(report.ok, true);
    assert.equal(report.assuranceLevel, 'local-one-round');
    assert.equal(report.localRounds.validRounds.length, 1);
    assert.equal(report.authorityDone, false);
    assert.equal(report.fullAuthorityDone, false);
    assert.equal(report.productionDone, false);
    assert.equal(
      buildReviewAssuranceFloorGuidance(report).legalWriterPaths.reviewerHost
        .filter(recipe => recipe.command.includes('autopilot_review_submit')).length,
      0,
      'satisfied ordinary guidance must not suggest the already effective runId',
    );
  });

  check('compatibility/retired-only records cannot satisfy the host-verdict assurance floor', () => {
    const findings = ['implementation-reviewer', 'test-intent', 'proof-or-stop-review-channel'].map((agent, index) =>
      finding({
        id: `${STORY_ID}:COMPAT-F-${index + 1}`,
        agent,
        severity: 'high',
        status: 'open',
      }));
    const report = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      changedFiles: ['packages/main/src/index.ts'],
      findings,
      processEvents: [],
      materialHash,
    });
    assert.equal(report.ok, false);
    assert.equal(report.requiredAssurance, 'one-local-round');
    assert.equal(report.failureSignals.length, 0, 'compatibility/retired roles cannot manufacture reviewer authority');
    assert.equal(report.localRounds.validRounds.length, 0);
    assert.match(report.reasons.join('\n'), /requires 1 fresh local PASS round/);
    assert.equal(report.proofAdmissibility.artifactKind, 'host-verdict');
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
    assert.match(formatted, new RegExp(`proof-or-stop validate --story=${STORY_ID} --json`));
    assert.match(formatted, new RegExp(`proof-or-stop verification_evidence_refresh_stale --storyId=${STORY_ID} --dryRun`));
    assert.match(formatted, new RegExp(`Legal reviewer/host only: re-submit local host verdicts over materialHash=${materialHash}`));
    assert.match(formatted, /node bin\/(?:proof-or-stop|proofOrStop)\.js autopilot_review_submit/); // B-cc10 F-077: canonical wrapper; bin/proofOrStop.js was deleted
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
    assert.match(formatted, /proof-or-stop validate --story=\{storyId\} --json/);
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
    assert.match(formatted, /proof-or-stop autopilot_review_status --storyId=B-review-assurance-floor/);
    assert.doesNotMatch(formatted, /skip stale|force DONE|override stale/i);
    assertStaleRecoveryCommandsShellSafe(formatted);
  });

  check('failure signals require sticky 3x1 local rounds', () => {
    const empty = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      bugs: bugData('fixed'),
      processEvents: [],
      materialHash,
    });
    const emptyCommands = buildReviewAssuranceFloorGuidance(empty).legalWriterPaths.reviewerHost
      .filter(recipe => recipe.command.includes('autopilot_review_submit'));
    assert.deepEqual(
      emptyCommands.map(recipe => recipe.command.match(/--runId=([^ ]+)/)?.[1]),
      [`${STORY_ID}-degraded-r1`, `${STORY_ID}-degraded-r2`, `${STORY_ID}-degraded-r3`],
      'failure floor guidance emits the complete distinct 3x1 recipe set',
    );

    const oneRound = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      bugs: bugData('fixed'),
      findings: [finding()],
      processEvents: [verdict(`${STORY_ID}-degraded-r1`, 'codex-a', materialHash)],
      materialHash,
    });
    assert.equal(oneRound.ok, false);
    assert.equal(oneRound.requiredAssurance, 'three-local-rounds');
    assert.equal(oneRound.localRounds.requiredRounds, REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS);
    assert.equal(oneRound.failureSignals.some(signal => signal.kind === 'bug'), true);
    assert.equal(oneRound.failureSignals.some(signal => signal.kind === 'verified-reviewer-finding'), true);
    const remainingCommands = buildReviewAssuranceFloorGuidance(oneRound).legalWriterPaths.reviewerHost
      .filter(recipe => recipe.command.includes('autopilot_review_submit'));
    assert.deepEqual(
      remainingCommands.map(recipe => recipe.command.match(/--runId=([^ ]+)/)?.[1]),
      [`${STORY_ID}-degraded-r2`, `${STORY_ID}-degraded-r3`],
      'guidance omits an already valid generated runId and supplies only the missing rounds',
    );

    const duplicateRunId = `${STORY_ID}-degraded-r1`;
    const duplicate = evaluateReviewAssuranceFloor({
      projectRoot: root,
      story: story(),
      storyId: STORY_ID,
      changedFiles: ['packages/main/src/index.ts'],
      bugs: bugData('fixed'),
      processEvents: [
        verdict(duplicateRunId, 'codex-a', materialHash),
        verdict(duplicateRunId, 'codex-a', materialHash, { verdictId: `${duplicateRunId}-duplicate` }),
      ],
      materialHash,
    });
    assert.equal(duplicate.localRounds.validRounds.length, 0);
    assert.equal(duplicate.localRounds.invalidRounds[0]?.runId, duplicateRunId);
    const recoveryCommands = buildReviewAssuranceFloorGuidance(duplicate).legalWriterPaths.reviewerHost
      .filter(recipe => recipe.command.includes('autopilot_review_submit'));
    assert.deepEqual(
      recoveryCommands.map(recipe => recipe.command.match(/--runId=([^ ]+)/)?.[1]),
      [`${STORY_ID}-degraded-r2`, `${STORY_ID}-degraded-r3`, `${STORY_ID}-degraded-r4`],
      'duplicate-poisoned runIds are skipped while a complete three-round recovery set is emitted',
    );

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
    write(root, 'proof-or-stop.config.json', JSON.stringify({
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
    const guidance = buildReviewAssuranceFloorGuidance(oneRound);
    const singleHostCommands = guidance.legalWriterPaths.reviewerHost.filter(recipe => recipe.command.includes('autopilot_review_submit'));
    assert.equal(singleHostCommands.length, 2, 'high-risk fallback guidance emits only the two missing single-host rounds');
    assert.equal(new Set(singleHostCommands.map(recipe => recipe.command.match(/--runId=([^ ]+)/)?.[1])).size, 2);
    for (const recipe of singleHostCommands) {
      assert.match(recipe.command, /--deriveBindings/);
      assert.match(recipe.command, new RegExp(`--materialDigest=${materialHash}`));
      assert.match(recipe.command, new RegExp(`--storyFilesHash=${storyFilesHash}`));
      assert.match(recipe.command, /--hostId="\$\(hostname\)"/);
      assert.match(recipe.command, /--provider=local/);
      assert.doesNotMatch(recipe.command, /\{round-id\}|\{host\}|\{session\}|\{key\}|fresh-validation-digest|current-prompt-digest/);
      execFileSync('zsh', ['-n', '-c', recipe.command], { stdio: ['ignore', 'pipe', 'pipe'] });
    }

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

  check('literal worktree-local guidance executes three complete degraded-only rounds', () => {
    const commandRoot = makeRepo();
    try {
      // B-cc10 F-077: the guidance recipe now names `bin/proof-or-stop.js`, so the fixture
      // must materialize the wrapper under THAT name or the recipe invokes a file that does
      // not exist (MODULE_NOT_FOUND). Both names are written: the canonical one is what the
      // recipe executes, and the deprecated one keeps a teammate branch's recipe runnable.
      const fixtureWrapper = `#!/usr/bin/env node\nimport ${JSON.stringify(DIST_CLI_PATH)};\n`;
      write(commandRoot, 'bin/proof-or-stop.js', fixtureWrapper);
      write(commandRoot, 'bin/proofOrStop.js', fixtureWrapper);
      // B-cc10 F-077: the runtime writes autopilot verdicts under the CANONICAL state dir, so
      // ignoring only the deprecated spelling left them as blocking dirty paths and
      // autopilot_review_submit --deriveBindings refused. Both spellings are ignored.
      write(commandRoot, '.gitignore', `${RETIRED_STATE_DIR}/autopilot-verdicts/\n${PROOF_OR_STOP_STATE_DIR}/autopilot-verdicts/\n`);
      write(commandRoot, 'proof-or-stop.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.proof-or-stop/story/actives',
        proofAdmissibility: { mode: 'enforce', enforcedConsumers: ['REVIEW'] },
      }, null, 2) + '\n');
      git(commandRoot, ['add', '.gitignore', 'bin/proof-or-stop.js', 'bin/proofOrStop.js', 'proof-or-stop.config.json']);
      git(commandRoot, ['commit', '-m', 'self-host command fixture']);
      resetConfigCache();
      const store = new StoryStore(commandRoot);
      const smokeStory = story({
        priority: 'high',
        riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
      });
      store.writeStory(STORY_ID, smokeStory);
      store.writeChecklist(STORY_ID, { items: [] });
      const currentMaterial = currentMaterialHash(commandRoot)!;
      const currentStoryFiles = currentStoryFilesHash(commandRoot)!;
      const currentHead = currentGitHead(commandRoot)!;
      const coverage = { total: 0, required: 0, covered: 0, missingRequired: 0, entries: [] };
      store.writeTestEvidence(STORY_ID, {
        command: `proof-or-stop validate --story=${STORY_ID} --json`,
        output: JSON.stringify({ allPass: true, verificationCoverage: coverage }),
        result: 'PASS',
        timestamp: '2026-06-19T11:50:00.000Z',
        headHash: currentHead,
        materialHash: currentMaterial,
        storyFilesHash: currentStoryFiles,
        verificationCoverage: coverage,
      });
      const blocked = evaluateReviewAssuranceFloor({
        projectRoot: commandRoot,
        story: smokeStory,
        storyId: STORY_ID,
        changedFiles: ['packages/main/src/core/machine.ts'],
        processEvents: [],
        materialHash: currentMaterial,
        storyFilesHash: currentStoryFiles,
      });
      const recipes = buildReviewAssuranceFloorGuidance(blocked).legalWriterPaths.reviewerHost
        .filter(recipe => recipe.command.includes('autopilot_review_submit'));
      assert.equal(recipes.length, 3);
      for (const recipe of recipes) {
        assert.match(recipe.command, /^node bin\/(?:proof-or-stop|proofOrStop)\.js autopilot_review_submit /); // B-cc10 F-077: accept either wrapper name
        execFileSync('zsh', ['-c', recipe.command], {
          cwd: commandRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'literal-guidance-smoke', PROOF_OR_STOP_NO_HOOKS: '1' },
        });
      }
      const persisted = listVerdicts(commandRoot, 'local', STORY_ID);
      assert.equal(persisted.length, 3, 'each literal command persists exactly one verdict');
      assert.equal(new Set(persisted.map(item => item.hostId)).size, 1, 'single-host guidance never fabricates a second host');
      for (const item of persisted) {
        assert.ok(item.keyId);
        assert.match(item.validationDigest ?? '', /^[0-9a-f]{64}$/);
        assert.match(item.promptDigest ?? '', /^[0-9a-f]{64}$/);
        assert.equal(item.materialDigest, currentMaterial);
        assert.equal(item.storyFilesHash, currentStoryFiles);
      }
      const verdictEvents = store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict');
      assert.equal(verdictEvents.length, 3);
      const degraded = evaluateReviewAssuranceFloor({
        projectRoot: commandRoot,
        story: smokeStory,
        storyId: STORY_ID,
        changedFiles: ['packages/main/src/core/machine.ts'],
        processEvents: [
          ...verdictEvents,
          fallback(currentMaterial, { eligibility: 'explicit-human-approval', storyFilesHash: currentStoryFiles }),
        ],
        materialHash: currentMaterial,
        storyFilesHash: currentStoryFiles,
      });
      assert.equal(degraded.ok, true);
      assert.equal(degraded.assuranceLevel, 'degraded-single-host');
      assert.equal(degraded.localRounds.ok, false, 'three single-host rounds do not satisfy 3x2');
      assert.equal(degraded.authorityDone, false);
      assert.equal(degraded.fullAuthorityDone, false);
      assert.equal(degraded.productionDone, false);
      assert.equal(
        buildReviewAssuranceFloorGuidance(degraded).legalWriterPaths.reviewerHost
          .filter(recipe => recipe.command.includes('autopilot_review_submit')).length,
        0,
        're-evaluated guidance does not replay any persisted effective runId',
      );
    } finally {
      rmSync(commandRoot, { recursive: true, force: true });
      resetConfigCache();
    }
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
      } as HandlerContext, { authorizeNativeInvocation: () => {} });
      mkdirSync(dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, JSON.stringify({
        storyId: STORY_ID,
        mode: { runCommands: true },
        actual: { exitCode: 0 },
      }), 'utf8');
      const positiveOutput = deliveryHandlers.delivery_check_set({
        storyId: STORY_ID,
        docsPromises: [],
        realMachineTests: ['passing live-smoke transcript'],
        closingSelfCheck: {
          hasRealMachineTest: true,
          hasEdgeCaseCoverage: true,
          hasUnresolvedTodos: false,
          summary: 'Valid live-smoke transcript signs delivery evidence.',
        },
      });
      assert.match(positiveOutput, /Delivery check saved/, 'valid present passing transcript allows delivery signing');
      const positiveDeliveryCheck = store.readDeliveryCheck(STORY_ID);
      assert.ok(positiveDeliveryCheck, 'positive control writes delivery-check.json');
      assert.equal(
        positiveDeliveryCheck._hash,
        signDeliveryCheck(
          positiveDeliveryCheck.storyId,
          positiveDeliveryCheck.docsPromises,
          positiveDeliveryCheck.realMachineTests,
          positiveDeliveryCheck.closingSelfCheck,
          positiveDeliveryCheck.reviewRound,
          positiveDeliveryCheck.materialHash,
          positiveDeliveryCheck.storyFilesHash,
        ),
        'positive delivery-check has a valid signature',
      );
      const deliveryCheckPath = store.storyFilePath(STORY_ID, 'delivery-check.json');
      const positiveDeliveryBytes = readFileSync(deliveryCheckPath, 'utf8');
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
        assert.equal(
          readFileSync(deliveryCheckPath, 'utf8'),
          positiveDeliveryBytes,
          `${label} rejection must not partially overwrite delivery-check.json`,
        );
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
