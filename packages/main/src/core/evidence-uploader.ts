import { createHash } from 'node:crypto';
import type {
  EvidenceRetentionClass,
  JobEvidencePolicy,
  JobPlan,
  PlannedStep,
  PlannerStoreLike,
} from './planner.js';
import { classifyRetention } from './evidence-retention.js';
import { redactText, type RedactionSummary } from './evidence-redaction.js';
import type {
  PlannedStepExecution,
  PlannedStepExecutionStatus,
  PlannedStepsExecutionResult,
} from './planned-steps-executor.js';
import type { AuthorityClient, AuthorityClientOutcomeKind } from './authority-client.js';
import {
  buildAuthorityRunEventsEnvelope,
  type AuthorityRunEvent,
  type AuthorityRunEventsEnvelope,
} from './authority-contracts.js';
import type { ProviderEvent } from './authority-runner-contracts.js';

/**
 * M8 — executor-driven per-step evidence streaming.
 *
 * This module turns the deterministic executor's per-step output
 * ({@link PlannedStepsExecutionResult.steps}) into the structured evidence
 * taxonomy required by the live-integration requirements §B4 and streams each
 * record to Lattice Authority through the EXISTING {@link AuthorityClient}
 * endpoints:
 *
 *   - provider events            -> POST /v1/runs/{runId}/provider-events
 *   - command / validation / git /
 *     gate request / stop summary /
 *     run record                 -> POST /v1/runs/{runId}/events
 *
 * Three boundaries are mechanical, not prose:
 *
 *   1. LOCAL mode writes local evidence ONLY. It performs ZERO network calls
 *      (no client is ever consulted) and records the evidence stream as a local
 *      `planner_evidence_local` process event when a store is supplied.
 *   2. AUTHORITY mode FAILS CLOSED on a required-evidence upload failure: the
 *      stream stops at the first required record whose transport outcome is not
 *      `success` and returns `status:'blocked'` with an EXACT
 *      `blockedReason` naming the kind, stepId, and transport outcome. A
 *      non-required record whose upload fails (only allowed when
 *      `evidencePolicy.allowContinueWithoutEvidence`) is recorded as
 *      `uploaded:false` but does not block.
 *   3. The client NEVER mints a receipt here. This module only POSTs evidence and
 *      reads the transport ack kind; it never verifies, derives, or trusts a
 *      receipt and never projects DONE. `receiptMinted` is a permanent `false`.
 */

export type EvidenceStreamKind =
  | 'run_record'
  | 'provider_event'
  | 'command_event'
  | 'validation_evidence'
  | 'git_evidence'
  | 'gate_request'
  | 'stop_summary';

/** Canonical §B4 evidence taxonomy; the conservative fail-closed required set. */
export const REQUIRED_EVIDENCE_KINDS: readonly EvidenceStreamKind[] = [
  'run_record',
  'provider_event',
  'command_event',
  'validation_evidence',
  'git_evidence',
  'gate_request',
  'stop_summary',
];

/** A single structured evidence record derived from one executor step (or run-level). */
export interface StepEvidenceRecord {
  /** Stable id used as the authority event id + idempotency key. */
  evidenceId: string;
  /** Owning step id, or `<run>` / `<git>` for run-level records. */
  stepId: string;
  kind: EvidenceStreamKind;
  status: PlannedStepExecutionStatus | 'recorded';
  /** Static evidence binding ref the gate certifies. */
  evidenceBinding: string;
  /** Digest of the underlying step record (digests/refs only — never raw secrets, §B4a). */
  evidenceDigest: string;
  occurredAt: string;
  /** True when a failed upload of this record must fail the run closed (authority mode). */
  required: boolean;
  /**
   * Retention class assigned to this record (§B4b) — derived consistently from the
   * JobPlan's `evidencePolicy.retentionClassByKind` (or the canonical default
   * mapping) by {@link classifyRetention}. The GC sweeper keys off this.
   */
  retentionClass: EvidenceRetentionClass;
  /**
   * Summary of the redaction pass run over this record's human-readable source text
   * BEFORE upload (§B4a). The redacted text is never carried raw; this summary keeps
   * the original/redacted digests + per-rule hit counts so a verifier can match the
   * unredacted local artifact without the secret ever leaving the host.
   */
  redactionSummary: RedactionSummary;
  /** Structured payload — digests / refs / redaction+retention metadata only. */
  payload: Record<string, unknown>;
}

