// Authority runner contracts (B-1123 milestones 1-2).
//
// Typed envelope shapes + Zod schemas + sign/verify helpers for the headless
// authority runner endpoints owned by the Python authority server:
//
//   POST /v1/actors/{actorId}/keys           — actor key registration
//   POST /v1/runners/register                — runner registration
//   POST /v1/runners/{runnerId}/heartbeat    — runner heartbeat
//   POST /v1/runners/{runnerId}/jobs/claim   — job claim
//   POST /v1/jobs/{jobId}/heartbeat          — job lease heartbeat
//   POST /v1/jobs/{jobId}/release            — job release
//   POST /v1/runs/{runId}/provider-events    — provider events
//
//   (Response) signed AuthorityReceipt
//
// Each envelope carries `actorId`, `nonce`, `createdAt`, and an optional
// `signature` over the signature-less canonical bytes (see authority-signing.ts).
//
// Trust boundary (authority-client-role.md §PD-2 / §L2+ Evidence Boundary):
//   - Mirroring the Python/Mac runner envelope shape here does NOT make a CLI
//     submission L2+. The classifier in authority-boundary.ts remains the
//     mechanical truth source; even a successfully signed runner envelope sent
//     from off/local/shadow workflow paths classifies as `local-only`,
//     `thin-client-shadow`, or `thin-client-transport-accepted`.
//   - `runnerEnvelopeIsL2PlusCandidate()` below is the adversarial gate: it
//     enumerates the L2+ field requirements for runner-issued evidence and
//     returns false for any CLI-shaped runner envelope today.

import { z } from 'zod';
import {
  canonicalDigest,
  signEnvelope as signEnvelopeRaw,
  stripSignature,
  verifyCanonical,
  verifySignedEnvelope,
  type PrivateKeyBase64,
  type PublicKeyBase64,
  type SignatureBase64,
} from './authority-signing.js';

// ===========================================================================
// Shared primitives
// ===========================================================================

/** Common envelope header carried by every runner request. */
export interface RunnerEnvelopeHeader {
  /** Stable id of the actor whose key signed this request. */
  actorId: string;
  /** Random nonce to prevent replay; opaque to the contract. */
  nonce: string;
  /** ISO 8601 timestamp from the client's clock. */
  createdAt: string;
  /** Base64 Ed25519 signature over the canonical bytes of the signature-less envelope. */
  signature?: SignatureBase64;
}

const RunnerEnvelopeHeaderSchema = z.object({
  actorId: z.string().min(1),
  nonce: z.string().min(1),
  createdAt: z.string().min(1),
  signature: z.string().min(1).optional(),
});

// ===========================================================================
// Actor key registration  — POST /v1/actors/{actorId}/keys
// ===========================================================================

export interface ActorKeyRegistration extends RunnerEnvelopeHeader {
  /** Base64 raw Ed25519 public key being registered for this actor. */
  publicKey: PublicKeyBase64;
  /** Stable label / purpose hint (e.g. "primary", "ci-mac-runner"). */
  keyLabel?: string;
  /** Capability hints requested by the actor (server may downgrade). */
  capabilities?: string[];
}

export const ActorKeyRegistrationSchema = RunnerEnvelopeHeaderSchema.extend({
  publicKey: z.string().min(1),
  keyLabel: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
}).passthrough();

// ===========================================================================
// Runner register  — POST /v1/runners/register
// ===========================================================================

export interface RunnerRegistration extends RunnerEnvelopeHeader {
  /** Stable runner id chosen by the client (server may reject duplicates). */
  runnerId: string;
  /** Display name for dashboards. */
  runnerName?: string;
  /** Capability tags (e.g. "macos-arm64", "node22"). */
  capabilities?: string[];
  /** Runner build version. */
  runnerVersion?: string;
  /** Free-form metadata; opaque to the protocol. */
  metadata?: Record<string, unknown>;
}

