import { createHash } from 'crypto';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash } from './evidence-freshness.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import type { Finding, ReviewPass, ReviewRun, StoryInfo } from './types.js';
import type { StoryStore } from './store.js';
import { buildScopeDiffPack } from './scope-diff-pack.js';
import {
  buildCurrentScopeContext,
  compareScopeBinding,
  type CurrentScopeContext,
  type ScopeBindingComparison,
} from './review-scope-binding.js';

export const REVIEW_RUN_SALT = 'koala-review-run-integrity-v1';

export const REVIEW_RUN_LANES = [
  'koala-review-concept',
  'koala-review-quality',
  'koala-review-test-coverage',
  'koala-review-behavior',
  'koala-review-docs',
  'koala-review-channel',
] as const;

export type ReviewRunLane = typeof REVIEW_RUN_LANES[number];
export type ReviewEvidenceKind = 'finding' | 'pass';
export type ReviewRunIssueCode =
  | 'missing_review_run_id'
  | 'invalid_evidence_signature'
  | 'unknown_run'
  | 'invalid_run_signature'
  | 'wrong_lane'
  | 'wrong_round'
  | 'stale_run'
  | 'stale_run_hash'
  // B-6bfd CHK-005: scope-binding lane codes (only for scope-protected stories).
  | 'missing_scope_binding'
  | 'stale_scope_binding'
  | 'scope_binding_tampered';

export interface ReviewRunIssue {
  code: ReviewRunIssueCode;
  kind: ReviewEvidenceKind;
  evidenceId: string;
  agent: string;
  reviewRunId?: string;
  message: string;
}

export interface ReviewerEvidenceRecord {
  id: string;
  kind: ReviewEvidenceKind;
  agent: string;
  reviewRound?: string;
  reviewRunId?: string;
  signatureValid?: boolean;
  finding?: Finding;
  pass?: ReviewPass;
}

export interface ReviewerEvidenceState {
  valid: ReviewerEvidenceRecord[];
  invalid: ReviewRunIssue[];
}

export function isReviewRunLane(value: string): value is ReviewRunLane {
  return (REVIEW_RUN_LANES as readonly string[]).includes(value);
}

// A finding / review pass counts as reviewer evidence (subject to reviewRunId
// binding) only when its agent is a koala-review-* lane. main / main-agent /
// koala-implementer / other non-reviewer actors create findings during DEV or
// for meta-process notes and must NOT be treated as reviewer evidence by the
// REVIEW→TEST gate. Mirrors the predicate used at finding_add time
// (handlers/finding.ts) and elsewhere in the codebase.
export function isReviewerAgent(agent: string | undefined | null): boolean {
  return !!agent && agent.startsWith('koala-review-');
}

export function resolveReviewRunLane(agent?: string, lane?: string): ReviewRunLane {
  const resolvedAgent = (agent || '').trim();
  const resolvedLane = (lane || '').trim();
  const candidate = resolvedLane || resolvedAgent;
  if (!candidate) {
    throw new Error(`review_run_start: agent/lane must provide a valid koala-review-* reviewer (supported: ${REVIEW_RUN_LANES.join(', ')})`);
  }
  if (resolvedAgent && !resolvedAgent.startsWith('koala-review-')) {
    throw new Error(`review_run_start: agent "${resolvedAgent}" is not a koala-review-* reviewer`);
  }
  if (!isReviewRunLane(candidate)) {
    throw new Error(`review_run_start: lane "${candidate}" is not in the supported REVIEW reviewer lane list (supported: ${REVIEW_RUN_LANES.join(', ')})`);
  }
  if (resolvedAgent && resolvedLane && resolvedAgent !== resolvedLane) {
    throw new Error(`review_run_start: agent "${resolvedAgent}" is inconsistent with lane "${resolvedLane}"`);
  }
  return candidate;
}

