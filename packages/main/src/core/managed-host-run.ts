import { MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY } from './runtime-fact-registry.js';
import { isManagedInventoryCriticEnvelopeValid, type ManagedInventoryCritic } from './managed-inventory-critic.js';
import { MANAGED_RUN_DASHBOARD_POLICY } from './runtime-fact-registry.js';
import { normalizeExecutionBatchEnvironment, revokeExecutionBatchBinding } from './reviewer-batch-producer.js';
import { consumeManagedLaunchAdmission, verifyManagedLaunchAdmission, type ManagedLaunchAdmission } from './managed-launch-admission.js';
import { resolveManagedReviewIsolation } from './managed-review-lane-policy.js';
import { createManagedReviewLane, managedReviewLaneEnvironment, verifyManagedReviewLane, type ManagedReviewLane } from './managed-review-lane.js';
import { estimateManagedRunDuration, MANAGED_DURATION_ESTIMATE_POLICY, type ManagedRunDurationEstimate, type ManagedRunDurationSample } from './managed-run-duration-estimate.js';
import { assessManagedBurn, managedBurnTokenLimit } from './managed-burn-guard.js';
import { MANAGED_BURN_RUNTIME_POLICY, MANAGED_SUPERVISOR_RUNTIME_POLICY, MANAGED_REVIEW_TEMP_RUNTIME_POLICY } from './runtime-fact-registry.js';
import type { LiveProviderUsage } from './usage-ledger/dispatch-usage.js';
import { ACCEPTANCE_REVIEW_FINAL_SCHEMA, ACCEPTANCE_REVIEW_PROFILE, ACCEPTANCE_REVIEW_LANE, assertAcceptanceReviewBinding, parseAcceptanceReviewFinal, type AcceptanceReviewBinding, type AcceptanceReviewFinal } from './acceptance-amendment-review.js';
/**
 * Durable, host-independent ownership boundary for cross-provider CLI runs.
 *
 * A caller submits a sealed spec plus one-shot prompt capability, then a
 * detached worker claims it and owns the provider process until an exclusive
 * terminal record is written. Callers may attach, poll, disappear, or return;
 * none of those events owns provider liveness. In particular, output silence
 * is not a terminal signal. Every run instead has a finite absolute deadline
 * and has an independent detached recovery owner before provider launch.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  fstatSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  generateEd25519KeyPair,
  signCanonical,
  verifyCanonical,
  type PrivateKeyBase64,
} from './authority-signing.js';

import {
  HOST_RUN_FINAL_ASSISTANT_RESULT_CAP,
  classifyManagedReviewFinalEnvelope,
  hasRequiredManagedReviewReadEvidence,
  isStrictManagedReviewFindingProposal,
  managedClaudePromptDirectoryForRun,
  normalizeHostRunModelSelection,
  runHostRun,
  isSafeIsolatedProviderProcessGroup,
  type HostRunHost,
  type HostRunReasoningEffort,
  type HostRunResult,
  type HostRunRunner,
  type HostRunProcessIdentity,
  type HostRunProcessCleanup,
} from './host-run.js';
import type {
  FindingEvidenceState,
  ReviewerReadDiagnostic,
  ReviewerReadLogEvidence,
  ReviewerReadManifest,
} from './types.js';
import {
  normalizeReviewerReadDiagnostics,
  normalizeReviewerReadLogEvidence,
  normalizeReviewerReadManifest,
} from './reviewer-read-evidence.js';
import { reportHealthIssue } from './health.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import {
  acquireMkdirLock,
  withMkdirLock,
  type ExistingMkdirLockSnapshot,
  type ExistingMkdirLockState,
} from './mkdir-lock.js';
import { getSessionIdentity } from './owner-session.js';
import { resolveCanonicalRuntimeProjectRoot, MANAGED_REVIEW_TEMP_ARTIFACT, MANAGED_REVIEW_LANE_ARTIFACT } from './runtime-artifact-registry.js';
import { currentMaterialHash } from './evidence-freshness.js';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { managedRunStage, managedSupervisionAction, type ManagedRunStage,
  type ManagedSupervisionCode, type ManagedSupervisionDiagnostic } from './managed-run-progress.js';
import { StoryStore } from './store.js';
import { initCheckSignatureIsValid } from './init-check-gate.js';
import { verifyScopeCheckContentSignature } from './scope-check-integrity.js';
import { recomputeDeliveryCheckHash } from './delivery-check-hash.js';
import type { InitCheckData } from './types.js';

export const MANAGED_HOST_RUN_SCHEMA_VERSION = 'lattice.managed_host_run.v1' as const;
export const MANAGED_HOST_RUN_STATUS_WAIT_MAX_MS = 30_000;
export const MANAGED_HOST_RUN_DEFAULT_DEADLINE_MS = 30 * 60 * 1000;
export const MANAGED_HOST_RUN_MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
const MANAGED_HOST_RUN_CLAIM_TIMEOUT_MS = 5_000;
export const MANAGED_HOST_RUN_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES = 8 * 1024 * 1024;
const MANAGED_HOST_RUN_OUTPUT_READ_MAX_FRAMES = 2_048;
const MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V1 = 'lattice.managed_host_run_receipt_archive.v1' as const;
const MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V2 = 'lattice.managed_host_run_receipt_archive.v2' as const;

/**
 * Narrow child-process surface for launcher-failure cleanup. It deliberately
 * carries no PGID: before the worker has published a verified process identity,
 * descriptor-delivery failure may only target the direct child.
 */
interface ManagedHostRunLaunchedWorkerHandle {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'close' | 'error', listener: () => void): unknown;
}

/**
 * Best-effort direct-child cleanup before a worker has returned a durable,
 * fingerprint-bound process identity. Do not infer that `pid` is an isolated
 * process group: a negative-PGID signal here could target a recycled or
 * unrelated group. The launch failure remains replacement-unsafe at the
 * submitter boundary even if this direct-child reap appears to succeed.
 */
export async function reapUnidentifiedManagedHostRunWorker(
  child: ManagedHostRunLaunchedWorkerHandle,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<{ directKillSent: boolean; reaped: boolean }> {
  let directKillSent = false;
  if (child.pid && child.pid > 1) {
    try {
      directKillSent = child.kill('SIGKILL') !== false;
    } catch {
      // The child may already have exited; retain a replacement-unsafe launch failure.
    }
  }
  let reaped = child.exitCode !== null || child.signalCode !== null;
  if (!reaped) {
    await Promise.race([
      new Promise<void>(resolveClose => {
        child.once('close', resolveClose);
        child.once('error', resolveClose);
      }),
      wait(1_000),
    ]);
    reaped = child.exitCode !== null || child.signalCode !== null;
  }
  return { directKillSent, reaped };
}

export type ManagedHostRunState =
  | 'submitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type ManagedHostRunTerminalState = Extract<
  ManagedHostRunState,
  'completed' | 'failed' | 'cancelled' | 'timed_out'
>;

interface ManagedHostRunCancellationTerminal {
  state: Extract<ManagedHostRunTerminalState, 'cancelled' | 'timed_out' | 'failed'>;
  reason: string;
}

function classifyManagedHostRunCancellation(reason: string): ManagedHostRunCancellationTerminal {
  if (reason === MANAGED_SUPERVISOR_RUNTIME_POLICY.orphanReason) return { state: 'failed', reason };
  return reason === 'absolute_deadline_exceeded'
    ? { state: 'timed_out', reason: 'absolute_deadline_exceeded' }
    : { state: 'cancelled', reason };
}

export interface ManagedHostRunSubmitArgs {
  /** Stable caller request identity. Formal reviews derive it from their review tuple. */
  idempotencyKey?: string;
  root: string;
  cwd: string;
  host: HostRunHost;
  /** Exact provider selector; null/absent preserves the provider default. */
  model?: string | null;
  /** Exact provider reasoning selector; null/absent preserves the provider default. */
  reasoningEffort?: HostRunReasoningEffort | null;
  storyId: string | null;
  phase: string;
  agentType: string;
  reviewRunId?: string | null;
  lane?: string | null;
  promptText: string;
  /** Absolute supervisor budget measured from submit time. */
  deadlineMs?: number;
  /** Optional provider total timeout, capped by the absolute deadline. */
  timeoutMs?: number;
  projectRootHash: string;
  profile?: string | null;
  /** Immutable formal-review tuple. Required by the managed-reviewer profile. */
  reviewBinding?: ManagedHostRunReviewBinding | null;
  acceptanceReviewBinding?: AcceptanceReviewBinding | null;
  /** Optional one-shot environment used by redacted launch profiles. */
  environment?: NodeJS.ProcessEnv;
  /** Honest provider-progress observation capability; heartbeat remains a separate fact in either mode. */
  providerProgressMode?: 'output-observable' | 'unobservable';
  /**
   * Public host_run --managedReview requests opt into a detached, read-only
   * provider scratch. Internal legacy fixtures may omit it while they migrate
   * to a real git-backed execution workspace.
   */
  isolateManagedReview?: boolean;
}

export interface ManagedHostRunReviewBinding {
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  promptHash: string;
  envelopeId: string | null;
  /** Digest of the exact derived provider prompt, including controller status projections when present. */
  managedPromptDigest?: string;
  /** Exact full-scan reason copied into the managed provider prompt, when required. */
  fullScanEscalationReason?: string;
}

export interface ManagedHostRunWorkerRequest {
  root: string;
  runId: string;
  /** In-memory/descriptor-only signing key for a formal managed reviewer. */
  proposalInvocationPrivateKey?: string;
}

export interface ManagedHostRunWorkerLaunchResult {
  pid: number;
}

export type ManagedHostRunWorkerLauncher = (
  request: ManagedHostRunWorkerRequest,
) => ManagedHostRunWorkerLaunchResult | Promise<ManagedHostRunWorkerLaunchResult>;

export interface ManagedHostRunTerminal {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  state: ManagedHostRunTerminalState;
  reason: string;
  terminalAt: string;
  generation: number;
  replacementSafe: boolean;
  resultDigest: string | null;
  eventJournalDigest: string;
  liveOutputDigest: string | null;
  /** Digest of the complete provider stdout stream, independent of retention. */
  stdoutDigest?: string | null;
  specDigest: string;
  evidenceProposalDigest: string | null;
  /** Exact scope-check bytes accepted before a managed PLAN reviewer completed. */
  managedDispatchOutputDigest?: string;
  processCleanup: HostRunProcessCleanup | null;
}

export interface ManagedReviewEvidenceFindingProposal {
  desc: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'happy' | 'edge' | 'adversarial' | 'missing';
  files?: string[];
  evidenceState?: FindingEvidenceState;
  uncertaintyReason?: string;
}

export interface ManagedReviewEvidenceProposal {
  schemaVersion: 'lattice.managed_review_evidence_proposal.v1';
  runId: string;
  storyId: string;
  providerAgent: string;
  lane: string;
  reviewRunId: string;
  authoredAt: string;
  conclusion: 'pass' | 'findings';
  note?: string;
  findings?: ManagedReviewEvidenceFindingProposal[];
  inventoryCritic?: ManagedInventoryCritic;
  readManifest: ReviewerReadManifest;
  readLog?: ReviewerReadLogEvidence;
  readDiagnostics?: ReviewerReadDiagnostic[];
}

export interface ManagedReviewProposalInvocationBinding {
  storyId: string;
  providerAgent: string;
  lane: string;
  reviewRunId: string;
}

export interface ManagedReviewProposalInvocationAttestation extends ManagedReviewProposalInvocationBinding {
  schemaVersion: 'lattice.managed_review_proposal_invocation.v1';
  runId: string;
  providerIdentity: HostRunProcessIdentity;
  invocationNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export interface ManagedInitInvocationAttestation {
  schemaVersion: 'lattice.managed_init_invocation.v1';
  runId: string;
  storyId: string;
  providerAgent: string;
  invocationNonce: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
}

export function signManagedInitInvocation(
  claims: Omit<ManagedInitInvocationAttestation, 'signature'>,
  privateKey: PrivateKeyBase64,
): ManagedInitInvocationAttestation {
  return { ...claims, signature: signCanonical(claims, privateKey) };
}

export function signManagedReviewProposalInvocation(
  claims: Omit<ManagedReviewProposalInvocationAttestation, 'signature'>,
  privateKey: PrivateKeyBase64,
): ManagedReviewProposalInvocationAttestation {
  return { ...claims, signature: signCanonical(claims, privateKey) };
}

export interface ManagedHostRunReceipt {
  schemaVersion: 'lattice.managed_host_run_receipt.v1';
  runId: string;
  /** Exact model selector sealed by spec/result/receipt, or null for provider default. */
  model?: string | null;
  /** Exact reasoning selector sealed by spec/result/receipt, or null for provider default. */
  reasoningEffort?: HostRunReasoningEffort | null;
  receiptId: string;
  terminalDigest: string;
  state: ManagedHostRunTerminalState;
  specDigest: string;
  /**
   * B-137a:F-299/F-312 — digest of the live binding projection, inside the
   * receipt payload so receiptId covers it. Required on any archive that
   * returns a binding. Absence is not "verify when present": a binding-bearing
   * archive without this field is corrupt, not a pre-fix skip.
   */
  bindingProjectionDigest?: string;
  resultDigest: string | null;
  eventJournalDigest: string;
  liveOutputDigest: string | null;
  /** Digest of the complete provider stdout stream, independent of retention. */
  stdoutDigest?: string | null;
  evidenceProposalDigest: string | null;
  /** Receipt-bound role output; currently required for managed PLAN scope reviewers. */
  managedDispatchOutputDigest?: string;
  replacementSafe: boolean;
  processCleanup: HostRunProcessCleanup | null;
  terminalAt: string;
}

export interface ManagedHostRunProjection {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  host: HostRunHost;
  model?: string | null;
  reasoningEffort?: HostRunReasoningEffort | null;
  storyId: string | null;
  phase: string;
  agentType: string;
  reviewRunId: string | null;
  lane: string | null;
  profile: string | null;
  state: ManagedHostRunState;
  generation: number;
  stage: ManagedRunStage;
  durationEstimate: ManagedRunDurationEstimate;
  supervisionDiagnostic: ManagedSupervisionDiagnostic | null;
  providerClosedAt: string | null;
  createdAt: string;
  deadlineAt: string;
  workerPid: number | null;
  workerHeartbeatAt: string | null;
  /** Last observed provider stdout/stderr byte, never a completion signal. */
  lastProviderProgressAt: string | null;
  /** Visibility of provider output; independent from worker heartbeat. */
  providerProgressMode: 'output-observable' | 'unobservable';
  cancelRequestedAt: string | null;
  replacementSafe: boolean;
  /**
   * A marker-bound managed-review scratch could not be removed. This is
   * operational state, deliberately separate from the sealed provider
   * terminal: retrying cleanup must never rewrite a terminal verdict.
   */
  managedReviewScratchCleanupDiagnostic: ManagedReviewScratchCleanupDiagnostic | null;
  terminal: ManagedHostRunTerminal | null;
}

export interface ManagedHostRunStatusResult {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  changed: boolean;
  run: ManagedHostRunProjection;
  receipt: ManagedHostRunReceipt | null;
}

export interface ManagedHostRunOutputFrame {
  sequence: number;
  at: string;
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ManagedHostRunOutputResult {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  frames: ManagedHostRunOutputFrame[];
  nextSequence: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface ManagedHostRunRuntimeDiagnostic {
  runId: string;
  state: ManagedHostRunState | 'corrupt';
  workerLiveness: 'not-started' | 'alive' | 'dead' | 'not-applicable' | 'unknown';
  workerHeartbeatAt: string | null;
  workerHeartbeatAgeMs: number | null;
  providerProgressMode: 'output-observable' | 'unobservable' | 'unknown';
  lastProviderProgressAt: string | null;
  providerProgressAgeMs: number | null;
  deadlineAt: string | null;
  deadlineExpired: boolean | null;
  cancelRequestedAt: string | null;
  replacementSafe: boolean | null;
  residualProcessGroup: boolean | null;
  terminalAt: string | null;
  terminalReason: string | null;
  retentionEligibleAt: string | null;
  retentionExpired: boolean;
  hasUnconsumedOneShotInputs: boolean;
  managedReviewScratchCleanupDiagnostic: ManagedReviewScratchCleanupDiagnostic | null;
  error: string | null;
}

export interface ManagedHostRunRuntimeScan {
  root: string;
  retentionMs: number;
  active: number;
  terminal: number;
  corrupt: number;
  eligibleForGc: number;
  runs: ManagedHostRunRuntimeDiagnostic[];
}

export interface ManagedHostRunGcResult {
  removed: string[];
  archivedReceipts: string[];
  retained: Array<{ runId: string; reason: string }>;
  failed: Array<{ runId: string; error: string }>;
}

interface ManagedHostRunReceiptArchive {
  schemaVersion: typeof MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V1 | typeof MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V2;
  runId: string;
  archivedAt: string;
  receipt: ManagedHostRunReceipt;
  evidenceBindingDigest: string | null;
  /**
   * B-137a:F-127 — the binding projection, persisted so already-imported managed
   * review evidence stays verifiable after terminal-retention GC deletes the run
   * directory. OPTIONAL so archives written before this field remain readable;
   * absent means "pre-F-127 archive", which degrades to the old ENOENT refusal
   * rather than a crash. Terminal GC must not keep such an archive when live
   * artifacts can still upgrade it (B-137a:F-135).
   */
  binding?: ManagedHostRunBindingProjection;
  /**
   * B-137a:F-127 — the provider-authored proposal BODY.
   *
   * Archiving it is what makes reclaimed-run evidence fully re-verifiable:
   * semanticDigestValid and subjectMatches both require a non-null proposal, so
   * without it every post-GC verification of an imported pass refuses even though
   * the receipt is intact.
   *
   * The retention/trust boundary still sheds the sensitive bulk: live-output.jsonl
   * (~923 KB observed) and result.json's finalAssistantResult (~6.7 KB of raw
   * provider text) are deleted. The proposal is structured VERDICT metadata —
   * conclusion, lane, providerAgent, reviewRunId, readManifest/readLog provenance
   * — about 6.8 KB, carrying no provider transcript. Integrity is preserved
   * because the archived TEXT is re-digested against the sealed receipt's
   * evidenceProposalDigest on read (sha256 over the original file bytes, which is
   * why the raw text is stored rather than a re-serialized object), so a tampered
   * archive is rejected rather than trusted.
   */
  evidenceProposalText?: string | null;
  /**
   * B-137a:F-127 — the import seal pair (evidence-binding.json + .seal.json),
   * 550 bytes of pure metadata (runId / receiptId / storyId / reviewRunId / lane /
   * importedAt / importedIds), no provider text. externalImportSealMatches returns
   * false when these are absent, so without them a reclaimed run still refuses.
   * The binding body is re-digested against the archive's own evidenceBindingDigest
   * on read; the archived seal's schemaVersion, runId, and bindingDigest are
   * checked the same way as the live path. A tampered archive is rejected.
   */
  evidenceBindingText?: string | null;
  evidenceBindingSealText?: string | null;
}

const MANAGED_REVIEW_SCRATCH_SCHEMA_VERSION = 'lattice.managed_review_scratch.v1' as const;
const MANAGED_REVIEW_SCRATCH_PARENT_PREFIX = 'lattice-managed-review-';
const MANAGED_REVIEW_SCRATCH_REGISTRATION = 'managed-review-scratch.json';

/**
 * A sealed, provider-only execution workspace for a formal managed review.
 * `root` remains the canonical story worktree that owns all durable run and
 * evidence artifacts; `cwd` is the detached sealed source snapshot. Fresh
 * specs also carry `executionCwd`, a second same-HEAD worktree used only for
 * commands that may generate files. It is optional solely so historical
 * in-flight specs can still be read and cleaned up.
 */
export interface ManagedReviewScratchWorktree {
  schemaVersion: typeof MANAGED_REVIEW_SCRATCH_SCHEMA_VERSION;
  runId: string;
  root: string;
  parent: string;
  cwd: string;
  executionCwd?: string;
  sourceGitFileDigest?: string;
  executionGitFileDigest?: string;
  sourceDirectoryIdentity?: ManagedReviewScratchPathIdentity;
  executionDirectoryIdentity?: ManagedReviewScratchPathIdentity;
  sourceGitFileIdentity?: ManagedReviewScratchPathIdentity;
  executionGitFileIdentity?: ManagedReviewScratchPathIdentity;
  sourceGitAdminDir?: string;
  executionGitAdminDir?: string;
  headHash: string;
  nonce: string;
  readonlyLane?: ManagedReviewLane;
}

interface ManagedReviewScratchPathIdentity {
  dev: number;
  ino: number;
}

type ManagedReviewScratchCleanupStage =
  | 'terminal'
  | 'submit_artifact_setup'
  | 'submit_input_setup';

export interface ManagedReviewScratchCleanupDiagnostic {
  schemaVersion: 'lattice.managed_review_scratch_cleanup_diagnostic.v1';
  runId: string;
  stage: ManagedReviewScratchCleanupStage;
  recordedAt: string;
  error: string;
}

interface ManagedHostRunSpec {
  /** Absent only on historical specs; fresh isolated submits always emit it. */
  executionAdmission?: { version: 1; binding: ManagedLaunchAdmission['binding'] };
  /** Sampled once at submission; sealed by the existing immutable spec binding. */
  durationEstimate?: ManagedRunDurationEstimate;
  /** Immutable supervisor cost limit; absent only for older managed specs. */
  burnTokenLimit?: number;
  /** Digest of normalized submit inputs, sealed by the owner's specDigest. */
  submissionDigest?: string;
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  host: HostRunHost;
  /** Optional for historical specs written before exact selector binding. */
  model?: string | null;
  /** Optional for historical specs written before exact selector binding. */
  reasoningEffort?: HostRunReasoningEffort | null;
  storyId: string | null;
  phase: string;
  agentType: string;
  reviewRunId: string | null;
  lane: string | null;
  cwd: string;
  root: string;
  /** Present only for public host_run --managedReview isolated executions. */
  managedReviewScratch?: ManagedReviewScratchWorktree | null;
  /** Sealed runtime for the existing cross-host snapshot; its controller owns cleanup. */
  crossHostReadonlyLane?: ManagedReviewLane;
  createdAt: string;
  deadlineAt: string;
  timeoutMs: number;
  projectRootHash: string;
  profile: string | null;
  reviewBinding: ManagedHostRunReviewBinding | null;
  acceptanceReviewBinding?: AcceptanceReviewBinding;
}

export interface ManagedHostRunBindingProjection {
  runId: string;
  host: HostRunHost;
  model?: string | null;
  reasoningEffort?: HostRunReasoningEffort | null;
  storyId: string | null;
  phase: string;
  agentType: string;
  reviewRunId: string | null;
  lane: string | null;
  cwd: string;
  deadlineAt: string;
  timeoutMs: number;
  projectRootHash: string;
  profile: string | null;
  promptDigest: string;
  reviewBinding: ManagedHostRunReviewBinding | null;
  acceptanceReviewBinding?: AcceptanceReviewBinding;
}

interface ManagedHostRunOwner {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  capabilityDigest: string;
  proposalInvocationPublicKey: string | null;
  specDigest: string;
  promptDigest: string;
  environmentDigest: string | null;
  createdAt: string;
}

interface ManagedHostRunSnapshot {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  state: ManagedHostRunState;
  generation: number;
  createdAt: string;
  deadlineAt: string;
  workerPid: number | null;
  workerHeartbeatAt: string | null;
  lastProviderProgressAt: string | null;
  providerProgressMode: 'output-observable' | 'unobservable';
  providerLaunchState: 'pending' | 'granted' | 'spawned' | 'revoked';
  providerIdentity: HostRunProcessIdentity | null;
  providerClosedAt?: string | null;
  supervisionDiagnostic?: ManagedSupervisionDiagnostic | null;
  outputSequence: number;
  outputRetainedBytes: number;
  outputTruncated: boolean;
  replacementSafe: boolean;
}

interface ManagedHostRunCancelRequest {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  requestedAt: string;
  reason: string;
}

interface ManagedHostRunClaim {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  workerPid: number;
  claimedAt: string;
  capabilityDigest: string;
}

interface ManagedHostRunEvent {
  schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION;
  runId: string;
  at: string;
  type: string;
  detail?: Record<string, unknown>;
}

interface ManagedHostRunSnapshotEventTransition {
  schemaVersion: 'lattice.managed_host_run_snapshot_event_transition.v1';
  runId: string;
  snapshot: ManagedHostRunSnapshot;
  event: ManagedHostRunEvent;
}

export interface ManagedHostRunSubmitDeps {
  /** Trusted application callback: durably pin the generated public key before any worker launch. */
  onAcceptanceReviewKeyCreated?: (value: { runId: string; publicKey: string }) => void;
  launchWorker?: ManagedHostRunWorkerLauncher;
  /** Declares an injected launcher that faithfully forwards the private key by pipe. */
  workerCapabilityTransport?: 'descriptor';
  now?: () => number;
  randomId?: () => string;
  claimTimeoutMs?: number;
  claimPollMs?: number;
  platform?: NodeJS.Platform;
  /** Test-only scratch-parent seam; production always creates a fresh OS-temp parent. */
  managedReviewScratchParentFactory?: () => string;
  /** Test-only seam before submission writes one-shot inputs. */
  beforeOneShotInputWrite?: (args: { root: string; runId: string }) => void;
}

export interface ManagedHostRunWorkerDeps {
  runner?: HostRunRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  heartbeatMs?: number;
  cancelPollMs?: number;
  /** Test seam for the immutable proposal pre-read → write race. */
  afterManagedReviewProposalPreRead?: (args: { root: string; runId: string; hasValidProposal: boolean }) => void;
  /** Test seam after exact managed-dispatch output bytes validate, before terminal sealing. */
  afterManagedDispatchOutputValidated?: (args: { root: string; runId: string; outputDigest: string | null }) => void;
  /** Test seam after provider-slot transfer and durable identity persistence, before host-run returns from onSpawn. */
  afterProviderIdentityPersisted?: (identity: HostRunProcessIdentity) => void;
}

function readWorkerProposalInvocationPrivateKey(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const rawFd = env.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD?.trim();
  if (!rawFd) return undefined;
  const fd = Number(rawFd);
  if (!Number.isInteger(fd) || fd < 3 || fd > 255) {
    throw new Error('managed host run worker: proposal capability fd must be between 3 and 255');
  }
  const stat = fstatSync(fd);
  if (stat.isFile()) {
    throw new Error('managed host run worker: proposal capability must arrive over a non-file descriptor');
  }
  const key = readFileSync(fd, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) {
    throw new Error('managed host run worker: proposal capability descriptor is malformed');
  }
  return key;
}

interface ManagedHostRunPaths {
  /**
   * The caller-selected directory is part of the durable run authority.  Do
   * not treat a mutually consistent set of artifacts from another directory
   * as this run: every parsed run-owned artifact must re-bind to this value.
   */
  expectedRunId: string;
  dir: string;
  spec: string;
  owner: string;
  capability: string;
  prompt: string;
  environment: string;
  claim: string;
  snapshot: string;
  snapshotEventTransition: string;
  events: string;
  output: string;
  result: string;
  terminal: string;
  cancelRequest: string;
  workerLog: string;
  evidenceProposal: string;
  evidenceBinding: string;
  evidenceBindingSeal: string;
  scratchCleanupDiagnostic: string;
  initInvocationConsumption: string;
  claimLock: string;
  reconcileLock: string;
  terminalLock: string;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function boundedPositiveMs(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function assertRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
    || runId.includes('..')) {
    throw new Error(`managed host run: invalid runId "${String(runId)}"`);
  }
}

export function managedHostRunsRoot(root: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'host-runs');
}

export function managedHostRunReceiptsRoot(root: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'host-run-receipts');
}

function managedHostRunReceiptArchivePath(root: string, runId: string): string {
  assertRunId(runId);
  return join(managedHostRunReceiptsRoot(root), `${runId}.json`);
}

export function managedHostRunDirectory(root: string, runId: string): string {
  assertRunId(runId);
  return join(managedHostRunsRoot(root), runId);
}

/**
 * Exact directory-name prefixes a cross-host review snapshot may carry, in
 * canonical-first order. `handlers/cross-host-review.ts` creates the first one;
 * the second is the retired spelling, retained ONLY so a snapshot left by an
 * older build stays cleanable instead of leaking. Adding a name here widens a
 * deletion boundary, so it must stay an exact, closed list.
 */
const CROSS_HOST_REVIEW_SNAPSHOT_PREFIXES: readonly string[] = [
  'proof-or-stop-xhr-review-',
  'lattice-xhr-review-',
];

function crossHostReadonlySnapshot(root: string, cwd: string) {
  const canonicalRoot = realpathSync(root), canonicalCwd = realpathSync(cwd);
  const parent = dirname(canonicalCwd);
  if (canonicalCwd !== resolve(cwd) || basename(canonicalCwd) !== 'worktree'
    || dirname(parent) !== realpathSync(tmpdir())
    || !CROSS_HOST_REVIEW_SNAPSHOT_PREFIXES.some(prefix => basename(parent).startsWith(prefix))
    || lstatSync(parent).isSymbolicLink() || lstatSync(cwd).isSymbolicLink()) {
    throw new Error('cross-host readonly snapshot is outside its canonical owned boundary');
  }
  const records = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: canonicalRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }).split('\n\n').map(block => block.split('\n'));
  const registered = records.find(lines => lines.includes(`worktree ${canonicalCwd}`));
  const headHash = managedReviewScratchHead(canonicalCwd);
  if (!registered?.includes('detached') || !registered.includes(`HEAD ${headHash}`)) {
    throw new Error('cross-host readonly snapshot must be a registered detached worktree');
  }
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], {cwd: canonicalCwd, stdio:'pipe'});
  return {root:canonicalRoot, cwd:canonicalCwd, parent, headHash};
}

