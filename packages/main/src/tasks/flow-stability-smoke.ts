#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, lstatSync, readlinkSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PHASE_TOOLS, getAllowedPatterns, isCommandAllowed, loadConfig, resetConfigCache } from '../core/config.js';
import { getCommandPolicyEntries, policyAllowedPhaseLabels } from '../core/command-policy.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsForStory,
  dirtyWorktreeClassifierOptionsFromConfig,
  parseGitPorcelainRow,
  DIRTY_WORKTREE_CATEGORIES,
  emptyDirtyWorktreeGroups,
} from '../core/dirty-worktree.js';
import {
  DIRTY_GATE_POLICY,
  assertPolicyCovers,
  defaultAuditWriter,
  evaluateDirtyGate,
  AUDIT_PATH_SAMPLE_LIMIT,
  type AuditEvent,
  type AuditWriter,
} from '../core/dirty-gate-policy.js';
import { evaluateDeclaredArtifactReferences } from '../core/declared-artifact-gate.js';
import { createArtifactDeclareHandlers } from '../handlers/artifact-declare.js';
import { EMPTY_STORY_FILES_HASH, checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { signDeliveryCheck } from '../core/delivery-check-hash.js';
import { signFinding, signReviewPass, verifyFinding, verifyReviewPass } from '../core/finding-verify.js';
import { autoCommitStoryMetadata, AUTO_COMMIT_METADATA_PREFIX } from '../core/auto-commit-metadata.js';
import { readHealthIssues } from '../core/health.js';
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
import { getGuardFailureReason as legacyGetGuardFailureReason } from '../core/guard-utils.js';
import { getProcessFactRegistryEntry, hasProcessFactSemantic, PROCESS_FACT_FLOW_POLICIES } from '../core/process-fact-registry.js';
import {
  ACTIVE_PHASE_ORDER,
  PHASE_ORDER,
  TERMINAL_PHASES,
  checkPhaseTransition,
  getPhaseInfo,
  normalizeLegacyPhase,
} from '../core/phase-flow.js';
import {
  isLifecycleArtifact,
  lifecycleArtifactsByPhase,
  lifecycleArtifactsByTransition,
  lifecycleCommandsByPhase,
  lifecycleResolvedCommandsForPhase,
} from '../core/lifecycle-registry.js';
import { assertCurrentReviewRunForEvidence, buildReviewRunWorkspaceBinding, collectReviewerEvidenceState, signReviewRun, verifyReviewRun } from '../core/review-run.js';
import { summarizeReviewerStatus } from '../core/reviewer-status.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, Finding, ReviewRun, StoryInfo, TestEvidenceData } from '../core/types.js';
import { findStaleEvidence } from '../core/evidence-stale-hint.js';
import { CWD_GATED_PHASES, PHASE_TO_EVENT } from '../handlers/context.js';
import { buildDoneChecklist, renderDoneChecklist } from '../core/done-oracle.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { formatWorktreePollutionDetails } from '../core/validation-executor.js';
import { createStoryAdvanceHandlers } from '../handlers/story-advance.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { runReviewToTestPreflightGate, runValidateGate } from '../handlers/phase-gates.js';
import { runReviewCliGates, renderPreflight } from '../handlers/review-preflight.js';
import { buildNextSteps, renderRelatedDocsHint } from '../handlers/transition-effects.js';
import { createStoryDispatchHandlers } from '../handlers/story-dispatch.js';
import { decorateResult } from '../handlers/hints.js';
import { createSessionHandlers } from '../handlers/session.js';
import { buildDoneClosureRunbook } from '../handlers/done-closure.js';
import { checkCommitAuthor } from '../handlers/validate-channel.js';
import { repairGlobalLatticeLinkBeforeWorktreeDelete } from '../handlers/worktree.js';

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
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-dirty-classifier-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const rename = parseGitPorcelainRow('R  packages/main/src/old.ts -> ./packages/main/src/new.ts');
    assert.equal(rename?.statusCode, 'R ');
    assert.equal(rename?.rawPath, './packages/main/src/new.ts');
    assert.equal(rename?.path, 'packages/main/src/new.ts');
    assert.equal(rename?.originalPath, 'packages/main/src/old.ts');

    const classification = classifyGitStatusRows([
      ' M .lattice/story/actives/B-smoke/checklist.json',
      ' M Docs/story/actives/B-smoke/test-evidence.json',
      '?? .lattice/activity.jsonl',
      ' M package.json',
      ' D lattice.config.json',
      'R  packages/main/src/old.ts -> ./packages/main/src/new.ts',
      '?? packages/main/tests/fixtures/dirty-owner.json',
      '?? packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json',
    ], dirtyWorktreeClassifierOptionsFromConfig(loadConfig(root)));

    assert.equal(classification.total, 8);
    assert.equal(classification.groups.lattice_metadata_changes.length, 2);
    assert.equal(classification.groups.runtime_artifact_changes.length, 1);
    assert.equal(classification.groups.declared_artifact_changes.length, 0, 'undeclared artifact extension point should stay empty by default');
    assert.equal(classification.groups.material_source_changes.length, 3);
    assert.equal(classification.groups.fixture_changes.length, 1);
    assert.equal(classification.groups.unexpected_dirty_files.length, 1);
    assert.equal(classification.groups.unexpected_dirty_files[0].path, 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json');
    assert.equal(classification.groups.runtime_artifact_changes[0].raw, '?? .lattice/activity.jsonl');
    assert.equal(classification.groups.runtime_artifact_changes[0].statusCode, '??');
    assert.equal(classification.groups.runtime_artifact_changes[0].rawPath, '.lattice/activity.jsonl');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Task B-4b22 regression block — registry / blocking / passing / audit /
// import-isolation invariants of the dirty-gate-policy module. Covers all
// three preMortem anchors from the story's decision.json.
function assertDirtyGatePolicyAcrossGates(): void {
  const STORY = 'B-smoke-policy';
  const fixedNow = () => '2026-05-15T18:00:00.000Z';

  // Build a typed classification from a list of {category, path} pairs without
  // running classifyGitStatusRows (so the test is independent of the
  // classifier's heuristics). Status code "?? " keeps parseGitPorcelainRow
  // happy if anyone later swaps in a real row.
  function buildClassification(
    entries: Array<{ category: string; path: string }>,
  ): import('../core/dirty-worktree.js').DirtyWorktreeClassification {
    const groups = emptyDirtyWorktreeGroups();
    for (const { category, path } of entries) {
      const cat = category as keyof typeof groups;
      groups[cat].push({
        raw: `?? ${path}`,
        statusCode: '??',
        rawPath: path,
        path,
        category: cat as any,
      });
    }
    return {
      total: entries.length,
      entries: DIRTY_WORKTREE_CATEGORIES.flatMap((c) => groups[c]),
      groups,
    };
  }

  // (1) registry-vs-policy invariant — preMortem #1 anchor.
  assert.equal(
    Object.keys(DIRTY_GATE_POLICY).length,
    DIRTY_WORKTREE_CATEGORIES.length,
    'DIRTY_GATE_POLICY entry count must equal DIRTY_WORKTREE_CATEGORIES.length (B-4b22 preMortem #1)',
  );
  assert.doesNotThrow(() => assertPolicyCovers(), 'assertPolicyCovers() must not throw against current registry');
  // Explicit blocking/passing partition is the safety contract.
  assert.equal(DIRTY_GATE_POLICY.material_source_changes.blocking, true);
  assert.equal(DIRTY_GATE_POLICY.fixture_changes.blocking, true);
  assert.equal(DIRTY_GATE_POLICY.unexpected_dirty_files.blocking, true);
  assert.equal(DIRTY_GATE_POLICY.lattice_metadata_changes.blocking, false);
  assert.equal(DIRTY_GATE_POLICY.runtime_artifact_changes.blocking, false);
  assert.equal(DIRTY_GATE_POLICY.declared_artifact_changes.blocking, false);

  // (2) blocking 3 categories coexist → allPass=false with names + counts.
  const blockingFixture = buildClassification([
    { category: 'material_source_changes', path: 'packages/main/src/foo.ts' },
    { category: 'fixture_changes', path: 'packages/main/tests/fixtures/x.json' },
    { category: 'unexpected_dirty_files', path: 'random.tmp' },
  ]);
  const blockingResult = evaluateDirtyGate(blockingFixture, {
    storyId: STORY,
    gate: 'test-pre-check',
    writer: null,
    now: fixedNow,
  });
  assert.equal(blockingResult.allPass, false, '3 blocking categories must yield allPass=false');
  assert.equal(blockingResult.blockingCounts.material_source_changes, 1);
  assert.equal(blockingResult.blockingCounts.fixture_changes, 1);
  assert.equal(blockingResult.blockingCounts.unexpected_dirty_files, 1);
  assert.match(blockingResult.summary, /material_source_changes=1/);
  assert.match(blockingResult.summary, /fixture_changes=1/);
  assert.match(blockingResult.summary, /unexpected_dirty_files=1/);
  assert.equal(blockingResult.auditEvents.length, 0, 'pure-blocking fixture must emit zero audit events');

  // (3) passing 3 categories coexist → allPass=true with 3 audit events.
  const passingFixture = buildClassification([
    { category: 'lattice_metadata_changes', path: '.lattice/story/actives/B-x/index.json' },
    { category: 'runtime_artifact_changes', path: '.lattice/activity.jsonl' },
    { category: 'declared_artifact_changes', path: 'packages/main/tests/output/declared.json' },
  ]);
  const passingCapture: AuditEvent[] = [];
  const passingResult = evaluateDirtyGate(passingFixture, {
    storyId: STORY,
    gate: 'done-gate',
    writer: (ev) => { passingCapture.push(ev); },
    now: fixedNow,
  });
  assert.equal(passingResult.allPass, true, 'passing-only fixture must yield allPass=true');
  assert.equal(passingResult.auditEvents.length, 3, '3 passing categories must emit 3 audit events');
  assert.equal(passingCapture.length, 3, 'writer must be invoked once per passing category');
  assert.match(passingResult.summary, /passed=3/);
  assert.match(passingResult.summary, /lattice_metadata_changes=1/);
  assert.match(passingResult.summary, /runtime_artifact_changes=1/);
  assert.match(passingResult.summary, /declared_artifact_changes=1/);

  // (4) B-3506 scenario — empty classification → allPass=true, no audit.
  const emptyResult = evaluateDirtyGate(buildClassification([]), {
    storyId: STORY,
    gate: 'test-pre-check',
    writer: null,
    now: fixedNow,
  });
  assert.equal(emptyResult.allPass, true);
  assert.equal(emptyResult.auditEvents.length, 0, 'empty classification must not write audit events');
  assert.equal(emptyResult.summary, 'blocking=0; passed=0');

  // (5) BL21 lacZ scenario — single declared_artifact_changes path passes.
  const BL21 = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
  const bl21Result = evaluateDirtyGate(
    buildClassification([{ category: 'declared_artifact_changes', path: BL21 }]),
    { storyId: STORY, gate: 'done-gate', writer: null, now: fixedNow },
  );
  assert.equal(bl21Result.allPass, true);
  assert.equal(bl21Result.auditEvents.length, 1);
  assert.equal(bl21Result.auditEvents[0].category, 'declared_artifact_changes');
  assert.equal(bl21Result.auditEvents[0].paths[0], BL21);

  // (5b) runtime_artifact_changes solo fixture — preMortem #1 anchor for the
  // smallest non-blocking single-category passing path. Covers CHK-004:edge:0
  // (verificationIntent: "single runtime_artifact_changes path → allPass=true
  // with exactly one audit row, category=runtime_artifact_changes"). Distinct
  // from (5) which covers declared_artifact_changes, and from (3) which mixes
  // all three passing categories.
  const runtimeOnlyPath = '.lattice/activity.jsonl';
  const runtimeOnlyResult = evaluateDirtyGate(
    buildClassification([{ category: 'runtime_artifact_changes', path: runtimeOnlyPath }]),
    { storyId: STORY, gate: 'done-gate', writer: null, now: fixedNow },
  );
  assert.equal(runtimeOnlyResult.allPass, true, 'solo runtime_artifact_changes must yield allPass=true');
  assert.equal(runtimeOnlyResult.auditEvents.length, 1, 'solo runtime_artifact_changes must emit exactly one audit event');
  assert.equal(runtimeOnlyResult.auditEvents[0].category, 'runtime_artifact_changes');
  assert.equal(runtimeOnlyResult.auditEvents[0].paths[0], runtimeOnlyPath);
  assert.equal(runtimeOnlyResult.auditEvents[0].pathCount, 1);
  assert.match(runtimeOnlyResult.summary, /passed=1/);
  assert.match(runtimeOnlyResult.summary, /runtime_artifact_changes=1/);
  assert.equal(
    Object.keys(runtimeOnlyResult.blockingCounts).length,
    0,
    'solo runtime_artifact_changes must produce zero blocking counts',
  );

  // (6) audit-write-failure → AUDIT WRITE FAILED + allPass forced false.
  // preMortem #2 anchor.
  const failingWriter: AuditWriter = () => { throw new Error('ENOSPC: no space left'); };
  const auditFailResult = evaluateDirtyGate(passingFixture, {
    storyId: STORY,
    gate: 'done-gate',
    writer: failingWriter,
    now: fixedNow,
  });
  assert.equal(auditFailResult.allPass, false, 'writer throw must force allPass=false');
  assert.ok(
    auditFailResult.auditFailure && auditFailResult.auditFailure.startsWith('AUDIT WRITE FAILED:'),
    'auditFailure must surface AUDIT WRITE FAILED prefix',
  );
  assert.match(auditFailResult.auditFailure!, /ENOSPC/);

  // (7) import-isolation grep — preMortem #3 anchor. Category literals must
  // only appear inside `from '../core/dirty-gate-policy.js'` or
  // `from '../core/dirty-worktree.js'` import lines in the two gate consumers.
  // At runtime this smoke runs from dist/tasks/; sources live under src/.
  // Walk up from <pkg>/dist/tasks/ to <pkg>/, then into src/.
  const distTasksDir = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(distTasksDir, '..', '..');
  const srcRoot = join(pkgRoot, 'src');
  for (const rel of ['core/done-oracle.ts', 'core/validation-executor.ts']) {
    const filePath = join(srcRoot, rel);
    const src = readFileSync(filePath, 'utf-8');
    for (const cat of DIRTY_WORKTREE_CATEGORIES) {
      // Find all line numbers containing the literal.
      const lines = src.split('\n');
      const offending: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(cat)) continue;
        const trimmed = line.trim();
        // Allow:
        //   - Comments (// or block)
        //   - import lines (single-line or part of a multi-line import block)
        //   - lines referencing the literal inside a comment
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        if (trimmed.startsWith('import ') || trimmed.includes(' from ')) continue;
        // Inside multi-line import braces: heuristic — line is just a
        // bare identifier (no method call, no string, no =)
        if (/^[A-Za-z_][A-Za-z0-9_]*,?$/.test(trimmed)) continue;
        offending.push(`${rel}:${i + 1}: ${line}`);
      }
      assert.equal(
        offending.length,
        0,
        `inline literal "${cat}" found in ${rel} — must be imported from dirty-gate-policy.ts (B-4b22 preMortem #3)\n${offending.join('\n')}`,
      );
    }
  }

  // (8) defaultAuditWriter happy path — actually append to a tmp file.
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lattice-dirty-audit-'));
  try {
    const storyDirRel = '.lattice/story/actives';
    mkdirSync(join(tmpRoot, storyDirRel, STORY), { recursive: true });
    const writer = defaultAuditWriter(tmpRoot, storyDirRel, STORY);
    const result = evaluateDirtyGate(passingFixture, {
      storyId: STORY,
      gate: 'validate-side-effect',
      writer,
      now: fixedNow,
    });
    assert.equal(result.allPass, true);
    const jsonlPath = join(tmpRoot, storyDirRel, STORY, 'process-events.jsonl');
    assert.ok(existsSync(jsonlPath), 'process-events.jsonl must be created by defaultAuditWriter');
    const persisted = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(persisted.length, 3, 'must write one JSONL row per passing category');
    for (const line of persisted) {
      const ev = JSON.parse(line);
      assert.equal(ev.type, 'dirty_gate_audit');
      assert.equal(ev.storyId, STORY);
      assert.equal(ev.gate, 'validate-side-effect');
      assert.equal(ev.timestamp, fixedNow());
      assert.ok(typeof ev.reason === 'string' && ev.reason.length > 0);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }

  // (9) path truncation — >5 paths in a passing category truncate to 5 with
  // pathCount preserved.
  const manyPaths = Array.from({ length: 8 }, (_, i) => `.lattice/story/actives/B-x/file-${i}.json`);
  const manyFixture = buildClassification(
    manyPaths.map((p) => ({ category: 'lattice_metadata_changes', path: p })),
  );
  const truncResult = evaluateDirtyGate(manyFixture, {
    storyId: STORY,
    gate: 'done-gate',
    writer: null,
    now: fixedNow,
  });
  assert.equal(truncResult.allPass, true);
  assert.equal(truncResult.auditEvents.length, 1);
  assert.equal(truncResult.auditEvents[0].pathCount, 8);
  assert.equal(truncResult.auditEvents[0].paths.length, AUDIT_PATH_SAMPLE_LIMIT, 'paths must be truncated to 5');
  assert.equal(truncResult.auditEvents[0].paths.length, 5);
}

function assertDispatchPromptsPinImplementerCommitAuthor(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-dispatch-author-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const dispatch = createStoryDispatchHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const expectedAuthor = /git commit --author="lattice-implementer <lattice-implementer@noreply\.local>"/;

    const itemPrompt = dispatch.dispatch({ storyId, itemId: 'CHK-001' }).prompt;
    assert.match(itemPrompt, expectedAuthor);
    assert.match(itemPrompt, /normal-channel author fallback/);

    store.writeFindings(storyId, {
      findings: [makeFinding(storyId, 'lattice-review-quality', reviewRound, '070', 'RR-smoke')],
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
      agent: 'lattice-review-docs',
    }),
    true,
    'low-severity reviewer pass-only finding should normalize to review pass',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS but README command failed.',
      severity: 'low',
      agent: 'lattice-review-docs',
    }),
    false,
    'ambiguous pass plus failure text must remain a real finding',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: '\u5ba1\u67e5\u901a\u8fc7\uff1a\u5df2\u68c0\u67e5\u8303\u56f4\uff0c\u65e0\u963b\u585e\u95ee\u9898\u3002',
      severity: 'low',
      agent: 'lattice-review-quality',
    }),
    true,
    'localized pass-only reviewer finding should normalize to review pass',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: '\u5ba1\u67e5\u901a\u8fc7\uff0c\u4f46\u4ecd\u7136\u6709\u95ee\u9898\u9700\u8981\u4fee\u590d\u3002',
      severity: 'low',
      agent: 'lattice-review-quality',
    }),
    false,
    'localized pass text with an explicit problem must remain a real finding',
  );
  assert.equal(
    isPassOnlyReviewFindingRecord({
      desc: 'PASS: docs consistency check PASSED.',
      severity: 'medium',
      agent: 'lattice-review-docs',
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-command-policy-'));
  const { store, storyId } = createReviewStore(root);
  const config = {
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    ...configPatch,
  };
  write(root, 'lattice.config.json', JSON.stringify(config));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'lattice@example.test']);
  git(root, ['config', 'user.name', 'Proofbound Smoke']);
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
    assert.match(output, /Replacement: .*lattice validate --story=<storyId>/);
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
    assert.match(output, /Command "finding_add" is not available in DEV phase/);
    assert.match(output, /Lifecycle: gateEvidence/);
    assert.match(output, /Requested phase: DEV/);
    assert.match(output, /Allowed phases: DEV, REVIEW/);
    assert.match(output, /Current phaseTools allow: session_brief, next, (?:done_closure, )?status/);
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

/**
 * B-3740 CHK-003 regression: prove the lifecycle registry's new command +
 * artifact dimensions did NOT change any value derived by phase-flow.ts.
 *
 * phase-flow.ts derives phase ordinals / transition graph purely from
 * LIFECYCLE_TRANSITIONS + the phase lists. The B-3740 extension added the
 * command/artifact dimensions as SEPARATE exported projections, never woven
 * into LIFECYCLE_TRANSITIONS (preMortem #2). This baseline is the hardcoded
 * snapshot of getPhaseInfo / checkPhaseTransition output captured before the
 * extension — any accidental coupling that mutates a derived value fails here.
 */
const PHASE_FLOW_GET_PHASE_INFO_BASELINE: Record<string, ReturnType<typeof getPhaseInfo>> = {
  IDEA: { phase: 'IDEA', ordinal: 1, total: 8, label: 'IDEA', terminal: false, allowedNext: ['INIT', 'PLAN'], allowedRollback: [] },
  INIT: { phase: 'INIT', ordinal: 2, total: 8, label: 'INIT', terminal: false, allowedNext: ['INIT_CHECK'], allowedRollback: [] },
  INIT_CHECK: { phase: 'INIT_CHECK', ordinal: 3, total: 8, label: 'INIT_CHECK', terminal: false, allowedNext: ['PLAN', 'DEV'], allowedRollback: [] },
  PLAN: { phase: 'PLAN', ordinal: 4, total: 8, label: 'PLAN', terminal: false, allowedNext: ['DEV'], allowedRollback: [] },
  DEV: { phase: 'DEV', ordinal: 5, total: 8, label: 'DEV', terminal: false, allowedNext: ['REVIEW'], allowedRollback: ['PLAN'] },
  REVIEW: { phase: 'REVIEW', ordinal: 6, total: 8, label: 'REVIEW', terminal: false, allowedNext: ['TEST'], allowedRollback: ['DEV'] },
  TEST: { phase: 'TEST', ordinal: 7, total: 8, label: 'TEST', terminal: false, allowedNext: ['DONE'], allowedRollback: ['DEV'] },
  DONE: { phase: 'DONE', ordinal: 8, total: 8, label: 'DONE', terminal: true, allowedNext: [], allowedRollback: [] },
  TEST_CASE: { phase: 'TEST_CASE', ordinal: 8, total: 8, label: 'TEST_CASE', terminal: false, allowedNext: ['TEST_CASE_REVIEW'], allowedRollback: ['DEV'] },
  TEST_CASE_REVIEW: { phase: 'TEST_CASE_REVIEW', ordinal: 8, total: 8, label: 'TEST_CASE_REVIEW', terminal: false, allowedNext: ['TEST'], allowedRollback: ['DEV', 'TEST_CASE'] },
  META: { phase: 'META', ordinal: 8, total: 8, label: 'META', terminal: false, allowedNext: [], allowedRollback: [] },
  DISCARDED: { phase: 'DISCARDED', ordinal: 8, total: 8, label: 'DISCARDED', terminal: true, allowedNext: [], allowedRollback: [] },
};

/** sha256 of JSON.stringify(checkPhaseTransition for every ordered phase pair). */
const PHASE_FLOW_TRANSITION_HEALTH_BASELINE_HASH =
  '8cce761d508c5d013bc6962a3052312e89d9b50f69e300b8dd1a3fad3593769f';

function assertPhaseFlowDerivedValuesByteIdentical(): void {
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

function assertStoryAdvanceTestGateFailClosedContracts(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // B-56d3: the TEST gate runner was extracted into handlers/phase-gates.ts.
  // The fail-closed error wording now lives there; the warn-and-advance regex
  // negative-check still covers both files so a relapse anywhere is caught.
  const source = readFileSync(join(root, 'src', 'handlers', 'story-advance.ts'), 'utf-8');
  const phaseGatesSource = readFileSync(join(root, 'src', 'handlers', 'phase-gates.ts'), 'utf-8');
  assert.match(
    phaseGatesSource,
    /Cannot enter TEST: CLI gate preflight execution error/,
    'REVIEW->TEST preflight infrastructure errors must be fail-closed',
  );
  assert.match(
    phaseGatesSource,
    /Cannot enter TEST: lattice validate execution error/,
    'validate execution errors must be fail-closed before entering TEST',
  );
  for (const src of [source, phaseGatesSource]) {
    assert.doesNotMatch(
      src,
      /CLI gate preflight self error \(does not block advancement\)|validate execution failed \(does not block advancement\)/,
      'TEST gate infrastructure errors must not use the old warn-and-advance path',
    );
  }
}

function assertManagedAssetExpandedDocsAndTrueDrift(): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = resolve(packageRoot, '..', '..');
  const current = runManagedAssetCheck(repoRoot, { profile: 'all' });
  const currentById = new Map(current.items.map(item => [item.id, item]));
  const expandedLocalGuideIds = ['doc:.lattice/Lattice.md', 'doc:LATTICE.md', 'doc:CLAUDE.md']
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
    const badRoot = mkdtempSync(join(tmpdir(), 'lattice-managed-drift-'));
    try {
      const badSection = '<!-- lattice:start -->\n# Locally edited guide\nThis is not a Proofbound-owned alternate contract.\n<!-- lattice:end -->\n';
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
    { id: 'doc:.lattice/Lattice.md', relPath: '.lattice/Lattice.md' },
    { id: 'doc:AGENTS.md', relPath: 'AGENTS.md' },
    { id: 'doc:CLAUDE.md', relPath: 'CLAUDE.md' },
  ]);
  assertTrueLocalDrift('full', [
    { id: 'doc:LATTICE.md', relPath: 'LATTICE.md' },
    { id: 'doc:AGENTS.md', relPath: 'AGENTS.md' },
    { id: 'doc:CLAUDE.md', relPath: 'CLAUDE.md' },
  ]);
}