export function hashReviewPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function resolveReviewPromptHash(prompt?: string, promptHash?: string): string {
  const trimmedPromptHash = promptHash?.trim() || '';
  const trimmedPrompt = prompt?.trim() || '';
  if (!trimmedPrompt) return trimmedPromptHash;
  const computed = hashReviewPrompt(trimmedPrompt);
  if (trimmedPromptHash && trimmedPromptHash !== computed) {
    throw new Error('review_run_start: promptHash does not match the actual sha256 of prompt');
  }
  return computed;
}

export function captureReviewRunSnapshot(projectRoot: string): { headHash: string; materialHash: string } {
  const headHash = currentGitHead(projectRoot) || '';
  const materialHash = currentMaterialHash(projectRoot) || '';
  if (!headHash || !materialHash) {
    throw new Error('review_run_start: unable to capture current git HEAD/materialHash, please run inside the story worktree');
  }
  return { headHash, materialHash };
}

export function signReviewRun(
  storyId: string,
  reviewRunId: string,
  agent: string,
  lane: string,
  reviewRound: string,
  startedAt: string,
  headHash: string,
  materialHash: string,
  promptHash: string,
  // B-6bfd CHK-005: scope binding hash, appended ONLY when present so runs with
  // no scope binding (legacy / unprotected stories) sign byte-identically to the
  // pre-CHK-005 algorithm and stay verifiable. A new run on a scope-protected
  // story appends its bindingHash, making the binding tamper-evident.
  scopeBindingHash?: string,
): string {
  const parts = [
    storyId,
    reviewRunId,
    agent,
    lane,
    reviewRound,
    startedAt,
    headHash,
    materialHash,
    promptHash,
  ];
  if (scopeBindingHash) parts.push(scopeBindingHash);
  parts.push(REVIEW_RUN_SALT);
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

export function verifyReviewRun(run: ReviewRun): boolean {
  if (
    !run._hash || !run.storyId || !run.reviewRunId || !run.agent || !run.lane
    || !run.reviewRound || !run.startedAt || !run.headHash || !run.materialHash
  ) {
    return false;
  }
  const expected = signReviewRun(
    run.storyId,
    run.reviewRunId,
    run.agent,
    run.lane,
    run.reviewRound,
    run.startedAt,
    run.headHash,
    run.materialHash,
    run.promptHash || '',
    run.scopeBinding?.bindingHash,
  );
  return run._hash === expected;
}

function compareRunRecency(a: ReviewRun, b: ReviewRun): number {
  const aTime = Date.parse(a.startedAt);
  const bTime = Date.parse(b.startedAt);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
    return a.reviewRunId.localeCompare(b.reviewRunId);
  }
  return aTime - bTime;
}

function currentRunForLane(runs: ReviewRun[], lane: string, reviewRound: string): ReviewRun | null {
  const current = runs
    .filter(run => verifyReviewRun(run) && run.lane === lane && run.reviewRound === reviewRound)
    .sort(compareRunRecency);
  return current.length > 0 ? current[current.length - 1] : null;
}

function startRunHint(storyId: string, lane: string): string {
  return `→ Current REVIEW round has no available reviewer run: run koala review_run_start '{"storyId":"${storyId}","agent":"${lane}"}', then resubmit finding_add/review_pass_set with the returned reviewRunId`;
}

function latestRunHint(storyId: string, lane: string, latestRunId?: string): string {
  const latest = latestRunId ? `(current latest: ${latestRunId})` : '';
  return `→ Current lane already has a newer reviewer run${latest}: use the latest reviewRunId to resubmit finding_add/review_pass_set; do not reuse the old reviewRunId`;
}

function roundMismatchHint(storyId: string, lane: string): string {
  return `→ This reviewRunId does not belong to the current REVIEW round: run koala review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' to obtain the reviewRunId for the current round, then resubmit finding_add/review_pass_set`;
}

