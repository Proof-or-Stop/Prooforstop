import type { JobPlan, PlannerStoreLike } from './planner.js';
import {
  executePlannedSteps,
  type PlannedStepsExecutionResult,
} from './planned-steps-executor.js';
import {
  resolveAuthorityGateEvaluator,
  resolveAuthorityVerdictBacking,
  listAuthorityHostVerdicts,
  type AuthorityGateDecision,
  type AuthorityGateEvaluatorOptions,
  type AuthorityGateEvaluatorResolution,
} from './authority-client.js';
import {
  deriveSignedServerReviewWaveReconciliation,
  partitionFreshWaveVerdicts,
  reconcileAuthorityCertification,
  type DisagreementBehavior,
} from './verdicts.js';
import { buildGateEvidenceRefResolver } from './evidence-uploader.js';
import {
  buildNoOverlapMaterialOverlapAuditDefault,
  type AuthorityVerdictReceipt,
} from './authority-contracts.js';
import type { BoundedProviderExecutor } from '../providers/types.js';

const REQUIRED_FINAL_HOST_CHECK_WAVES = 3;
const REQUIRED_FINAL_HOSTS_PER_REVIEW_WAVE = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Authority completion decision (B16 Advancement And Completion, M10 / M11)
//
// The single FAIL-CLOSED gate that turns an executed Stage B job into an authority
// completion verdict. It MINTS NOTHING and TRUSTS NOTHING beyond structured facts:
//
//   - per-run `authorityDone` requires a verified native gate_decision receipt
//     (execution.receiptVerified, set ONLY when the executor's gate.evaluate step
//     passed on a verified approve) PLUS a completed (validation-passed) run;
//   - `fullAuthorityDone` additionally requires the multi-host final verification
//     gate for every authority/DONE job;
//   - the job `completed` flag is the per-mode DONE projection: authority/DONE jobs
//     complete only when fullAuthorityDone holds; every other mode completes on local
//     validation only and never projects authority DONE.
//
// Every failure path — reject, tamper, wrong key, wrong story, stale, future-dated,
// missing decisionDigest, unavailable receipt, evaluation error, incomplete
// validation, or an unmet multi-host floor — leaves `completed` / `authorityDone` /
// `fullAuthorityDone` false and records an explicit blocking reason. The verdict is
// pure: it derives only from the executor result, the resolved gate decision, the
// job policy, and an optional already-reconciled multi-host result.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthorityReceiptRef {
  receiptId: string;
  kind: 'gate_decision';
  decisionDigest?: string;
  /** True ONLY for a verified-approve native gate_decision receipt. */
  verified: boolean;
}

export interface MultiHostReviewWaveProof {
  reviewWaveRef: string;
  independentHostVerdictCount: number;
  hostVerdictRefs: string[];
}

/**
 * Multi-host reconciliation result. The independence count and `satisfied` flag are
 * computed by the Authority (or the local certified-review path) and consumed here
 * verbatim — this module NEVER recomputes independence from self-reported fields.
 */
export interface MultiHostReconciliation {
  independentHostVerdictCount: number;
  satisfied: boolean;
  hostVerdictRefs: string[];
  /** Receipt id that the final host checks inspected. Required for authority/DONE. */
  checkedReceiptId?: string;
  /** Native gate_decision receipt inputDigest that the final host checks inspected. Required for authority/DONE. */
  checkedGateInputDigest?: string;
  /** Per-wave proof that each final review wave met the independent-host floor. */
  reviewWaveProofs?: MultiHostReviewWaveProof[];
  satisfiedReviewWaveCount?: number;
  requiredReviewWaveCount?: number;
  reviewWaveRefs?: string[];
  /**
   * Machine-readable disagreement/blocked reason for an UNSATISFIED multi-host wave
   * (e.g. `multi_host_disagreement`, `insufficient_independent_hosts`,
   * `stale_review_wave_after_repair`, or `multi_host_reconciliation_unavailable`).
   * Undefined when the wave is satisfied. Surfaced verbatim in the completion verdict
   * and final output so a blocked fullAuthorityDone always names WHY.
   */
  blockedReason?: string;
}

export interface AuthorityCompletionInput {
  jobPlan: JobPlan;
  execution: PlannedStepsExecutionResult;
  /** Resolved gate decision from resolveAuthorityGateEvaluator, when a round-trip ran. */
  gateDecision?: AuthorityGateDecision;
  /** Final story lifecycle phase after execution (read-only), or null when unknown. */
  finalPhase?: string | null;
  /** Multi-host reconciliation, when a final verification wave was run. */
  multiHost?: MultiHostReconciliation;
}

