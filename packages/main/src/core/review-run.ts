import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  changedFilesBetween,
  checkEvidenceFreshnessForGit,
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
} from './evidence-freshness.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import {
  classifyReviewerExecutionAuthority,
  managedReviewerPromptDigest,
  verifyManagedReviewEvidence,
  verifyManagedReviewLiveBinding,
} from './managed-review-evidence.js';
import { verifyNativeReviewEvidenceBinding } from './native-review-evidence.js';
import { REVIEW_RETENTION_PROTOCOL_METADATA_PATHS } from './lifecycle-registry.js';
import type { Finding, ReviewPass, ReviewRun, ReviewRunWorkspaceBinding, ReviewInventoryPurposeBinding, StoryInfo } from './types.js';
import { canonicalJson } from './digest.js';
import type { StoryStore } from './store.js';
import { buildScopeDiffPack } from './scope-diff-pack.js';
import { resolveStorySignedWorkspace } from './story-signed-workspace-resolution.js';
import {
  buildCurrentScopeContext,
  compareScopeBinding,
  type CurrentScopeContext,
  type ScopeBindingComparison,
} from './review-scope-binding.js';
import {
  classifyCurrentCloseoutArtifactForReviewRetention,
  evaluateMetadataOnlyReviewRetention,
  readTrustedProofStoryScopeArtifacts,
} from './closeout-trust.js';
import { AGENT_DISPATCH_REGISTRY, resolveRegisteredAgentActor } from './agent-dispatch-registry.js';
import {
  verifyFullPromptAssemblyIntegrity,
  verifyIncrementalPromptAssemblyIntegrity,
  verifyPromptEnvelopeIntegrity,
} from './prompt-envelope.js';
import {
  domainSeparatedDigest,
  reviewerDispatchBindingDigest,
  parseReviewerDispatchResponsibility,
  type ReviewerDispatchResponsibility,
  reviewerDispatchPromptDigest,
  type PromptEnvelope,
} from './prompt-contracts.js';
import { BASELINE_RUNTIME_CONTRACT } from './prompt-measurement.js';
import { readPromptRegistry, type PromptHost } from './prompt-registry.js';
import { agentRoleIdsEqual, canonicalAgentRoleId } from './agent-role-identity.js';
import { loadConfig } from './config.js';
import {
  isPromptRoleEligibleForReviewEvidence,
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  promptRoleContract,
  promptRoleContractForSemanticDigest,
  reviewerHostRenderIdentity,
  resolvePromptEnvelopeRolloutMode,
  resolvePromptRoleBody,
} from './prompt-role-contract-registry.js';
import { reviewIncrementalContext } from './review-incremental-context.js';
import { assertReviewInventoryCutoff, currentOpenReviewInventory, inventoryPurposeMatchesEpoch } from './review-inventory-epoch.js';

export const REVIEW_RUN_SALT = 'lattice-review-run-integrity-v1';

type ReviewLaneForEntry<Entry> = Entry extends {
  readonly allowedPhases: infer Phases extends readonly string[];
  readonly reviewerLane: infer Lane extends string;
}
  ? 'REVIEW' extends Phases[number] ? Lane : never
  : never;

/** Includes the retired historical lane at the type boundary; runtime eligibility still rejects it. */
export type ReviewRunLane =
  | ReviewLaneForEntry<(typeof AGENT_DISPATCH_REGISTRY)[number]>
  | 'proof-or-stop-review-story-init'
  | 'proof-or-stop-review-scope-plan'
  | 'proof-or-stop-review-topology-critic'
  | 'proof-or-stop-review-concept'
  | 'proof-or-stop-review-quality'
  | 'proof-or-stop-review-test-coverage'
  | 'proof-or-stop-review-behavior'
  | 'proof-or-stop-review-docs'
  | 'proof-or-stop-review-delivery'
  | 'proof-or-stop-review-channel'
  // Historical lane spellings remain valid input types for persisted evidence
  // and migration tests; resolveReviewRunLane canonicalizes them before use.
  | 'lattice-review-story-init'
  | 'product-reviewer'
  | 'lattice-review-scope-plan'
  | 'lattice-review-topology-critic'
  | 'lattice-review-concept'
  | 'lattice-review-quality'
  | 'lattice-review-test-coverage'
  | 'lattice-review-behavior'
  | 'lattice-review-docs'
  | 'lattice-review-channel'
  | 'lattice-review-delivery';

/** Stable registry-order projection; the dispatch registry is the sole lane authority. */
export const REVIEW_RUN_LANES: readonly ReviewRunLane[] = Object.freeze(
  AGENT_DISPATCH_REGISTRY.flatMap((entry) =>
    entry.reviewerLane && (entry.allowedPhases as readonly string[]).includes('REVIEW')
      ? [entry.reviewerLane as ReviewRunLane]
      : []),
);
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
  | 'scope_binding_tampered'
  | 'missing_prompt_envelope'
  | 'prompt_envelope_tampered'
  | 'prompt_envelope_mismatch'
  | 'review_execution_authority_missing'
  | 'managed_receipt_invalid';

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
  envelopeId?: string;
  signatureValid?: boolean;
  finding?: Finding;
  pass?: ReviewPass;
}

export interface ReviewerEvidenceState {
  valid: ReviewerEvidenceRecord[];
  invalid: ReviewRunIssue[];
  advisories?: ReviewRunIssue[];
}

/**
 * Clone and freeze one prompt-envelope collection before passing it to any
 * verifier. The store owns the data it returns, so sharing those mutable
 * objects with a verifier would let one evidence check alter the inputs seen
 * by the next check in the same collection.
 */
export function snapshotPromptEnvelopes(
  envelopes: readonly PromptEnvelope[],
): readonly PromptEnvelope[] {
  return Object.freeze(envelopes.map(envelope => {
    const cloned: PromptEnvelope = {
      ...envelope,
    };
    // Absence is part of canonical envelope integrity: do not manufacture own
    // undefined keys. Preserve explicit malformed values for the verifier to
    // reject; a snapshot is isolation, never normalization or re-signing.
    return Object.freeze({
      ...cloned,
      ...(Array.isArray(cloned.eligibilityReasonCodes)
        ? { eligibilityReasonCodes: Object.freeze([...cloned.eligibilityReasonCodes]) }
        : {}),
      ...(Array.isArray(cloned.findingProjection)
        ? { findingProjection: Object.freeze(cloned.findingProjection.map(projection =>
          projection !== null && typeof projection === 'object' && !Array.isArray(projection)
            ? Object.freeze({ ...projection })
            : projection)) }
        : {}),
    }) as unknown as PromptEnvelope;
  }));
}

export interface ReviewerEvidenceCollectionOptions {
  /**
   * Verification seam used by focused mutation-isolation tests. Production
   * callers use verifyReviewRunPromptEnvelope by default.
   */
  verifyPromptEnvelope?: typeof verifyReviewRunPromptEnvelope;
}

const SUPERSEDED_PASS_ISSUE_CODES = new Set<ReviewRunIssueCode>([
  'stale_run',
  'stale_run_hash',
  'missing_scope_binding',
  'stale_scope_binding',
  'scope_binding_tampered',
  'missing_prompt_envelope',
  'prompt_envelope_tampered',
  'prompt_envelope_mismatch',
]);