/**
 * Remove only the detached cross-host snapshot shape created by the managed
 * adapter. The canonical tmp boundary is checked before either git metadata or
 * filesystem state is touched, so a persisted caller-controlled cwd cannot
 * turn retention GC into an arbitrary deletion primitive.
 */
export function cleanupManagedCrossHostReviewWorktree(gitCwd: string, worktree: string): void {
  // Accept the historical lexical tmp alias, but never follow a replaced parent.
  const lexicalParent = dirname(worktree);
  if (existsSync(lexicalParent) && lstatSync(lexicalParent).isSymbolicLink()) {
    throw new Error('managed host run: cross-host snapshot parent is a symlink');
  }
  worktree = join(realpathSync(dirname(lexicalParent)), basename(lexicalParent), basename(worktree));
  const parent = dirname(worktree);
  if (basename(worktree) !== 'worktree'
    // B-137a main-merge fix: the snapshot CREATOR
    // (handlers/cross-host-review.ts) makes `proof-or-stop-xhr-review-*` after
    // the brand rename, while this consumer still required the retired
    // `lattice-` prefix -- so every cross-host snapshot cleanup/resume failed
    // with "outside the canonical temporary boundary". Accept the canonical
    // prefix, and keep the retired one so a snapshot created by an older build
    // is still cleanable rather than leaked. Both remain exact-prefix checks
    // under tmpdir(), so the boundary is not widened beyond these two names.
    || !CROSS_HOST_REVIEW_SNAPSHOT_PREFIXES.some(prefix => basename(parent).startsWith(prefix))
    || dirname(parent) !== realpathSync(tmpdir())) {
    throw new Error(`managed host run: cross-host review snapshot is outside the canonical temporary boundary: ${worktree}`);
  }
  if (!existsSync(worktree)) {
    const registeredWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    const registered = registeredWorktrees
      .split('\n')
      .some(line => line === `worktree ${resolve(worktree)}`);
    if (!registered) {
      rmSync(parent, { recursive: true, force: true });
      return;
    }
  }
  // Git administration is authoritative for a registered worktree. If this
  // mutation fails, retain the filesystem snapshot and surface the error to GC
  // diagnostics; deleting only the directory would strand hidden registration
  // state while falsely reporting successful cleanup.
  execFileSync('git', ['worktree', 'remove', '--force', worktree], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  rmSync(parent, { recursive: true, force: true });
}

function managedReviewScratchRegistrationPath(scratch: ManagedReviewScratchWorktree): string {
  return join(scratch.parent, MANAGED_REVIEW_SCRATCH_REGISTRATION);
}

function canonicalManagedReviewScratchPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function managedReviewScratchPathIdentity(path: string, kind: 'directory' | 'file'): ManagedReviewScratchPathIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`managed host run: managed-review scratch ${kind} identity is invalid`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function isManagedReviewScratchPathIdentity(value: unknown): value is ManagedReviewScratchPathIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).sort().join(',') === 'dev,ino'
    && Number.isSafeInteger(identity.dev) && Number(identity.dev) >= 0
    && Number.isSafeInteger(identity.ino) && Number(identity.ino) >= 0;
}

function assertManagedReviewScratchShape(scratch: ManagedReviewScratchWorktree): void {
  const canonicalTmp = canonicalManagedReviewScratchPath(tmpdir());
  const canonicalRoot = canonicalManagedReviewScratchPath(scratch.root);
  const canonicalParent = canonicalManagedReviewScratchPath(scratch.parent);
  const canonicalCwd = canonicalManagedReviewScratchPath(scratch.cwd);
  if (scratch.schemaVersion !== MANAGED_REVIEW_SCRATCH_SCHEMA_VERSION
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(scratch.runId)
    || scratch.runId.includes('..')
    || scratch.root !== canonicalRoot
    || scratch.parent !== canonicalParent
    || scratch.cwd !== canonicalCwd
    || dirname(canonicalParent) !== canonicalTmp
    || !basename(canonicalParent).startsWith(MANAGED_REVIEW_SCRATCH_PARENT_PREFIX)
    || canonicalCwd !== join(canonicalParent, 'worktree')
    || (scratch.executionCwd !== undefined
      && (canonicalManagedReviewScratchPath(scratch.executionCwd) !== join(canonicalParent, MANAGED_REVIEW_LANE_ARTIFACT.executionWorktree)
        || scratch.executionCwd === scratch.cwd))
    || (scratch.sourceGitFileDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(scratch.sourceGitFileDigest))
    || (scratch.executionGitFileDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(scratch.executionGitFileDigest))
    || (scratch.sourceDirectoryIdentity !== undefined && !isManagedReviewScratchPathIdentity(scratch.sourceDirectoryIdentity))
    || (scratch.executionDirectoryIdentity !== undefined && !isManagedReviewScratchPathIdentity(scratch.executionDirectoryIdentity))
    || (scratch.sourceGitFileIdentity !== undefined && !isManagedReviewScratchPathIdentity(scratch.sourceGitFileIdentity))
    || (scratch.executionGitFileIdentity !== undefined && !isManagedReviewScratchPathIdentity(scratch.executionGitFileIdentity))
    || !/^[0-9a-f]{40,64}$/i.test(scratch.headHash)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(scratch.nonce)) {
    throw new Error('managed host run: managed-review scratch shape is not an owned canonical detached-worktree path');
  }
}

function registeredWorktreePaths(gitCwd: string): Set<string> {
  const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  return new Set(raw.split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => canonicalManagedReviewScratchPath(line.slice('worktree '.length).trim())));
}

function managedReviewScratchHead(gitCwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  }).trim();
}

function managedReviewScratchGitAdminDir(gitCwd: string): string {
  const path = execFileSync('git', ['rev-parse', '--git-dir'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
  }).trim();
  return canonicalManagedReviewScratchPath(resolve(gitCwd, path));
}

function managedReviewScratchAdminMarkerContent(scratch: ManagedReviewScratchWorktree, side: 'source' | 'execution'): string {
  return `${scratch.schemaVersion}:${scratch.runId}:${scratch.nonce}:${side}\n`;
}

function assertManagedReviewScratchAdminMarker(scratch: ManagedReviewScratchWorktree, side: 'source' | 'execution'): void {
  const adminDir = side === 'source' ? scratch.sourceGitAdminDir : scratch.executionGitAdminDir;
  const cwd = side === 'source' ? scratch.cwd : scratch.executionCwd;
  if (!adminDir || !cwd
    || managedReviewScratchGitAdminDir(cwd) !== adminDir
    || readFileSync(join(adminDir, MANAGED_REVIEW_LANE_ARTIFACT.scratchAdminMarker), 'utf8') !== managedReviewScratchAdminMarkerContent(scratch, side)) {
    throw new Error('managed host run: managed-review scratch Git admin identity changed after registration');
  }
}

function assertManagedReviewScratchGenerationIdentity(
  scratch: ManagedReviewScratchWorktree,
  registered = registeredWorktreePaths(scratch.root),
): void {
  const identityFields = [
    scratch.executionCwd,
    scratch.sourceGitFileDigest,
    scratch.executionGitFileDigest,
    scratch.sourceDirectoryIdentity,
    scratch.executionDirectoryIdentity,
    scratch.sourceGitFileIdentity,
    scratch.executionGitFileIdentity,
    scratch.sourceGitAdminDir,
    scratch.executionGitAdminDir,
  ];
  if (identityFields.every(value => value === undefined)) return; // Historical single-worktree spec.
  if (identityFields.some(value => value === undefined) || !scratch.executionCwd
    || !registered.has(scratch.cwd) || !registered.has(scratch.executionCwd)) {
    throw new Error('managed host run: managed-review scratch generation identity is incomplete');
  }
  if (sha256(readFileSync(join(scratch.cwd, '.git'), 'utf8')) !== scratch.sourceGitFileDigest
    || sha256(readFileSync(join(scratch.executionCwd, '.git'), 'utf8')) !== scratch.executionGitFileDigest) {
    throw new Error('managed host run: managed-review scratch git metadata changed after registration');
  }
  if (canonicalJson(managedReviewScratchPathIdentity(scratch.cwd, 'directory')) !== canonicalJson(scratch.sourceDirectoryIdentity)
    || canonicalJson(managedReviewScratchPathIdentity(scratch.executionCwd, 'directory')) !== canonicalJson(scratch.executionDirectoryIdentity)
    || canonicalJson(managedReviewScratchPathIdentity(join(scratch.cwd, '.git'), 'file')) !== canonicalJson(scratch.sourceGitFileIdentity)
    || canonicalJson(managedReviewScratchPathIdentity(join(scratch.executionCwd, '.git'), 'file')) !== canonicalJson(scratch.executionGitFileIdentity)) {
    throw new Error('managed host run: managed-review scratch path identity changed after registration');
  }
  assertManagedReviewScratchAdminMarker(scratch, 'source');
  assertManagedReviewScratchAdminMarker(scratch, 'execution');
}

/**
 * Setup failures happen before a worker or provider has been launched. The
 * parent came from this invocation's private mkdtemp allocation, so only this
 * exact temporary registration may be removed; the canonical story worktree is
 * never a cleanup target.
 */
