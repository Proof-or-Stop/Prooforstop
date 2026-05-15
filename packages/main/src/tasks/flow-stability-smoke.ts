#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PHASE_TOOLS, getAllowedPatterns, isCommandAllowed, loadConfig, resetConfigCache } from '../core/config.js';
import { getCommandPolicyEntries, policyAllowedPhaseLabels } from '../core/command-policy.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsFromConfig,
  parseGitPorcelainRow,
} from '../core/dirty-worktree.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { signFinding, signReviewPass, verifyFinding, verifyReviewPass } from '../core/finding-verify.js';
import { autoCommitStoryMetadata, AUTO_COMMIT_METADATA_PREFIX } from '../core/auto-commit-metadata.js';
import { getArtifactContractStatus } from '../core/artifact-contract.js';
import { FLOW_FACT_POLICIES, isPassOnlyReviewFindingRecord } from '../core/flow-fact-policy.js';
import { runManagedAssetCheck } from '../core/managed-assets.js';
import {
  ACTIVE_LIFECYCLE_PHASES,
  COMMAND_LIFECYCLE_PHASES,
  CWD_GATED_LIFECYCLE_PHASES,
  LEGACY_LIFECYCLE_PHASE_ALIASES,
  LIFECYCLE_PHASES,
  LIFECYCLE_TRANSITIONS,
  PHASE_EVENT_BY_TARGET,
  TERMINAL_LIFECYCLE_PHASES,
  findLifecycleTransition,
  lifecycleForwardTransitionsByPhase,
} from '../core/lifecycle-registry.js';
import { getGuardFailureReason } from '../core/machine.js';
import { getProcessFactRegistryEntry, hasProcessFactSemantic, PROCESS_FACT_FLOW_POLICIES } from '../core/process-fact-registry.js';
import {
  ACTIVE_PHASE_ORDER,
  PHASE_ORDER,
  TERMINAL_PHASES,
  checkPhaseTransition,
  normalizeLegacyPhase,
} from '../core/phase-flow.js';
import { collectReviewerEvidenceState, signReviewRun } from '../core/review-run.js';
import { summarizeReviewerStatus } from '../core/reviewer-status.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, Finding, ReviewRun, StoryInfo, TestEvidenceData } from '../core/types.js';
import { CWD_GATED_PHASES, PHASE_TO_EVENT } from '../handlers/context.js';
import { buildDoneChecklist } from '../handlers/story-advance.js';
import { createStoryAdvanceHandlers } from '../handlers/story-advance.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { decorateResult } from '../handlers/hints.js';
import { createSessionHandlers } from '../handlers/session.js';
import { checkCommitAuthor } from '../handlers/validate-channel.js';
import { repairGlobalKoalaLinkBeforeWorktreeDelete } from '../handlers/worktree.js';

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function localCliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

function makeFinding(storyId: string, agent: string, reviewRound: string, idSuffix: string, reviewRunId: string): Finding {
  const id = `${storyId}:F-${idSuffix}`;
  const createdAt = `2026-04-27T12:00:${idSuffix}.000Z`;
  const desc = `${agent} clean finding`;
  const severity = 'low';
  return {
    id,
    desc,
    severity,
    category: 'happy',
    status: 'resolved',
    agent,
    createdAt,
    reviewRound,
    reviewRunId,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound, reviewRunId),
  };
}

function makeLegacyFindingWithoutRun(storyId: string, agent: string, reviewRound: string, idSuffix: string): Finding {
  const id = `${storyId}:F-${idSuffix}`;
  const createdAt = `2026-04-27T12:05:${idSuffix}.000Z`;
  const desc = `${agent} legacy finding without review run binding`;
  const severity = 'low';
  return {
    id,
    desc,
    severity,
    category: 'happy',
    status: 'resolved',
    agent,
    createdAt,
    reviewRound,
    _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
  };
}

function makeReviewPass(storyId: string, agent: string, reviewRound: string, idSuffix: string, reviewRunId: string) {
  const id = `${storyId}:RP-${idSuffix}`;
  const createdAt = `2026-04-27T12:10:${idSuffix}.000Z`;
  const note = `${agent} checked the story and found no blocking issue`;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    reviewRunId,
    _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound, reviewRunId),
  };
}

function makeLegacyReviewPassWithoutRun(storyId: string, agent: string, reviewRound: string, idSuffix: string) {
  const id = `${storyId}:RP-${idSuffix}`;
  const createdAt = `2026-04-27T12:20:${idSuffix}.000Z`;
  const note = `${agent} legacy pass without review run binding`;
  return {
    id,
    agent,
    note,
    createdAt,
    reviewRound,
    _hash: signReviewPass(storyId, id, agent, note, createdAt, reviewRound),
  };
}

function seedReviewRuns(root: string, store: StoryStore, storyId: string, reviewRound: string, agents: string[]): Map<string, string> {
  const headHash = currentGitHead(root) || `head-${reviewRound}`;
  const materialHash = currentMaterialHash(root) || `material-${reviewRound}`;
  const runs: ReviewRun[] = agents.map((agent, index) => {
    const reviewRunId = `${storyId}:RR-${String(index + 1).padStart(3, '0')}`;
    const startedAt = `2026-04-27T11:${String(index).padStart(2, '0')}:00.000Z`;
    return {
      reviewRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      promptHash: '',
      _hash: signReviewRun(storyId, reviewRunId, agent, agent, reviewRound, startedAt, headHash, materialHash, ''),
    };
  });
  store.writeReviewRuns(storyId, { runs });
  return new Map(runs.map((run) => [run.agent, run.reviewRunId]));
}