export interface AuthorityCompletionVerdict {
  schemaVersion: 'lattice.authority_completion.v1';
  mode: JobPlan['mode'];
  until: JobPlan['until'];
  /** The single fail-closed gate: may the job complete (per-mode DONE)? */
  completed: boolean;
  validationPassed: boolean;
  receiptVerified: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  multiHostRequired: boolean;
  multiHostVerified: boolean;
  requiredHostVerdictCount: number;
  independentHostVerdictCount: number;
  requiredReviewWaveCount: number;
  satisfiedReviewWaveCount: number;
  reviewWaveRefs: string[];
  hostVerdictRefs: string[];
  /** Specific multi-host disagreement/blocked reason, when a required wave is unsatisfied. */
  multiHostBlockedReason?: string;
  receiptRefs: AuthorityReceiptRef[];
  receiptId?: string;
  decisionDigest?: string;
  /** Executor gate input digest certified by the verified gate.evaluate step. */
  gateInputDigest?: string;
  /** Native gate_decision receipt inputDigest issued by Lattice Authority. */
  receiptInputDigest?: string;
  lifecyclePhase: string | null;
  /** Explicit machine-readable reasons the job did NOT complete (empty when completed). */
  blockingReasons: string[];
  stopReason: string;
  nextAction: string;
}

