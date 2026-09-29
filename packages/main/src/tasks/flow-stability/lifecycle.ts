import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_PHASE_TOOLS, getAllowedPatterns, isCommandAllowed } from '../../core/config.js';
import { getCommandPolicyEntries, policyAllowedPhaseLabels } from '../../core/command-policy.js';

import { FLOW_FACT_POLICIES, isPassOnlyReviewFindingRecord } from '../../core/flow-fact-policy.js';
import { runManagedAssetCheck } from '../../core/managed-assets.js';

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
} from '../../core/lifecycle-registry.js';

import { getProcessFactRegistryEntry, hasProcessFactSemantic, PROCESS_FACT_FLOW_POLICIES } from '../../core/process-fact-registry.js';
import {
  ACTIVE_PHASE_ORDER,
  PHASE_ORDER,
  TERMINAL_PHASES,
  checkPhaseTransition,
  getPhaseInfo,
  normalizeLegacyPhase,
} from '../../core/phase-flow.js';
import {
  isLifecycleArtifact,
  lifecycleArtifactsByPhase,
  lifecycleArtifactsByTransition,
  lifecycleCommandsByPhase,
  lifecycleResolvedCommandsForPhase,
} from '../../core/lifecycle-registry.js';

import type { StoryInfo } from '../../core/types.js';

import { CWD_GATED_PHASES, PHASE_TO_EVENT } from '../../handlers/context.js';

import { createStoryDispatchHandlers } from '../../handlers/story-dispatch.js';

import { PROOF_OR_STOP_STATE_DIR } from '../../core/brand-paths.js';

import { ORIGINAL_TASKS_DIR } from './support.js';
import { createReviewStore, git, makeFinding, write, localCliPath } from './support.js';

export function assertDispatchPromptsPinImplementerCommitAuthor(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-dispatch-author-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'dispatch-author@example.test']);
    git(root, ['config', 'user.name', 'dispatch-author-smoke']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'dispatch author baseline']);
    const dispatch = createStoryDispatchHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    store.writeStory(storyId, { ...store.readStory(storyId), phase: 'DEV' });
    const expectedAuthor = /git commit --author="proof-or-stop-implementer <proof-or-stop-implementer@noreply\.local>"/;

    const itemPrompt = dispatch.dispatch({ storyId, itemId: 'CHK-001' }).prompt;
    assert.match(itemPrompt, expectedAuthor);
    assert.match(itemPrompt, /Author text never replaces the required dispatch\/subagent_result process evidence/);

    store.writeFindings(storyId, {
      findings: [makeFinding(storyId, 'proof-or-stop-review-quality', reviewRound, '070', 'RR-smoke')],
    });
    const findingPrompt = dispatch.dispatch({ storyId, findingId: 'F-070' }).prompt;
    assert.match(findingPrompt, expectedAuthor);
    assert.match(findingPrompt, /Author text never replaces the required dispatch\/subagent_result process evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertSessionBriefGate(): void {
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
    isCommandAllowed('dispatch', 'DEV'),
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
    isCommandAllowed('finding_cluster', 'DEV', { '*': ['status'], DEV: ['finding_add', 'dispatch'] }),
    false,
    'custom phase tools should still be able to override DEV finding_cluster availability',
  );
}