function createReviewStore(root: string): { store: StoryStore; storyId: string; reviewRound: string } {
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
  }));
  resetConfigCache();

  const store = new StoryStore(root);
  const storyId = 'B-smoke';
  const now = '2026-04-27T12:00:00.000Z';
  const reviewRound = '2026-04-27T12:01:00.000Z';
  const story: StoryInfo = {
    storyId,
    name: 'flow-stability-smoke',
    title: 'Flow stability smoke',
    description: 'Synthetic story for REVIEW gate smoke coverage.',
    type: 'chore',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  const checklist: ChecklistData = {
    items: ['001', '002', '003'].map((suffix) => ({
      id: `CHK-${suffix}`,
      title: `Done item ${suffix}`,
      context: 'Synthetic checklist item.',
      status: 'done',
      startTime: now,
      endTime: now,
    })),
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeUnderstanding(storyId, {
    task: 'Check review gate',
    outcome: 'Review gate reports opt-in reviewers',
    facts: [],
    constraints: [],
    unknowns: [],
    touchpoints: ['packages/main/src/core/machine.ts'],
    timestamp: now,
  });
  store.writeDecision(storyId, {
    principles: ['keep gates explicit', 'reuse reviewer routing', 'avoid fixture state leakage'],
    drivers: ['normal channel smoke coverage'],
    options: [
      { name: 'A: shared reviewer routing', pros: ['matches reviewer_list'], cons: ['requires signed fixtures'] },
      { name: 'B: local copy', pros: ['simple'], cons: ['drifts from reviewer_list'] },
    ],
    chosen: 'A: shared reviewer routing',
    rationale: 'normal channel requires multiple real options in the smoke fixture',
    timestamp: now,
  });
  return { store, storyId, reviewRound };
}

function assertDirtyWorktreeClassifierGroupsOwnership(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-dirty-classifier-'));
  try {
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const rename = parseGitPorcelainRow('R  packages/main/src/old.ts -> ./packages/main/src/new.ts');
    assert.equal(rename?.statusCode, 'R ');
    assert.equal(rename?.rawPath, './packages/main/src/new.ts');
    assert.equal(rename?.path, 'packages/main/src/new.ts');
    assert.equal(rename?.originalPath, 'packages/main/src/old.ts');

    const classification = classifyGitStatusRows([
      ' M .koala/story/actives/B-smoke/checklist.json',
      '?? .koala/activity.jsonl',
      ' M package.json',
      ' D koala.config.json',
      'R  packages/main/src/old.ts -> ./packages/main/src/new.ts',
      '?? packages/main/tests/fixtures/dirty-owner.json',
      '?? packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json',
    ], dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)));

    assert.equal(classification.total, 7);
    assert.equal(classification.groups.koala_metadata_changes.length, 1);
    assert.equal(classification.groups.runtime_artifact_changes.length, 1);
    assert.equal(classification.groups.declared_artifact_changes.length, 0, 'undeclared artifact extension point should stay empty by default');
    assert.equal(classification.groups.material_source_changes.length, 3);
    assert.equal(classification.groups.fixture_changes.length, 1);
    assert.equal(classification.groups.unexpected_dirty_files.length, 1);
    assert.equal(classification.groups.unexpected_dirty_files[0].path, 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json');
    assert.equal(classification.groups.runtime_artifact_changes[0].raw, '?? .koala/activity.jsonl');
    assert.equal(classification.groups.runtime_artifact_changes[0].statusCode, '??');
    assert.equal(classification.groups.runtime_artifact_changes[0].rawPath, '.koala/activity.jsonl');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDispatchPromptsPinImplementerCommitAuthor(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-dispatch-author-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const dispatch = createStoryDispatchHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const expectedAuthor = /git commit --author="koala-implementer <koala-implementer@noreply\.local>"/;

    const itemPrompt = dispatch.dispatch({ storyId, itemId: 'CHK-001' }).prompt;
    assert.match(itemPrompt, expectedAuthor);
    assert.match(itemPrompt, /normal-channel author fallback/);

    store.writeFindings(storyId, {
      findings: [makeFinding(storyId, 'koala-review-quality', reviewRound, '070', 'RR-smoke')],
    });
    const findingPrompt = dispatch.dispatch({ storyId, findingId: 'F-070' }).prompt;
    assert.match(findingPrompt, expectedAuthor);
    assert.match(findingPrompt, /normal-channel author fallback/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSessionBriefGate(): void {
  for (const phase of ['INIT', 'INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE']) {
    assert.equal(isCommandAllowed('session_brief', phase), true, `session_brief should be allowed in ${phase}`);
    assert.equal(isCommandAllowed('next', phase), true, `next should be allowed in ${phase}`);
    assert.equal(
      isCommandAllowed('session_brief', phase, { '*': [], [phase]: [] }),
      true,
      `session_brief should bypass custom phase tools in ${phase}`,
    );
    assert.equal(
      isCommandAllowed('next', phase, { '*': [], [phase]: [] }),
      true,
      `next should bypass custom phase tools in ${phase}`,
    );
  }

  assert.equal(isCommandAllowed('finding_add', 'DEV'), true, 'DEV reviewers should be able to register findings');
  assert.equal(isCommandAllowed('review_pass_set', 'DEV'), false, 'DEV must not accept REVIEW no-blocker receipts');
  assert.equal(isCommandAllowed('review_run_start', 'REVIEW'), true, 'REVIEW reviewers should be able to start signed review runs');
  assert.equal(isCommandAllowed('review_run_start', 'DEV'), false, 'review_run_start should stay REVIEW-only');
  assert.equal(
    isCommandAllowed('finding_dispatch', 'DEV'),
    true,
    'DEV implementers should be able to dispatch finding fixes',
  );
  assert.equal(
    isCommandAllowed('finding_cluster', 'DEV'),
    true,
    'DEV stories with reviewer findings should be able to cluster before dispatch',
  );
  assert.equal(isCommandAllowed('finding_cluster', 'REVIEW'), true, 'REVIEW should still allow finding clustering');
  assert.equal(isCommandAllowed('finding_cluster', 'TEST'), true, 'TEST should still allow finding clustering');
  assert.equal(
    isCommandAllowed('bug_report', 'DEV'),
    false,
    'finding_cluster in DEV must not broaden unrelated TEST/REVIEW commands',
  );
  assert.equal(
    isCommandAllowed('test_auto', 'REVIEW', { REVIEW: ['test_auto'] }),
    false,
    'custom phase tools must not widen legacy rootOnly commands into REVIEW',
  );
  assert.equal(
    isCommandAllowed('bug_report', 'DEV', null as any),
    false,
    'malformed phaseTools must still respect command policy disallowing bug_report in DEV',
  );
  assert.equal(
    isCommandAllowed('test_auto', 'REVIEW', null as any),
    false,
    'malformed phaseTools must not allow legacy rootOnly commands with no active producer phase',
  );
  assert.equal(
    isCommandAllowed('validate', 'DEV', null as any),
    true,
    'malformed phaseTools should fall back to the lifecycle policy ceiling for policy-approved commands',
  );
  assert.equal(
    getAllowedPatterns('REVIEW', { REVIEW: ['test_auto', 'finding_add'] }).includes('test_auto'),
    false,
    'allowed pattern display must filter commands blocked by lifecycle policy',
  );
  assert.equal(
    getAllowedPatterns('REVIEW', { REVIEW: ['test_auto', 'finding_add'] }).includes('finding_add'),
    true,
    'allowed pattern display should keep policy-approved custom commands',
  );
  assert.equal(
    isCommandAllowed('finding_add', 'DEV', { '*': ['status'], DEV: ['checklist_get'] }),
    false,
    'custom phase tools should still reject unrelated mutation commands',
  );
  assert.equal(
    isCommandAllowed('finding_cluster', 'DEV', { '*': ['status'], DEV: ['finding_add', 'finding_dispatch'] }),
    false,
    'custom phase tools should still be able to override DEV finding_cluster availability',
  );
}

function assertFlowFactPolicyRegistry(): void {
  const flowPolicyNames = FLOW_FACT_POLICIES.map(policy => policy.name).sort();
  assert.deepEqual(
    PROCESS_FACT_FLOW_POLICIES.map(policy => policy.name).sort(),
    flowPolicyNames,
    'process fact registry should be built from the centralized flow fact policy table',
  );

  const reviewPass = getProcessFactRegistryEntry('flow-policy:review-pass');
  assert.equal(reviewPass?.kind, 'flow-policy');
  assert.equal(reviewPass?.artifact?.path, 'review-passes.json');
  assert.equal(reviewPass?.consumerGate, 'storyMachine.canPassReview REVIEW to TEST gate');
  assert.equal(hasProcessFactSemantic('flow-policy:review-pass', 'review-pass'), true);

  const reviewRunBoundary = getProcessFactRegistryEntry('flow-policy:review-run-boundary');
  assert.equal(reviewRunBoundary?.kind, 'flow-policy');
  assert.equal(reviewRunBoundary?.artifact?.path, 'review-runs.json');
  assert.equal(hasProcessFactSemantic('flow-policy:review-run-boundary', 'review-run'), true);

  const finding = getProcessFactRegistryEntry('flow-policy:finding');
  assert.equal(finding?.kind, 'flow-policy');
  assert.equal(finding?.artifact?.path, 'findings.json');
  assert.equal(hasProcessFactSemantic('flow-policy:finding', 'finding-state'), true);

  const passOnly = getProcessFactRegistryEntry('flow-policy:pass-only-normalization');
  assert.equal(passOnly?.kind, 'flow-policy');
  assert.equal(passOnly?.artifact?.path, 'review-passes.json');
  assert.equal(hasProcessFactSemantic('flow-policy:pass-only-normalization', 'normalization-policy'), true);

  const reviewRound = getProcessFactRegistryEntry('flow-policy:review-round-iso-string');
  assert.equal(reviewRound?.kind, 'flow-policy');
  assert.equal(hasProcessFactSemantic('flow-policy:review-round-iso-string', 'schema-contract'), true);

  const express = getProcessFactRegistryEntry('flow-policy:express-verification-policy');
  assert.equal(express?.kind, 'flow-policy');
  assert.equal(hasProcessFactSemantic('flow-policy:express-verification-policy', 'verification-policy'), true);

  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS: docs consistency check PASSED.',
      severity: 'low',
      agent: 'koala-review-docs',
    }),
    true,
    'low-severity reviewer pass-only finding should normalize to review pass',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS but README command failed.',
      severity: 'low',
      agent: 'koala-review-docs',
    }),
    false,
    'ambiguous pass plus failure text must remain a real finding',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS: docs consistency check PASSED.',
      severity: 'medium',
      agent: 'koala-review-docs',
    }),
    false,
    'non-low pass-like finding must not normalize to review pass',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'No findings after review.',
      severity: 'low',
      agent: 'main',
    }),
    false,
    'non-reviewer pass-like finding must not normalize to review pass',
  );
}

