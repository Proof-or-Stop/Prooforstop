import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash } from './evidence-freshness.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import type { Finding, ReviewPass, ReviewRun, ReviewRunWorkspaceBinding, StoryInfo } from './types.js';
import type { StoryStore } from './store.js';
import { buildScopeDiffPack } from './scope-diff-pack.js';
import { resolveStorySignedWorkspace } from './story-signed-workspace-resolution.js';
import {
  buildCurrentScopeContext,
  compareScopeBinding,
  type CurrentScopeContext,
  type ScopeBindingComparison,
} from './review-scope-binding.js';

export const REVIEW_RUN_SALT = 'lattice-review-run-integrity-v1';

export const REVIEW_RUN_LANES = [
  'lattice-review-concept',
  'lattice-review-quality',
  'lattice-review-test-coverage',
  'lattice-review-behavior',
  'lattice-review-docs',
  'lattice-review-channel',
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
  | 'workspace_binding_tampered'
  | 'stale_workspace_binding'
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
  advisories?: ReviewRunIssue[];
}

const SUPERSEDED_PASS_ISSUE_CODES = new Set<ReviewRunIssueCode>([
  'stale_run',
  'stale_run_hash',
  'missing_scope_binding',
  'stale_scope_binding',
  'scope_binding_tampered',
]);

export function isReviewRunLane(value: string): value is ReviewRunLane {
  return (REVIEW_RUN_LANES as readonly string[]).includes(value);
}

// A finding / review pass counts as reviewer evidence (subject to reviewRunId
// binding) only when its agent is a lattice-review-* lane. main / main-agent /
// lattice-implementer / other non-reviewer actors create findings during DEV or
// for meta-process notes and must NOT be treated as reviewer evidence by the
// REVIEW→TEST gate. Mirrors the predicate used at finding_add time
// (handlers/finding.ts) and elsewhere in the codebase.
export function isReviewerAgent(agent: string | undefined | null): boolean {
  return !!agent && agent.startsWith('lattice-review-');
}