export function assertFlowFactPolicyRegistry(): void {
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

  const finishDecision = getProcessFactRegistryEntry('runtime:done_finish_decision_presence');
  assert.equal(finishDecision?.level, 'L4');
  assert.match(finishDecision?.consumerGate ?? '', /storyMachine\.canFinish DONE gate/);
  assert.match(finishDecision?.consumerGate ?? '', /done_closure\/done_prepare preflight/);
  assert.equal(hasProcessFactSemantic('runtime:done_finish_decision_presence', 'blocker-state'), true);

  const reviewerVerdict = getProcessFactRegistryEntry('runtime:done_phase_agnostic_reviewer_verdict');
  assert.equal(reviewerVerdict?.level, 'L4');
  assert.match(reviewerVerdict?.producer ?? '', /evaluateReviewVerdict/);
  assert.match(reviewerVerdict?.consumerGate ?? '', /storyMachine\.canFinish DONE gate/);
  assert.match(reviewerVerdict?.consumerGate ?? '', /done_closure\/done_prepare preflight/);
  assert.equal(hasProcessFactSemantic('runtime:done_phase_agnostic_reviewer_verdict', 'freshness-policy'), true);

  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS: docs consistency check PASSED.',
      severity: 'low',
      agent: 'proof-or-stop-review-docs',
    }),
    true,
    'low-severity reviewer pass-only finding should normalize to review pass',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS but README command failed.',
      severity: 'low',
      agent: 'proof-or-stop-review-docs',
    }),
    false,
    'ambiguous pass plus failure text must remain a real finding',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: '\u5ba1\u67e5\u901a\u8fc7\uff1a\u5df2\u68c0\u67e5\u8303\u56f4\uff0c\u65e0\u963b\u585e\u95ee\u9898\u3002',
      severity: 'low',
      agent: 'proof-or-stop-review-quality',
    }),
    true,
    'localized pass-only reviewer finding should normalize to review pass',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: '\u5ba1\u67e5\u901a\u8fc7\uff0c\u4f46\u4ecd\u7136\u6709\u95ee\u9898\u9700\u8981\u4fee\u590d\u3002',
      severity: 'low',
      agent: 'proof-or-stop-review-quality',
    }),
    false,
    'localized pass text with an explicit problem must remain a real finding',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS: docs consistency check PASSED.',
      severity: 'medium',
      agent: 'proof-or-stop-review-docs',
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
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS: no blocking issues.',
      severity: 'low',
      agent: 'proof-or-stop-review-lookalike',
    }),
    false,
    'an unregistered prefix lookalike must not normalize into reviewer evidence',
  );
}

export function createActiveStoryRoot(phase: StoryInfo['phase'], configPatch: Record<string, unknown> = {}): { root: string; storyId: string } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-flow-command-policy-'));
  const { store, storyId } = createReviewStore(root);
  const config = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    ...configPatch,
  };
  write(root, 'proof-or-stop.config.json', JSON.stringify(config));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'proofOrStop@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', `story/${storyId}`]);
  const story = store.readStory(storyId);
  story.phase = phase;
  store.writeStory(storyId, story);
  return { root, storyId };
}