// B-cdf6 / B-META F-019: the ONLY admissible finding statuses whose recorded
// defect is considered already discharged, and therefore whose binding-freshness
// (SUPERSEDED_PASS_ISSUE_CODES) issue may be forgiven in
// collectReviewerEvidenceState.
//
// Deliberately an explicit allowlist rather than a `!== 'open'` negation: a
// negation would silently grant forgiveness to any status added later (or to a
// hand-edited / legacy findings.json carrying an unknown or empty status), which
// is precisely the fail-OPEN shape this gate must not have. Anything not listed
// here — 'open', 'suspected', 'disproven', undefined, '', or an arbitrary
// injected string — is treated as NON-terminal and keeps its stale binding
// blocking. Per the Handler 编码约定 this predicate is the single re-validation
// point shared by every consumer, so a caller that bypasses Zod (internal fn
// call, old on-disk JSON) is still rejected.
const TERMINAL_REVIEWER_FINDING_STATUSES: ReadonlySet<string> = new Set([
  'resolved',
  'dismissed',
]);

// Matched EXACTLY — deliberately no trim()/lowercase normalization. A canonical
// finding status is written by finding_add / finding_resolve and never carries
// padding or alternate casing, so 'resolved ' or 'RESOLVED' signals hand-edited
// or foreign data. Normalizing it would widen the forgiveness surface to inputs
// no legitimate writer produces, so such values are treated as NON-terminal and
// keep their stale binding blocking.
export function isTerminalReviewerFindingStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  return TERMINAL_REVIEWER_FINDING_STATUSES.has(status);
}

export function isReviewRunLane(value: string): value is ReviewRunLane {
  return (REVIEW_RUN_LANES as readonly string[]).includes(canonicalAgentRoleId(value));
}

// A finding / review pass counts as reviewer evidence (subject to reviewRunId
// binding) only when its agent resolves to a proof-or-stop-review-* lane.
// Historical lattice-review-* values are explicit legacy compatibility input
// and are canonicalized before this check. lattice-implementer is a
// historical/legacy compatibility alias; the canonical implementer is
// proof-or-stop-implementer. main / main-agent / other non-reviewer actors
// create findings during DEV or for meta-process
// notes and must NOT be treated as reviewer evidence by the REVIEW→TEST gate.
// Mirrors the predicate used at finding_add time (handlers/finding.ts) and
// elsewhere in the codebase.
export function isReviewerAgent(agent: string | undefined | null): boolean {
  const entry = resolveRegisteredAgentActor(agent);
  return !!entry?.reviewerLane
    && isReviewRunLane(entry.reviewerLane)
    && isPromptRoleEligibleForReviewEvidence(entry.reviewerLane);
}