function createActiveStoryRoot(phase: StoryInfo['phase'], configPatch: Record<string, unknown> = {}): { root: string; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-command-policy-'));
  const { store, storyId } = createReviewStore(root);
  const config = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    ...configPatch,
  };
  write(root, 'koala.config.json', JSON.stringify(config));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'koala@example.test']);
  git(root, ['config', 'user.name', 'Koala Smoke']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', `story/${storyId}`]);
  const story = store.readStory(storyId);
  story.phase = phase;
  store.writeStory(storyId, story);
  return { root, storyId };
}

function runBlockedCli(root: string, args: string[]): string {
  try {
    execFileSync('node', [localCliPath(), ...args], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    assert.notEqual(error.status, 0, `${args.join(' ')} should fail`);
    return `${error.stdout || ''}${error.stderr || ''}`;
  }
  assert.fail(`${args.join(' ')} should have been blocked by phase gate`);
}

function assertPhaseGatePolicyHints(): void {
  const supported = createActiveStoryRoot('DEV');
  try {
    const output = runBlockedCli(supported.root, ['bug_report']);
    assert.match(output, /命令 "bug_report" 在 DEV 阶段不可用/);
    assert.match(output, /Lifecycle: supported/);
    assert.match(output, /Requested phase: DEV/);
    assert.match(output, /Allowed phases: REVIEW, TEST/);
    assert.match(output, /Reason: Bug records are REVIEW\/TEST feedback artifacts/);
    assert.match(output, /Policy source: packages\/main\/src\/core\/command-policy\.ts/);
  } finally {
    rmSync(supported.root, { recursive: true, force: true });
  }

  const legacy = createActiveStoryRoot('DEV');
  try {
    const output = runBlockedCli(legacy.root, ['test_auto']);
    assert.match(output, /Lifecycle: legacy/);
    assert.match(output, /Requested phase: DEV/);
    assert.match(output, /Allowed phases: root-only/);
    assert.match(output, /Replacement: .*koala validate --story=<storyId>/);
    assert.match(output, /verificationEvidence/);
    assert.match(output, /Destructive risk: workspace-destructive/);
    assert.match(output, /confirm/);
  } finally {
    rmSync(legacy.root, { recursive: true, force: true });
  }
}

function assertPhaseToolsOverrideStillBlocks(): void {
  const override = createActiveStoryRoot('DEV', {
    phaseTools: {
      '*': ['session_brief'],
      DEV: ['status'],
    },
  });
  try {
    const output = runBlockedCli(override.root, ['finding_add']);
    assert.match(output, /命令 "finding_add" 在 DEV 阶段不可用/);
    assert.match(output, /Lifecycle: gateEvidence/);
    assert.match(output, /Requested phase: DEV/);
    assert.match(output, /Allowed phases: DEV, REVIEW/);
    assert.match(output, /Current phaseTools allow: session_brief, next, status/);
  } finally {
    rmSync(override.root, { recursive: true, force: true });
  }
}

function patternMatchesCommand(pattern: string, command: string): boolean {
  if (pattern.endsWith('*')) return command.startsWith(pattern.slice(0, -1));
  return command === pattern;
}

function assertLifecycleRegistryConsistency(): void {
  assert.deepEqual(
    ACTIVE_PHASE_ORDER,
    ACTIVE_LIFECYCLE_PHASES,
    'Lifecycle registry mismatch: ACTIVE_PHASE_ORDER should mirror ACTIVE_LIFECYCLE_PHASES',
  );
  assert.deepEqual(
    TERMINAL_PHASES,
    TERMINAL_LIFECYCLE_PHASES,
    'Lifecycle registry mismatch: TERMINAL_PHASES should mirror TERMINAL_LIFECYCLE_PHASES',
  );
  assert.deepEqual(
    PHASE_ORDER,
    LIFECYCLE_PHASES,
    'Lifecycle registry mismatch: PHASE_ORDER should mirror LIFECYCLE_PHASES',
  );
  assert.deepEqual(
    [...CWD_GATED_PHASES],
    CWD_GATED_LIFECYCLE_PHASES,
    'Lifecycle registry mismatch: CWD_GATED_PHASES should mirror CWD_GATED_LIFECYCLE_PHASES',
  );
  assert.deepEqual(
    PHASE_TO_EVENT,
    PHASE_EVENT_BY_TARGET,
    'Lifecycle registry mismatch: PHASE_TO_EVENT should mirror PHASE_EVENT_BY_TARGET',
  );

  for (const [legacy, current] of Object.entries(LEGACY_LIFECYCLE_PHASE_ALIASES)) {
    assert.equal(
      normalizeLegacyPhase(legacy),
      current,
      `Lifecycle registry mismatch: legacy alias ${legacy} should normalize to ${current}`,
    );
  }

  const transitionProjection = lifecycleForwardTransitionsByPhase();
  for (const transition of LIFECYCLE_TRANSITIONS) {
    const health = checkPhaseTransition(transition.from, transition.to);
    assert.equal(
      health.ok,
      true,
      `Lifecycle registry mismatch: transition ${transition.from}->${transition.to} must be allowed by phase-flow`,
    );
    assert.equal(
      health.kind,
      transition.kind,
      `Lifecycle registry mismatch: transition ${transition.from}->${transition.to} kind expected ${transition.kind}`,
    );
    assert.ok(
      findLifecycleTransition(transition.from, transition.to),
      `Lifecycle registry mismatch: findLifecycleTransition should return ${transition.from}->${transition.to}`,
    );
    assert.ok(
      transitionProjection[transition.from].includes(transition.to),
      `Lifecycle registry mismatch: transition projection missing ${transition.from}->${transition.to}`,
    );
  }

  const commandPhases = new Set(COMMAND_LIFECYCLE_PHASES);
  for (const [command, policy] of getCommandPolicyEntries()) {
    for (const phase of policyAllowedPhaseLabels(policy)) {
      assert.ok(
        commandPhases.has(phase as any),
        `Lifecycle registry mismatch: COMMAND_POLICIES.${command} allows unknown phase ${phase}`,
      );
    }
  }

  const policyEntries = getCommandPolicyEntries();
  const knownCommands = new Set(policyEntries.map(([command]) => command));
  for (const [phase, patterns] of Object.entries(DEFAULT_PHASE_TOOLS)) {
    assert.ok(
      phase === '*' || commandPhases.has(phase as any),
      `Lifecycle registry mismatch: DEFAULT_PHASE_TOOLS has unknown phase ${phase}`,
    );
    for (const pattern of patterns) {
      const matchingCommands = pattern.endsWith('*')
        ? policyEntries.map(([command]) => command).filter(command => patternMatchesCommand(pattern, command))
        : (knownCommands.has(pattern as any) ? [pattern] : []);
      assert.ok(
        matchingCommands.length > 0,
        `Lifecycle registry mismatch: DEFAULT_PHASE_TOOLS.${phase} pattern ${pattern} has no command policy entry`,
      );
      if (phase === '*') continue;
      for (const command of matchingCommands) {
        const policy = policyEntries.find(([name]) => name === command)?.[1];
        assert.ok(policy, `Lifecycle registry mismatch: missing policy for ${command}`);
        assert.ok(
          policyAllowedPhaseLabels(policy).includes(phase),
          `Lifecycle registry mismatch: DEFAULT_PHASE_TOOLS.${phase} allows ${command} but COMMAND_POLICIES does not`,
        );
      }
    }
  }
}

function assertStoryAdvanceTestGateFailClosedContracts(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = readFileSync(join(root, 'src', 'handlers', 'story-advance.ts'), 'utf-8');
  assert.match(
    source,
    /Cannot enter TEST: CLI gate preflight 执行异常/,
    'REVIEW->TEST preflight infrastructure errors must be fail-closed',
  );
  assert.match(
    source,
    /Cannot enter TEST: koala validate 执行异常/,
    'validate execution errors must be fail-closed before entering TEST',
  );
  assert.doesNotMatch(
    source,
    /CLI gate preflight 自身错误（不阻塞推进）|validate 执行失败（不阻塞推进）/,
    'TEST gate infrastructure errors must not use the old warn-and-advance path',
  );
}

function assertManagedAssetExpandedDocsAndTrueDrift(): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = resolve(packageRoot, '..', '..');
  const current = runManagedAssetCheck(repoRoot, { profile: 'all' });
  const currentById = new Map(current.items.map(item => [item.id, item]));
  for (const id of ['doc:KOALA.md', 'doc:AGENTS.md', 'doc:CLAUDE.md']) {
    assert.equal(
      currentById.get(id)?.status,
      'OK',
      `managed asset drift check should accept expanded local guide ${id}`,
    );
  }

  const badRoot = mkdtempSync(join(tmpdir(), 'koala-managed-drift-'));
  try {
    const badSection = '<!-- koala:start -->\n# Locally edited guide\nThis is not a Koala-owned alternate contract.\n<!-- koala:end -->\n';
    write(badRoot, 'KOALA.md', badSection);
    write(badRoot, 'AGENTS.md', badSection);
    write(badRoot, 'CLAUDE.md', badSection);
    const drift = runManagedAssetCheck(badRoot, { profile: 'all' });
    const driftById = new Map(drift.items.map(item => [item.id, item]));
    for (const id of ['doc:KOALA.md', 'doc:AGENTS.md', 'doc:CLAUDE.md']) {
      assert.equal(
        driftById.get(id)?.status,
        'STALE_LOCAL_EDIT',
        `managed asset drift check must still flag true local drift for ${id}`,
      );
    }
  } finally {
    rmSync(badRoot, { recursive: true, force: true });
  }
}