function staleMaterialHint(storyId: string, lane: string): string {
  return `→ The reviewRunId's HEAD/materialHash is stale and cannot be fixed by repeatedly running review_run_start within the same REVIEW round; first return to DEV to fix and commit, then run koala story_advance '{"storyId":"${storyId}","phase":"REVIEW"}' to enter a new currentReviewRound, and subsequently run koala review_run_start '{"storyId":"${storyId}","agent":"${lane}"}'`;
}

// ── B-6bfd CHK-005: review scope binding (scope-protected stories only) ──

function scopeBindingHint(storyId: string, lane: string): string {
  return `→ scope-protected story: reviewer evidence must be bound to the current scope contract and diff. Re-run koala review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' to capture the latest scopeContractHash/diffPackHash, then use the new reviewRunId to resubmit finding_add/review_pass_set`;
}

/**
 * Build the live scope context for a story, or null when the story is NOT
 * scope-protected (no scope contract → review scope binding is not required and
 * the gate stays backward compatible). buildScopeDiffPack swallows git errors
 * and returns a deterministic empty pack, so this never throws on non-git roots.
 */
export function currentScopeContextForStory(
  store: StoryStore,
  storyId: string,
  projectRoot: string,
): CurrentScopeContext | null {
  // B-6bfd CHK-006 fail-closed: store.readScopeContract returns null only for a
  // genuinely MISSING contract (legacy / unprotected story → no scope binding
  // required, fully backward compatible) and THROWS for a corrupt/unreadable
  // existing contract. We deliberately do NOT catch that throw: a scope-protected
  // story whose contract is corrupt must not silently downgrade to no-contract.
  // The throw propagates to the gate callers (canPassReview catches → false;
  // getGuardFailureReason / preflight surface a blocking reason), so the gate
  // fails closed instead of waving the review through.
  const contract = store.readScopeContract(storyId);
  if (!contract) return null;
  const diffPack = buildScopeDiffPack(projectRoot);
  return buildCurrentScopeContext(contract, diffPack, projectRoot);
}

function scopeComparisonToIssueCode(cmp: ScopeBindingComparison): ReviewRunIssueCode {
  if (cmp.code === 'missing_scope_binding') return 'missing_scope_binding';
  if (cmp.code === 'scope_binding_tampered') return 'scope_binding_tampered';
  return 'stale_scope_binding';
}

function scopeBindingMessage(
  storyId: string,
  lane: string,
  cmp: ScopeBindingComparison,
  evidenceLabel: string,
): string {
  return (
    `${evidenceLabel}（lane ${lane}）scope binding ${cmp.code}：` +
    `${cmp.detail ?? ''} (expected ${cmp.expected ?? '(none)'}, actual ${cmp.actual ?? '(none)'}). ` +
    scopeBindingHint(storyId, lane)
  );
}