/** Optional git state injected by the caller (the module performs no git I/O itself). */
export interface GitStateInput {
  beforeDigest?: string;
  afterDigest?: string;
  headHash?: string;
  dirty?: boolean;
  changedFiles?: string[];
  commitId?: string;
}

export interface BuildEvidenceStreamOptions {
  /** Git state for the run-level git_evidence record; omitted -> no git record. */
  gitState?: GitStateInput;
  now?: () => Date;
}

export type EvidenceUploadEndpoint = 'provider-events' | 'run-events' | 'local';

export interface EvidenceUploadOutcome {
  stepId: string;
  kind: EvidenceStreamKind;
  required: boolean;
  endpoint: EvidenceUploadEndpoint;
  /** Transport outcome kind, `local` (no network), or `skipped` (after a block). */
  transport: AuthorityClientOutcomeKind | 'local' | 'skipped';
  uploaded: boolean;
}

export type EvidenceStreamStatus = 'streamed' | 'local_only' | 'blocked';

export interface EvidenceStreamResult {
  mode: 'local' | 'authority';
  status: EvidenceStreamStatus;
  /** Exact reason on a required-evidence upload failure (authority mode only). */
  blockedReason?: string;
  /** Number of real network POSTs performed (always 0 in local mode). */
  networkCalls: number;
  recordCount: number;
  uploads: EvidenceUploadOutcome[];
  records: StepEvidenceRecord[];
  /** Permanent invariant: this module never mints a receipt. */
  receiptMinted: false;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function resolveProjectId(jobPlan: JobPlan): string {
  return jobPlan.jobCreateRequestEnvelope?.projectId
    ?? jobPlan.jobCreateRequest?.projectId
    ?? 'local-project';
}

function resolveJobId(jobPlan: JobPlan): string | undefined {
  return jobPlan.jobCreateRequest ? jobPlan.jobPlanDigest : undefined;
}

/** Map an executor step type to its §B4 evidence kind. */
export function classifyEvidenceKind(stepType: PlannedStep['type']): EvidenceStreamKind {
  switch (stepType) {
    case 'provider.fake':
    case 'provider.codex':
    case 'provider.claude':
      return 'provider_event';
    case 'validate.run':
      return 'validation_evidence';
    case 'gate.evaluate':
      return 'gate_request';
    case 'stop.summary':
      return 'stop_summary';
    case 'lattice.command':
    case 'codex.verify':
    case 'story.advance':
    default:
      return 'command_event';
  }
}

function resolveEvidencePolicy(jobPlan: JobPlan): JobEvidencePolicy {
  const ep = jobPlan.evidencePolicy;
  if (!ep || typeof ep !== 'object') {
    // Conservative fail-closed default: every taxonomy kind is required and the
    // run may not continue past a failed required upload.
    return {
      requiredEvidenceKinds: [...REQUIRED_EVIDENCE_KINDS],
      redactionRequired: true,
      retentionClassByKind: {},
      allowContinueWithoutEvidence: false,
      checklistCoverageRequired: true,
    };
  }
  return ep;
}

/**
 * Whether a failed upload of this record must fail the run closed in authority
 * mode. A step's `blocksUntilEvidenceUploaded` forces its own record required;
 * otherwise the kind must be in `requiredEvidenceKinds` AND the policy must not
 * `allowContinueWithoutEvidence`.
 */
function isRecordRequired(
  kind: EvidenceStreamKind,
  policy: JobEvidencePolicy,
  step?: PlannedStep | undefined,
): boolean {
  if (step?.blocksUntilEvidenceUploaded === true) return true;
  if (policy.allowContinueWithoutEvidence === true) return false;
  return policy.requiredEvidenceKinds.includes(kind);
}

/**
 * Collect every human-readable string the executor attached to a step (the stop
 * reason + any string-valued summary fields, e.g. a provider `note`/`detail`) and
 * run it through the redaction pipeline BEFORE it can become uploadable evidence.
 * Returns the merged redaction summary plus the redacted reason actually stored in
 * the payload — the raw reason is never persisted when it carries a secret (§B4a).
 */
function redactStepEvidence(step: PlannedStepExecution): { summary: RedactionSummary; redactedReason?: string } {
  const parts: string[] = [];
  if (typeof step.reason === 'string' && step.reason !== '') parts.push(step.reason);
  for (const value of Object.values(step.summary)) {
    if (typeof value === 'string' && value !== '') parts.push(value);
  }
  const { summary } = redactText(parts.join('\n'));
  return {
    summary,
    ...(typeof step.reason === 'string' && step.reason !== ''
      ? { redactedReason: redactText(step.reason).text }
      : {}),
  };
}

/** Redaction summary for a run-level (no-step) record built from digest-only text. */
function redactPayloadText(text: string): RedactionSummary {
  return redactText(text).summary;
}

function retentionPolicyOf(jobPlan: JobPlan): Record<string, EvidenceRetentionClass> | undefined {
  return jobPlan.evidencePolicy?.retentionClassByKind;
}

/** Redaction + retention metadata every uploaded record carries (never raw secrets). */
function redactionPayload(kind: EvidenceStreamKind, retentionClass: EvidenceRetentionClass, summary: RedactionSummary): Record<string, unknown> {
  return {
    retentionClass,
    redaction: {
      redacted: summary.redacted,
      ruleHits: summary.ruleHits,
      originalDigest: summary.originalDigest,
      redactedDigest: summary.redactedDigest,
      originalBytes: summary.originalBytes,
    },
    evidenceKind: kind,
  };
}

function stepRecordPayload(
  step: PlannedStepExecution,
  jobPlan: JobPlan,
  kind: EvidenceStreamKind,
  retentionClass: EvidenceRetentionClass,
  redaction: { summary: RedactionSummary; redactedReason?: string },
): Record<string, unknown> {
  // Digests / refs only — never raw stdout/stderr/prompts (§B4a redaction boundary).
  // `reason` is stored REDACTED so a secret laundered into a stop reason cannot leak.
  return {
    stepId: step.stepId,
    stepType: step.type,
    status: step.status,
    attempts: step.attempts,
    ...(redaction.redactedReason !== undefined ? { reason: redaction.redactedReason } : {}),
    evidenceBinding: step.evidenceBinding,
    evidenceDigest: step.evidenceDigest,
    summaryDigest: digest(step.summary),
    storyId: jobPlan.storyId,
    ...redactionPayload(kind, retentionClass, redaction.summary),
  };
}

/** Build one structured evidence record from a single executed step. */
export function buildStepEvidenceRecord(step: PlannedStepExecution, jobPlan: JobPlan, plannedStep?: PlannedStep): StepEvidenceRecord {
  const kind = classifyEvidenceKind(step.type);
  const policy = resolveEvidencePolicy(jobPlan);
  const retentionClass = classifyRetention(kind, retentionPolicyOf(jobPlan));
  const redaction = redactStepEvidence(step);
  return {
    evidenceId: `${jobPlan.plannerRunId}:${step.stepId}:${kind}`,
    stepId: step.stepId,
    kind,
    status: step.status,
    evidenceBinding: step.evidenceBinding,
    evidenceDigest: step.evidenceDigest,
    occurredAt: step.endedAt,
    required: isRecordRequired(kind, policy, plannedStep),
    retentionClass,
    redactionSummary: redaction.summary,
    payload: stepRecordPayload(step, jobPlan, kind, retentionClass, redaction),
  };
}

function buildRunRecord(result: PlannedStepsExecutionResult, jobPlan: JobPlan, occurredAt: string): StepEvidenceRecord {
  const policy = resolveEvidencePolicy(jobPlan);
  const startedAt = result.steps[0]?.startedAt ?? occurredAt;
  const endedAt = result.steps[result.steps.length - 1]?.endedAt ?? occurredAt;
  const retentionClass = classifyRetention('run_record', retentionPolicyOf(jobPlan));
  const payload: Record<string, unknown> = {
    runId: jobPlan.plannerRunId,
    jobId: resolveJobId(jobPlan),
    projectId: resolveProjectId(jobPlan),
    storyId: jobPlan.storyId,
    mode: jobPlan.mode,
    until: jobPlan.until,
    startedAt,
    endedAt,
    plannedStepsDigest: result.plannedStepsDigest,
    executedStepCount: result.executedStepCount,
  };
  const redactionSummary = redactPayloadText(`${jobPlan.storyId}:${result.stopReason}`);
  return {
    evidenceId: `${jobPlan.plannerRunId}:<run>:run_record`,
    stepId: '<run>',
    kind: 'run_record',
    status: 'recorded',
    evidenceBinding: `${jobPlan.storyId}:run`,
    evidenceDigest: digest(payload),
    occurredAt,
    required: isRecordRequired('run_record', policy),
    retentionClass,
    redactionSummary,
    payload: { ...payload, ...redactionPayload('run_record', retentionClass, redactionSummary) },
  };
}

function buildGitEvidenceRecord(git: GitStateInput, jobPlan: JobPlan, occurredAt: string): StepEvidenceRecord {
  const policy = resolveEvidencePolicy(jobPlan);
  // Only digests / file-name list — never raw diffs (§B4a).
  const retentionClass = classifyRetention('git_evidence', retentionPolicyOf(jobPlan));
  const payload: Record<string, unknown> = {
    storyId: jobPlan.storyId,
    beforeDigest: git.beforeDigest,
    afterDigest: git.afterDigest,
    headHash: git.headHash,
    dirty: git.dirty,
    changedFiles: git.changedFiles ?? [],
    changedFileCount: (git.changedFiles ?? []).length,
    ...(git.commitId ? { commitId: git.commitId } : {}),
  };
  const redactionSummary = redactPayloadText((git.changedFiles ?? []).join('\n'));
  return {
    evidenceId: `${jobPlan.plannerRunId}:<git>:git_evidence`,
    stepId: '<git>',
    kind: 'git_evidence',
    status: 'recorded',
    evidenceBinding: `${jobPlan.storyId}:git`,
    evidenceDigest: digest(payload),
    occurredAt,
    required: isRecordRequired('git_evidence', policy),
    retentionClass,
    redactionSummary,
    payload: { ...payload, ...redactionPayload('git_evidence', retentionClass, redactionSummary) },
  };
}

/**
 * Build the full ordered evidence stream for an execution: a leading run_record,
 * one record per executed step (classified by type), and an optional run-level
 * git_evidence record when git state is injected. This is the single source of
 * truth both the local recorder and the authority streamer consume.
 */
export function buildEvidenceStream(
  result: PlannedStepsExecutionResult,
  jobPlan: JobPlan,
  options: BuildEvidenceStreamOptions = {},
): StepEvidenceRecord[] {
  const now = options.now ?? (() => new Date());
  const occurredAt = now().toISOString();
  const plannedById = new Map<string, PlannedStep>(jobPlan.plannedSteps.map(s => [s.stepId, s]));
  const records: StepEvidenceRecord[] = [buildRunRecord(result, jobPlan, occurredAt)];
  for (const step of result.steps) {
    records.push(buildStepEvidenceRecord(step, jobPlan, plannedById.get(step.stepId)));
  }
  if (options.gitState) {
    records.push(buildGitEvidenceRecord(options.gitState, jobPlan, occurredAt));
  }
  return records;
}

// --- Per-step executor-driven local recorder --------------------------------

/**
 * A synchronous per-step local recorder. The executor calls `recorder(step,
 * index)` once per executed step, in order, so local evidence is captured as the
 * loop runs — zero network. `records()` returns the accumulated stream.
 */
export interface StepEvidenceRecorderHandle {
  recorder: (step: PlannedStepExecution, index: number) => void;
  records(): StepEvidenceRecord[];
}

export function createStepEvidenceRecorder(jobPlan: JobPlan): StepEvidenceRecorderHandle {
  const plannedById = new Map<string, PlannedStep>(jobPlan.plannedSteps.map(s => [s.stepId, s]));
  const collected: StepEvidenceRecord[] = [];
  return {
    recorder: (step) => {
      collected.push(buildStepEvidenceRecord(step, jobPlan, plannedById.get(step.stepId)));
    },
    records: () => [...collected],
  };
}

// --- Upload routing ----------------------------------------------------------

export interface EvidenceUploadHeader {
  actorId: string;
  runId: string;
  role?: string;
  provider?: string;
  jobId?: string;
  /** Optional signer — best effort; an unsigned envelope is left for the server to reject. */
  signEnvelope?: <T extends object>(envelope: T) => T & { signature?: string };
}

function runEventOf(record: StepEvidenceRecord): AuthorityRunEvent {
  const kindMap: Record<EvidenceStreamKind, string> = {
    run_record: 'lattice.run_record',
    provider_event: 'lattice.provider',
    command_event: 'lattice.command',
    validation_evidence: 'lattice.validation',
    git_evidence: 'lattice.git',
    gate_request: 'lattice.gate_request',
    stop_summary: 'lattice.summary',
  };
  return {
    type: kindMap[record.kind],
    payload: { eventId: record.evidenceId, evidenceBinding: record.evidenceBinding, evidenceDigest: record.evidenceDigest, occurredAt: record.occurredAt, ...record.payload },
  };
}

function providerEventOf(record: StepEvidenceRecord, header: EvidenceUploadHeader): ProviderEvent {
  return {
    eventId: record.evidenceId,
    runId: header.runId,
    provider: header.provider ?? 'codex',
    type: 'message',
    ...(header.jobId ? { jobId: header.jobId } : {}),
    message: `Lattice provider evidence ${record.evidenceId}`,
    occurredAt: record.occurredAt,
    artifactRefs: [],
    metadata: { evidenceBinding: record.evidenceBinding, evidenceDigest: record.evidenceDigest, ...record.payload },
  } as unknown as ProviderEvent;
}

function endpointFor(kind: EvidenceStreamKind): EvidenceUploadEndpoint {
  return kind === 'provider_event' ? 'provider-events' : 'run-events';
}

/**
 * Stream evidence records to Lattice Authority through the existing client
 * endpoints, one POST per record (per-step streaming). Fails closed at the first
 * required record whose transport outcome is not `success`.
 */
export async function streamEvidenceToAuthority(
  records: StepEvidenceRecord[],
  client: AuthorityClient,
  header: EvidenceUploadHeader,
): Promise<EvidenceStreamResult> {
  function sign<T extends object>(envelope: T): T & { signature?: string } {
    return header.signEnvelope ? header.signEnvelope(envelope) : envelope;
  }
  const uploads: EvidenceUploadOutcome[] = [];
  let networkCalls = 0;
  let blockedReason: string | undefined;
  let blocked = false;

  for (const record of records) {
    if (blocked) {
      uploads.push({ stepId: record.stepId, kind: record.kind, required: record.required, endpoint: endpointFor(record.kind), transport: 'skipped', uploaded: false });
      continue;
    }
    const endpoint = endpointFor(record.kind);
    let transport: AuthorityClientOutcomeKind;
    if (endpoint === 'provider-events') {
      const base = {
        actorId: header.actorId,
        role: header.role ?? 'runner',
        nonce: `${record.evidenceId}:provider`,
        timestamp: record.occurredAt,
        providerEvent: providerEventOf(record, header),
      };
      const ack = await client.submitProviderEvents(header.runId, sign(base));
      transport = ack.kind;
    } else {
      const base: AuthorityRunEventsEnvelope = buildAuthorityRunEventsEnvelope(
        { actorId: header.actorId, role: header.role ?? 'runner', nonce: `${record.evidenceId}:event`, timestamp: record.occurredAt },
        header.runId,
        [runEventOf(record)],
      );
      const ack = await client.appendRunEvents(header.runId, sign(base));
      transport = ack.kind;
    }
    networkCalls += 1;
    const uploaded = transport === 'success';
    uploads.push({ stepId: record.stepId, kind: record.kind, required: record.required, endpoint, transport, uploaded });
    // Fail closed: a required record that does not upload successfully blocks the
    // run with an EXACT reason. Non-required failures are recorded, not fatal.
    if (!uploaded && record.required) {
      blocked = true;
      blockedReason = `evidence_upload_failed:${record.kind}:${record.stepId}:${transport}`;
    }
  }

  return {
    mode: 'authority',
    status: blocked ? 'blocked' : 'streamed',
    ...(blockedReason ? { blockedReason } : {}),
    networkCalls,
    recordCount: records.length,
    uploads,
    records,
    receiptMinted: false,
  };
}

/** Append the evidence stream to the local store as a digest-only process event. */
export function recordLocalEvidence(
  store: PlannerStoreLike,
  storyId: string,
  records: StepEvidenceRecord[],
  meta: Record<string, unknown> = {},
): void {
  store.appendProcessEvent(storyId, {
    type: 'planner_evidence_local',
    recordCount: records.length,
    records: records.map(r => ({ stepId: r.stepId, kind: r.kind, status: r.status, evidenceBinding: r.evidenceBinding, evidenceDigest: r.evidenceDigest, required: r.required, retentionClass: r.retentionClass, redacted: r.redactionSummary.redacted })),
    ...meta,
  });
}

// --- Durable evidence refs for the gate (§B4 / §B15) -------------------------

/**
 * The durable, content-addressed ref for an uploaded evidence record: its
 * `evidenceId` (`<plannerRunId>:<stepId>:<kind>`). This is the id the streamed
 * authority envelope is keyed by, so referencing it ties the gate input to the
 * ACTUAL uploaded evidence rather than the static pre-execution `evidenceBinding`.
 */
export function durableEvidenceRef(record: StepEvidenceRecord): string {
  return record.evidenceId;
}

/**
 * Build the executor's `gateEvidenceRefResolver` for a job: maps each executed step
 * to the durable evidence id its uploaded record will carry. Crucially this id is
 * derived ONLY from `(plannerRunId, stepId, kind)`, so it is identical whether
 * computed before execution (planning the gate request) or after (the uploaded
 * record) — letting the gate input reference uploaded/durable refs deterministically.
 *
 * Pass the returned resolver to `executePlannedSteps({ gateEvidenceRefResolver })`
 * when a live evidence upload is configured; omit it to keep the default static
 * `evidenceBinding` gate input (deterministic local/no-network behavior unchanged).
 */
export function buildGateEvidenceRefResolver(jobPlan: JobPlan): (step: PlannedStepExecution) => string {
  return (step) => `${jobPlan.plannerRunId}:${step.stepId}:${classifyEvidenceKind(step.type)}`;
}

export interface StreamPlannedStepEvidenceOptions extends BuildEvidenceStreamOptions {
  /** Authority client — required for authority mode, ignored for local mode. */
  client?: AuthorityClient;
  header?: EvidenceUploadHeader;
  /** Local store — when supplied, local mode writes a `planner_evidence_local` event. */
  store?: PlannerStoreLike;
}

/**
 * Top-level entry: build the evidence stream from an execution and either record
 * it locally (local mode — ZERO network) or stream it to Lattice Authority
 * (authority mode — fail closed on required upload failure).
 *
 * Mode is taken from `jobPlan.mode`. A local job NEVER touches the client even if
 * one is passed; an authority job with no client/header fails closed before any
 * network with a `blockedReason` of `authority_evidence_client_unconfigured`.
 */
export async function streamPlannedStepEvidence(
  result: PlannedStepsExecutionResult,
  jobPlan: JobPlan,
  options: StreamPlannedStepEvidenceOptions = {},
): Promise<EvidenceStreamResult> {
  const records = buildEvidenceStream(result, jobPlan, options);

  if (jobPlan.mode !== 'authority') {
    // Local mode writes local evidence ONLY — no client is ever consulted.
    if (options.store) recordLocalEvidence(options.store, jobPlan.storyId, records, { plannerRunId: jobPlan.plannerRunId, mode: jobPlan.mode });
    return {
      mode: 'local',
      status: 'local_only',
      networkCalls: 0,
      recordCount: records.length,
      uploads: records.map(r => ({ stepId: r.stepId, kind: r.kind, required: r.required, endpoint: 'local' as const, transport: 'local' as const, uploaded: false })),
      records,
      receiptMinted: false,
    };
  }

  if (!options.client || !options.header) {
    // Authority mode with no configured client fails closed before any network.
    return {
      mode: 'authority',
      status: 'blocked',
      blockedReason: 'authority_evidence_client_unconfigured',
      networkCalls: 0,
      recordCount: records.length,
      uploads: records.map(r => ({ stepId: r.stepId, kind: r.kind, required: r.required, endpoint: endpointFor(r.kind), transport: 'skipped' as const, uploaded: false })),
      records,
      receiptMinted: false,
    };
  }

  return streamEvidenceToAuthority(records, options.client, options.header);
}