function assertReviewGateUsesOptIn(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-docs',
      'koala-review-test-coverage',
    ]);
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '001', runIds.get('koala-review-concept')!),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '002', runIds.get('koala-review-quality')!),
        makeFinding(storyId, 'koala-review-docs', reviewRound, '003', runIds.get('koala-review-docs')!),
      ],
    });

    const missing = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missing ?? '', /期望 3 个 reviewer（opt-in: concept,quality,test-coverage）/);
    assert.match(missing ?? '', /缺: test-coverage/);
    assert.match(missing ?? '', /koala-review-docs/);
    assert.doesNotMatch(missing ?? '', /全部 5 个 reviewer/);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '004', runIds.get('koala-review-concept')!),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '005', runIds.get('koala-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '006', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const pass = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.equal(pass, null);

    const status = summarizeReviewerStatus(store, storyId, root);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('test-coverage')?.verdict, 'pass');
    assert.equal(byName.has('channel'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertReviewRunBindingRejectsInvalidEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-run-binding-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const agents = [
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
    ];
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, agents);

    const retrofittedLegacyFinding = {
      ...makeLegacyFindingWithoutRun(storyId, 'koala-review-quality', reviewRound, '045'),
      reviewRunId: runIds.get('koala-review-quality')!,
    };
    const retrofittedLegacyPass = {
      ...makeLegacyReviewPassWithoutRun(storyId, 'koala-review-quality', reviewRound, '046'),
      reviewRunId: runIds.get('koala-review-quality')!,
    };
    assert.equal(
      verifyFinding(storyId, retrofittedLegacyFinding),
      false,
      'retrofitting reviewRunId onto a legacy-signed finding must invalidate the signature',
    );
    assert.equal(
      verifyReviewPass(storyId, retrofittedLegacyPass),
      false,
      'retrofitting reviewRunId onto a legacy-signed review pass must invalidate the signature',
    );
    store.writeFindings(storyId, { findings: [retrofittedLegacyFinding] });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '047', runIds.get('koala-review-concept')!),
        retrofittedLegacyPass,
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '048', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const retrofitState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      retrofitState.invalid.some(issue => issue.code === 'invalid_evidence_signature' && issue.agent === 'koala-review-quality'),
      true,
      'review-run evidence collection must reject reviewRunId-retrofitted legacy signatures',
    );
    const retrofitFailure = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(retrofitFailure ?? '', /签名无效|reviewRunId/, 'review gate must fail retrofitted legacy signatures');
    store.writeFindings(storyId, { findings: [] });

    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '050', runIds.get('koala-review-concept')!),
        makeLegacyReviewPassWithoutRun(storyId, 'koala-review-quality', reviewRound, '051'),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '052', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const missingRun = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missingRun ?? '', /缺少 reviewRunId/, 'current REVIEW evidence without reviewRunId must be rejected');
    const missingRunStatus = summarizeReviewerStatus(store, storyId, root);
    const missingRunByName = new Map(missingRunStatus.entries.map(e => [e.name, e]));
    const qualityStatus = missingRunByName.get('quality');
    assert.equal(qualityStatus?.present, true, 'invalid reviewer evidence should count as present evidence');
    assert.equal(qualityStatus?.verdict, 'fail', 'invalid reviewer evidence must not be shown as pending');
    assert.equal(qualityStatus?.blockerCount, 1, 'invalid reviewer evidence should count as a blocking reviewer issue');
    assert.match(qualityStatus?.detail ?? '', /缺少 reviewRunId/);
    assert.equal(missingRunStatus.totalBlockers, 1, 'invalid reviewer evidence should surface in totalBlockers');
    assert.equal(missingRunStatus.allPassed, false);

    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '053', runIds.get('koala-review-concept')!),
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '054', runIds.get('koala-review-concept')!),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '055', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const wrongLane = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(wrongLane ?? '', /lane=koala-review-concept/, 'evidence bound to a different reviewer lane must be rejected');

    const runs = store.readReviewRuns(storyId);
    runs.runs[1]._hash = 'tampered-review-run-signature';
    store.writeReviewRuns(storyId, runs);
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '056', runIds.get('koala-review-concept')!),
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '057', runIds.get('koala-review-quality')!),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '058', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const tamperedRun = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(tamperedRun ?? '', /签名无效|被篡改/, 'tampered review-runs.json signature must be rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-legacy-review-evidence-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const story = store.readStory(storyId);
    delete story.currentReviewRound;
    store.writeStory(storyId, story);
    store.writeReviewPasses(storyId, {
      passes: [makeLegacyReviewPassWithoutRun(storyId, 'koala-review-quality', reviewRound, '060')],
    });

    const evidenceState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(evidenceState.invalid.length, 0, 'legacy story without currentReviewRound should not require reviewRunId');
    assert.equal(evidenceState.valid.length, 1, 'legacy signed review pass should remain readable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStoryAdvanceReviewEchoOmitsRetiredChannel(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-echo-'));
  const oldCwd = process.cwd();
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    story.currentReviewRound = undefined;
    store.writeStory(storyId, story);

    process.chdir(root);
    const output = await createStoryAdvanceHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).story_advance({ storyId, phase: 'REVIEW' });

    assert.match(output, /Active reviewers: concept, quality, test-coverage/);
    assert.doesNotMatch(output, /koala-review-channel/);
    assert.doesNotMatch(output, /channel \(normal channel\)/);
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertReviewerStatusUsesMdFallback(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-doc-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    store.writeUnderstanding(storyId, {
      task: 'Check review gate',
      outcome: 'Review gate reports git-detected docs reviewers',
      facts: [],
      constraints: [],
      unknowns: [],
      timestamp: '2026-04-27T12:00:00.000Z',
    } as any);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'docs/review-notes.md', '# Review notes\n\nDocs changed in story branch.\n');
    git(root, ['add', 'docs/review-notes.md']);
    git(root, ['commit', '-m', 'docs change']);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
    ]);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'koala-review-concept', reviewRound, '010', runIds.get('koala-review-concept')!),
        makeFinding(storyId, 'koala-review-quality', reviewRound, '011', runIds.get('koala-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '012', runIds.get('koala-review-test-coverage')!),
      ],
    });

    const status = summarizeReviewerStatus(store, storyId, root);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('docs')?.verdict, 'pending', 'reviewer status should include docs from git diff fallback');

    const reviewBrief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({ concise: true });
    assert.match(reviewBrief, /\[pending\] docs/i);
    assert.match(reviewBrief, /review_run_start/, 'REVIEW anti-stall should tell reviewers to start a signed review run');
    assert.match(reviewBrief, /reviewRunId/, 'REVIEW anti-stall should mention the returned reviewRunId');
    assert.match(reviewBrief, /review_pass_set/, 'REVIEW anti-stall should still explain no-blocker pass evidence');
    assert.match(reviewBrief, /<reviewRunId from review_run_start>/, 'REVIEW anti-stall should not imply a hard-coded reviewRunId');
    assert.doesNotMatch(reviewBrief, /:RR-001/, 'REVIEW anti-stall must not hard-code a synthetic reviewRunId');

    const contract = getArtifactContractStatus(store, storyId, 'TEST', { projectRoot: root });
    const findingsClear = contract.entries.find(entry => entry.name === 'findings-clear');
    assert.equal(findingsClear?.present, false, 'artifact contract should use the same docs reviewer fallback as status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSessionBriefStatusHintsMatchGates(): void {
  const reviewRoot = mkdtempSync(join(tmpdir(), 'koala-flow-session-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(reviewRoot);
    git(reviewRoot, ['init']);
    git(reviewRoot, ['config', 'user.email', 'koala@example.test']);
    git(reviewRoot, ['config', 'user.name', 'Koala Smoke']);
    git(reviewRoot, ['checkout', '-B', 'main']);
    git(reviewRoot, ['add', '.']);
    git(reviewRoot, ['commit', '-m', 'base']);
    git(reviewRoot, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(reviewRoot, store, storyId, reviewRound, [
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
    ]);
    store.writeReview(storyId, {
      reviews: [{
        timestamp: reviewRound,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '020', runIds.get('koala-review-concept')!),
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '021', runIds.get('koala-review-quality')!),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '022', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const reviewBrief = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).session_brief({ concise: true });
    const reviewNext = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).next({ concise: true });
    assert.doesNotMatch(reviewBrief, /REVIEW blocked by unresolved findings/);
    assert.match(reviewNext, /reviewer gate 全部通过/);
    assert.match(reviewNext, /phase=TEST/);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    const evidence: TestEvidenceData = {
      command: 'koala validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-04-27T12:20:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);
    const testBrief = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).session_brief({ concise: true });
    const nextStep = createSessionHandlers({
      store,
      root: reviewRoot,
      scanRoot: join(reviewRoot, 'packages/main'),
    }).next({ concise: true });
    assert.match(testBrief, /\[FAIL\] delivery-check/);
    assert.match(testBrief, /\[FAIL\] Story summary/);
    assert.match(testBrief, /DONE pre-check 还有/);
    assert.match(testBrief, /先处理这些 dirty path/);
    assert.match(testBrief, /koala_metadata_changes/);
    assert.match(testBrief, /KOALA_WRITE_\*_REPORT|默认无副作用/);
    assert.match(testBrief, /delivery_check_set/);
    assert.match(testBrief, /summary_set/);
    assert.match(nextStep, /git-working-tree, delivery-check, story-summary/);
    assert.match(nextStep, /全部通过后再 story_advance --phase=DONE/);
    assert.match(testBrief, /全部通过后再 story_advance --phase=DONE/);
    assert.doesNotMatch(testBrief, /下一步：story_advance --storyId=B-smoke --phase=DONE/);
    assert.doesNotMatch(testBrief, /下一步：先 git add \+ git commit 提交所有改动，再 advance DONE/);
  } finally {
    rmSync(reviewRoot, { recursive: true, force: true });
  }
}

function assertReviewNextUsesReviewerGateState(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-review-next-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
    ]);

    const handlers = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const pendingNext = handlers.next({ concise: true });
    assert.match(pendingNext, /等待 reviewer evidence/);
    assert.match(pendingNext, /story-review/);
    assert.match(pendingNext, /concept/);
    assert.match(pendingNext, /quality/);
    assert.match(pendingNext, /test-coverage/);
    assert.doesNotMatch(pendingNext, /channel/);
    assert.doesNotMatch(pendingNext, /critical\/high finding 全部 resolved/);

    const id = `${storyId}:F-open`;
    const createdAt = '2026-04-27T12:30:00.000Z';
    const desc = 'concept blocking issue';
    const severity = 'high';
    store.writeReview(storyId, {
      reviews: [{
        timestamp: reviewRound,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
      }],
    });
    store.writeFindings(storyId, {
      findings: [{
        id,
        desc,
        severity,
        category: 'happy',
        status: 'open',
        agent: 'koala-review-concept',
        createdAt,
        reviewRound,
        reviewRunId: runIds.get('koala-review-concept')!,
        _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound, runIds.get('koala-review-concept')!),
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '041', runIds.get('koala-review-quality')!),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '042', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const blockerNext = handlers.next({ concise: true });
    assert.match(blockerNext, /1 个 blocking finding/);
    assert.match(blockerNext, /concept\(1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDevGuidanceUsesReviewPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-dev-guidance-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    store.writeStory(storyId, story);

    const brief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({ concise: true });
    assert.match(brief, /phase=REVIEW/);
    assert.doesNotMatch(brief, /phase=TEST 进入验证/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertValidateHintsFollowStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-validate-hint-'));
  try {
    const { store, storyId } = createReviewStore(root);
    const result = JSON.stringify({ provider: 'koala-verifier', allPass: true });
    const render = (phase: StoryInfo['phase']) => {
      const story = store.readStory(storyId);
      story.phase = phase;
      store.writeStory(storyId, story);
      return String(decorateResult({
        cmd: 'validate',
        args: { story: storyId },
        result,
        store,
        root,
        activeStory: { storyId, phase },
      }));
    };

    const devHint = render('DEV');
    assert.match(devHint, /phase=REVIEW/);
    assert.doesNotMatch(devHint, /phase=DONE/);
    assert.doesNotMatch(devHint, /phase=TEST/);

    const reviewHint = render('REVIEW');
    assert.match(reviewHint, /phase=TEST/);
    assert.doesNotMatch(reviewHint, /phase=DONE/);

    const testHint = render('TEST');
    assert.match(testHint, /DONE pre-check/);
    assert.match(testHint, /phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertRealCliValidateHintFollowsActiveStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-real-cli-validate-'));
  try {
    const { store, storyId } = createReviewStore(root);
    write(root, 'validate-smoke.js', 'console.log(JSON.stringify({ provider: "smoke", status: "pass", allPass: true, summary: "ok", details: [] }));\n');
    write(root, 'koala.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.koala/story/actives',
      requirementsDir: 'docs/requirements',
      validate: { command: 'node validate-smoke.js' },
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    store.writeStory(storyId, story);

    const output = execFileSync('node', [localCliPath(), 'validate', '--json'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(output, /phase=REVIEW/);
    assert.doesNotMatch(output, /phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertBugUpdateTestHintUsesDonePrecheck(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-bug-hint-'));
  try {
    const { store, storyId } = createReviewStore(root);
    const story = store.readStory(storyId);
    story.phase = 'TEST';
    store.writeStory(storyId, story);
    store.writeBugs(storyId, {
      bugs: [{
        id: 'BUG-001',
        title: 'last test bug',
        status: 'fixed',
        foundAt: '2026-04-27T12:00:00.000Z',
        fixedAt: '2026-04-27T12:30:00.000Z',
      }],
    });

    const output = String(decorateResult({
      cmd: 'bug_update',
      args: { storyId, id: 'BUG-001', status: 'fixed' },
      result: 'Bug BUG-001 updated to fixed',
      store,
      root,
      activeStory: { storyId, phase: 'TEST' },
    }));
    assert.match(output, /DONE pre-check/);
    assert.match(output, /phase=DONE/);
    assert.doesNotMatch(output, /下一步：story_advance --storyId=.*--phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateRejectsKoalaSubjectForRealFiles(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=main-agent',
      '-c', 'user.email=main@example.test',
      'commit',
      '-m', 'koala: implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /缺 dispatch\/subagent_result 证据/);
    assert.match(result.summary, /不能作为 author fallback/);
    assert.match(result.details.join('\n'), /koala: implement real code/);
    assert.match(result.details.join('\n'), /正常通道主证据必须是 dispatch\/subagent_result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-shared-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=main-agent',
      '-c', 'user.email=main@example.test',
      'commit',
      '-m', 'implement real code through dispatched worker',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'subagent_result');
    assert.match(result.summary, /结构化证据覆盖完整/);
    assert.match(result.details.join('\n'), /commit author advisory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsImplementerAuthorWithoutDispatch(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-author-fallback-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=koala-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'commit_author');
    assert.match(result.summary, /commit author 作为直派执行证据/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsSuccessfulSubagentResultEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-subagent-evidence-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=koala-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'subagent_result',
        checklistId: `CHK-${suffix}`,
        success: true,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'subagent_result');
    assert.match(renderedDetails(result), /已覆盖: CHK-001, CHK-002, CHK-003/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsDispatchEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-channel-dispatch-evidence-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=koala-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);
    for (const suffix of ['001', '002', '003']) {
      store.appendProcessEvent(storyId, {
        type: 'dispatch',
        checklistId: `CHK-${suffix}`,
      });
    }

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'dispatch');
    assert.match(renderedDetails(result), /已覆盖: CHK-001, CHK-002, CHK-003/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function renderedDetails(result: { details: string[] }): string {
  return result.details.join('\n');
}

function assertDoneChecklistUsesStableOracleRows(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-oracle-row-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'koala@example.test']);
    git(root, ['config', 'user.name', 'Koala Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'koala-review-concept',
      'koala-review-quality',
      'koala-review-test-coverage',
    ]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    store.writeReview(storyId, {
      reviews: [{
        timestamp: reviewRound,
        issueCount: 0,
        blockerCount: 0,
        issues: [],
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'koala-review-concept', reviewRound, '030', runIds.get('koala-review-concept')!),
        makeReviewPass(storyId, 'koala-review-quality', reviewRound, '031', runIds.get('koala-review-quality')!),
        makeReviewPass(storyId, 'koala-review-test-coverage', reviewRound, '032', runIds.get('koala-review-test-coverage')!),
      ],
    });
    const evidence: TestEvidenceData = {
      command: 'koala validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-04-27T12:25:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);
    write(root, 'packages/main/src/core/dirty.ts', 'export const dirty = true;\n');
    write(root, '.koala/activity.jsonl', '{"event":"runtime"}\n');
    write(root, '.koala/story/actives/B-smoke/dirty-owner.json', '{}\n');
    write(root, 'packages/main/tests/fixtures/dirty-owner.json', '{}\n');
    write(root, 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json', '{}\n');

    const rows = buildDoneChecklist(storyId, store, root);
    const byId = new Map(rows.map(row => [row.id, row]));
    assert.deepEqual(
      ['id', 'status', 'detail', 'hint', 'source', 'blocking'].every(key => key in (byId.get('delivery-check') ?? {})),
      true,
      'delivery-check row should expose the stable oracle contract',
    );
    assert.equal(byId.get('git-working-tree')?.status, 'fail');
    assert.equal(byId.get('git-working-tree')?.source, 'git status --porcelain');
    assert.equal(byId.get('git-working-tree')?.blocking, true);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /dirty path\(s\) by category/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /koala_metadata_changes=/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /runtime_artifact_changes=1/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /fixture_changes=1/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /unexpected_dirty_files=1/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /packages\/main\/src\/core\/dirty\.ts/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /material_source_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /koala_metadata_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /runtime_artifact_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /fixture_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /unexpected_dirty_files/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /packages\/main\/tests\/output\/bl21_lacz_ecoli_minicell\/prodenovo_viewer\.json/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /默认无副作用|side-effect-free|KOALA_WRITE/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /delivery_check_set/);
    assert.equal(byId.get('delivery-check')?.source, 'delivery-check.json');
    assert.equal(byId.get('story-summary')?.status, 'fail');
    assert.equal(byId.get('story-summary')?.source, 'summary.json');
    assert.equal(byId.get('story-summary')?.blocking, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertGlobalLinkRepair(): void {
  const root = mkdtempSync(join(tmpdir(), 'koala-flow-link-'));
  try {
    const mainRepo = join(root, 'repo');
    const worktree = join(root, 'repo', '.worktrees', 'B-smoke');
    const worktreePackage = join(worktree, 'packages', 'main');
    const mainPackage = join(mainRepo, 'packages', 'main');
    const globalPackage = join(root, 'global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(worktreePackage, { recursive: true });
    mkdirSync(mainPackage, { recursive: true });
    mkdirSync(dirname(globalPackage), { recursive: true });
    symlinkSync(worktreePackage, globalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    const repaired = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: globalPackage });
    assert.equal(repaired.action, 'relinked');
    assert.equal(lstatSync(globalPackage).isSymbolicLink(), true);
    assert.equal(resolve(dirname(globalPackage), readlinkSync(globalPackage)), resolve(mainPackage));

    const otherPackage = join(root, 'other', 'packages', 'main');
    const otherGlobalPackage = join(root, 'other-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(otherPackage, { recursive: true });
    mkdirSync(dirname(otherGlobalPackage), { recursive: true });
    symlinkSync(otherPackage, otherGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');
    const skipped = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: otherGlobalPackage });
    assert.equal(skipped.action, 'skipped');
    assert.equal(resolve(dirname(otherGlobalPackage), readlinkSync(otherGlobalPackage)), resolve(otherPackage));

    const normalInstall = join(root, 'normal-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(normalInstall, { recursive: true });
    const normalSkipped = repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: normalInstall });
    assert.equal(normalSkipped.action, 'skipped');
    assert.equal(existsSync(normalInstall), true);
    assert.equal(lstatSync(normalInstall).isDirectory(), true);

    const failingGlobalPackage = join(root, 'failing-global', 'node_modules', '@koala-agent', 'core');
    mkdirSync(dirname(failingGlobalPackage), { recursive: true });
    symlinkSync(worktreePackage, failingGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => repairGlobalKoalaLinkBeforeWorktreeDelete(worktree, mainRepo, {
        globalPackagePath: failingGlobalPackage,
        unlinkImpl: () => {
          throw new Error('mock unlink failure');
        },
      }),
      /已阻止删除 .*mock unlink failure/,
    );
    assert.equal(resolve(dirname(failingGlobalPackage), readlinkSync(failingGlobalPackage)), resolve(worktreePackage));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function gitConfig(root: string, key: string, value: string): void {
  execFileSync('git', ['config', key, value], { cwd: root, stdio: 'ignore' });
}

function gitCheckoutNewBranch(root: string, branch: string): void {
  execFileSync('git', ['checkout', '-b', branch], { cwd: root, stdio: 'ignore' });
}

function gitCheckoutExistingBranch(root: string, branch: string): void {
  execFileSync('git', ['checkout', branch], { cwd: root, stdio: 'ignore' });
}

function gitCurrentBranch(root: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitCommitCount(root: string): number {
  return parseInt(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim(), 10);
}

function gitLastSubject(root: string): string {
  return execFileSync('git', ['log', '-1', '--pretty=%s'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function gitStatusPorcelain(root: string): string {
  return execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function setupAutoCommitFixture(): { root: string; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'koala-auto-commit-'));
  // Init git repo + initial commit on main so branch checkout works
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  gitConfig(root, 'user.email', 'smoke@koala.test');
  gitConfig(root, 'user.name', 'smoke');
  gitConfig(root, 'commit.gpgsign', 'false');
  // koala.config.json so loadConfig picks our story dir
  write(root, 'koala.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.koala/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  resetConfigCache();
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return { root, storyId: 'B-test1' };
}

function writeFakeMetadata(root: string, storyId: string, content = '{"x":1}'): void {
  write(root, `.koala/story/actives/${storyId}/findings.json`, content);
}

function writeMaterialFile(root: string, content = 'export const X = 1;\n'): void {
  write(root, 'packages/main/src/foo.ts', content);
}

function assertAutoCommitMetadataAcrossHandlers(): void {
  // Test 1 (happy): story/B-test1 branch, write fake metadata → helper commits
  // it and the user-visible hint matches the canonical prefix + reason + sha7.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const commitsBefore = gitCommitCount(root);
      const out = autoCommitStoryMetadata(root, storyId, 'finding_add');
      assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX), `auto-commit hint must start with the canonical prefix; got: ${JSON.stringify(out)}`);
      assert.match(out, /koala: record B-test1 finding_add metadata/);
      assert.match(out, /\([0-9a-f]{7}\)/, 'auto-commit hint must include short sha (7 hex chars)');
      assert.equal(gitCommitCount(root), commitsBefore + 1);
      assert.match(gitLastSubject(root), /^koala: record B-test1 finding_add metadata$/);
      assert.ok(!out.includes('untouched'), `no coexisting non-metadata dirt → tail-note must be omitted; got: ${JSON.stringify(out)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 2 (coexist): material source change coexists → metadata committed,
  // tail-note announces untouched non-metadata categories, material file
  // stays dirty on disk + git status confirms still M / ??.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      writeMaterialFile(root); // packages/main/src/foo.ts → material_source_changes
      const commitsBefore = gitCommitCount(root);
      const out = autoCommitStoryMetadata(root, storyId, 'review_pass_set');
      assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX), 'prefix must match');
      assert.match(out, /koala: record B-test1 review_pass_set metadata/);
      assert.match(out, /\(coexisting non-metadata dirt left untouched: [^)]*material_source_changes=1[^)]*\)/);
      assert.equal(gitCommitCount(root), commitsBefore + 1);
      // material file still dirty
      const status = gitStatusPorcelain(root);
      assert.ok(status.includes('packages/main/src/foo.ts'), `material file must remain dirty after helper; status: ${JSON.stringify(status)}`);
      // Classifier vocabulary parity (preMortem #3 — same words user sees)
      const classification = classifyGitStatusRows(
        status.split('\n').map(line => line.trimEnd()).filter(Boolean),
        dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)),
      );
      assert.equal(classification.groups.material_source_changes.length, 1);
      assert.equal(classification.groups.koala_metadata_changes.length, 0, 'metadata category must be empty after auto-commit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 3 (no coexist): nothing else dirty → output has NO `untouched`
  // tail-note (CHK-002 edge — do not print empty parens / left-untouched: ).
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const out = autoCommitStoryMetadata(root, storyId, 'summary_set');
      assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX));
      assert.ok(!out.includes('untouched'), `no non-metadata dirt → tail-note must be omitted; got: ${JSON.stringify(out)}`);
      assert.ok(!out.includes('left-untouched'));
      assert.ok(!out.includes('()'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 4 (idempotent): consecutive calls produce at most one commit.
  // Second invocation with nothing staged returns '' and does not commit again.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const first = autoCommitStoryMetadata(root, storyId, 'checklist_update');
      assert.ok(first.startsWith(AUTO_COMMIT_METADATA_PREFIX));
      const commitsAfterFirst = gitCommitCount(root);
      const second = autoCommitStoryMetadata(root, storyId, 'checklist_update');
      assert.equal(second, '', `idempotent re-call must return empty; got: ${JSON.stringify(second)}`);
      assert.equal(gitCommitCount(root), commitsAfterFirst, 'no second commit when nothing is staged');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 5 (main branch): on non-story/* branch helper returns '' silently
  // and does NOT produce a commit.
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      assert.equal(gitCurrentBranch(root), 'main');
      writeFakeMetadata(root, storyId);
      const commitsBefore = gitCommitCount(root);
      const out = autoCommitStoryMetadata(root, storyId, 'finding_add');
      assert.equal(out, '', `on main branch helper must be silent; got: ${JSON.stringify(out)}`);
      assert.equal(gitCommitCount(root), commitsBefore, 'no commit on main branch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 6 (path broaden): non-canonical storyId form throws synchronously
  // BEFORE any git invocation (preMortem #1 anchor). We probe path-traversal
  // (`../foo`), shell-metachar injection (`B-xx@injected`, `B-xx/yy`), and
  // empty / wrong-prefix inputs.
  {
    const { root } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, 'story/B-test1');
      for (const bad of ['B-xx@injected', '../foo', '', 'B-xx/yy', 'B-xx..yy', 'A-test1', 'B-', 'B- test', 'B-xx\\yy']) {
        assert.throws(
          () => autoCommitStoryMetadata(root, bad, 'finding_add'),
          /storyId must match/,
          `storyId=${JSON.stringify(bad)} should be rejected`,
        );
      }
      // Also confirm helper does not write a commit for these failures
      const startCommits = gitCommitCount(root);
      try { autoCommitStoryMetadata(root, '../foo', 'finding_add'); } catch { /* expected */ }
      assert.equal(gitCommitCount(root), startCommits, 'failed validation must not leave a commit behind');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 7 (prefix vocabulary parity with story-advance precedent — CHK-003
  // adversarial: byte-equal prefix `\n✓ koala metadata 已自动提交:`).
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      const out = autoCommitStoryMetadata(root, storyId, 'init_check_set');
      // Use indexOf instead of startsWith for crystal-clear failure message
      assert.equal(
        out.slice(0, AUTO_COMMIT_METADATA_PREFIX.length),
        AUTO_COMMIT_METADATA_PREFIX,
        'user-visible prefix must be byte-equal `\\n✓ koala metadata 已自动提交:`',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 8 (3+ handler reasons covered — CHK-004 happy): the same fixture +
  // 3 different reasons all produce the canonical hint format. Verifies the
  // helper is reason-agnostic, not hardcoded to a single phase like the old
  // story-advance copy.
  {
    const reasons = ['finding_add', 'checklist_update', 'summary_set'] as const;
    for (const reason of reasons) {
      const { root, storyId } = setupAutoCommitFixture();
      try {
        gitCheckoutNewBranch(root, `story/${storyId}`);
        writeFakeMetadata(root, storyId, `{"reason":"${reason}"}`);
        const out = autoCommitStoryMetadata(root, storyId, reason);
        assert.ok(out.startsWith(AUTO_COMMIT_METADATA_PREFIX), `reason=${reason} prefix mismatch`);
        assert.match(out, new RegExp(`koala: record B-test1 ${reason} metadata`));
        assert.match(gitLastSubject(root), new RegExp(`^koala: record B-test1 ${reason} metadata$`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  // Test 9 (classifier parity — CHK-004 adversarial): classifyDirtyWorktree
  // returns the same category counts whether helper was called or not for
  // non-metadata categories (auto-commit must not mask material/fixture/
  // unexpected dirt).
  {
    const { root, storyId } = setupAutoCommitFixture();
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      writeMaterialFile(root);
      // Add an unexpected file too (outside src/ and tests/fixtures/)
      write(root, 'packages/main/tests/output/x', 'unexpected');

      const before = classifyGitStatusRows(
        gitStatusPorcelain(root).split('\n').map(line => line.trimEnd()).filter(Boolean),
        dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)),
      );
      const materialBefore = before.groups.material_source_changes.length;
      const unexpectedBefore = before.groups.unexpected_dirty_files.length;

      autoCommitStoryMetadata(root, storyId, 'finding_add');

      const after = classifyGitStatusRows(
        gitStatusPorcelain(root).split('\n').map(line => line.trimEnd()).filter(Boolean),
        dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)),
      );
      assert.equal(after.groups.material_source_changes.length, materialBefore, 'material dirt count unchanged by auto-commit');
      assert.equal(after.groups.unexpected_dirty_files.length, unexpectedBefore, 'unexpected dirt count unchanged by auto-commit');
      assert.equal(after.groups.koala_metadata_changes.length, 0, 'metadata category drains to zero after auto-commit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

assertSessionBriefGate();
assertDirtyWorktreeClassifierGroupsOwnership();
assertFlowFactPolicyRegistry();
assertPhaseGatePolicyHints();
assertPhaseToolsOverrideStillBlocks();
assertLifecycleRegistryConsistency();
assertStoryAdvanceTestGateFailClosedContracts();
assertManagedAssetExpandedDocsAndTrueDrift();
assertDispatchPromptsPinImplementerCommitAuthor();
assertReviewGateUsesOptIn();
assertReviewRunBindingRejectsInvalidEvidence();
assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable();
await assertStoryAdvanceReviewEchoOmitsRetiredChannel();
assertReviewerStatusUsesMdFallback();
assertSessionBriefStatusHintsMatchGates();
assertReviewNextUsesReviewerGateState();
assertDevGuidanceUsesReviewPhase();
assertValidateHintsFollowStoryPhase();
assertRealCliValidateHintFollowsActiveStoryPhase();
assertBugUpdateTestHintUsesDonePrecheck();
assertChannelGateRejectsKoalaSubjectForRealFiles();
assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor();
assertChannelGateAcceptsSuccessfulSubagentResultEvidence();
assertChannelGateAcceptsDispatchEvidence();
assertChannelGateAcceptsImplementerAuthorWithoutDispatch();
assertDoneChecklistUsesStableOracleRows();
assertGlobalLinkRepair();
assertAutoCommitMetadataAcrossHandlers();

console.log('✓ flow stability smoke passed');