export function runBlockedCli(root: string, args: string[]): string {
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

export function assertPhaseGatePolicyHints(): void {
  const supported = createActiveStoryRoot('DEV');
  try {
    const output = runBlockedCli(supported.root, ['bug_report']);
    assert.match(output, /Command "bug_report" is not available in DEV phase/);
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
    assert.match(output, /Replacement: .*proof-or-stop validate --story=<storyId>/);
    assert.match(output, /verificationEvidence/);
    assert.match(output, /Destructive risk: workspace-destructive/);
    assert.match(output, /confirm/);
  } finally {
    rmSync(legacy.root, { recursive: true, force: true });
  }
}

export function assertPhaseToolsOverrideStillBlocks(): void {
  const override = createActiveStoryRoot('DEV', {
    phaseTools: {
      '*': ['session_brief'],
      DEV: ['status'],
    },
  });
  try {
    const output = runBlockedCli(override.root, ['finding_add']);
    assert.match(output, /Command "finding_add" is not available in DEV phase/);
    assert.match(output, /Lifecycle: gateEvidence/);
    assert.match(output, /Requested phase: DEV/);
    assert.match(output, /Allowed phases: DEV, REVIEW/);
    assert.match(output, /Current phaseTools allow: session_brief, next, (?:done_closure, )?status/);
  } finally {
    rmSync(override.root, { recursive: true, force: true });
  }
}

export function patternMatchesCommand(pattern: string, command: string): boolean {
  if (pattern.endsWith('*')) return command.startsWith(pattern.slice(0, -1));
  return command === pattern;
}

export function assertLifecycleRegistryConsistency(): void {
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

export const PHASE_FLOW_GET_PHASE_INFO_BASELINE: Record<string, ReturnType<typeof getPhaseInfo>> = {
  IDEA: { phase: 'IDEA', ordinal: 1, total: 8, label: 'IDEA', terminal: false, allowedNext: ['INIT', 'PLAN'], allowedRollback: [] },
  INIT: { phase: 'INIT', ordinal: 2, total: 8, label: 'INIT', terminal: false, allowedNext: ['INIT_CHECK'], allowedRollback: [] },
  INIT_CHECK: { phase: 'INIT_CHECK', ordinal: 3, total: 8, label: 'INIT_CHECK', terminal: false, allowedNext: ['PLAN', 'DEV'], allowedRollback: [] },
  // B-8b69: the gated PLAN->INIT reopen edge (unfreeze a scope-flagged title) is a
  // rollback out of PLAN, so PLAN's derived allowedRollback now includes 'INIT'.
  PLAN: { phase: 'PLAN', ordinal: 4, total: 8, label: 'PLAN', terminal: false, allowedNext: ['DEV'], allowedRollback: ['INIT'] },
  DEV: { phase: 'DEV', ordinal: 5, total: 8, label: 'DEV', terminal: false, allowedNext: ['REVIEW'], allowedRollback: ['PLAN'] },
  REVIEW: { phase: 'REVIEW', ordinal: 6, total: 8, label: 'REVIEW', terminal: false, allowedNext: ['TEST'], allowedRollback: ['DEV'] },
  TEST: { phase: 'TEST', ordinal: 7, total: 8, label: 'TEST', terminal: false, allowedNext: ['DONE'], allowedRollback: ['DEV'] },
  DONE: { phase: 'DONE', ordinal: 8, total: 8, label: 'DONE', terminal: true, allowedNext: [], allowedRollback: [] },
  TEST_CASE: { phase: 'TEST_CASE', ordinal: 8, total: 8, label: 'TEST_CASE', terminal: false, allowedNext: ['TEST_CASE_REVIEW'], allowedRollback: ['DEV'] },
  TEST_CASE_REVIEW: { phase: 'TEST_CASE_REVIEW', ordinal: 8, total: 8, label: 'TEST_CASE_REVIEW', terminal: false, allowedNext: ['TEST'], allowedRollback: ['DEV', 'TEST_CASE'] },
  META: { phase: 'META', ordinal: 8, total: 8, label: 'META', terminal: false, allowedNext: [], allowedRollback: [] },
  DISCARDED: { phase: 'DISCARDED', ordinal: 8, total: 8, label: 'DISCARDED', terminal: true, allowedNext: [], allowedRollback: [] },
};

export const PHASE_FLOW_TRANSITION_HEALTH_BASELINE_HASH =
  'd14e6aa25cf0d78f52ce5cbf596dac19760c9157322b004c90327bb113954094';

export function assertPhaseFlowDerivedValuesByteIdentical(): void {
  // getPhaseInfo for every lifecycle phase must equal the captured baseline.
  for (const phase of LIFECYCLE_PHASES) {
    assert.deepEqual(
      getPhaseInfo(phase),
      PHASE_FLOW_GET_PHASE_INFO_BASELINE[phase],
      `B-3740 regression: getPhaseInfo(${phase}) changed after the lifecycle registry extension — phase-flow derived value is no longer byte-identical`,
    );
  }
  assert.equal(
    Object.keys(PHASE_FLOW_GET_PHASE_INFO_BASELINE).length,
    LIFECYCLE_PHASES.length,
    'B-3740 regression: getPhaseInfo baseline must cover every LIFECYCLE_PHASES entry',
  );

  // checkPhaseTransition for every ordered phase pair must hash to the baseline.
  const health: Record<string, ReturnType<typeof checkPhaseTransition>> = {};
  for (const from of LIFECYCLE_PHASES) {
    for (const to of LIFECYCLE_PHASES) {
      health[`${from}->${to}`] = checkPhaseTransition(from, to);
    }
  }
  const healthHash = createHash('sha256').update(JSON.stringify(health)).digest('hex');
  assert.equal(
    healthHash,
    PHASE_FLOW_TRANSITION_HEALTH_BASELINE_HASH,
    'B-3740 regression: checkPhaseTransition output changed after the lifecycle registry extension — phase-flow transition health is no longer byte-identical',
  );

  // The new dimensions must be usable, separately-exported projections — proves
  // they exist without being coupled to the phase-flow-consumed transitions.
  const commandsByPhase = lifecycleCommandsByPhase();
  assert.ok(
    Array.isArray(commandsByPhase.wildcard) && commandsByPhase.wildcard.length > 0,
    'B-3740 regression: lifecycleCommandsByPhase must expose a non-empty wildcard bucket',
  );
  for (const phase of COMMAND_LIFECYCLE_PHASES) {
    const resolved = lifecycleResolvedCommandsForPhase(phase);
    for (const wildcardCommand of commandsByPhase.wildcard) {
      assert.ok(
        resolved.includes(wildcardCommand),
        `B-3740 regression: wildcard command ${wildcardCommand} must resolve as legal in phase ${phase}`,
      );
    }
  }
  const artifactsByPhase = lifecycleArtifactsByPhase();
  assert.equal(
    Object.keys(artifactsByPhase).length,
    LIFECYCLE_PHASES.length,
    'B-3740 regression: lifecycleArtifactsByPhase must project every lifecycle phase',
  );
  for (const transitionArtifacts of lifecycleArtifactsByTransition()) {
    for (const artifact of transitionArtifacts.artifacts) {
      assert.ok(
        isLifecycleArtifact(artifact),
        `B-3740 regression: transition ${transitionArtifacts.from}->${transitionArtifacts.to} surfaced undeclared artifact ${artifact}`,
      );
    }
  }
}

export function assertStoryAdvanceTestGateFailClosedContracts(): void {
  const root = resolve(ORIGINAL_TASKS_DIR, '..', '..');
  // B-14ae: TEST is a signed-evidence consumer. The phase gate must preserve
  // the PRE_CERT recovery but cannot retain an execution fallback.
  const source = readFileSync(join(root, 'src', 'handlers', 'story-advance.ts'), 'utf-8');
  const phaseGatesSource = readFileSync(join(root, 'src', 'handlers', 'phase-gates.ts'), 'utf-8');
  assert.match(
    phaseGatesSource,
    /Cannot enter TEST: CLI gate preflight execution error/,
    'REVIEW->TEST preflight infrastructure errors must be fail-closed',
  );
  assert.match(
    phaseGatesSource,
    /\[\$\{PRE_CERT_ROUTINE_PASS_REQUIRED\}\] Cannot enter TEST/,
    'missing or stale REVIEW routine evidence must fail closed before entering TEST',
  );
  assert.doesNotMatch(
    phaseGatesSource,
    /createVerifierHandlers|verifierHandlers\.validate/,
    'TEST must not retain a verifier execution fallback',
  );
  for (const src of [source, phaseGatesSource]) {
    assert.doesNotMatch(
      src,
      /CLI gate preflight self error \(does not block advancement\)|validate execution failed \(does not block advancement\)/,
      'TEST gate infrastructure errors must not use the old warn-and-advance path',
    );
  }
}

export function assertManagedAssetExpandedDocsAndTrueDrift(): void {
  const packageRoot = resolve(ORIGINAL_TASKS_DIR, '..', '..');
  const repoRoot = resolve(packageRoot, '..', '..');
  const current = runManagedAssetCheck(repoRoot, { profile: 'all' });
  const currentById = new Map(current.items.map(item => [item.id, item]));
  const expandedLocalGuideIds = [`doc:${PROOF_OR_STOP_STATE_DIR}/Proof-or-Stop.md`, 'doc:PROOF_OR_STOP.md', 'doc:CLAUDE.md']
    .filter(id => currentById.has(id));
  assert.ok(
    expandedLocalGuideIds.length > 0,
    `managed asset drift check should expose at least one local guide doc for assetMode=${current.assetMode}`,
  );
  for (const id of expandedLocalGuideIds) {
    const status = currentById.get(id)?.status;
    assert.ok(
      status === 'OK' || status === 'STALE_SAFE',
      `managed asset drift check should not flag current local guide ${id} as unsafe drift: ${status}`,
    );
  }

  const assertTrueLocalDrift = (
    assetMode: 'full' | 'global-thin',
    docs: Array<{ id: string; relPath: string }>,
  ): void => {
    const badRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-managed-drift-'));
    try {
      const badSection = '<!-- proof-or-stop:start -->\n# Locally edited guide\nThis is not a Proof-or-Stop-owned alternate contract.\n<!-- proof-or-stop:end -->\n';
      for (const doc of docs) write(badRoot, doc.relPath, badSection);
      const drift = runManagedAssetCheck(badRoot, { profile: 'all', assetMode });
      const driftById = new Map(drift.items.map(item => [item.id, item]));
      for (const doc of docs) {
        assert.equal(
          driftById.get(doc.id)?.status,
          'STALE_LOCAL_EDIT',
          `managed asset drift check must still flag true local drift for ${doc.id}`,
        );
      }
    } finally {
      rmSync(badRoot, { recursive: true, force: true });
    }
  };

  assertTrueLocalDrift('global-thin', [
    { id: `doc:${PROOF_OR_STOP_STATE_DIR}/Proof-or-Stop.md`, relPath: `${PROOF_OR_STOP_STATE_DIR}/Proof-or-Stop.md` },
    { id: 'doc:AGENTS.md', relPath: 'AGENTS.md' },
    { id: 'doc:CLAUDE.md', relPath: 'CLAUDE.md' },
  ]);
  assertTrueLocalDrift('full', [
    { id: 'doc:PROOF_OR_STOP.md', relPath: 'PROOF_OR_STOP.md' },
    { id: 'doc:AGENTS.md', relPath: 'AGENTS.md' },
    { id: 'doc:CLAUDE.md', relPath: 'CLAUDE.md' },
  ]);
}