/** Map a non-verified gate decision to a specific machine-readable block reason. */
function receiptBlockReason(gate: AuthorityGateDecision | undefined, gateBindingMismatch: boolean): string {
  if (gateBindingMismatch) return 'authority_gate_receipt_binding_mismatch';
  if (!gate) return 'authority_gate_decision_receipt_required';
  switch (gate.status) {
    case 'rejected':
      return 'authority_gate_decision_rejected';
    case 'blocked':
      return 'authority_gate_decision_blocked';
    case 'receipt_unavailable':
      return 'authority_gate_receipt_unavailable';
    case 'receipt_unverified':
      // Covers tamper, wrong key, wrong story, wrong project, wrong kind, missing
      // decisionDigest, stale, and future-dated — all fail closed identically.
      return 'authority_gate_receipt_unverified';
    case 'error':
      return 'authority_gate_evaluation_error';
    case 'verified':
    default:
      return 'authority_gate_decision_receipt_required';
  }
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stringFromSummary(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function verifiedExecutorGateBinding(execution: PlannedStepsExecutionResult): {
  gateInputDigest: string;
  receiptId: string;
  decisionDigest: string;
} {
  const step = execution.steps.find(
    item => item.type === 'gate.evaluate' && item.status === 'passed' && item.summary.receiptVerified === true,
  );
  return {
    gateInputDigest: stringFromSummary(step?.summary, 'gateInputDigest'),
    receiptId: stringFromSummary(step?.summary, 'receiptId'),
    decisionDigest: stringFromSummary(step?.summary, 'decisionDigest'),
  };
}

function normalizedReviewWaveProofs(input: MultiHostReconciliation | undefined): MultiHostReviewWaveProof[] {
  if (!Array.isArray(input?.reviewWaveProofs)) return [];
  return input.reviewWaveProofs
    .map(proof => ({
      reviewWaveRef: typeof proof.reviewWaveRef === 'string' ? proof.reviewWaveRef.trim() : '',
      independentHostVerdictCount: nonNegativeInt(proof.independentHostVerdictCount),
      hostVerdictRefs: Array.isArray(proof.hostVerdictRefs)
        ? proof.hostVerdictRefs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
        : [],
    }))
    .filter(proof => proof.reviewWaveRef.length > 0);
}

function satisfiedReviewWaveProofCount(
  proofs: MultiHostReviewWaveProof[],
  requiredHostVerdictCount: number,
  requiredReviewWaveRefs: string[],
): number {
  const requiredRefs = new Set(requiredReviewWaveRefs);
  const satisfied = new Set<string>();
  for (const proof of proofs) {
    if (!requiredRefs.has(proof.reviewWaveRef)) continue;
    const uniqueHostVerdictRefs = new Set(proof.hostVerdictRefs.map(ref => ref.trim()).filter(ref => ref !== ''));
    if (
      proof.independentHostVerdictCount >= requiredHostVerdictCount
      && uniqueHostVerdictRefs.size >= requiredHostVerdictCount
    ) {
      satisfied.add(proof.reviewWaveRef);
    }
  }
  return satisfied.size;
}

function deriveReviewWaveProofs(
  verdicts: AuthorityVerdictReceipt[],
  reviewWaveRefs: string[],
): MultiHostReviewWaveProof[] {
  const wanted = new Set(reviewWaveRefs);
  const byWave = new Map<string, Map<string, string>>();
  for (const verdict of verdicts) {
    const reviewWaveRef = typeof verdict.reviewWaveId === 'string' ? verdict.reviewWaveId.trim() : '';
    if (!wanted.has(reviewWaveRef)) continue;
    if (verdict.decision !== 'pass') continue;
    const hostId = typeof verdict.hostId === 'string' ? verdict.hostId.trim().toLowerCase() : '';
    const verdictId = typeof verdict.verdictId === 'string' ? verdict.verdictId.trim() : '';
    if (!hostId || !verdictId) continue;
    const hosts = byWave.get(reviewWaveRef) ?? new Map<string, string>();
    if (!hosts.has(hostId)) hosts.set(hostId, verdictId);
    byWave.set(reviewWaveRef, hosts);
  }
  return reviewWaveRefs.map(reviewWaveRef => {
    const refs = [...(byWave.get(reviewWaveRef)?.values() ?? [])];
    return {
      reviewWaveRef,
      independentHostVerdictCount: refs.length,
      hostVerdictRefs: refs,
    };
  });
}

/**
 * Decide the authority completion verdict for an executed job. Pure + fail-closed:
 * see the module banner for the full contract.
 */
export function evaluateAuthorityCompletion(input: AuthorityCompletionInput): AuthorityCompletionVerdict {
  const { jobPlan, execution } = input;
  const mode = jobPlan.mode;
  const until = jobPlan.until;
  const finalPhase = input.finalPhase ?? null;

  const validationPassed = execution.status === 'done';
  const gate = input.gateDecision;
  const isAuthorityDone = mode === 'authority' && until === 'DONE';
  const executorGate = verifiedExecutorGateBinding(execution);
  const expectedReceiptId = typeof gate?.receiptId === 'string' ? gate.receiptId.trim() : '';
  const expectedDecisionDigest = typeof gate?.decisionDigest === 'string' ? gate.decisionDigest.trim() : '';
  const expectedGateInputDigest = typeof gate?.gateInputDigest === 'string' ? gate.gateInputDigest.trim() : '';
  const gateDecisionVerified =
    gate?.status === 'verified'
    && gate.decision === 'approve'
    && gate.receiptVerified === true;
  const gateBindingMatchesExecution =
    gateDecisionVerified
    && execution.receiptVerified === true
    && expectedReceiptId.length > 0
    && expectedDecisionDigest.length > 0
    && expectedGateInputDigest.length > 0
    && executorGate.receiptId === expectedReceiptId
    && executorGate.decisionDigest === expectedDecisionDigest
    && executorGate.gateInputDigest === expectedGateInputDigest;
  const gateBindingMismatch =
    gateDecisionVerified
    && execution.receiptVerified === true
    && !gateBindingMatchesExecution;
  // receiptVerified is true only when the executor's verified gate.evaluate step is
  // bound to the same verified approve gateDecision supplied to this completion gate.
  const receiptVerified = gateBindingMatchesExecution;

  // Record a receipt ref whenever the gate returned a receipt handle — even on a
  // blocked run — so the outcome is always traceable. `verified` is true only for a
  // verified-approve receipt that the executor also accepted.
  const receiptRefs: AuthorityReceiptRef[] = [];
  if (gate && (gate.receiptId || gate.decisionDigest)) {
    receiptRefs.push({
      receiptId: gate.receiptId ?? '',
      kind: 'gate_decision',
      ...(gate.decisionDigest ? { decisionDigest: gate.decisionDigest } : {}),
      verified: receiptVerified && gate.status === 'verified',
    });
  }

  // Multi-host policy floor. requireMultiHost / fullAuthorityDoneRequired are
  // tighten-only knobs; requiredHostVerdictCount is floored by minIndependentHosts.
  const mh = jobPlan.multiHostPolicy ?? ({} as JobPlan['multiHostPolicy']);
  const multiHostRequired = isAuthorityDone || mh.requireMultiHost === true || mh.fullAuthorityDoneRequired === true;
  const requiredHostVerdictCount = multiHostRequired
    ? Math.max(
        REQUIRED_FINAL_HOSTS_PER_REVIEW_WAVE,
        nonNegativeInt(mh.requiredHostVerdictCount),
        nonNegativeInt(mh.minIndependentHosts),
      )
    : 0;
  const independentHostVerdictCount = nonNegativeInt(input.multiHost?.independentHostVerdictCount);
  const mhPolicy = mh as NonNullable<JobPlan['multiHostPolicy']> & {
    requiredReviewWaveCount?: number;
  };
  const requiredReviewWaveCount = multiHostRequired
    ? Math.max(
        nonNegativeInt(mhPolicy.requiredReviewWaveCount),
        nonNegativeInt(input.multiHost?.requiredReviewWaveCount),
        REQUIRED_FINAL_HOST_CHECK_WAVES,
      )
    : 0;
  const satisfiedReviewWaveCount = multiHostRequired
    ? input.multiHost?.satisfiedReviewWaveCount !== undefined
      ? nonNegativeInt(input.multiHost.satisfiedReviewWaveCount)
      : input.multiHost?.satisfied === true
        ? 1
        : 0
    : 0;
  const reviewWaveRefs = Array.isArray(input.multiHost?.reviewWaveRefs)
    ? input.multiHost!.reviewWaveRefs!.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : [];
  const checkedReceiptId = typeof input.multiHost?.checkedReceiptId === 'string' ? input.multiHost.checkedReceiptId.trim() : '';
  const checkedGateInputDigest = typeof input.multiHost?.checkedGateInputDigest === 'string' ? input.multiHost.checkedGateInputDigest.trim() : '';
  const expectedHostCheckedGateInputDigest = typeof gate?.receiptInputDigest === 'string'
    ? gate.receiptInputDigest.trim()
    : '';
  const reviewWaveProofs = normalizedReviewWaveProofs(input.multiHost);
  const uniqueReviewWaveRefs = new Set(reviewWaveRefs);
  const satisfiedProofWaveCount = satisfiedReviewWaveProofCount(
    reviewWaveProofs,
    requiredHostVerdictCount,
    reviewWaveRefs,
  );
  const reviewWaveProofsVerified = !multiHostRequired
    || (uniqueReviewWaveRefs.size >= requiredReviewWaveCount && satisfiedProofWaveCount >= requiredReviewWaveCount);
  const multiHostBindingMatches = !multiHostRequired
    ? true
    : input.multiHost !== undefined
      && expectedReceiptId.length > 0
      && expectedHostCheckedGateInputDigest.length > 0
      && checkedReceiptId === expectedReceiptId
      && checkedGateInputDigest === expectedHostCheckedGateInputDigest;
  // multiHostVerified ONLY when reconciliation reported satisfied, the independent
  // floor is met, all final host-check waves are satisfied, and the verdict wave
  // is bound to the current receiptId + gate_decision receipt inputDigest. The
  // executor X5 gateInputDigest is already checked by the gate.evaluate step.
  // Absent or unbound verdicts (the default) → not verified.
  const multiHostVerified = multiHostRequired
    ? input.multiHost?.satisfied === true
      && independentHostVerdictCount >= requiredHostVerdictCount
      && satisfiedReviewWaveCount >= requiredReviewWaveCount
      && reviewWaveProofsVerified
      && multiHostBindingMatches
    : false;
  const hostVerdictRefs = Array.isArray(input.multiHost?.hostVerdictRefs)
    ? input.multiHost!.hostVerdictRefs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : [];
  // Specific disagreement/blocked reason from the reconciliation, surfaced only when a
  // required multi-host wave is NOT verified. The generic `multi_host_verification_incomplete`
  // still leads blockingReasons; this names the precise cause (disagreement / shortfall /
  // stale / reconciliation-unavailable) when the reconciliation reported one.
  const rawMultiHostBlockedReason =
    typeof input.multiHost?.blockedReason === 'string' && input.multiHost.blockedReason.trim() !== ''
      ? input.multiHost.blockedReason.trim()
      : undefined;
  const multiHostBlockedReason =
    multiHostRequired && !multiHostVerified
      ? rawMultiHostBlockedReason
        ?? (input.multiHost !== undefined && !multiHostBindingMatches
          ? 'multi_host_binding_mismatch: final host checks must reference the current receiptId and gate_decision receipt inputDigest'
          : undefined)
        ?? (input.multiHost?.satisfied === true && !reviewWaveProofsVerified
          ? `insufficient_review_wave_proof: requires ${requiredReviewWaveCount} review wave proof(s) with ${requiredHostVerdictCount} independent host(s) each, have ${satisfiedProofWaveCount}`
          : undefined)
        ?? (input.multiHost?.satisfied === true && satisfiedReviewWaveCount < requiredReviewWaveCount
          ? `insufficient_review_waves: requires ${requiredReviewWaveCount} satisfied final host-check wave(s), have ${satisfiedReviewWaveCount}`
          : undefined)
      : undefined;

  const blockingReasons: string[] = [];
  let authorityDone = false;
  let fullAuthorityDone = false;

  if (isAuthorityDone) {
    if (!receiptVerified) blockingReasons.push(receiptBlockReason(gate, gateBindingMismatch));
    if (!validationPassed) blockingReasons.push('validation_incomplete');
    authorityDone = receiptVerified && validationPassed;
    if (multiHostRequired) {
      if (!multiHostVerified) blockingReasons.push('multi_host_verification_incomplete');
      fullAuthorityDone = authorityDone && multiHostVerified;
    }
  } else if (!validationPassed) {
    // authority/non-DONE and local jobs both complete on validation; neither projects
    // any authority DONE flag.
    blockingReasons.push('validation_incomplete');
  }

  const completed = isAuthorityDone ? fullAuthorityDone : validationPassed;

  const stopReason = completed
    ? isAuthorityDone
      ? fullAuthorityDone && multiHostRequired
        ? 'full_authority_done'
        : 'authority_done'
      : 'completed'
    : blockingReasons[0] ?? execution.stopReason;

  const nextAction = completionNextAction({
    completed,
    isAuthorityDone,
    multiHostRequired,
    blockingReasons,
    fullAuthorityDone,
  });

  return {
    schemaVersion: 'lattice.authority_completion.v1',
    mode,
    until,
    completed,
    validationPassed,
    receiptVerified,
    authorityDone,
    fullAuthorityDone,
    multiHostRequired,
    multiHostVerified,
    requiredHostVerdictCount,
    independentHostVerdictCount,
    requiredReviewWaveCount,
    satisfiedReviewWaveCount,
    reviewWaveRefs,
    hostVerdictRefs,
    ...(multiHostBlockedReason ? { multiHostBlockedReason } : {}),
    receiptRefs,
    ...(gate?.receiptId ? { receiptId: gate.receiptId } : {}),
    ...(gate?.decisionDigest ? { decisionDigest: gate.decisionDigest } : {}),
    ...(expectedGateInputDigest ? { gateInputDigest: expectedGateInputDigest } : {}),
    ...(gate?.receiptInputDigest ? { receiptInputDigest: gate.receiptInputDigest } : {}),
    lifecyclePhase: finalPhase,
    blockingReasons,
    stopReason,
    nextAction,
  };
}

function completionNextAction(args: {
  completed: boolean;
  isAuthorityDone: boolean;
  multiHostRequired: boolean;
  blockingReasons: string[];
  fullAuthorityDone: boolean;
}): string {
  if (args.completed) {
    if (args.isAuthorityDone) {
      return args.multiHostRequired && args.fullAuthorityDone
        ? 'Authority DONE: per-run gate receipt verified and multi-host final verification reconciled. Release the job and write the final summary.'
        : 'Authority DONE: native gate_decision receipt verified for this run. Release the job and write the final summary.';
    }
    return 'Validation passed; complete the run per the selected (non-authority) mode. Authority DONE is not claimed.';
  }
  const reason = args.blockingReasons[0];
  switch (reason) {
    case 'authority_gate_decision_receipt_required':
      return 'Run against a Lattice Authority server that evaluates the gate and issues a native gate_decision receipt; authority DONE is fail-closed without one.';
    case 'authority_gate_decision_rejected':
    case 'authority_gate_decision_blocked':
      return 'Lattice Authority did not approve the gate; resolve the decision reason and rerun, or stop — authority DONE is not available.';
    case 'authority_gate_receipt_unverified':
      return 'The native gate_decision receipt failed verification (signature, key id, story/project binding, decisionDigest, or freshness); do not claim authority DONE.';
    case 'authority_gate_receipt_binding_mismatch':
      return 'The verified gate_decision receipt is not bound to the executor gate input for this run; rerun the authority gate and do not claim authority DONE.';
    case 'authority_gate_receipt_unavailable':
      return 'The gate approved but no verifiable native receipt was returned or fetchable; authority DONE is fail-closed until the receipt is available and verifies.';
    case 'authority_gate_evaluation_error':
      return 'The authority gate evaluation errored before a verified receipt; authority DONE stays fail-closed until the gate call succeeds and the receipt verifies.';
    case 'multi_host_verification_incomplete':
      return 'The per-run gate receipt verified, but the required multi-host final verification is not reconciled; collect the required independent host verdicts before claiming full authority DONE.';
    case 'validation_incomplete':
      return 'Resolve the blocked/failed planned step so validation completes, then rerun the authority job loop.';
    default:
      return 'Resolve the recorded blocking reason, then rerun the authority job loop.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authority completion loop (B7 / B16, M10 / M11)
//
// The single high-level orchestration that drives a planned/claimed job to a
// completion verdict:
//
//   1. resolveAuthorityGateEvaluator — for an authority/DONE job this performs the
//      live round-trip (append run + evidence events -> POST /v1/gates/evaluate ->
//      verify the native gate_decision receipt) and returns a synchronous
//      evaluator; it FAILS CLOSED (no evaluator) when authority mode/url/server-key
//      are unconfigured. Local / non-DONE jobs resolve to no evaluator, zero network.
//   2. executePlannedSteps — consume the typed steps, handing the resolved
//      evaluator to the gate.evaluate step. The executor never mints a receipt and
//      never contacts a default server.
//   3. multi-host final certification — for an authority/DONE job whose policy requires
//      it, consume an injected reconciliation OR query the Authority verdict
//      reconciliation (GET /v1/jobs/{jobId}/verdicts) and project it; fullAuthorityDone
//      stays closed until the wave is satisfied.
//   4. evaluateAuthorityCompletion — the fail-closed completion gate above.
//   5. build the B16 final output binding receipt refs, evidence refs, host verdict
//      refs, the multi-host disagreement/blocked reason, and the completion verdict.
//
// It composes existing primitives: no new network path, no new minting. Lease
// lifecycle (heartbeat / renew / release / complete) is owned by the separate job
// lease state machine; `completionToFinalizeInput` bridges this verdict into that
// machine's complete-or-release tail without coupling the two modules.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthorityCompletionLoopOptions {
  root: string;
  store: PlannerStoreLike;
  jobPlan: JobPlan;
  maxSteps?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Injectable bounded provider executor (tests stub this; default spawns real CLIs). */
  providerExecutor?: BoundedProviderExecutor;
  /** Injectable fetch for the authority gate round-trip (tests inject a fake server). */
  fetchImpl?: AuthorityGateEvaluatorOptions['fetchImpl'];
  /** Caller-owned material overlap audit; defaults to the no-overlap CLI audit when no detector exists. */
  materialOverlapAudit?: AuthorityGateEvaluatorOptions['materialOverlapAudit'];
  /**
   * Multi-host reconciliation result, when a final verification wave already ran.
   * When supplied it is consumed verbatim and TAKES PRECEDENCE over any server query.
   * When ABSENT and the job policy requires multi-host certification, the loop QUERIES
   * the Authority verdict reconciliation (GET /v1/jobs/{jobId}/verdicts) itself and
   * derives the reconciliation; if no server backing is available it fails closed.
   */
  multiHost?: MultiHostReconciliation;
  /** §X9 disagreement protocol shaping the recommended nextAction; defaults to `block`. */
  disagreementBehavior?: DisagreementBehavior;
}

/** B16 final output (the subset the deterministic Stage B loop can produce). */
export interface AuthorityJobCompletionOutput {
  schemaVersion: 'lattice.authority_job_completion.v1';
  jobId?: string;
  storyId: string;
  projectId: string;
  mode: JobPlan['mode'];
  until: JobPlan['until'];
  /** Executor status (done / blocked / failed). */
  executionStatus: PlannedStepsExecutionResult['status'];
  localPhase: string | null;
  localDone: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  multiHostVerified: boolean;
  independentHostVerdictCount: number;
  requiredHostVerdictCount: number;
  requiredReviewWaveCount: number;
  satisfiedReviewWaveCount: number;
  reviewWaveRefs: string[];
  hostVerdictRefs: string[];
  /** Specific multi-host disagreement/blocked reason, when a required wave is unsatisfied. */
  multiHostBlockedReason?: string;
  receiptVerified: boolean;
  receiptId?: string;
  decisionDigest?: string;
  /** Executor gate input digest checked by final host verdicts. */
  gateInputDigest?: string;
  /** Native gate_decision receipt inputDigest verified against the server key. */
  receiptInputDigest?: string;
  receiptRefs: AuthorityReceiptRef[];
  executedStepCount: number;
  evidenceRefs: string[];
  /** True only when a live authority gate round-trip was performed. */
  gateConfigured: boolean;
  /** Mechanical reason for the gate resolution (fail-closed cause or gate status). */
  gateReason: string;
  /** Whether the job may complete (per-mode DONE). */
  completed: boolean;
  stopReason: string;
  nextAction: string;
}

export interface AuthorityCompletionLoopResult {
  resolution: AuthorityGateEvaluatorResolution;
  execution: PlannedStepsExecutionResult;
  completion: AuthorityCompletionVerdict;
  finalOutput: AuthorityJobCompletionOutput;
}

function resolveProjectId(jobPlan: JobPlan): string {
  return jobPlan.jobCreateRequestEnvelope?.projectId
    ?? jobPlan.jobCreateRequest?.projectId
    ?? 'local-project';
}

function buildFinalOutput(
  jobPlan: JobPlan,
  execution: PlannedStepsExecutionResult,
  completion: AuthorityCompletionVerdict,
  resolution: AuthorityGateEvaluatorResolution,
): AuthorityJobCompletionOutput {
  return {
    schemaVersion: 'lattice.authority_job_completion.v1',
    ...(jobPlan.jobCreateRequest ? { jobId: jobPlan.jobPlanDigest } : {}),
    storyId: jobPlan.storyId,
    projectId: resolveProjectId(jobPlan),
    mode: jobPlan.mode,
    until: jobPlan.until,
    executionStatus: execution.status,
    localPhase: completion.lifecyclePhase,
    localDone: execution.localDone,
    authorityDone: completion.authorityDone,
    fullAuthorityDone: completion.fullAuthorityDone,
    multiHostVerified: completion.multiHostVerified,
    independentHostVerdictCount: completion.independentHostVerdictCount,
    requiredHostVerdictCount: completion.requiredHostVerdictCount,
    requiredReviewWaveCount: completion.requiredReviewWaveCount,
    satisfiedReviewWaveCount: completion.satisfiedReviewWaveCount,
    reviewWaveRefs: completion.reviewWaveRefs,
    hostVerdictRefs: completion.hostVerdictRefs,
    ...(completion.multiHostBlockedReason ? { multiHostBlockedReason: completion.multiHostBlockedReason } : {}),
    receiptVerified: completion.receiptVerified,
    ...(completion.receiptId ? { receiptId: completion.receiptId } : {}),
    ...(completion.decisionDigest ? { decisionDigest: completion.decisionDigest } : {}),
    ...(completion.gateInputDigest ? { gateInputDigest: completion.gateInputDigest } : {}),
    ...(completion.receiptInputDigest ? { receiptInputDigest: completion.receiptInputDigest } : {}),
    receiptRefs: completion.receiptRefs,
    executedStepCount: execution.executedStepCount,
    evidenceRefs: execution.evidenceRefs,
    gateConfigured: resolution.configured,
    gateReason: resolution.reason,
    completed: completion.completed,
    stopReason: completion.stopReason,
    nextAction: completion.nextAction,
  };
}

/** Authority/DONE always demands a multi-host final certification wave. */
function requiresMultiHostCertification(jobPlan: JobPlan): boolean {
  return jobPlan.mode === 'authority' && jobPlan.until === 'DONE';
}

/** The Authority job id the verdict reconciliation is keyed by (matches finalOutput.jobId). */
function resolveAuthorityJobId(jobPlan: JobPlan): string {
  return jobPlan.jobPlanDigest;
}

/**
 * Query the Authority for the job's multi-host verdict reconciliation and project it
 * into a {@link MultiHostReconciliation}. Reuses the SAME pure overlay
 * (`reconcileAuthorityCertification` + `partitionFreshWaveVerdicts`) as `authority job
 * status`, so independence is never recomputed client-side — the server's count is
 * authoritative and this can only ADD fail-closed blocks. The per-run gate receipt is
 * verified separately by the completion gate, so this view isolates the multi-host
 * WAVE verdict (`satisfied` / `blockedReason`). Fails closed (unsatisfied, with a
 * machine-readable reason) when no server backing is available or the list call fails.
 */
async function queryMultiHostReconciliation(
  options: AuthorityCompletionLoopOptions,
  resolution: AuthorityGateEvaluatorResolution,
): Promise<MultiHostReconciliation> {
  const backing = resolveAuthorityVerdictBacking({
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    cwd: options.root,
  });
  if (backing.mode !== 'server' || !backing.client) {
    return {
      independentHostVerdictCount: 0,
      satisfied: false,
      hostVerdictRefs: [],
      satisfiedReviewWaveCount: 0,
      requiredReviewWaveCount: REQUIRED_FINAL_HOST_CHECK_WAVES,
      blockedReason: `multi_host_reconciliation_unavailable: ${backing.reason}`,
    };
  }

  const jobId = resolveAuthorityJobId(options.jobPlan);
  const listed = await listAuthorityHostVerdicts(backing.client, jobId);
  const runId = options.jobPlan.plannerRunId;
  const verdictsForRun = listed.verdicts.filter(verdict => verdict.runId === runId);
  const hostVerdictRefs = verdictsForRun
    .map(verdict => verdict.verdictId)
    .filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '');
  if (!listed.ok || !listed.reconciliation) {
    return {
      independentHostVerdictCount: 0,
      satisfied: false,
      hostVerdictRefs,
      satisfiedReviewWaveCount: 0,
      requiredReviewWaveCount: REQUIRED_FINAL_HOST_CHECK_WAVES,
      blockedReason:
        listed.reason ?? 'multi_host_reconciliation_unavailable: authority returned no verdict reconciliation',
    };
  }

  // Fresh review-wave staleness: when the verified per-run receiptId is known, verdicts
  // that checked a prior receipt are stale (§X9 post-repair fresh wave).
  const currentReceiptId = resolution.decision?.receiptId;
  const currentGateInputDigest = resolution.decision?.receiptInputDigest ?? resolution.decision?.gateInputDigest;
  const partition = currentReceiptId
    ? partitionFreshWaveVerdicts(verdictsForRun, currentReceiptId, currentGateInputDigest)
    : undefined;
  const freshVerdicts = partition?.fresh ?? verdictsForRun;
  const reconciliation = deriveSignedServerReviewWaveReconciliation(
    listed.reconciliation,
    freshVerdicts,
  );
  const certification = reconcileAuthorityCertification({
    reconciliation,
    // The receipt half (per-run authorityDone) is verified by the completion gate, not
    // here. Pass `true` so this overlay isolates the MULTI-HOST wave verdict and never
    // reports a spurious `authority_receipt_unverified` reason in the multi-host field.
    receiptVerified: true,
    ...(currentReceiptId ? { receiptId: currentReceiptId } : {}),
    ...(options.disagreementBehavior ? { disagreementBehavior: options.disagreementBehavior } : {}),
    ...(partition ? { staleVerdictIds: partition.staleVerdictIds } : {}),
  });

  return {
    independentHostVerdictCount: certification.passingIndependentHosts,
    satisfied: certification.multiHostVerified,
    hostVerdictRefs,
    ...(currentReceiptId ? { checkedReceiptId: currentReceiptId } : {}),
    ...(currentGateInputDigest ? { checkedGateInputDigest: currentGateInputDigest } : {}),
    reviewWaveProofs: deriveReviewWaveProofs(freshVerdicts, certification.reviewWaveRefs),
    satisfiedReviewWaveCount: certification.satisfiedReviewWaves,
    requiredReviewWaveCount: certification.requiredReviewWaves,
    reviewWaveRefs: certification.reviewWaveRefs,
    ...(certification.multiHostVerified
      ? {}
      : { blockedReason: certification.blockedReason ?? 'multi_host_verification_incomplete' }),
  };
}

/**
 * Run the Stage B authority completion loop end to end. See the section banner for
 * the sequencing and fail-closed contract. Local / non-authority and
 * authority/non-DONE jobs run the same shape but never project an authority DONE
 * flag.
 */
export async function runAuthorityCompletionLoop(
  options: AuthorityCompletionLoopOptions,
): Promise<AuthorityCompletionLoopResult> {
  const { now } = options;
  const materialOverlapAudit = options.materialOverlapAudit ?? buildNoOverlapMaterialOverlapAuditDefault();

  const resolution = await resolveAuthorityGateEvaluator(options.jobPlan, {
    ...(options.env ? { env: options.env } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(now ? { now } : {}),
    cwd: options.root,
    materialOverlapAudit,
  });

  const execution = executePlannedSteps({
    root: options.root,
    store: options.store,
    jobPlan: options.jobPlan,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.providerExecutor ? { providerExecutor: options.providerExecutor } : {}),
    ...(now ? { now } : {}),
    authorityGate: resolution.evaluator,
    ...(resolution.evaluator ? { gateEvidenceRefResolver: buildGateEvidenceRefResolver(options.jobPlan) } : {}),
    materialOverlapAudit,
  });

  let finalPhase: string | null = null;
  try {
    finalPhase = options.store.readStory(options.jobPlan.storyId).phase;
  } catch {
    finalPhase = null;
  }

  // Multi-host final certification: an injected reconciliation is consumed verbatim;
  // otherwise, for an authority/DONE job whose policy requires multi-host verification,
  // QUERY the Authority verdict reconciliation and derive it. fullAuthorityDone stays
  // closed until the queried (or injected) wave is satisfied.
  let multiHost = options.multiHost;
  if (!multiHost && requiresMultiHostCertification(options.jobPlan)) {
    multiHost = await queryMultiHostReconciliation(options, resolution);
  }

  const completion = evaluateAuthorityCompletion({
    jobPlan: options.jobPlan,
    execution,
    ...(resolution.decision ? { gateDecision: resolution.decision } : {}),
    finalPhase,
    ...(multiHost ? { multiHost } : {}),
  });

  const finalOutput = buildFinalOutput(options.jobPlan, execution, completion, resolution);

  return { resolution, execution, completion, finalOutput };
}

/**
 * Bridge a completion verdict into the job lease state machine's complete-or-release
 * tail (`finalizeAuthorityJob`). Structurally typed so this module stays decoupled
 * from the lease module: spread the result into `finalizeAuthorityJob({ loop, ... })`.
 *
 * - `receiptRequired` is true only for an authority/DONE target;
 * - `finalPolicySatisfied` is the FULL completion gate (validation + multi-host +,
 *   for authority/DONE, verified receipt), so the lease machine completes only when
 *   this verdict already says the job may complete, and releases otherwise.
 */
export interface CompletionFinalizeInput {
  resultDigest: string;
  receiptRequired: boolean;
  receiptVerified: boolean;
  finalPolicySatisfied: boolean;
  releaseReason: string;
}

export function completionToFinalizeInput(
  completion: AuthorityCompletionVerdict,
  resultDigest: string,
): CompletionFinalizeInput {
  return {
    resultDigest,
    receiptRequired: completion.mode === 'authority' && completion.until === 'DONE',
    receiptVerified: completion.receiptVerified,
    finalPolicySatisfied: completion.completed,
    releaseReason: completion.stopReason,
  };
}