export function resolveReviewRunLane(agent?: string, lane?: string): ReviewRunLane {
  const resolvedAgent = (agent || '').trim();
  const resolvedLane = (lane || '').trim();
  const candidate = resolvedLane || resolvedAgent;
  if (!candidate) {
    throw new Error(`review_run_start: agent/lane must provide a valid lattice-review-* reviewer (supported: ${REVIEW_RUN_LANES.join(', ')})`);
  }
  if (resolvedAgent && !resolvedAgent.startsWith('lattice-review-')) {
    throw new Error(`review_run_start: agent "${resolvedAgent}" is not a lattice-review-* reviewer`);
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

export const REVIEW_RUN_WORKSPACE_BINDING_SCHEMA_VERSION = 'lattice.review_run_workspace_binding.v1';
export const REVIEW_RUN_WORKSPACE_BINDING_SALT = 'lattice-review-run-workspace-binding-v1';

export interface ReviewRunWorkspaceBindingInput {
  metadataRoot: string;
  invocationCwd: string;
  repoRoot?: string | null;
  signedWorkspaceRoot: string;
  workspaceMode: string;
  headHash: string;
  materialHash: string;
  storyFilesHash?: string;
}

function requireBindingText(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`review_run_start: workspaceBinding.${field} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeOptionalBindingText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() || '';
  return trimmed ? trimmed : null;
}

function workspaceBindingPayload(binding: Omit<ReviewRunWorkspaceBinding, 'bindingHash'>): Record<string, unknown> {
  return {
    schemaVersion: binding.schemaVersion,
    metadataRoot: binding.metadataRoot,
    invocationCwd: binding.invocationCwd,
    repoRoot: binding.repoRoot,
    signedWorkspaceRoot: binding.signedWorkspaceRoot,
    workspaceMode: binding.workspaceMode,
    headHash: binding.headHash,
    materialHash: binding.materialHash,
    ...(binding.storyFilesHash ? { storyFilesHash: binding.storyFilesHash } : {}),
    salt: REVIEW_RUN_WORKSPACE_BINDING_SALT,
  };
}

export function signReviewRunWorkspaceBinding(binding: Omit<ReviewRunWorkspaceBinding, 'bindingHash'>): string {
  return createHash('sha256')
    .update(JSON.stringify(workspaceBindingPayload(binding)))
    .digest('hex');
}

export function buildReviewRunWorkspaceBinding(input: ReviewRunWorkspaceBindingInput): ReviewRunWorkspaceBinding {
  const storyFilesHash = normalizeOptionalBindingText(input.storyFilesHash)
    ?? currentStoryFilesHash(input.signedWorkspaceRoot, 'HEAD', input.metadataRoot);
  const unsigned = {
    schemaVersion: REVIEW_RUN_WORKSPACE_BINDING_SCHEMA_VERSION,
    metadataRoot: requireBindingText('metadataRoot', input.metadataRoot),
    invocationCwd: requireBindingText('invocationCwd', input.invocationCwd),
    repoRoot: normalizeOptionalBindingText(input.repoRoot),
    signedWorkspaceRoot: requireBindingText('signedWorkspaceRoot', input.signedWorkspaceRoot),
    workspaceMode: requireBindingText('workspaceMode', input.workspaceMode),
    headHash: requireBindingText('headHash', input.headHash),
    materialHash: requireBindingText('materialHash', input.materialHash),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  } satisfies Omit<ReviewRunWorkspaceBinding, 'bindingHash'>;
  return {
    ...unsigned,
    bindingHash: signReviewRunWorkspaceBinding(unsigned),
  };
}

export function verifyReviewRunWorkspaceBinding(
  binding: ReviewRunWorkspaceBinding | null | undefined,
  run?: Pick<ReviewRun, 'headHash' | 'materialHash' | 'storyFilesHash'>,
): boolean {
  if (!binding || !binding.bindingHash) return false;
  if (binding.schemaVersion !== REVIEW_RUN_WORKSPACE_BINDING_SCHEMA_VERSION) return false;
  if (
    !binding.metadataRoot || !binding.invocationCwd || !binding.signedWorkspaceRoot
    || !binding.workspaceMode || !binding.headHash || !binding.materialHash
  ) {
    return false;
  }
  if (
    run && (
      run.headHash !== binding.headHash
      || run.materialHash !== binding.materialHash
      || (run.storyFilesHash !== undefined && run.storyFilesHash !== binding.storyFilesHash)
    )
  ) {
    return false;
  }
  const expected = signReviewRunWorkspaceBinding({
    schemaVersion: binding.schemaVersion,
    metadataRoot: binding.metadataRoot,
    invocationCwd: binding.invocationCwd,
    repoRoot: binding.repoRoot ?? null,
    signedWorkspaceRoot: binding.signedWorkspaceRoot,
    workspaceMode: binding.workspaceMode,
    headHash: binding.headHash,
    materialHash: binding.materialHash,
    ...(binding.storyFilesHash ? { storyFilesHash: binding.storyFilesHash } : {}),
  });
  return binding.bindingHash === expected;
}

export type ReviewRunSnapshotFailureCode = 'not_git_repo' | 'missing_head' | 'missing_material_hash';
const EMPTY_MATERIAL_HASH = createHash('sha256').update('').digest('hex');

export interface ReviewRunSnapshotFailure {
  code: ReviewRunSnapshotFailureCode;
  reason: string;
  nextAction: string;
}

export interface ReviewRunSnapshotContext {
  storyId?: string;
  storyPhase?: string;
  currentReviewRound?: string;
  workspaceMode?: string;
  expectedWorktreeRoot?: string;
}

function isGitRepository(gitCwd: string): boolean {
  // B-75f0 CHK-004: param named `gitCwd` because every caller chain ends at
  // captureReviewRunSnapshot(signedWorkspaceRoot, ...) — the inbound value is
  // the already-resolved signedWorkspaceRoot (authoritativeCwd), never a bare
  // metadataRoot. Pure rename, zero behavior change.
  try {
    const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result === 'true';
  } catch {
    return false;
  }
}

export function diagnoseReviewRunSnapshot(projectRoot: string): ReviewRunSnapshotFailure | null {
  if (!isGitRepository(projectRoot)) {
    return {
      code: 'not_git_repo',
      reason: `signed workspace is not a git repository: ${projectRoot}`,
      nextAction: 'Run inside a git-backed Proofbound project/worktree, or initialize git and create an initial commit before starting a signed reviewer run.',
    };
  }
  if (!currentGitHead(projectRoot)) {
    return {
      code: 'missing_head',
      reason: `git HEAD cannot be resolved from signed workspace: ${projectRoot}`,
      nextAction: 'Create at least one commit in the signed workspace before starting a reviewer run.',
    };
  }
  const materialHash = currentMaterialHash(projectRoot);
  if (!materialHash || materialHash === EMPTY_MATERIAL_HASH) {
    return {
      code: 'missing_material_hash',
      reason: `materialHash cannot be computed from signed workspace: ${projectRoot}`,
      nextAction: 'Check git tree/materialHash exclusions and rerun from the project or story worktree root.',
    };
  }
  return null;
}

function formatSnapshotFailure(failure: ReviewRunSnapshotFailure, context?: ReviewRunSnapshotContext): string {
  const storyPrefix = context?.storyId
    ? `story ${context.storyId}${context.storyPhase ? ` is in ${context.storyPhase}` : ''}`
    : 'the story';
  const roundStatus = context?.currentReviewRound
    ? ' and currentReviewRound is initialized'
    : '';
  const workspaceHint = context?.workspaceMode === 'story-worktree' && context.expectedWorktreeRoot
    ? `\nExpected story worktree: ${context.expectedWorktreeRoot}`
    : '';
  return [
    `review_run_start: ${storyPrefix}${roundStatus}, but this command cannot capture a git HEAD/materialHash from the signed workspace.`,
    `Reason [${failure.code}]: ${failure.reason}`,
    'No reviewer run was created. No legacy currentReviewRound repair was written before signed snapshot readiness succeeded.',
    'Host runners such as Claude CLI or Codex CLI may execute this command, but they do not manufacture material snapshots or Authority receipts.',
    `Next action: ${failure.nextAction}${workspaceHint}`,
  ].join('\n');
}

export function captureReviewRunSnapshot(projectRoot: string, context?: ReviewRunSnapshotContext): { headHash: string; materialHash: string; storyFilesHash?: string } {
  const failure = diagnoseReviewRunSnapshot(projectRoot);
  if (failure) {
    throw new Error(formatSnapshotFailure(failure, context));
  }
  const storyFilesHash = currentStoryFilesHash(projectRoot);
  return {
    headHash: currentGitHead(projectRoot)!,
    materialHash: currentMaterialHash(projectRoot)!,
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
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
  // B-b750: workspace binding hash, appended only when present so legacy runs
  // without workspaceBinding remain verifiable while new split-root-aware runs
  // bind HEAD/materialHash to the exact signed workspace interpretation.
  workspaceBindingHash?: string,
  // B-5a9a: storyFilesHash is appended only when present so legacy review runs
  // without the secondary binding keep the exact previous signature domain.
  storyFilesHash?: string,
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
  if (storyFilesHash) parts.push(storyFilesHash);
  if (scopeBindingHash) parts.push(scopeBindingHash);
  if (workspaceBindingHash) parts.push(workspaceBindingHash);
  parts.push(REVIEW_RUN_SALT);
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

function defaultReviewRoundFromStory(story: StoryInfo): string {
  if (!story.createdAt) return new Date().toISOString();
  if (Number.isFinite(Date.parse(story.createdAt))) return story.createdAt;
  return new Date().toISOString();
}

export function ensureCurrentReviewRound(
  store: StoryStore,
  storyId: string,
  commandName: string,
): StoryInfo {
  const story = store.readStory(storyId);
  if (!story.currentReviewRound) {
    if (story.phase !== 'REVIEW') {
      throw new Error(
        `${commandName}: story ${storyId} must be in REVIEW phase (current: ${story.phase})`,
      );
    }
    story.currentReviewRound = defaultReviewRoundFromStory(story);
    if (!story.events) story.events = [];
    story.events.push({
      phase: 'REVIEW',
      action: 'reviewer_forced',
      timestamp: new Date().toISOString(),
      reason: `${commandName} auto-initialized missing currentReviewRound for legacy direct REVIEW story`,
      agent: 'main',
    });
    store.writeStory(storyId, story);
  }
  if (!story.currentReviewRound) {
    throw new Error(
      `${commandName}: failed to initialize currentReviewRound for ${storyId}; ` +
      'story metadata is inconsistent. Please recreate through a supported REVIEW-entry flow.',
    );
  }
  return story;
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
    run.workspaceBinding?.bindingHash,
    run.storyFilesHash,
  );
  return run._hash === expected
    && (!run.workspaceBinding || verifyReviewRunWorkspaceBinding(run.workspaceBinding, run));
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
  return `→ Current REVIEW round has no available reviewer run: run lattice review_run_start '{"storyId":"${storyId}","agent":"${lane}"}', then resubmit finding_add/review_pass_set with the returned reviewRunId`;
}

function latestRunHint(storyId: string, lane: string, latestRunId?: string): string {
  const latest = latestRunId ? `(current latest: ${latestRunId})` : '';
  return `→ Current lane already has a newer reviewer run${latest}: use the latest reviewRunId to resubmit finding_add/review_pass_set; do not reuse the old reviewRunId`;
}

function roundMismatchHint(storyId: string, lane: string): string {
  return `→ This reviewRunId does not belong to the current REVIEW round: run lattice review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' to obtain the reviewRunId for the current round, then resubmit finding_add/review_pass_set`;
}

function staleMaterialHint(storyId: string, lane: string): string {
  return `→ The reviewRunId's HEAD/materialHash is stale and cannot be fixed by repeatedly running review_run_start within the same REVIEW round; first return to DEV to fix and commit, then run lattice story_advance '{"storyId":"${storyId}","phase":"REVIEW"}' to enter a new currentReviewRound, and subsequently run lattice review_run_start '{"storyId":"${storyId}","agent":"${lane}"}'`;
}

// ── B-6bfd CHK-005: review scope binding (scope-protected stories only) ──

function scopeBindingHint(storyId: string, lane: string): string {
  return `→ scope-protected story: reviewer evidence must be bound to the current scope contract and diff. Re-run lattice review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' to capture the latest scopeContractHash/diffPackHash, then use the new reviewRunId to resubmit finding_add/review_pass_set`;
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

interface RunWorkspaceBindingValidation {
  ok: boolean;
  projectRoot: string;
  code?: Extract<ReviewRunIssueCode, 'workspace_binding_tampered' | 'stale_workspace_binding'>;
  message?: string;
}

function canonicalBindingPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function canonicalOptionalBindingPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim() || '';
  return trimmed ? canonicalBindingPath(trimmed) : null;
}

function validateRunWorkspaceBindingMatchesCurrentResolution(
  store: StoryStore,
  run: ReviewRun,
): RunWorkspaceBindingValidation | null {
  const binding = run.workspaceBinding;
  if (!binding) return null;

  let currentResolution: ReturnType<typeof resolveStorySignedWorkspace>;
  try {
    currentResolution = resolveStorySignedWorkspace({
      store,
      storyId: run.storyId,
      metadataRoot: binding.metadataRoot,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      projectRoot: binding.signedWorkspaceRoot,
      code: 'stale_workspace_binding',
      message: `reviewRunId ${run.reviewRunId} workspaceBinding cannot be compared to current story signed workspace resolution: ${reason}`,
    };
  }

  if (!currentResolution.resolved || !currentResolution.signedWorkspaceRoot) {
    return {
      ok: false,
      projectRoot: binding.signedWorkspaceRoot,
      code: 'stale_workspace_binding',
      message: `reviewRunId ${run.reviewRunId} workspaceBinding no longer matches a resolved current story signed workspace: ${currentResolution.unresolvedReason || 'unresolved'}`,
    };
  }

  const comparisons = [
    {
      field: 'metadataRoot',
      actual: canonicalBindingPath(binding.metadataRoot),
      expected: currentResolution.metadataRoot,
    },
    {
      field: 'signedWorkspaceRoot',
      actual: canonicalBindingPath(binding.signedWorkspaceRoot),
      expected: currentResolution.signedWorkspaceRoot,
    },
    {
      field: 'repoRoot',
      actual: canonicalOptionalBindingPath(binding.repoRoot),
      expected: currentResolution.repoRoot,
    },
    {
      field: 'workspaceMode',
      actual: binding.workspaceMode,
      expected: currentResolution.resolutionSource,
    },
  ];

  const mismatch = comparisons.find((entry) => entry.actual !== entry.expected);
  if (!mismatch) return null;

  return {
    ok: false,
    projectRoot: binding.signedWorkspaceRoot,
    code: 'stale_workspace_binding',
    message: (
      `reviewRunId ${run.reviewRunId} workspaceBinding is stale relative to current story signed workspace resolution: ` +
      `${mismatch.field} expected ${mismatch.expected ?? '(none)'}, got ${mismatch.actual ?? '(none)'}`
    ),
  };
}

function validateRunWorkspaceBinding(
  store: StoryStore,
  run: ReviewRun,
  fallbackProjectRoot: string,
): RunWorkspaceBindingValidation {
  if (!run.workspaceBinding) {
    return { ok: true, projectRoot: fallbackProjectRoot };
  }

  if (!verifyReviewRunWorkspaceBinding(run.workspaceBinding, run)) {
    return {
      ok: false,
      projectRoot: run.workspaceBinding.signedWorkspaceRoot || fallbackProjectRoot,
      code: 'workspace_binding_tampered',
      message: `reviewRunId ${run.reviewRunId} has tampered workspaceBinding or mismatched headHash/materialHash`,
    };
  }

  const currentResolutionMismatch = validateRunWorkspaceBindingMatchesCurrentResolution(store, run);
  if (currentResolutionMismatch) return currentResolutionMismatch;

  const signedWorkspaceRoot = run.workspaceBinding.signedWorkspaceRoot;
  const failure = diagnoseReviewRunSnapshot(signedWorkspaceRoot);
  if (failure) {
    return {
      ok: false,
      projectRoot: signedWorkspaceRoot,
      code: 'stale_workspace_binding',
      message: `reviewRunId ${run.reviewRunId} workspaceBinding signedWorkspaceRoot is no longer a usable git material root: ${failure.reason}`,
    };
  }

  return { ok: true, projectRoot: signedWorkspaceRoot };
}

function workspaceBindingHint(storyId: string, lane: string): string {
  return `→ Re-run lattice review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' from the resolved signed workspace, then resubmit finding_add/review_pass_set with the new reviewRunId`;
}

export function assertCurrentReviewRunForEvidence(
  store: StoryStore,
  story: StoryInfo,
  projectRoot: string,
  agent: string,
  reviewRunId: string | undefined,
): ReviewRun {
  if (!story.currentReviewRound) {
    throw new Error(
      `review_run_start: story ${story.storyId} is marked REVIEW but missing currentReviewRound. ` +
      `This likely came from legacy direct --phase=REVIEW creation before review metadata initialization; ` +
      `recreate this story through a supported REVIEW-entry flow before running reviewer commands.`,
    );
  }
  if (!reviewRunId || !reviewRunId.trim()) {
    throw new Error(`review evidence for ${agent} is missing reviewRunId. ${startRunHint(story.storyId, agent)}`);
  }
  const runs = store.readReviewRuns(story.storyId).runs;
  const run = runs.find((candidate) => candidate.reviewRunId === reviewRunId);
  if (!run) {
    throw new Error(`review evidence for ${agent} references unknown reviewRunId ${reviewRunId}. ${startRunHint(story.storyId, agent)}`);
  }
  const workspaceValidation = validateRunWorkspaceBinding(store, run, projectRoot);
  if (!workspaceValidation.ok) {
    throw new Error(
      `review evidence for ${agent} bound reviewRunId ${reviewRunId} has invalid workspace binding: ` +
      `${workspaceValidation.message}. ${workspaceBindingHint(story.storyId, agent)}`,
    );
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
  // review-run-binding-race (friction #2): NO id-recency rejection. A second
  // review_run_start on a lane only mints a newer reviewRunId; it does not change
  // what was reviewed. A pass/finding bound to a NON-latest run in the CURRENT
  // round is accepted as long as it is still material-fresh + scope-fresh (enforced
  // below) — rejecting it purely because a newer run exists is the benign
  // concurrent/retried-run binding race. The freshness check (material/storyFilesHash,
  // with the EMPTY-set no-signal guard) and the scope-binding check are the real
  // staleness authorities; id-recency carries no material/scope information.
  const signedProjectRoot = workspaceValidation.projectRoot;
  const freshness = checkEvidenceFreshnessForGit(
    signedProjectRoot,
    run.headHash,
    run.materialHash,
    signedProjectRoot,
    run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash,
  );
  if (!freshness.fresh) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} is stale: ${freshness.reason}. ${staleMaterialHint(story.storyId, agent)}`);
  }
  if (freshness.warnings?.length) {
    console.warn(`review evidence for ${agent} bound reviewRunId ${reviewRunId}: ${freshness.warnings.join('; ')}`);
  }
  // B-6bfd CHK-005: for a scope-protected story, the run's scope binding must
  // still match the live scope contract + diff. A reviewer must capture a fresh
  // binding (via review_run_start) before recording evidence; natural-language
  // evidence with no/stale binding is rejected here at write time.
  const scopeContext = currentScopeContextForStory(store, story.storyId, signedProjectRoot);
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
  store: StoryStore,
  story: StoryInfo,
  projectRoot: string,
  runs: ReviewRun[],
  evidence: ReviewerEvidenceRecord,
  scopeContext: CurrentScopeContext | null,
  advisories?: ReviewRunIssue[],
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
  const workspaceValidation = validateRunWorkspaceBinding(store, run, projectRoot);
  if (!workspaceValidation.ok) {
    return {
      code: workspaceValidation.code ?? 'workspace_binding_tampered',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId} has invalid workspace binding: ${workspaceValidation.message}. ${workspaceBindingHint(story.storyId, evidence.agent)}`,
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
  // review-run-binding-race (friction #2): the id-recency 'stale_run' rejection is
  // RELAXED FOR PASSES only. A material-fresh non-latest PASS in the current round
  // stays valid (the freshness + scope checks below are the authorities), fixing the
  // concurrent/retried review_run_start race that stranded an otherwise-valid pass and
  // blocked quorum_submit. It is KEPT FOR FINDINGS so an older OPEN finding is still
  // surfaced and is NOT hidden by a newer pass on the same lane; the supersede filter
  // in collectReviewerEvidenceState already drops a stale_run finding once it is
  // resolved/dismissed (terminal), so resolved findings stay superseded as before.
  const currentRun = currentRunForLane(runs, evidence.agent, story.currentReviewRound);
  if (currentRun && currentRun.reviewRunId !== run.reviewRunId && evidence.kind !== 'pass') {
    return {
      code: 'stale_run',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId}: Not the latest run on the current lane (current: ${currentRun.reviewRunId}). ${latestRunHint(story.storyId, evidence.agent, currentRun.reviewRunId)}`,
    };
  }
  const signedProjectRoot = workspaceValidation.projectRoot;
  const freshness = checkEvidenceFreshnessForGit(
    signedProjectRoot,
    run.headHash,
    run.materialHash,
    signedProjectRoot,
    run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash,
  );
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
  if (freshness.warnings?.length) {
    advisories?.push({
      code: 'stale_run_hash',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} bound reviewRunId ${evidence.reviewRunId} has whole-tree materialHash drift but matching storyFilesHash: ${freshness.warnings.join('; ')}`,
    });
  }
  // B-6bfd CHK-005: scope-protected stories require the run's scope binding to
  // match the live scope contract + diff. Checked last so it only applies to the
  // current, otherwise-valid run. scopeContext is null for unprotected/legacy
  // stories → this whole block is skipped (backward compatible).
  const effectiveScopeContext = run.workspaceBinding
    ? currentScopeContextForStory(store, story.storyId, signedProjectRoot)
    : scopeContext;
  if (effectiveScopeContext) {
    const cmp = compareScopeBinding(run.scopeBinding, effectiveScopeContext);
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

  // Only true reviewer lanes (lattice-review-*) require reviewRunId binding.
  // main / main-agent / lattice-implementer / other non-reviewer actors create
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
  const advisories: ReviewRunIssue[] = [];

  for (const evidence of [...reviewerFindings, ...reviewerPasses]) {
    const issue = validateEvidenceRunBinding(store, story, projectRoot, runs, evidence, scopeContext, advisories);
    if (issue) {
      rawInvalid.push(issue);
    } else {
      valid.push(evidence);
    }
  }

  const agentsWithCurrentValidEvidence = new Set(valid.map((evidence) => evidence.agent));
  const terminalReviewerFindingIds = new Set(
    reviewerFindings
      .filter((evidence) => evidence.finding?.status === 'resolved' || evidence.finding?.status === 'dismissed')
      .map((evidence) => evidence.id),
  );
  const invalid = rawInvalid.filter((issue) => {
    if (!SUPERSEDED_PASS_ISSUE_CODES.has(issue.code)) return true;
    if (!agentsWithCurrentValidEvidence.has(issue.agent)) return true;
    if (issue.kind === 'pass') return false;
    if (issue.kind === 'finding' && terminalReviewerFindingIds.has(issue.evidenceId)) return false;
    return true;
  });

  return { valid, invalid, ...(advisories.length > 0 ? { advisories } : {}) };
}