function assertReviewGateUsesOptIn(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-docs',
      'lattice-review-test-coverage',
    ]);
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'lattice-review-concept', reviewRound, '001', runIds.get('lattice-review-concept')!),
        makeFinding(storyId, 'lattice-review-quality', reviewRound, '002', runIds.get('lattice-review-quality')!),
        makeFinding(storyId, 'lattice-review-docs', reviewRound, '003', runIds.get('lattice-review-docs')!),
      ],
    });

    const missing = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missing ?? '', /Expected 3 reviewers \(opt-in: concept,quality,test-coverage\)/);
    assert.match(missing ?? '', /Missing: test-coverage/);
    assert.match(missing ?? '', /lattice-review-docs/);
    assert.doesNotMatch(missing ?? '', /all 5 reviewers/);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'lattice-review-concept', reviewRound, '004', runIds.get('lattice-review-concept')!),
        makeFinding(storyId, 'lattice-review-quality', reviewRound, '005', runIds.get('lattice-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '006', runIds.get('lattice-review-test-coverage')!),
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-review-run-binding-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const agents = [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ];
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, agents);

    const retrofittedLegacyFinding = {
      ...makeLegacyFindingWithoutRun(storyId, 'lattice-review-quality', reviewRound, '045'),
      reviewRunId: runIds.get('lattice-review-quality')!,
    };
    const retrofittedLegacyPass = {
      ...makeLegacyReviewPassWithoutRun(storyId, 'lattice-review-quality', reviewRound, '046'),
      reviewRunId: runIds.get('lattice-review-quality')!,
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
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '047', runIds.get('lattice-review-concept')!),
        retrofittedLegacyPass,
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '048', runIds.get('lattice-review-test-coverage')!),
      ],
    });
    const retrofitState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      retrofitState.invalid.some(issue => issue.code === 'invalid_evidence_signature' && issue.agent === 'lattice-review-quality'),
      true,
      'review-run evidence collection must reject reviewRunId-retrofitted legacy signatures',
    );
    const retrofitFailure = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(retrofitFailure ?? '', /Invalid signature|reviewRunId/, 'review gate must fail retrofitted legacy signatures');
    store.writeFindings(storyId, { findings: [] });

    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '050', runIds.get('lattice-review-concept')!),
        makeLegacyReviewPassWithoutRun(storyId, 'lattice-review-quality', reviewRound, '051'),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '052', runIds.get('lattice-review-test-coverage')!),
      ],
    });
    const missingRun = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(missingRun ?? '', /Missing reviewRunId/, 'current REVIEW evidence without reviewRunId must be rejected');
    const missingRunStatus = summarizeReviewerStatus(store, storyId, root);
    const missingRunByName = new Map(missingRunStatus.entries.map(e => [e.name, e]));
    const qualityStatus = missingRunByName.get('quality');
    assert.equal(qualityStatus?.present, true, 'invalid reviewer evidence should count as present evidence');
    assert.equal(qualityStatus?.verdict, 'fail', 'invalid reviewer evidence must not be shown as pending');
    assert.equal(qualityStatus?.blockerCount, 1, 'invalid reviewer evidence should count as a blocking reviewer issue');
    assert.match(qualityStatus?.detail ?? '', /Missing reviewRunId/);
    assert.equal(missingRunStatus.totalBlockers, 1, 'invalid reviewer evidence should surface in totalBlockers');
    assert.equal(missingRunStatus.allPassed, false);

    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '053', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '054', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '055', runIds.get('lattice-review-test-coverage')!),
      ],
    });
    const wrongLane = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(wrongLane ?? '', /lane=lattice-review-concept/, 'evidence bound to a different reviewer lane must be rejected');

    const runs = store.readReviewRuns(storyId);
    runs.runs[1]._hash = 'tampered-review-run-signature';
    store.writeReviewRuns(storyId, runs);
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '056', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '057', runIds.get('lattice-review-quality')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '058', runIds.get('lattice-review-test-coverage')!),
      ],
    });
    const tamperedRun = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.match(tamperedRun ?? '', /Invalid signature|tampered/, 'tampered review-runs.json signature must be rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSupersededReviewPassDoesNotBlockLatestReviewerRun(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-review-pass-supersede-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const agents = [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ];
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, agents);

    const runsData = store.readReviewRuns(storyId);
    const previousTestCoverageRun = runsData.runs.find(run => run.lane === 'lattice-review-test-coverage');
    assert.ok(previousTestCoverageRun, 'test-coverage run fixture should exist');
    const latestTestCoverageRunId = `${storyId}:RR-004`;
    const latestStartedAt = '2026-04-27T11:03:00.000Z';
    runsData.runs.push({
      ...previousTestCoverageRun,
      reviewRunId: latestTestCoverageRunId,
      startedAt: latestStartedAt,
      _hash: signReviewRun(
        storyId,
        latestTestCoverageRunId,
        previousTestCoverageRun.agent,
        previousTestCoverageRun.lane,
        reviewRound,
        latestStartedAt,
        previousTestCoverageRun.headHash,
        previousTestCoverageRun.materialHash,
        previousTestCoverageRun.promptHash,
      ),
    });
    store.writeReviewRuns(storyId, runsData);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'lattice-review-concept', reviewRound, '061', runIds.get('lattice-review-concept')!),
        makeFinding(storyId, 'lattice-review-quality', reviewRound, '062', runIds.get('lattice-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '063', runIds.get('lattice-review-test-coverage')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '064', latestTestCoverageRunId),
      ],
    });

    const supersededState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      supersededState.invalid.some(issue => issue.kind === 'pass' && issue.code === 'stale_run'),
      false,
      'older review pass should be superseded by a newer valid pass for the same lane',
    );
    assert.equal(getGuardFailureReason(storyId, store, 'TEST', root), null);
    const status = summarizeReviewerStatus(store, storyId, root);
    const byName = new Map(status.entries.map(e => [e.name, e]));
    assert.equal(byName.get('test-coverage')?.verdict, 'pass');
    assert.equal(status.totalBlockers, 0);

    const staleFinding = {
      ...makeFinding(storyId, 'lattice-review-test-coverage', reviewRound, '065', runIds.get('lattice-review-test-coverage')!),
      status: 'open' as const,
    };
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'lattice-review-concept', reviewRound, '066', runIds.get('lattice-review-concept')!),
        makeFinding(storyId, 'lattice-review-quality', reviewRound, '067', runIds.get('lattice-review-quality')!),
        staleFinding,
      ],
    });
    const staleFindingState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      staleFindingState.invalid.some(issue => issue.kind === 'finding' && issue.code === 'stale_run'),
      true,
      'older stale findings must not be hidden by a newer pass for the same lane',
    );
    assert.match(
      getGuardFailureReason(storyId, store, 'TEST', root) ?? '',
      /Not the latest run on the current lane/,
      'supersede logic applies only to stale passes, not stale findings',
    );

    const resolvedStaleFinding = {
      ...staleFinding,
      status: 'resolved' as const,
      resolvedReason: 'fixed and rechecked by latest reviewer run',
      resolvedAt: '2026-04-27T11:04:00.000Z',
    };
    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'lattice-review-concept', reviewRound, '068', runIds.get('lattice-review-concept')!),
        makeFinding(storyId, 'lattice-review-quality', reviewRound, '069', runIds.get('lattice-review-quality')!),
        resolvedStaleFinding,
      ],
    });
    const resolvedStaleFindingState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      resolvedStaleFindingState.invalid.some(issue => issue.kind === 'finding' && issue.code === 'stale_run'),
      false,
      'resolved stale findings should be superseded by a newer valid pass for the same lane',
    );
    assert.equal(getGuardFailureReason(storyId, store, 'TEST', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// B-6c4d regression — the review-run-binding race (friction #2). A second
// review_run_start on a lane (concurrent / retried) mints a newer reviewRunId
// over the SAME material tree; a pass bound to the FIRST run must NOT be
// rejected purely because a newer run exists. The freshness (material /
// storyFilesHash, with the EMPTY-set no-signal guard) + scope checks remain the
// real staleness authorities. This also pins the kind-aware relax: an OPEN
// finding on a non-latest run STILL surfaces (stale_run), and genuine material
// drift / empty-signal runs still hard-reject.
// Build a signed review run captured against the CURRENT git head + material,
// binding the secondary storyFilesHash signal so freshness can exercise both the
// material and storyFilesHash paths. No workspaceBinding: this regression targets
// the id-recency + freshness authorities, not split-root workspace resolution, so
// the run stays workspace-binding-exempt (validateRunWorkspaceBinding passes when
// run.workspaceBinding is absent), matching a metadata-git-root reviewer run.
function signedReviewRunOverHead(
  root: string,
  storyId: string,
  agent: string,
  reviewRound: string,
  reviewRunId: string,
  startedAt: string,
): ReviewRun {
  const headHash = currentGitHead(root)!;
  const materialHash = currentMaterialHash(root)!;
  const storyFilesHash = currentStoryFilesHash(root) ?? undefined;
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
    ...(storyFilesHash ? { storyFilesHash } : {}),
    _hash: signReviewRun(storyId, reviewRunId, agent, agent, reviewRound, startedAt, headHash, materialHash, '', undefined, undefined, storyFilesHash),
  };
}

function assertReviewRunBindingRaceAcceptsNonLatestFreshPass(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-run-binding-race-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story change']);
    resetConfigCache();

    const storyId = 'B-smoke';
    const agent = 'lattice-review-concept';
    const now = '2026-06-24T12:00:00.000Z';
    const reviewRound = '2026-06-24T12:01:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'flow-stability-smoke',
      title: 'Flow stability smoke',
      description: 'Synthetic story for the review-run binding race.',
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
      items: [{ id: 'CHK-001', title: 'item', context: 'ctx', status: 'done', startTime: now, endTime: now }],
    };
    const store = new StoryStore(root);
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    // Two review runs on ONE lane, SAME round + SAME material tree: run1 (older)
    // then run2 (newer). This is the concurrent/retried review_run_start race.
    const run1Id = `${storyId}:RR-001`;
    const run2Id = `${storyId}:RR-002`;
    const run1 = signedReviewRunOverHead(root, storyId, agent, reviewRound, run1Id, '2026-06-24T11:00:00.000Z');
    const run2 = signedReviewRunOverHead(root, storyId, agent, reviewRound, run2Id, '2026-06-24T11:05:00.000Z');
    assert.notEqual(run1.storyFilesHash, EMPTY_STORY_FILES_HASH, 'story-branch run must carry a non-empty storyFilesHash');
    assert.ok(run1.storyFilesHash, 'story-branch run must carry a storyFilesHash');
    store.writeReviewRuns(storyId, { runs: [run1, run2] });

    // CORE: a PASS bound to the NON-latest run1 (material+scope fresh) is ACCEPTED.
    // Pre-fix this threw "is not the current latest reviewer run".
    const accepted = assertCurrentReviewRunForEvidence(store, story, root, agent, run1Id);
    assert.equal(accepted.reviewRunId, run1Id, 'non-latest material-fresh run must be accepted by assertCurrentReviewRunForEvidence');

    // And collectReviewerEvidenceState must NOT flag that pass as an invalid stale_run.
    store.writeReviewPasses(storyId, {
      passes: [makeReviewPass(storyId, agent, reviewRound, '063', run1Id)],
    });
    const passState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      passState.invalid.some(issue => issue.kind === 'pass' && issue.code === 'stale_run' && issue.agent === agent),
      false,
      'a material-fresh pass bound to a non-latest run must not be an invalid stale_run',
    );

    // KIND-AWARE: an OPEN finding bound to the non-latest run1 STILL surfaces as stale_run
    // (it is not silently relaxed by the pass relax — open findings must keep blocking).
    const openFinding = {
      ...makeFinding(storyId, agent, reviewRound, '064', run1Id),
      status: 'open' as const,
    };
    store.writeFindings(storyId, { findings: [openFinding] });
    const findingState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      findingState.invalid.some(issue => issue.kind === 'finding' && issue.code === 'stale_run' && issue.agent === agent),
      true,
      'kind-aware relax must keep stale_run for an OPEN finding bound to a non-latest run',
    );
    assert.match(
      getGuardFailureReason(storyId, store, 'TEST', root) ?? '',
      /Not the latest run on the current lane|stale_run/,
      'open finding still blocks the gate even though the pass is accepted',
    );
    store.writeFindings(storyId, { findings: [] });

    // GUARD B: an empty-set-storyFilesHash run on a drifted material tree must
    // STILL hard-reject — the EMPTY_STORY_FILES_HASH no-signal guard must not let
    // the drift advisory ride an empty story diff. Build run3 against the CURRENT
    // (pre-drift) head but with the empty-set storyFilesHash (the value a HEAD==main
    // run carries), so after the material drift below its material is stale while
    // its storyFilesHash carries no real vouching signal. Constructed before the
    // drift commit so its headHash/materialHash match the captured tree.
    const emptyRunId = `${storyId}:RR-003`;
    const emptyHead = currentGitHead(root)!;
    const emptyMaterial = currentMaterialHash(root)!;
    const emptyRun: ReviewRun = {
      reviewRunId: emptyRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt: '2026-06-24T11:10:00.000Z',
      headHash: emptyHead,
      materialHash: emptyMaterial,
      promptHash: '',
      storyFilesHash: EMPTY_STORY_FILES_HASH,
      _hash: signReviewRun(storyId, emptyRunId, agent, agent, reviewRound, '2026-06-24T11:10:00.000Z', emptyHead, emptyMaterial, '', undefined, undefined, EMPTY_STORY_FILES_HASH),
    };
    assert.equal(emptyRun.storyFilesHash, EMPTY_STORY_FILES_HASH, 'empty-signal run must carry the empty-set storyFilesHash');
    store.writeReviewRuns(storyId, { runs: [run1, run2, emptyRun] });

    // GUARD A: genuine material drift makes both run1 (real story diff) AND the
    // empty-signal run3 stale → hard-reject, never advisory. Committing the story
    // metadata + drift onto the current story branch keeps store.readStory usable
    // (no branch switch, so the story files never leave the working tree).
    write(root, 'packages/main/src/story.ts', 'export const story = 2; // drift\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'material drift']);
    const story2 = store.readStory(storyId);
    assert.throws(
      () => assertCurrentReviewRunForEvidence(store, story2, root, agent, run1Id),
      /stale/i,
      'a genuinely material-drifted run1 (non-empty storyFilesHash) must still hard-reject',
    );
    assert.throws(
      () => assertCurrentReviewRunForEvidence(store, story2, root, agent, emptyRunId),
      /stale/i,
      'an empty-set-storyFilesHash run on a drifted material tree must still hard-reject (EMPTY no-signal guard)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertReviewRunStoryFilesHashBindingIsSigned(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-run-story-files-hash-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story change']);

    const storyId = 'B-smoke';
    const reviewRunId = `${storyId}:RR-001`;
    const agent = 'lattice-review-quality';
    const reviewRound = '2026-06-19T12:00:00.000Z';
    const startedAt = '2026-06-19T12:01:00.000Z';
    const headHash = currentGitHead(root)!;
    const materialHash = currentMaterialHash(root)!;
    const storyFilesHash = currentStoryFilesHash(root)!;
    const workspaceBinding = buildReviewRunWorkspaceBinding({
      metadataRoot: root,
      invocationCwd: root,
      repoRoot: root,
      signedWorkspaceRoot: root,
      workspaceMode: 'metadata-git-root',
      headHash,
      materialHash,
    });
    assert.equal(workspaceBinding.storyFilesHash, storyFilesHash, 'workspace binding must capture storyFilesHash when computable');

    const run: ReviewRun = {
      reviewRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      promptHash: '',
      workspaceBinding,
      _hash: signReviewRun(storyId, reviewRunId, agent, agent, reviewRound, startedAt, headHash, materialHash, '', undefined, workspaceBinding.bindingHash),
    };
    assert.equal(verifyReviewRun(run), true, 'review run with storyFilesHash workspace binding must verify');

    const tampered: ReviewRun = {
      ...run,
      workspaceBinding: {
        ...workspaceBinding,
        storyFilesHash: '0'.repeat(64),
      },
    };
    assert.equal(verifyReviewRun(tampered), false, 'tampering storyFilesHash must invalidate the signed workspace binding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertVerificationEvidenceStoryFilesHashDowngradesUnrelatedDrift(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-verification-story-files-hash-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file']);

    const recordedHead = currentGitHead(root)!;
    const recordedMaterial = currentMaterialHash(root)!;
    const recordedStoryFiles = currentStoryFilesHash(root)!;

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated main file']);
    git(root, ['checkout', 'story/B-smoke']);
    git(root, ['merge', 'main', '--no-edit']);

    const storyId = 'B-smoke';
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Verify story behavior',
        status: 'done',
        startTime: '2026-06-19T12:00:00.000Z',
        endTime: '2026-06-19T12:01:00.000Z',
        verificationIntent: {
          happy: [{ desc: 'story works', type: 'logic', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
        verificationEvidence: [{
          intentRef: 'CHK-001:happy:0',
          kind: 'logic_test',
          command: 'synthetic',
          result: 'pass',
          note: 'synthetic evidence',
          headHash: recordedHead,
          materialHash: recordedMaterial,
          storyFilesHash: recordedStoryFiles,
        }],
      }],
    };

    const coverage = buildVerificationCoverage(
      checklist,
      currentGitHead(root),
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
      { deferredGateEvidence: 'missing' },
    );
    assert.equal(coverage.entries[0]?.status, 'covered', 'matching storyFilesHash must prevent unrelated material drift from marking evidence stale');
    const store = new StoryStore(root);
    store.writeChecklist(storyId, checklist);
    assert.deepEqual(findStaleEvidence(root, storyId), [], 'session stale hint must also honor matching storyFilesHash');
    const freshness = checkEvidenceFreshnessForGit(root, recordedHead, recordedMaterial, root, recordedStoryFiles);
    assert.equal(freshness.fresh, true);
    assert.equal(freshness.warnings?.some(line => line.includes('re-attestation')), true, 'downgraded material drift must expose a re-attestation warning');

    write(root, 'packages/main/src/story.ts', 'export const story = 2;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file changed']);
    const staleCoverage = buildVerificationCoverage(
      checklist,
      currentGitHead(root),
      (headHash, evidence) => checkEvidenceFreshnessForGit(root, headHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
      { deferredGateEvidence: 'missing' },
    );
    assert.equal(staleCoverage.entries[0]?.status, 'stale', 'story-owned file changes must still stale verification evidence');

    const handlers = createChecklistHandlers({ store, root, scanRoot: root });
    const refreshResult = handlers.verification_evidence_refresh_stale({ storyId });
    assert.match(refreshResult, /Refreshed 1\/1 stale evidence/, 'refresh helper should refresh the stale story-owned evidence');
    const refreshed = store.readChecklist(storyId).items[0]?.verificationEvidence?.[0];
    assert.equal(refreshed?.storyFilesHash, currentStoryFilesHash(root), 'refresh helper must preserve the current storyFilesHash binding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertTestEvidenceStoryFilesHashDowngradesActiveDoneFreshness(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-test-evidence-story-files-hash-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file']);

    const recordedHead = currentGitHead(root)!;
    const recordedMaterial = currentMaterialHash(root)!;
    const recordedStoryFiles = currentStoryFilesHash(root)!;

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated main file']);
    git(root, ['checkout', 'story/B-smoke']);
    git(root, ['merge', 'main', '--no-edit']);

    const store = new StoryStore(root);
    const storyId = 'B-smoke';
    const now = '2026-06-19T12:00:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'test-evidence-story-files-hash',
      title: 'Test evidence storyFilesHash smoke',
      description: 'Synthetic story for active DONE evidence freshness.',
      type: 'chore',
      phase: 'TEST',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      events: [],
    });
    store.writeChecklist(storyId, { items: [] });

    const baseEvidence: TestEvidenceData = {
      command: 'lattice validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: now,
      headHash: recordedHead,
      materialHash: recordedMaterial,
    };
    store.writeTestEvidence(storyId, baseEvidence);
    let rows = buildDoneChecklist(storyId, store, root);
    let byId = new Map(rows.map(row => [row.id, row]));
    assert.equal(byId.get('evidence-freshness')?.status, 'fail', 'legacy test-evidence without storyFilesHash must remain strict');
    assert.match(byId.get('evidence-freshness')?.detail ?? '', /materialHash does not match/);

    store.writeTestEvidence(storyId, { ...baseEvidence, storyFilesHash: recordedStoryFiles });
    rows = buildDoneChecklist(storyId, store, root);
    byId = new Map(rows.map(row => [row.id, row]));
    assert.equal(byId.get('evidence-freshness')?.status, 'pass', 'matching storyFilesHash must downgrade unrelated active DONE material drift');
    assert.match(byId.get('evidence-freshness')?.detail ?? '', /re-attestation advisory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function assertReviewPreflightSurfacesStoryFilesHashAdvisories(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-review-preflight-story-files-hash-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      workflow: { profile: 'balanced' },
    }));
    write(root, 'packages/main/src/base.ts', 'export const base = 1;\n');
    git(root, ['init']);
    git(root, ['config', 'user.email', 'flow@example.invalid']);
    git(root, ['config', 'user.name', 'Flow Stability Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-B', 'story/B-smoke']);
    write(root, 'packages/main/src/story.ts', 'export const story = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'story file']);

    const storyId = 'B-smoke';
    const reviewRound = '2026-06-19T12:00:00.000Z';
    const agent = 'lattice-review-quality';
    const reviewRunId = `${storyId}:RR-001`;
    const startedAt = '2026-06-19T12:01:00.000Z';
    const recordedHead = currentGitHead(root)!;
    const recordedMaterial = currentMaterialHash(root)!;
    const recordedStoryFiles = currentStoryFilesHash(root)!;

    git(root, ['checkout', 'main']);
    write(root, 'packages/main/src/unrelated.ts', 'export const unrelated = 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated main file']);
    git(root, ['checkout', 'story/B-smoke']);
    git(root, ['merge', 'main', '--no-edit']);

    const store = new StoryStore(root);
    store.writeStory(storyId, {
      storyId,
      name: 'review-preflight-story-files-hash',
      title: 'Review preflight storyFilesHash smoke',
      description: 'Synthetic story for REVIEW preflight advisory coverage.',
      type: 'chore',
      phase: 'REVIEW',
      priority: 'medium',
      createdAt: reviewRound,
      startedAt: reviewRound,
      endedAt: null,
      currentReviewRound: reviewRound,
      events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
    });
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Fast-channel item',
        context: 'Keep the preflight smoke on the express path.',
        status: 'done',
        startTime: reviewRound,
        endTime: reviewRound,
      }],
    });
    const run: ReviewRun = {
      reviewRunId,
      storyId,
      agent,
      lane: agent,
      reviewRound,
      startedAt,
      headHash: recordedHead,
      materialHash: recordedMaterial,
      storyFilesHash: recordedStoryFiles,
      promptHash: '',
      _hash: signReviewRun(storyId, reviewRunId, agent, agent, reviewRound, startedAt, recordedHead, recordedMaterial, '', undefined, undefined, recordedStoryFiles),
    };
    store.writeReviewRuns(storyId, { runs: [run] });
    store.writeReviewPasses(storyId, {
      passes: [makeReviewPass(storyId, agent, reviewRound, '099', reviewRunId)],
    });

    const preflight = runReviewCliGates(storyId, {
      store,
      projectRoot: root,
      registryNames: new Set(),
    });
    assert.equal(preflight.ok, true, 'storyFilesHash reviewer drift advisory must be non-blocking');
    const advisoryGate = preflight.gates.find(gate => gate.name === 'reviewer-evidence');
    assert.equal(advisoryGate?.status, 'warn');
    const rendered = renderPreflight(preflight);
    assert.match(rendered, /reviewer-evidence freshness: warn/);
    assert.match(rendered, /whole-tree materialHash drift/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-legacy-review-evidence-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const story = store.readStory(storyId);
    delete story.currentReviewRound;
    store.writeStory(storyId, story);
    store.writeReviewPasses(storyId, {
      passes: [makeLegacyReviewPassWithoutRun(storyId, 'lattice-review-quality', reviewRound, '060')],
    });

    const evidenceState = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(evidenceState.invalid.length, 0, 'legacy story without currentReviewRound should not require reviewRunId');
    assert.equal(evidenceState.valid.length, 1, 'legacy signed review pass should remain readable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// B-ad2c F-004 regression: collectReviewerEvidenceState must classify
// reviewer evidence by the lattice-review-* lane prefix, NOT by `agent != main`.
// Otherwise main-agent / lattice-implementer / other non-reviewer actors that
// recorded findings during DEV (e.g. plan-conflict notes) are incorrectly
// treated as reviewer evidence and the missing reviewRunId blocks REVIEW→TEST.
function assertNonReviewerFindingsDoNotCountAsReviewerEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-non-reviewer-evidence-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ]);

    const nonReviewerAgents = ['main', 'main-agent', 'lattice-implementer'];
    const nonReviewerFindings = nonReviewerAgents.map((agent, idx) => {
      const id = `${storyId}:F-${String(900 + idx).padStart(3, '0')}`;
      const createdAt = `2026-04-27T13:00:${String(idx).padStart(2, '0')}.000Z`;
      const desc = `${agent} DEV-phase note without reviewRunId`;
      const severity = 'high';
      return {
        id,
        desc,
        severity: severity as Finding['severity'],
        category: 'missing' as Finding['category'],
        status: 'resolved' as Finding['status'],
        agent,
        createdAt,
        reviewRound,
        _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound),
      };
    });
    store.writeFindings(storyId, { findings: nonReviewerFindings });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '901', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '902', runIds.get('lattice-review-quality')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '903', runIds.get('lattice-review-test-coverage')!),
      ],
    });

    const state = collectReviewerEvidenceState(store, storyId, root);
    for (const agent of nonReviewerAgents) {
      assert.equal(
        state.invalid.some(issue => issue.agent === agent),
        false,
        `non-reviewer agent ${agent} must not appear in reviewer evidence issues (was treated as reviewer)`,
      );
      assert.equal(
        state.valid.some(record => record.agent === agent),
        false,
        `non-reviewer agent ${agent} must not appear in valid reviewer evidence`,
      );
    }
    assert.equal(
      state.invalid.length,
      0,
      `clean reviewer passes + non-reviewer findings should produce no invalid issues, got: ${JSON.stringify(state.invalid)}`,
    );
    assert.equal(
      getGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'REVIEW→TEST gate must pass when only reviewer passes are bound and non-reviewer findings exist',
    );

    // Negative arm: a real lattice-review-* finding without reviewRunId in the
    // current round must STILL be rejected — proves the fix narrowed the
    // classifier but did not weaken the reviewRunId requirement for real lanes.
    const reviewerFindingWithoutRun = makeLegacyFindingWithoutRun(
      storyId,
      'lattice-review-quality',
      reviewRound,
      '910',
    );
    store.writeFindings(storyId, {
      findings: [...nonReviewerFindings, reviewerFindingWithoutRun],
    });
    const stateWithReviewerMiss = collectReviewerEvidenceState(store, storyId, root);
    assert.equal(
      stateWithReviewerMiss.invalid.some(issue =>
        issue.agent === 'lattice-review-quality' && issue.code === 'missing_review_run_id',
      ),
      true,
      'a real lattice-review-* finding without reviewRunId must still raise missing_review_run_id',
    );
    assert.equal(
      stateWithReviewerMiss.invalid.some(issue => issue.agent === 'main-agent'),
      false,
      'main-agent findings must remain excluded even when a reviewer evidence issue is also present',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// B-ad2c F-005 regression: a real story_advance-style guard path
// (machine.ts getGuardFailureReason → canPassReview, the live REVIEW→TEST
// gate) must NOT block when a resolved main-agent finding with EMPTY
// reviewRound (the shape produced by finding_add during DEV, before the
// story has a currentReviewRound) sits alongside complete reviewer-lane
// evidence. F-004 narrowed collectReviewerEvidenceState; F-005 closes the
// last hole: the legacy guard-utils.ts mirror path must classify reviewer
// evidence by lattice-review-* prefix too, not by `agent != main`.
//
// Negative arm: a real lattice-review-* finding without reviewRunId in the
// current round must STILL block the live path — proves the narrowing did
// not weaken the reviewRunId binding requirement for real reviewer lanes.
function assertStoryAdvanceGuardIgnoresMainAgentDevFindings(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-dev-finding-gate-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ]);

    // Mirror live B-ad2c F-001 shape: main-agent authored, status=resolved,
    // high severity, EMPTY reviewRound, no reviewRunId. Signed via the same
    // legacy path that finding_add takes when the story has no currentReviewRound.
    const devFindingId = `${storyId}:F-001`;
    const devCreatedAt = '2026-04-27T13:30:00.000Z';
    const devDesc = 'main-agent DEV-phase replan note (mirrors B-ad2c F-001)';
    const devFinding: Finding = {
      id: devFindingId,
      desc: devDesc,
      severity: 'high',
      category: 'missing',
      status: 'resolved',
      agent: 'main-agent',
      createdAt: devCreatedAt,
      reviewRound: '',
      _hash: signFinding(storyId, devFindingId, devDesc, 'high', devCreatedAt, ''),
    };
    // One bound reviewer finding per opt-in lane — covers the legacy
    // guard-utils.ts gate (which reads findings only, not review passes).
    const reviewerFindings: Finding[] = [
      makeFinding(storyId, 'lattice-review-concept', reviewRound, '821', runIds.get('lattice-review-concept')!),
      makeFinding(storyId, 'lattice-review-quality', reviewRound, '822', runIds.get('lattice-review-quality')!),
      makeFinding(storyId, 'lattice-review-test-coverage', reviewRound, '823', runIds.get('lattice-review-test-coverage')!),
    ];
    store.writeFindings(storyId, { findings: [devFinding, ...reviewerFindings] });
    // Add review passes too — covers machine.ts canPassReview's quorum check
    // which reads valid evidence (findings ∪ passes) from collectReviewerEvidenceState.
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '801', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '802', runIds.get('lattice-review-quality')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '803', runIds.get('lattice-review-test-coverage')!),
      ],
    });

    // Live story_advance guard path (machine.ts) — what `lattice story_advance
    // --phase=TEST` actually calls — must let the transition through.
    assert.equal(
      getGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'machine.ts guard must ignore a main-agent DEV finding with empty reviewRound when reviewer lanes are covered',
    );
    // Legacy guard-utils.ts mirror — no source import today, but it exports
    // the same `getGuardFailureReason` shape and must stay in sync so future
    // code that wires it back in inherits the same isReviewerAgent
    // classification. Without the F-005 fix this returned a "Cannot enter
    // TEST" reason because main-agent F-001 was misclassified as a reviewer
    // finding that lacked a current-round reviewRound.
    assert.equal(
      legacyGetGuardFailureReason(storyId, store, 'TEST', root),
      null,
      'guard-utils.ts mirror must ignore a main-agent DEV finding with empty reviewRound when reviewer lanes are covered',
    );

    // Negative arm: a real lattice-review-* finding in the current round with
    // no reviewRunId must still block the live path — the narrowing only
    // changed agent classification, not the reviewRunId binding contract for
    // real reviewer lanes.
    const reviewerMiss = makeLegacyFindingWithoutRun(
      storyId,
      'lattice-review-quality',
      reviewRound,
      '811',
    );
    store.writeFindings(storyId, { findings: [devFinding, ...reviewerFindings, reviewerMiss] });
    const liveBlocked = getGuardFailureReason(storyId, store, 'TEST', root);
    assert.ok(
      liveBlocked && /Cannot enter TEST/.test(liveBlocked),
      `machine.ts guard must still block when a real lattice-review-* finding lacks reviewRunId, got: ${liveBlocked}`,
    );
    assert.ok(
      liveBlocked && /missing_review_run_id|reviewer evidence/.test(liveBlocked),
      `machine.ts block reason should reference the reviewRunId binding, got: ${liveBlocked}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function assertStoryAdvanceReviewEchoOmitsRetiredChannel(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-review-echo-'));
  const oldCwd = process.cwd();
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    story.currentReviewRound = undefined;
    story.events = [{ phase: 'DEV', action: 'advance', timestamp: '2026-04-27T12:02:00.000Z' }];
    store.writeStory(storyId, story);

    process.chdir(root);
    const output = await createStoryAdvanceHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).story_advance({ storyId, phase: 'REVIEW' });

    assert.match(output, /Active reviewers: concept, quality, test-coverage/);
    assert.doesNotMatch(output, /lattice-review-channel/);
    assert.doesNotMatch(output, /channel \(normal channel\)/);
  } finally {
    process.chdir(oldCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function assertReviewerStatusUsesMdFallback(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-doc-review-'));
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
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'docs/review-notes.md', '# Review notes\n\nDocs changed in story branch.\n');
    git(root, ['add', 'docs/review-notes.md']);
    git(root, ['commit', '-m', 'docs change']);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ]);

    store.writeFindings(storyId, {
      findings: [
        makeFinding(storyId, 'lattice-review-concept', reviewRound, '010', runIds.get('lattice-review-concept')!),
        makeFinding(storyId, 'lattice-review-quality', reviewRound, '011', runIds.get('lattice-review-quality')!),
      ],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '012', runIds.get('lattice-review-test-coverage')!),
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
    assert.match(reviewBrief, /<reviewRunId from lattice review_run_start>/, 'REVIEW anti-stall should not imply a hard-coded reviewRunId');
    assert.doesNotMatch(reviewBrief, /:RR-001/, 'REVIEW anti-stall must not hard-code a synthetic reviewRunId');

    const contract = getArtifactContractStatus(store, storyId, 'TEST', { projectRoot: root });
    const findingsClear = contract.entries.find(entry => entry.name === 'findings-clear');
    assert.equal(findingsClear?.present, false, 'artifact contract should use the same docs reviewer fallback as status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertSessionBriefStatusHintsMatchGates(): void {
  const reviewRoot = mkdtempSync(join(tmpdir(), 'lattice-flow-session-review-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(reviewRoot);
    git(reviewRoot, ['init']);
    git(reviewRoot, ['config', 'user.email', 'lattice@example.test']);
    git(reviewRoot, ['config', 'user.name', 'Proofbound Smoke']);
    git(reviewRoot, ['checkout', '-B', 'main']);
    git(reviewRoot, ['add', '.']);
    git(reviewRoot, ['commit', '-m', 'base']);
    git(reviewRoot, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(reviewRoot, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
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
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '020', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '021', runIds.get('lattice-review-quality')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '022', runIds.get('lattice-review-test-coverage')!),
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
    assert.match(reviewNext, /All reviewer gates passed/);
    assert.match(reviewNext, /phase=TEST/);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    const evidence: TestEvidenceData = {
      command: 'lattice validate --json',
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
    assert.match(testBrief, /DONE pre-check still has/);
    // B-4b22: lattice_metadata_changes is a passing category, so the git-working-tree
    // row now reports PASS with "pass: blocking=0 ...; passed=N (lattice_metadata_changes=N)".
    // The LATTICE_WRITE side-effect hint only appears when the row fails, so it is
    // no longer asserted here. session_brief still surfaces "Working tree dirty
    // (N files)" because dirt exists even when policy allows it.
    assert.match(testBrief, /\[PASS\] git working tree/);
    assert.match(testBrief, /pass: blocking=0/);
    assert.match(testBrief, /lattice_metadata_changes/);
    assert.match(testBrief, /Working tree dirty/);
    assert.match(testBrief, /delivery_check_set/);
    assert.match(testBrief, /agentId=lattice-review-delivery/);
    assert.match(testBrief, /main agent must not self-sign/);
    assert.match(testBrief, /summary_set/);
    // B-4b22: lattice_metadata-only pollution passes via dirty-gate-policy, so
    // git-working-tree no longer appears in the blocked-row list.
    assert.match(nextStep, /delivery-check, story-summary/);
    assert.match(nextStep, /After all pass, run lattice story_advance --phase=DONE/);
    assert.match(testBrief, /After all pass, run lattice story_advance --phase=DONE/);
    assert.doesNotMatch(testBrief, /Next step: story_advance --storyId=B-smoke --phase=DONE/);
    assert.doesNotMatch(testBrief, /Next step: first git add \+ git commit to commit all changes, then advance DONE/);
  } finally {
    rmSync(reviewRoot, { recursive: true, force: true });
  }
}

function assertReviewNextUsesReviewerGateState(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-review-next-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ]);

    const handlers = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const pendingNext = handlers.next({ concise: true });
    assert.match(pendingNext, /Waiting for reviewer evidence/);
    assert.match(pendingNext, /story-review/);
    assert.match(pendingNext, /concept/);
    assert.match(pendingNext, /quality/);
    assert.match(pendingNext, /test-coverage/);
    assert.doesNotMatch(pendingNext, /channel/);
    assert.doesNotMatch(pendingNext, /All critical\/high findings resolved/);

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
        agent: 'lattice-review-concept',
        createdAt,
        reviewRound,
        reviewRunId: runIds.get('lattice-review-concept')!,
        _hash: signFinding(storyId, id, desc, severity, createdAt, reviewRound, runIds.get('lattice-review-concept')!),
      }],
    });
    store.writeReviewPasses(storyId, {
      passes: [
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '041', runIds.get('lattice-review-quality')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '042', runIds.get('lattice-review-test-coverage')!),
      ],
    });
    const blockerNext = handlers.next({ concise: true });
    assert.match(blockerNext, /1 blocking finding/);
    assert.match(blockerNext, /concept\(1\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDevGuidanceUsesReviewPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-dev-guidance-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
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
    assert.doesNotMatch(brief, /enter verification via phase=TEST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertValidateHintsFollowStoryPhase(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-validate-hint-'));
  try {
    const { store, storyId } = createReviewStore(root);
    const result = JSON.stringify({ provider: 'lattice-verifier', allPass: true });
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-real-cli-validate-'));
  try {
    const { store, storyId } = createReviewStore(root);
    write(root, 'validate-smoke.js', 'console.log(JSON.stringify({ provider: "smoke", status: "pass", allPass: true, summary: "ok", details: [] }));\n');
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      validate: { command: 'node validate-smoke.js' },
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const story = store.readStory(storyId);
    story.phase = 'DEV';
    store.writeStory(storyId, story);

    // B-7fc2 keeps --json stdout machine-parseable, so human next-step hints
    // are intentionally text-mode only. This flow assertion covers that the
    // real CLI hint still follows the active story phase; JSON purity is
    // covered separately by cli-json-stdout-contract-smoke.
    const output = execFileSync('node', [localCliPath(), 'validate'], {
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-bug-hint-'));
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
    assert.doesNotMatch(output, /Next step: story_advance --storyId=.*--phase=DONE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateRejectsLatticeSubjectForRealFiles(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-channel-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
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
      '-m', 'lattice: implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /missing dispatch\/subagent_result evidence/);
    assert.match(result.summary, /cannot be used as author fallback/);
    assert.match(result.details.join('\n'), /lattice: implement real code/);
    assert.match(result.details.join('\n'), /normal channel primary evidence must be dispatch\/subagent_result/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-channel-shared-author-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
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
    assert.match(result.summary, /structured evidence coverage complete/);
    assert.match(result.details.join('\n'), /commit author advisory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsImplementerAuthorWithoutDispatch(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-channel-author-fallback-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=lattice-implementer',
      '-c', 'user.email=implementer@example.test',
      'commit',
      '-m', 'implement real code',
    ]);

    const result = checkCommitAuthor(storyId, { store, projectRoot: root });
    assert.equal(result.status, 'pass');
    assert.equal(result.evidenceSource, 'commit_author');
    assert.match(result.summary, /commit author as direct-dispatch execution evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsSuccessfulSubagentResultEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-channel-subagent-evidence-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=lattice-implementer',
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
    assert.match(renderedDetails(result), /Covered: CHK-001, CHK-002, CHK-003/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertChannelGateAcceptsDispatchEvidence(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-channel-dispatch-evidence-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    write(root, 'packages/main/src/real-code.ts', 'export const realCode = true;\n');
    git(root, ['add', 'packages/main/src/real-code.ts']);
    git(root, [
      '-c', 'user.name=lattice-implementer',
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
    assert.match(renderedDetails(result), /Covered: CHK-001, CHK-002, CHK-003/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function renderedDetails(result: { details: string[] }): string {
  return result.details.join('\n');
}

function assertDoneChecklistUsesStableOracleRows(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-oracle-row-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    const runIds = seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
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
        makeReviewPass(storyId, 'lattice-review-concept', reviewRound, '030', runIds.get('lattice-review-concept')!),
        makeReviewPass(storyId, 'lattice-review-quality', reviewRound, '031', runIds.get('lattice-review-quality')!),
        makeReviewPass(storyId, 'lattice-review-test-coverage', reviewRound, '032', runIds.get('lattice-review-test-coverage')!),
      ],
    });
    const evidence: TestEvidenceData = {
      command: 'lattice validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-04-27T12:25:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);
    write(root, 'packages/main/src/core/dirty.ts', 'export const dirty = true;\n');
    write(root, '.lattice/activity.jsonl', '{"event":"runtime"}\n');
    write(root, '.lattice/story/actives/B-smoke/dirty-owner.json', '{}\n');
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
    // B-4b22: detail now follows the policy summary format:
    //   "fail: blocking=N (...); passed=M (...)"
    assert.match(byId.get('git-working-tree')?.detail ?? '', /^fail: blocking=/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /passed=/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /lattice_metadata_changes=/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /runtime_artifact_changes=1/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /fixture_changes=1/);
    assert.match(byId.get('git-working-tree')?.detail ?? '', /unexpected_dirty_files=1/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /packages\/main\/src\/core\/dirty\.ts/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /material_source_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /lattice_metadata_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /runtime_artifact_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /fixture_changes/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /unexpected_dirty_files/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /packages\/main\/tests\/output\/bl21_lacz_ecoli_minicell\/prodenovo_viewer\.json/);
    assert.match(byId.get('git-working-tree')?.hint ?? '', /side-effect-free by default|side-effect-free|LATTICE_WRITE/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /delivery_check_set/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /agentId=lattice-review-delivery/);
    assert.match(byId.get('delivery-check')?.hint ?? '', /main agent must not self-sign/);
    assert.equal(byId.get('delivery-check')?.source, 'delivery-check.json');
    assert.equal(byId.get('story-summary')?.status, 'fail');
    assert.equal(byId.get('story-summary')?.source, 'summary.json');
    assert.equal(byId.get('story-summary')?.blocking, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertDoneClosureProjectionSeparatesAuthority(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-closure-projection-'));
  try {
    const { store, storyId } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    store.writeTestEvidence(storyId, {
      command: 'lattice validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-05-15T12:25:00.000Z',
      headHash: currentGitHead(root),
      materialHash: currentMaterialHash(root),
      verificationCoverage: {
        total: 0,
        required: 0,
        covered: 0,
        missingRequired: 0,
        entries: [],
      },
    });

    const runbook = buildDoneClosureRunbook({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }, storyId);
    const byId = new Map(runbook.blockers.map(row => [row.id, row]));

    assert.equal(runbook.schemaVersion, 'lattice.done_closure.v1');
    assert.equal(runbook.phase, 'TEST');
    assert.equal(runbook.canAttemptDone, false, 'TEST PASS with missing closure artifacts must not be DONE-ready');
    assert.equal(byId.get('test-evidence')?.status, 'pass');
    assert.equal(byId.get('delivery-check')?.status, 'fail', 'missing delivery-check must be projected as blocking');
    assert.equal(byId.get('story-summary')?.status, 'fail', 'missing summary must be projected as blocking');
    assert.equal(runbook.localNonAuthorityAudit.status, 'blocked');
    assert.equal(runbook.localAssurance.admissibilityStatus, 'blocked');
    assert.equal(runbook.localAssurance.assuranceLevel, 'local');
    assert.equal(JSON.stringify(runbook).includes('"authorityDone":true'), false);
    assert.equal(JSON.stringify(runbook).includes('"productionDone":true'), false);
    assert.equal(JSON.stringify(runbook).includes('"fullAuthorityDone":true'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

function assertGlobalLinkRepair(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-flow-link-'));
  try {
    const mainRepo = join(root, 'repo');
    const worktree = join(root, 'repo', '.worktrees', 'B-smoke');
    const worktreePackage = join(worktree, 'packages', 'main');
    const mainPackage = join(mainRepo, 'packages', 'main');
    const globalPackage = join(root, 'global', 'node_modules', '@lattice', 'core');
    mkdirSync(worktreePackage, { recursive: true });
    mkdirSync(mainPackage, { recursive: true });
    mkdirSync(dirname(globalPackage), { recursive: true });
    symlinkSync(worktreePackage, globalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    const repaired = repairGlobalLatticeLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: globalPackage });
    assert.equal(repaired.action, 'relinked');
    assert.equal(lstatSync(globalPackage).isSymbolicLink(), true);
    assert.equal(resolve(dirname(globalPackage), readlinkSync(globalPackage)), resolve(mainPackage));

    const otherPackage = join(root, 'other', 'packages', 'main');
    const otherGlobalPackage = join(root, 'other-global', 'node_modules', '@legacy-agent', 'core');
    mkdirSync(otherPackage, { recursive: true });
    mkdirSync(dirname(otherGlobalPackage), { recursive: true });
    symlinkSync(otherPackage, otherGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');
    const skipped = repairGlobalLatticeLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: otherGlobalPackage });
    assert.equal(skipped.action, 'skipped');
    assert.equal(resolve(dirname(otherGlobalPackage), readlinkSync(otherGlobalPackage)), resolve(otherPackage));

    const normalInstall = join(root, 'normal-global', 'node_modules', '@legacy-agent', 'core');
    mkdirSync(normalInstall, { recursive: true });
    const normalSkipped = repairGlobalLatticeLinkBeforeWorktreeDelete(worktree, mainRepo, { globalPackagePath: normalInstall });
    assert.equal(normalSkipped.action, 'skipped');
    assert.equal(existsSync(normalInstall), true);
    assert.equal(lstatSync(normalInstall).isDirectory(), true);

    const failingGlobalPackage = join(root, 'failing-global', 'node_modules', '@legacy-agent', 'core');
    mkdirSync(dirname(failingGlobalPackage), { recursive: true });
    symlinkSync(worktreePackage, failingGlobalPackage, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => repairGlobalLatticeLinkBeforeWorktreeDelete(worktree, mainRepo, {
        globalPackagePath: failingGlobalPackage,
        unlinkImpl: () => {
          throw new Error('mock unlink failure');
        },
      }),
      /Blocked deletion of .*mock unlink failure/,
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
  const root = mkdtempSync(join(tmpdir(), 'lattice-auto-commit-'));
  // Init git repo + initial commit on main so branch checkout works
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  gitConfig(root, 'user.email', 'smoke@lattice.test');
  gitConfig(root, 'user.name', 'smoke');
  gitConfig(root, 'commit.gpgsign', 'false');
  // lattice.config.json so loadConfig picks our story dir
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  resetConfigCache();
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return { root, storyId: 'B-test1' };
}

function writeFakeMetadata(root: string, storyId: string, content = '{"x":1}'): void {
  write(root, `.lattice/story/actives/${storyId}/findings.json`, content);
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
      assert.match(out, /lattice: record B-test1 finding_add metadata/);
      assert.match(out, /\([0-9a-f]{7}\)/, 'auto-commit hint must include short sha (7 hex chars)');
      assert.equal(gitCommitCount(root), commitsBefore + 1);
      assert.match(gitLastSubject(root), /^lattice: record B-test1 finding_add metadata$/);
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
      assert.match(out, /lattice: record B-test1 review_pass_set metadata/);
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
      assert.equal(classification.groups.lattice_metadata_changes.length, 0, 'metadata category must be empty after auto-commit');
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

  // Test 6 (non-git temp root): validation/e2e fixtures that are not git
  // repos should return '' and should not create mutation:storyMetadataCommit
  // health noise.
  {
    const root = mkdtempSync(join(tmpdir(), 'lattice-auto-commit-nongit-'));
    const previousHealthPath = process.env.LATTICE_HEALTH_PATH;
    process.env.LATTICE_HEALTH_PATH = join(root, 'health.jsonl');
    try {
      writeFakeMetadata(root, 'B-test1');
      const out = autoCommitStoryMetadata(root, 'B-test1', 'artifact_declare');
      assert.equal(out, '', `non-git roots should be treated as non-story workspaces; got: ${JSON.stringify(out)}`);
      assert.equal(
        readHealthIssues().filter(issue => issue.category === 'mutation:storyMetadataCommit').length,
        0,
        'non-git roots must not produce mutation:storyMetadataCommit health issues',
      );
    } finally {
      if (previousHealthPath === undefined) delete process.env.LATTICE_HEALTH_PATH;
      else process.env.LATTICE_HEALTH_PATH = previousHealthPath;
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 7 (real git failure): once inside a story/* checkout, staging/commit
  // failures remain health-reportable mutation failures.
  {
    const { root, storyId } = setupAutoCommitFixture();
    const previousHealthPath = process.env.LATTICE_HEALTH_PATH;
    process.env.LATTICE_HEALTH_PATH = join(root, 'health.jsonl');
    try {
      gitCheckoutNewBranch(root, `story/${storyId}`);
      writeFakeMetadata(root, storyId);
      writeFileSync(join(root, '.git', 'index.lock'), 'locked');
      const out = autoCommitStoryMetadata(root, storyId, 'finding_add');
      assert.match(out, /lattice metadata auto-commit failed/, 'real git failures still return the user-visible warning');
      const issues = readHealthIssues().filter(issue => issue.category === 'mutation:storyMetadataCommit');
      assert.equal(issues.length, 1, 'real git checkout failures still produce one metadata health issue');
      assert.equal(issues[0].context.storyId, storyId);
      assert.equal(issues[0].context.reason, 'finding_add');
      assert.equal(issues[0].context.projectRoot, root);
    } finally {
      rmSync(join(root, '.git', 'index.lock'), { force: true });
      if (previousHealthPath === undefined) delete process.env.LATTICE_HEALTH_PATH;
      else process.env.LATTICE_HEALTH_PATH = previousHealthPath;
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 8 (path broaden): non-canonical storyId form throws synchronously
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

  // Test 9 (prefix vocabulary parity with story-advance precedent — CHK-003
  // adversarial: byte-equal prefix `\n✓ lattice metadata auto-committed:`).
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
        'user-visible prefix must be byte-equal `\\n✓ lattice metadata auto-committed:`',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Test 10 (3+ handler reasons covered — CHK-004 happy): the same fixture +
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
        assert.match(out, new RegExp(`lattice: record B-test1 ${reason} metadata`));
        assert.match(gitLastSubject(root), new RegExp(`^lattice: record B-test1 ${reason} metadata$`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  // Test 11 (classifier parity — CHK-004 adversarial): classifyDirtyWorktree
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
      assert.equal(after.groups.lattice_metadata_changes.length, 0, 'metadata category drains to zero after auto-commit');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * B-cf60 CHK-004: regression coverage for the per-story declared-artifact channel.
 *
 * Covers four scenarios (happy/edge/adversarial intents from the checklist):
 *   1. happy: declare a path → classifier groups it as declared_artifact_changes
 *   2. happy: same path WITHOUT declaration → classifier keeps it as unexpected_dirty_files
 *   3. edge: declare malicious paths (`*`, `..`, leading `/`) → handler throws
 *   4. adversarial: DONE gate fn evaluateDeclaredArtifactReferences with
 *      matching / unreferenced / mixed inputs.
 *
 * Uses the BL21 lacZ minicell viewer path literal from the field report so a
 * future refactor cannot accidentally silence the smoke without renaming the
 * regression target.
 */
function assertDeclaredArtifactsChannel(): void {
  const BL21 = 'packages/main/tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json';
  const root = mkdtempSync(join(tmpdir(), 'lattice-declared-artifacts-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();
    const store = new StoryStore(root);

    // Seed a story so artifact_declare's storyExists check passes.
    const storyId = 'B-cftest';
    const now = '2026-05-15T18:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'declared-artifacts-smoke',
      title: 'Declared artifacts smoke',
      description: 'Per-story declared product artifact registration regression.',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    };
    const checklist: ChecklistData = {
      items: [{
        id: 'CHK-001',
        title: 'Declared item',
        context: 'happy intent for the BL21 viewer.',
        status: 'done',
        startTime: now,
        endTime: now,
        verificationIntent: {
          happy: [{ desc: 'cli regenerates viewer', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);

    const handlers = createArtifactDeclareHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });

    // === Scenario 1 (happy): declare → classifier groups as declared_artifact_changes ===
    handlers.artifact_declare({
      storyId,
      path: BL21,
      reason: 'BL21 lacZ minicell viewer regenerated for verification',
      relatedIntent: 'CHK-001:happy:0',
    });
    const config = loadConfig(root);
    const dirtyLines = [`?? ${BL21}`];
    const declared = classifyGitStatusRows(
      dirtyLines,
      dirtyWorktreeClassifierOptionsForStory(config, storyId, store),
    );
    assert.equal(
      declared.groups.declared_artifact_changes.length,
      1,
      'declared artifact must land in declared_artifact_changes when story declared it',
    );
    assert.equal(declared.groups.declared_artifact_changes[0].path, BL21);
    assert.equal(
      declared.groups.unexpected_dirty_files.length,
      0,
      'declared path must not leak into unexpected_dirty_files',
    );

    // === Scenario 2 (happy): same path WITHOUT declaration → unexpected_dirty_files ===
    const undeclared = classifyGitStatusRows(
      dirtyLines,
      dirtyWorktreeClassifierOptionsFromConfig(config),
    );
    assert.equal(
      undeclared.groups.declared_artifact_changes.length,
      0,
      'without per-story injection the declared_artifact_changes category must stay empty',
    );
    assert.equal(undeclared.groups.unexpected_dirty_files.length, 1, 'BL21 viewer falls through to unexpected by default');
    assert.equal(undeclared.groups.unexpected_dirty_files[0].path, BL21);

    // === Scenario 2b: a sibling undeclared path under same prefix STAYS unexpected ===
    const sibling = `${BL21.replace('prodenovo_viewer.json', 'other_snapshot.json')}`;
    const mixedDirty = [`?? ${BL21}`, `?? ${sibling}`];
    const mixed = classifyGitStatusRows(
      mixedDirty,
      dirtyWorktreeClassifierOptionsForStory(config, storyId, store),
    );
    assert.equal(mixed.groups.declared_artifact_changes.length, 1, 'only the declared path flips category');
    assert.equal(mixed.groups.declared_artifact_changes[0].path, BL21);
    assert.equal(mixed.groups.unexpected_dirty_files.length, 1, 'sibling path stays in unexpected_dirty_files');
    assert.equal(mixed.groups.unexpected_dirty_files[0].path, sibling);

    // === Scenario 3 (edge/adversarial): malicious paths throw ===
    const malicious: string[] = [
      'tests/output/*',
      'tests/output/**/*.json',
      '../escape.json',
      'tests/output/../escape.json',
      '/abs/path.json',
      'tests/output/foo?.json',
      'tests/output/[abc].json',
    ];
    for (const evil of malicious) {
      assert.throws(
        () => handlers.artifact_declare({
          storyId,
          path: evil,
          reason: 'should not be allowed in any case',
          relatedIntent: 'CHK-001:happy:0',
        }),
        /artifact_declare: path /,
        `path ${JSON.stringify(evil)} must be rejected`,
      );
    }

    // === Scenario 3b: bad relatedIntent shape also throws ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: 'tests/output/some.json',
        reason: 'reason text long enough',
        relatedIntent: 'not-a-valid-ref',
      }),
      /relatedIntent must match/,
      'malformed relatedIntent must be rejected at handler entry',
    );

    // === Scenario 4 (adversarial): DONE gate reference checker ===
    // (a) matching → no unreferenced.
    const checklistData = store.readChecklist(storyId);
    const declaredEntries = store.readDeclaredArtifacts(storyId);
    const matchedResult = evaluateDeclaredArtifactReferences(declaredEntries, checklistData, null);
    assert.equal(matchedResult.total, 1);
    assert.equal(matchedResult.unreferenced.length, 0, 'CHK-001:happy:0 matches the seeded verificationIntent slot');

    // (b) bogus intentRef → unreferenced.
    handlers.artifact_declare({
      storyId,
      path: 'tests/output/bogus.json',
      reason: 'second declaration with bogus ref for gate adversarial test',
      relatedIntent: 'CHK-999:happy:0',
    });
    const withBogus = store.readDeclaredArtifacts(storyId);
    const bogusResult = evaluateDeclaredArtifactReferences(withBogus, checklistData, null);
    assert.equal(bogusResult.total, 2);
    assert.equal(bogusResult.unreferenced.length, 1, 'CHK-999:happy:0 has no matching checklist item');
    assert.equal(bogusResult.unreferenced[0].relatedIntent, 'CHK-999:happy:0');

    // (c) coexisting matching + unreferenced still reports the unreferenced (1 is enough to block).
    const coexistResult = evaluateDeclaredArtifactReferences(withBogus, checklistData, null);
    assert.ok(coexistResult.unreferenced.length >= 1, 'at least one unreferenced entry must surface');

    // === Scenario 5: idempotency — re-declare same path overwrites entry.
    //     Run BEFORE the promise: stub block since that block rewrites the file.
    const beforeIdem = store.readDeclaredArtifacts(storyId);
    const idemOut = handlers.artifact_declare({
      storyId,
      path: BL21,
      reason: 'BL21 lacZ minicell viewer regenerated for verification (rewrite)',
      relatedIntent: 'CHK-001:happy:0',
    });
    assert.match(idemOut, /overwritten/, 'second declaration of same path must mention overwrite');
    const afterIdem = store.readDeclaredArtifacts(storyId);
    assert.equal(afterIdem.entries.length, beforeIdem.entries.length, 're-declaring same path must not duplicate entries');

    // (d) promise:<docPath> ref resolves when delivery-check.docsPromises contains the docPath.
    //     Use a separate store rooted at a fresh temp dir so we don't trample
    //     the previous-scenario fixtures.
    const promiseRoot = mkdtempSync(join(tmpdir(), 'lattice-declared-artifacts-promise-'));
    try {
      write(promiseRoot, 'lattice.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        testsDir: 'packages/main/tests',
        fixturesDir: 'packages/main/tests/fixtures',
        storyDir: '.lattice/story/actives',
        requirementsDir: 'docs/requirements',
      }));
      resetConfigCache();
      const promiseStore = new StoryStore(promiseRoot);
      promiseStore.writeStory(storyId, story);
      promiseStore.writeChecklist(storyId, checklist);
      promiseStore.writeDeclaredArtifacts(storyId, {
        entries: [{
          path: 'tests/output/with-promise.json',
          reason: 'promise ref smoke entry',
          relatedIntent: 'promise:CLAUDE.md#section-foo',
          declaredAt: now,
        }],
      });
      const declaredPromiseOnly = promiseStore.readDeclaredArtifacts(storyId);
      const deliveryStub = {
        storyId,
        checkedAt: now,
        reviewRound: now,
        agentId: 'lattice-review-delivery',
        docsPromises: [{ docPath: 'CLAUDE.md#section-foo', promise: 'doc promise', verifiedBy: 'grep', evidence: 'observed' }],
        realMachineTests: [],
        closingSelfCheck: { hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false, summary: 'ok summary text' },
        _hash: 'stub',
      };
      const promiseResult = evaluateDeclaredArtifactReferences(declaredPromiseOnly, null, deliveryStub);
      assert.equal(promiseResult.unreferenced.length, 0, 'promise:<docPath> ref must resolve via delivery-check docsPromises');
    } finally {
      rmSync(promiseRoot, { recursive: true, force: true });
      resetConfigCache();
    }

    // (e) empty entries → zero unreferenced, gate caller treats as informational.
    const emptyResult = evaluateDeclaredArtifactReferences({ entries: [] }, checklistData, null);
    assert.equal(emptyResult.total, 0);
    assert.equal(emptyResult.unreferenced.length, 0, 'empty declared-artifacts must not synthesize blockers');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B-8db9 CHK-004: regression coverage for the declared-artifact gate-bypass
 * attack chain (CRITICAL classifier reorder + entry rejection + HIGH DONE
 * committed-check).
 *
 * Uses the literal attack path `packages/main/src/core/store.ts` and a
 * `tests/output/` generated path so a future refactor cannot silence the
 * regression without renaming the attack target.
 */
function assertDeclaredArtifactGateHotfix(): void {
  const ATTACK_SOURCE = 'packages/main/src/core/store.ts';
  const FIXTURE_PATH = 'packages/main/tests/fixtures/sample-fixture.json';
  const GENERATED_OUTPUT = 'packages/main/tests/output/declared-generated.json';
  const root = mkdtempSync(join(tmpdir(), 'lattice-declared-gate-hotfix-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-hotfix';
    const now = '2026-05-15T21:00:00.000Z';
    const story: StoryInfo = {
      storyId,
      name: 'declared-gate-hotfix-smoke',
      title: 'Declared gate hotfix smoke',
      description: 'Attack-chain regression for the declared-artifact gate bypass.',
      type: 'chore',
      phase: 'DEV',
      priority: 'high',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    };
    store.writeStory(storyId, story);

    const handlers = createArtifactDeclareHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    });
    const config = loadConfig(root);

    // === CHK-002: artifact_declare rejects material source path ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: ATTACK_SOURCE,
        reason: 'attacker tries to declare a dirty source file',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as material_source_changes and cannot be declared/,
      'artifact_declare must reject packages/main/src/core/store.ts',
    );
    // === CHK-002: artifact_declare rejects fixture path ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: FIXTURE_PATH,
        reason: 'attacker tries to declare a fixture file',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as fixture_changes and cannot be declared/,
      'artifact_declare must reject a fixture path',
    );
    // === CHK-002: artifact_declare rejects config / lattice-metadata paths ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: 'CLAUDE.md',
        reason: 'attacker tries to declare a config doc',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as material_source_changes and cannot be declared/,
      'artifact_declare must reject a config path (materialSourceFiles)',
    );
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: '.lattice/story/actives/B-hotfix/index.json',
        reason: 'attacker tries to declare lattice metadata',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /classifies as lattice_metadata_changes and cannot be declared/,
      'artifact_declare must reject a lattice-metadata path',
    );
    // === CHK-002 (B-8db9 F-002): artifact_declare rejects a runtime artifact path ===
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: '.lattice/activity.jsonl',
        reason: 'attacker tries to declare a runtime activity log',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /is a runtime artifact, already handled by runtime-artifact-registry/,
      'artifact_declare must reject a runtime artifact path (.lattice/activity.jsonl)',
    );
    assert.throws(
      () => handlers.artifact_declare({
        storyId,
        path: '.lattice-serve.json',
        reason: 'attacker tries to declare the dev-server handshake file',
        relatedIntent: 'CHK-001:happy:0',
      }),
      /is a runtime artifact, already handled by runtime-artifact-registry/,
      'artifact_declare must reject a runtime artifact path (.lattice-serve.json)',
    );
    // === CHK-002 happy: a tests/output/ generated path is declarable ===
    handlers.artifact_declare({
      storyId,
      path: GENERATED_OUTPUT,
      reason: 'legitimate generated output declared for verification',
      relatedIntent: 'CHK-001:happy:0',
    });
    assert.equal(
      store.readDeclaredArtifacts(storyId).entries.some(e => e.path === GENERATED_OUTPUT),
      true,
      'a tests/output/ generated path must be declarable',
    );

    // === CHK-001 hard gate: hand-inject a declared-artifacts.json with the
    //     attack source path (NOT via artifact_declare) — the classifier must
    //     still group the dirty source file as material_source_changes. ===
    store.writeDeclaredArtifacts(storyId, {
      entries: [
        { path: GENERATED_OUTPUT, reason: 'generated output', relatedIntent: 'CHK-001:happy:0', declaredAt: now },
        { path: ATTACK_SOURCE, reason: 'hand-injected source path bypassing artifact_declare', relatedIntent: 'CHK-001:happy:0', declaredAt: now },
        { path: FIXTURE_PATH, reason: 'hand-injected fixture path bypassing artifact_declare', relatedIntent: 'CHK-001:happy:0', declaredAt: now },
      ],
    });
    const optsForStory = dirtyWorktreeClassifierOptionsForStory(config, storyId, store);
    const injected = classifyGitStatusRows(
      [` M ${ATTACK_SOURCE}`, ` M ${FIXTURE_PATH}`, `?? ${GENERATED_OUTPUT}`],
      optsForStory,
    );
    assert.equal(
      injected.groups.material_source_changes.length, 1,
      'dirty source file stays material_source_changes even when declared (classifier hard gate)',
    );
    assert.equal(injected.groups.material_source_changes[0].path, ATTACK_SOURCE);
    assert.equal(
      injected.groups.fixture_changes.length, 1,
      'dirty fixture file stays fixture_changes even when declared (declared check runs after fixture)',
    );
    assert.equal(injected.groups.fixture_changes[0].path, FIXTURE_PATH);
    assert.equal(
      injected.groups.declared_artifact_changes.length, 1,
      'only the genuine generated-output path stays declared_artifact_changes',
    );
    assert.equal(injected.groups.declared_artifact_changes[0].path, GENERATED_OUTPUT);

    // === CHK-001/CHK-003 cross-check: the declared generated output is
    //     non-blocking in a REVIEW/TEST gate context (dirty-gate-policy
    //     untouched) — only its uncommitted state blocks DONE. ===
    const reviewGate = evaluateDirtyGate(injected, {
      storyId,
      gate: 'test-pre-check',
      writer: null,
    });
    assert.equal(
      (reviewGate.passingCounts.declared_artifact_changes ?? 0), 1,
      'declared generated output is a passing (non-blocking) category in REVIEW/TEST gate context',
    );
    assert.equal(
      reviewGate.allPass, false,
      'the dirty source + fixture rows still block REVIEW/TEST (classifier reorder works)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

/**
 * B-8db9 CHK-004: DONE committed-check row coverage. Drives buildDoneChecklist
 * against a real git repo so the uncommitted / committed-clean / git-ignored
 * / absent branches of the declared-artifacts-committed row are all exercised.
 */
function assertDeclaredArtifactDoneCommittedRow(): void {
  const GENERATED_OUTPUT = 'packages/main/tests/output/declared-generated.json';
  const root = mkdtempSync(join(tmpdir(), 'lattice-declared-committed-row-'));
  try {
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['config', 'user.email', 'smoke@example.test']);
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      testsDir: 'packages/main/tests',
      fixturesDir: 'packages/main/tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed committed-row smoke']);
    resetConfigCache();

    const store = new StoryStore(root);
    const storyId = 'B-committed';
    const now = '2026-05-15T21:30:00.000Z';
    store.writeStory(storyId, {
      storyId,
      name: 'declared-committed-row-smoke',
      title: 'Declared committed row smoke',
      description: 'DONE committed-check row regression.',
      type: 'chore',
      phase: 'TEST',
      priority: 'high',
      createdAt: now,
      startedAt: now,
      endedAt: null,
      currentReviewRound: now,
      events: [],
    });

    function committedRow(): { status: string; blocking: boolean; detail: string; hint?: string } {
      const rows = buildDoneChecklist(storyId, store, root);
      const row = rows.find(r => r.id === 'declared-artifacts-committed');
      assert.ok(row, 'buildDoneChecklist must emit a declared-artifacts-committed row');
      return row as { status: string; blocking: boolean; detail: string; hint?: string };
    }

    // === No declarations → pass non-blocking ===
    store.writeDeclaredArtifacts(storyId, { entries: [] });
    let row = committedRow();
    assert.equal(row.status, 'pass', 'empty declarations → committed row passes');
    assert.equal(row.blocking, false, 'empty declarations → committed row non-blocking');

    // === Uncommitted (untracked) declared artifact → fail/blocking ===
    store.writeDeclaredArtifacts(storyId, {
      entries: [{ path: GENERATED_OUTPUT, reason: 'declared deliverable', relatedIntent: 'CHK-001:happy:0', declaredAt: now }],
    });
    write(root, GENERATED_OUTPUT, '{"generated":true}\n');
    row = committedRow();
    assert.equal(row.status, 'fail', 'untracked declared artifact → committed row fails');
    assert.equal(row.blocking, true, 'untracked declared artifact → committed row blocking');
    assert.match(row.detail, /uncommitted/, 'detail must name the uncommitted path');
    assert.match(row.hint ?? '', /commit|delete/, 'hint must give commit/cleanup guidance');

    // === committed-and-clean → pass ===
    git(root, ['add', GENERATED_OUTPUT]);
    git(root, ['commit', '-m', 'commit declared artifact']);
    row = committedRow();
    assert.equal(row.status, 'pass', 'committed-and-clean declared artifact → committed row passes');
    assert.equal(row.blocking, false, 'committed-and-clean → non-blocking');
    assert.match(row.detail, /1\/1/, 'detail shows 1/1 committed');

    // === absent (cleaned up) declared artifact → pass ===
    store.writeDeclaredArtifacts(storyId, {
      entries: [{ path: 'packages/main/tests/output/never-existed.json', reason: 'temp output cleaned up', relatedIntent: 'CHK-001:happy:0', declaredAt: now }],
    });
    row = committedRow();
    assert.equal(row.status, 'pass', 'absent declared artifact → committed row passes (cleaned up is acceptable)');
    assert.equal(row.blocking, false, 'absent declared artifact → non-blocking');

    // === git-ignored declared path → fail/blocking with explicit message ===
    write(root, '.gitignore', 'packages/main/tests/output/ignored-output.json\n');
    git(root, ['add', '.gitignore']);
    git(root, ['commit', '-m', 'add gitignore']);
    const IGNORED = 'packages/main/tests/output/ignored-output.json';
    write(root, IGNORED, '{"ignored":true}\n');
    store.writeDeclaredArtifacts(storyId, {
      entries: [{ path: IGNORED, reason: 'mistakenly declared a git-ignored path', relatedIntent: 'CHK-001:happy:0', declaredAt: now }],
    });
    row = committedRow();
    assert.equal(row.status, 'fail', 'git-ignored declared path → committed row fails');
    assert.equal(row.blocking, true, 'git-ignored declared path → committed row blocking');
    assert.match(row.detail, /git-ignored/, 'detail must name the git-ignored status');
    assert.match(
      row.hint ?? '', /git-ignored paths must not be declared as deliverable artifacts/,
      'git-ignored declared path → explicit preMortem #2 message',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

/**
 * B-56d3/B-6974 CHK-003: phase-gates.ts + transition-effects.ts +
 * transition-orchestrator.ts extraction contract.
 *
 * Proves the Lifecycle Phase 2 Story 3a extraction is behavior-preserving:
 *
 *  1. Static layering (preMortem #2): phase-gates.ts, transition-effects.ts,
 *     and transition-orchestrator.ts do NOT import handlers/story-advance.js
 *     (no circular import); story-advance.ts is only the public command shell,
 *     and transition-orchestrator.ts owns the transition sequence.
 *  2. Fail-closed gate behavior (preMortem #1): runValidateGate still blocks
 *     TEST when lattice validate fails (allPass=false) AND when validate output
 *     is non-JSON (JSON-parse failure); runReviewToTestPreflightGate still
 *     blocks TEST when a CLI gate fails.
 *  3. Effect snapshot byte-identical (preMortem #3): buildNextSteps and
 *     renderRelatedDocsHint produce the exact text the inline originals did.
 */
async function assertPhaseGatesAndEffectsExtraction(): Promise<void> {
  const srcRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src');

  // --- 1. Static layering check ---
  const phaseGatesSrc = readFileSync(join(srcRoot, 'handlers', 'phase-gates.ts'), 'utf-8');
  const transitionEffectsSrc = readFileSync(join(srcRoot, 'handlers', 'transition-effects.ts'), 'utf-8');
  const transitionOrchestratorSrc = readFileSync(join(srcRoot, 'handlers', 'transition-orchestrator.ts'), 'utf-8');
  const storyAdvanceSrc = readFileSync(join(srcRoot, 'handlers', 'story-advance.ts'), 'utf-8');

  for (const [name, src] of [
    ['phase-gates.ts', phaseGatesSrc],
    ['transition-effects.ts', transitionEffectsSrc],
    ['transition-orchestrator.ts', transitionOrchestratorSrc],
  ] as const) {
    const importLines = src
      .split('\n')
      .filter(l => l.trimStart().startsWith('import'))
      .join('\n');
    assert.doesNotMatch(
      importLines,
      /story-advance/,
      `${name} must not import from handlers/story-advance.js (circular import guard — preMortem #2)`,
    );
  }
  // story-advance.ts must delegate, not import or inline the gate/effect bodies.
  assert.match(
    storyAdvanceSrc,
    /runStoryTransition/,
    'story-advance.ts must delegate the transition to handlers/transition-orchestrator.js',
  );
  assert.match(
    storyAdvanceSrc,
    /renderTransitionResult/,
    'story-advance.ts must format transition-orchestrator results',
  );
  assert.doesNotMatch(
    storyAdvanceSrc,
    /from '\.\/(?:phase-gates|transition-effects|done-effects)\.js'/,
    'story-advance.ts must not import gate/effect modules directly',
  );
  assert.match(
    transitionOrchestratorSrc,
    /from '\.\/phase-gates\.js'/,
    'transition-orchestrator.ts must own the phase-gates dependency',
  );
  assert.match(
    transitionOrchestratorSrc,
    /from '\.\/transition-effects\.js'/,
    'transition-orchestrator.ts must own the transition-effects dependency',
  );
  // The inline gate body markers are gone — story-advance.ts no longer
  // re-implements the preflight orchestration or the inline validate gate.
  assert.doesNotMatch(
    storyAdvanceSrc,
    /const \{ runReviewCliGates, renderPreflight \} = await import/,
    'the REVIEW->TEST preflight body must live in phase-gates.ts, not inline in story-advance.ts',
  );
  assert.doesNotMatch(
    storyAdvanceSrc,
    /const verifierHandlers = createVerifierHandlers\(ctx\)/,
    'the lattice validate gate body must live in phase-gates.ts, not inline in story-advance.ts',
  );
  // Fail-closed wording for the validate-throw / JSON-parse-failure catch must
  // live in phase-gates.ts and be the fail-closed branch (preMortem #1). The
  // verifier always returns valid JSON in practice, so the JSON-parse branch is
  // defensive — its fail-closed shape is pinned statically here, while the
  // validate-FAIL and preflight-FAIL paths below are exercised behaviorally.
  assert.match(
    phaseGatesSrc,
    /if \(e\.message\?\.includes\('Cannot enter TEST'\)\) throw e;/,
    'runValidateGate catch must rethrow gate errors before the execution exception throw',
  );
  assert.match(
    phaseGatesSrc,
    /if \(e\?\.message\?\.startsWith\('Cannot enter TEST'\)\) throw e;/,
    'runReviewToTestPreflightGate catch must rethrow gate errors before the execution exception throw',
  );
  assert.doesNotMatch(
    phaseGatesSrc,
    /actor\.stop\(\)/,
    'phase-gates.ts must not stop the actor directly; transition-orchestrator owns the lifecycle',
  );
  assert.match(
    transitionOrchestratorSrc,
    /finally \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*actor\?\.stop\(\);/s,
    'transition-orchestrator.ts must stop the actor in a single finally',
  );

  // --- 2. Fail-closed gate behavior ---
  // 2a. runValidateGate: validate FAIL → block TEST. The verifier judges the
  //     configured validate command by exit code, so a non-zero exit is a real
  //     validate failure (allPass=false) → first throw "did not pass".
  const failRoot = mkdtempSync(join(tmpdir(), 'lattice-phase-gates-validate-fail-'));
  try {
    const store = new StoryStore(failRoot);
    write(failRoot, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      validate: { commands: [{ label: 'failing gate', command: 'node', args: ['-e', 'process.exit(5)'] }] },
      workflow: { profile: 'balanced' },
    }));
    resetConfigCache();
    const storyId = 'B-failgate';
    const now = '2026-05-16T02:00:00.000Z';
    store.writeStory(storyId, {
      storyId, name: 'phase-gate-fail', title: 'Phase gate fail',
      description: 'validate FAIL must block TEST', type: 'chore', phase: 'TEST',
      priority: 'medium', createdAt: now, startedAt: now, endedAt: null,
      currentReviewRound: now, events: [],
    });
    let stopped = false;
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runValidateGate({ store, root: failRoot, scanRoot: join(failRoot, 'packages/main') }, storyId, actor),
      /Cannot enter TEST: lattice validate did not pass/,
      'runValidateGate must block TEST when lattice validate fails',
    );
    assert.equal(stopped, false, 'runValidateGate must leave actor stop to transition-orchestrator');
    // The fail-closed path still persists a FAIL test-evidence record (the
    // behavior-preserving side effect annotated in phase-gates.ts).
    assert.equal(store.readTestEvidence(storyId)?.result, 'FAIL', 'validate FAIL must persist a FAIL test-evidence record');
  } finally {
    rmSync(failRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // 2b. runReviewToTestPreflightGate: a failing CLI gate must block TEST.
  //     A riskSignal forces the normal channel (review-preflight's
  //     detectFastChannel routes ≤5-item, no-risk stories to the fast channel,
  //     where all gates skip). A main-agent-authored commit with no implementer
  //     evidence then trips the channel gate → preflight.ok=false → block.
  const preflightRoot = mkdtempSync(join(tmpdir(), 'lattice-phase-gates-preflight-'));
  try {
    const { store, storyId } = createReviewStore(preflightRoot);
    // Promote to the normal channel so the CLI gates actually run.
    const normalStory = store.readStory(storyId);
    normalStory.riskSignals = [{ category: 'state machine', matched: 'gate' }];
    store.writeStory(storyId, normalStory);
    git(preflightRoot, ['init']);
    git(preflightRoot, ['config', 'user.email', 'lattice@example.test']);
    git(preflightRoot, ['config', 'user.name', 'Proofbound Smoke']);
    git(preflightRoot, ['checkout', '-B', 'main']);
    git(preflightRoot, ['add', '.']);
    git(preflightRoot, ['commit', '-m', 'base']);
    git(preflightRoot, ['checkout', '-b', `story/${storyId}`]);
    // Add a main-agent-authored commit so the channel gate has a real diff to
    // judge — normal channel with no implementer evidence → channel gate fail.
    write(preflightRoot, 'src/core/feature.ts', 'export const feature = 1;\n');
    git(preflightRoot, ['add', '.']);
    git(preflightRoot, ['commit', '-m', `${storyId}: main agent writes feature`]);
    let stopped = false;
    const actor = { stop() { stopped = true; } };
    await assert.rejects(
      () => runReviewToTestPreflightGate(
        { store, root: preflightRoot, scanRoot: join(preflightRoot, 'packages/main') },
        storyId,
        actor,
      ),
      /Cannot enter TEST: CLI gate preflight/,
      'runReviewToTestPreflightGate must block TEST when a CLI gate fails (fail-closed)',
    );
    assert.equal(stopped, false, 'runReviewToTestPreflightGate must leave actor stop to transition-orchestrator');
  } finally {
    rmSync(preflightRoot, { recursive: true, force: true });
    resetConfigCache();
  }

  // --- 3. Effect snapshot byte-identical ---
  const effectRoot = mkdtempSync(join(tmpdir(), 'lattice-phase-gates-effects-'));
  try {
    const { store, storyId } = createReviewStore(effectRoot);

    // 3a. buildNextSteps: PLAN / TEST / DONE entries are static strings —
    //     pin them byte-for-byte against the inline originals.
    const nextSteps = buildNextSteps(store, effectRoot, storyId);
    assert.equal(
      nextSteps.PLAN,
      `→ Recommend switching to Claude Code plan mode immediately (shift-tab twice to plan mode) — the PLAN stage only breaks down checklist / writes understanding_set / decision_set, and should not modify code. Edit/Write being disabled in plan mode prevents accidental edits.
→ Next step: checklist_get(${storyId}) to view pending items, then story_advance(${storyId}, DEV) to begin development
⚠ User value acceptance (mandatory): the outcome field of understanding_set must be written as a concrete user-facing transcript — the exact text the user will see in the terminal/UI after running this story, not an abstract description like "event X is wired up". Judgment method: outcome must read in a way that lets one imagine the moment when the user considers the work done. See the "User value acceptance" section in CLAUDE.md for details.`,
      'buildNextSteps PLAN text must be byte-identical to the inline original',
    );
    assert.equal(
      nextSteps.TEST_CASE,
      `→ Legacy phase. Recommend directly story_advance(${storyId}, TEST) to enter verification`,
      'buildNextSteps TEST_CASE text must be byte-identical to the inline original',
    );
    assert.equal(
      nextSteps.DONE,
      `→ Must execute immediately: tell the user the Story summary paragraph below in your own words (what changed / how to use / real-machine coverage / limitations / pitfalls), then convergence_check to check project convergence state
⚠ DONE self-check 5 questions (CLAUDE.md "User value acceptance" section): (1) Is the PLAN outcome a concrete transcript or abstract? (2) During real-machine testing, did you read the user-perspective output or only look at the event log? (3) When the user sees the last line of the actual transcript, would they consider the work done or still wonder what comes next? (4) Are there any engineering logs that are noise/duplicates in the user's eyes? (5) Is there a plain-language summary of the task result? If any question is answered "not done", return to DEV and do not force-push DONE.`,
      'buildNextSteps DONE text must be byte-identical to the inline original',
    );
    // The REVIEW entry depends on opt-in routing; it must at least surface the
    // reviewer Agent call lines and the liveness reminder unchanged.
    assert.match(nextSteps.REVIEW, /launch the above reviewers in parallel to review code/);
    assert.match(nextSteps.REVIEW, /reviewer liveness: each reviewer should first output REVIEW_START after starting/);

    // 3b. renderRelatedDocsHint: with checklist relatedDocs, the DEV header +
    //     line shape must be byte-identical to the inline original.
    store.writeChecklist(storyId, {
      items: [{
        id: 'CHK-001',
        title: 'Item with related docs',
        context: 'snapshot fixture',
        status: 'done',
        startTime: '2026-04-27T12:00:00.000Z',
        endTime: '2026-04-27T12:00:00.000Z',
        relatedDocs: ['docs/requirements/decisions/story-lifecycle.md'],
      }],
    });
    const devHint = renderRelatedDocsHint(store, effectRoot, storyId, 'DEV');
    assert.equal(
      devHint,
      `\n\n📄 Documents associated with this story (note synchronization when modifying code):\n  - docs/requirements/decisions/story-lifecycle.md  (CHK-001)`,
      'renderRelatedDocsHint DEV output must be byte-identical to the inline original',
    );
    const doneHint = renderRelatedDocsHint(store, effectRoot, storyId, 'DONE');
    assert.equal(
      doneHint,
      `\n\n📄 Documents associated with this story (verify synchronization before DONE wrap-up):\n  - docs/requirements/decisions/story-lifecycle.md  (CHK-001)`,
      'renderRelatedDocsHint DONE output must be byte-identical to the inline original',
    );
  } finally {
    rmSync(effectRoot, { recursive: true, force: true });
    resetConfigCache();
  }
}

/**
 * B-37e9 CHK-003: same-source contract for the DONE oracle.
 *
 * Proves both behaviorally and structurally that the DONE gate
 * (handlers/phase-gates.ts, driven by handlers/transition-orchestrator.ts) and
 * session_brief's DONE pre-check (handlers/session.ts) render the SAME rows
 * from the SAME core/done-oracle.ts module — no divergent re-implementation
 * (preMortem #3 anchor).
 *
 *  1. Behavioral: one TEST-phase story fixture drives the DONE gate path
 *     (buildDoneChecklist + renderDoneChecklist) AND the real session_brief
 *     handler; the DONE pre-check rows session_brief emits are byte-identical
 *     to what buildDoneChecklist produces.
 *  2. Structural: a static check confirms both story-advance.ts and session.ts
 *     import buildDoneChecklist from core/done-oracle.js — a future edit cannot
 *     give session_brief its own copy without failing this assertion.
 *  3. Regression baseline (preMortem #1): the row id/status/blocking shape for
 *     the fixture is asserted explicitly so a silent behavior change in the
 *     relocated function body is caught.
 */
function assertDoneOracleSameSource(): void {
  // --- 2. Structural same-source check (static import grep) ---
  // At runtime this smoke runs from dist/tasks/; sources live under src/.
  // Walk up from <pkg>/dist/tasks/ to <pkg>/, then into src/.
  const srcRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'src');
  const storyAdvanceSrc = readFileSync(join(srcRoot, 'handlers', 'story-advance.ts'), 'utf-8');
  const sessionSrc = readFileSync(join(srcRoot, 'handlers', 'session.ts'), 'utf-8');
  assert.match(
    storyAdvanceSrc,
    /buildDoneChecklist[\s\S]*?from '\.\.\/core\/done-oracle\.js'/,
    'story-advance.ts must import buildDoneChecklist from core/done-oracle.js',
  );
  assert.match(
    sessionSrc,
    /buildDoneChecklist[\s\S]*?from '\.\.\/core\/done-oracle\.js'/,
    'session.ts must import buildDoneChecklist from core/done-oracle.js',
  );
  // The DONE oracle implementation must NOT live in story-advance.ts anymore —
  // only a thin re-export plus the gate call site are allowed.
  assert.doesNotMatch(
    storyAdvanceSrc,
    /export function buildDoneChecklist\(/,
    'buildDoneChecklist must have exactly one implementation (in core/done-oracle.ts), not story-advance.ts',
  );
  // done-oracle.ts must not import story-advance.ts (no circular import — preMortem #2).
  const doneOracleSrc = readFileSync(join(srcRoot, 'core', 'done-oracle.ts'), 'utf-8');
  const doneOracleImportLines = doneOracleSrc
    .split('\n')
    .filter(l => l.trimStart().startsWith('import'))
    .join('\n');
  assert.doesNotMatch(
    doneOracleImportLines,
    /story-advance/,
    'core/done-oracle.ts must not import from handlers/story-advance.js (circular import guard)',
  );
  // B-37e9 F-001: core/ must not depend upward on handlers/. done-oracle.ts is a
  // core module; any `from '../handlers/...'` import is a layer violation. The
  // delivery-check hash primitives were extracted to core/delivery-check-hash.ts
  // precisely so this assertion can stay clean.
  assert.doesNotMatch(
    doneOracleImportLines,
    /from '\.\.\/handlers\//,
    'core/done-oracle.ts must not import from any handlers/ module (core→handlers layer violation)',
  );

  // --- 1 & 3. Behavioral same-source + regression baseline ---
  const root = mkdtempSync(join(tmpdir(), 'lattice-done-oracle-same-source-'));
  try {
    const { store, storyId, reviewRound } = createReviewStore(root);
    git(root, ['init']);
    git(root, ['config', 'user.email', 'lattice@example.test']);
    git(root, ['config', 'user.name', 'Proofbound Smoke']);
    git(root, ['checkout', '-B', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'base']);
    git(root, ['checkout', '-b', `story/${storyId}`]);
    seedReviewRuns(root, store, storyId, reviewRound, [
      'lattice-review-concept',
      'lattice-review-quality',
      'lattice-review-test-coverage',
    ]);

    const testStory = store.readStory(storyId);
    testStory.phase = 'TEST';
    store.writeStory(storyId, testStory);
    const evidence: TestEvidenceData = {
      command: 'lattice validate --json',
      output: JSON.stringify({ allPass: true }),
      result: 'PASS',
      timestamp: '2026-05-15T12:25:00.000Z',
    };
    store.writeTestEvidence(storyId, evidence);

    // Path A: the DONE gate path (phase-gates.ts imports these from done-oracle.ts).
    const gateRows = buildDoneChecklist(storyId, store, root);
    const gateRendered = renderDoneChecklist(storyId, gateRows);
    assert.ok(gateRendered.startsWith(`DONE Gate Checklist (${storyId}):`), 'DONE gate rendering header stable');

    // Path B: the real session_brief handler (session.ts imports the same module).
    const brief = createSessionHandlers({
      store,
      root,
      scanRoot: join(root, 'packages/main'),
    }).session_brief({ concise: true });

    // session_brief renders the DONE pre-check section as:
    //   ## DONE pre-check
    //     [PASS|FAIL|warn] <label>[: <detail>]
    const briefLines = brief.split('\n');
    const preCheckIdx = briefLines.findIndex(l => l.trim() === '## DONE pre-check');
    assert.notEqual(preCheckIdx, -1, 'session_brief must emit a DONE pre-check section for a TEST-phase story');
    const sessionRowLines: string[] = [];
    for (let i = preCheckIdx + 1; i < briefLines.length; i++) {
      const line = briefLines[i];
      if (/^\s{2}\[(PASS|FAIL|warn)\]\s/.test(line)) {
        sessionRowLines.push(line.trim());
      } else if (line.trim().startsWith('## ')) {
        break;
      }
    }

    // The DONE gate and session_brief must emit the SAME number of rows in the
    // SAME order — both consume buildDoneChecklist from core/done-oracle.ts.
    assert.equal(
      sessionRowLines.length,
      gateRows.length,
      `session_brief DONE pre-check row count (${sessionRowLines.length}) must match the DONE gate (${gateRows.length})`,
    );
    for (let i = 0; i < gateRows.length; i++) {
      const row = gateRows[i];
      const marker = row.status === 'pass' ? 'PASS' : (row.status === 'fail' ? 'FAIL' : 'warn');
      // The git-working-tree row's detail embeds an audit-line counter that
      // grows each call (buildDoneChecklist's audit writer appends to
      // process-events.jsonl). That makes the *detail* call-order-sensitive
      // regardless of same-source — so compare its stable id/label/status only.
      if (row.id === 'git-working-tree') {
        assert.match(
          sessionRowLines[i],
          new RegExp(`^\\[${marker}\\] ${row.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
          `DONE row ${i} (${row.id}) label/status must render identically in session_brief and the DONE gate`,
        );
        continue;
      }
      const expected = `[${marker}] ${row.label}${row.detail ? `: ${row.detail}` : ''}`;
      assert.equal(
        sessionRowLines[i],
        expected,
        `DONE row ${i} (${row.id}) must render identically in session_brief and the DONE gate`,
      );
    }

    // --- 3. Regression baseline: explicit row shape for this fixture ---
    // The fixture has PASS test-evidence but is missing delivery-check.json /
    // summary.json — these stable ids/status/blocking values catch a silent
    // behavior change in the relocated function body.
    const byId = new Map(gateRows.map(r => [r.id, r]));
    assert.equal(byId.get('test-evidence')?.status, 'pass', 'baseline: test-evidence passes');
    assert.equal(byId.get('bugs-fixed')?.status, 'pass', 'baseline: no bugs → pass');
    assert.equal(byId.get('delivery-check')?.status, 'fail', 'baseline: missing delivery-check → fail');
    assert.equal(byId.get('delivery-check')?.blocking, true, 'baseline: missing delivery-check is blocking');
    assert.equal(byId.get('story-summary')?.status, 'fail', 'baseline: missing summary → fail');
    assert.equal(byId.get('story-summary')?.blocking, true, 'baseline: missing summary is blocking');
    assert.equal(byId.get('declared-artifacts-referenced')?.status, 'pass', 'baseline: no declarations → pass');
    assert.equal(byId.get('declared-artifacts-committed')?.status, 'pass', 'baseline: no declarations → pass');

    const closingSelfCheck = {
      hasRealMachineTest: true,
      hasEdgeCaseCoverage: true,
      hasUnresolvedTodos: false,
      summary: 'DONE oracle delivery branch smoke',
    };
    const realMachineTests = [{
      featureId: 'flow-stability-smoke',
      transcript: 'npm --prefix packages/main run test:flow-stability-smoke',
    }];

    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-05-15T12:30:00.000Z',
      reviewRound,
      agentId: 'lattice-review-delivery',
      docsPromises: [],
      realMachineTests,
      closingSelfCheck,
      _hash: 'tampered-delivery-check-hash',
    });
    const hashMismatchRows = buildDoneChecklist(storyId, store, root);
    const hashMismatchRow = new Map(hashMismatchRows.map(r => [r.id, r])).get('delivery-check');
    assert.equal(hashMismatchRow?.status, 'fail', 'delivery-check hash mismatch must fail');
    assert.equal(hashMismatchRow?.detail, 'delivery-check.json _hash mismatch');
    assert.equal(hashMismatchRow?.source, 'delivery-check.json._hash');
    assert.match(hashMismatchRow?.hint ?? '', /Re-run the lattice-review-delivery reviewer to generate a new delivery-check\.json/);

    const docsPromises = [{
      docPath: 'docs/requirements/decisions/flow-stability-smoke.md',
      promise: 'Document the flow-stability delivery assertion.',
      status: 'unverified' as const,
    }];
    const deliveryHeadHash = currentGitHead(root);
    const deliveryMaterialHash = currentMaterialHash(root);
    assert.ok(deliveryHeadHash, 'smoke repo must have git HEAD for delivery-check freshness');
    assert.ok(deliveryMaterialHash, 'smoke repo must have material hash for delivery-check freshness');
    store.writeDeliveryCheck(storyId, {
      storyId,
      checkedAt: '2026-05-15T12:31:00.000Z',
      headHash: deliveryHeadHash,
      materialHash: deliveryMaterialHash,
      reviewRound,
      agentId: 'lattice-review-delivery',
      docsPromises,
      realMachineTests,
      closingSelfCheck,
      _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, reviewRound, deliveryMaterialHash),
    });
    const unverifiedDocsRows = buildDoneChecklist(storyId, store, root);
    const unverifiedDocsRow = new Map(unverifiedDocsRows.map(r => [r.id, r])).get('delivery-check');
    assert.equal(unverifiedDocsRow?.status, 'fail', 'unverified docsPromise must fail');
    assert.equal(unverifiedDocsRow?.detail, '1 docsPromise entries are unverified and not waived');
    assert.equal(unverifiedDocsRow?.source, 'delivery-check.json.docsPromises');
    assert.match(unverifiedDocsRow?.hint ?? '', /Use delivery_waiver_add to write a waiver/);
    assert.match(unverifiedDocsRow?.hint ?? '', /re-run the lattice-review-delivery reviewer to add verification evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

/**
 * B-edca quality follow-up: production helpers must pass projectRoot down to
 * dirtyWorktreeClassifierOptions* so a custom storyDir is honoured in real call
 * chains. Uses formatWorktreePollutionDetails (validation-executor) as the
 * representative production caller: if it forgets projectRoot the custom story
 * metadata path would land in unexpected_dirty_files (blocking) instead of
 * lattice_metadata_changes (passing).
 */
function assertProductionHelperPassesProjectRootToClassifier(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-prod-root-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: 'workflow/stories',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const worktreePollution: {
      statusLines: string[];
      paths: string[];
      blocking?: boolean;
    } = {
      statusLines: [' M workflow/stories/B-smoke/checklist.json'],
      paths: ['workflow/stories/B-smoke/checklist.json'],
    };
    const mockResult = {
      label: 'smoke-cmd',
      command: 'echo',
      args: ['ok'],
      code: 0,
      output: '',
      durationMs: 0,
      worktreePollution,
    };

    const lines = formatWorktreePollutionDetails(mockResult, root);
    assert.ok(lines.length > 0, 'formatWorktreePollutionDetails must return lines');
    const header = lines[0];
    assert.ok(
      header.startsWith('✓'),
      `Production helper must classify custom storyDir path as lattice_metadata (passing). ` +
      `Got: ${header} — if this fails, the production helper is not passing projectRoot to dirtyWorktreeClassifierOptionsFromConfig.`,
    );
    assert.equal(
      worktreePollution.blocking, false,
      'worktreePollution.blocking must be false when only lattice_metadata paths are dirty',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

/**
 * B-edca quality follow-up: dirty-worktree classification honours configured
 * storyDir via projectRoot so custom storyDir paths land in lattice_metadata_changes,
 * not unexpected_dirty_files. Verifies three cases:
 *   1. Custom storyDir sub-path → lattice_metadata_changes
 *   2. Same-prefix-but-not-storyDir path → unexpected_dirty_files
 *   3. Default .lattice/story/ paths still work with projectRoot set
 * Also verifies that declared/fixture/material precedence rules are not weakened.
 */
function assertCustomStoryDirDirtyWorktreeClassification(): void {
  const root = mkdtempSync(join(tmpdir(), 'lattice-custom-storydir-'));
  try {
    write(root, 'lattice.config.json', JSON.stringify({
      scanRoot: 'src',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: 'workflow/stories',
      requirementsDir: 'docs/requirements',
    }));
    resetConfigCache();

    const config = loadConfig(root);
    const opts = dirtyWorktreeClassifierOptionsFromConfig(config, root);

    // 1. Custom storyDir sub-path must be lattice_metadata_changes.
    const storyMeta = classifyGitStatusRows(
      [' M workflow/stories/B-smoke/test-evidence.json'],
      opts,
    );
    assert.equal(
      storyMeta.groups.lattice_metadata_changes.length, 1,
      'workflow/stories/B-smoke/test-evidence.json must be lattice_metadata_changes with custom storyDir',
    );
    assert.equal(storyMeta.groups.unexpected_dirty_files.length, 0);

    // 2. Sibling path outside storyDir must not be classified as lattice_metadata.
    const notMeta = classifyGitStatusRows(
      ['?? workflow/notes.md'],
      opts,
    );
    assert.equal(
      notMeta.groups.lattice_metadata_changes.length, 0,
      'workflow/notes.md must not be lattice_metadata_changes',
    );
    assert.equal(
      notMeta.groups.unexpected_dirty_files.length, 1,
      'workflow/notes.md must be unexpected_dirty_files',
    );

    // 3. Default .lattice/story/ paths still work even with projectRoot set.
    const defaultMeta = classifyGitStatusRows(
      [' M .lattice/story/actives/B-xxx/checklist.json'],
      opts,
    );
    assert.equal(
      defaultMeta.groups.lattice_metadata_changes.length, 1,
      '.lattice/story/ default prefix must still be lattice_metadata_changes',
    );

    // 4. Material source path is NOT reclassified as lattice_metadata even if
    //    projectRoot is set (classifier checks metadata first, but src/ is not
    //    storyDir so it stays material).
    const materialOpts = dirtyWorktreeClassifierOptionsFromConfig(config, root);
    const material = classifyGitStatusRows(
      [' M src/core/foo.ts'],
      materialOpts,
    );
    assert.equal(
      material.groups.material_source_changes.length, 1,
      'src/core/foo.ts must remain material_source_changes with projectRoot set',
    );
    assert.equal(material.groups.lattice_metadata_changes.length, 0);

    // 5. Fixture path is not reclassified.
    const fixtureOpts = dirtyWorktreeClassifierOptionsFromConfig(config, root);
    const fixture = classifyGitStatusRows(
      ['?? tests/fixtures/my-fixture.json'],
      fixtureOpts,
    );
    assert.equal(
      fixture.groups.fixture_changes.length, 1,
      'tests/fixtures/ path must remain fixture_changes',
    );
    assert.equal(fixture.groups.lattice_metadata_changes.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

assertProductionHelperPassesProjectRootToClassifier();
assertCustomStoryDirDirtyWorktreeClassification();
assertSessionBriefGate();
assertDirtyWorktreeClassifierGroupsOwnership();
assertDirtyGatePolicyAcrossGates();
assertDeclaredArtifactsChannel();
assertDeclaredArtifactGateHotfix();
assertDeclaredArtifactDoneCommittedRow();
assertFlowFactPolicyRegistry();
assertPhaseGatePolicyHints();
assertPhaseToolsOverrideStillBlocks();
assertLifecycleRegistryConsistency();
assertPhaseFlowDerivedValuesByteIdentical();
assertStoryAdvanceTestGateFailClosedContracts();
assertManagedAssetExpandedDocsAndTrueDrift();
assertDispatchPromptsPinImplementerCommitAuthor();
assertReviewGateUsesOptIn();
assertReviewRunBindingRejectsInvalidEvidence();
assertReviewRunStoryFilesHashBindingIsSigned();
assertVerificationEvidenceStoryFilesHashDowngradesUnrelatedDrift();
assertTestEvidenceStoryFilesHashDowngradesActiveDoneFreshness();
assertReviewPreflightSurfacesStoryFilesHashAdvisories();
assertSupersededReviewPassDoesNotBlockLatestReviewerRun();
assertReviewRunBindingRaceAcceptsNonLatestFreshPass();
assertLegacyReviewEvidenceWithoutCurrentRoundStaysReadable();
assertNonReviewerFindingsDoNotCountAsReviewerEvidence();
assertStoryAdvanceGuardIgnoresMainAgentDevFindings();
await assertStoryAdvanceReviewEchoOmitsRetiredChannel();
assertReviewerStatusUsesMdFallback();
assertSessionBriefStatusHintsMatchGates();
assertReviewNextUsesReviewerGateState();
assertDevGuidanceUsesReviewPhase();
assertValidateHintsFollowStoryPhase();
assertRealCliValidateHintFollowsActiveStoryPhase();
assertBugUpdateTestHintUsesDonePrecheck();
assertChannelGateRejectsLatticeSubjectForRealFiles();
assertChannelGateAcceptsStructuredEvidenceWithSharedGitAuthor();
assertChannelGateAcceptsSuccessfulSubagentResultEvidence();
assertChannelGateAcceptsDispatchEvidence();
assertChannelGateAcceptsImplementerAuthorWithoutDispatch();
assertDoneChecklistUsesStableOracleRows();
assertDoneClosureProjectionSeparatesAuthority();
assertDoneOracleSameSource();
await assertPhaseGatesAndEffectsExtraction();
assertGlobalLinkRepair();
assertAutoCommitMetadataAcrossHandlers();

console.log('✓ flow stability smoke passed');
