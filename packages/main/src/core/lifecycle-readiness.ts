import { execFileSync } from 'child_process';
import { buildDoneChecklist, type DoneCheckRow } from './done-oracle.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { getBlockingVerificationEvidenceIssues } from './verification.js';
import { loadConfig } from './config.js';
import { resolveWorkflowPolicy } from './workflow-policy.js';
import { collectReviewerEvidenceState } from './review-run.js';
import { isFindingBlocking, resolveReviewRoundCount } from './advisory.js';
import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import { detectMdTouchpointsFromGit } from './touchpoints-fallback.js';
import { findingAgentMatchesReviewer } from './reviewer-opt-in.js';
import { evaluateReviewerQuorum, type ReviewerEvidenceEntry } from './reviewer-quorum.js';
import { computeActiveReviewers } from '../handlers/reviewer-list.js';
import type { StoryStore } from './store.js';
import type { Finding, StoryPhase, VerificationEvidence } from './types.js';

export type LifecycleReadinessTarget = 'REVIEW' | 'TEST' | 'DONE';
export type LifecycleReadinessStatus = 'pass' | 'warn' | 'blocked' | 'manual' | 'external';
export type LifecycleReadinessCategory = 'missing' | 'stale' | 'blocking' | 'manual' | 'external' | 'advisory';
export type LifecycleReadinessSource = 'storyMachine' | 'validate' | 'review' | 'delivery' | 'done_prepare' | 'authority';
export type LifecycleReadinessOwner = 'host' | 'reviewer' | 'delivery-reviewer' | 'done_prepare' | 'authority' | 'human';

export interface StoryReadinessRow {
  id: string;
  status: LifecycleReadinessStatus;
  blocking: boolean;
  source: LifecycleReadinessSource;
  sourceRef: string | null;
  owner: LifecycleReadinessOwner;
  category: LifecycleReadinessCategory;
  code: string;
  reason: string;
  nextCommand?: string;
}

export interface MainSyncReadiness {
  status: 'synced' | 'behind' | 'unknown';
  storyId: string;
  branch: string;
  behindCount: number | null;
  donePrepareCommand: string;
}

export interface StoryReadinessNextAction {
  kind: 'command' | 'human_decision' | 'external_wait';
  owner: LifecycleReadinessOwner;
  command?: string;
  reason: string;
}

export interface StoryReadinessReport {
  storyId: string;
  target: LifecycleReadinessTarget;
  phase: StoryPhase;
  headHash: string | null;
  materialHash: string | null;
  storyFilesHash: string | null;
  mode: {
    runCommands: false;
    writeEvidence: false;
  };
  artifacts: {
    verificationEvidence: Array<{
      itemId: string;
      intentRef?: string;
      kind?: string;
      result?: string;
      command?: string;
      headHash?: string;
      materialHash?: string;
      storyFilesHash?: string;
    }>;
    validationRef: Record<string, unknown> | null;
    reviewRound: string | null;
    deliveryCheckRef: Record<string, unknown> | null;
    liveSmokeTranscriptRef: null;
    metadataOnlyWaiverRef: null;
    donePrepareRef: null;
  };
  readiness: StoryReadinessRow[];
  next: StoryReadinessNextAction[];
  claims: {
    localReady: boolean;
    authorityDone: false;
    fullAuthorityDone: false;
    productionDone: false;
  };
}

export interface BuildStoryReadinessReportInput {
  storyId: string;
  target: LifecycleReadinessTarget;
  store: StoryStore;
  root: string;
  gitCwd?: string;
}

const PHASE_RANK: Record<StoryPhase, number> = {
  IDEA: 0,
  INIT: 1,
  INIT_CHECK: 2,
  PLAN: 3,
  DEV: 4,
  REVIEW: 5,
  TEST: 6,
  DONE: 7,
  TEST_CASE: 6,
  TEST_CASE_REVIEW: 6,
  DISCARDED: 8,
  META: 8,
};

function row(input: Omit<StoryReadinessRow, 'blocking'> & { blocking?: boolean }): StoryReadinessRow {
  const blocking = input.blocking ?? input.status === 'blocked';
  return { ...input, blocking };
}

function targetRank(target: LifecycleReadinessTarget): number {
  return PHASE_RANK[target];
}

function rollbackToDevCommand(storyId: string): string {
  return `lattice story_advance '{"storyId":"${storyId}","phase":"DEV"}'`;
}

function storyAdvanceCommand(storyId: string, phase: LifecycleReadinessTarget): string {
  return `lattice story_advance '{"storyId":"${storyId}","phase":"${phase}"}'`;
}

function donePrepareCommand(storyId: string): string {
  return `lattice done_prepare '{"storyId":"${storyId}","mergeMain":true,"refreshStale":true,"validate":true}'`;
}