function cleanupManagedReviewScratchSetupFailure(scratch: ManagedReviewScratchWorktree): void {
  assertManagedReviewScratchShape(scratch);
  const registered = registeredWorktreePaths(scratch.root);
  for (const worktree of [scratch.executionCwd, scratch.cwd].filter((path): path is string => path !== undefined)) {
    if (!registered.has(worktree)) continue;
    execFileSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: scratch.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  rmSync(scratch.parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

/**
 * Create the only provider execution directory accepted for a public formal
 * managed review. The marker is outside the review tree, binds it to the
 * sealed run id/root/HEAD, and keeps provider read access from becoming cleanup
 * authority over the canonical story worktree.
 */
export function createManagedReviewScratchWorktree(args: {
  gitCwd: string;
  runId: string;
  headHash: string;
  parentFactory?: () => string;
}): ManagedReviewScratchWorktree {
  // B-137a main-merge fix: this local IS the resolved git cwd (realpath of
  // args.gitCwd), but naming it `root` tripped the gitroot-cwd contract, which
  // flags bare root/projectRoot/metadataRoot used as a git cwd. Renamed to say
  // what it is; the struct field `root` below is unchanged.
  const scratchGitCwd = canonicalManagedReviewScratchPath(args.gitCwd);
  const parent = canonicalManagedReviewScratchPath((args.parentFactory ?? (() => mkdtempSync(join(tmpdir(), MANAGED_REVIEW_SCRATCH_PARENT_PREFIX))))());
  const executionCwd = join(parent, MANAGED_REVIEW_LANE_ARTIFACT.executionWorktree);
  const scratch: ManagedReviewScratchWorktree = {
    schemaVersion: MANAGED_REVIEW_SCRATCH_SCHEMA_VERSION,
    runId: args.runId,
    root: scratchGitCwd,
    parent,
    cwd: join(parent, 'worktree'),
    executionCwd,
    headHash: args.headHash.trim(),
    nonce: randomBytes(24).toString('base64url'),
  };
  try {
    assertManagedReviewScratchShape(scratch);
    if (managedReviewScratchHead(scratchGitCwd) !== scratch.headHash) {
      throw new Error(`managed host run: review HEAD changed before scratch creation (${scratch.headHash} no longer current)`);
    }
    execFileSync('git', ['worktree', 'add', '--detach', scratch.cwd, scratch.headHash], {
      cwd: scratchGitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    execFileSync('git', ['worktree', 'add', '--detach', executionCwd, scratch.headHash], {
      cwd: scratchGitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    scratch.sourceGitFileDigest = sha256(readFileSync(join(scratch.cwd, '.git'), 'utf8'));
    scratch.executionGitFileDigest = sha256(readFileSync(join(executionCwd, '.git'), 'utf8'));
    scratch.sourceDirectoryIdentity = managedReviewScratchPathIdentity(scratch.cwd, 'directory');
    scratch.executionDirectoryIdentity = managedReviewScratchPathIdentity(executionCwd, 'directory');
    scratch.sourceGitFileIdentity = managedReviewScratchPathIdentity(join(scratch.cwd, '.git'), 'file');
    scratch.executionGitFileIdentity = managedReviewScratchPathIdentity(join(executionCwd, '.git'), 'file');
    scratch.sourceGitAdminDir = managedReviewScratchGitAdminDir(scratch.cwd);
    scratch.executionGitAdminDir = managedReviewScratchGitAdminDir(executionCwd);
    writeFileSync(join(scratch.sourceGitAdminDir, MANAGED_REVIEW_LANE_ARTIFACT.scratchAdminMarker),
      managedReviewScratchAdminMarkerContent(scratch, 'source'), { flag: 'wx', mode: 0o400 });
    writeFileSync(join(scratch.executionGitAdminDir, MANAGED_REVIEW_LANE_ARTIFACT.scratchAdminMarker),
      managedReviewScratchAdminMarkerContent(scratch, 'execution'), { flag: 'wx', mode: 0o400 });
    assertManagedReviewScratchShape(scratch);
    if (managedReviewScratchHead(scratch.cwd) !== scratch.headHash
      || managedReviewScratchHead(executionCwd) !== scratch.headHash
      || !registeredWorktreePaths(scratchGitCwd).has(scratch.cwd)
      || !registeredWorktreePaths(scratchGitCwd).has(executionCwd)) {
      throw new Error('managed host run: detached managed-review scratch registration/head verification failed');
    }
    atomicWrite(managedReviewScratchRegistrationPath(scratch), scratch);
    return scratch;
  } catch (error) {
    try {
      cleanupManagedReviewScratchSetupFailure(scratch);
    } catch (cleanupError) {
      throw new Error(
        `managed host run: managed-review scratch setup failed and exact owned cleanup also failed: `
        + `${error instanceof Error ? error.message : String(error)}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw new Error(
      `managed host run: cannot create detached managed-review scratch at ${scratch.headHash}; refusing to execute in the canonical worktree `
      + `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Remove only a marker-bound scratch registration. This remains idempotent
 * after a successful terminal cleanup, but refuses to remove a registered path
 * whose ownership marker no longer matches the sealed run identity.
 */
function cleanupManagedReviewScratchWorktree(gitCwd: string, scratch: ManagedReviewScratchWorktree): void {
  assertManagedReviewScratchShape(scratch);
  if (canonicalManagedReviewScratchPath(gitCwd) !== scratch.root) {
    throw new Error('managed host run: refusing managed-review scratch cleanup from a root other than its sealed canonical worktree');
  }
  const registered = registeredWorktreePaths(scratch.root);
  if (!existsSync(scratch.parent)) {
    if (registered.has(scratch.cwd) || (scratch.executionCwd !== undefined && registered.has(scratch.executionCwd))) {
      throw new Error('managed host run: scratch parent is absent but its git worktree remains registered; retain for manual recovery');
    }
    return;
  }
  const markerPath = managedReviewScratchRegistrationPath(scratch);
  if (!existsSync(markerPath)) {
    throw new Error('managed host run: scratch registration marker is absent; refusing unbound cleanup');
  }
  const marker = readJson<ManagedReviewScratchWorktree>(markerPath);
  if (canonicalJson(marker) !== canonicalJson(scratch)) {
    throw new Error('managed host run: scratch registration marker does not match the sealed run identity');
  }
  // Fresh scratch cleanup consumes the same generation identity as terminal
  // validation. A replacement is retained with a diagnostic for manual
  // recovery; path equality never grants deletion authority.
  assertManagedReviewScratchGenerationIdentity(scratch, registered);
  for (const worktree of [scratch.executionCwd, scratch.cwd].filter((path): path is string => path !== undefined)) {
    if (!registered.has(worktree)) continue;
    execFileSync('git', ['worktree', 'remove', '--force', worktree], {
      cwd: scratch.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  rmSync(scratch.parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}

/** Temp state belongs beside the detached source, never in the source tree. */
function managedReviewTemporaryEnvironment(spec: ManagedHostRunSpec): NodeJS.ProcessEnv {
  if (spec.crossHostReadonlyLane) return managedReviewLaneEnvironment(spec.crossHostReadonlyLane);
  if (!spec.managedReviewScratch) return {};
  const scratch = spec.managedReviewScratch;
  assertManagedReviewScratchShape(scratch);
  if (scratch.readonlyLane) return managedReviewLaneEnvironment(scratch.readonlyLane);
  const temporaryRoot = join(scratch.parent, MANAGED_REVIEW_TEMP_ARTIFACT.directoryName);
  if (!existsSync(temporaryRoot)) mkdirSync(temporaryRoot, { mode: MANAGED_REVIEW_TEMP_RUNTIME_POLICY.directoryMode });
  if (!lstatSync(temporaryRoot).isDirectory() || lstatSync(temporaryRoot).isSymbolicLink()
    || realpathSync(temporaryRoot) !== temporaryRoot) throw new Error('managed review temporary root is not an owned canonical directory');
  chmodSync(temporaryRoot, MANAGED_REVIEW_TEMP_RUNTIME_POLICY.directoryMode);
  return {
    ...Object.fromEntries(MANAGED_REVIEW_TEMP_RUNTIME_POLICY.environmentKeys.map(key => [key, temporaryRoot])),
    ...(scratch.executionCwd ? { PROOF_OR_STOP_REVIEW_EXECUTION_CWD: scratch.executionCwd } : {}),
  };
}

/**
 * Re-check the sealed managed-review execution workspace.
 *
 * The pre-launch check proves that the provider starts in the owned detached
 * worktree. The post-exit check additionally proves that the provider did not
 * change that worktree before any proposal is read or terminal receipt is
 * sealed. A managed-review receipt must therefore never vouch for bytes other
 * than its signed review binding.
 */
function assertManagedReviewScratchExecution(
  spec: ManagedHostRunSpec,
  options: { verifyBoundMaterial?: boolean } = {},
): void {
  if (spec.crossHostReadonlyLane) {
    if (spec.profile !== 'cross_host_review_codex' || spec.host !== 'codex' || spec.managedReviewScratch) {
      throw new Error('managed host run: cross-host readonly lane profile mismatch');
    }
    const expected = crossHostReadonlySnapshot(spec.root, spec.cwd);
    if (expected.headHash !== spec.crossHostReadonlyLane.binding.headHash) throw new Error('cross-host readonly snapshot HEAD changed');
    verifyManagedReviewLane(spec.crossHostReadonlyLane, expected);
  }
  const scratch = spec.managedReviewScratch;
  if (!scratch) return;
  if (!isIsolatedReviewerProfile(spec.profile)
    || spec.cwd !== (scratch.executionCwd ?? scratch.cwd)
    || canonicalManagedReviewScratchPath(spec.root) !== scratch.root
    || spec.reviewBinding?.headHash !== scratch.headHash) {
    throw new Error('managed host run: sealed managed-review scratch does not match the provider execution binding');
  }
  assertManagedReviewScratchShape(scratch);
  const marker = readJson<ManagedReviewScratchWorktree>(managedReviewScratchRegistrationPath(scratch));
  const registered = registeredWorktreePaths(scratch.root);
  if (canonicalJson(marker) !== canonicalJson(scratch)
    || !registered.has(scratch.cwd)
    || (scratch.executionCwd !== undefined && !registered.has(scratch.executionCwd))
    || managedReviewScratchHead(scratch.cwd) !== scratch.headHash
    || (scratch.executionCwd !== undefined && managedReviewScratchHead(scratch.executionCwd) !== scratch.headHash)) {
    throw new Error('managed host run: managed-review scratch was replaced, unregistered, or moved off its sealed detached HEAD');
  }
  assertManagedReviewScratchGenerationIdentity(scratch, registered);
  if (scratch.readonlyLane) verifyManagedReviewLane(scratch.readonlyLane, scratch);
  if (!options.verifyBoundMaterial) return;
  const observedMaterialHash = currentMaterialHash(scratch.cwd);
  if (!observedMaterialHash || observedMaterialHash !== spec.reviewBinding?.materialHash) {
    throw new Error('managed host run: managed-review scratch material no longer matches its signed review binding');
  }
  if (scratch.executionCwd !== undefined) {
    const executionMaterialHash = currentMaterialHash(scratch.executionCwd);
    if (!executionMaterialHash || executionMaterialHash !== spec.reviewBinding?.materialHash) {
      throw new Error('managed host run: managed-review execution worktree tracked material no longer matches its signed review binding');
    }
    const trackedExecutionDrift = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
      cwd: scratch.executionCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
    if (trackedExecutionDrift) {
      throw new Error('managed host run: managed-review execution worktree tracked material no longer matches its signed review binding');
    }
  }
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], {
    cwd: scratch.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  });
  // B-137a: judge MATERIAL, not every byte git can see. This predicate exists to
  // catch provider-authored changes to the reviewed tree, but a raw non-empty
  // `git status --ignored=matching` also fires on the framework's OWN runtime
  // artifacts -- `.proof-or-stop/runtime/` (this very run's directory) and
  // `docs/story/activity.jsonl` (the CLI heartbeat) -- which the reviewer never
  // touched. That made every managed lane structurally unrunnable: the run
  // dirtied its own scratch merely by existing. Note the inconsistency this
  // removes: `currentMaterialHash` immediately above ALREADY filters through
  // `isMaterialExcludedPath`, so the binding check passed on exactly the tree
  // this check then rejected. Reuse that one canonical policy instead of a
  // second, divergent notion of materiality. Provider edits to real source stay
  // refused -- such paths are not excluded -- and untracked provider files still
  // fail, because only policy-excluded paths are dropped here.
  const offending = dirty
    .split('\n')
    .filter(line => line.length >= 4)
    .flatMap(line => {
      const pathText = line.slice(3);
      return pathText.includes(' -> ') ? pathText.split(' -> ') : [pathText];
    })
    .map(raw => raw.trim().replace(/^"(.*)"$/, '$1'))
    .filter(path => path.length > 0 && !isMaterialExcludedPath(path, scratch.cwd) && !scratch.readonlyLane?.binding.sourceRuntimeLinks.some(link => link.path === path));
  if (offending.length > 0) {
    throw new Error(`managed host run: managed-review scratch contains provider-created or modified material: ${offending.slice(0, 5).join(', ')}`);
  }
}

function pathsFor(root: string, runId: string): ManagedHostRunPaths {
  const dir = managedHostRunDirectory(root, runId);
  return {
    expectedRunId: runId,
    dir,
    spec: join(dir, 'spec.json'),
    owner: join(dir, 'owner.json'),
    capability: join(dir, 'input.cap'),
    prompt: join(dir, 'input.prompt'),
    environment: join(dir, 'input.env.json'),
    claim: join(dir, 'claim.json'),
    snapshot: join(dir, 'snapshot.json'),
    snapshotEventTransition: join(dir, 'snapshot-event-transition.json'),
    events: join(dir, 'events.jsonl'),
    output: join(dir, 'live-output.jsonl'),
    result: join(dir, 'result.json'),
    terminal: join(dir, 'terminal.json'),
    cancelRequest: join(dir, 'cancel-request.json'),
    workerLog: join(dir, 'worker.log'),
    evidenceProposal: join(dir, 'evidence-proposal.json'),
    evidenceBinding: join(dir, 'evidence-binding.json'),
    evidenceBindingSeal: join(dir, 'evidence-binding.seal.json'),
    scratchCleanupDiagnostic: join(dir, 'managed-review-scratch-cleanup-diagnostic.json'),
    initInvocationConsumption: join(dir, 'init-invocation-consumed.json'),
    claimLock: join(dir, 'claim.lock'),
    reconcileLock: join(dir, 'reconcile.lock'),
    terminalLock: join(dir, 'terminal.lock'),
  };
}

class ManagedReconcileBusyError extends Error {}

const managedReconcileQueues = new Map<string, Promise<void>>();

async function withManagedReconcileLock<T>(
  paths: ManagedHostRunPaths,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = managedReconcileQueues.get(paths.reconcileLock) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>(resolve => { releaseTurn = resolve; });
  const tail = previous.then(() => turn);
  managedReconcileQueues.set(paths.reconcileLock, tail);
  await previous;
  let lock: ReturnType<typeof acquireMkdirLock> | null = null;
  try {
    lock = acquireMkdirLock(paths.reconcileLock, {
      label: `managed reconcile ${paths.dir}`,
      deadlineMs: 5_000,
      staleMs: 2_000,
      pollMs: 10,
      requireHolderToken: true,
      classifyExistingLock: classifyManagedHostRunTerminalLock,
      holderInfo: {
        pid: process.pid,
        hostname: hostname(),
        command: `managed reconcile ${paths.dir}`,
        acquiredAt: new Date().toISOString(),
        lockId: randomUUID(),
        processStartTimeMs: currentProcessStartTimeMs(),
      },
    });
    return await fn();
  } catch (error) {
    if (lock === null && error instanceof Error
      && error.message.startsWith(`managed reconcile ${paths.dir} lock timeout after`)) {
      throw new ManagedReconcileBusyError(error.message, { cause: error });
    }
    throw error;
  } finally {
    lock?.release();
    releaseTurn();
    if (managedReconcileQueues.get(paths.reconcileLock) === tail) {
      managedReconcileQueues.delete(paths.reconcileLock);
    }
  }
}

export interface ManagedRuntimeReadBudget { remainingBytes: number; exhausted: boolean }
// Only synchronous observation scopes use this budget; normal execution has none.
let managedObservationBudget: ManagedRuntimeReadBudget | undefined;
/** Runtime authority reads must not follow links or block on a special file. */
function readManagedRuntimeText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const size = fstatSync(fd);
    if (!size.isFile() || size.size > MANAGED_RUN_DASHBOARD_POLICY.maxRuntimeArtifactBytes) throw new Error('managed runtime artifact is not a bounded regular file');
    if (managedObservationBudget) {
      if (size.size > managedObservationBudget.remainingBytes) { managedObservationBudget.exhausted = true; throw new Error('managed observation byte budget exhausted'); }
      managedObservationBudget.remainingBytes -= size.size;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, size.size + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      length += count;
      if (length > size.size) throw new Error('managed runtime artifact changed during read');
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { closeSync(fd); }
}

function readJson<T>(path: string): T {
  return JSON.parse(readManagedRuntimeText(path)) as T;
}

function assertArtifactRunId(
  paths: ManagedHostRunPaths,
  artifact: string,
  actualRunId: unknown,
): asserts actualRunId is string {
  if (actualRunId !== paths.expectedRunId) {
    throw new Error(
      `managed host run ${paths.expectedRunId}: ${artifact} runId binding mismatch`,
    );
  }
}

function readManagedHostRunSpec(paths: ManagedHostRunPaths): { text: string; value: ManagedHostRunSpec } {
  const text = readManagedRuntimeText(paths.spec);
  const value = JSON.parse(text) as ManagedHostRunSpec;
  assertArtifactRunId(paths, 'spec', value.runId);
  return { text, value };
}

function readManagedHostRunOwner(paths: ManagedHostRunPaths): ManagedHostRunOwner {
  const value = readJson<ManagedHostRunOwner>(paths.owner);
  assertArtifactRunId(paths, 'owner', value.runId);
  return value;
}

function readManagedHostRunSnapshot(paths: ManagedHostRunPaths): ManagedHostRunSnapshot {
  const value = readJson<ManagedHostRunSnapshot>(paths.snapshot);
  assertArtifactRunId(paths, 'snapshot', value.runId);
  return value;
}

interface ManagedHostRunOutputJournalCache {
  dev: number;
  ino: number;
  readBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  terminalLiveOutputDigest: string | null;
  terminalGeneration: number | null;
  frames: ManagedHostRunOutputFrame[];
  trailing: Buffer;
  monotonicSequences: boolean;
  lastSequence: number | null;
  lastAccessAt: number;
}

interface ManagedHostRunOutputJournalRead {
  frames: ManagedHostRunOutputFrame[];
  hasMore: boolean;
  retainedTruncated: boolean;
}

const MANAGED_HOST_RUN_OUTPUT_JOURNAL_CACHE_MAX_ENTRIES = 32;
const managedHostRunOutputJournalCache = new Map<string, ManagedHostRunOutputJournalCache>();

function readOutputJournalRange(
  path: string,
  position: number,
  length: number,
  onRead?: (bytes: number) => void,
): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, position + read);
      if (count <= 0) break;
      read += count;
    }
    if (read > 0) onRead?.(read);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function emptyManagedHostRunOutputJournalCache(args: {
  dev: number;
  ino: number;
  terminalLiveOutputDigest: string | null;
  terminalGeneration: number | null;
}): ManagedHostRunOutputJournalCache {
  return {
    ...args,
    readBytes: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    frames: [],
    trailing: Buffer.alloc(0),
    monotonicSequences: true,
    lastSequence: null,
    lastAccessAt: Date.now(),
  };
}

function appendManagedHostRunOutputJournalFrames(
  cache: ManagedHostRunOutputJournalCache,
  chunk: Buffer,
): void {
  const combined = cache.trailing.length > 0 ? Buffer.concat([cache.trailing, chunk]) : chunk;
  let lineStart = 0;
  while (true) {
    const lineEnd = combined.indexOf(0x0a, lineStart);
    if (lineEnd < 0) break;
    const line = combined.subarray(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line.length === 0) continue;
    try {
      const frame = JSON.parse(line.toString('utf8')) as ManagedHostRunOutputFrame;
      cache.frames.push(frame);
      if (!Number.isFinite(frame.sequence)
        || cache.lastSequence !== null
        && frame.sequence <= cache.lastSequence) {
        cache.monotonicSequences = false;
      }
      if (Number.isFinite(frame.sequence)) cache.lastSequence = frame.sequence;
    } catch {
      // Preserve the historic permissive reader behavior: corrupt individual
      // live frames are ignored; a terminal seal remains the authority fence.
    }
  }
  cache.trailing = combined.subarray(lineStart);
}

function retainManagedHostRunOutputJournalCache(path: string, cache: ManagedHostRunOutputJournalCache): void {
  cache.lastAccessAt = Date.now();
  managedHostRunOutputJournalCache.set(path, cache);
  if (managedHostRunOutputJournalCache.size <= MANAGED_HOST_RUN_OUTPUT_JOURNAL_CACHE_MAX_ENTRIES) return;
  let oldestPath: string | null = null;
  let oldestAccess = Number.POSITIVE_INFINITY;
  for (const [candidatePath, candidate] of managedHostRunOutputJournalCache) {
    if (candidate.lastAccessAt < oldestAccess) {
      oldestPath = candidatePath;
      oldestAccess = candidate.lastAccessAt;
    }
  }
  if (oldestPath) managedHostRunOutputJournalCache.delete(oldestPath);
}

/**
 * Read the retained JSONL journal incrementally. Foreground attachment drains
 * pages from one process, so once a stable file prefix is parsed we retain its
 * byte cursor and frame index; only an append suffix is parsed on later pages.
 * Shrink/replacement/same-size mutation inside the retained prefix or a
 * newly-sealed terminal invalidate the derived cache and safely rebuild from
 * the bounded retained prefix. Appends beyond that retention ceiling cannot
 * change the visible prefix and therefore remain cache hits.
 */
function readIncrementalManagedHostRunOutputJournal(args: {
  path: string;
  afterSequence: number;
  terminalLiveOutputDigest: string | null;
  terminalGeneration: number | null;
  onRead?: (bytes: number) => void;
}): ManagedHostRunOutputJournalRead {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(args.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      managedHostRunOutputJournalCache.delete(args.path);
      return { frames: [], hasMore: false, retainedTruncated: false };
    }
    throw error;
  }
  const retainedBytes = Math.min(stat.size, MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES);
  const cached = managedHostRunOutputJournalCache.get(args.path);
  const stableIdentity = cached
    && cached.dev === stat.dev
    && cached.ino === stat.ino
    && cached.terminalLiveOutputDigest === args.terminalLiveOutputDigest
    && cached.terminalGeneration === args.terminalGeneration;
  const requiresRebuild = !stableIdentity
    || retainedBytes < cached.readBytes
    || (retainedBytes === cached.readBytes
      && stat.size <= MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES
      && (cached.mtimeMs !== stat.mtimeMs || cached.ctimeMs !== stat.ctimeMs));
  const cache = requiresRebuild
    ? emptyManagedHostRunOutputJournalCache({
      dev: stat.dev,
      ino: stat.ino,
      terminalLiveOutputDigest: args.terminalLiveOutputDigest,
      terminalGeneration: args.terminalGeneration,
    })
    : cached;
  if (retainedBytes > cache.readBytes) {
    appendManagedHostRunOutputJournalFrames(
      cache,
      readOutputJournalRange(args.path, cache.readBytes, retainedBytes - cache.readBytes, args.onRead),
    );
    cache.readBytes = retainedBytes;
  }
  cache.mtimeMs = stat.mtimeMs;
  cache.ctimeMs = stat.ctimeMs;
  retainManagedHostRunOutputJournalCache(args.path, cache);

  if (!cache.monotonicSequences) {
    const matchingFrames = cache.frames.filter(frame => frame.sequence > args.afterSequence);
    return {
      frames: matchingFrames.slice(0, MANAGED_HOST_RUN_OUTPUT_READ_MAX_FRAMES),
      hasMore: matchingFrames.length > MANAGED_HOST_RUN_OUTPUT_READ_MAX_FRAMES,
      retainedTruncated: stat.size > MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES,
    };
  }
  let low = 0;
  let high = cache.frames.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (cache.frames[middle]!.sequence > args.afterSequence) high = middle;
    else low = middle + 1;
  }
  return {
    frames: cache.frames.slice(low, low + MANAGED_HOST_RUN_OUTPUT_READ_MAX_FRAMES),
    hasMore: cache.frames.length > low + MANAGED_HOST_RUN_OUTPUT_READ_MAX_FRAMES,
    retainedTruncated: stat.size > MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES,
  };
}

function atomicWrite(path: string, value: unknown, mode = 0o600): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(temp, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode, flag: 'wx' });
  renameSync(temp, path);
  chmodSync(path, mode);
}

function writeExclusive(path: string, value: unknown, mode = 0o600): boolean {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temp, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode, flag: 'wx' });
    chmodSync(temp, mode);
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    unlinkIfPresent(temp);
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * The worker must erase every one-shot input before publishing any terminal
 * outcome that can no longer launch a provider. Keep this as one operation so
 * pre-intake failures cannot accidentally sit outside the intake try/finally.
 */
function eraseManagedHostRunOneShotInputs(paths: ManagedHostRunPaths): void {
  unlinkIfPresent(paths.capability);
  unlinkIfPresent(paths.prompt);
  unlinkIfPresent(paths.environment);
}

function withTerminalAuthorityLock<T>(paths: ManagedHostRunPaths, fn: () => T): T {
  return withMkdirLock(paths.terminalLock, fn, {
    label: `managed terminal ${paths.dir}`,
    deadlineMs: 5_000,
    staleMs: 2_000,
    pollMs: 10,
    requireHolderToken: true,
    classifyExistingLock: classifyManagedHostRunTerminalLock,
    holderInfo: {
      pid: process.pid,
      hostname: hostname(),
      command: `managed terminal ${paths.dir}`,
      acquiredAt: new Date().toISOString(),
      lockId: randomUUID(),
      processStartTimeMs: currentProcessStartTimeMs(),
    },
  });
}

function appendEvent(paths: ManagedHostRunPaths, event: ManagedHostRunEvent): boolean {
  assertArtifactRunId(paths, 'event', event.runId);
  return withTerminalAuthorityLock(paths, () => {
    if (readTerminal(paths)) return false;
    appendFileSync(paths.events, `${canonicalJson(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  });
}

function readCancelRequest(paths: ManagedHostRunPaths): ManagedHostRunCancelRequest | null {
  if (!existsSync(paths.cancelRequest)) return null;
  const value = readJson<ManagedHostRunCancelRequest>(paths.cancelRequest);
  assertArtifactRunId(paths, 'cancel request', value.runId);
  return value;
}

function readTerminal(paths: ManagedHostRunPaths): ManagedHostRunTerminal | null {
  if (!existsSync(paths.terminal)) return null;
  const value = readJson<ManagedHostRunTerminal>(paths.terminal);
  assertArtifactRunId(paths, 'terminal', value.runId);
  return value;
}

/**
 * Managed Claude prompt transport intentionally lives under the provider cwd
 * rather than the durable host-runs directory, because Claude's sandbox cannot
 * read an OS-temp path.  Bind that private leaf to the sealed spec runId and
 * remove only that exact leaf after terminal ownership is established.  A
 * worker SIGKILL bypasses runHostRun's local finally; the next reconciliation
 * terminal therefore has the same one-shot cleanup duty.
 */
function cleanupManagedClaudePromptForTerminal(paths: ManagedHostRunPaths): void {
  const { text: specText, value: spec } = readManagedHostRunSpec(paths);
  if (!isIsolatedReviewerProfile(spec.profile) || spec.host !== 'claude') return;

  const owner = readManagedHostRunOwner(paths);
  if (
    spec.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
    || spec.runId !== owner.runId
    || owner.specDigest !== sha256(specText)
  ) {
    throw new Error(`managed host run ${spec.runId}: refuse external prompt cleanup without sealed spec ownership`);
  }

  const promptDir = managedClaudePromptDirectoryForRun(spec.cwd, spec.runId);
  // The path is derived only from the sealed run spec and canonical fixed
  // suffix. rmSync therefore cannot follow a caller-supplied artifact path or
  // sweep unrelated reviewer prompts. Removal is idempotent for the ordinary
  // in-process finally, which normally wins this race.
  rmSync(promptDir, { recursive: true, force: true });
}

function terminalAllowsManagedReviewScratchCleanup(terminal: ManagedHostRunTerminal): boolean {
  return terminal.replacementSafe
    && terminal.processCleanup !== null
    && terminal.processCleanup.reaped
    && !terminal.processCleanup.residualProcessGroup;
}

function boundedCleanupDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function managedDispatchInvocationConsumptionIsValid(input: {
  root: string;
  storyId: string;
  agentType: string;
  runId: string;
}): boolean {
  try {
    const paths = pathsFor(input.root, input.runId);
    if (!existsSync(paths.initInvocationConsumption)) return false;
    const record = readJson<{
      schemaVersion: string;
      runId: string;
      storyId: string;
      providerAgent: string;
      consumedAt: string;
      invocationNonce?: string;
      attestation?: ManagedInitInvocationAttestation;
      providerIdentity?: HostRunProcessIdentity;
      caller?: ManagedHostRunProcessGroupRow;
    }>(paths.initInvocationConsumption);
    const owner = readManagedHostRunOwner(paths);
    const spec = readManagedHostRunSpec(paths).value;
    const common = record.runId === input.runId
      && record.storyId === input.storyId
      && record.providerAgent === input.agentType
      && Number.isFinite(Date.parse(record.consumedAt));
    if (!common) return false;
    if (record.schemaVersion === 'lattice.managed_dispatch_process_group_consumption.v1') {
      const snapshotIdentity = readManagedHostRunSnapshot(paths).providerIdentity;
      return !!snapshotIdentity
        && record.providerIdentity !== undefined
        && canonicalJson(record.providerIdentity) === canonicalJson(snapshotIdentity)
        && record.caller?.pgid === snapshotIdentity.pgid
        && record.caller.pid > 0
        && typeof record.caller.start === 'string'
        && record.caller.start.length > 0;
    }
    if (record.schemaVersion !== 'lattice.managed_dispatch_invocation_consumption.v2'
      || !record.attestation || !record.invocationNonce) return false;
    const attestation = record.attestation;
    const { signature, ...claims } = attestation;
    return record.invocationNonce === attestation.invocationNonce
      && attestation.runId === input.runId
      && attestation.storyId === input.storyId
      && attestation.providerAgent === input.agentType
      && attestation.expiresAt === spec.deadlineAt
      && typeof owner.proposalInvocationPublicKey === 'string'
      && verifyCanonical(claims, signature, owner.proposalInvocationPublicKey);
  } catch {
    return false;
  }
}

export function managedDispatchOutputValidation(input: {
  root: string;
  storyId: string | null;
  agentType: string;
  runId: string;
}): { failureReason: string | null; outputDigest: string | null } {
  if (!input.storyId) return { failureReason: 'managed_dispatch_story_missing', outputDigest: null };
  try {
    const storyStore = new StoryStore(input.root);
    if (input.agentType === MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.role) {
      const data = storyStore.readDeliveryCheck(input.storyId);
      if (!data || data.managedDeliveryRunId !== input.runId) {
        return { failureReason: 'managed_dispatch_output_missing', outputDigest: null };
      }
      if (data.storyId !== input.storyId || data.nativeEvidenceBinding
        || data._hash !== recomputeDeliveryCheckHash(input.storyId, storyStore)) {
        return { failureReason: 'managed_dispatch_output_invalid', outputDigest: null };
      }
      return managedDispatchInvocationConsumptionIsValid({ ...input, storyId: input.storyId })
        ? { failureReason: null, outputDigest: digestFile(storyStore.storyFilePath(input.storyId, MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.artifact)) }
        : { failureReason: 'managed_dispatch_invocation_unconsumed', outputDigest: null };
    }
    if (input.agentType === 'proof-or-stop-review-scope-plan') {
      const scopePath = storyStore.storyFilePath(input.storyId, 'scope-check.json');
      if (!existsSync(scopePath)) return { failureReason: 'managed_dispatch_output_missing', outputDigest: null };
      const scopeText = readFileSync(scopePath, 'utf8');
      const scopeCheck = JSON.parse(scopeText) as import('./types.js').ScopeCheckData;
      if (scopeCheck && !verifyScopeCheckContentSignature(input.storyId, scopeCheck)) {
        return { failureReason: 'managed_dispatch_output_invalid', outputDigest: null };
      }
      if (scopeCheck?.deliveryRunId !== input.runId) {
        return { failureReason: 'managed_dispatch_output_missing', outputDigest: null };
      }
      return managedDispatchInvocationConsumptionIsValid({ ...input, storyId: input.storyId })
        ? { failureReason: null, outputDigest: sha256(scopeText) }
        : { failureReason: 'managed_dispatch_invocation_unconsumed', outputDigest: null };
    }
    const configuredInitCheckPath = storyStore.storyFilePath(input.storyId, 'init-check.json');
    const initCheck = existsSync(configuredInitCheckPath)
      ? JSON.parse(readFileSync(configuredInitCheckPath, 'utf8')) as InitCheckData
      : null;
    if (initCheck && !initCheckSignatureIsValid(input.storyId, storyStore, input.root, initCheck)) {
      return { failureReason: 'managed_dispatch_output_invalid', outputDigest: null };
    }
    const outputPresent = Array.isArray(initCheck?.agentResults)
      && initCheck.agentResults.some(row =>
        row.agentId === input.agentType && row.deliveryRunId === input.runId);
    if (!outputPresent) return { failureReason: 'managed_dispatch_output_missing', outputDigest: null };
    return managedDispatchInvocationConsumptionIsValid({ ...input, storyId: input.storyId })
      ? { failureReason: null, outputDigest: null }
      : { failureReason: 'managed_dispatch_invocation_unconsumed', outputDigest: null };
  } catch (error) {
    return { failureReason: `managed_dispatch_output_unreadable:${boundedCleanupDiagnosticError(error)}`, outputDigest: null };
  }
}

export function managedDispatchOutputFailureReason(input: {
  root: string;
  storyId: string | null;
  agentType: string;
  runId: string;
}): string | null {
  return managedDispatchOutputValidation(input).failureReason;
}

function readManagedReviewScratchCleanupDiagnostic(
  paths: ManagedHostRunPaths,
): ManagedReviewScratchCleanupDiagnostic | null {
  if (!existsSync(paths.scratchCleanupDiagnostic)) return null;
  let diagnostic: ManagedReviewScratchCleanupDiagnostic;
  try {
    diagnostic = readJson<ManagedReviewScratchCleanupDiagnostic>(paths.scratchCleanupDiagnostic);
  } catch {
    // A failed exclusive diagnostic write can leave an attacker-/filesystem-
    // supplied non-file at this auxiliary path. The terminal remains the
    // authority; the corresponding persistence failure is already in health.
    return null;
  }
  if (
    diagnostic.schemaVersion !== 'lattice.managed_review_scratch_cleanup_diagnostic.v1'
    || diagnostic.runId !== paths.expectedRunId
    || !['terminal', 'submit_artifact_setup', 'submit_input_setup'].includes(diagnostic.stage)
    || typeof diagnostic.recordedAt !== 'string'
    || typeof diagnostic.error !== 'string'
    || diagnostic.error.length === 0
    || diagnostic.error.length > 2_000
  ) {
    throw new Error(`managed host run ${paths.expectedRunId}: scratch cleanup diagnostic is malformed`);
  }
  return diagnostic;
}

/**
 * Preserve the first failed cleanup attempt. A later terminal/reconcile retry
 * may remove the scratch and clear this marker, but must not rewrite the
 * already-sealed terminal to claim a different provider outcome.
 */
function recordManagedReviewScratchCleanupFailure(
  paths: ManagedHostRunPaths,
  stage: ManagedReviewScratchCleanupStage,
  error: unknown,
): void {
  const diagnostic: ManagedReviewScratchCleanupDiagnostic = {
    schemaVersion: 'lattice.managed_review_scratch_cleanup_diagnostic.v1',
    runId: paths.expectedRunId,
    stage,
    recordedAt: new Date().toISOString(),
    error: boundedCleanupDiagnosticError(error),
  };
  try {
    // Only a readable, identity-valid prior diagnostic is an idempotent retry.
    // EEXIST can also mean a directory or malformed file prevented persistence.
    if (!writeExclusive(paths.scratchCleanupDiagnostic, diagnostic)) {
      if (!readManagedReviewScratchCleanupDiagnostic(paths)) throw new Error('Existing scratch cleanup diagnostic path is not a valid diagnostic');
      return;
    }
  } catch (persistenceError) {
    // The terminal outcome stays authoritative even if the filesystem cannot
    // preserve an auxiliary cleanup marker. Never let observability writes
    // mutate or invalidate that terminal, but do surface a genuine thrown
    // filesystem error through doctor's durable health channel.
    reportHealthIssue(
      'persist:managedReviewScratchCleanupDiagnostic',
      persistenceError instanceof Error ? persistenceError : new Error(String(persistenceError)),
      {
        runId: paths.expectedRunId,
        stage,
        cleanupError: diagnostic.error,
      },
    );
  }
}

function clearManagedReviewScratchCleanupDiagnostic(paths: ManagedHostRunPaths): void {
  unlinkIfPresent(paths.scratchCleanupDiagnostic);
}

function cleanupManagedReviewScratchForSubmitFailure(
  paths: ManagedHostRunPaths,
  scratch: ManagedReviewScratchWorktree,
  stage: Extract<ManagedReviewScratchCleanupStage, 'submit_artifact_setup' | 'submit_input_setup'>,
): boolean {
  try {
    cleanupManagedReviewScratchWorktree(scratch.root, scratch);
    clearManagedReviewScratchCleanupDiagnostic(paths);
    return true;
  } catch (error) {
    recordManagedReviewScratchCleanupFailure(paths, stage, error);
    return false;
  }
}

/**
 * The detached scratch is retained while a terminal is unsafe/reclaimable. A
 * sealed terminal proves cleanup only when it explicitly records a reaped,
 * residual-free provider group; cleanup errors stay non-destructive and leave
 * the exact marker-bound scratch for a later safe retry.
 */
function cleanupManagedReviewScratchForTerminal(
  paths: ManagedHostRunPaths,
  terminal: ManagedHostRunTerminal,
): boolean {
  if (!terminalAllowsManagedReviewScratchCleanup(terminal)) return false;
  try {
    const spec = readManagedHostRunSpec(paths).value;
    if (!spec.managedReviewScratch) return true;
    cleanupManagedReviewScratchWorktree(spec.root, spec.managedReviewScratch);
    clearManagedReviewScratchCleanupDiagnostic(paths);
    return true;
  } catch (error) {
    // terminal.json remains the authority. Do not turn a post-terminal scratch
    // cleanup retry into a contradictory provider result or broaden deletion.
    recordManagedReviewScratchCleanupFailure(paths, 'terminal', error);
    return false;
  }
}

function digestFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256(readManagedRuntimeText(path));
}

function isSealedProcessEnvironment(value: unknown): value is NodeJS.ProcessEnv {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string');
}

function isManagedHostRunReceiptArchiveSchema(
  value: string,
): value is typeof MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V1 | typeof MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V2 {
  return value === MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V1 || value === MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V2;
}

function archivedBindingProjection(
  archive: ManagedHostRunReceiptArchive,
  runId: string,
): ManagedHostRunBindingProjection {
  if (!archive.binding || archive.binding.runId !== runId) {
    throw new Error(
      `managed host run ${runId}: run directory was reclaimed by terminal retention and the archive predates `
      + 'binding capture, so the evidence binding cannot be reconstructed',
    );
  }
  const digest = archive.receipt?.bindingProjectionDigest;
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new Error(
      `managed host run ${runId}: archived binding is not digest-bound`,
    );
  }
  if (bindingProjectionDigestOf(archive.binding) !== digest) {
    throw new Error(
      `managed host run ${runId}: archived binding does not match receipt bindingProjectionDigest`,
    );
  }
  return archive.binding;
}

function liveBindingProjection(paths: ManagedHostRunPaths): ManagedHostRunBindingProjection {
  const spec = readManagedHostRunSpec(paths).value;
  const owner = readManagedHostRunOwner(paths);
  return {
    runId: spec.runId,
    host: spec.host,
    ...(Object.prototype.hasOwnProperty.call(spec, 'model') ? { model: spec.model ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(spec, 'reasoningEffort')
      ? { reasoningEffort: spec.reasoningEffort ?? null } : {}),
    storyId: spec.storyId,
    phase: spec.phase,
    agentType: spec.agentType,
    reviewRunId: spec.reviewRunId,
    lane: spec.lane,
    cwd: spec.cwd,
    deadlineAt: spec.deadlineAt,
    timeoutMs: spec.timeoutMs,
    projectRootHash: spec.projectRootHash,
    profile: spec.profile,
    promptDigest: owner.promptDigest,
    reviewBinding: spec.reviewBinding ?? null,
    ...(spec.acceptanceReviewBinding ? { acceptanceReviewBinding: spec.acceptanceReviewBinding } : {}),
  };
}

function bindingProjectionDigestOf(binding: ManagedHostRunBindingProjection): string {
  return sha256(canonicalJson(binding));
}

function receiptPayloadFor(paths: ManagedHostRunPaths, terminal: ManagedHostRunTerminal): ManagedHostRunReceipt {
  assertArtifactRunId(paths, 'terminal', terminal.runId);
  const binding = liveBindingProjection(paths);
  const payload = {
    schemaVersion: 'lattice.managed_host_run_receipt.v1' as const,
    runId: terminal.runId,
    ...(Object.prototype.hasOwnProperty.call(binding, 'model') ? { model: binding.model ?? null } : {}),
    ...(Object.prototype.hasOwnProperty.call(binding, 'reasoningEffort')
      ? { reasoningEffort: binding.reasoningEffort ?? null } : {}),
    terminalDigest: sha256(readManagedRuntimeText(paths.terminal)),
    state: terminal.state,
    specDigest: terminal.specDigest,
    bindingProjectionDigest: bindingProjectionDigestOf(binding),
    resultDigest: terminal.resultDigest,
    eventJournalDigest: terminal.eventJournalDigest,
    liveOutputDigest: terminal.liveOutputDigest,
    ...(terminal.stdoutDigest ? { stdoutDigest: terminal.stdoutDigest } : {}),
    evidenceProposalDigest: terminal.evidenceProposalDigest,
    ...(terminal.managedDispatchOutputDigest
      ? { managedDispatchOutputDigest: terminal.managedDispatchOutputDigest }
      : {}),
    replacementSafe: terminal.replacementSafe,
    processCleanup: terminal.processCleanup,
    terminalAt: terminal.terminalAt,
  };
  return { ...payload, receiptId: sha256(canonicalJson(payload)) };
}

/**
 * A binding can survive a crash after its exclusive write but before its
 * companion seal write. It is recoverable only when it already binds the
 * immutable terminal receipt exactly; no partial artifact is REVIEW evidence
 * until the seal exists and readManagedReviewImportSeal admits the pair.
 */
function isRecoverableManagedReviewImportBinding(
  paths: ManagedHostRunPaths,
  terminal: ManagedHostRunTerminal,
): boolean {
  try {
    const binding = readJson<Record<string, unknown>>(paths.evidenceBinding);
    const receipt = receiptPayloadFor(paths, terminal);
    return binding.schemaVersion === 'lattice.managed_review_evidence_import.v1'
      && binding.runId === paths.expectedRunId
      && binding.receiptId === receipt.receiptId
      && typeof binding.storyId === 'string'
      && typeof binding.reviewRunId === 'string'
      && typeof binding.lane === 'string'
      && typeof binding.importedAt === 'string'
      && Array.isArray(binding.importedIds)
      && binding.importedIds.length > 0
      && binding.importedIds.every(value => typeof value === 'string' && value.length > 0);
  } catch {
    return false;
  }
}

function assertSealedManagedHostRunArtifacts(paths: ManagedHostRunPaths, terminal: ManagedHostRunTerminal): void {
  const mismatches: string[] = [];
  assertArtifactRunId(paths, 'terminal', terminal.runId);
  readManagedHostRunSpec(paths);
  if (digestFile(paths.spec) !== terminal.specDigest) mismatches.push('spec');
  if (digestFile(paths.result) !== terminal.resultDigest) mismatches.push('result');
  if ((digestFile(paths.events) ?? sha256('')) !== terminal.eventJournalDigest) mismatches.push('events');
  if (digestFile(paths.output) !== terminal.liveOutputDigest) mismatches.push('live-output');
  if (digestFile(paths.evidenceProposal) !== terminal.evidenceProposalDigest) mismatches.push('proposal');
  if (terminal.managedDispatchOutputDigest) {
    const spec = readManagedHostRunSpec(paths).value;
    // Delivery receipts describe a historical run. A later delivery review may
    // replace the live Story report; only its evidence consumer compares that
    // live file with this sealed digest. Preserve the existing scope contract.
    if (spec.agentType !== MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.role) {
      const currentOutputDigest = spec.profile === 'managed_dispatch'
        && spec.agentType === 'proof-or-stop-review-scope-plan' && spec.storyId
        ? digestFile(new StoryStore(spec.root).storyFilePath(spec.storyId, 'scope-check.json')) : null;
      if (currentOutputDigest !== terminal.managedDispatchOutputDigest) mismatches.push('managed-dispatch-output');
    }
  }
  const hasEvidenceBinding = existsSync(paths.evidenceBinding);
  const hasEvidenceBindingSeal = existsSync(paths.evidenceBindingSeal);
  if (!hasEvidenceBinding && hasEvidenceBindingSeal) {
    mismatches.push('binding');
  } else if (hasEvidenceBinding) {
    try {
      if (!isRecoverableManagedReviewImportBinding(paths, terminal)) {
        mismatches.push('binding');
      } else if (hasEvidenceBindingSeal) {
        const seal = readJson<Record<string, unknown>>(paths.evidenceBindingSeal);
        if (seal.schemaVersion !== 'lattice.managed_review_evidence_binding_seal.v1'
          || seal.runId !== paths.expectedRunId
          || seal.bindingDigest !== digestFile(paths.evidenceBinding)) {
          mismatches.push('binding');
        }
      }
    } catch {
      mismatches.push('binding');
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`managed host run ${terminal.runId}: sealed artifact digest mismatch (${[...new Set(mismatches)].join(',')})`);
  }
}

function pidAlive(pid: number | null): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Bounded read-only history sampling happens once, never in status/heartbeat polling. */
function captureManagedRunDurationEstimate(args: ManagedHostRunSubmitArgs, createdAt: string): ManagedRunDurationEstimate {
  const policy = MANAGED_DURATION_ESTIMATE_POLICY;
  const samples: ManagedRunDurationSample[] = [];
  const started = performance.now();
  let remainingBytes = policy.maxCandidateArtifactBytes as number;
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    directory = opendirSync(managedHostRunsRoot(args.root));
    for (let index=0; index<policy.maxDirectoryEntries && performance.now()-started<policy.scanTargetMs; index++) {
      const entry=directory.readSync(); if (!entry) break;
      if (!entry.isDirectory()) continue;
      try {
        const paths=pathsFor(args.root,entry.name);
        const files=[paths.spec,paths.owner,paths.snapshot,paths.terminal,paths.result,paths.events,
          paths.output,paths.evidenceProposal,paths.evidenceBinding,paths.evidenceBindingSeal];
        let bytes=0;
        for (const path of files) {
          if (!existsSync(path)) continue;
          const stat=lstatSync(path);
          if (!stat.isFile() || stat.size>policy.maxArtifactBytes) throw new Error('history artifact exceeds bounded read policy');
          bytes+=stat.size;
        }
        if (bytes>remainingBytes) continue;
        remainingBytes-=bytes;
        const spec=readManagedHostRunSpec(paths).value;
        if (spec.host!==args.host || spec.phase!==args.phase || spec.agentType!==args.agentType
          || spec.profile!==(args.profile??null) || spec.lane!==(args.lane??null)) continue;
        const terminal=readTerminal(paths);
        if (!terminal || terminal.state!=='completed' || !terminal.replacementSafe) continue;
        // Full current artifact bindings must hold; partial/tampered/censored runs are not samples.
        assertSealedManagedHostRunArtifacts(paths,terminal);
        const owner=readManagedHostRunOwner(paths);
        if (owner.specDigest!==terminal.specDigest) continue;
        const snapshot=readManagedHostRunSnapshot(paths);
        if (snapshot.state!==terminal.state || snapshot.generation!==terminal.generation) continue;
        samples.push({runId:spec.runId,durationMs:Date.parse(terminal.terminalAt)-Date.parse(spec.createdAt),terminalAt:terminal.terminalAt});
      } catch { /* A malformed or concurrently reclaimed sample never changes the run's authority. */ }
    }
  } catch { /* History is optional diagnostics; an empty sample yields unavailable, never an invented ETA. */ }
  finally { try { directory?.closeSync(); } catch { /* Optional diagnostics cannot fail submission. */ } }
  return estimateManagedRunDuration(samples,createdAt);
}

function projectionFor(paths: ManagedHostRunPaths): ManagedHostRunProjection {
  if (existsSync(paths.snapshotEventTransition)) {
    throw new Error(`managed host run ${paths.expectedRunId}: snapshot/event recovery pending; supervisor recovery required`);
  }
  const { text: specText, value: spec } = readManagedHostRunSpec(paths);
  if (!existsSync(paths.owner)) {
    throw new Error(`managed host run ${paths.expectedRunId}: partial runtime: owner.json missing`);
  }
  const owner = readManagedHostRunOwner(paths);
  const snapshot = readManagedHostRunSnapshot(paths);
  const terminal = readTerminal(paths);
  // Once terminal.json is sealed, late/corrupt control requests are not part of
  // the immutable result authority and cannot make a valid terminal unreadable.
  const cancel = terminal ? null : readCancelRequest(paths);
  if (
    spec.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
    || owner.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
    || snapshot.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
    || owner.runId !== paths.expectedRunId
    || snapshot.runId !== paths.expectedRunId
    || owner.specDigest !== sha256(specText)
  ) {
    throw new Error(`managed host run ${spec.runId}: partial runtime: immutable spec/owner/snapshot binding mismatch`);
  }
  const snapshotIsTerminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(snapshot.state);
  if (snapshotIsTerminal && !terminal) {
    throw new Error(`managed host run ${spec.runId}: partial runtime: terminal.json missing for terminal snapshot`);
  }
  if (
    terminal
    && (
      terminal.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
      || terminal.runId !== spec.runId
      || (snapshotIsTerminal && terminal.state !== snapshot.state)
      || (!snapshotIsTerminal && terminal.generation !== snapshot.generation + 1)
    )
  ) {
    throw new Error(`managed host run ${spec.runId}: partial runtime: terminal/snapshot binding mismatch`);
  }
  if (terminal) assertSealedManagedHostRunArtifacts(paths, terminal);
  return {
    schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
    runId: spec.runId,
    host: spec.host,
    model: spec.model ?? null,
    reasoningEffort: spec.reasoningEffort ?? null,
    storyId: spec.storyId,
    phase: spec.phase,
    agentType: spec.agentType,
    reviewRunId: spec.reviewRunId,
    lane: spec.lane,
    profile: spec.profile,
    state: terminal?.state ?? snapshot.state,
    generation: terminal?.generation ?? snapshot.generation,
    durationEstimate: spec.durationEstimate ?? {kind:'unavailable',source:'bounded-local-completed-runs',sampleCount:0,reason:'legacy-run-without-estimate'},
    stage: managedRunStage({terminal:terminal !== null,state:snapshot.state,
      providerStarted:snapshot.providerIdentity !== null,providerClosed:!!snapshot.providerClosedAt}),
    supervisionDiagnostic: terminal ? null : snapshot.supervisionDiagnostic ?? null,
    providerClosedAt: snapshot.providerClosedAt ?? null,
    createdAt: spec.createdAt,
    deadlineAt: spec.deadlineAt,
    workerPid: snapshot.workerPid,
    workerHeartbeatAt: snapshot.workerHeartbeatAt,
    lastProviderProgressAt: snapshot.lastProviderProgressAt,
    providerProgressMode: snapshot.providerProgressMode,
    cancelRequestedAt: cancel?.requestedAt ?? null,
    replacementSafe: terminal?.replacementSafe ?? snapshot.replacementSafe,
    managedReviewScratchCleanupDiagnostic: readManagedReviewScratchCleanupDiagnostic(paths),
    terminal,
  };
}

/** Read-only, fully bound projection for host-neutral owner/UI consumers. */
export function readManagedHostRunProjection(root: string, runId: string, budget?: ManagedRuntimeReadBudget): ManagedHostRunProjection & { terminalDigest: string | null } {
  const previous = managedObservationBudget;
  managedObservationBudget = budget;
  try {
    const run = projectionFor(pathsFor(root, runId));
    // Identity of already validated terminal content, not a new signature or PASS.
    return { ...run, terminalDigest: run.terminal ? sha256(`${canonicalJson(run.terminal)}\n`) : null };
  } finally { managedObservationBudget = previous; }
}

/** Recovery and its observation share the worker's transaction lock. */
function recoverAndProjectManagedHostRun(paths: ManagedHostRunPaths): ManagedHostRunProjection {
  return withTerminalAuthorityLock(paths, () => {
    recoverPendingSnapshotEventTransitionUnlocked(paths);
    return projectionFor(paths);
  });
}

function updateSnapshotUnlocked(
  paths: ManagedHostRunPaths,
  update: (current: ManagedHostRunSnapshot) => ManagedHostRunSnapshot,
): ManagedHostRunSnapshot {
  const current = readManagedHostRunSnapshot(paths);
  const next = update(current);
  assertArtifactRunId(paths, 'snapshot', next.runId);
  atomicWrite(paths.snapshot, next);
  return next;
}

/** Every non-terminal snapshot RMW is serialized with terminal sealing. */
function updateSnapshot(
  paths: ManagedHostRunPaths,
  update: (current: ManagedHostRunSnapshot) => ManagedHostRunSnapshot,
): ManagedHostRunSnapshot {
  return withTerminalAuthorityLock(paths, () => {
    const current = readManagedHostRunSnapshot(paths);
    if (readTerminal(paths)) return current;
    return updateSnapshotUnlocked(paths, update);
  });
}

/**
 * A state transition which has a corresponding lifecycle event must publish
 * both under the same terminal authority lock. Otherwise a terminal writer can
 * observe the incremented snapshot generation between separate lock
 * acquisitions and seal the journal before its causal event is appended.
 */
function updateSnapshotAndAppendEvent(
  paths: ManagedHostRunPaths,
  update: (current: ManagedHostRunSnapshot) => ManagedHostRunSnapshot | null,
  event: ManagedHostRunEvent,
): boolean {
  assertArtifactRunId(paths, 'event', event.runId);
  return withTerminalAuthorityLock(paths, () => {
    recoverPendingSnapshotEventTransitionUnlocked(paths);
    const current = readManagedHostRunSnapshot(paths);
    if (readTerminal(paths)) return false;
    const next = update(current);
    if (!next) return false;
    assertArtifactRunId(paths, 'snapshot', next.runId);
    atomicWrite(paths.snapshotEventTransition, {
      schemaVersion: 'lattice.managed_host_run_snapshot_event_transition.v1',
      runId: paths.expectedRunId,
      snapshot: next,
      event,
    } satisfies ManagedHostRunSnapshotEventTransition);
    atomicWrite(paths.snapshot, next);
    appendFileSync(paths.events, `${canonicalJson(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    unlinkIfPresent(paths.snapshotEventTransition);
    return true;
  });
}

function recoverPendingSnapshotEventTransitionUnlocked(paths: ManagedHostRunPaths): void {
  if (!existsSync(paths.snapshotEventTransition)) return;
  if (readTerminal(paths)) {
    throw new Error(`managed host run ${paths.expectedRunId}: terminal sealed with an unrecovered snapshot/event transition`);
  }
  const transition = readJson<ManagedHostRunSnapshotEventTransition>(paths.snapshotEventTransition);
  if (
    transition.schemaVersion !== 'lattice.managed_host_run_snapshot_event_transition.v1'
    || transition.runId !== paths.expectedRunId
    || transition.snapshot.runId !== paths.expectedRunId
    || transition.event.runId !== paths.expectedRunId
  ) {
    throw new Error(`managed host run ${paths.expectedRunId}: snapshot/event transition binding mismatch`);
  }
  const current = readManagedHostRunSnapshot(paths);
  if (current.generation > transition.snapshot.generation) {
    throw new Error(`managed host run ${paths.expectedRunId}: snapshot/event transition generation regressed`);
  }
  if (current.generation === transition.snapshot.generation) {
    if (canonicalJson(current) !== canonicalJson(transition.snapshot)) {
      throw new Error(`managed host run ${paths.expectedRunId}: snapshot/event transition snapshot mismatch`);
    }
  } else {
    atomicWrite(paths.snapshot, transition.snapshot);
  }
  const eventLine = canonicalJson(transition.event);
  const existingEvents = existsSync(paths.events) ? readFileSync(paths.events, 'utf8') : '';
  if (!existingEvents.split('\n').some(line => line === eventLine)) {
    appendFileSync(paths.events, `${eventLine}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  unlinkIfPresent(paths.snapshotEventTransition);
}

/** Complete a crash-interrupted snapshot/event transaction before any reader exposes it. */
function recoverPendingSnapshotEventTransition(paths: ManagedHostRunPaths): void {
  if (!existsSync(paths.snapshotEventTransition)) return;
  withTerminalAuthorityLock(paths, () => recoverPendingSnapshotEventTransitionUnlocked(paths));
}

function currentProcessStartTimeMs(): number {
  return Math.floor(Date.now() - process.uptime() * 1_000);
}

function processStartTimeMsForPid(pid: number): number | null {
  if (pid === process.pid) return currentProcessStartTimeMs();
  if (process.platform === 'win32') return null;
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameProcessStart(left: number | undefined, right: number | null): boolean {
  if (left === undefined || right === null) return true;
  return Math.abs(left - right) <= 2_000;
}

/** A terminal writer may legitimately outlive staleMs; PID reuse is fenced by process start time. */
function classifyManagedHostRunTerminalLock(snapshot: ExistingMkdirLockSnapshot): ExistingMkdirLockState {
  const holder = snapshot.holder;
  if (!holder || holder.hostname !== hostname()) return 'unknown';
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return 'unknown';
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'stale';
    if (code !== 'EPERM') return 'unknown';
  }
  const observedStart = processStartTimeMsForPid(holder.pid);
  if (!sameProcessStart(holder.processStartTimeMs, observedStart)) return 'stale';
  // A live PID with an unobservable start time is conservatively active. The
  // bounded acquisition deadline reports contention instead of stealing it.
  return 'active';
}

function writeTerminal(
  paths: ManagedHostRunPaths,
  state: ManagedHostRunTerminalState,
  reason: string,
  replacementSafe: boolean,
  result: HostRunResult | null,
  now: number,
  cleanupOverride?: HostRunProcessCleanup,
  managedDispatchOutputDigest?: string | null,
): ManagedHostRunTerminal {
  const terminal = withTerminalAuthorityLock(paths, () => {
    recoverPendingSnapshotEventTransitionUnlocked(paths);
    const existing = readTerminal(paths);
    if (existing) {
      cleanupManagedClaudePromptForTerminal(paths);
      return existing;
    }

    // The durable terminal is authoritative over a provider-local result. A
    // provider can return zero and then lose to a post-result cancellation or
    // managed-review validation failure; persist the terminal projection before
    // calculating its receipt digest so every consumer observes the same truth.
    const terminalResult = projectManagedHostRunTerminalResult(state, result);
    if (terminalResult) atomicWrite(paths.result, terminalResult);
    const { text: specText, value: spec } = readManagedHostRunSpec(paths);
    const snapshot = readManagedHostRunSnapshot(paths);
    const terminal: ManagedHostRunTerminal = {
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId: snapshot.runId,
      state,
      reason,
      terminalAt: new Date(now).toISOString(),
      generation: snapshot.generation + 1,
      replacementSafe,
      resultDigest: digestFile(paths.result),
      eventJournalDigest: digestFile(paths.events) ?? sha256(''),
      liveOutputDigest: digestFile(paths.output),
      stdoutDigest: terminalResult?.stdoutDigest ?? null,
      specDigest: sha256(specText),
      evidenceProposalDigest: digestFile(paths.evidenceProposal),
      ...(state === 'completed' && managedDispatchOutputDigest
        ? { managedDispatchOutputDigest }
        : {}),
      processCleanup: cleanupOverride ?? terminalResult?.processCleanup ?? (
        replacementSafe
          ? { termSent: false, killSent: false, reaped: true, residualProcessGroup: false }
          : null
      ),
    };
    // Do this before terminal sealing. If the ownership proof or precise
    // one-shot cleanup cannot be established, do not claim terminal cleanup
    // has converged; a later status/cancel/repair touch can retry safely.
    cleanupManagedClaudePromptForTerminal(paths);
    if (!writeExclusive(paths.terminal, terminal)) return readTerminal(paths)!;
    updateSnapshotUnlocked(paths, current => ({
      ...current,
      state: terminal.state,
      generation: terminal.generation,
      replacementSafe: terminal.replacementSafe,
    }));
    // terminal.json is the exclusive terminal event. Keep events.jsonl immutable
    // after its digest is sealed into the terminal receipt; appending a second
    // textual terminal event here would immediately make eventJournalDigest stale.
    return terminal;
  });
  cleanupManagedReviewScratchForTerminal(paths, terminal);
  return terminal;
}

/**
 * Make the sealed managed terminal, rather than a stale provider-local exit,
 * the canonical result contract. This intentionally preserves all provider
 * output, usage and process-cleanup facts; only terminal-owned outcome fields
 * are projected. Callers also apply it while reading legacy sealed runs whose
 * result file predates this normalization.
 */
export function projectManagedHostRunTerminalResult(
  state: ManagedHostRunTerminalState,
  result: HostRunResult | null,
): HostRunResult | null {
  if (!result || state === 'completed') return result;
  if (state === 'timed_out') {
    return {
      ...result,
      exitCode: 124,
      timedOut: true,
      timeoutKind: 'total_timeout',
      terminalReason: 'total_timeout',
      failureKind: 'timeout',
    };
  }
  if (state === 'cancelled') {
    return {
      ...result,
      exitCode: 130,
      timedOut: false,
      timeoutKind: null,
      terminalReason: 'aborted',
      failureKind: result.failureKind === 'none' ? 'unknown' : result.failureKind,
    };
  }
  return {
    ...result,
    exitCode: result.exitCode === 0 ? 1 : result.exitCode,
    timedOut: false,
    timeoutKind: null,
    terminalReason: result.terminalReason === 'completed' || result.terminalReason === null
      ? 'child_error'
      : result.terminalReason,
    failureKind: result.failureKind === 'none' ? 'unknown' : result.failureKind,
  };
}

/**
 * Production launcher. Ordinary one-shot input remains in the run directory;
 * a formal-review signing key crosses only an inherited pipe, never argv, env,
 * prompt text, or a durable plaintext artifact. stdout/stderr are append-only
 * worker diagnostics, not the provider live-output protocol.
 */
async function launchManagedSupervisor(request: ManagedHostRunWorkerRequest, logFd: number): Promise<void> {
  const entry = fileURLToPath(new URL('../cli/managed-host-run-supervisor.js', import.meta.url));
  const supervisor = spawn(process.execPath, [entry, request.root, request.runId], {
    cwd: request.root, detached: true, stdio: ['ignore', logFd, logFd, 'ipc'],
  });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('managed supervisor readiness timeout')),
        MANAGED_SUPERVISOR_RUNTIME_POLICY.readyTimeoutMs);
      supervisor.once('error', error => { clearTimeout(timer); rejectReady(error); });
      supervisor.once('exit', () => { clearTimeout(timer); rejectReady(new Error('managed supervisor exited before readiness')); });
      supervisor.once('message', message => {
        clearTimeout(timer);
        const ready = message as { type?: string; runId?: string };
        if (ready?.type !== 'managed-supervisor-ready' || ready.runId !== request.runId) {
          rejectReady(new Error('managed supervisor readiness binding mismatch'));
        } else resolveReady();
      });
    });
    supervisor.disconnect();
    supervisor.unref();
  } catch (error) {
    await reapUnidentifiedManagedHostRunWorker(supervisor);
    throw error;
  }
}

export const defaultManagedHostRunWorkerLauncher: ManagedHostRunWorkerLauncher = async request => {
  assertManagedHostRunPlatformSupported(process.platform);
  const paths = pathsFor(request.root, request.runId);
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('managed host run: cannot resolve the current lattice CLI entrypoint');
  const logFd = openSync(paths.workerLog, 'a', 0o600);
  try {
    // No provider worker is launched until its independent recovery owner is ready.
    await launchManagedSupervisor(request, logFd);
    const hasInvocationKey = typeof request.proposalInvocationPrivateKey === 'string';
    const submitterSession = getSessionIdentity();
    // A detached CLI worker has a different PPID. Carry only the already
    // canonical fallback identity across that boundary so its ownership gate
    // continues the submitter's lease. Explicit and adapter identities keep
    // their original environment/source behavior.
    const workerEnvironment: NodeJS.ProcessEnv = submitterSession.sessionSource === 'derived-ppid'
      ? { ...process.env, PROOF_OR_STOP_SESSION_ID: submitterSession.sessionId }
      : process.env;
    const child = spawn(
      process.execPath,
      [entrypoint, '--root', request.root, 'host_run_worker', JSON.stringify({ runId: request.runId })],
      {
        cwd: request.root,
        env: hasInvocationKey
          ? { ...workerEnvironment, LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD: '3' }
          : workerEnvironment,
        detached: true,
        stdio: hasInvocationKey ? ['ignore', logFd, logFd, 'pipe'] : ['ignore', logFd, logFd],
      },
    );
    const terminateAndReapLaunchedWorker = async (): Promise<void> => {
      await reapUnidentifiedManagedHostRunWorker(child);
    };
    if (!child.pid) {
      await terminateAndReapLaunchedWorker();
      throw new Error('managed host run: detached worker did not expose a pid');
    }
    if (hasInvocationKey) {
      try {
        const descriptor = child.stdio[3];
        if (!descriptor || !('end' in descriptor)) throw new Error('worker capability descriptor unavailable');
        await new Promise<void>((resolveWrite, rejectWrite) => {
          let deliverySettled = false;
          // The submitter needs to wait only until its write is flushed into
          // the descriptor pipe. Waiting for `close` instead turns --detach
          // into an implicit attach: the worker owns fd 3 for its whole
          // provider lifetime and normally closes it only at terminal exit.
          // Keep the error listener through close/reap even after `finish`;
          // a large write can emit a late EPIPE edge, which must remain
          // supervised rather than becoming an uncaught process-level error.
          descriptor.on('error', (error: Error) => {
            if (deliverySettled) return;
            deliverySettled = true;
            rejectWrite(error);
          });
          descriptor.once('finish', () => {
            if (deliverySettled) return;
            deliverySettled = true;
            resolveWrite();
          });
          descriptor.once('close', () => {
            if (deliverySettled) return;
            deliverySettled = true;
            rejectWrite(new Error('worker capability descriptor closed before write completion'));
          });
          descriptor.end(request.proposalInvocationPrivateKey);
        });
      } catch (error) {
        await terminateAndReapLaunchedWorker();
        throw new Error(`managed host run: worker capability descriptor failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
};

export function assertManagedHostRunPlatformSupported(platform: NodeJS.Platform | string): void {
  if (platform === 'win32') {
    throw new Error('managed host run: unsupported platform win32; POSIX process-group supervision is required before provider spawn');
  }
}

export async function submitManagedHostRun(
  args: ManagedHostRunSubmitArgs,
  deps: ManagedHostRunSubmitDeps = {},
): Promise<ManagedHostRunProjection> {
  if (!args.root || !args.cwd) throw new Error('managed host run: root and cwd are required');
  if (!args.promptText) throw new Error('managed host run: prompt is empty; refuse pre-spawn');
  if (!args.phase || !args.agentType) throw new Error('managed host run: phase and agentType are required');
  const selection = normalizeHostRunModelSelection(args);
  const platform = deps.platform ?? process.platform;
  if (args.reviewRunId && args.storyId && !args.reviewRunId.startsWith(`${args.storyId}:`)) {
    throw new Error(`managed host run: reviewRunId "${args.reviewRunId}" does not belong to story "${args.storyId}"`);
  }
  if (args.profile === ACCEPTANCE_REVIEW_PROFILE) {
    assertAcceptanceReviewBinding(args.acceptanceReviewBinding);
    if (args.phase !== 'DEV' || args.agentType !== ACCEPTANCE_REVIEW_LANE || args.lane !== ACCEPTANCE_REVIEW_LANE
      || !args.reviewRunId || !args.storyId || !args.reviewBinding || args.isolateManagedReview !== true) {
      throw new Error('acceptance amendment review requires an isolated DEV reviewer and exact subject');
    }
  } else if (args.acceptanceReviewBinding) {
    throw new Error('acceptance amendment binding requires its dedicated reviewer profile');
  }
  if (isIsolatedReviewerProfile(args.profile)) {
    if (!args.storyId || !args.reviewRunId || !args.lane || args.agentType !== args.lane || !args.reviewBinding) {
      throw new Error('managed host run: managed_reviewer requires exact storyId/reviewRunId/lane/agentType/reviewBinding');
    }
    const binding = args.reviewBinding;
    if (![binding.headHash, binding.materialHash, binding.storyFilesHash, binding.promptHash].every(value => value.trim().length > 0)) {
      throw new Error('managed host run: managed_reviewer reviewBinding fields must be non-empty');
    }
  }
  if (args.isolateManagedReview === true) {
    if (!isIsolatedReviewerProfile(args.profile) || !args.reviewBinding) {
      throw new Error('managed host run: managed-review isolation requires an exact managed_reviewer binding');
    }
    if (resolve(args.root) !== resolve(args.cwd)) {
      throw new Error('managed host run: managed-review isolation requires the canonical story worktree as the submitted cwd');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(args.reviewBinding.managedPromptDigest ?? '')) {
      throw new Error('managed host run: managed-review isolation requires the sealed derived prompt digest');
    }
  }

  const requestedReadonlyLane = args.isolateManagedReview === true || args.profile === 'cross_host_review_codex'
    ? resolveManagedReviewIsolation(args.root) : null;
  const now = deps.now ?? Date.now;
  const burnTokenLimit = managedBurnTokenLimit(args.environment ?? process.env);
  const createdMs = now();
  const createdAt = new Date(createdMs).toISOString();
  const deadlineMs = boundedPositiveMs(args.deadlineMs, MANAGED_HOST_RUN_DEFAULT_DEADLINE_MS, MANAGED_HOST_RUN_MAX_DEADLINE_MS);
  const timeoutMs = boundedPositiveMs(args.timeoutMs, deadlineMs, deadlineMs);
  const deadlineAt = new Date(createdMs + deadlineMs).toISOString();
  mkdirSync(managedHostRunsRoot(args.root), { recursive: true, mode: 0o700 });
  if (args.idempotencyKey !== undefined && (!args.idempotencyKey.trim() || args.idempotencyKey.length > 512)) {
    throw new Error('managed host run: idempotency key must contain 1 to 512 characters');
  }
  const logicalIdentity = isIsolatedReviewerProfile(args.profile)
    ? ['review', args.host, args.storyId, args.reviewRunId, args.lane]
    : args.idempotencyKey !== undefined
      ? ['request', args.idempotencyKey]
      : null;
  const submissionArgs = { ...args };
  delete submissionArgs.model;
  delete submissionArgs.reasoningEffort;
  const submissionDigest = logicalIdentity ? sha256(canonicalJson({
    ...submissionArgs,
    ...(selection.model !== null ? { model: selection.model } : {}),
    ...(selection.reasoningEffort !== null ? { reasoningEffort: selection.reasoningEffort } : {}),
    burnTokenLimit,
    root: realpathSync(args.root),
    cwd: realpathSync(args.cwd),
    deadlineMs,
    timeoutMs,
  })) : undefined;
  const runId = logicalIdentity
    ? `request-${createHash('sha256').update(canonicalJson(logicalIdentity)).digest('hex')}`
    : (deps.randomId ?? randomUUID)();
  assertRunId(runId);
  const paths = pathsFor(args.root, runId);
  mkdirSync(managedHostRunsRoot(args.root), { recursive: true, mode: 0o700 });
  if (logicalIdentity && existsSync(managedHostRunReceiptArchivePath(args.root, runId))) {
    managedHostRunReceipt(args.root, runId); // Verify the archive before reporting its recovery anchor.
    throw new Error(`managed host run ${runId}: idempotent run archived; consume its terminal receipt, never redispatch`);
  }
  try {
    // Atomic directory creation is the cross-process single-dispatch claim.
    mkdirSync(paths.dir, { mode: 0o700 });
  } catch (error) {
    if (!logicalIdentity || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const until = Date.now() + boundedPositiveMs(deps.claimTimeoutMs, MANAGED_HOST_RUN_CLAIM_TIMEOUT_MS, MANAGED_HOST_RUN_STATUS_WAIT_MAX_MS);
    while (Date.now() < until) {
      if (existsSync(paths.spec) && existsSync(paths.owner) && existsSync(paths.snapshot)) {
        const existing = readManagedHostRunSpec(paths).value;
        if (existing.submissionDigest !== submissionDigest) {
          throw new Error(`managed host run ${runId}: idempotency input conflict; keep the original run`);
        }
        const projection = projectionFor(paths);
        if (projection.state !== 'submitted') return projection;
      }
      await sleep(20);
    }
    throw new Error(`managed host run ${runId}: idempotent submission pending or interrupted; inspect this run, never redispatch`);
  }

  let admission: ManagedLaunchAdmission | undefined;
  let sealedEnvironment = args.environment;
  let managedReviewScratch: ManagedReviewScratchWorktree | null = null;
  let crossHostReadonlyLane: ManagedReviewLane | undefined;
  try {
    if (requestedReadonlyLane) {
      // New claims only. Existing spec/archive recovery above never probes.
      // Dispatcher verifies signed ordinary roster or trusted singleton subject.
      sealedEnvironment = normalizeExecutionBatchEnvironment({...process.env,...args.environment});
      admission = await consumeManagedLaunchAdmission(args, sealedEnvironment, {runId,deadlineAt});
      if (!admission) throw new Error('managed launch requires execution admission');
    }
    if (args.isolateManagedReview === true) {
      managedReviewScratch = createManagedReviewScratchWorktree({
        gitCwd: args.root,
        runId,
        headHash: args.reviewBinding!.headHash,
        parentFactory: deps.managedReviewScratchParentFactory,
      });
      if (requestedReadonlyLane) {
        const sealedScratch = {...managedReviewScratch, readonlyLane: await createManagedReviewLane(managedReviewScratch, args.host, {...process.env,...args.environment}, admission!.providerState)};
        atomicWrite(managedReviewScratchRegistrationPath(managedReviewScratch), sealedScratch);
        managedReviewScratch = sealedScratch;
      }
    }
    if (requestedReadonlyLane && args.profile === 'cross_host_review_codex') {
      if (args.host !== 'codex') throw new Error('cross-host readonly profile requires Codex');
      crossHostReadonlyLane = await createManagedReviewLane(crossHostReadonlySnapshot(args.root, args.cwd), args.host, {...process.env,...args.environment}, admission!.providerState);
    }
  } catch (error) {
    if (managedReviewScratch) cleanupManagedReviewScratchWorktree(args.root, managedReviewScratch);
    // No worker exists before scratch setup completes. Remove only this run's
    // newly-created durable directory; the scratch helper itself owns its
    // canonical temporary parent and never targets the primary worktree.
    rmSync(paths.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    throw error;
  }

  const proposalInvocationKeys = (isIsolatedReviewerProfile(args.profile) || args.profile === 'managed_dispatch')
    ? generateEd25519KeyPair()
    : null;
  const capability = proposalInvocationKeys?.privateKey ?? randomBytes(32).toString('base64url');
  const spec: ManagedHostRunSpec = {
    ...(admission ? { executionAdmission: { version: 1 as const, binding: admission.binding } } : {}),
    durationEstimate: captureManagedRunDurationEstimate(args, createdAt),
    burnTokenLimit,
    ...(submissionDigest ? { submissionDigest } : {}),
    schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
    runId,
    host: args.host,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    storyId: args.storyId,
    phase: args.phase,
    agentType: args.agentType,
    reviewRunId: args.reviewRunId ?? null,
    lane: args.lane ?? null,
    cwd: managedReviewScratch?.executionCwd ?? managedReviewScratch?.cwd ?? args.cwd,
    root: args.root,
    managedReviewScratch,
    ...(crossHostReadonlyLane ? {crossHostReadonlyLane} : {}),
    createdAt,
    deadlineAt,
    timeoutMs,
    projectRootHash: args.projectRootHash,
    profile: args.profile ?? null,
    reviewBinding: args.reviewBinding ?? null,
    ...(args.acceptanceReviewBinding ? { acceptanceReviewBinding: args.acceptanceReviewBinding } : {}),
  };
  try {
    atomicWrite(paths.spec, spec);
    const owner: ManagedHostRunOwner = {
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId,
      capabilityDigest: sha256(capability),
      proposalInvocationPublicKey: proposalInvocationKeys?.publicKey ?? null,
      specDigest: sha256(readManagedHostRunSpec(paths).text),
      promptDigest: sha256(args.promptText),
      environmentDigest: sealedEnvironment ? sha256(canonicalJson(sealedEnvironment)) : null,
      createdAt,
    };
    atomicWrite(paths.owner, owner);
    atomicWrite(paths.snapshot, {
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId,
      state: 'submitted',
      generation: 1,
      createdAt,
      deadlineAt,
      workerPid: null,
      workerHeartbeatAt: null,
      lastProviderProgressAt: null,
      providerProgressMode: args.providerProgressMode ?? 'output-observable',
      providerLaunchState: 'pending',
      providerIdentity: null,
      outputSequence: 0,
      outputRetainedBytes: 0,
      outputTruncated: false,
      replacementSafe: false,
    } satisfies ManagedHostRunSnapshot);
    appendEvent(paths, {
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId,
      at: createdAt,
      type: 'submitted',
    });
  } catch (error) {
    const scratchCleanupSucceeded = !managedReviewScratch
      || cleanupManagedReviewScratchForSubmitFailure(paths, managedReviewScratch, 'submit_artifact_setup');
    // A failed marker-bound cleanup needs its run directory as a durable
    // operator diagnostic/recovery anchor. Removing it would orphan the exact
    // scratch path and make the failure look like an ordinary vanished submit.
    if (scratchCleanupSucceeded) {
      rmSync(paths.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
    throw error;
  }
  try {
    assertManagedHostRunPlatformSupported(platform);
  } catch {
    writeTerminal(paths, 'failed', `unsupported_platform:${platform}`, true, null, now());
    return projectionFor(paths);
  }
  // Production uses the descriptor-only worker launcher. Injected launchers are
  // an explicit test seam and may start the worker in a separate fixture
  // process, so retain the legacy one-shot file only for that seam.
  try {
    if (args.profile === ACCEPTANCE_REVIEW_PROFILE && proposalInvocationKeys) deps.onAcceptanceReviewKeyCreated?.({ runId, publicKey: proposalInvocationKeys.publicKey });
    deps.beforeOneShotInputWrite?.({ root: args.root, runId });
    if (!proposalInvocationKeys || (deps.launchWorker && deps.workerCapabilityTransport !== 'descriptor')) {
      writeFileSync(paths.capability, capability, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    writeFileSync(paths.prompt, args.promptText, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (sealedEnvironment) {
      writeFileSync(paths.environment, `${canonicalJson(sealedEnvironment)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
  } catch (error) {
    unlinkIfPresent(paths.capability);
    unlinkIfPresent(paths.prompt);
    unlinkIfPresent(paths.environment);
    if (managedReviewScratch) {
      cleanupManagedReviewScratchForSubmitFailure(paths, managedReviewScratch, 'submit_input_setup');
    }
    // No worker can exist before these one-shot writes finish. Seal an honest
    // failed terminal rather than deleting the run, so status/GC expose any
    // retained scratch cleanup diagnostic and recovery anchor.
    writeTerminal(
      paths,
      'failed',
      `submit_input_write_failed:${error instanceof Error ? error.message : String(error)}`,
      true,
      null,
      now(),
    );
    return projectionFor(paths);
  }

  let launchedWorker: ManagedHostRunWorkerLaunchResult;
  try {
    launchedWorker = await (deps.launchWorker ?? defaultManagedHostRunWorkerLauncher)({
      root: args.root,
      runId,
      ...(proposalInvocationKeys ? { proposalInvocationPrivateKey: proposalInvocationKeys.privateKey } : {}),
    });
    updateSnapshot(paths, current => ({ ...current, workerPid: launchedWorker.pid }));
  } catch (error) {
    unlinkIfPresent(paths.capability);
    unlinkIfPresent(paths.prompt);
    unlinkIfPresent(paths.environment);
    // A launcher may throw after the OS process exists but before it can return
    // the worker pid. Without a returned identity the submitter cannot prove
    // reap or replacement safety, so publish the ambiguity honestly.
    writeTerminal(paths, 'failed', `worker_launch_failed:${error instanceof Error ? error.message : String(error)}`, false, null, now());
    return projectionFor(paths);
  }

  const claimTimeoutMs = boundedPositiveMs(deps.claimTimeoutMs, MANAGED_HOST_RUN_CLAIM_TIMEOUT_MS, MANAGED_HOST_RUN_STATUS_WAIT_MAX_MS);
  const claimPollMs = boundedPositiveMs(deps.claimPollMs, 20, 1_000);
  const claimDeadline = Date.now() + claimTimeoutMs;
  while (Date.now() < claimDeadline) {
    const terminal = readTerminal(paths);
    if (terminal) return projectionFor(paths);
    if (existsSync(paths.claim)) {
      const snapshot = readManagedHostRunSnapshot(paths);
      if (snapshot.state === 'running') return projectionFor(paths);
    }
    await sleep(claimPollMs);
  }

  // Serialize the final no-claim decision against the worker's durable claim.
  // Otherwise a worker blocked on one-shot input can cross this boundary after
  // the submitter has already published a conflicting failed terminal.
  return withMkdirLock(paths.claimLock, () => {
    if (readTerminal(paths) || existsSync(paths.claim)) return projectionFor(paths);
    unlinkIfPresent(paths.capability);
    unlinkIfPresent(paths.prompt);
    unlinkIfPresent(paths.environment);
    writeTerminal(paths, 'failed', 'worker_claim_timeout', !pidAlive(launchedWorker.pid), null, now());
    return projectionFor(paths);
  }, { label: `managed host run ${runId} submit/claim fence` });
}

export async function runManagedHostRunWorker(
  request: ManagedHostRunWorkerRequest,
  deps: ManagedHostRunWorkerDeps = {},
): Promise<ManagedHostRunTerminal> {
  const paths = pathsFor(request.root, request.runId);
  const existing = readTerminal(paths);
  if (existing) return existing;
  const sealedSpec = readManagedHostRunSpec(paths);
  const spec = sealedSpec.value;
  const owner = readManagedHostRunOwner(paths);
  // Protect even removal of the admission-version field; old immutable specs still match.
  if (owner.specDigest !== sha256(sealedSpec.text)) throw new Error('managed worker immutable spec mismatch');
  const proposalInvocationPrivateKey = request.proposalInvocationPrivateKey
    ?? readWorkerProposalInvocationPrivateKey(deps.env ?? process.env);
  const now = deps.now ?? Date.now;
  const claimedAt = new Date(now()).toISOString();
  const claim: ManagedHostRunClaim = {
    schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
    runId: request.runId,
    workerPid: process.pid,
    claimedAt,
    capabilityDigest: owner.capabilityDigest,
  };
  const terminalBeforeClaim = withMkdirLock(paths.claimLock, () => {
    const terminal = readTerminal(paths);
    if (terminal) return terminal;
    if (!writeExclusive(paths.claim, claim)) {
      throw new Error(`managed host run ${request.runId}: already claimed`);
    }
    return null;
  }, { label: `managed host run ${request.runId} worker claim` });
  if (terminalBeforeClaim) return terminalBeforeClaim;

  // Claim ownership before opening one-shot inputs. Named pipes, slow
  // filesystems, or provider-neutral descriptor brokers may legitimately make
  // these reads slow; publish the claimed worker as running before those reads
  // so the submit response cannot contradict its durable ownership handshake.
  updateSnapshotAndAppendEvent(
    paths,
    current => ({
      ...current,
      state: 'running',
      generation: current.generation + 1,
      workerPid: process.pid,
      workerHeartbeatAt: claimedAt,
    }),
    {
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId: request.runId,
      at: claimedAt,
      type: 'worker_claimed',
      detail: { workerPid: process.pid },
    },
  );
  try {
    // A restart/reclaim reads only the sealed spec. Re-validate its private
    // scratch registration and detached HEAD here, before opening one-shot
    // inputs or creating a provider process, so an on-disk path substitution
    // cannot redirect a resumed formal review into the primary worktree.
    assertManagedReviewScratchExecution(spec);
  } catch (error) {
    // Scratch validation runs before the one-shot intake try/finally. It is a
    // terminal pre-provider failure nonetheless, so do not retain prompt,
    // capability, or redacted environment bytes until GC.
    eraseManagedHostRunOneShotInputs(paths);
    return writeTerminal(
      paths,
      'failed',
      `managed_review_scratch_invalid:${error instanceof Error ? error.message : String(error)}`,
      true,
      null,
      now(),
    );
  }
  let capability: string;
  let promptText: string;
  let oneShotEnvironment: NodeJS.ProcessEnv | null;
  try {
    capability = proposalInvocationPrivateKey ?? readFileSync(paths.capability, 'utf8');
    if (sha256(capability) !== owner.capabilityDigest) {
      return writeTerminal(paths, 'failed', 'worker_capability_mismatch', true, null, now());
    }
    promptText = readFileSync(paths.prompt, 'utf8');
    if (sha256(promptText) !== owner.promptDigest) {
      return writeTerminal(paths, 'failed', 'worker_prompt_digest_mismatch', true, null, now());
    }
    if (owner.environmentDigest) {
      if (!existsSync(paths.environment)) {
        return writeTerminal(paths, 'failed', 'worker_environment_missing', true, null, now());
      }
      const parsedEnvironment = readJson<unknown>(paths.environment);
      if (!isSealedProcessEnvironment(parsedEnvironment)) {
        return writeTerminal(paths, 'failed', 'worker_environment_invalid', true, null, now());
      }
      if (sha256(canonicalJson(parsedEnvironment)) !== owner.environmentDigest) {
        return writeTerminal(paths, 'failed', 'worker_environment_digest_mismatch', true, null, now());
      }
      oneShotEnvironment = parsedEnvironment;
    } else {
      oneShotEnvironment = null;
    }
  } catch (error) {
    return writeTerminal(
      paths,
      'failed',
      `worker_input_error:${error instanceof Error ? error.message : String(error)}`,
      true,
      null,
      now(),
    );
  } finally {
    eraseManagedHostRunOneShotInputs(paths);
  }

  const abort = new AbortController();
  let cancelTriggered = false;
  let deadlineTriggered = false;
  let supervisorFailure: Error | null = null;
  const failSupervisor = (error: unknown): void => {
    if (supervisorFailure === null) {
      supervisorFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (!abort.signal.aborted) abort.abort(supervisorFailure);
  };
  // Maximum per-event lower bound avoids double counting repeated/cumulative usage
  // events. This is deliberately not a sum of transcript or provider session history.
  let liveUsage: LiveProviderUsage | null = null;
  let providerClosed = false;
  let nextBurnCheckAt = 0;
  let lastBurnDecision: string | null = null;
  const checkBurn = (): void => {
    if (providerClosed || abort.signal.aborted || !liveUsage || now() < nextBurnCheckAt) return;
    const limit = spec.burnTokenLimit ?? MANAGED_BURN_RUNTIME_POLICY.defaultTokenLimit;
    if (liveUsage.tokens <= limit) return;
    nextBurnCheckAt = now() + MANAGED_BURN_RUNTIME_POLICY.progressCheckIntervalMs;
    const decision = assessManagedBurn(spec.root, spec.storyId, liveUsage.tokens, limit);
    const key = `${decision.action}:${decision.reason}`;
    if (key !== lastBurnDecision) {
      updateSnapshotAndAppendEvent(paths, current => ({ ...current, generation: current.generation + 1 }), {
        schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION, runId: spec.runId, at: new Date(now()).toISOString(),
        type: 'burn_guard', detail: { ...decision, observedTokensLowerBound: liveUsage.tokens, tokenLimit: limit,
          provider: liveUsage.provider, usagePayloadDigest: liveUsage.payloadDigest },
      });
      lastBurnDecision = key;
    }
    if (decision.action === 'stop') {
      ensureCancelRequest(paths, spec.runId, decision.reason, now());
      cancelTriggered = true;
      abort.abort(new Error(decision.reason));
    }
  };
  let outputSequence = readManagedHostRunSnapshot(paths).outputSequence;
  let outputRetainedBytes = readManagedHostRunSnapshot(paths).outputRetainedBytes ?? 0;
  let outputTruncated = readManagedHostRunSnapshot(paths).outputTruncated ?? false;
  const heartbeatMs = boundedPositiveMs(deps.heartbeatMs, 5_000, 60_000);
  const cancelPollMs = boundedPositiveMs(deps.cancelPollMs, 100, 5_000);
  const heartbeat = setInterval(() => {
    if (readTerminal(paths)) return;
    const at = new Date(now()).toISOString();
    try {
      updateSnapshot(paths, current => ({
        ...current,
        // Generation wakes status/attach consumers. A worker liveness tick is
        // diagnostic data, not a provider event or authorization to redispatch.
        workerHeartbeatAt: at,
        outputSequence,
        outputRetainedBytes,
        outputTruncated,
      }));
      checkBurn();
    } catch (error) {
      // Runtime retention/test cleanup may remove the authoritative snapshot while
      // the unref'ed heartbeat is between its terminal check and locked RMW.  A
      // missing snapshot is terminal for this worker: recreating it would invent
      // state after the run authority has been removed.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !existsSync(paths.snapshot)) {
        clearInterval(heartbeat);
        return;
      }
      failSupervisor(error);
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  const cancelPoll = setInterval(() => {
    try {
      if (!existsSync(paths.cancelRequest) || abort.signal.aborted) return;
      const requestValue = readCancelRequest(paths);
      if (requestValue?.reason === 'absolute_deadline_exceeded') deadlineTriggered = true;
      else cancelTriggered = true;
      abort.abort(new Error(requestValue?.reason ?? 'cancelled'));
    } catch (error) {
      failSupervisor(error);
    }
  }, cancelPollMs);
  cancelPoll.unref?.();
  const remainingMs = Math.max(1, Date.parse(spec.deadlineAt) - now());
  const deadlineTimer = setTimeout(() => {
    try {
      deadlineTriggered = true;
      ensureCancelRequest(paths, spec.runId, 'absolute_deadline_exceeded', now());
      if (!abort.signal.aborted) abort.abort(new Error('absolute_deadline_exceeded'));
    } catch (error) {
      failSupervisor(error);
    }
  }, remainingMs);
  deadlineTimer.unref?.();

  let result: HostRunResult | null = null;
  try {
    const providerEnvironment: NodeJS.ProcessEnv = {
      ...(oneShotEnvironment ?? deps.env ?? process.env),
      ...managedReviewTemporaryEnvironment(spec),
      LATTICE_MANAGED_HOST_RUN_ID: spec.runId,
      PROOF_OR_STOP_AGENT: spec.agentType,
      // Injected runners are an explicit in-process test seam. Production
      // provider children never receive this signing key in their env;
      // they receive only an exact signed attestation on descriptor fd 3.
      ...(spec.profile === 'managed_reviewer' && deps.runner
        ? { LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY: capability }
        : {}),
      ...(spec.profile === 'managed_dispatch' && proposalInvocationPrivateKey
        ? {
          LATTICE_MANAGED_INIT_INVOCATION: canonicalJson(signManagedInitInvocation({
            schemaVersion: 'lattice.managed_init_invocation.v1',
            runId: spec.runId,
            storyId: spec.storyId!,
            providerAgent: spec.agentType,
            invocationNonce: randomUUID(),
            issuedAt: new Date(now()).toISOString(),
            expiresAt: spec.deadlineAt,
          }, proposalInvocationPrivateKey as PrivateKeyBase64)),
        }
        : {}),
    };
    // Descriptor 3 is repurposed at the provider boundary for the one-shot
    // review invocation attestation. Never let the detached worker's own FD
    // selector leak into a child as ambient authority or confuse nested CLI
    // commands that did not inherit the worker capability descriptor.
    delete providerEnvironment.LATTICE_MANAGED_HOST_WORKER_CAPABILITY_FD;
    const readonlyLane = spec.managedReviewScratch?.readonlyLane ?? spec.crossHostReadonlyLane;
    if(readonlyLane) providerEnvironment.PATH = join(dirname(readonlyLane.layout.buildSource),MANAGED_REVIEW_LANE_ARTIFACT.launchers)+':'+(providerEnvironment.PATH ?? process.env.PATH ?? '');
    const grantLaunch = () => withTerminalAuthorityLock(paths, () => {
      const terminal = readTerminal(paths);
      if (terminal) return terminal.state === 'timed_out' ? 'absolute_deadline_exceeded' : terminal.reason;
      const current = readManagedHostRunSnapshot(paths);
      const cancel = readCancelRequest(paths);
      const deadlineExceeded = now() >= Date.parse(spec.deadlineAt);
      if (cancel || deadlineExceeded || current.providerLaunchState === 'revoked') {
        updateSnapshotUnlocked(paths, snapshot => ({ ...snapshot, providerLaunchState: 'revoked' }));
        return cancel?.reason ?? (deadlineExceeded ? 'absolute_deadline_exceeded' : 'provider_launch_authority_revoked');
      }
      updateSnapshotUnlocked(paths, snapshot => ({ ...snapshot, providerLaunchState: 'granted' }));
      return null;
    });
    let launchRefusal: string | null | void;
    if (spec.executionAdmission) {
      if (spec.executionAdmission.version !== 1 || !spec.executionAdmission.binding || !readonlyLane) {
        throw new Error('managed execution admission spec invalid');
      }
      const currentSpec = readManagedHostRunSpec(paths);
      if (owner.specDigest !== sha256(currentSpec.text)) throw new Error('managed execution admission spec digest mismatch');
      if (!oneShotEnvironment) throw new Error('managed admission sealed base environment missing');
      // Controller verification and the terminal grant form one launch decision.
      // The callback releases both locks before runHostRun begins.
      launchRefusal = await verifyManagedLaunchAdmission({
        spec, binding: spec.executionAdmission.binding,
        effectiveBaseEnvironment: oneShotEnvironment, providerEnvironment, readonlyLane,
        ...(spec.profile === 'managed_reviewer' && deps.runner ? {injectedCapability:capability} : {}),
      }, grantLaunch);
    } else {
      launchRefusal = grantLaunch();
    }
    if (launchRefusal) {
      if (launchRefusal === 'absolute_deadline_exceeded') {
        deadlineTriggered = true;
        return writeTerminal(paths, 'timed_out', launchRefusal, true, null, now());
      }
      cancelTriggered = readCancelRequest(paths) !== null;
      return writeTerminal(paths, cancelTriggered ? 'cancelled' : 'failed', launchRefusal, true, null, now());
    }
    result = await runHostRun(
      {
        host: spec.host,
        model: spec.model ?? null,
        reasoningEffort: spec.reasoningEffort ?? null,
        storyId: spec.storyId,
        agentType: spec.agentType,
        phase: spec.phase,
        promptText,
        managedRunId: spec.runId,
        ...(spec.profile === ACCEPTANCE_REVIEW_PROFILE ? { finalResultSchema: ACCEPTANCE_REVIEW_FINAL_SCHEMA } : {}),
        reviewRunId: spec.reviewRunId,
        lane: spec.lane,
        timeoutMs: Math.min(spec.timeoutMs, remainingMs),
        signal: abort.signal,
        env: providerEnvironment,
        usageEnv: deps.env ?? process.env,
        ...(spec.profile === 'cross_host_review_codex'
          ? { launchProfile: 'cross_host_review_codex' as const }
          : isIsolatedReviewerProfile(spec.profile)
            ? { launchProfile: 'managed_reviewer' as const }
            : spec.profile === 'managed_dispatch'
              ? { launchProfile: 'managed_dispatch' as const }
            : {}),
        ...(readonlyLane ? {managedReadonlyLayout: readonlyLane.layout} : {}),
        cwd: spec.cwd,
        root: spec.root,
        recordedAt: new Date(now()).toISOString(),
        projectRootHash: spec.projectRootHash,
      },
      {
        runner: deps.runner,
        onProviderUsage: usage => {
          if (!liveUsage || usage.tokens > liveUsage.tokens) liveUsage = usage;
        },
        // This fact arrives before asynchronous process-group cleanup. Do not
        // manufacture a new burn cancellation after the provider already closed.
        onProcessClose: closedAt => {
          providerClosed = true;
          updateSnapshotAndAppendEvent(paths, current => current.providerClosedAt ? null : ({
            ...current, generation:current.generation+1, providerClosedAt:closedAt, supervisionDiagnostic:null,
          }), {schemaVersion:MANAGED_HOST_RUN_SCHEMA_VERSION, runId:spec.runId,
            at:closedAt, type:'provider_closed', detail:{stage:'finalizing_result'}});
        },
        onProcessSpawn: identity => {
          const published = updateSnapshotAndAppendEvent(
            paths,
            current => ({
              ...current,
              generation: current.generation + 1,
              providerLaunchState: 'spawned',
              providerIdentity: identity,
            }),
            {
              schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
              runId: spec.runId,
              at: new Date(now()).toISOString(),
              type: 'provider_spawned',
              detail: {
                pid: identity.pid,
                pgid: identity.pgid,
                processGroupIsolated: identity.processGroupIsolated,
                startFingerprintPresent: identity.startFingerprint !== null,
              },
            },
          );
          if (published) deps.afterProviderIdentityPersisted?.(identity);
        },
        ...(spec.profile === 'managed_reviewer' && proposalInvocationPrivateKey
          ? {
            reviewInvocationPayload: (identity: HostRunProcessIdentity) => canonicalJson(signManagedReviewProposalInvocation({
              schemaVersion: 'lattice.managed_review_proposal_invocation.v1',
              runId: spec.runId,
              storyId: spec.storyId!,
              providerAgent: spec.agentType,
              lane: spec.lane!,
              reviewRunId: spec.reviewRunId!,
              providerIdentity: identity,
              invocationNonce: randomUUID(),
              issuedAt: new Date(now()).toISOString(),
              expiresAt: new Date(now() + 120_000).toISOString(),
            }, proposalInvocationPrivateKey as PrivateKeyBase64)),
          }
          : {}),
        passthrough: chunk => {
          withTerminalAuthorityLock(paths, () => {
            if (readTerminal(paths)) return;
            outputSequence += 1;
            const progressAt = new Date(now()).toISOString();
            const frame: ManagedHostRunOutputFrame = {
              sequence: outputSequence,
              at: progressAt,
              stream: chunk.stream,
              text: chunk.text,
            };
            const encoded = `${canonicalJson(frame)}\n`;
            const encodedBytes = Buffer.byteLength(encoded, 'utf8');
            if (outputRetainedBytes + encodedBytes <= MANAGED_HOST_RUN_OUTPUT_RETENTION_MAX_BYTES) {
              appendFileSync(paths.output, encoded, { encoding: 'utf8', mode: 0o600 });
              outputRetainedBytes += encodedBytes;
            } else {
              outputTruncated = true;
            }
            updateSnapshotUnlocked(paths, current => ({
              ...current,
              generation: current.generation + 1,
              outputSequence,
              outputRetainedBytes,
              outputTruncated,
              lastProviderProgressAt: progressAt,
            }));
          });
        },
      },
    );

    // Authentication failure invalidates the shared seed before any other
    // result/terminal branch can return. A late old worker cannot revoke a new generation.
    if (result.failureKind === 'auth' && spec.executionAdmission) {
      if (!oneShotEnvironment) throw new Error('managed admission sealed base environment missing');
      const revoked = await revokeExecutionBatchBinding({
        root: spec.root,
        binding: spec.executionAdmission.binding.execution,
        effectiveBaseEnvironment: oneShotEnvironment,
      });
      if (!(revoked.state === 'BLOCKED' && revoked.reason === 'provider-auth-revoked')
        && !(revoked.state === 'UNKNOWN' && revoked.reason === 'revocation-generation-not-current')) {
        throw new Error(`managed batch auth revocation failed: ${revoked.reason ?? revoked.state}`);
      }
    }

    if (supervisorFailure) throw supervisorFailure;

    // A provider may write only inside its detached scratch, but a formal
    // receipt is still bound to the exact material captured before launch.
    // Re-check both the registration/HEAD and the clean material immediately
    // after provider exit, before accepting a compatibility proposal, parsing
    // final stdout, or sealing any completed terminal record.
    if (isIsolatedReviewerProfile(spec.profile) || spec.crossHostReadonlyLane) {
      try {
        assertManagedReviewScratchExecution(spec, { verifyBoundMaterial: true });
      } catch (error) {
        return writeTerminal(
          paths,
          'failed',
          `managed_review_scratch_integrity_invalid:${error instanceof Error ? error.message : String(error)}`,
          result.replacementSafe,
          result,
          now(),
        );
      }
    }

    // The child close fence wins only when the deadline callback arrived AFTER
    // the provider close. An `aborted` result proves the opposite ordering: the
    // managed deadline/cancel reached a still-live provider and caused its
    // close. That must remain a timed_out terminal rather than falling through
    // to the ordinary nonzero-exit failure path. Injected legacy runners have
    // no close proof, so their deadline behavior remains fail-closed.
    const deadlineAbortedLiveProvider = deadlineTriggered && result.terminalReason === 'aborted';
    if (result.timedOut || deadlineAbortedLiveProvider || (deadlineTriggered && result.closeObserved !== true)) {
      // runHostRun is capped to the remaining managed deadline. When its total
      // timer and this worker's deadline timer become runnable together, event
      // loop ordering must not downgrade an expired managed deadline into a
      // provider-local timeout.
      const managedDeadlineReached = deadlineTriggered || now() >= Date.parse(spec.deadlineAt);
      return writeTerminal(
        paths,
        'timed_out',
        managedDeadlineReached ? 'absolute_deadline_exceeded' : result.timeoutKind ?? 'provider_total_timeout',
        result.replacementSafe,
        result,
        now(),
      );
    }
    const postResultCancellation = readCancelRequest(paths);
    const closeObservedAt = result.closeObservedAt ? Date.parse(result.closeObservedAt) : Number.NaN;
    const cancelRequestedAt = postResultCancellation ? Date.parse(postResultCancellation.requestedAt) : Number.NaN;
    // A close fence accepts only the reserved deadline request that was
    // durably recorded at or after the production runner's authoritative
    // close boundary. This avoids waiting for the worker poll interval while
    // preserving a prior deadline/cancel as a timed-out terminal. Legacy or
    // injected runners without an exact close timestamp remain fail-closed.
    const closeFencedDeadline = result.closeObserved === true
      && !deadlineAbortedLiveProvider
      && postResultCancellation?.reason === 'absolute_deadline_exceeded'
      && Number.isFinite(closeObservedAt)
      && Number.isFinite(cancelRequestedAt)
      && cancelRequestedAt >= closeObservedAt;
    if (cancelTriggered || (postResultCancellation
      && !(closeFencedDeadline && postResultCancellation.reason === 'absolute_deadline_exceeded'))) {
      const terminal = classifyManagedHostRunCancellation(postResultCancellation?.reason ?? 'cancelled');
      return writeTerminal(paths, terminal.state, terminal.reason, result.replacementSafe, result, now());
    }
    if (result.blocked || result.exitCode !== 0) {
      const classifiedReason = result.failureKind && !['none', 'unknown'].includes(result.failureKind)
        ? result.failureKind
        : null;
      return writeTerminal(
        paths,
        'failed',
        result.refusalReason ?? classifiedReason ?? result.terminalReason ?? `provider_exit_${result.exitCode}`,
        result.replacementSafe,
        result,
        now(),
      );
    }
    if (spec.profile === ACCEPTANCE_REVIEW_PROFILE) {
      try {
        assertAcceptanceReviewBinding(spec.acceptanceReviewBinding);
        if (!proposalInvocationPrivateKey) throw new Error('worker signing key unavailable');
        const proposal = parseAcceptanceReviewFinal(result, { ...spec.acceptanceReviewBinding, runId: spec.runId, storyId: spec.storyId! });
        const terminalResult = projectManagedHostRunTerminalResult('completed', result);
        const claims = {
          schemaVersion: 'proofbound.acceptance_amendment_review_receipt.v1' as const,
          runId: spec.runId,
          root: realpathSync(spec.root),
          specDigest: owner.specDigest,
          promptDigest: owner.promptDigest,
          bindingProjectionDigest: bindingProjectionDigestOf(liveBindingProjection(paths)),
          resultDigest: sha256(`${canonicalJson(terminalResult)}\n`),
          processCleanup: result.processCleanup,
          proposal,
        };
        if (!writeExclusive(paths.evidenceProposal, { ...claims, signature: signCanonical(claims, proposalInvocationPrivateKey) })) {
          throw new Error('amendment proposal already exists');
        }
      } catch (error) {
        return writeTerminal(paths, 'failed', `acceptance_review_invalid:${error instanceof Error ? error.message : String(error)}`, result.replacementSafe, result, now());
      }
    }
    if (spec.profile === 'managed_reviewer') {
      const existingProposal = readValidManagedReviewEvidenceProposal(spec.root, spec.runId, spec);
      deps.afterManagedReviewProposalPreRead?.({
        root: spec.root,
        runId: spec.runId,
        hasValidProposal: existingProposal !== null,
      });
      // Older adapters may already have submitted one descriptor-attested,
      // immutable proposal before their ordinary final prose is emitted. That
      // proposal is the compatibility authority; only runs without it use the
      // canonical final-result lane.
      if (!existingProposal) {
        try {
          const proposal = parseManagedReviewFinalProposal(result);
          writeManagedReviewEvidenceProposal({
            root: spec.root,
            runId: spec.runId,
            proposal,
            environment: {
              LATTICE_MANAGED_HOST_RUN_ID: spec.runId,
              LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY: capability,
              PROOF_OR_STOP_AGENT: spec.agentType,
            },
          });
        } catch (error) {
          // A compatibility callback can win after the first read but before
          // the final-result writer takes the immutable-file fence. Its valid
          // proposal is the authority; malformed or absent competitors still
          // leave this final result fail-closed.
          if (readValidManagedReviewEvidenceProposal(spec.root, spec.runId, spec)) {
            return writeTerminal(paths, 'completed', 'provider_completed', result.replacementSafe, result, now());
          }
          return writeTerminal(
            paths,
            'failed',
            `managed_review_final_result_invalid:${error instanceof Error ? error.message : String(error)}`,
            result.replacementSafe,
            result,
            now(),
          );
        }
      }
      if (!readValidManagedReviewEvidenceProposal(spec.root, spec.runId, spec)) {
        return writeTerminal(paths, 'failed', 'managed_review_final_result_missing', result.replacementSafe, result, now());
      }
    }
    if (spec.profile === 'managed_dispatch') {
      const output = managedDispatchOutputValidation(spec);
      if (output.failureReason) {
        return writeTerminal(paths, 'failed', output.failureReason, result.replacementSafe, result, now());
      }
      deps.afterManagedDispatchOutputValidated?.({ root: spec.root, runId: spec.runId, outputDigest: output.outputDigest });
      if (output.outputDigest && spec.storyId
        && digestFile(new StoryStore(spec.root).storyFilePath(spec.storyId,
          spec.agentType === MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.role ? MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.artifact : 'scope-check.json')) !== output.outputDigest) {
        return writeTerminal(paths, 'failed', 'managed_dispatch_output_changed_before_seal', result.replacementSafe, result, now());
      }
      return writeTerminal(paths, 'completed', 'provider_completed', result.replacementSafe, result, now(), undefined, output.outputDigest);
    }
    return writeTerminal(paths, 'completed', 'provider_completed', result.replacementSafe, result, now());
  } catch (error) {
    const failedSnapshot = readManagedHostRunSnapshot(paths);
    const cleanup = result?.processCleanup
      ?? (failedSnapshot.providerIdentity
        ? await reapManagedHostRunProviderProcess(failedSnapshot.providerIdentity)
        : failedSnapshot.providerLaunchState === 'pending' || failedSnapshot.providerLaunchState === 'revoked'
          ? REAPED_WITHOUT_SIGNAL
          : AMBIGUOUS_PROCESS_CLEANUP);
    const replacementSafe = result?.replacementSafe ?? cleanupIsReplacementSafe(cleanup);
    const capturedSupervisorFailure = supervisorFailure as Error | null;
    if (capturedSupervisorFailure) {
      return writeTerminal(paths, 'failed', `worker_error:${capturedSupervisorFailure.message}`, replacementSafe, result, now(), cleanup);
    }
    if (deadlineTriggered) {
      return writeTerminal(paths, 'timed_out', 'absolute_deadline_exceeded', replacementSafe, result, now(), cleanup);
    }
    const caughtCancellation = readCancelRequest(paths);
    if (cancelTriggered || caughtCancellation) {
      const terminal = classifyManagedHostRunCancellation(caughtCancellation?.reason ?? 'cancelled');
      return writeTerminal(paths, terminal.state, terminal.reason, replacementSafe, result, now(), cleanup);
    }
    return writeTerminal(paths, 'failed', `worker_error:${error instanceof Error ? error.message : String(error)}`, replacementSafe, result, now(), cleanup);
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
    clearTimeout(deadlineTimer);
  }
}

function ensureCancelRequest(
  paths: ManagedHostRunPaths,
  runId: string,
  reason: string,
  now: number,
): ManagedHostRunCancelRequest {
  assertArtifactRunId(paths, 'cancel request', runId);
  const existing = readCancelRequest(paths);
  if (existing) return existing;
  const request: ManagedHostRunCancelRequest = {
    schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
    runId,
    requestedAt: new Date(now).toISOString(),
    reason: reason.trim() || 'cancelled',
  };
  if (!writeExclusive(paths.cancelRequest, request)) return readCancelRequest(paths)!;
  appendEvent(paths, {
    schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
    runId,
    at: request.requestedAt,
    type: 'cancel_requested',
    detail: { reason: request.reason },
  });
  return request;
}

export interface ManagedHostRunProcessGroupRow {
  pid: number;
  pgid: number;
  sessionId: number | null;
  /** Darwin ps exposes an opaque session pointer, not a POSIX SID. */
  sessionIdSource?: 'darwin-session-unavailable';
  start: string;
  processState?: string;
}

export interface ManagedHostRunProcessGroupOps {
  rows(pgid: number): ManagedHostRunProcessGroupRow[] | null;
  signal(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  wait(ms: number): Promise<void>;
}

function processGroupRows(pgid: number): ManagedHostRunProcessGroupRow[] | null {
  if (process.platform === 'win32') return null;
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,pgid=,sess=,stat=,lstart='], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .map(line => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ pid: Number(match[1]), pgid: Number(match[2]),
        sessionId: process.platform === 'darwin' ? null : Number(match[3]),
        ...(process.platform === 'darwin' ? { sessionIdSource: 'darwin-session-unavailable' as const } : {}),
        processState:match[4]!, start: match[5]! }))
      .filter(row => row.pgid === pgid);
  } catch {
    return null;
  }
}

const DEFAULT_PROCESS_GROUP_OPS: ManagedHostRunProcessGroupOps = {
  rows: processGroupRows,
  signal: (pgid, signal) => process.kill(-pgid, signal),
  wait: sleep,
};

function providerInvocationMatches(
  paths: ManagedHostRunPaths,
  binding: ManagedReviewProposalInvocationBinding,
  callerPid: number,
): boolean {
  if (process.platform === 'win32') return false;
  if (readTerminal(paths)) return false;
  const spec = readManagedHostRunSpec(paths).value;
  const snapshot = readManagedHostRunSnapshot(paths);
  if (snapshot.state !== 'running'
    || spec.profile !== 'managed_reviewer'
    || spec.storyId !== binding.storyId
    || spec.agentType !== binding.providerAgent
    || spec.lane !== binding.lane
    || spec.reviewRunId !== binding.reviewRunId) return false;
  const identity = snapshot.providerIdentity;
  if (!identity?.processGroupIsolated || !identity.pgid || !identity.startFingerprint) return false;
  const inspect = (pid: number): { pid: number; pgid: number; sessionId: number; start: string } | null => {
    try {
      const output = execFileSync('ps', ['-o', 'pid=', '-o', 'pgid=', '-o', 'sess=', '-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(output);
      return match
        ? { pid: Number(match[1]), pgid: Number(match[2]), sessionId: Number(match[3]), start: match[4]! }
        : null;
    } catch { return null; }
  };
  const leader = inspect(identity.pid);
  const caller = inspect(callerPid);
  return leader !== undefined
    && leader !== null
    && caller !== null
    && leader.pgid === identity.pgid
    && caller.pgid === identity.pgid
    && leader.start === identity.startFingerprint
    && leader.sessionId === caller.sessionId;
}

function readManagedInitInvocationFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ManagedInitInvocationAttestation | null {
  const raw = environment.LATTICE_MANAGED_INIT_INVOCATION?.trim();
  if (!raw) return null;
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) {
    throw new Error('managed INIT invocation attestation exceeds 16 KiB');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('managed INIT invocation attestation is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('managed INIT invocation attestation must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    'expiresAt', 'invocationNonce', 'issuedAt', 'providerAgent',
    'runId', 'schemaVersion', 'signature', 'storyId',
  ];
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('managed INIT invocation attestation has an invalid shape');
  }
  for (const key of expectedKeys) {
    if (typeof record[key] !== 'string' || record[key]!.length === 0) {
      throw new Error(`managed INIT invocation attestation field "${key}" must be a non-empty string`);
    }
  }
  return record as unknown as ManagedInitInvocationAttestation;
}

function consumeManagedInitInvocationAttestation(args: {
  root: string;
  storyId: string;
  agentType: string;
  attestation: ManagedInitInvocationAttestation;
}): string {
  const { attestation } = args;
  assertRunId(attestation.runId);
  const paths = pathsFor(args.root, attestation.runId);
  return withTerminalAuthorityLock(paths, () => {
    if (readTerminal(paths)) throw new Error('managed INIT invocation run is terminal');
    const spec = readManagedHostRunSpec(paths).value;
    const owner = readManagedHostRunOwner(paths);
    const snapshot = readManagedHostRunSnapshot(paths);
    const { signature, ...claims } = attestation;
    const issuedAt = Date.parse(attestation.issuedAt);
    const expiresAt = Date.parse(attestation.expiresAt);
    const now = Date.now();
    const valid = attestation.schemaVersion === 'lattice.managed_init_invocation.v1'
      && attestation.storyId === args.storyId
      && attestation.providerAgent === args.agentType
      && spec.runId === attestation.runId
      && spec.profile === 'managed_dispatch'
      && spec.storyId === args.storyId
      && spec.agentType === args.agentType
      && snapshot.state === 'running'
      && snapshot.providerIdentity !== null
      && typeof owner.proposalInvocationPublicKey === 'string'
      && /^[A-Za-z0-9._-]{16,128}$/.test(attestation.invocationNonce)
      && Number.isFinite(issuedAt)
      && Number.isFinite(expiresAt)
      && issuedAt <= now + 5_000
      && expiresAt >= now
      && attestation.expiresAt === spec.deadlineAt
      && verifyCanonical(claims, signature, owner.proposalInvocationPublicKey);
    if (!valid) throw new Error('managed INIT invocation attestation is invalid or mismatched');
    const consumedAt = new Date(now).toISOString();
    if (!writeExclusive(paths.initInvocationConsumption, {
      schemaVersion: 'lattice.managed_dispatch_invocation_consumption.v2',
      runId: attestation.runId,
      storyId: attestation.storyId,
      providerAgent: attestation.providerAgent,
      invocationNonce: attestation.invocationNonce,
      consumedAt,
      attestation,
    })) {
      throw new Error('managed INIT invocation attestation was already consumed');
    }
    appendFileSync(paths.events, `${canonicalJson({
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId: attestation.runId,
      at: consumedAt,
      type: 'managed_init_invocation_consumed',
      detail: { storyId: attestation.storyId, providerAgent: attestation.providerAgent },
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    return attestation.runId;
  });
}

/**
 * Resolve the controller-owned managed reviewer run authorizing this CLI process.
 * Real provider tool hosts may create a fresh process group/session for each
 * command, so a signed, one-shot controller attestation is authoritative. The
 * environment is transport, not trust: the controller signature binds every
 * claim and the nonce is consumed atomically. This assumes the managed child is
 * protected from unrelated same-UID/root processes by its existing host or
 * container isolation boundary. The legacy same-process-group path remains for
 * older managed adapters.
 */
export function resolveManagedDispatchInvocation(args: {
  root: string;
  storyId: string;
  agentType: string;
  callerPid?: number;
  environment?: NodeJS.ProcessEnv;
}): string {
  let attestation: ManagedInitInvocationAttestation | null;
  try {
    attestation = readManagedInitInvocationFromEnvironment(args.environment ?? process.env);
    if (attestation) {
      return consumeManagedInitInvocationAttestation({
        root: args.root,
        storyId: args.storyId,
        agentType: args.agentType,
        attestation,
      });
    }
  } catch (error) {
    throw new Error(
      `managed dispatch refused: invocation was not accepted (${error instanceof Error ? error.message : String(error)}). `
      + 'Use a fresh host_run managedDispatch reviewer. [delivery_not_acknowledged]',
    );
  }
  if (process.platform === 'win32') {
    throw new Error('managed dispatch: reviewer delivery attestation is unsupported on win32');
  }
  const callerPid = args.callerPid ?? process.pid;
  const candidates: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(managedHostRunsRoot(args.root)); } catch { /* no active managed runs */ }
  for (const runId of entries) {
    try {
      const paths = pathsFor(args.root, runId);
      if (readTerminal(paths)) continue;
      const spec = readManagedHostRunSpec(paths).value;
      if (spec.profile !== 'managed_dispatch'
        || spec.storyId !== args.storyId
        || spec.agentType !== args.agentType) continue;
      const snapshot = readManagedHostRunSnapshot(paths);
      if (snapshot.state !== 'running') continue;
      const identity = snapshot.providerIdentity;
      if (!identity?.processGroupIsolated || !identity.pgid || !identity.startFingerprint) continue;
      const rows = processGroupRows(identity.pgid);
      const leader = rows?.find(row => row.pid === identity.pid);
      const caller = rows?.find(row => row.pid === callerPid);
      if (!leader || !caller || leader.start !== identity.startFingerprint) continue;
      if (process.platform !== 'darwin' && leader.sessionId !== caller.sessionId) continue;
      candidates.push(runId);
    } catch {
      // A corrupt, partial, stale, or foreign run can never grant authority.
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `init_check_set refused: required INIT reviewer delivery was not acknowledged by exactly one active managed dispatch (matched ${candidates.length}). `
      + 'Use host_run with managedDispatch=true, or the explicit acknowledged init_check_repair fallback. [delivery_not_acknowledged]',
    );
  }
  const runId = candidates[0]!;
  const paths = pathsFor(args.root, runId);
  return withTerminalAuthorityLock(paths, () => {
    if (readTerminal(paths)) throw new Error('managed dispatch invocation run is terminal');
    const spec = readManagedHostRunSpec(paths).value;
    const snapshot = readManagedHostRunSnapshot(paths);
    const identity = snapshot.providerIdentity;
    if (spec.profile !== 'managed_dispatch'
      || spec.storyId !== args.storyId
      || spec.agentType !== args.agentType
      || snapshot.state !== 'running'
      || !identity?.processGroupIsolated
      || !identity.pgid
      || !identity.startFingerprint) {
      throw new Error('managed dispatch process-group invocation changed before consumption');
    }
    const rows = processGroupRows(identity.pgid);
    const leader = rows?.find(row => row.pid === identity.pid);
    const caller = rows?.find(row => row.pid === callerPid);
    if (!leader || !caller || leader.start !== identity.startFingerprint
      || (process.platform !== 'darwin' && leader.sessionId !== caller.sessionId)) {
      throw new Error('managed dispatch process-group invocation is no longer live or matched');
    }
    const consumedAt = new Date().toISOString();
    if (!writeExclusive(paths.initInvocationConsumption, {
      schemaVersion: 'lattice.managed_dispatch_process_group_consumption.v1',
      runId,
      storyId: args.storyId,
      providerAgent: args.agentType,
      consumedAt,
      providerIdentity: identity,
      caller,
    })) {
      throw new Error('managed dispatch process-group invocation was already consumed');
    }
    appendFileSync(paths.events, `${canonicalJson({
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId,
      at: consumedAt,
      type: 'managed_dispatch_process_group_invocation_consumed',
      detail: { storyId: args.storyId, providerAgent: args.agentType, callerPid },
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    return runId;
  });
}

/**
 * Provider-tool broker: resolve exactly one active managed reviewer whose
 * recorded provider process group contains this invocation. PGID is never a
 * bearer by itself: exact review binding, live leader fingerprint, POSIX
 * session, non-terminal state, and unique candidate are all mandatory.
 */
export function resolveManagedReviewProposalInvocation(args: {
  root: string;
  binding: ManagedReviewProposalInvocationBinding;
  callerPid?: number;
}): string {
  if (process.platform === 'win32') {
    throw new Error('managed_review_proposal_set: provider invocation broker is unsupported on win32');
  }
  const callerPid = args.callerPid ?? process.pid;
  const candidates: string[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(managedHostRunsRoot(args.root)); } catch { /* no active managed runs */ }
  for (const runId of entries) {
    try {
      const paths = pathsFor(args.root, runId);
      if (providerInvocationMatches(paths, args.binding, callerPid)) candidates.push(runId);
    } catch {
      // Corrupt/partial candidates cannot grant provider authority.
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `managed_review_proposal_set: provider invocation must match exactly one active managed reviewer (matched ${candidates.length})`,
    );
  }
  return candidates[0]!;
}

export function readManagedReviewProposalInvocationFromFd(
  env: NodeJS.ProcessEnv = process.env,
): ManagedReviewProposalInvocationAttestation | null {
  const rawFd = env.LATTICE_MANAGED_REVIEW_INVOCATION_FD?.trim();
  if (!rawFd) return null;
  const fd = Number(rawFd);
  if (!Number.isInteger(fd) || fd < 3 || fd > 255) {
    throw new Error('managed_review_proposal_set: invocation fd must be between 3 and 255');
  }
  const raw = readFileSync(fd, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
    throw new Error('managed_review_proposal_set: invocation attestation exceeds 64 KiB');
  }
  try {
    return JSON.parse(raw) as ManagedReviewProposalInvocationAttestation;
  } catch {
    throw new Error('managed_review_proposal_set: invocation fd does not contain JSON');
  }
}

function verifyManagedReviewProposalInvocationAttestation(
  paths: ManagedHostRunPaths,
  binding: ManagedReviewProposalInvocationBinding,
  attestation: ManagedReviewProposalInvocationAttestation,
): boolean {
  if (readTerminal(paths)) return false;
  const spec = readManagedHostRunSpec(paths).value;
  const owner = readManagedHostRunOwner(paths);
  const snapshot = readManagedHostRunSnapshot(paths);
  if (!owner.proposalInvocationPublicKey || snapshot.state !== 'running' || !snapshot.providerIdentity) return false;
  const { signature, ...claims } = attestation;
  const issuedAt = Date.parse(attestation.issuedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  const now = Date.now();
  return attestation.schemaVersion === 'lattice.managed_review_proposal_invocation.v1'
    && attestation.runId === spec.runId
    && attestation.storyId === binding.storyId
    && attestation.providerAgent === binding.providerAgent
    && attestation.lane === binding.lane
    && attestation.reviewRunId === binding.reviewRunId
    && spec.profile === 'managed_reviewer'
    && spec.storyId === binding.storyId
    && spec.agentType === binding.providerAgent
    && spec.lane === binding.lane
    && spec.reviewRunId === binding.reviewRunId
    && canonicalJson(attestation.providerIdentity) === canonicalJson(snapshot.providerIdentity)
    && snapshot.providerIdentity.processGroupIsolated
    && snapshot.providerIdentity.pgid !== null
    && snapshot.providerIdentity.startFingerprint !== null
    && /^[A-Za-z0-9._-]{16,128}$/.test(attestation.invocationNonce)
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= now + 5_000
    && expiresAt >= now
    && expiresAt > issuedAt
    && expiresAt - issuedAt <= 120_000
    && verifyCanonical(claims, signature, owner.proposalInvocationPublicKey);
}

const REAPED_WITHOUT_SIGNAL: HostRunProcessCleanup = {
  termSent: false,
  killSent: false,
  reaped: true,
  residualProcessGroup: false,
};

const AMBIGUOUS_PROCESS_CLEANUP: HostRunProcessCleanup = {
  termSent: false,
  killSent: false,
  reaped: false,
  residualProcessGroup: true,
};

/**
 * A granted worker that has not published provider identity is neither safe to
 * signal by bare PID nor safe to wait on forever. Give cancellation a bounded
 * cooperative window, then seal an explicitly replacement-unsafe terminal so
 * recovery cannot mistake an unobserved child for a reaped provider.
 */
const MANAGED_HOST_RUN_PREIDENTITY_RECOVERY_GRACE_MS = 500;

function cleanupIsReplacementSafe(cleanup: HostRunProcessCleanup): boolean {
  return cleanup.reaped && !cleanup.residualProcessGroup;
}

/**
 * A negative PGID signal is authorized only while the original detached group
 * leader remains observable with its exact captured start identity. A
 * leaderless descendant group is residual-unknown, not an exception: without
 * continuous original-member identity, reconciliation must fail closed.
 */
function hasContinuouslyVerifiedManagedProviderLeader(
  identity: HostRunProcessIdentity,
  rows: ManagedHostRunProcessGroupRow[],
): boolean {
  if (!isSafeIsolatedProviderProcessGroup(identity)) return false;
  const leader = rows.find(row => row.pid === identity.pid);
  return leader !== undefined
    && leader.pgid === identity.pgid
    && (leader.sessionId === identity.pgid
      || (process.platform === 'darwin' && leader.sessionId === null
        && leader.sessionIdSource === 'darwin-session-unavailable'))
    && leader.start === identity.startFingerprint;
}

export async function reapManagedHostRunProviderProcess(
  identity: HostRunProcessIdentity | null,
  ops: ManagedHostRunProcessGroupOps = DEFAULT_PROCESS_GROUP_OPS,
): Promise<HostRunProcessCleanup> {
  if (!isSafeIsolatedProviderProcessGroup(identity)) {
    return AMBIGUOUS_PROCESS_CLEANUP;
  }
  let rows = ops.rows(identity.pgid);
  if (rows === null) return AMBIGUOUS_PROCESS_CLEANUP;
  if (rows.length === 0) return REAPED_WITHOUT_SIGNAL;
  if (!hasContinuouslyVerifiedManagedProviderLeader(identity, rows)) return AMBIGUOUS_PROCESS_CLEANUP;

  let termSent = false;
  try {
    ops.signal(identity.pgid, 'SIGTERM');
    termSent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return AMBIGUOUS_PROCESS_CLEANUP;
  }
  await ops.wait(250);
  rows = ops.rows(identity.pgid);
  if (rows === null) return { termSent, killSent: false, reaped: false, residualProcessGroup: true };
  if (rows.length === 0) return { termSent, killSent: false, reaped: true, residualProcessGroup: false };
  if (!hasContinuouslyVerifiedManagedProviderLeader(identity, rows)) {
    return { termSent, killSent: false, reaped: false, residualProcessGroup: true };
  }
  let killSent = false;
  try {
    ops.signal(identity.pgid, 'SIGKILL');
    killSent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return { termSent, killSent, reaped: false, residualProcessGroup: true };
    }
  }
  await ops.wait(250);
  rows = ops.rows(identity.pgid);
  const reaped = rows !== null && rows.length === 0;
  return { termSent, killSent, reaped, residualProcessGroup: !reaped };
}

async function reconcileManagedHostRunUnlocked(
  paths: ManagedHostRunPaths,
  now: number,
  processGroupOps: ManagedHostRunProcessGroupOps = DEFAULT_PROCESS_GROUP_OPS,
): Promise<void> {
  recoverPendingSnapshotEventTransition(paths);
  // A terminal written by an older worker or a prior interrupted cleanup can
  // still have its cwd-local Claude leaf. Reconciliation is the durable owner
  // of that one-shot cleanup, not merely the worker's in-process finally.
  const existingTerminal = readTerminal(paths);
  if (existingTerminal) {
    cleanupManagedClaudePromptForTerminal(paths);
    cleanupManagedReviewScratchForTerminal(paths, existingTerminal);
    return;
  }
  const spec = readManagedHostRunSpec(paths).value;
  const fenceLaunchBeforeTerminal = (): 'revoked' | 'granted' | 'spawned' => withTerminalAuthorityLock(paths, () => {
    const current = readManagedHostRunSnapshot(paths);
    const state = current.providerLaunchState
      ?? (current.providerIdentity ? 'spawned' : current.state === 'submitted' ? 'pending' : 'granted');
    if (state === 'pending' || state === 'revoked') {
      if (state === 'pending') {
        updateSnapshotUnlocked(paths, value => ({ ...value, providerLaunchState: 'revoked' }));
      }
      return 'revoked';
    }
    return state;
  });
  if (now >= Date.parse(spec.deadlineAt)) {
    const request = ensureCancelRequest(paths, spec.runId, 'absolute_deadline_exceeded', now);
    // Give a healthy worker a short cooperative window. A genuinely wedged
    // worker cannot hold the status API forever: after the grace, the next touch
    // reconciles against the recorded provider identity and writes an honest
    // terminal even when replacement safety cannot be proven.
    if (now - Date.parse(request.requestedAt) < 250) return;
    const launchState = fenceLaunchBeforeTerminal();
    const fencedSnapshot = readManagedHostRunSnapshot(paths);
    // The worker can be between its durable launch grant and provider identity
    // publication. Bare worker PIDs are not safe authority (they can be reused),
    // so never signal one here. A live worker gets a bounded cooperative window;
    // after it expires the ambiguous cleanup terminal records residual risk
    // rather than leaving status polling wedged forever.
    if (launchState === 'granted'
      && fencedSnapshot.providerIdentity === null
      && fencedSnapshot.workerPid !== null
      && pidAlive(fencedSnapshot.workerPid)
      && now - Date.parse(request.requestedAt) < MANAGED_HOST_RUN_PREIDENTITY_RECOVERY_GRACE_MS) return;
    const cleanup = launchState === 'revoked'
      ? REAPED_WITHOUT_SIGNAL
      : fencedSnapshot.providerIdentity
        ? await reapManagedHostRunProviderProcess(fencedSnapshot.providerIdentity, processGroupOps)
        : AMBIGUOUS_PROCESS_CLEANUP;
    writeTerminal(
      paths,
      'timed_out',
      'absolute_deadline_exceeded',
      cleanupIsReplacementSafe(cleanup),
      null,
      now,
      cleanup,
    );
    return;
  }
  const cancel = readCancelRequest(paths);
  if (cancel && now - Date.parse(cancel.requestedAt) >= 250) {
    const launchState = fenceLaunchBeforeTerminal();
    const fencedSnapshot = readManagedHostRunSnapshot(paths);
    if (launchState === 'granted'
      && fencedSnapshot.providerIdentity === null
      && fencedSnapshot.workerPid !== null
      && pidAlive(fencedSnapshot.workerPid)
      && now - Date.parse(cancel.requestedAt) < MANAGED_HOST_RUN_PREIDENTITY_RECOVERY_GRACE_MS) return;
    const cleanup = launchState === 'revoked'
      ? REAPED_WITHOUT_SIGNAL
      : fencedSnapshot.providerIdentity
        ? await reapManagedHostRunProviderProcess(fencedSnapshot.providerIdentity, processGroupOps)
        : AMBIGUOUS_PROCESS_CLEANUP;
    const terminal = classifyManagedHostRunCancellation(cancel.reason);
    writeTerminal(
      paths,
      terminal.state,
      terminal.reason,
      cleanupIsReplacementSafe(cleanup),
      null,
      now,
      cleanup,
    );
  }
}

async function reconcileManagedHostRun(
  paths: ManagedHostRunPaths,
  now: number,
  processGroupOps: ManagedHostRunProcessGroupOps = DEFAULT_PROCESS_GROUP_OPS,
): Promise<void> {
  await withManagedReconcileLock(paths, async () => {
    await reconcileManagedHostRunUnlocked(paths, now, processGroupOps);
  });
}

/** Independent of the submitting model and provider worker process. */
export async function runManagedHostRunSupervisor(
  request: ManagedHostRunWorkerRequest,
  onReady: () => void = () => {},
): Promise<void> {
  const paths = pathsFor(request.root, request.runId);
  // Validate the immutable spec/owner binding before reporting launch readiness.
  recoverAndProjectManagedHostRun(paths);
  onReady();
  let abnormal: {code:ManagedSupervisionCode; since:number} | null = null;
  while (existsSync(paths.spec)) {
    let terminal = false;
    try {
      terminal = await withManagedReconcileLock(paths, async () => {
      const run = recoverAndProjectManagedHostRun(paths);
      if (run.terminal) {
        await reconcileManagedHostRunUnlocked(paths, Date.now());
        return true;
      }
      if (run.workerPid !== null && !pidAlive(run.workerPid)) {
        ensureCancelRequest(paths, request.runId, MANAGED_SUPERVISOR_RUNTIME_POLICY.orphanReason, Date.now());
      }
      // Reuse the existing launch fence, fingerprint-bound TERM/KILL/reap and
      // exclusive terminal writer. Never signal a bare worker PID.
      await reconcileManagedHostRunUnlocked(paths, Date.now());
      if (!readTerminal(paths)) {
        const observed = readManagedHostRunSnapshot(paths);
        const now = Date.now();
        let code: ManagedSupervisionCode | null = null;
        if (observed.providerClosedAt) {
          if (now-Date.parse(observed.providerClosedAt) >= MANAGED_SUPERVISOR_RUNTIME_POLICY.stalledStageMs) {
            code = 'result_finalization_stalled';
          }
        } else if (observed.providerIdentity) {
          const identity = observed.providerIdentity;
          const rows = identity.pgid === null ? null : processGroupRows(identity.pgid);
          const leader = rows?.find(row => row.pid === identity.pid);
          if (rows === null) code = 'provider_probe_unavailable';
          else if (!leader || leader.processState?.startsWith('Z')) code = 'provider_missing';
          else if (!identity.startFingerprint || leader.start !== identity.startFingerprint) code = 'provider_identity_changed';
        } else if (now-Date.parse(observed.createdAt) >= MANAGED_SUPERVISOR_RUNTIME_POLICY.stalledStageMs) {
          code = 'provider_launch_stalled';
        }
        if (!code) abnormal = null;
        else if (abnormal?.code !== code) abnormal = {code,since:now};
        const diagnostic = abnormal && now-abnormal.since >= MANAGED_SUPERVISOR_RUNTIME_POLICY.diagnosticGraceMs
          ? {code:abnormal.code,observedAt:new Date(abnormal.since).toISOString(),action:managedSupervisionAction(abnormal.code)}
          : null;
        if ((observed.supervisionDiagnostic?.code ?? null) !== (diagnostic?.code ?? null)) {
          updateSnapshotAndAppendEvent(paths, current => {
            // A provider close or new identity observed during ps invalidates
            // this sample; it must not overwrite the worker's newer stage.
            if (current.providerClosedAt !== observed.providerClosedAt
              || canonicalJson(current.providerIdentity) !== canonicalJson(observed.providerIdentity)
              || (current.supervisionDiagnostic?.code ?? null) === (diagnostic?.code ?? null)) return null;
            return {...current,generation:current.generation+1,supervisionDiagnostic:diagnostic};
          }, {schemaVersion:MANAGED_HOST_RUN_SCHEMA_VERSION,runId:request.runId,
            at:new Date(now).toISOString(),type:'supervision_diagnostic',detail:{diagnostic}});
        }
      }
      return readTerminal(paths) !== null;
      });
    } catch (error) {
      // Contention is temporary, not a reason to abandon this run's owner.
      // Integrity and IO failures still surface instead of becoming silent retries.
      if (!(error instanceof ManagedReconcileBusyError)) throw error;
    }
    if (terminal) return;
    await sleep(MANAGED_SUPERVISOR_RUNTIME_POLICY.pollIntervalMs);
  }
}

export async function getManagedHostRunStatus(args: {
  root: string;
  runId: string;
  afterGeneration?: number;
  waitMs?: number;
  /** Internal handler-smoke seam; production omits this and retains the 30s cap. */
  maxWaitMs?: number;
  /** Internal process-smoke clock seam; production always uses Date.now. */
  now?: () => number;
}): Promise<ManagedHostRunStatusResult> {
  const paths = pathsFor(args.root, args.runId);
  if (!existsSync(paths.spec)) throw new Error(`managed host run not found: ${args.runId}`);
  const waitMs = Math.min(
    boundedManagedHostRunStatusWaitMs(args.waitMs),
    boundedManagedHostRunStatusWaitMs(args.maxWaitMs ?? MANAGED_HOST_RUN_STATUS_WAIT_MAX_MS),
  );
  let run = projectionFor(paths);
  const baseline = typeof args.afterGeneration === 'number' ? args.afterGeneration : run.generation;
  const now = args.now ?? Date.now;
  const deadline = now() + waitMs;
  while (true) {
    run = projectionFor(paths);
    // A cursor acknowledges terminal delivery as well as provider progress.
    // A new observer still receives an already completed run immediately.
    const changed = run.generation !== baseline
      || (args.afterGeneration === undefined && run.terminal !== null);
    if (changed || now() >= deadline || waitMs === 0) {
      return {
        schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
        changed,
        run,
        receipt: run.terminal ? managedHostRunReceipt(args.root, args.runId) : null,
      };
    }
    await sleep(Math.min(50, Math.max(1, deadline - now())));
  }
}

/** Explicit recovery owner entry point; observation never invokes this operation. */
export async function recoverManagedHostRun(args: {
  root: string;
  runId: string;
  afterGeneration?: number;
  waitMs?: number;
  now?: () => number;
  processGroupOps?: ManagedHostRunProcessGroupOps;
}): Promise<ManagedHostRunStatusResult> {
  const paths = pathsFor(args.root, args.runId);
  if (!existsSync(paths.spec)) throw new Error(`managed host run not found: ${args.runId}`);
  const deadline = Date.now() + boundedManagedHostRunStatusWaitMs(args.waitMs);
  do {
    await reconcileManagedHostRun(paths, (args.now ?? Date.now)(), args.processGroupOps);
    if (readTerminal(paths) || Date.now() >= deadline) break;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (true);
  return getManagedHostRunStatus({root:args.root, runId:args.runId, afterGeneration:args.afterGeneration});
}

export function boundedManagedHostRunStatusWaitMs(waitMs: number | undefined): number {
  return boundedPositiveMs(waitMs, 0, MANAGED_HOST_RUN_STATUS_WAIT_MAX_MS);
}

export interface ManagedHostRunWaitTarget {
  runId: string;
  afterGeneration?: number;
}

/** One bounded observation loop, with no abandoned per-run long polls. */
export async function waitManagedHostRuns(args: {
  root: string;
  targets: ManagedHostRunWaitTarget[];
  waitMs?: number;
  maxWaitMs?: number;
}): Promise<{ schemaVersion: typeof MANAGED_HOST_RUN_SCHEMA_VERSION; changed: boolean; runs: ManagedHostRunStatusResult[] }> {
  if (!Array.isArray(args.targets) || args.targets.length < 1 || args.targets.length > 32) {
    throw new Error('host_run_status: targets must contain 1 to 32 runs');
  }
  const seen = new Set<string>();
  const targets = args.targets.map(target => {
    if (!target || typeof target.runId !== 'string' || !target.runId.trim()) {
      throw new Error('host_run_status: each target requires runId');
    }
    const runId = target.runId.trim();
    if (seen.has(runId)) throw new Error(`host_run_status: duplicate target ${runId}`);
    seen.add(runId);
    if (target.afterGeneration !== undefined
      && (!Number.isSafeInteger(target.afterGeneration) || target.afterGeneration < 0)) {
      throw new Error('host_run_status: afterGeneration must be a nonnegative safe integer');
    }
    const paths = pathsFor(args.root, runId);
    if (!existsSync(paths.spec)) throw new Error(`managed host run not found: ${runId}`);
    return { runId, afterGeneration: target.afterGeneration };
  });
  const waitMs = Math.min(boundedManagedHostRunStatusWaitMs(args.waitMs),
    boundedManagedHostRunStatusWaitMs(args.maxWaitMs ?? MANAGED_HOST_RUN_STATUS_WAIT_MAX_MS));
  const deadline = Date.now() + waitMs;
  const baselines = new Map<string, number>();
  while (true) {
    const runs = await Promise.all(targets.map(async target => {
      const status = await getManagedHostRunStatus({ root: args.root, runId: target.runId });
      if (!baselines.has(target.runId)) {
        baselines.set(target.runId, target.afterGeneration ?? status.run.generation);
      }
      // An explicit cursor acknowledges terminal delivery as well as progress.
      // With no cursor, an already terminal run is immediately actionable.
      const changed = status.run.generation !== baselines.get(target.runId)
        || (target.afterGeneration === undefined && status.run.terminal !== null);
      return { ...status, changed };
    }));
    const changed = runs.some(run => run.changed);
    if (changed || Date.now() >= deadline) {
      return { schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION, changed, runs };
    }
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}

export async function cancelManagedHostRun(args: {
  root: string;
  runId: string;
  reason?: string;
}): Promise<ManagedHostRunProjection> {
  const paths = pathsFor(args.root, args.runId);
  if (!existsSync(paths.spec)) throw new Error(`managed host run not found: ${args.runId}`);
  recoverAndProjectManagedHostRun(paths);
  if (!readTerminal(paths)) ensureCancelRequest(paths, args.runId, args.reason ?? 'operator_cancelled', Date.now());
  await reconcileManagedHostRun(paths, Date.now());
  return projectionFor(paths);
}

export function readManagedHostRunOutput(args: {
  root: string;
  runId: string;
  afterSequence?: number;
  /** Test-only observer for bounded journal reads; never affects output content. */
  journalReadObserver?: (bytes: number) => void;
}): ManagedHostRunOutputResult {
  const paths = pathsFor(args.root, args.runId);
  if (!existsSync(paths.spec)) throw new Error(`managed host run not found: ${args.runId}`);
  projectionFor(paths);
  const terminalBeforeRead = readTerminal(paths);
  if (terminalBeforeRead) assertSealedManagedHostRunArtifacts(paths, terminalBeforeRead);
  const after = Math.max(0, Math.floor(args.afterSequence ?? 0));
  const snapshot = readManagedHostRunSnapshot(paths);
  const retained = readIncrementalManagedHostRunOutputJournal({
    path: paths.output,
    afterSequence: after,
    terminalLiveOutputDigest: terminalBeforeRead?.liveOutputDigest ?? null,
    terminalGeneration: terminalBeforeRead?.generation ?? null,
    onRead: args.journalReadObserver,
  });
  const frames = retained.frames;
  const hasMore = retained.hasMore;
  const nextSequence = frames.length > 0
    ? frames[frames.length - 1]!.sequence
    : snapshot.outputTruncated
      ? Math.max(after, snapshot.outputSequence)
      : after;
  const terminalAfterRead = readTerminal(paths);
  if (terminalAfterRead) assertSealedManagedHostRunArtifacts(paths, terminalAfterRead);
  return {
    schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
    runId: args.runId,
    frames,
    nextSequence,
    hasMore,
    truncated: (snapshot.outputTruncated ?? false) || retained.retainedTruncated,
  };
}

export function readManagedHostRunResult(root: string, runId: string): HostRunResult | null {
  const paths = pathsFor(root, runId);
  if (existsSync(paths.spec)) projectionFor(paths);
  return existsSync(paths.result) ? readJson<HostRunResult>(paths.result) : null;
}

export function readManagedHostRunBinding(root: string, runId: string): ManagedHostRunBindingProjection {
  const paths = pathsFor(root, runId);
  // B-137a:F-127 — same archive-backed fallback managedHostRunReceipt already
  // has. Terminal-retention GC archives the receipt and then deletes the run
  // directory, so without this the spec/owner reads below throw ENOENT and
  // verifyManagedReviewEvidence fails closed on evidence that was legitimately
  // imported while the run still existed. Verified empirically: after
  // removeManagedHostRunRuntime the pre-fix reader threw ENOENT.
  if (!existsSync(paths.spec)) {
    const archivePath = managedHostRunReceiptArchivePath(root, runId);
    if (existsSync(archivePath)) {
      const archive = readJson<ManagedHostRunReceiptArchive>(archivePath);
      if (!isManagedHostRunReceiptArchiveSchema(archive.schemaVersion) || archive.runId !== runId) {
        throw new Error(`managed host run ${runId}: archived binding is corrupt`);
      }
      return archivedBindingProjection(archive, runId);
    }
  }
  return liveBindingProjection(paths);
}

/** Resolve the immutable Story subject used by the CLI ownership gate. */
export function managedHostRunStoryIdForOwnership(root: string, runId: string): string | null {
  const paths = pathsFor(root, runId);
  if (!existsSync(paths.spec) || !existsSync(paths.owner)) return null;
  const { text: specText, value: spec } = readManagedHostRunSpec(paths);
  const owner = readManagedHostRunOwner(paths);
  if (spec.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
    || owner.schemaVersion !== MANAGED_HOST_RUN_SCHEMA_VERSION
    || spec.runId !== paths.expectedRunId
    || owner.runId !== paths.expectedRunId
    || owner.specDigest !== sha256(specText)) {
    throw new Error(`managed host run ${runId}: immutable ownership subject binding mismatch`);
  }
  return typeof spec.storyId === 'string' && spec.storyId.trim().length > 0 ? spec.storyId.trim() : null;
}

type ManagedReviewFinalProposalInput = Omit<ManagedReviewEvidenceProposal, 'schemaVersion' | 'runId' | 'authoredAt'>;

function readValidManagedReviewEvidenceProposal(
  root: string,
  runId: string,
  spec: ManagedHostRunSpec,
): ManagedReviewEvidenceProposal | null {
  try {
    const proposal = readManagedReviewEvidenceProposal(root, runId);
    if (!proposal
      || proposal.schemaVersion !== 'lattice.managed_review_evidence_proposal.v1'
      || proposal.runId !== runId
      || proposal.storyId !== spec.storyId
      || proposal.providerAgent !== spec.agentType
      || proposal.lane !== spec.lane
      || proposal.reviewRunId !== spec.reviewRunId
      || !Number.isFinite(Date.parse(proposal.authoredAt))) {
      return null;
    }
    if (proposal.conclusion === 'pass') {
      if (typeof proposal.note !== 'string' || proposal.note.trim().length < 10
        || (proposal.findings !== undefined && (!Array.isArray(proposal.findings) || proposal.findings.length > 0))) {
        return null;
      }
    } else if (proposal.conclusion === 'findings') {
      if (typeof proposal.note === 'string' && proposal.note.trim().length > 0
        || !Array.isArray(proposal.findings)
        || proposal.findings.length === 0
        || !proposal.findings.every(isStrictManagedReviewFindingProposal)) {
        return null;
      }
    } else {
      return null;
    }
    if (!isManagedInventoryCriticEnvelopeValid(proposal.inventoryCritic, proposal.lane, proposal.providerAgent, proposal.findings?.length ?? 0)) return null;
    if (!hasRequiredManagedReviewReadEvidence(proposal.readManifest, proposal.readLog)) return null;
    normalizeReviewerReadManifest(proposal.readManifest);
    normalizeReviewerReadLogEvidence(proposal.readLog);
    if (proposal.readDiagnostics !== undefined) normalizeReviewerReadDiagnostics(proposal.readDiagnostics);
    return proposal;
  } catch {
    return null;
  }
}

function parseManagedReviewFinalProposal(result: HostRunResult): ManagedReviewFinalProposalInput {
  if (result.finalAssistantResultTruncated) {
    throw new Error('managed_review_final_result_oversize');
  }
  if (result.finalAssistantResultCount > 1) {
    throw new Error('managed_review_final_result_multiple');
  }
  if (result.finalAssistantResultCount !== 1 || result.finalAssistantResult === null) {
    throw new Error('managed_review_final_result_missing');
  }
  const classification = classifyManagedReviewFinalEnvelope(result.finalAssistantResult);
  if (classification.kind !== 'valid') {
    throw new Error(`managed_review_final_result_malformed${classification.kind === 'malformed' && classification.reason ? `:${classification.reason}` : ''}`);
  }
  const envelope = classification.envelope;
  const conclusion = envelope.conclusion;
  return {
    storyId: envelope.storyId,
    providerAgent: envelope.providerAgent,
    lane: envelope.lane,
    reviewRunId: envelope.reviewRunId,
    conclusion,
    ...(conclusion === 'pass' ? { note: envelope.note as string | undefined } : {
      findings: envelope.findings as ManagedReviewEvidenceFindingProposal[] | undefined,
    }),
    ...(envelope.inventoryCritic !== undefined ? { inventoryCritic: envelope.inventoryCritic } : {}),
    readManifest: envelope.readManifest as ReviewerReadManifest,
    readLog: envelope.readLog as unknown as ReviewerReadLogEvidence,
    ...(envelope.readDiagnostics !== undefined ? { readDiagnostics: envelope.readDiagnostics as ReviewerReadDiagnostic[] } : {}),
  };
}

export function writeManagedReviewEvidenceProposal(args: {
  root: string;
  runId: string;
  proposal: Omit<ManagedReviewEvidenceProposal, 'schemaVersion' | 'runId' | 'authoredAt'>;
  environment?: NodeJS.ProcessEnv;
  providerInvocationPid?: number;
  providerInvocationAttestation?: ManagedReviewProposalInvocationAttestation;
}): ManagedReviewEvidenceProposal {
  // Compatibility ingress is provider-authored input too. Keep it under the
  // same bounded final-envelope ceiling as the canonical adapter path before
  // any filesystem or authority side effect.
  if (Buffer.byteLength(canonicalJson(args.proposal), 'utf8') > HOST_RUN_FINAL_ASSISTANT_RESULT_CAP) {
    throw new Error(`managed_review_proposal_set: proposal exceeds ${HOST_RUN_FINAL_ASSISTANT_RESULT_CAP} byte managed final envelope cap`);
  }
  const paths = pathsFor(args.root, args.runId);
  const spec = readManagedHostRunSpec(paths).value;
  const owner = readManagedHostRunOwner(paths);
  const snapshot = readManagedHostRunSnapshot(paths);
  const environment = args.environment ?? process.env;
  if (args.providerInvocationPid === undefined
    && args.providerInvocationAttestation === undefined
    && environment.LATTICE_MANAGED_HOST_RUN_ID !== args.runId) {
    throw new Error('managed_review_proposal_set: active managed-run capability is missing or mismatched');
  }
  if (readTerminal(paths) || snapshot.state !== 'running') {
    throw new Error('managed_review_proposal_set: proposal is accepted only while the managed provider run is active');
  }
  if (spec.profile !== 'managed_reviewer' || !spec.reviewBinding) {
    throw new Error('managed_review_proposal_set: run is not a formal managed_reviewer execution');
  }
  if (!spec.storyId || !spec.reviewRunId || !spec.lane) {
    throw new Error('managed_review_proposal_set: managed reviewer run is not bound to storyId/reviewRunId/lane');
  }
  const environmentAuthorized = (
    environment.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY === undefined
      ? false
      : sha256(environment.LATTICE_MANAGED_REVIEW_PROPOSAL_CAPABILITY) === owner.capabilityDigest
        && environment.PROOF_OR_STOP_AGENT === spec.agentType
  );
  const providerInvocationAuthorized = args.providerInvocationPid !== undefined
    && providerInvocationMatches(paths, {
      storyId: args.proposal.storyId,
      providerAgent: args.proposal.providerAgent,
      lane: args.proposal.lane,
      reviewRunId: args.proposal.reviewRunId,
    }, args.providerInvocationPid);
  const descriptorInvocationAuthorized = args.providerInvocationAttestation !== undefined
    && verifyManagedReviewProposalInvocationAttestation(paths, {
      storyId: args.proposal.storyId,
      providerAgent: args.proposal.providerAgent,
      lane: args.proposal.lane,
      reviewRunId: args.proposal.reviewRunId,
    }, args.providerInvocationAttestation);
  if (!environmentAuthorized && !providerInvocationAuthorized && !descriptorInvocationAuthorized) {
    throw new Error('managed_review_proposal_set: provider proposal capability or agent identity is missing or mismatched');
  }
  if (
    args.proposal.storyId !== spec.storyId
    || args.proposal.reviewRunId !== spec.reviewRunId
    || args.proposal.lane !== spec.lane
    || args.proposal.providerAgent !== spec.agentType
  ) {
    throw new Error('managed_review_proposal_set: proposal provenance does not match the sealed managed run spec');
  }
  if (!isManagedInventoryCriticEnvelopeValid(args.proposal.inventoryCritic, spec.lane, spec.agentType, args.proposal.findings?.length ?? 0)) {
    throw new Error('managed_review_proposal_set: invalid inventory critic transport');
  }
  const expectedFullScanReason = spec.reviewBinding.fullScanEscalationReason;
  if (expectedFullScanReason !== undefined) {
    const rawManifest = args.proposal.readManifest;
    const rawReason = rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest)
      ? (rawManifest as unknown as Record<string, unknown>).scanEscalationReason
      : undefined;
    if (rawReason !== expectedFullScanReason) {
      throw new Error('managed_review_proposal_set: full-scan readManifest.scanEscalationReason must copy the sealed candidate artifact reason byte-for-byte');
    }
  }
  const conclusion = args.proposal.conclusion;
  const findings = args.proposal.findings ?? [];
  const note = args.proposal.note?.trim() ?? '';
  if (conclusion === 'pass') {
    if (note.length < 10 || findings.length > 0) {
      throw new Error('managed_review_proposal_set: pass requires note >= 10 chars and no findings');
    }
  } else if (conclusion === 'findings') {
    // The provider-owned final envelope allows a non-empty explanatory note.
    // It is diagnostic-only and deliberately omitted from the immutable
    // findings proposal below, never promoted to formal finding evidence.
    // Reject whitespace-only notes rather than silently normalizing a malformed
    // envelope into a valid proposal.
    if (findings.length === 0 || (args.proposal.note !== undefined && note.length < 10)) {
      throw new Error('managed_review_proposal_set: findings conclusion requires at least one finding and an optional trimmed diagnostic note >= 10 chars');
    }
  } else {
    throw new Error('managed_review_proposal_set: conclusion must be pass or findings');
  }
  const normalizedFindings = findings.map((finding, index) => {
    if (!isStrictManagedReviewFindingProposal(finding)) {
      throw new Error(`managed_review_proposal_set: findings[${index}] must match the strict managed finding schema`);
    }
    return {
      ...finding,
      desc: finding.desc.trim(),
      ...(finding.files ? { files: [...new Set(finding.files.map(value => value.trim()).filter(Boolean))].sort() } : {}),
    };
  });
  if (!hasRequiredManagedReviewReadEvidence(args.proposal.readManifest, args.proposal.readLog)) {
    throw new Error(
      'managed_review_proposal_set: non-empty readManifest/readLog plus candidateSpecSetDigest and corpusDigest are required',
    );
  }
  const proposal: ManagedReviewEvidenceProposal = {
    schemaVersion: 'lattice.managed_review_evidence_proposal.v1',
    runId: args.runId,
    storyId: spec.storyId,
    providerAgent: spec.agentType,
    lane: spec.lane,
    reviewRunId: spec.reviewRunId,
    authoredAt: new Date().toISOString(),
    conclusion,
    ...(conclusion === 'pass' ? { note } : { findings: normalizedFindings }),
    ...(args.proposal.inventoryCritic !== undefined ? { inventoryCritic: structuredClone(args.proposal.inventoryCritic) } : {}),
    readManifest: normalizeReviewerReadManifest(args.proposal.readManifest),
    readLog: normalizeReviewerReadLogEvidence(args.proposal.readLog),
    ...(args.proposal.readDiagnostics ? { readDiagnostics: normalizeReviewerReadDiagnostics(args.proposal.readDiagnostics) } : {}),
  };
  withTerminalAuthorityLock(paths, () => {
    if (readTerminal(paths)) {
      throw new Error('managed_review_proposal_set: proposal is accepted only while the managed provider run is active');
    }
    if (!writeExclusive(paths.evidenceProposal, proposal)) {
      throw new Error('managed_review_proposal_set: this run already has an immutable evidence proposal');
    }
    appendFileSync(paths.events, `${canonicalJson({
      schemaVersion: MANAGED_HOST_RUN_SCHEMA_VERSION,
      runId: args.runId,
      at: proposal.authoredAt,
      type: 'review_evidence_proposed',
      detail: { conclusion, proposalDigest: digestFile(paths.evidenceProposal) },
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  });
  return proposal;
}

export function readManagedReviewEvidenceProposal(root: string, runId: string): ManagedReviewEvidenceProposal | null {
  const paths = pathsFor(root, runId);
  if (existsSync(paths.evidenceProposal)) {
    projectionFor(paths);
    const proposal = readJson<ManagedReviewEvidenceProposal>(paths.evidenceProposal);
    assertArtifactRunId(paths, 'evidence proposal', proposal.runId);
    return proposal;
  }
  // B-137a:F-127 — archive fallback for a run whose directory was reclaimed by
  // terminal-retention GC. The archived body is only accepted when it re-digests
  // to the SEALED receipt's evidenceProposalDigest, so a tampered or swapped
  // archive is rejected instead of trusted; a missing spec.json distinguishes a
  // genuinely reclaimed run from a merely absent proposal on a live run.
  if (!existsSync(paths.spec)) {
    const archivePath = managedHostRunReceiptArchivePath(root, runId);
    if (existsSync(archivePath)) {
      const archive = readJson<ManagedHostRunReceiptArchive>(archivePath);
      if (!isManagedHostRunReceiptArchiveSchema(archive.schemaVersion) || archive.runId !== runId) {
        throw new Error(`managed host run ${runId}: archived proposal is corrupt`);
      }
      const archivedText = archive.evidenceProposalText ?? null;
      if (archivedText === null) return null;
      const expected = archive.receipt.evidenceProposalDigest;
      if (expected === null || sha256(archivedText) !== expected) {
        throw new Error(
          `managed host run ${runId}: archived proposal does not match the sealed receipt digest`,
        );
      }
      const proposal = JSON.parse(archivedText) as ManagedReviewEvidenceProposal;
      assertArtifactRunId(paths, 'archived evidence proposal', proposal.runId);
      return proposal;
    }
  }
  return null;
}

function importSealMatchesLiveContract(runId: string, bindingText: string, sealText: string): boolean {
  try {
    const binding = JSON.parse(bindingText) as Record<string, unknown>;
    const seal = JSON.parse(sealText) as Record<string, unknown>;
    return binding.runId === runId
      && seal.schemaVersion === 'lattice.managed_review_evidence_binding_seal.v1'
      && seal.runId === runId
      && seal.bindingDigest === sha256(bindingText);
  } catch {
    return false;
  }
}

/**
 * B-137a:F-127 — the import-seal pair for a run, archive-backed so an imported
 * evidence record stays verifiable after terminal-retention GC. Returns the raw
 * texts (the caller compares them exactly as it would the on-disk files) or null
 * when neither the live files nor an archive carrying them exist. An archived
 * pair is admitted only after the binding re-digests to evidenceBindingDigest
 * and the seal's schemaVersion, runId, and bindingDigest match the live path.
 */
export function readManagedReviewImportSeal(
  root: string,
  runId: string,
): { bindingText: string; sealText: string } | null {
  const paths = pathsFor(root, runId);
  if (existsSync(paths.evidenceBinding) && existsSync(paths.evidenceBindingSeal)) {
    projectionFor(paths);
    const bindingText = readFileSync(paths.evidenceBinding, 'utf8');
    const sealText = readFileSync(paths.evidenceBindingSeal, 'utf8');
    if (!importSealMatchesLiveContract(paths.expectedRunId, bindingText, sealText)) {
      throw new Error(`managed host run ${runId}: live import seal schema, runId, or bindingDigest is invalid`);
    }
    return { bindingText, sealText };
  }
  if (!existsSync(paths.spec)) {
    const archivePath = managedHostRunReceiptArchivePath(root, runId);
    if (existsSync(archivePath)) {
      const archive = readJson<ManagedHostRunReceiptArchive>(archivePath);
      if (!isManagedHostRunReceiptArchiveSchema(archive.schemaVersion) || archive.runId !== runId) {
        throw new Error(`managed host run ${runId}: archived import seal is corrupt`);
      }
      const bindingText = archive.evidenceBindingText ?? null;
      const sealText = archive.evidenceBindingSealText ?? null;
      if (bindingText === null || sealText === null) return null;
      const expected = archive.evidenceBindingDigest;
      if (expected === null || sha256(bindingText) !== expected) {
        throw new Error(
          `managed host run ${runId}: archived import seal does not match its recorded digest`,
        );
      }
      if (!importSealMatchesLiveContract(runId, bindingText, sealText)) {
        throw new Error(
          `managed host run ${runId}: archived import seal schema, runId, or bindingDigest is invalid`,
        );
      }
      return { bindingText, sealText };
    }
  }
  return null;
}

export function managedHostRunReceipt(root: string, runId: string): ManagedHostRunReceipt {
  const paths = pathsFor(root, runId);
  const terminal = readTerminal(paths);
  if (!terminal) {
    const archivePath = managedHostRunReceiptArchivePath(root, runId);
    if (existsSync(archivePath)) {
      const archive = readJson<ManagedHostRunReceiptArchive>(archivePath);
      if (!archive.receipt
        || !isManagedHostRunReceiptArchiveSchema(archive.schemaVersion)
        || archive.runId !== runId
        || archive.receipt.runId !== runId) {
        throw new Error(`managed host run ${runId}: archived terminal receipt is corrupt`);
      }
      const { receiptId, ...receiptPayload } = archive.receipt;
      if (receiptId !== sha256(canonicalJson(receiptPayload))) {
        throw new Error(`managed host run ${runId}: archived terminal receipt is corrupt`);
      }
      if (archive.binding) archivedBindingProjection(archive, runId);
      return archive.receipt;
    }
    throw new Error(`managed host run ${runId}: terminal receipt is not available`);
  }
  assertSealedManagedHostRunArtifacts(paths, terminal);
  return receiptPayloadFor(paths, terminal);
}

export function verifyManagedDispatchDelivery(args: {
  root: string;
  runId: string;
  storyId: string;
  agentType: string;
}): { valid: true } | { valid: false; reason: string } {
  try {
    const binding = readManagedHostRunBinding(args.root, args.runId);
    if (binding.profile !== 'managed_dispatch'
      || binding.storyId !== args.storyId
      || binding.agentType !== args.agentType) {
      return { valid: false, reason: 'managed dispatch Story/role binding mismatch' };
    }
    const receipt = managedHostRunReceipt(args.root, args.runId);
    if (receipt.state !== 'completed' || !receipt.replacementSafe) {
      return { valid: false, reason: 'managed dispatch terminal receipt is not a safe completion' };
    }
    if (args.agentType === 'proof-or-stop-review-scope-plan') {
      const currentDigest = digestFile(new StoryStore(args.root).storyFilePath(args.storyId, 'scope-check.json'));
      if (!receipt.managedDispatchOutputDigest
        || currentDigest !== receipt.managedDispatchOutputDigest) {
        return { valid: false, reason: 'managed dispatch scope output does not match the completed receipt' };
      }
    }
    if (args.agentType === MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.role) {
      const currentDigest = digestFile(new StoryStore(args.root).storyFilePath(args.storyId, MANAGED_DELIVERY_DISPATCH_RUNTIME_POLICY.artifact));
      if (!receipt.managedDispatchOutputDigest || currentDigest !== receipt.managedDispatchOutputDigest) {
        return { valid: false, reason: 'managed dispatch delivery output does not match the completed receipt' };
      }
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function writeManagedHostRunEvidenceBinding(
  root: string,
  runId: string,
  value: unknown,
  options: { afterBindingWrite?: () => void } = {},
): void {
  const paths = pathsFor(root, runId);
  withTerminalAuthorityLock(paths, () => {
    projectionFor(paths);
    if (!value || typeof value !== 'object' || (value as Record<string, unknown>).runId !== paths.expectedRunId) {
      throw new Error(`managed host run ${runId}: evidence binding runId must match the requested run`);
    }
    const wroteBinding = writeExclusive(paths.evidenceBinding, value);
    if (!wroteBinding) {
      const existing = readFileSync(paths.evidenceBinding, 'utf8').trim();
      if (existing !== canonicalJson(value)) throw new Error(`managed host run ${runId}: evidence already imported with a different binding`);
    }
    options.afterBindingWrite?.();
    const seal = {
      schemaVersion: 'lattice.managed_review_evidence_binding_seal.v1',
      runId,
      bindingDigest: digestFile(paths.evidenceBinding),
    };
    if (!writeExclusive(paths.evidenceBindingSeal, seal)) {
      const existingSeal = readFileSync(paths.evidenceBindingSeal, 'utf8').trim();
      if (existingSeal !== canonicalJson(seal)) {
        throw new Error(`managed host run ${runId}: evidence binding seal does not match the immutable import`);
      }
    }
  });
}

/** Test/repair helper: validates runtime artifacts without mutating them. */
export function inspectManagedHostRunFiles(root: string, runId: string): {
  mode: number;
  hasCapability: boolean;
  hasPrompt: boolean;
  hasTerminal: boolean;
} {
  const paths = pathsFor(root, runId);
  return {
    mode: statSync(paths.dir).mode & 0o777,
    hasCapability: existsSync(paths.capability),
    hasPrompt: existsSync(paths.prompt),
    hasTerminal: existsSync(paths.terminal),
  };
}

function timestampAgeMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

/**
 * Read-only operational projection. It deliberately reports heartbeat and
 * provider progress as separate facts: neither a stale heartbeat nor output
 * silence is promoted to a terminal outcome by this scan.
 */
export function scanManagedHostRunRuntime(
  root: string,
  options: { now?: number; retentionMs?: number } = {},
): ManagedHostRunRuntimeScan {
  const runtimeRoot = managedHostRunsRoot(root);
  const now = options.now ?? Date.now();
  const retentionMs = boundedPositiveMs(
    options.retentionMs,
    MANAGED_HOST_RUN_TERMINAL_RETENTION_MS,
    Number.MAX_SAFE_INTEGER,
  );
  const runs: ManagedHostRunRuntimeDiagnostic[] = [];
  if (existsSync(runtimeRoot)) {
    for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      try {
        assertRunId(runId);
        const paths = pathsFor(root, runId);
        const run = projectionFor(paths);
        const terminalAt = run.terminal?.terminalAt ?? null;
        const terminalAtMs = terminalAt ? Date.parse(terminalAt) : Number.NaN;
        const retentionEligibleAt = Number.isFinite(terminalAtMs)
          ? new Date(terminalAtMs + retentionMs).toISOString()
          : null;
        const hasUnconsumedOneShotInputs = existsSync(paths.capability)
          || existsSync(paths.prompt)
          || existsSync(paths.environment);
        const workerLiveness = run.terminal
          ? 'not-applicable'
          : run.workerPid === null
            ? 'not-started'
            : pidAlive(run.workerPid)
              ? 'alive'
              : 'dead';
        runs.push({
          runId,
          state: run.state,
          workerLiveness,
          workerHeartbeatAt: run.workerHeartbeatAt,
          workerHeartbeatAgeMs: timestampAgeMs(run.workerHeartbeatAt, now),
          providerProgressMode: run.providerProgressMode,
          lastProviderProgressAt: run.lastProviderProgressAt,
          providerProgressAgeMs: timestampAgeMs(run.lastProviderProgressAt, now),
          deadlineAt: run.deadlineAt,
          deadlineExpired: now >= Date.parse(run.deadlineAt),
          cancelRequestedAt: run.cancelRequestedAt,
          replacementSafe: run.replacementSafe,
          residualProcessGroup: run.terminal?.processCleanup?.residualProcessGroup ?? null,
          terminalAt,
          terminalReason: run.terminal?.reason ?? null,
          retentionEligibleAt,
          retentionExpired: !!retentionEligibleAt && now >= Date.parse(retentionEligibleAt),
          hasUnconsumedOneShotInputs,
          managedReviewScratchCleanupDiagnostic: run.managedReviewScratchCleanupDiagnostic,
          error: null,
        });
      } catch (error) {
        const dir = join(runtimeRoot, runId);
        let managedReviewScratchCleanupDiagnostic: ManagedReviewScratchCleanupDiagnostic | null = null;
        try {
          managedReviewScratchCleanupDiagnostic = readManagedReviewScratchCleanupDiagnostic(pathsFor(root, runId));
        } catch {
          // The enclosing error remains the primary corrupt-runtime diagnosis.
        }
        runs.push({
          runId,
          state: 'corrupt',
          workerLiveness: 'unknown',
          workerHeartbeatAt: null,
          workerHeartbeatAgeMs: null,
          providerProgressMode: 'unknown',
          lastProviderProgressAt: null,
          providerProgressAgeMs: null,
          deadlineAt: null,
          deadlineExpired: null,
          cancelRequestedAt: null,
          replacementSafe: null,
          residualProcessGroup: null,
          terminalAt: null,
          terminalReason: null,
          retentionEligibleAt: null,
          retentionExpired: false,
          hasUnconsumedOneShotInputs: existsSync(join(dir, 'input.cap'))
            || existsSync(join(dir, 'input.prompt'))
            || existsSync(join(dir, 'input.env.json')),
          managedReviewScratchCleanupDiagnostic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  runs.sort((left, right) => left.runId.localeCompare(right.runId));
  return {
    root: runtimeRoot,
    retentionMs,
    active: runs.filter(run => !['completed', 'failed', 'cancelled', 'timed_out', 'corrupt'].includes(run.state)).length,
    terminal: runs.filter(run => ['completed', 'failed', 'cancelled', 'timed_out'].includes(run.state)).length,
    corrupt: runs.filter(run => run.state === 'corrupt').length,
    eligibleForGc: runs.filter(run => run.retentionExpired && !run.hasUnconsumedOneShotInputs).length,
    runs,
  };
}

/**
 * B-137a:F-135 — a receipt archive can replace the live runtime only when it
 * can re-verify already-imported evidence after deletion: sealed receipt,
 * binding projection, proposal body, evidence-binding body, and seal
 * schemaVersion/runId/bindingDigest. Null proposal/binding is complete only
 * when the live receipt/digest also says those artifacts were absent.
 */
function isCompleteValidReceiptArchive(
  archive: ManagedHostRunReceiptArchive,
  expected: {
    runId: string;
    receiptId: string;
    evidenceProposalDigest: string | null;
    evidenceBindingDigest: string | null;
  },
): boolean {
  if (!isManagedHostRunReceiptArchiveSchema(archive.schemaVersion)) return false;
  if (archive.runId !== expected.runId) return false;
  const receipt = archive.receipt;
  if (!receipt || receipt.runId !== expected.runId || receipt.receiptId !== expected.receiptId) return false;
  const { receiptId, ...payload } = receipt;
  if (receiptId !== sha256(canonicalJson(payload))) return false;
  if (receipt.evidenceProposalDigest !== expected.evidenceProposalDigest) return false;
  if (!archive.binding || archive.binding.runId !== expected.runId) return false;
  if (typeof receipt.bindingProjectionDigest !== 'string' || receipt.bindingProjectionDigest.length === 0) return false;
  if (bindingProjectionDigestOf(archive.binding) !== receipt.bindingProjectionDigest) return false;

  const proposalText = archive.evidenceProposalText ?? null;
  if (expected.evidenceProposalDigest === null) {
    if (proposalText !== null) return false;
  } else if (proposalText === null || sha256(proposalText) !== expected.evidenceProposalDigest) {
    return false;
  }

  const bindingText = archive.evidenceBindingText ?? null;
  const sealText = archive.evidenceBindingSealText ?? null;
  if (expected.evidenceBindingDigest === null) {
    if (bindingText !== null || sealText !== null) return false;
    if ((archive.evidenceBindingDigest ?? null) !== null) return false;
  } else if (
    bindingText === null
    || sealText === null
    || archive.evidenceBindingDigest !== expected.evidenceBindingDigest
    || sha256(bindingText) !== expected.evidenceBindingDigest
    || !importSealMatchesLiveContract(expected.runId, bindingText, sealText)
  ) {
    return false;
  }
  return true;
}

function persistManagedHostRunReceiptArchive(
  archivePath: string,
  archive: ManagedHostRunReceiptArchive,
  runId: string,
): void {
  const expected = {
    runId,
    receiptId: archive.receipt.receiptId,
    evidenceProposalDigest: archive.receipt.evidenceProposalDigest,
    evidenceBindingDigest: archive.evidenceBindingDigest,
  };
  if (!isCompleteValidReceiptArchive(archive, expected)) {
    throw new Error(`managed host run ${runId}: live artifacts cannot form a complete receipt archive`);
  }
  if (writeExclusive(archivePath, archive)) return;
  let existing: ManagedHostRunReceiptArchive;
  try {
    existing = readJson<ManagedHostRunReceiptArchive>(archivePath);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`managed host run ${runId}: existing archived receipt is corrupt (${cause})`);
  }
  if (existing.receipt?.receiptId !== archive.receipt.receiptId) {
    throw new Error(`managed host run ${runId}: existing archived receipt does not match terminal receipt`);
  }
  if (isCompleteValidReceiptArchive(existing, expected)) return;
  // ReceiptId-only leftovers (crash or pre-F-127) must not keep an incomplete
  // archive and then delete the only complete live artifacts.
  atomicWrite(archivePath, archive);
}

/**
 * Explicit bounded GC used by doctor --repair. Active/corrupt runs and any
 * directory still carrying one-shot secrets are retained fail-closed.
 */
export function pruneExpiredManagedHostRuns(
  root: string,
  options: { now?: number; retentionMs?: number } = {},
): ManagedHostRunGcResult {
  const scan = scanManagedHostRunRuntime(root, options);
  const result: ManagedHostRunGcResult = { removed: [], archivedReceipts: [], retained: [], failed: [] };
  for (const run of scan.runs) {
    if (run.state === 'corrupt') {
      result.retained.push({ runId: run.runId, reason: 'corrupt_runtime_retained_for_manual_review' });
      continue;
    }
    if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(run.state)) {
      result.retained.push({ runId: run.runId, reason: 'active_run_protected' });
      continue;
    }
    if (run.hasUnconsumedOneShotInputs) {
      result.retained.push({ runId: run.runId, reason: 'one_shot_inputs_present_retained' });
      continue;
    }
    if (!run.retentionExpired) {
      result.retained.push({ runId: run.runId, reason: 'within_terminal_retention_window' });
      continue;
    }
    try {
      const paths = pathsFor(root, run.runId);
      // The same verified run-id binding is used for expiry GC, so terminal
      // retention cannot reclaim host-runs/<id> while retaining a plaintext
      // Claude prompt sibling outside that directory.
      cleanupManagedClaudePromptForTerminal(paths);
      const spec = readManagedHostRunSpec(paths).value;
      const terminal = readTerminal(paths);
      if (spec.managedReviewScratch) {
        if (!terminal || !terminalAllowsManagedReviewScratchCleanup(terminal)) {
          result.retained.push({ runId: run.runId, reason: 'managed_review_scratch_retained_until_replacement_safe_terminal' });
          continue;
        }
        // Do not archive/delete the durable run while a marker-bound provider
        // scratch remains registered. A cleanup failure is retryable and must
        // retain both the scratch and its sealed ownership proof plus its
        // operator-visible diagnostic.
        if (!cleanupManagedReviewScratchForTerminal(paths, terminal)) {
          result.retained.push({ runId: run.runId, reason: 'managed_review_scratch_cleanup_failed_retained' });
          continue;
        }
      }
      const archivePath = managedHostRunReceiptArchivePath(root, run.runId);
      mkdirSync(managedHostRunReceiptsRoot(root), { recursive: true, mode: 0o700 });
      const archive: ManagedHostRunReceiptArchive = {
        schemaVersion: MANAGED_HOST_RUN_RECEIPT_ARCHIVE_V2,
        runId: run.runId,
        archivedAt: run.terminalAt ?? new Date(options.now ?? Date.now()).toISOString(),
        receipt: managedHostRunReceipt(root, run.runId),
        evidenceBindingDigest: digestFile(paths.evidenceBinding),
        // B-137a:F-127 — capture the binding BEFORE removeManagedHostRunRuntime
        // deletes spec.json/owner.json, otherwise verifyManagedReviewEvidence
        // can never reconstruct it and every imported receipt for this run turns
        // into managed_receipt_invalid (absent from SUPERSEDED_PASS_ISSUE_CODES,
        // so it hard-blocks REVIEW->TEST -- the F-100 deadlock mechanism).
        binding: readManagedHostRunBinding(root, run.runId),
        // B-137a:F-127 — capture the RAW BYTES before removeManagedHostRunRuntime
        // deletes them. The sealed evidenceProposalDigest is sha256 over the file
        // text, so storing a re-serialized object would not re-digest identically.
        evidenceProposalText: existsSync(paths.evidenceProposal)
          ? readFileSync(paths.evidenceProposal, 'utf8')
          : null,
        evidenceBindingText: existsSync(paths.evidenceBinding)
          ? readFileSync(paths.evidenceBinding, 'utf8')
          : null,
        evidenceBindingSealText: existsSync(paths.evidenceBindingSeal)
          ? readFileSync(paths.evidenceBindingSeal, 'utf8')
          : null,
      };
      persistManagedHostRunReceiptArchive(archivePath, archive, run.runId);
      if (spec.profile === 'cross_host_review_codex') {
        cleanupManagedCrossHostReviewWorktree(spec.root, spec.cwd);
      }
      removeManagedHostRunRuntime(root, run.runId);
      result.removed.push(run.runId);
      result.archivedReceipts.push(run.runId);
    } catch (error) {
      result.failed.push({ runId: run.runId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

/** Used only by bounded repair/cleanup code; never follows caller-provided paths. */
export function removeManagedHostRunRuntime(root: string, runId: string): void {
  rmSync(managedHostRunDirectory(root, runId), { recursive: true, force: true });
}


function isIsolatedReviewerProfile(profile: string | null | undefined): boolean {
  return profile === 'managed_reviewer' || profile === ACCEPTANCE_REVIEW_PROFILE;
}

/** Pin this key in the signed amendment review attempt before consuming any verdict. */
export function managedAcceptanceReviewPublicKey(root: string, runId: string): string {
  const paths = pathsFor(root, runId);
  const { value: spec, text } = readManagedHostRunSpec(paths);
  const owner = readManagedHostRunOwner(paths);
  if (spec.profile !== ACCEPTANCE_REVIEW_PROFILE || spec.phase !== 'DEV' || owner.specDigest !== sha256(text)
    || !owner.proposalInvocationPublicKey) throw new Error('acceptance amendment review key binding invalid');
  return owner.proposalInvocationPublicKey;
}

/** Hash-only host receipts are insufficient: the independently pinned worker key seals the verdict and actual result. */
export function readManagedAcceptanceReviewReceipt(root: string, runId: string,
  expected: AcceptanceReviewBinding & { storyId: string; promptDigest: string; publicKey: string },
): { proposal: AcceptanceReviewFinal; receipt: ManagedHostRunReceipt } {
  assertAcceptanceReviewBinding({ amendmentId: expected.amendmentId, amendmentDigest: expected.amendmentDigest,
    baseDigest: expected.baseDigest, submitterSessionId: expected.submitterSessionId });
  const receipt = managedHostRunReceipt(root, runId);
  const binding = readManagedHostRunBinding(root, runId);
  const seal = readManagedReviewEvidenceProposal(root, runId) as unknown as {
    schemaVersion: string; runId: string; root: string; specDigest: string; promptDigest: string;
    bindingProjectionDigest: string; resultDigest: string; processCleanup: HostRunProcessCleanup;
    proposal: AcceptanceReviewFinal; signature: string;
  } | null;
  if (!seal) throw new Error('acceptance amendment review proposal missing');
  const { signature, ...claims } = seal;
  if (!verifyCanonical(claims, signature, expected.publicKey)) throw new Error('acceptance amendment review signature invalid');
  if (seal.schemaVersion !== 'proofbound.acceptance_amendment_review_receipt.v1' || seal.runId !== runId
    || seal.root !== realpathSync(root) || seal.specDigest !== receipt.specDigest
    || seal.promptDigest !== expected.promptDigest || binding.promptDigest !== expected.promptDigest
    || seal.bindingProjectionDigest !== receipt.bindingProjectionDigest || seal.resultDigest !== receipt.resultDigest
    || canonicalJson(seal.processCleanup) !== canonicalJson(receipt.processCleanup)
    || receipt.state !== 'completed' || !receipt.replacementSafe || !receipt.processCleanup?.reaped || receipt.processCleanup.residualProcessGroup
    || binding.profile !== ACCEPTANCE_REVIEW_PROFILE || binding.phase !== 'DEV' || binding.storyId !== expected.storyId
    || binding.agentType !== ACCEPTANCE_REVIEW_LANE || binding.lane !== ACCEPTANCE_REVIEW_LANE
    || seal.proposal.schemaVersion !== ACCEPTANCE_REVIEW_FINAL_SCHEMA
    || seal.proposal.storyId !== expected.storyId || seal.proposal.runId !== runId
    || ['amendmentId', 'amendmentDigest', 'baseDigest', 'submitterSessionId'].some(key =>
      seal.proposal[key as keyof AcceptanceReviewBinding] !== expected[key as keyof AcceptanceReviewBinding]
      || binding.acceptanceReviewBinding?.[key as keyof AcceptanceReviewBinding] !== expected[key as keyof AcceptanceReviewBinding])) {
    throw new Error('acceptance amendment review receipt subject binding invalid');
  }
  return { proposal: seal.proposal, receipt };
}