export const RunnerRegistrationSchema = RunnerEnvelopeHeaderSchema.extend({
  runnerId: z.string().min(1),
  runnerName: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  runnerVersion: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ===========================================================================
// Runner heartbeat  — POST /v1/runners/{runnerId}/heartbeat
// ===========================================================================

export interface RunnerHeartbeat extends RunnerEnvelopeHeader {
  runnerId: string;
  /** Monotonic heartbeat sequence number (client clock independent). */
  sequence?: number;
  /** Active job ids being processed (if any). */
  activeJobs?: string[];
  /** Resource pressure hints (load, free memory, etc.). */
  health?: Record<string, unknown>;
}

export const RunnerHeartbeatSchema = RunnerEnvelopeHeaderSchema.extend({
  runnerId: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
  activeJobs: z.array(z.string()).optional(),
  health: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ===========================================================================
// Job claim  — POST /v1/runners/{runnerId}/jobs/claim
// ===========================================================================

export interface JobClaim extends RunnerEnvelopeHeader {
  runnerId: string;
  /** Lease duration the runner is requesting, in seconds. */
  leaseDurationSeconds?: number;
  /** Capability filter for which kinds of jobs may be claimed. */
  capabilities?: string[];
  /** Optional explicit job id to claim (otherwise next eligible). */
  jobId?: string;
}

export const JobClaimSchema = RunnerEnvelopeHeaderSchema.extend({
  runnerId: z.string().min(1),
  leaseDurationSeconds: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
  jobId: z.string().min(1).optional(),
}).passthrough();

// ===========================================================================
// Job spec  — response payload describing a claimed job
// ===========================================================================

export interface JobSpec {
  /** Stable job id. */
  jobId: string;
  /** Run id this job belongs to (binds producer/verifier evidence later). */
  runId: string;
  /** Job kind (e.g. "verify", "produce", "review"). */
  kind: string;
  /** Story id the job is scoped to. */
  storyId?: string;
  /** Project id the job is scoped to. */
  projectId?: string;
  /** Producer run id (the run that produced the artifact being verified). */
  producerRunId?: string;
  /** Verifier run id (independent verifier run; same-id as producer = collapse). */
  verifierRunId?: string;
  /** Provider/model/vendor binding for the executing actor. */
  provider?: string;
  model?: string;
  vendor?: string;
  /** Signed context pack reference (verifier reading boundary). */
  contextPackId?: string;
  contextPackDigest?: string;
  /** Lease expiry ISO timestamp. */
  leaseExpiresAt?: string;
  /** Authority-issued signature over the job spec (server-side). */
  signature?: SignatureBase64;
  /** Free-form additional fields the authority may attach. */
  metadata?: Record<string, unknown>;
}

export const JobSpecSchema = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1),
  kind: z.string().min(1),
  storyId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  producerRunId: z.string().min(1).optional(),
  verifierRunId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  vendor: z.string().min(1).optional(),
  contextPackId: z.string().min(1).optional(),
  contextPackDigest: z.string().min(1).optional(),
  leaseExpiresAt: z.string().min(1).optional(),
  signature: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ===========================================================================
// Job lease heartbeat  — POST /v1/jobs/{jobId}/heartbeat
// ===========================================================================

export interface JobLeaseHeartbeat extends RunnerEnvelopeHeader {
  jobId: string;
  /** Progress hint, 0..1 inclusive. */
  progress?: number;
  /** Optional renewed lease duration in seconds. */
  leaseDurationSeconds?: number;
  /** Free-form status. */
  status?: string;
}

export const JobLeaseHeartbeatSchema = RunnerEnvelopeHeaderSchema.extend({
  jobId: z.string().min(1),
  progress: z.number().min(0).max(1).optional(),
  leaseDurationSeconds: z.number().int().positive().optional(),
  status: z.string().min(1).optional(),
}).passthrough();

// ===========================================================================
// Job release  — POST /v1/jobs/{jobId}/release
// ===========================================================================

export type JobReleaseOutcome = 'completed' | 'failed' | 'cancelled' | 'abandoned';

export const JOB_RELEASE_OUTCOMES: readonly JobReleaseOutcome[] = [
  'completed',
  'failed',
  'cancelled',
  'abandoned',
] as const;

export interface JobRelease extends RunnerEnvelopeHeader {
  jobId: string;
  outcome: JobReleaseOutcome;
  /** Optional reason string for non-completed outcomes. */
  reason?: string;
  /** Optional evidence envelope id produced for this job. */
  evidenceId?: string;
}

export const JobReleaseSchema = RunnerEnvelopeHeaderSchema.extend({
  jobId: z.string().min(1),
  outcome: z.enum(JOB_RELEASE_OUTCOMES as unknown as [JobReleaseOutcome, ...JobReleaseOutcome[]]),
  reason: z.string().min(1).optional(),
  evidenceId: z.string().min(1).optional(),
}).passthrough();

// ===========================================================================
// Provider events  — POST /v1/runs/{runId}/provider-events
// ===========================================================================

export interface ProviderEvent {
  /** Stable event id (client chooses; server dedups). */
  eventId: string;
  /** Event kind (e.g. "start", "tool_use", "output", "finish"). */
  kind: string;
  /** ISO 8601 occurredAt timestamp. */
  occurredAt: string;
  /** Free-form payload. */
  payload?: Record<string, unknown>;
}

export const ProviderEventSchema = z.object({
  eventId: z.string().min(1),
  kind: z.string().min(1),
  occurredAt: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export interface ProviderEventsEnvelope extends RunnerEnvelopeHeader {
  runId: string;
  events: ProviderEvent[];
}

export const ProviderEventsEnvelopeSchema = RunnerEnvelopeHeaderSchema.extend({
  runId: z.string().min(1),
  events: z.array(ProviderEventSchema).min(1),
}).passthrough();

// ===========================================================================
// Authority receipt  — signed server response
// ===========================================================================

/**
 * The Python authority's signed receipt. The CLI never produces a receipt; it
 * only verifies one when reading runner / evidence submission responses.
 *
 * `signature` is the Ed25519 signature over the canonical bytes of the
 * signature-less view of this object, using the authority's published key.
 */
export interface AuthorityReceipt {
  /** Stable receipt id chosen by the authority. */
  receiptId: string;
  /** What this receipt is acknowledging (e.g. evidenceId, jobId). */
  subjectId: string;
  /** Kind of subject ("evidence" | "job" | "runner" | ...). */
  subjectKind: string;
  /** ISO 8601 timestamp the receipt was issued. */
  issuedAt: string;
  /** Authority-side actor id (the server identity). */
  authorityActorId: string;
  /** Base64 Ed25519 signature over the signature-less canonical bytes. */
  signature?: SignatureBase64;
  /** Optional digest of the artifact the receipt acknowledges. */
  subjectDigest?: string;
  /** Free-form metadata the authority may attach. */
  metadata?: Record<string, unknown>;
}

export const AuthorityReceiptSchema = z.object({
  receiptId: z.string().min(1),
  subjectId: z.string().min(1),
  subjectKind: z.string().min(1),
  issuedAt: z.string().min(1),
  authorityActorId: z.string().min(1),
  signature: z.string().min(1).optional(),
  subjectDigest: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// ===========================================================================
// Sign / verify helpers (runner envelopes)
// ===========================================================================

/**
 * Sign a runner envelope and attach the signature in-place.
 *
 * Runtime re-validation (Handler 编码约定): we enforce non-empty actorId /
 * nonce / createdAt at the runtime entry point, *not* only via Zod. A caller
 * who bypasses the schema (e.g. through internal fn re-use) still cannot
 * produce a signed envelope with an empty actor binding.
 */
export function signRunnerEnvelope<T extends RunnerEnvelopeHeader>(
  envelope: T,
  privateKey: PrivateKeyBase64,
): { signed: T & { signature: SignatureBase64 }; digest: string } {
  assertEnvelopeHeader(envelope);
  // Sign over the signature-less canonical bytes.
  // signEnvelopeRaw returns { signed, digest } over the cleaned envelope.
  // We pre-strip any existing signature to defend against accidental re-signing.
  const cleaned = stripSignature(envelope) as unknown as T;
  return signEnvelopeRaw(cleaned as unknown as Record<string, unknown>, privateKey) as unknown as {
    signed: T & { signature: SignatureBase64 };
    digest: string;
  };
}

/**
 * Verify a signed runner envelope using the actor's published public key.
 *
 * Returns false (does NOT throw) on any tamper / wrong-key / missing-actor
 * path so the caller can map verification failure to a controlled outcome.
 */
export function verifyRunnerEnvelope<T extends RunnerEnvelopeHeader>(
  envelope: T,
  publicKey: PublicKeyBase64,
): boolean {
  // Runtime re-validation (Handler 编码约定): missing actor binding cannot
  // verify regardless of signature presence.
  if (!isNonEmptyString(envelope.actorId)) return false;
  if (!isNonEmptyString(envelope.nonce)) return false;
  if (!isNonEmptyString(envelope.createdAt)) return false;
  return verifySignedEnvelope(envelope, publicKey);
}

/**
 * Verify an authority-issued signed receipt against the authority's published
 * public key. Same semantics as {@link verifyRunnerEnvelope}: returns false on
 * any failure path.
 */
export function verifyAuthorityReceipt(
  receipt: AuthorityReceipt,
  authorityPublicKey: PublicKeyBase64,
): boolean {
  if (!isNonEmptyString(receipt.receiptId)) return false;
  if (!isNonEmptyString(receipt.subjectId)) return false;
  if (!isNonEmptyString(receipt.subjectKind)) return false;
  if (!isNonEmptyString(receipt.authorityActorId)) return false;
  const sig = receipt.signature;
  if (!isNonEmptyString(sig)) return false;
  const unsigned = stripSignature(receipt);
  return verifyCanonical(unsigned, sig, authorityPublicKey);
}

// ===========================================================================
// Adversarial classifier (runner-evidence trust boundary)
// ===========================================================================

/**
 * Requirements for a runner-issued envelope to *even be a candidate* for L2+
 * receipt-backed evidence. This is the runner-side mirror of
 * authority-boundary.AuthorityL2Requirement and intentionally redundant — both
 * surfaces must agree, and the smoke test asserts the conjunction.
 */
export type RunnerL2Requirement =
  | 'actorId'
  | 'nonce'
  | 'createdAt'
  | 'envelopeSignature'
  | 'producerRunId'
  | 'verifierRunId'
  | 'independentVerifierRunId'
  | 'provider'
  | 'model'
  | 'vendor'
  | 'commandDigest'
  | 'transcriptHash'
  | 'diffHash'
  | 'verifiedAuthorityReceipt';

export const RUNNER_L2_REQUIREMENTS: ReadonlyArray<RunnerL2Requirement> = [
  'actorId',
  'nonce',
  'createdAt',
  'envelopeSignature',
  'producerRunId',
  'verifierRunId',
  'independentVerifierRunId',
  'provider',
  'model',
  'vendor',
  'commandDigest',
  'transcriptHash',
  'diffHash',
  'verifiedAuthorityReceipt',
];

/** Bundle the run-binding metadata that a runner-issued envelope might carry. */
export interface RunnerRunBinding {
  producerRunId?: string;
  verifierRunId?: string;
  provider?: string;
  model?: string;
  vendor?: string;
  commandDigest?: string;
  transcriptHash?: string;
  diffHash?: string;
}

export interface RunnerL2ClassificationInput {
  envelope: RunnerEnvelopeHeader;
  runBinding?: RunnerRunBinding;
  /** Has the consumer cryptographically verified an authority-signed receipt? */
  receiptVerified?: boolean;
}

/**
 * Enumerate the missing L2+ requirements for a runner-issued envelope.
 *
 * Adversarial invariant (CHK-001): adding signing primitives MUST NOT promote
 * an ordinary local/shadow envelope to L2+. The classifier here is the
 * mechanical witness — every CLI-shaped runner envelope (no run binding, no
 * receipt verified) still surfaces missing requirements.
 */
export function missingRunnerL2Requirements(
  input: RunnerL2ClassificationInput,
): RunnerL2Requirement[] {
  const env = input.envelope;
  const bind = input.runBinding ?? {};
  const missing: RunnerL2Requirement[] = [];
  if (!isNonEmptyString(env.actorId)) missing.push('actorId');
  if (!isNonEmptyString(env.nonce)) missing.push('nonce');
  if (!isNonEmptyString(env.createdAt)) missing.push('createdAt');
  if (!isNonEmptyString(env.signature)) missing.push('envelopeSignature');
  if (!isNonEmptyString(bind.producerRunId)) missing.push('producerRunId');
  if (!isNonEmptyString(bind.verifierRunId)) missing.push('verifierRunId');
  // L2+ requires the verifier to be an INDEPENDENT run from the producer (see
  // authority-client-role.md §"Cold-read definition of L2+ authority"). A
  // same-run envelope collapses the separation and is not L2+ even if every
  // other field is populated.
  if (
    isNonEmptyString(bind.producerRunId) &&
    isNonEmptyString(bind.verifierRunId) &&
    bind.producerRunId.trim() === bind.verifierRunId.trim()
  ) {
    missing.push('independentVerifierRunId');
  }
  if (!isNonEmptyString(bind.provider)) missing.push('provider');
  if (!isNonEmptyString(bind.model)) missing.push('model');
  if (!isNonEmptyString(bind.vendor)) missing.push('vendor');
  if (!isNonEmptyString(bind.commandDigest)) missing.push('commandDigest');
  if (!isNonEmptyString(bind.transcriptHash)) missing.push('transcriptHash');
  if (!isNonEmptyString(bind.diffHash)) missing.push('diffHash');
  if (input.receiptVerified !== true) missing.push('verifiedAuthorityReceipt');
  return missing;
}

/**
 * True iff a runner-issued envelope satisfies *every* L2+ requirement.
 *
 * This is the adversarial witness used by authority-runner-contracts-smoke:
 * for any ordinary local/shadow runner envelope produced by this CLI today,
 * this function returns false — proving that signing primitives by themselves
 * cannot promote evidence to receipt-backed L2+.
 */
export function runnerEnvelopeIsL2PlusCandidate(input: RunnerL2ClassificationInput): boolean {
  return missingRunnerL2Requirements(input).length === 0;
}

// ===========================================================================
// Schema parse helpers (Handler 编码约定: runtime re-validation entry points)
// ===========================================================================

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`${label} is invalid: ${issues}`);
  }
  return result.data;
}

export const parseActorKeyRegistration = (v: unknown) =>
  parseOrThrow(ActorKeyRegistrationSchema, v, 'actor key registration');
export const parseRunnerRegistration = (v: unknown) =>
  parseOrThrow(RunnerRegistrationSchema, v, 'runner registration');
export const parseRunnerHeartbeat = (v: unknown) =>
  parseOrThrow(RunnerHeartbeatSchema, v, 'runner heartbeat');
export const parseJobClaim = (v: unknown) =>
  parseOrThrow(JobClaimSchema, v, 'job claim');
export const parseJobSpec = (v: unknown) =>
  parseOrThrow(JobSpecSchema, v, 'job spec');
export const parseJobLeaseHeartbeat = (v: unknown) =>
  parseOrThrow(JobLeaseHeartbeatSchema, v, 'job lease heartbeat');
export const parseJobRelease = (v: unknown) =>
  parseOrThrow(JobReleaseSchema, v, 'job release');
export const parseProviderEventsEnvelope = (v: unknown) =>
  parseOrThrow(ProviderEventsEnvelopeSchema, v, 'provider events envelope');
export const parseAuthorityReceipt = (v: unknown) =>
  parseOrThrow(AuthorityReceiptSchema, v, 'authority receipt');

/** Compute canonical digest for an envelope (re-exported for callers). */
export function digestRunnerEnvelope(value: unknown): string {
  return canonicalDigest(value);
}

// ===========================================================================
// Internal helpers
// ===========================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertEnvelopeHeader(env: RunnerEnvelopeHeader): void {
  if (!isNonEmptyString(env.actorId)) throw new Error('runner envelope: actorId is required (non-empty string)');
  if (!isNonEmptyString(env.nonce)) throw new Error('runner envelope: nonce is required (non-empty string)');
  if (!isNonEmptyString(env.createdAt)) throw new Error('runner envelope: createdAt is required (non-empty string)');
}