function gitOutput(gitCwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function gitSucceeds(gitCwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function buildMainSyncReadiness(input: { storyId: string; gitCwd: string }): MainSyncReadiness {
  const { storyId, gitCwd } = input;
  const branch = gitOutput(gitCwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || `story/${storyId}`;
  const command = donePrepareCommand(storyId);
  if (!gitSucceeds(gitCwd, ['rev-parse', '--verify', 'main^{commit}'])) {
    return { status: 'unknown', storyId, branch, behindCount: null, donePrepareCommand: command };
  }
  if (gitSucceeds(gitCwd, ['merge-base', '--is-ancestor', 'main', 'HEAD'])) {
    return { status: 'synced', storyId, branch, behindCount: 0, donePrepareCommand: command };
  }

  const countRaw = gitOutput(gitCwd, ['rev-list', '--count', 'HEAD..main']);
  const behindCount = countRaw === null ? null : Number.parseInt(countRaw, 10);
  if (behindCount !== null && Number.isFinite(behindCount) && behindCount > 0) {
    return { status: 'behind', storyId, branch, behindCount, donePrepareCommand: command };
  }
  return { status: 'unknown', storyId, branch, behindCount: null, donePrepareCommand: command };
}

export function renderMainSyncReadinessAdvisory(readiness: MainSyncReadiness): string | null {
  if (readiness.status !== 'behind') return null;
  const count = readiness.behindCount === null ? 'unknown number of' : String(readiness.behindCount);
  return `main-sync readiness: ${readiness.branch} is behind main by ${count} commits; advisory/read-only; run ${readiness.donePrepareCommand}`;
}

function validationCommand(storyId: string): string {
  return `lattice validate --story=${storyId} --json`;
}

function currentBlockingSeverities(store: StoryStore, storyId: string, projectRoot: string): { severities: string[]; roundCount: number } {
  const story = store.readStory(storyId);
  const policy = resolveWorkflowPolicy(loadConfig(projectRoot), story);
  const roundCount = resolveReviewRoundCount(store, storyId);
  if (roundCount >= 3) return { severities: ['critical'], roundCount };
  if (roundCount >= 2) return { severities: ['critical', 'high'], roundCount };
  return { severities: [...policy.review.blockingSeverities], roundCount };
}

function activeReviewersForStory(store: StoryStore, storyId: string, projectRoot: string) {
  const story = store.readStory(storyId);
  let checklist: { items: unknown[] } = { items: [] };
  try { checklist = store.readChecklist(storyId); } catch { /* missing checklist is handled by review target rows */ }
  let decision = null;
  try { decision = store.readDecision(storyId); } catch { /* decision is optional for reviewer routing */ }
  const understanding = store.readUnderstanding(storyId);
  const touchpoints = understanding?.touchpoints
    ?? detectMdTouchpointsFromGit(projectRoot);
  return computeActiveReviewers(story, checklist, decision, touchpoints);
}

function reviewerLane(name: string): string {
  return name.startsWith('lattice-review-') ? name : `lattice-review-${name}`;
}

function reviewerRunStartCommand(storyId: string, lane: string): string {
  return `lattice review_run_start '{"storyId":"${storyId}","agent":"${lane}"}'`;
}

function quorumEvidence(evidenceRecords: { agent: string; kind: string; signatureValid?: boolean }[]): ReviewerEvidenceEntry[] {
  return evidenceRecords.map((evidence) => ({
    lane: evidence.agent,
    agent: evidence.agent,
    // Match canPassReviewGuard: lane coverage is enough here; blocking finding
    // severity is evaluated by the existing review.findings readiness row.
    kind: 'pass',
    signatureValid: evidence.signatureValid,
  }));
}

function verificationEvidenceArtifacts(evidence: Array<VerificationEvidence & { itemId: string }>) {
  return evidence.map((ev) => ({
    itemId: ev.itemId,
    ...(ev.intentRef ? { intentRef: ev.intentRef } : {}),
    ...(ev.kind ? { kind: ev.kind } : {}),
    ...(ev.result ? { result: ev.result } : {}),
    ...(ev.command ? { command: ev.command } : {}),
    ...(ev.headHash ? { headHash: ev.headHash } : {}),
    ...(ev.materialHash ? { materialHash: ev.materialHash } : {}),
    ...(ev.storyFilesHash ? { storyFilesHash: ev.storyFilesHash } : {}),
  }));
}

function collectVerificationEvidence(store: StoryStore, storyId: string): Array<VerificationEvidence & { itemId: string }> {
  try {
    return store.readChecklist(storyId).items.flatMap((item) =>
      (item.verificationEvidence ?? []).map((ev) => ({ ...ev, itemId: item.id })),
    );
  } catch {
    return [];
  }
}

function buildReviewTargetRows(store: StoryStore, storyId: string, projectRoot: string): StoryReadinessRow[] {
  const rows: StoryReadinessRow[] = [];
  let checklist;
  try {
    checklist = store.readChecklist(storyId);
  } catch (err) {
    rows.push(row({
      id: 'review.checklist',
      status: 'blocked',
      source: 'storyMachine',
      sourceRef: 'checklist.json',
      owner: 'host',
      category: 'missing',
      code: 'missing_checklist',
      reason: `Checklist could not be read: ${err instanceof Error ? err.message : String(err)}`,
      nextCommand: `lattice checklist_get '{"storyId":"${storyId}"}'`,
    }));
    return rows;
  }

  const pending = checklist.items.filter((item) => item.status !== 'done');
  if (pending.length > 0) {
    rows.push(row({
      id: 'review.checklist_status',
      status: 'blocked',
      source: 'storyMachine',
      sourceRef: 'checklist.json',
      owner: 'host',
      category: 'missing',
      code: 'checklist_items_not_done',
      reason: `${pending.length} checklist item(s) are not done: ${pending.map((item) => item.id).join(', ')}`,
      nextCommand: `lattice checklist_update '{"storyId":"${storyId}","itemId":"${pending[0]?.id ?? "CHK-001"}","status":"done"}'`,
    }));
  } else {
    rows.push(row({
      id: 'review.checklist_status',
      status: 'pass',
      source: 'storyMachine',
      sourceRef: 'checklist.json',
      owner: 'host',
      category: 'advisory',
      code: 'checklist_items_done',
      reason: `${checklist.items.length}/${checklist.items.length} checklist item(s) done`,
      blocking: false,
    }));
  }

  const story = store.readStory(storyId);
  const policy = resolveWorkflowPolicy(loadConfig(projectRoot), story);
  const missingEvidence = getBlockingVerificationEvidenceIssues(checklist, undefined, policy.profile);
  if (missingEvidence.length > 0) {
    rows.push(row({
      id: 'review.verification_evidence',
      status: 'blocked',
      source: 'storyMachine',
      sourceRef: 'checklist.verificationEvidence',
      owner: 'host',
      category: 'missing',
      code: 'missing_verification_evidence',
      reason: `${missingEvidence.length} required verification intent(s) lack passing evidence or waiver`,
      nextCommand: `lattice verification_evidence_add '{"storyId":"${storyId}","itemId":"<CHK-id>","intentRef":"<intent-ref>","kind":"logic_test","result":"pass","note":"..."}'`,
    }));
  } else {
    rows.push(row({
      id: 'review.verification_evidence',
      status: 'pass',
      source: 'storyMachine',
      sourceRef: 'checklist.verificationEvidence',
      owner: 'host',
      category: 'advisory',
      code: 'verification_evidence_present',
      reason: 'Required verification intent evidence is present or waived',
      blocking: false,
    }));
  }

  return rows;
}

function buildReviewGateRows(store: StoryStore, storyId: string, projectRoot: string): StoryReadinessRow[] {
  const rows: StoryReadinessRow[] = [];
  const story = store.readStory(storyId);
  const policy = resolveWorkflowPolicy(loadConfig(projectRoot), story);
  if (!policy.review.requireReviewer) {
    return [row({
      id: 'review.policy',
      status: 'pass',
      source: 'review',
      sourceRef: 'workflow.policy.review.requireReviewer',
      owner: 'reviewer',
      category: 'advisory',
      code: 'review_not_required_by_policy',
      reason: `Workflow profile ${policy.profile} does not require reviewer evidence`,
      blocking: false,
    })];
  }

  let loopRecords;
  try {
    loopRecords = store.readReviewLoopRecords(storyId);
    const openLoops = loopRecords.filter((record) => record.status === 'open');
    if (openLoops.length > 0) {
      rows.push(row({
        id: 'review.loops',
        status: 'blocked',
        source: 'review',
        sourceRef: 'review-loops.jsonl',
        owner: 'reviewer',
        category: 'blocking',
        code: 'open_review_loop',
        reason: `${openLoops.length} review loop(s) are still open`,
        nextCommand: rollbackToDevCommand(storyId),
      }));
    }
  } catch (err) {
    rows.push(row({
      id: 'review.loops',
      status: 'blocked',
      source: 'review',
      sourceRef: 'review-loops.jsonl',
      owner: 'reviewer',
      category: 'blocking',
      code: 'review_loop_record_error',
      reason: `Review loop records could not be read: ${err instanceof Error ? err.message : String(err)}`,
      nextCommand: `lattice review_loop_status '{"storyId":"${storyId}"}'`,
    }));
  }

  const findings = store.readFindings(storyId).findings ?? [];
  const passes = store.readReviewPasses(storyId).passes ?? [];
  if (findings.length === 0 && passes.length === 0) {
    rows.push(row({
      id: 'review.evidence',
      status: 'blocked',
      source: 'review',
      sourceRef: 'findings.json + review-passes.json',
      owner: 'reviewer',
      category: 'missing',
      code: 'missing_review_evidence',
      reason: 'No reviewer finding or review pass is recorded',
      nextCommand: `lattice review_run_start '{"storyId":"${storyId}","agent":"lattice-review-<name>"}'`,
    }));
    return rows;
  }

  const evidenceState = collectReviewerEvidenceState(store, storyId, projectRoot);
  if (evidenceState.invalid.length > 0) {
    rows.push(row({
      id: 'review.evidence_bindings',
      status: 'blocked',
      source: 'review',
      sourceRef: 'review-runs.json + findings/review-passes',
      owner: 'reviewer',
      category: 'stale',
      code: 'invalid_review_run_binding',
      reason: evidenceState.invalid.slice(0, 3).map((issue) => issue.message).join('; '),
      nextCommand: rollbackToDevCommand(storyId),
    }));
  }

  const { severities, roundCount } = currentBlockingSeverities(store, storyId, projectRoot);
  if (policy.review.requireReviewerFinding) {
    const currentRoundReviewerEvidence = evidenceState.valid.map((record) => ({
      agent: record.agent,
      kind: record.kind,
      signatureValid: record.signatureValid,
    }));
    if (roundCount <= 1) {
      const activeReviewers = activeReviewersForStory(store, storyId, projectRoot);
      const missing = activeReviewers.filter((reviewer) => !currentRoundReviewerEvidence.some(
        (evidence) => findingAgentMatchesReviewer(evidence.agent, reviewer.name),
      ));
      if (missing.length > 0) {
        for (const reviewer of missing) {
          const lane = reviewerLane(reviewer.name);
          rows.push(row({
            id: `review.required_lane.${reviewer.name}`,
            status: 'blocked',
            source: 'review',
            sourceRef: 'reviewer_list/computeActiveReviewers',
            owner: 'reviewer',
            category: 'missing',
            code: 'missing_required_review_lane',
            reason: `Round ${roundCount} requires reviewer lane ${lane} (${reviewer.reason}); no valid current-round finding or review pass is recorded`,
            nextCommand: reviewerRunStartCommand(storyId, lane),
          }));
        }
      } else {
        rows.push(row({
          id: 'review.required_lanes',
          status: 'pass',
          source: 'review',
          sourceRef: 'reviewer_list/computeActiveReviewers',
          owner: 'reviewer',
          category: 'advisory',
          code: 'required_review_lanes_covered',
          reason: `Round ${roundCount} reviewer evidence covers all ${activeReviewers.length} active lane(s): ${activeReviewers.map((reviewer) => reviewer.name).join(', ')}`,
          blocking: false,
        }));
      }

      const quorum = evaluateReviewerQuorum({
        activeReviewers: activeReviewers.map((reviewer) => reviewer.name),
        evidence: quorumEvidence(currentRoundReviewerEvidence),
        profile: policy.profile as 'light' | 'balanced' | 'strict',
      });
      if (!quorum.ok) {
        rows.push(row({
          id: 'review.quorum',
          status: 'blocked',
          source: 'review',
          sourceRef: 'reviewer-quorum.evaluateReviewerQuorum',
          owner: 'reviewer',
          category: 'blocking',
          code: 'reviewer_quorum_not_met',
          reason: `Round ${roundCount} reviewer quorum not met: ${quorum.blocking.slice(0, 3).join('; ')}`,
          nextCommand: rollbackToDevCommand(storyId),
        }));
      } else if (quorum.warnings.length > 0) {
        rows.push(row({
          id: 'review.quorum',
          status: 'warn',
          source: 'review',
          sourceRef: 'reviewer-quorum.evaluateReviewerQuorum',
          owner: 'reviewer',
          category: 'advisory',
          code: 'reviewer_quorum_advisory',
          reason: `Round ${roundCount} reviewer quorum warnings: ${quorum.warnings.slice(0, 3).join('; ')}`,
          blocking: false,
        }));
      } else {
        rows.push(row({
          id: 'review.quorum',
          status: 'pass',
          source: 'review',
          sourceRef: 'reviewer-quorum.evaluateReviewerQuorum',
          owner: 'reviewer',
          category: 'advisory',
          code: 'reviewer_quorum_met',
          reason: `Round ${roundCount} reviewer quorum is met`,
          blocking: false,
        }));
      }
    } else if (currentRoundReviewerEvidence.length === 0) {
      rows.push(row({
        id: 'review.current_round_evidence',
        status: 'blocked',
        source: 'review',
        sourceRef: 'findings.json + review-passes.json',
        owner: 'reviewer',
        category: 'missing',
        code: 'missing_current_round_review_evidence',
        reason: `Round ${roundCount} requires at least one valid current-round reviewer finding or review pass`,
        nextCommand: `lattice reviewer_list '{"storyId":"${storyId}"}'`,
      }));
    } else {
      rows.push(row({
        id: 'review.current_round_evidence',
        status: 'pass',
        source: 'review',
        sourceRef: 'findings.json + review-passes.json',
        owner: 'reviewer',
        category: 'advisory',
        code: 'current_round_review_evidence_present',
        reason: `Round ${roundCount} has ${currentRoundReviewerEvidence.length} valid reviewer evidence record(s)`,
        blocking: false,
      }));
    }
  }

  const blockingFindings = evidenceState.valid
    .map((record) => record.finding)
    .filter((finding): finding is Finding => !!finding)
    .filter((finding) => isFindingBlocking(finding, severities, roundCount));
  if (blockingFindings.length > 0) {
    rows.push(row({
      id: 'review.findings',
      status: 'blocked',
      source: 'review',
      sourceRef: 'findings.json',
      owner: 'reviewer',
      category: 'blocking',
      code: 'open_blocking_review_finding',
      reason: `${blockingFindings.length} blocking finding(s) open (Round ${roundCount}, blocking: ${severities.join('/')})`,
      nextCommand: rollbackToDevCommand(storyId),
    }));
  } else {
    rows.push(row({
      id: 'review.findings',
      status: 'pass',
      source: 'review',
      sourceRef: 'findings.json + review-passes.json',
      owner: 'reviewer',
      category: 'advisory',
      code: 'no_open_blocking_review_findings',
      reason: `${evidenceState.valid.length} valid reviewer evidence record(s), no open blocking findings`,
      blocking: false,
    }));
  }

  if ((evidenceState.advisories ?? []).length > 0) {
    rows.push(row({
      id: 'review.advisories',
      status: 'warn',
      source: 'review',
      sourceRef: 'review-runs.json',
      owner: 'reviewer',
      category: 'advisory',
      code: 'review_evidence_advisory',
      reason: evidenceState.advisories!.slice(0, 3).map((issue) => issue.message).join('; '),
      blocking: false,
    }));
  }

  return rows;
}

function doneRowNextCommand(storyId: string, row: DoneCheckRow): string | undefined {
  switch (row.id) {
    case 'test-evidence':
    case 'verification-intent-coverage':
      return validationCommand(storyId);
    case 'evidence-freshness':
    case 'done-required-validation':
    case 'branch-synced-main':
      return row.blocking ? donePrepareCommand(storyId) : undefined;
    case 'bugs-fixed':
      return row.blocking ? `lattice bug_list '{"storyId":"${storyId}"}'` : undefined;
    case 'git-working-tree':
      return row.blocking ? 'git status --short' : undefined;
    case 'story-summary':
      return row.blocking ? row.hint : undefined;
    case 'delivery-check':
      return row.blocking
        ? `lattice delivery_check_set --storyId=${storyId} --agentId=lattice-review-delivery ...`
        : undefined;
    case 'eval-evidence':
    case 'codex-adapter-evidence':
      return row.blocking ? row.hint : undefined;
    default:
      return undefined;
  }
}

function classifyDoneRow(storyId: string, row: DoneCheckRow): Pick<StoryReadinessRow, 'source' | 'owner' | 'category' | 'code' | 'nextCommand'> {
  const lowerDetail = (row.detail ?? '').toLowerCase();
  const baseCategory: LifecycleReadinessCategory = row.status === 'warn'
    ? 'advisory'
    : row.status === 'fail'
      ? (lowerDetail.includes('stale') || lowerDetail.includes('hash') ? 'stale' : 'blocking')
      : 'advisory';
  const next = doneRowNextCommand(storyId, row);
  switch (row.id) {
    case 'test-evidence':
      if (/no test evidence|does not exist/.test(lowerDetail)) {
        return { source: 'validate', owner: 'host', category: 'missing', code: 'missing_validation_evidence', nextCommand: next };
      }
      return { source: 'validate', owner: 'host', category: row.status === 'pass' ? 'advisory' : 'blocking', code: row.status === 'pass' ? 'validation_passed' : 'validation_blocking', nextCommand: next };
    case 'verification-intent-coverage':
      return { source: 'validate', owner: 'host', category: row.status === 'pass' ? 'advisory' : 'missing', code: row.status === 'pass' ? 'verification_intent_coverage_passed' : 'missing_verification_coverage', nextCommand: next };
    case 'evidence-freshness':
      return { source: 'validate', owner: 'host', category: row.status === 'pass' ? 'advisory' : 'stale', code: row.status === 'pass' ? 'verification_evidence_fresh' : 'stale_verification_evidence', nextCommand: next };
    case 'done-required-validation':
      if (row.status === 'pass' && !row.blocking) return { source: 'validate', owner: 'host', category: 'advisory', code: 'done_required_validation_passed', nextCommand: next };
      if (/not required|no done|required/.test(lowerDetail) && !row.blocking) return { source: 'validate', owner: 'host', category: 'advisory', code: 'done_required_validation_not_required', nextCommand: next };
      if (/missing/.test(lowerDetail)) return { source: 'validate', owner: 'host', category: 'missing', code: 'missing_done_required_validation', nextCommand: next };
      return { source: 'validate', owner: 'host', category: baseCategory, code: baseCategory === 'stale' ? 'stale_done_required_validation' : 'done_required_validation_blocking', nextCommand: next };
    case 'bugs-fixed':
      return { source: 'validate', owner: 'host', category: row.status === 'pass' ? 'advisory' : 'blocking', code: row.status === 'pass' ? 'bugs_fixed' : 'open_bugs', nextCommand: next };
    case 'git-working-tree':
      return { source: 'storyMachine', owner: 'host', category: row.status === 'pass' ? 'advisory' : 'blocking', code: row.status === 'pass' ? 'worktree_clean' : 'dirty_worktree', nextCommand: next };
    case 'branch-synced-main':
      return { source: 'storyMachine', owner: 'host', category: row.status === 'pass' || row.status === 'warn' ? 'advisory' : 'stale', code: row.status === 'pass' ? 'branch_synced_main' : row.status === 'warn' ? 'branch_sync_advisory' : 'branch_not_synced_main', nextCommand: next };
    case 'related-docs':
      return { source: 'storyMachine', owner: 'host', category: 'advisory', code: row.status === 'pass' ? 'related_docs_touched' : 'related_docs_advisory', nextCommand: next };
    case 'delivery-check':
      if (/hash mismatch|stale/.test(lowerDetail)) return { source: 'delivery', owner: 'delivery-reviewer', category: 'stale', code: 'stale_delivery_check', nextCommand: next };
      if (/missing/.test(lowerDetail)) return { source: 'delivery', owner: 'delivery-reviewer', category: 'missing', code: 'missing_delivery_check', nextCommand: next };
      if (row.status !== 'pass' && /docspromise|docs promise|unverified/.test(lowerDetail)) return { source: 'delivery', owner: 'delivery-reviewer', category: 'blocking', code: 'docs_promise_unresolved', nextCommand: next };
      return { source: 'delivery', owner: 'delivery-reviewer', category: row.status === 'pass' ? 'advisory' : 'blocking', code: row.status === 'pass' ? 'delivery_check_passed' : 'delivery_check_blocking', nextCommand: next };
    case 'story-summary':
      if (/no summary/.test(lowerDetail)) return { source: 'storyMachine', owner: 'host', category: row.blocking ? 'missing' : 'advisory', code: 'missing_story_summary', nextCommand: next };
      if (/missing|too short/.test(lowerDetail)) return { source: 'storyMachine', owner: 'host', category: row.blocking ? 'missing' : 'advisory', code: 'incomplete_story_summary', nextCommand: next };
      return { source: 'storyMachine', owner: 'host', category: 'advisory', code: 'story_summary_present', nextCommand: next };
    case 'user-value-summary':
      return { source: 'delivery', owner: 'delivery-reviewer', category: 'advisory', code: 'product_outcome_summarized', nextCommand: next };
    case 'review-escalation':
    case 'review-assurance-floor':
      return { source: 'review', owner: 'reviewer', category: row.status === 'pass' ? 'advisory' : 'blocking', code: row.id.replaceAll('-', '_'), nextCommand: next };
    case 'eval-evidence':
      return { source: 'delivery', owner: 'host', category: row.status === 'pass' ? 'advisory' : row.blocking ? 'missing' : 'advisory', code: row.status === 'pass' ? 'eval_evidence_passed' : 'missing_eval_evidence', nextCommand: next };
    case 'codex-adapter-evidence':
      return { source: 'storyMachine', owner: 'host', category: row.status === 'pass' ? 'advisory' : 'missing', code: row.status === 'pass' ? 'codex_adapter_evidence_passed' : 'missing_codex_adapter_evidence', nextCommand: next };
    default:
      return { source: 'storyMachine', owner: 'host', category: baseCategory, code: row.id.replaceAll('-', '_'), nextCommand: next };
  }
}

function mapDoneRow(storyId: string, doneRow: DoneCheckRow): StoryReadinessRow {
  const classified = classifyDoneRow(storyId, doneRow);
  const status: LifecycleReadinessStatus = doneRow.status === 'pass'
    ? 'pass'
    : doneRow.status === 'warn' || !doneRow.blocking
      ? 'warn'
      : 'blocked';
  return row({
    id: `done.${doneRow.id}`,
    status,
    source: classified.source,
    sourceRef: doneRow.source,
    owner: classified.owner,
    category: classified.category,
    code: classified.code,
    reason: [doneRow.label, doneRow.detail].filter(Boolean).join(': '),
    ...(classified.nextCommand ? { nextCommand: classified.nextCommand } : {}),
    blocking: status === 'blocked' && doneRow.blocking,
  });
}

function buildDoneRows(store: StoryStore, storyId: string, root: string, gitCwd: string): StoryReadinessRow[] {
  const rows = buildDoneChecklist(storyId, store, root, { gitCwd, auditWriter: null }).map((doneRow) => mapDoneRow(storyId, doneRow));
  const doneOracleHasBlockers = rows.some((doneRow) => doneRow.blocking);
  rows.push(row({
    id: 'done.done_prepare',
    status: doneOracleHasBlockers ? 'blocked' : 'warn',
    source: 'done_prepare',
    sourceRef: null,
    owner: 'done_prepare',
    category: doneOracleHasBlockers ? 'missing' : 'advisory',
    code: 'missing_done_prepare_report',
    reason: doneOracleHasBlockers
      ? 'No current done_prepare report is recorded in V1-readable structured storage; V1 does not run done_prepare'
      : 'No current done_prepare report is recorded; DONE oracle rows have no blockers, so done_prepare is advisory preflight guidance only',
    nextCommand: donePrepareCommand(storyId),
    blocking: doneOracleHasBlockers,
  }));
  rows.push(row({
    id: 'authority.local_only',
    status: 'external',
    source: 'authority',
    sourceRef: null,
    owner: 'authority',
    category: 'external',
    code: 'legacy_authority_receipt_ignored_by_v1',
    reason: 'V1 is local read-only readiness only; legacy authority receipt refs are ignored and current assurance comes from local proof-admissibility, receipt-bundle, and review quorum evidence',
    blocking: false,
  }));
  return rows;
}

function buildMainSyncReadinessRows(storyId: string, gitCwd: string): StoryReadinessRow[] {
  const readiness = buildMainSyncReadiness({ storyId, gitCwd });
  const advisory = renderMainSyncReadinessAdvisory(readiness);
  if (!advisory) return [];
  return [row({
    id: 'main-sync.readiness',
    status: 'warn',
    source: 'storyMachine',
    sourceRef: 'git merge-base --is-ancestor main HEAD + git rev-list --count HEAD..main',
    owner: 'done_prepare',
    category: 'advisory',
    code: 'branch_behind_main_advisory',
    reason: advisory,
    nextCommand: readiness.donePrepareCommand,
    blocking: false,
  })];
}

function buildPhaseRow(storyId: string, phase: StoryPhase, target: LifecycleReadinessTarget): StoryReadinessRow {
  const currentRank = PHASE_RANK[phase] ?? -1;
  const desiredRank = targetRank(target);
  if (phase === 'DISCARDED') {
    return row({
      id: 'state.phase',
      status: 'blocked',
      source: 'storyMachine',
      sourceRef: 'index.json.phase',
      owner: 'host',
      category: 'blocking',
      code: 'story_discarded',
      reason: `Story is DISCARDED and cannot target ${target}`,
    });
  }
  if (currentRank > desiredRank) {
    return row({
      id: 'state.phase',
      status: 'warn',
      source: 'storyMachine',
      sourceRef: 'index.json.phase',
      owner: 'host',
      category: 'advisory',
      code: 'target_already_passed',
      reason: `Story is already in ${phase}, past target ${target}`,
      blocking: false,
    });
  }
  return row({
    id: 'state.phase',
    status: 'pass',
    source: 'storyMachine',
    sourceRef: 'index.json.phase',
    owner: 'host',
    category: 'advisory',
    code: 'target_phase_readable',
    reason: `Current phase ${phase}; target ${target}`,
    ...(phase === target ? {} : { nextCommand: storyAdvanceCommand(storyId, target) }),
    blocking: false,
  });
}

function buildHashRows(headHash: string | null, materialHash: string | null, storyFilesHash: string | null): StoryReadinessRow[] {
  const rows: StoryReadinessRow[] = [];
  if (!headHash) {
    rows.push(row({
      id: 'state.head_hash',
      status: 'warn',
      source: 'storyMachine',
      sourceRef: 'git rev-parse HEAD',
      owner: 'host',
      category: 'advisory',
      code: 'head_hash_unavailable',
      reason: 'Current git HEAD could not be read',
      blocking: false,
    }));
  }
  if (!materialHash) {
    rows.push(row({
      id: 'state.material_hash',
      status: 'warn',
      source: 'storyMachine',
      sourceRef: 'currentMaterialHash',
      owner: 'host',
      category: 'advisory',
      code: 'material_hash_unavailable',
      reason: 'Current material hash could not be derived',
      blocking: false,
    }));
  }
  if (!storyFilesHash) {
    rows.push(row({
      id: 'state.story_files_hash',
      status: 'warn',
      source: 'storyMachine',
      sourceRef: 'currentStoryFilesHash',
      owner: 'host',
      category: 'advisory',
      code: 'story_files_hash_unavailable',
      reason: 'Current storyFilesHash could not be derived; V1 leaves it unknown instead of inventing a hash',
      blocking: false,
    }));
  }
  return rows;
}

function nextActionsFromRows(rows: StoryReadinessRow[]): StoryReadinessNextAction[] {
  const actions: StoryReadinessNextAction[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.blocking && row.status !== 'manual' && row.status !== 'external') continue;
    const key = row.nextCommand ? `command:${row.nextCommand}` : `${row.status}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.nextCommand) {
      actions.push({ kind: 'command', owner: row.owner, command: row.nextCommand, reason: `${row.code}: ${row.reason}` });
    } else if (row.status === 'external') {
      actions.push({ kind: 'external_wait', owner: row.owner, reason: `${row.code}: ${row.reason}` });
    } else {
      actions.push({ kind: 'human_decision', owner: row.owner, reason: `${row.code}: ${row.reason}` });
    }
  }
  return actions;
}

export function buildStoryReadinessReport(input: BuildStoryReadinessReportInput): StoryReadinessReport {
  const { storyId, target, store, root } = input;
  const story = store.readStory(storyId);
  const gitCwd = input.gitCwd ?? resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  const headHash = currentGitHead(gitCwd) ?? null;
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', root) ?? null;
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', root) ?? null;
  const verificationEvidence = collectVerificationEvidence(store, storyId);
  const testEvidence = store.readTestEvidence(storyId);
  const deliveryCheck = store.readDeliveryCheck(storyId);

  const readiness: StoryReadinessRow[] = [
    buildPhaseRow(storyId, story.phase, target),
    ...buildHashRows(headHash, materialHash, storyFilesHash),
  ];
  if (target === 'REVIEW' || target === 'TEST') {
    readiness.push(...buildMainSyncReadinessRows(storyId, gitCwd));
  }
  if (target === 'REVIEW' || target === 'TEST' || target === 'DONE') {
    readiness.push(...buildReviewTargetRows(store, storyId, root));
  }
  if (target === 'TEST' || target === 'DONE') {
    readiness.push(...buildReviewGateRows(store, storyId, root));
    const evidence = store.readTestEvidence(storyId);
    if (!evidence) {
      readiness.push(row({
        id: 'test.validation',
        status: 'blocked',
        source: 'validate',
        sourceRef: 'test-evidence.json',
        owner: 'host',
        category: 'missing',
        code: 'missing_validation_evidence',
        reason: 'No validation evidence is recorded for TEST readiness',
        nextCommand: validationCommand(storyId),
      }));
    } else if (evidence.result !== 'PASS') {
      readiness.push(row({
        id: 'test.validation',
        status: 'blocked',
        source: 'validate',
        sourceRef: 'test-evidence.json',
        owner: 'host',
        category: 'blocking',
        code: 'validation_blocking',
        reason: `Latest validation result is ${evidence.result}`,
        nextCommand: validationCommand(storyId),
      }));
    } else {
      readiness.push(row({
        id: 'test.validation',
        status: 'pass',
        source: 'validate',
        sourceRef: 'test-evidence.json',
        owner: 'host',
        category: 'advisory',
        code: 'validation_passed',
        reason: `Latest validation PASS @ ${evidence.timestamp}`,
        blocking: false,
      }));
    }
  }
  if (target === 'DONE') {
    readiness.push(...buildDoneRows(store, storyId, root, gitCwd));
  }

  const localReady = !readiness.some((candidate) => candidate.blocking === true);
  return {
    storyId,
    target,
    phase: story.phase,
    headHash,
    materialHash,
    storyFilesHash,
    mode: { runCommands: false, writeEvidence: false },
    artifacts: {
      verificationEvidence: verificationEvidenceArtifacts(verificationEvidence),
      validationRef: testEvidence ? {
        source: 'test-evidence.json',
        result: testEvidence.result,
        timestamp: testEvidence.timestamp,
        headHash: testEvidence.headHash ?? null,
        materialHash: testEvidence.materialHash ?? null,
        storyFilesHash: testEvidence.storyFilesHash ?? null,
      } : null,
      reviewRound: story.currentReviewRound ?? null,
      deliveryCheckRef: deliveryCheck ? {
        source: 'delivery-check.json',
        checkedAt: deliveryCheck.checkedAt,
        headHash: deliveryCheck.headHash ?? null,
        materialHash: deliveryCheck.materialHash ?? null,
        reviewRound: deliveryCheck.reviewRound,
        hash: deliveryCheck._hash ?? null,
      } : null,
      liveSmokeTranscriptRef: null,
      metadataOnlyWaiverRef: null,
      donePrepareRef: null,
    },
    readiness,
    next: nextActionsFromRows(readiness),
    claims: {
      localReady,
      authorityDone: false,
      fullAuthorityDone: false,
      productionDone: false,
    },
  };
}

export function renderStoryReadinessReport(report: StoryReadinessReport): string {
  const blockers = report.readiness.filter((row) => row.blocking);
  const lines = [
    `Lifecycle check (${report.storyId} -> ${report.target})`,
    'mode: read-only',
    `phase: ${report.phase}`,
    `headHash: ${report.headHash ?? 'unknown'}`,
    `materialHash: ${report.materialHash ?? 'unknown'}`,
    `storyFilesHash: ${report.storyFilesHash ?? 'unknown'}`,
    `localReady: ${report.claims.localReady}`,
    `blockers: ${blockers.length}`,
    '',
    'Readiness:',
  ];
  for (const row of report.readiness) {
    const marker = row.blocking ? 'BLOCKED' : row.status.toUpperCase();
    lines.push(`  [${marker}] ${row.id} code=${row.code} category=${row.category} owner=${row.owner}`);
    lines.push(`        ${row.reason}`);
    if (row.nextCommand) lines.push(`        next: ${row.nextCommand}`);
  }
  lines.push('', 'Next actions:');
  if (report.next.length === 0) {
    lines.push('  none');
  } else {
    for (const action of report.next) {
      const detail = action.command ? `${action.command} — ${action.reason}` : action.reason;
      lines.push(`  - ${action.kind} owner=${action.owner}: ${detail}`);
    }
  }
  lines.push('', 'Claims:');
  lines.push(`  authorityDone: ${report.claims.authorityDone}`);
  lines.push(`  fullAuthorityDone: ${report.claims.fullAuthorityDone}`);
  lines.push(`  productionDone: ${report.claims.productionDone}`);
  return lines.join('\n');
}