export function assertCurrentReviewRunForEvidence(
  store: StoryStore,
  story: StoryInfo,
  projectRoot: string,
  agent: string,
  reviewRunId: string | undefined,
): ReviewRun {
  if (!story.currentReviewRound) {
    throw new Error(`review_run_start: story ${story.storyId} currently has no currentReviewRound; advance to REVIEW first before starting a reviewer run`);
  }
  if (!reviewRunId || !reviewRunId.trim()) {
    throw new Error(`review evidence for ${agent} is missing reviewRunId. ${startRunHint(story.storyId, agent)}`);
  }
  const runs = store.readReviewRuns(story.storyId).runs;
  const run = runs.find((candidate) => candidate.reviewRunId === reviewRunId);
  if (!run) {
    throw new Error(`review evidence for ${agent} references unknown reviewRunId ${reviewRunId}. ${startRunHint(story.storyId, agent)}`);
  }
  if (!verifyReviewRun(run)) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} has invalid signature. ${startRunHint(story.storyId, agent)}`);
  }
  if (run.lane !== agent) {
    throw new Error(`review evidence agent=${agent} does not match lane=${run.lane} of reviewRunId ${reviewRunId}. ${startRunHint(story.storyId, agent)}`);
  }
  if (run.reviewRound !== story.currentReviewRound) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} belongs to reviewRound ${run.reviewRound}, current round is ${story.currentReviewRound}. ${roundMismatchHint(story.storyId, agent)}`);
  }
  const currentRun = currentRunForLane(runs, agent, story.currentReviewRound);
  if (currentRun && currentRun.reviewRunId !== reviewRunId) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} is not the current latest reviewer run (current: ${currentRun.reviewRunId}). ${latestRunHint(story.storyId, agent, currentRun.reviewRunId)}`);
  }
  const freshness = checkEvidenceFreshnessForGit(projectRoot, run.headHash, run.materialHash);
  if (!freshness.fresh) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} is stale: ${freshness.reason}. ${staleMaterialHint(story.storyId, agent)}`);
  }
  // B-6bfd CHK-005: for a scope-protected story, the run's scope binding must
  // still match the live scope contract + diff. A reviewer must capture a fresh
  // binding (via review_run_start) before recording evidence; natural-language
  // evidence with no/stale binding is rejected here at write time.
  const scopeContext = currentScopeContextForStory(store, story.storyId, projectRoot);
  if (scopeContext) {
    const cmp = compareScopeBinding(run.scopeBinding, scopeContext);
    if (!cmp.ok) {
      throw new Error(
        scopeBindingMessage(story.storyId, agent, cmp, `review evidence for ${agent} bound reviewRunId ${reviewRunId}`),
      );
    }
  }
  return run;
}

function validateEvidenceRunBinding(
  story: StoryInfo,
  projectRoot: string,
  runs: ReviewRun[],
  evidence: ReviewerEvidenceRecord,
  scopeContext: CurrentScopeContext | null,
): ReviewRunIssue | null {
  if (!story.currentReviewRound) return null;
  if (evidence.reviewRound !== story.currentReviewRound) {
    return {
      code: 'wrong_round',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} belongs to reviewRound ${evidence.reviewRound || 'missing'}, current round is ${story.currentReviewRound}. ${roundMismatchHint(story.storyId, evidence.agent)}`,
    };
  }
  if (evidence.signatureValid === false) {
    return {
      code: 'invalid_evidence_signature',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} has invalid signature or record was tampered; REVIEW evidence with reviewRunId must use a signature that includes reviewRunId. ${startRunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (!evidence.reviewRunId) {
    return {
      code: 'missing_review_run_id',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      message: `${evidence.kind} ${evidence.id}: Missing reviewRunId; current REVIEW round reviewer evidence must be bound to review_run_start. ${startRunHint(story.storyId, evidence.agent)}`,
    };
  }
  const run = runs.find(candidate => candidate.reviewRunId === evidence.reviewRunId);
  if (!run) {
    return {
      code: 'unknown_run',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} references unknown reviewRunId ${evidence.reviewRunId}. ${startRunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (!verifyReviewRun(run)) {
    return {
      code: 'invalid_run_signature',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId} has invalid signature or record was tampered. ${startRunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (run.lane !== evidence.agent) {
    return {
      code: 'wrong_lane',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} has agent=${evidence.agent}, but reviewRunId ${evidence.reviewRunId} belongs to lane=${run.lane}. ${startRunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (run.reviewRound !== story.currentReviewRound) {
    return {
      code: 'wrong_round',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} reviewRunId ${evidence.reviewRunId} belongs to reviewRound ${run.reviewRound}, current round is ${story.currentReviewRound}. ${roundMismatchHint(story.storyId, evidence.agent)}`,
    };
  }
  const currentRun = currentRunForLane(runs, evidence.agent, story.currentReviewRound);
  if (currentRun && currentRun.reviewRunId !== run.reviewRunId) {
    return {
      code: 'stale_run',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId}: Not the latest run on the current lane (current: ${currentRun.reviewRunId}). ${latestRunHint(story.storyId, evidence.agent, currentRun.reviewRunId)}`,
    };
  }
  const freshness = checkEvidenceFreshnessForGit(projectRoot, run.headHash, run.materialHash);
  if (!freshness.fresh) {
    return {
      code: 'stale_run_hash',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId} is stale: ${freshness.reason}. ${staleMaterialHint(story.storyId, evidence.agent)}`,
    };
  }
  // B-6bfd CHK-005: scope-protected stories require the run's scope binding to
  // match the live scope contract + diff. Checked last so it only applies to the
  // current, otherwise-valid run. scopeContext is null for unprotected/legacy
  // stories → this whole block is skipped (backward compatible).
  if (scopeContext) {
    const cmp = compareScopeBinding(run.scopeBinding, scopeContext);
    if (!cmp.ok) {
      return {
        code: scopeComparisonToIssueCode(cmp),
        kind: evidence.kind,
        evidenceId: evidence.id,
        agent: evidence.agent,
        reviewRunId: evidence.reviewRunId,
        message: scopeBindingMessage(
          story.storyId,
          evidence.agent,
          cmp,
          `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId}`,
        ),
      };
    }
  }
  return null;
}