export function resolveReviewRunLane(agent?: string, lane?: string): ReviewRunLane {
  const resolvedAgent = (agent || '').trim();
  const resolvedLane = (lane || '').trim();
  const candidate = canonicalAgentRoleId(resolvedLane || resolvedAgent);
  if (!candidate) {
    throw new Error(`review_run_start: agent/lane must provide a registered REVIEW reviewer (supported: ${REVIEW_RUN_LANES.join(', ')})`);
  }
  if (resolvedAgent) {
    const entry = resolveRegisteredAgentActor(resolvedAgent);
    if (!entry?.reviewerLane || !isReviewRunLane(entry.reviewerLane)) {
      throw new Error(`review_run_start: agent "${resolvedAgent}" is not a registered REVIEW reviewer`);
    }
    if (!isPromptRoleEligibleForReviewEvidence(entry.reviewerLane)) {
      throw new Error(`review_run_start: agent "${resolvedAgent}" is retired or not eligible to create REVIEW evidence`);
    }
    if (resolvedLane && !agentRoleIdsEqual(resolvedLane, entry.reviewerLane)) {
      throw new Error(`review_run_start: agent "${resolvedAgent}" belongs to lane ${entry.reviewerLane}, not ${resolvedLane}`);
    }
  }
  if (!isReviewRunLane(candidate)) {
    throw new Error(`review_run_start: lane "${candidate}" is not in the supported REVIEW reviewer lane list (supported: ${REVIEW_RUN_LANES.join(', ')})`);
  }
  if (!isPromptRoleEligibleForReviewEvidence(candidate)) {
    throw new Error(`review_run_start: lane "${candidate}" is retired or not eligible to create REVIEW evidence`);
  }
  if (resolvedAgent && resolvedLane && !agentRoleIdsEqual(resolvedAgent, resolvedLane)) {
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

// B-9dcb CHK-002: metadataRoot — NOT projectRoot — drives the storyDir-aware
// metadata-path exclusion inside currentMaterialHash (isMaterialExcludedPath ->
// isStoryMetadataPath -> loadConfig). On a wrapper-root layout (metadataRoot !=
// gitRoot) with a CUSTOM storyDir, loading config from the gitRoot silently
// misses the custom storyDir and WRONGLY includes story-metadata paths in the
// EMPTY_MATERIAL_HASH diagnostic. Threading metadataRoot keeps the diagnostic
// consistent with the real captured snapshot. Defaults to projectRoot so plain
// repos and every existing positional caller stay byte-identical.
export function diagnoseReviewRunSnapshot(projectRoot: string, metadataRoot: string = projectRoot): ReviewRunSnapshotFailure | null {
  if (!isGitRepository(projectRoot)) {
    return {
      code: 'not_git_repo',
      reason: `signed workspace is not a git repository: ${projectRoot}`,
      nextAction: 'Run inside a git-backed Proof-or-Stop project/worktree, or initialize git and create an initial commit before starting a signed reviewer run.',
    };
  }
  if (!currentGitHead(projectRoot)) {
    return {
      code: 'missing_head',
      reason: `git HEAD cannot be resolved from signed workspace: ${projectRoot}`,
      nextAction: 'Create at least one commit in the signed workspace before starting a reviewer run.',
    };
  }
  const materialHash = currentMaterialHash(projectRoot, 'HEAD', metadataRoot);
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

// B-9dcb CHK-002: metadataRoot is the storyDir-aware config-load root threaded
// into the material/story hash computation (see currentMaterialHash /
// currentStoryFilesHash). On a wrapper-root layout (metadataRoot != gitRoot) with
// a CUSTOM storyDir the config lives at the metadataRoot, so passing the gitRoot
// as metadataRoot (the old behavior) wrongly INCLUDES custom-storyDir metadata in
// the material/story hashes and produces a false-stale evidence binding.
// metadataRoot defaults to projectRoot so plain repos and every existing
// positional caller stay byte-identical.
export function captureReviewRunSnapshot(projectRoot: string, context?: ReviewRunSnapshotContext, metadataRoot: string = projectRoot): { headHash: string; materialHash: string; storyFilesHash?: string } {
  const failure = diagnoseReviewRunSnapshot(projectRoot, metadataRoot);
  if (failure) {
    throw new Error(formatSnapshotFailure(failure, context));
  }
  const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', metadataRoot);
  return {
    headHash: currentGitHead(projectRoot)!,
    materialHash: currentMaterialHash(projectRoot, 'HEAD', metadataRoot)!,
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
  envelopeId?: string,
  reviewerEscalationReason?: string,
  reviewPurpose?: ReviewRun['reviewPurpose'],
  inventoryBinding?: ReviewInventoryPurposeBinding,
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
  if (envelopeId) parts.push(envelopeId);
  if (reviewerEscalationReason) parts.push(reviewerEscalationReason);
  if (reviewPurpose !== undefined || inventoryBinding !== undefined) {
    parts.push('critic-review-purpose.v1', JSON.stringify({ reviewPurpose, inventoryBinding }));
  }
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
  if (run.reviewPurpose !== undefined && run.reviewPurpose !== 'topology' && run.reviewPurpose !== 'inventory-completeness') return false;
  if ((run.reviewPurpose === 'inventory-completeness') !== (run.inventoryBinding !== undefined)) return false;
  if (run.reviewPurpose !== undefined && canonicalAgentRoleId(run.lane) !== 'proof-or-stop-review-topology-critic') return false;
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
    run.envelopeId,
    run.reviewerEscalationReason,
    run.reviewPurpose,
    run.inventoryBinding,
  );
  return run._hash === expected
    && (!run.workspaceBinding || verifyReviewRunWorkspaceBinding(run.workspaceBinding, run))
    && (
      run.assembledPrompt === undefined
      || (
        Boolean(run.envelopeId)
        && run.promptHash === domainSeparatedDigest('assembled-prompt.raw-utf8.v1', run.assembledPrompt)
      )
    );
}

export interface VerifiedReviewerDispatchBinding {
  reviewerResponsibility?: ReviewerDispatchResponsibility;
  dispatchPrompt: string;
  dispatchPromptDigest: string;
  hostRenderHost: PromptHost;
  hostRenderIdentityDigest: string;
  dispatchBindingDigest: string;
}

export function verifyCurrentReviewerDispatchBinding(args: {
  store: StoryStore;
  storyId: string;
  lane: string;
  reviewRound: string;
  projectRoot: string;
  rolloutMode?: 'legacy-full-context' | 'full-envelope';
  expectedDispatchBindingDigest?: string;
  reviewPurpose?: ReviewRun['reviewPurpose'];
  inventoryBinding?: ReviewInventoryPurposeBinding;
}): { ok: true; binding: VerifiedReviewerDispatchBinding } | { ok: false; reason: string } {
  const canonicalLane = canonicalAgentRoleId(args.lane);
  const event = [...args.store.readProcessEvents(args.storyId)].reverse().find(candidate =>
    candidate.type === 'dispatch'
    && candidate.targetKind === (args.reviewPurpose === 'inventory-completeness' ? 'inventory-critic-review' : canonicalLane === 'proof-or-stop-review-topology-critic' ? 'topology-critic-review' : 'story-review')
    && typeof candidate.agentType === 'string'
    && agentRoleIdsEqual(candidate.agentType, canonicalLane)
    && candidate.reviewRound === args.reviewRound
    && (args.expectedDispatchBindingDigest === undefined || candidate.dispatchBindingDigest === args.expectedDispatchBindingDigest));
  if (!event) {
    return { ok: false, reason: `no trusted story-review dispatch binding for ${args.lane} in the current REVIEW round` };
  }
  if (args.reviewPurpose === 'inventory-completeness' && (event.reviewPurpose !== args.reviewPurpose
    || !args.inventoryBinding || JSON.stringify(event.inventoryBinding) !== JSON.stringify(args.inventoryBinding)
    || !String(event.dispatchPrompt).includes(`Trusted inventory subject: ${JSON.stringify(args.inventoryBinding)}`))) {
    return { ok: false, reason: 'inventory dispatch purpose/subject binding is missing or tampered' };
  }
  const hostRenderHost = event.hostRenderHost;
  if (hostRenderHost !== 'claude' && hostRenderHost !== 'codex') {
    return { ok: false, reason: 'story-review dispatch is missing a supported host render identity' };
  }
  let hostIdentity;
  try {
    const rolloutMode = args.rolloutMode ?? resolvePromptEnvelopeRolloutMode(
      args.lane,
      loadConfig(args.projectRoot).promptEnvelope,
    );
    hostIdentity = reviewerHostRenderIdentity(args.projectRoot, args.lane, hostRenderHost, rolloutMode);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const dispatchPrompt = typeof event.dispatchPrompt === 'string' ? event.dispatchPrompt : '';
  const dispatchPromptDigest = typeof event.dispatchPromptDigest === 'string' ? event.dispatchPromptDigest : '';
  const hostRenderIdentityDigest = typeof event.hostRenderIdentityDigest === 'string'
    ? event.hostRenderIdentityDigest
    : '';
  const dispatchBindingDigest = typeof event.dispatchBindingDigest === 'string' ? event.dispatchBindingDigest : '';
  if (!dispatchPrompt || dispatchPromptDigest !== reviewerDispatchPromptDigest(dispatchPrompt)) {
    return { ok: false, reason: 'story-review dispatch prompt bytes/digest are missing or tampered' };
  }
  if (hostRenderIdentityDigest !== hostIdentity.identityDigest) {
    return { ok: false, reason: 'reviewer host render identity is stale or does not match current host assets' };
  }
  let reviewerResponsibility: ReviewerDispatchResponsibility | undefined;
  if (event.reviewerResponsibility !== undefined) {
    try { reviewerResponsibility = parseReviewerDispatchResponsibility(event.reviewerResponsibility); }
    catch { return { ok: false, reason: 'reviewer dispatch responsibility is malformed' }; }
  }
  const expectedBindingDigest = reviewerDispatchBindingDigest({
    ...(reviewerResponsibility ? { reviewerResponsibility } : {}),
    storyId: args.storyId,
    lane: args.lane,
    reviewRound: args.reviewRound,
    dispatchPromptDigest,
    hostRenderIdentityDigest,
  });
  if (dispatchBindingDigest !== expectedBindingDigest) {
    return { ok: false, reason: 'story-review dispatch binding digest is missing or tampered' };
  }
  return {
    ok: true,
    binding: {
      ...(reviewerResponsibility ? { reviewerResponsibility } : {}),
      dispatchPrompt,
      dispatchPromptDigest,
      hostRenderHost,
      hostRenderIdentityDigest,
      dispatchBindingDigest,
    },
  };
}

function verifyLegacyReviewRunPromptBinding(
  store: StoryStore,
  run: ReviewRun,
): { ok: boolean; reason?: string } {
  const metadataRoot = run.workspaceBinding?.metadataRoot
    || run.workspaceBinding?.signedWorkspaceRoot
    || process.cwd();
  const legacyConfig = {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [run.lane]: 'legacy-full-context' },
  };
  const modularConfig = {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [run.lane]: 'full-envelope' },
  };
  try {
    const contract = promptRoleContract(run.lane);
    const legacyBody = resolvePromptRoleBody(run.lane, legacyConfig);
    const modularBody = resolvePromptRoleBody(run.lane, modularConfig);
    if (run.promptHash !== hashReviewPrompt(legacyBody.body)) {
      return { ok: false, reason: 'legacy ReviewRun promptHash does not match the frozen legacy role body' };
    }
    if (contract.renderDigest !== domainSeparatedDigest('role-contract.render.v1', modularBody.body)) {
      return { ok: false, reason: 'legacy ReviewRun Role Contract render binding is stale or inconsistent' };
    }
    // Both supported host transforms must remain deterministic for the exact
    // frozen body. Legacy rollback is package-resolved, not a claim that the
    // physically modular full asset contains legacy bytes.
    reviewerHostRenderIdentity(metadataRoot, run.lane, 'claude', 'legacy-full-context');
    reviewerHostRenderIdentity(metadataRoot, run.lane, 'codex', 'legacy-full-context');

    const dispatch = verifyCurrentReviewerDispatchBinding({
      store,
      storyId: run.storyId,
      lane: run.lane,
      reviewRound: run.reviewRound,
      projectRoot: metadataRoot,
      rolloutMode: 'legacy-full-context',
      reviewPurpose: run.reviewPurpose,
      inventoryBinding: run.inventoryBinding,
    });
    // Pre-B-235e legacy runs did not persist dispatch bindings. Preserve only
    // that bounded history/binding-race case; once a binding exists, every
    // body/host/round digest is mandatory and drift is rejected.
    if (!dispatch.ok && (run.reviewPurpose === 'inventory-completeness' || !dispatch.reason.startsWith('no trusted story-review dispatch binding'))) {
      return dispatch;
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `legacy ReviewRun canonical binding cannot be reconstructed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Historical selection is content-bound, never a latest-dispatch or prompt-only lookup. */
export function verifyHistoricalReviewerDispatchBinding(args: {
  store: StoryStore; storyId: string; lane: string; reviewRound: string; projectRoot: string;
  envelope: PromptEnvelope; reviewedIntentRefs: readonly string[];
  reviewPurpose?: ReviewRun['reviewPurpose']; inventoryBinding?: ReviewInventoryPurposeBinding;
}): { ok: true; binding: VerifiedReviewerDispatchBinding } | { ok: false; reason: string } {
  let expected = args.envelope.reviewerDispatchBindingDigest;
  if (expected === undefined) {
    const matches = args.store.readProcessEvents(args.storyId).filter(event =>
      event.type === 'dispatch' && event.reviewRound === args.reviewRound
      && typeof event.agentType === 'string' && agentRoleIdsEqual(event.agentType, args.lane)
      && typeof event.dispatchBindingDigest === 'string'
      && domainSeparatedDigest('prompt-launcher-spec.v1', {
        reviewedIntentRefs: args.reviewedIntentRefs,
        dispatchBindingDigest: event.dispatchBindingDigest,
        hostRenderHost: event.hostRenderHost,
      }) === args.envelope.launcherSpecDigest);
    const identities = [...new Set(matches.map(event => event.dispatchBindingDigest as string))];
    if (identities.length !== 1) {
      return { ok: false, reason: 'historical dispatch launcher identity is missing or cannot be reconstructed exactly' };
    }
    expected = identities[0];
  }
  return verifyCurrentReviewerDispatchBinding({
    store: args.store, storyId: args.storyId, lane: args.lane, reviewRound: args.reviewRound,
    projectRoot: args.projectRoot, expectedDispatchBindingDigest: expected,
    reviewPurpose: args.reviewPurpose, inventoryBinding: args.inventoryBinding,
  });
}

export function verifyReviewRunPromptEnvelope(
  store: StoryStore,
  run: ReviewRun,
  promptEnvelopes?: readonly PromptEnvelope[],
): { ok: boolean; reason?: string } {
  if (!run.envelopeId) return verifyLegacyReviewRunPromptBinding(store, run);
  const envelopes = promptEnvelopes ?? store.readPromptEnvelopes(run.storyId).envelopes;
  const matching = envelopes.filter(
    envelope => envelope.envelopeId === run.envelopeId,
  );
  if (matching.length !== 1) {
    return { ok: false, reason: `expected one persisted envelope ${run.envelopeId}, found ${matching.length}` };
  }
  const envelope = matching[0];
  if (!verifyPromptEnvelopeIntegrity(envelope)) return { ok: false, reason: 'Prompt Envelope integrity verification failed' };
  if (!agentRoleIdsEqual(envelope.roleId, run.lane)) {
    return { ok: false, reason: 'Prompt Envelope roleId does not match the signed ReviewRun lane' };
  }
  if (!run.assembledPrompt) {
    return { ok: false, reason: 'signed ReviewRun is missing the exact assembled prompt bytes' };
  }
  if (run.promptHash !== envelope.assembledPromptDigest) {
    return { ok: false, reason: 'signed ReviewRun promptHash does not match Prompt Envelope assembledPromptDigest' };
  }
  const canonicalLane = canonicalAgentRoleId(run.lane);
  const promptEntry = readPromptRegistry().agents.find(entry => entry.agentId === canonicalLane);
  if (!promptEntry) return { ok: false, reason: `no canonical prompt registry entry for ReviewRun lane ${canonicalLane}` };
  const metadataRoot = run.workspaceBinding?.metadataRoot
    || run.workspaceBinding?.signedWorkspaceRoot
    || process.cwd();
  let roleContract;
  let resolvedRoleBody;
  try {
    roleContract = promptRoleContractForSemanticDigest(canonicalLane, envelope.roleSemanticDigest);
    resolvedRoleBody = resolvePromptRoleBody(
      canonicalLane,
      loadConfig(metadataRoot).promptEnvelope,
    );
  } catch {
    return { ok: false, reason: `no canonical Role Contract for ReviewRun lane ${canonicalLane}` };
  }
  if (resolvedRoleBody.mode !== 'full-envelope') {
    return { ok: false, reason: `Prompt Envelope cannot be consumed while ${canonicalLane} is ${resolvedRoleBody.mode}` };
  }
  const dispatchBinding = verifyHistoricalReviewerDispatchBinding({
    store,
    storyId: run.storyId,
    lane: run.lane,
    reviewRound: run.reviewRound,
    projectRoot: metadataRoot,
    envelope,
    reviewedIntentRefs: run.scopeBinding?.reviewedIntentRefs ?? [],
    reviewPurpose: run.reviewPurpose,
    inventoryBinding: run.inventoryBinding,
  });
  if (!dispatchBinding.ok) return dispatchBinding;
  const assemblyValid = envelope.contextMode === 'incremental'
    ? verifyIncrementalPromptAssemblyIntegrity({
      prompt: run.assembledPrompt,
      envelope,
      runtimeContract: BASELINE_RUNTIME_CONTRACT,
      roleContract,
      eligibilityRoleSemanticDigest: envelope.eligibilityRoleSemanticDigest,
      rolePrompt: resolvedRoleBody.body,
      reviewerDispatchBindingDigest: envelope.reviewerDispatchBindingDigest === undefined ? undefined : dispatchBinding.binding.dispatchBindingDigest,
      dispatchPrompt: dispatchBinding.binding.dispatchPrompt,
      hostRenderIdentityDigest: dispatchBinding.binding.hostRenderIdentityDigest,
    })
    : verifyFullPromptAssemblyIntegrity({
      prompt: run.assembledPrompt,
      envelope,
      runtimeContract: BASELINE_RUNTIME_CONTRACT,
      roleContract,
      eligibilityRoleSemanticDigest: envelope.eligibilityRoleSemanticDigest,
      rolePrompt: resolvedRoleBody.body,
      reviewerDispatchBindingDigest: envelope.reviewerDispatchBindingDigest === undefined ? undefined : dispatchBinding.binding.dispatchBindingDigest,
      dispatchPrompt: dispatchBinding.binding.dispatchPrompt,
      hostRenderIdentityDigest: dispatchBinding.binding.hostRenderIdentityDigest,
    });
  if (!assemblyValid) {
    return { ok: false, reason: 'Prompt Envelope does not match the canonical runtime/role/task assembly bytes' };
  }
  if (envelope.impactPolicyVersion) {
    let incremental;
    try {
      incremental = reviewIncrementalContext(
        store,
        run.workspaceBinding?.signedWorkspaceRoot || run.workspaceBinding?.metadataRoot || process.cwd(),
        run.storyId,
        run.lane,
        {
          roleSemanticDigest: envelope.eligibilityRoleSemanticDigest ?? promptRoleContract(run.lane).semanticDigest,
          excludedReviewRunId: run.reviewRunId,
          findingsCutoffAt: run.startedAt,
          // Recompute the baseline as-of this signed run. Later metadata-only
          // reviewer passes must not rewrite the priorPassRef of an older run;
          // doing so made every valid pass stale at DONE after review_pass_set
          // appended its own metadata commit. Pin git probes to run.headHash so
          // a later metadata-only import commit cannot rewrite eligibilityDigest
          // / reviewBasisDigest either; related material drift remains visible
          // to a current-HEAD probe.
          passesCutoffAt: run.startedAt,
          asOfRef: run.headHash,
          findingProjection: envelope.findingProjection,
          promptEnvelopes: envelopes,
        },
      );
    } catch (error) {
      return {
        ok: false,
        reason: `incremental eligibility could not be recomputed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    // A reviewer-requested full run delivers the signed full Task Context, not
    // the incremental Review Basis that was computed only as a discarded
    // candidate. Later reviewer-lane metadata may legitimately change that
    // candidate (for example, another lane resolves a nonblocking finding)
    // without changing any product, requirement, scope, or prompt bytes the
    // reviewer actually inspected. Keep the candidate fields integrity-bound
    // inside the immutable envelope, but do not dynamically reinterpret them as
    // current gate facts for this one full-context selection. All material and
    // semantic facts below remain authoritatively recomputed and fail closed.
    const reviewerRequestedFull = envelope.contextMode === 'full'
      && envelope.selectionReason === 'REVIEWER_REQUESTED_FULL';
    const eligibilityMismatches = [
      ['impactPolicyVersion', envelope.impactPolicyVersion, incremental.impactPolicyVersion],
      ...(!reviewerRequestedFull ? [
        ['eligibilityDigest', envelope.eligibilityDigest, incremental.eligibilityDigest],
        ['eligibilityReasonCodes', JSON.stringify(envelope.eligibilityReasonCodes), JSON.stringify(incremental.eligibilityReasonCodes)],
      ] : []),
      ['freshnessClassification', envelope.freshnessClassification, incremental.freshnessClassification],
      ['priorPassRef', envelope.priorPassRef, incremental.priorPassRef ?? undefined],
      ['changedFilesDigest', envelope.changedFilesDigest, incremental.changedFilesDigest],
      ['impactedFilesDigest', envelope.impactedFilesDigest, incremental.impactedFilesDigest],
      ...(!reviewerRequestedFull ? [
        ['reviewBasisDigest', envelope.reviewBasisDigest, incremental.reviewBasisDigest ?? undefined],
      ] : []),
      ['taskSemanticDigest', envelope.taskSemanticDigest, incremental.taskSemanticDigest ?? undefined],
    ].filter(([, actual, expected]) => actual !== expected);
    if (eligibilityMismatches.length > 0) {
      return {
        ok: false,
        reason: `Prompt Envelope incremental eligibility fields do not match authoritative recomputation: ${eligibilityMismatches.map(([key]) => key).join(', ')}`,
      };
    }
    const safetyRequiresFull = incremental.contextMode === 'full';
    if (envelope.contextMode === 'incremental' && safetyRequiresFull) {
      return { ok: false, reason: 'incremental context was served while authoritative eligibility required full' };
    }
    if (envelope.contextMode === 'incremental' && envelope.selectionReason !== 'SAFE_INCREMENTAL') {
      return { ok: false, reason: 'incremental context is missing SAFE_INCREMENTAL selection' };
    }
    if (envelope.contextMode === 'full' && envelope.selectionReason === 'SAFETY_REQUIRES_FULL' && !safetyRequiresFull) {
      return { ok: false, reason: 'full safety selection contradicts authoritative incremental eligibility' };
    }
    if (envelope.selectionReason === 'REVIEWER_REQUESTED_FULL'
      && (
        !run.reviewerEscalationReason
        || envelope.escalationReason !== run.reviewerEscalationReason
      )) {
      return { ok: false, reason: 'reviewer escalation reason is missing or does not match the signed ReviewRun' };
    }
    if (envelope.selectionReason === 'FULL_CHEAPER_OR_EQUAL'
      && (envelope.incrementalContextBytes === undefined || envelope.fullContextBytes === undefined
        || envelope.incrementalContextBytes < envelope.fullContextBytes)) {
      return { ok: false, reason: 'FULL_CHEAPER_OR_EQUAL size relation is invalid' };
    }
  }
  const fieldsMatch = envelope.dispatchKind === 'review-run'
    && envelope.storyId === run.storyId
    && envelope.reviewRunId === run.reviewRunId
    && envelope.reviewRound === run.reviewRound
    && agentRoleIdsEqual(envelope.lane, run.lane)
    && envelope.headHash === run.headHash
    && envelope.materialHash === run.materialHash
    && envelope.storyFilesHash === run.storyFilesHash;
  return fieldsMatch
    ? { ok: true }
    : { ok: false, reason: 'Prompt Envelope fields do not match the signed ReviewRun' };
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
    .filter(run => verifyReviewRun(run) && agentRoleIdsEqual(run.lane, lane) && run.reviewRound === reviewRound)
    .sort(compareRunRecency);
  return current.length > 0 ? current[current.length - 1] : null;
}

function startRunHint(storyId: string, lane: string): string {
  return `→ Current REVIEW round has no available reviewer run: run proof-or-stop review_run_start '{"storyId":"${storyId}","agent":"${lane}"}', then resubmit finding_add/review_pass_set with the returned reviewRunId`;
}

function latestRunHint(storyId: string, lane: string, latestRunId?: string): string {
  const latest = latestRunId ? `(current latest: ${latestRunId})` : '';
  return `→ Current lane already has a newer reviewer run${latest}: use the latest reviewRunId to resubmit finding_add; do not reuse the old reviewRunId`;
}

function roundMismatchHint(storyId: string, lane: string): string {
  return `→ This reviewRunId does not belong to the current REVIEW round: run proof-or-stop review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' to obtain the reviewRunId for the current round, then resubmit finding_add/review_pass_set`;
}

function staleMaterialHint(storyId: string, lane: string): string {
  return `→ The reviewRunId's HEAD/materialHash is stale and cannot be fixed by repeatedly running review_run_start within the same REVIEW round; run proof-or-stop review_inventory_begin --storyId=${storyId}, finish required lanes + topology critic findingDispositions + finalize, consume that receipt to enter DEV and commit the repair, then advance to REVIEW and run proof-or-stop review_run_start '{"storyId":"${storyId}","agent":"${lane}"}'`;

}

// ── B-6bfd CHK-005: review scope binding (scope-protected stories only) ──

function scopeBindingHint(storyId: string, lane: string): string {
  return `→ scope-protected story: reviewer evidence must be bound to the current scope contract and diff. Re-run proof-or-stop review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' to capture the latest scopeContractHash/diffPackHash, then use the new reviewRunId to resubmit finding_add/review_pass_set`;
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
  const trusted = readTrustedProofStoryScopeArtifacts(store, storyId);
  return buildCurrentScopeContext(
    contract,
    diffPack,
    projectRoot,
    trusted.ledger,
    trusted.slicePlan,
  );
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
  return `→ Re-run proof-or-stop review_run_start '{"storyId":"${storyId}","agent":"${lane}"}' from the resolved signed workspace, then resubmit finding_add/review_pass_set with the new reviewRunId`;
}

function uncommittedPathsUnder(gitCwd: string, prefix: string): string[] {
  const commands = [
    ['diff', '--name-only', '--', prefix],
    ['diff', '--cached', '--name-only', '--', prefix],
    ['ls-files', '--others', '--exclude-standard', '--', prefix],
  ];
  const paths = new Set<string>();
  for (const args of commands) {
    const output = execFileSync('git', args, {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const path of output.split('\n').map((line) => line.trim()).filter(Boolean)) paths.add(path);
  }
  return [...paths];
}

export function evaluatePersistedReviewToTestIndexTransition(
  gitCwd: string,
  indexGitPath: string,
  run: ReviewRun,
  currentStory: StoryInfo,
): { ok: boolean; reason?: string } {
  let reviewedStory: StoryInfo;
  try {
    reviewedStory = JSON.parse(execFileSync('git', ['show', `${run.headHash}:${indexGitPath}`], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })) as StoryInfo;
  } catch {
    return { ok: false, reason: 'signed REVIEW index snapshot is unreadable' };
  }
  if (reviewedStory.storyId !== run.storyId || currentStory.storyId !== run.storyId) {
    return { ok: false, reason: 'index storyId does not match the signed review run' };
  }
  if (reviewedStory.phase !== 'REVIEW' || currentStory.phase !== 'TEST') {
    return { ok: false, reason: `phase delta is ${reviewedStory.phase}->${currentStory.phase}, not REVIEW->TEST` };
  }
  if (!run.reviewRound || reviewedStory.currentReviewRound !== run.reviewRound || currentStory.currentReviewRound !== run.reviewRound) {
    return { ok: false, reason: 'currentReviewRound changed or does not match the signed review run' };
  }
  const reviewedEvents = reviewedStory.events ?? [];
  const currentEvents = currentStory.events ?? [];
  if (currentEvents.length !== reviewedEvents.length + 1 || canonicalJson(currentEvents.slice(0, -1)) !== canonicalJson(reviewedEvents)) {
    return { ok: false, reason: 'events are not the reviewed prefix plus exactly one transition event' };
  }
  const event = currentEvents.at(-1)!;
  const allowedEventKeys = new Set(['phase', 'action', 'timestamp', 'branch', 'user', 'sessionId', 'agent']);
  if (Object.keys(event).some((key) => !allowedEventKeys.has(key))) {
    return { ok: false, reason: 'transition event contains fields not emitted by collectContext' };
  }
  if (event.phase !== 'TEST' || event.action !== 'advance') {
    return { ok: false, reason: 'transition event is not exactly TEST/advance' };
  }
  // Local event identity/timing strings are cooperative runtime audit context,
  // not writer authentication, and git user.name is legitimately absent in
  // env-only commit setups. They therefore cannot affect retention. Only
  // reject malformed types when a field exists;
  // the gate authority comes from the already-verified signed review
  // run/pass/round plus the exact stable index delta above/below.
  for (const key of ['timestamp', 'branch', 'user', 'sessionId', 'agent'] as const) {
    if (event[key] !== undefined && typeof event[key] !== 'string') {
      return { ok: false, reason: `transition event audit field ${key} is not a string` };
    }
  }
  const { phase: _reviewedPhase, events: _reviewedEvents, ...reviewedStable } = reviewedStory;
  const { phase: _currentPhase, events: _currentEvents, ...currentStable } = currentStory;
  if (canonicalJson(reviewedStable) !== canonicalJson(currentStable)) {
    return { ok: false, reason: 'index fields outside the canonical phase/event delta changed' };
  }
  return { ok: true };
}

export function evaluateReviewRunMetadataRetention(
  store: StoryStore,
  story: StoryInfo,
  run: ReviewRun,
  projectRoot: string,
  scopeContext: CurrentScopeContext | null,
): { ok: boolean; reasons: string[] } {
  if (!run.scopeBinding?.compositeScopeDigest && !scopeContext?.compositeScopeDigest) {
    return { ok: true, reasons: [] };
  }
  const metadataRoot = run.workspaceBinding?.metadataRoot ?? projectRoot;
  const evaluationHead = currentGitHead(projectRoot);
  const materialUnchanged = currentMaterialHash(projectRoot, 'HEAD', metadataRoot) === run.materialHash;
  const storedStoryFilesHash = run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash;
  const storyFilesUnchanged = Boolean(storedStoryFilesHash)
    && currentStoryFilesHash(projectRoot, 'HEAD', metadataRoot) === storedStoryFilesHash;
  let changedFiles: string[];
  let storyPrefix: string;
  try {
    const gitRoot = realpathSync(resolve(projectRoot));
    const storyDir = realpathSync(resolve(store.storyDirPath(story.storyId)));
    const storyRel = relative(gitRoot, storyDir).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!storyRel || storyRel === '.' || isAbsolute(storyRel) || storyRel === '..' || storyRel.startsWith('../')) {
      throw new Error(`story directory is outside signed git root: ${storyDir}`);
    }
    storyPrefix = `${storyRel}/`;
    changedFiles = [
      ...changedFilesBetween(projectRoot, run.headHash, 'HEAD'),
      ...uncommittedPathsUnder(projectRoot, storyPrefix),
    ];
  } catch {
    return { ok: false, reasons: ['unable to derive metadata changes since the signed review run'] };
  }
  const metadataPaths = [...new Set(changedFiles
    .filter((path) => path.startsWith(storyPrefix))
    .map((path) => path.slice(storyPrefix.length))
    .filter((path) => !REVIEW_RETENTION_PROTOCOL_METADATA_PATHS.has(path)))];
  const indexTransition = metadataPaths.includes('index.json')
    ? evaluatePersistedReviewToTestIndexTransition(projectRoot, `${storyPrefix}index.json`, run, story)
    : null;
  const effectiveMetadataPaths = metadataPaths.filter(
    (path) => path !== 'index.json' || !indexTransition?.ok,
  );
  const changedArtifacts = effectiveMetadataPaths.map((artifactPath) => {
    const classification = classifyCurrentCloseoutArtifactForReviewRetention(
      store,
      story.storyId,
      artifactPath,
      projectRoot,
      metadataRoot,
    );
    return {
      path: artifactPath,
      writer: classification.writer,
      valid: classification.retainsReview,
    };
  });
  const finalHead = currentGitHead(projectRoot);
  return evaluateMetadataOnlyReviewRetention({
    materialUnchanged,
    storyFilesUnchanged,
    stableEvaluationHead: Boolean(evaluationHead) && evaluationHead === finalHead,
    storedCompositeScopeDigest: run.scopeBinding?.compositeScopeDigest,
    currentCompositeScopeDigest: scopeContext?.compositeScopeDigest,
    changedArtifacts,
    storedReviewRound: run.reviewRound,
    currentReviewRound: story.currentReviewRound ?? '',
  });
}

export function assertCurrentReviewRunForEvidence(
  store: StoryStore,
  story: StoryInfo,
  projectRoot: string,
  agent: string,
  reviewRunId: string | undefined,
): ReviewRun {
  if (story.phase !== 'REVIEW') {
    throw new Error(`REVIEW_EVIDENCE_PHASE_REQUIRED: story ${story.storyId} is ${story.phase}; reviewer evidence is writable only in REVIEW`);
  }
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
  if (run.reviewPurpose === 'inventory-completeness') {
    const epoch = currentOpenReviewInventory(store, story.storyId);
    if (!epoch || !inventoryPurposeMatchesEpoch(run.inventoryBinding, epoch)) {
      throw new Error('review evidence inventory purpose requires the same current OPEN epoch/wave/cutoff');
    }
  }
  const envelopeMode = resolvePromptEnvelopeRolloutMode(
    run.lane,
    loadConfig(run.workspaceBinding?.metadataRoot ?? projectRoot).promptEnvelope,
  );
  if (envelopeMode === 'full-envelope' && !run.envelopeId) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} is missing the required Prompt Envelope`);
  }
  const envelopeVerification = verifyReviewRunPromptEnvelope(store, run);
  if (!envelopeVerification.ok) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} has invalid Prompt Envelope: ${envelopeVerification.reason}`);
  }
  if (!agentRoleIdsEqual(run.lane, agent)) {
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
  // B-9dcb CHK-003: the freshness recompute's metadataRoot (4th arg) must be the
  // run's authoritative signed metadataRoot, NOT the signedProjectRoot (gitRoot).
  // On a wrapper-root layout with a CUSTOM storyDir, using the gitRoot as
  // metadataRoot wrongly INCLUDES custom-storyDir metadata in the recomputed
  // material/story hashes → false-stale. Legacy runs without workspaceBinding
  // fall back to projectRoot (unchanged behavior). gitCwd (arg1) stays
  // signedProjectRoot.
  const freshness = checkEvidenceFreshnessForGit(
    signedProjectRoot,
    run.headHash,
    run.materialHash,
    run.workspaceBinding?.metadataRoot ?? projectRoot,
    run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash,
  );
  if (!freshness.fresh) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} is stale: ${freshness.reason}. ${staleMaterialHint(story.storyId, agent)}`);
  }
  const liveMaterialHash = currentMaterialHash(signedProjectRoot, 'HEAD', run.workspaceBinding?.metadataRoot ?? projectRoot);
  if (!liveMaterialHash) throw new Error(`review inventory freshness: cannot compute current material hash for ${story.storyId}`);
  assertReviewInventoryCutoff(store, story.storyId, {
    materialHash: liveMaterialHash,
    storyFilesHash: currentStoryFilesHash(signedProjectRoot, 'HEAD', run.workspaceBinding?.metadataRoot ?? projectRoot) ?? undefined,
  });
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
  const retention = evaluateReviewRunMetadataRetention(store, story, run, signedProjectRoot, scopeContext);
  if (!retention.ok) {
    throw new Error(`review evidence for ${agent} bound reviewRunId ${reviewRunId} failed closeout metadata retention: ${retention.reasons.join('; ')}. ${staleMaterialHint(story.storyId, agent)}`);
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
  promptEnvelopes: readonly PromptEnvelope[],
  advisories?: ReviewRunIssue[],
  verifyPromptEnvelope: typeof verifyReviewRunPromptEnvelope = verifyReviewRunPromptEnvelope,
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
  let envelopeMode: ReturnType<typeof resolvePromptEnvelopeRolloutMode>;
  try {
    envelopeMode = resolvePromptEnvelopeRolloutMode(
      run.lane,
      loadConfig(run.workspaceBinding?.metadataRoot ?? projectRoot).promptEnvelope,
    );
  } catch (error) {
    return {
      code: 'prompt_envelope_tampered',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} cannot resolve Prompt Envelope rollout policy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (envelopeMode === 'full-envelope' && !run.envelopeId) {
    return {
      code: 'missing_prompt_envelope',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} is bound to a legacy run while ${run.lane} requires full-envelope`,
    };
  }
  const envelopeVerification = verifyPromptEnvelope(store, run, promptEnvelopes);
  if (!envelopeVerification.ok) {
    return {
      code: 'prompt_envelope_tampered',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} Prompt Envelope is invalid: ${envelopeVerification.reason}`,
    };
  }
  if (evidence.kind === 'pass' && evidence.envelopeId !== run.envelopeId) {
    return {
      code: 'prompt_envelope_mismatch',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} envelopeId does not equal its signed ReviewRun binding`,
    };
  }
  if (!agentRoleIdsEqual(run.lane, evidence.agent)) {
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
  const managedBinding = evidence.pass?.managedEvidenceBinding ?? evidence.finding?.managedEvidenceBinding;
  const nativeBinding = evidence.pass?.nativeEvidenceBinding ?? evidence.finding?.nativeEvidenceBinding;
  // B-9dcb CHK-003: the freshness recompute's metadataRoot (4th arg) must be the
  // run's authoritative signed metadataRoot, NOT the signedProjectRoot (gitRoot).
  // On a wrapper-root layout with a CUSTOM storyDir, using the gitRoot as
  // metadataRoot wrongly INCLUDES custom-storyDir metadata in the recomputed
  // material/story hashes → false-stale. Legacy runs without workspaceBinding
  // fall back to projectRoot (unchanged behavior). gitCwd (arg1) stays
  // signedProjectRoot.
  if (managedBinding) {
    const live = verifyManagedReviewLiveBinding({
      gitCwd: signedProjectRoot,
      metadataRoot: run.workspaceBinding?.metadataRoot ?? projectRoot,
      storyId: story.storyId,
      expected: {
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash ?? '',
      },
    });
    if (!live.valid) {
      return {
        code: 'managed_receipt_invalid',
        kind: evidence.kind,
        evidenceId: evidence.id,
        agent: evidence.agent,
        reviewRunId: evidence.reviewRunId,
        message: `${evidence.kind} ${evidence.id} failed shared managed-review live binding: ${live.reason}`,
      };
    }
  } else {
    const freshness = checkEvidenceFreshnessForGit(
      signedProjectRoot,
      run.headHash,
      run.materialHash,
      run.workspaceBinding?.metadataRoot ?? projectRoot,
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
  const retention = evaluateReviewRunMetadataRetention(store, story, run, signedProjectRoot, effectiveScopeContext);
  if (!retention.ok) {
    return {
      code: 'stale_run_hash',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} failed closeout metadata retention: ${retention.reasons.join('; ')}. ${staleMaterialHint(story.storyId, evidence.agent)}`,
    };
  }
  if (!managedBinding && !nativeBinding) {
    return {
      code: 'review_execution_authority_missing',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} has neither a managed receipt nor a registered-broker native invocation attestation`,
    };
  }
  if (managedBinding && nativeBinding) {
    return {
      code: 'review_execution_authority_missing',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} has conflicting managed and native execution authority bindings`,
    };
  }
  const authority = classifyReviewerExecutionAuthority({
    executionMode: managedBinding ? 'cross-provider-cli' : 'native-host',
    assuranceLevel: 'ordinary-review',
    hasManagedEvidenceBinding: managedBinding !== undefined,
  });
  if (authority.reviewGatePath === 'managed-receipt' && managedBinding) {
    const managed = verifyManagedReviewEvidence({
      root: projectRoot,
      storyId: story.storyId,
      agent: evidence.agent,
      lane: run.lane,
      reviewRunId: run.reviewRunId,
      binding: managedBinding,
      expected: {
        providerHost: managedBinding.providerHost,
        headHash: run.headHash,
        materialHash: run.materialHash,
        storyFilesHash: run.storyFilesHash ?? run.workspaceBinding?.storyFilesHash ?? '',
        promptHash: run.promptHash,
        envelopeId: run.envelopeId ?? null,
        managedPromptDigest: managedReviewerPromptDigest(run.workspaceBinding?.metadataRoot ?? projectRoot, run),
      },
      ...(evidence.kind === 'pass' && evidence.pass
        ? { evidence: { kind: 'pass' as const, pass: evidence.pass } }
        : evidence.kind === 'finding' && evidence.finding
          ? { evidence: { kind: 'finding' as const, finding: evidence.finding } }
          : {}),
    });
    if (!managed.valid) {
      return {
        code: 'managed_receipt_invalid',
        kind: evidence.kind,
        evidenceId: evidence.id,
        agent: evidence.agent,
        reviewRunId: evidence.reviewRunId,
        message: `${evidence.kind} ${evidence.id} failed shared managed-review Proof Admissibility: ${managed.reason}`,
      };
    }
  }
  if (authority.reviewGatePath === 'direct-signed-review' && nativeBinding) {
    const dispatch = verifyCurrentReviewerDispatchBinding({
      store,
      storyId: story.storyId,
      lane: run.lane,
      reviewRound: run.reviewRound,
      projectRoot: run.workspaceBinding?.metadataRoot ?? projectRoot,
    });
    const writerSessionId = evidence.pass?.writerSessionId ?? nativeBinding.writerSessionId;
    const sessionSource = evidence.pass?.sessionSource ?? nativeBinding.sessionSource;
    if (!dispatch.ok || !verifyNativeReviewEvidenceBinding({
      binding: nativeBinding,
      projectRoot: run.workspaceBinding?.metadataRoot ?? projectRoot,
      storyId: story.storyId,
      agent: run.agent,
      lane: run.lane,
      reviewRunId: run.reviewRunId,
      dispatch: dispatch.ok ? dispatch.binding : {
        hostRenderHost: nativeBinding.host,
        dispatchPromptDigest: '',
        hostRenderIdentityDigest: '',
        dispatchBindingDigest: '',
      },
      writerSessionId,
      sessionSource,
    })) {
      return {
        code: 'review_execution_authority_missing',
        kind: evidence.kind,
        evidenceId: evidence.id,
        agent: evidence.agent,
        reviewRunId: evidence.reviewRunId,
        message: `${evidence.kind} ${evidence.id} native invocation attestation is missing, stale, replayed, or does not match its signed dispatch`,
      };
    }
  }
  return null;
}

export function collectReviewerEvidenceState(
  store: StoryStore,
  storyId: string,
  projectRoot: string,
  options: ReviewerEvidenceCollectionOptions = {},
): ReviewerEvidenceState {
  const story = store.readStory(storyId);
  const currentRound = story.currentReviewRound;
  const runs = store.readReviewRuns(storyId).runs;
  const findings = store.readFindings(storyId).findings || [];
  const passes = store.readReviewPasses(storyId).passes || [];

  // Only true reviewer lanes (proof-or-stop-review-*) require reviewRunId
  // binding. Historical lattice-review-* values are legacy compatibility input
  // and are canonicalized before this check. main / main-agent /
  // lattice-implementer is a historical/legacy compatibility alias; the
  // canonical implementer is proof-or-stop-implementer. Other non-reviewer
  // actors create findings during DEV
  // or capture meta-process notes that must not be treated as reviewer evidence
  // by the REVIEW→TEST gate.
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
      envelopeId: pass.envelopeId,
      signatureValid: verifyReviewPass(storyId, pass),
      pass,
    }));

  // B-6bfd CHK-005: compute the live scope context ONCE per call (null for
  // unprotected/legacy stories → no scope-binding enforcement, fully backward
  // compatible).
  const scopeContext = currentScopeContextForStory(store, storyId, projectRoot);
  const reviewerEvidence = [...reviewerFindings, ...reviewerPasses];
  const promptEnvelopes = reviewerEvidence.length > 0
    ? snapshotPromptEnvelopes(store.readPromptEnvelopes(storyId).envelopes)
    : [];
  const verifyPromptEnvelope = options.verifyPromptEnvelope ?? verifyReviewRunPromptEnvelope;

  const valid: ReviewerEvidenceRecord[] = [];
  const rawInvalid: ReviewRunIssue[] = [];
  const advisories: ReviewRunIssue[] = [];
  const nativeInvocationNonceCounts = new Map<string, number>();
  for (const evidence of [...reviewerFindings, ...reviewerPasses]) {
    const binding = evidence.kind === 'pass'
      ? evidence.pass.nativeEvidenceBinding
      : evidence.finding.nativeEvidenceBinding;
    if (!binding) continue;
    nativeInvocationNonceCounts.set(
      binding.invocationNonce,
      (nativeInvocationNonceCounts.get(binding.invocationNonce) ?? 0) + 1,
    );
  }

  for (const evidence of reviewerEvidence) {
    // B-137a: broker attestations are one-shot. A reused invocation nonce is a
    // replay, so refuse it BEFORE the ordinary run-binding validation (which
    // would otherwise accept the duplicate as a well-formed binding).
    const nativeBinding = evidence.kind === 'pass'
      ? evidence.pass.nativeEvidenceBinding
      : evidence.finding.nativeEvidenceBinding;
    const duplicateNativeInvocation = nativeBinding
      && (nativeInvocationNonceCounts.get(nativeBinding.invocationNonce) ?? 0) > 1;
    const issue = duplicateNativeInvocation
      ? {
        code: 'review_execution_authority_missing' as const,
        kind: evidence.kind,
        evidenceId: evidence.id,
        agent: evidence.agent,
        reviewRunId: evidence.reviewRunId,
        message: `${evidence.kind} ${evidence.id} reuses native invocation nonce ${nativeBinding.invocationNonce}; broker attestations are one-shot`,
      }
      : validateEvidenceRunBinding(
        store,
        story,
        projectRoot,
        runs,
        evidence,
        scopeContext,
        promptEnvelopes,
        advisories,
        verifyPromptEnvelope,
      );
    if (issue) {
      rawInvalid.push(issue);
    } else {
      valid.push(evidence);
    }
  }

  const evidenceCreatedAt = (evidence: ReviewerEvidenceRecord): number => {
    const value = evidence.pass?.createdAt ?? evidence.finding?.createdAt;
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const evidenceById = new Map(
    [...reviewerFindings, ...reviewerPasses].map(evidence => [evidence.id, evidence]),
  );
  const terminalReviewerFindingIds = new Set(
    reviewerFindings
      .filter((evidence) => isTerminalReviewerFindingStatus(evidence.finding?.status))
      .map((evidence) => evidence.id),
  );
  const invalid = rawInvalid.filter((issue) => {
    if (!SUPERSEDED_PASS_ISSUE_CODES.has(issue.code)) return true;
    // B-cdf6 / B-META F-019: a TERMINAL (resolved/dismissed) reviewer finding is
    // forgiven for a binding-freshness-class issue WITHOUT requiring its lane to
    // also hold currently-valid evidence.
    //
    // Why the old `&& agentsWithCurrentValidEvidence.has(...)` conjunct was a
    // deadlock, not a safeguard: every remedy for staleness (finding_resolve,
    // review_pass_set, verification_evidence_refresh_stale, ...) writes its own
    // `proof-or-stop: record ... metadata` commit, which advances HEAD and re-stales
    // the bindings that very command just established. Once a whole lane goes
    // stale in one sweep, its passes never enter `valid`, so the lane held no
    // currently-valid evidence, so the forgiveness for its already RESOLVED
    // findings never fired — the same staleness that needs forgiving is what
    // withheld the precondition for forgiving it. Measured on B-cdf6: 19 review
    // runs produced 7 passes and still could not converge.
    //
    // Why dropping the conjunct does not weaken the gate: this branch is reached
    // only for SUPERSEDED_PASS_ISSUE_CODES (binding freshness/supersession), and
    // only for a finding whose recorded defect is already terminal. A resolved
    // finding asserts nothing about current material — its envelope's job is
    // done — so a stale binding on it cannot mislead. Everything that CAN
    // mislead is untouched below: an OPEN finding and ANY pass still fall
    // through to the newer-valid-evidence rule, and non-freshness codes
    // (invalid_run_signature / unknown_run / wrong_lane / wrong_round /
    // workspace_binding_tampered / ...) already returned true above and remain
    // fail-closed for terminal findings too.
    if (
      issue.kind === 'finding'
      && terminalReviewerFindingIds.has(issue.evidenceId)
    ) return false;
    const invalidEvidence = evidenceById.get(issue.evidenceId);
    const hasNewerValidEvidence = Boolean(invalidEvidence) && valid.some(evidence =>
      agentRoleIdsEqual(evidence.agent, issue.agent)
      && evidenceCreatedAt(evidence) > evidenceCreatedAt(invalidEvidence!));
    if (!hasNewerValidEvidence) return true;
    if (issue.kind === 'pass') return false;
    return true;
  });

  return { valid, invalid, ...(advisories.length > 0 ? { advisories } : {}) };
}