export function collectReviewerEvidenceState(
  store: StoryStore,
  storyId: string,
  projectRoot: string,
): ReviewerEvidenceState {
  const story = store.readStory(storyId);
  const currentRound = story.currentReviewRound;
  const runs = store.readReviewRuns(storyId).runs;
  const findings = store.readFindings(storyId).findings || [];
  const passes = store.readReviewPasses(storyId).passes || [];

  // Only true reviewer lanes (koala-review-*) require reviewRunId binding.
  // main / main-agent / koala-implementer / other non-reviewer actors create
  // findings during DEV or capture meta-process notes that must not be treated
  // as reviewer evidence by the REVIEW→TEST gate.
  const reviewerFindings = findings
    .filter((finding) => isReviewerAgent(finding.agent))
    .filter((finding) => !currentRound || finding.reviewRound === currentRound || !finding.reviewRound)
    .map((finding) => ({
      id: finding.id,
      kind: 'finding' as const,
      agent: finding.agent!,
      reviewRound: finding.reviewRound,
      reviewRunId: finding.reviewRunId,
      signatureValid: verifyFinding(storyId, finding),
      finding,
    }));
  const reviewerPasses = passes
    .filter((pass) => isReviewerAgent(pass.agent))
    .filter((pass) => !currentRound || pass.reviewRound === currentRound || !pass.reviewRound)
    .map((pass) => ({
      id: pass.id,
      kind: 'pass' as const,
      agent: pass.agent,
      reviewRound: pass.reviewRound,
      reviewRunId: pass.reviewRunId,
      signatureValid: verifyReviewPass(storyId, pass),
      pass,
    }));

  // B-6bfd CHK-005: compute the live scope context ONCE per call (null for
  // unprotected/legacy stories → no scope-binding enforcement, fully backward
  // compatible).
  const scopeContext = currentScopeContextForStory(store, storyId, projectRoot);

  const valid: ReviewerEvidenceRecord[] = [];
  const rawInvalid: ReviewRunIssue[] = [];

  for (const evidence of [...reviewerFindings, ...reviewerPasses]) {
    const issue = validateEvidenceRunBinding(story, projectRoot, runs, evidence, scopeContext);
    if (issue) {
      rawInvalid.push(issue);
    } else {
      valid.push(evidence);
    }
  }

  const agentsWithCurrentValidEvidence = new Set(valid.map((evidence) => evidence.agent));
  const invalid = rawInvalid.filter((issue) => {
    if (issue.kind !== 'pass') return true;
    if (issue.code !== 'stale_run' && issue.code !== 'stale_run_hash') return true;
    return !agentsWithCurrentValidEvidence.has(issue.agent);
  });

  return { valid, invalid };
}
