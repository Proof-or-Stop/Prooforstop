import type { ZodType } from 'zod';
import {
  AuthorityEvidenceBatchSubmissionResultSchema,
  AuthorityEvidenceSubmissionResultSchema,
  AuthorityPolicyContractSchema,
  AUTHORITY_POLICY_OVERCLAIM_KEYS,
  AuthorityVerdictListResultSchema,
  AuthorityVerdictSubmitResultSchema,
  GateEvaluateResultContractSchema,
  detectPolicyOverclaim,
  type AuthorityEvidenceBatchSubmissionResult,
  type AuthorityEvidenceSubmissionResult,
  type AuthorityGateDecisionValue,
  type AuthorityPolicyContract,
  type AuthorityRunEventsEnvelope,
  type AuthorityVerdictClaim,
  type AuthorityVerdictListResult,
  type AuthorityVerdictReceipt,
  type AuthorityVerdictReconciliation,
  type AuthorityVerdictSubmitResult,
  type EvidenceEnvelopeContract,
  type GateEvaluateRequestContract,
  type GateEvaluateResultContract,
  type AuthorityRunEvent,
  buildAuthorityEvidenceBatchSubmission,
  buildAuthorityRunEventsEnvelope,
  buildGateEvaluateRequest,
} from './authority-contracts.js';
import {
  AuthorityGateReceiptProofSchema,
  type AuthorityGateReceiptProof,
} from './authority-gate-receipt-verifier.js';
import {
  normalizePrivateKeyToBase64,
  verifyLatticeAuthorityReceipt,
  type LatticeAuthorityKeyEncoding,
} from './lattice-authority-native.js';
import {
  checkFinalHostReviewPromptDigest,
  checkReceiptBeforeVerdict,
  deriveSignedServerReviewWaveReconciliation,
  partitionFreshWaveVerdicts,
  reconcileAuthorityCertification,
  type AuthorityCertificationView,
  type DisagreementBehavior,
} from './verdicts.js';
import { canonicalDigest, signCanonical, stripSignature } from './authority-signing.js';
import type { JobPlan } from './planner.js';
import {
  buildAuthorityGateInput,
  type AuthorityGateEvaluator,
  type AuthorityGateOutcome,
  type PlannedStepExecution,
} from './planned-steps-executor.js';
import {
  ActorKeyRegistrationSchema,
  AuthorityReceiptSchema,
  JobClaimSchema,
  JobLeaseHeartbeatSchema,
  JobReleaseSchema,
  JobSpecSchema,
  ProviderEventsEnvelopeSchema,
  RunnerHeartbeatSchema,
  RunnerRegistrationSchema,
  type ActorKeyRegistration,
  type AuthorityReceipt,
  type JobClaim,
  type JobLeaseHeartbeat,
  type JobRelease,
  type JobSpec,
  type ProviderEventsEnvelope,
  type RunnerHeartbeat,
  type RunnerRegistration,
} from './authority-runner-contracts.js';
import {
  authorityModeEnabled,
  loadAuthoritySettings,
  normalizeAuthorityTrustEnv,
  normalizeAuthorityMode,
  parseAuthorityMd,
  parseAuthorityTrustEnv,
  resolveAuthorityConfig,
  readAuthorityEnv,
  DEFAULT_AUTHORITY_KEY_FILE,
  DEFAULT_AUTHORITY_TRUST_ENV_FILE,
  type AuthorityConfig,
  type AuthorityMdConfig,
  type AuthorityMode,
  type AuthoritySettings,
  type AuthoritySettingsOverride,
  DEFAULT_AUTHORITY_TIMEOUT_MS,
} from './authority-mode.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { z } from 'zod';

/**
 * HTTP client that POSTs verification evidence envelopes to the cross-repo Python
 * authority server (LATTICE_AUTHORITY_URL).
 * The defining responsibility for B-94a6 is
 * to mechanically distinguish every transport / server outcome, so that shadow mode
 * (CHK-003) can degrade ANY failure to a warning while enforce mode (CHK-004) can
 * gate strictly on success.
 *
 * Outcome taxonomy (mutually exclusive, see {@link AuthorityClientOutcome}):
 *  - success           : HTTP 2xx + non-empty body that PASSES the submission-result
 *                        schema (Handler coding convention: a 2xx whose body fails schema is
 *                        NOT treated as success — see `error`). An empty 2xx body is a
 *                        success with `data = {}` (server gave nothing to validate).
 *  - http_error        : HTTP 4xx / 5xx (server reachable, request rejected)
 *  - timeout           : request aborted because it exceeded timeoutMS
 *  - connection_refused: TCP connection refused / DNS failure / network unreachable
 *  - error             : any other thrown failure (e.g. JSON parse error) OR a 2xx
 *                        whose non-empty body fails schema validation (malformed body).
 *                        Malformed-body → `error` (ok:false) so that enforce mode does
 *                        0 local writes and shadow mode degrades to a warning, never
 *                        accepting an unverified server response (evidence integrity).
 */

export type AuthorityClientOutcomeKind =
  | 'success'
  | 'http_error'
  | 'timeout'
  | 'connection_refused'
  | 'error';

export interface AuthorityClientOutcome<T> {
  kind: AuthorityClientOutcomeKind;
  /** Whether the request succeeded end-to-end (kind === 'success'). */
  ok: boolean;
  /** Parsed response body — present only on success. */
  data?: T;
  /** HTTP status code — present for success and http_error. */
  status?: number;
  /** Human-readable message for any non-success outcome. */
  message?: string;
  /** Original error object for non-HTTP failures (timeout / refused / error). */
  cause?: unknown;
}

/** Minimal fetch shape so tests can inject a stub without a real network. */
export interface AuthorityFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type AuthorityFetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type AuthorityFetch = (
  input: string,
  init: AuthorityFetchInit,
) => Promise<AuthorityFetchResponse>;

export interface AuthorityClientAuth {
  /** Customer API key used only for mutating Authority requests. Never logged. */
  customerApiKey?: string;
}

export const AuthorityJobCreateResultSchema = z.object({
  job: z.record(z.string(), z.unknown()),
  run: z.record(z.string(), z.unknown()),
}).passthrough();

export type AuthorityJobCreateResult = z.infer<typeof AuthorityJobCreateResultSchema>;

/** Connection-level error codes treated as "server unreachable". */
const CONNECTION_REFUSED_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ABORT_ERR';
}

function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  // node fetch wraps the underlying cause; check both levels.
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') return causeCode;
  }
  return undefined;
}

function classifyThrown<T>(error: unknown): AuthorityClientOutcome<T> {
  if (isAbortError(error)) {
    return {
      kind: 'timeout',
      ok: false,
      message: 'authority request timed out',
      cause: error,
    };
  }
  const code = extractErrorCode(error);
  if (code && CONNECTION_REFUSED_CODES.has(code)) {
    return {
      kind: 'connection_refused',
      ok: false,
      message: `authority server unreachable (${code})`,
      cause: error,
    };
  }
  return {
    kind: 'error',
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  };
}

export class AuthorityClient {
  constructor(
    readonly baseURL: string,
    private readonly fetchImpl: AuthorityFetch = globalThis.fetch as unknown as AuthorityFetch,
    private readonly timeoutMS: number = DEFAULT_AUTHORITY_TIMEOUT_MS,
    private readonly auth: AuthorityClientAuth = {},
  ) {}

  /** POST a single evidence envelope to /v1/evidence. */
  async submitEvidence(
    envelope: EvidenceEnvelopeContract,
  ): Promise<AuthorityClientOutcome<AuthorityEvidenceSubmissionResult>> {
    return this.post<AuthorityEvidenceSubmissionResult>(
      '/v1/evidence',
      envelope,
      AuthorityEvidenceSubmissionResultSchema,
    );
  }

  /** POST /v1/jobs — submit a signed Authority job-create envelope. */
  async createJob(
    envelope: Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<AuthorityJobCreateResult>> {
    return this.post<AuthorityJobCreateResult>(
      '/v1/jobs',
      envelope,
      AuthorityJobCreateResultSchema,
    );
  }

  /** POST a batch of evidence envelopes to /v1/evidence/batch (all-or-nothing). */
  async submitEvidenceBatch(
    envelopes: EvidenceEnvelopeContract[],
  ): Promise<AuthorityClientOutcome<AuthorityEvidenceBatchSubmissionResult>> {
    return this.post<AuthorityEvidenceBatchSubmissionResult>(
      '/v1/evidence/batch',
      buildAuthorityEvidenceBatchSubmission(envelopes),
      AuthorityEvidenceBatchSubmissionResultSchema,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Runner endpoint methods (B-1123 milestone 2)
  //
  // Mirror the Python authority's headless runner routes. Each method takes
  // an already-signed envelope (signing is the caller's responsibility — see
  // authority-runner-contracts.signRunnerEnvelope) and returns the same
  // outcome taxonomy used by submitEvidence().
  //
  // Trust boundary: a successful runner round-trip does NOT promote ordinary
  // local/shadow workflow submissions to receipt-backed L2+. See
  // authority-boundary.ts; the classifier is the single mechanical truth source.
  // ─────────────────────────────────────────────────────────────────────────

  /** POST /v1/actors/{actorId}/keys — register an Ed25519 public key for an actor. */
  async registerActorKey(
    actorId: string,
    envelope: ActorKeyRegistration,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    assertNonEmpty(actorId, 'actorId');
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      `/v1/actors/${encodeURIComponent(actorId)}/keys`,
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /** POST /v1/runners/register — register a runner instance. */
  async registerRunner(
    envelope: RunnerRegistration,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      '/v1/runners/register',
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /** POST /v1/runners/{runnerId}/heartbeat — emit a runner heartbeat. */
  async heartbeatRunner(
    runnerId: string,
    envelope: RunnerHeartbeat,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    assertNonEmpty(runnerId, 'runnerId');
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      `/v1/runners/${encodeURIComponent(runnerId)}/heartbeat`,
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /** POST /v1/runners/{runnerId}/jobs/claim — claim the next eligible job. */
  async claimJob(
    runnerId: string,
    envelope: JobClaim,
  ): Promise<AuthorityClientOutcome<JobSpec | null>> {
    assertNonEmpty(runnerId, 'runnerId');
    return this.post<JobSpec | null>(
      `/v1/runners/${encodeURIComponent(runnerId)}/jobs/claim`,
      envelope,
      JobSpecOrNullSchema,
    );
  }

  /** POST /v1/jobs/{jobId}/heartbeat — extend a job lease. */
  async heartbeatJob(
    jobId: string,
    envelope: JobLeaseHeartbeat | Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    assertNonEmpty(jobId, 'jobId');
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      `/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`,
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /** POST /v1/jobs/{jobId}/release — release a job lease (Python release requeues; completion is a run event). */
  async releaseJob(
    jobId: string,
    envelope: JobRelease | Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    assertNonEmpty(jobId, 'jobId');
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      `/v1/jobs/${encodeURIComponent(jobId)}/release`,
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /** POST /v1/runs/{runId}/provider-events — submit one provider event envelope. */
  async submitProviderEvents(
    runId: string,
    envelope: ProviderEventsEnvelope | Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    assertNonEmpty(runId, 'runId');
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      `/v1/runs/${encodeURIComponent(runId)}/provider-events`,
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /**
   * POST /v1/runs/{runId}/events — append command / validation / repair / summary /
   * completion events. Same ack taxonomy as submitProviderEvents (AuthorityReceipt or
   * empty passthrough); the CLI never mints a receipt from this ack.
   */
  async appendRunEvents(
    runId: string,
    envelope: AuthorityRunEventsEnvelope | Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<AuthorityReceipt | Record<string, unknown>>> {
    assertNonEmpty(runId, 'runId');
    return this.post<AuthorityReceipt | Record<string, unknown>>(
      `/v1/runs/${encodeURIComponent(runId)}/events`,
      envelope,
      AuthorityReceiptOrEmptySchema,
    );
  }

  /**
   * POST /v1/gates/evaluate — request a native gate decision (B6 / B15).
   *
   * Returns the typed gate result (decision + optional decisionDigest / receiptId /
   * embedded receipt). This is NOT a DONE projection: the caller must fetch (when
   * only a receiptId is returned) and verify the native gate_decision receipt before
   * any authority DONE. See {@link evaluateAuthorityGate} for the verify loop.
   */
  async evaluateGate(
    request: GateEvaluateRequestContract | Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<GateEvaluateResultContract>> {
    return this.post<GateEvaluateResultContract>(
      '/v1/gates/evaluate',
      request,
      GateEvaluateResultContractSchema,
    );
  }

  /**
   * GET /v1/receipts/{receiptId} — fetch a native receipt by id.
   *
   * Unlike policy discovery, the receipt body legitimately contains `receiptId`
   * (and may contain other discovery-overclaim keys), so the overclaim guard is
   * disabled here. The body is returned raw for the native verifier — this method
   * does NOT verify or trust it.
   */
  async fetchReceipt(
    receiptId: string,
  ): Promise<AuthorityClientOutcome<Record<string, unknown>>> {
    assertNonEmpty(receiptId, 'receiptId');
    return this.get<Record<string, unknown>>(
      `/v1/receipts/${encodeURIComponent(receiptId)}`,
      undefined,
      { rejectOverclaim: false },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-host verdict endpoints (truth source §X9 verdict submission)
  //
  // POST submits ONE host's verdict claim; GET reads the Authority-computed
  // reconciliation. These never produce a gate_decision receipt or authority DONE
  // — a verdict endpoint returning a `gate_decision`-kinded receipt fails schema
  // validation (the kind refine in AuthorityVerdictReceiptSchema), so the client
  // can never launder a host opinion into a production DONE decision.
  // ─────────────────────────────────────────────────────────────────────────

  /** POST /v1/jobs/{jobId}/verdicts — submit one host's multi-host verifier verdict. */
  async submitJobVerdict(
    jobId: string,
    envelope: Record<string, unknown>,
  ): Promise<AuthorityClientOutcome<AuthorityVerdictSubmitResult>> {
    assertNonEmpty(jobId, 'jobId');
    return this.post<AuthorityVerdictSubmitResult>(
      `/v1/jobs/${encodeURIComponent(jobId)}/verdicts`,
      envelope,
      AuthorityVerdictSubmitResultSchema,
    );
  }

  /**
   * GET /v1/jobs/{jobId}/verdicts — list verdicts + Authority-computed reconciliation
   * (`independentHostCount` / `satisfied`). The policy-discovery overclaim guard is
   * disabled here: this is not policy discovery, and the body legitimately nests
   * `host_verdict` receipts under `verdicts[]`. Independence is the server's count,
   * never recomputed client-side.
   */
  async listJobVerdicts(
    jobId: string,
  ): Promise<AuthorityClientOutcome<AuthorityVerdictListResult>> {
    assertNonEmpty(jobId, 'jobId');
    return this.get<AuthorityVerdictListResult>(
      `/v1/jobs/${encodeURIComponent(jobId)}/verdicts`,
      AuthorityVerdictListResultSchema,
      { authenticated: true, rejectOverclaim: false },
    );
  }

  /**
   * GET /v1/authority/policy — read-only authority policy discovery (B-ea92 M1).
   *
   * Outcome taxonomy mirrors POST paths above, with two additional M1 guards:
   *  - Overclaim guard: a 2xx body containing `receipt`, `receiptId`,
   *    `gatePassed`, or `accepted` is rejected with `kind:'error'` (ok:false).
   *    These keys belong to the evidence-submission protocol and must never
   *    appear in a discovery response.
   *  - Schema guard: identical to POST — a parseable-but-wrong-shape body maps
   *    to `error` (ok:false) so callers never accept an unverified policy body.
   *
   * This method NEVER calls /v1/evidence or /v1/evidence/batch.
   */
  async discoverPolicy(): Promise<AuthorityClientOutcome<AuthorityPolicyContract>> {
    return this.get<AuthorityPolicyContract>(
      '/v1/authority/policy',
      AuthorityPolicyContractSchema,
    );
  }

  /**
   * GET a server-relative Authority gate receipt proof.
   *
   * This is intentionally a transport + schema fetch only. The caller must run
   * verifyAuthorityGateReceiptProof() before treating the body as evidence.
   */
  async fetchGateReceiptProof(
    proofPath: string,
  ): Promise<AuthorityClientOutcome<AuthorityGateReceiptProof>> {
    assertServerRelativePath(proofPath, 'proofPath');
    return this.get<AuthorityGateReceiptProof>(
      proofPath,
      AuthorityGateReceiptProofSchema,
      {
        policyOverclaimGuard: false,
        label: 'authority receipt proof response',
        emptyBodyMessage: 'authority receipt proof response body is empty (malformed proof)',
      },
    );
  }

  /**
   * Generic GET helper — parallel to `post()` but reads no body and sends no
   * request body. Returns the same outcome taxonomy (success / http_error /
   * timeout / connection_refused / error).
   *
   * Additional M1 overclaim guard: if the response body contains any key from
   * AUTHORITY_POLICY_OVERCLAIM_KEYS the outcome is `error` (ok:false).
   */
  private async get<T>(
    path: string,
    schema?: ZodType<T>,
    options: {
      authenticated?: boolean;
      policyOverclaimGuard?: boolean;
      rejectOverclaim?: boolean;
      label?: string;
      emptyBodyMessage?: string;
    } = {},
  ): Promise<AuthorityClientOutcome<T>> {
    const label = options.label ?? 'authority policy response';
    const rejectOverclaim = options.rejectOverclaim !== false && options.policyOverclaimGuard !== false;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.authenticated === true) {
      const customerApiKey = this.auth.customerApiKey?.trim();
      if (!customerApiKey) {
        return {
          kind: 'error',
          ok: false,
          message: 'customer_api_key_unconfigured_fails_closed: customer API key is required for protected Authority reads',
        };
      }
      headers.Authorization = `Bearer ${customerApiKey}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMS);
    let response: AuthorityFetchResponse;
    try {
      response = await this.fetchImpl(joinURL(this.baseURL, path), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      return classifyThrown<T>(error);
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return classifyThrown<T>(error);
    }

    if (!response.ok) {
      return {
        kind: 'http_error',
        ok: false,
        status: response.status,
        message: `authority server rejected request (${response.status})${text ? `: ${text}` : ''}`,
      };
    }

    if (!text) {
      return {
        kind: 'error',
        ok: false,
        status: response.status,
        message: options.emptyBodyMessage ?? `${label} body is empty (malformed body)`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return classifyThrown<T>(error);
    }

    // Overclaim guard (M1): reject if any overclaim key is present at top level.
    // Skipped for endpoints (e.g. /v1/receipts/{id}) whose body legitimately
    // carries receiptId — those are verified by the native receipt verifier.
    const overclaim = rejectOverclaim ? detectPolicyOverclaim(parsed) : undefined;
    if (overclaim !== undefined) {
      return {
        kind: 'error',
        ok: false,
        status: response.status,
        message: `authority policy response contains overclaim key "${overclaim}": policy discovery cannot include evidence-submission fields (${AUTHORITY_POLICY_OVERCLAIM_KEYS.join(', ')})`,
      };
    }

    if (!schema) {
      return { kind: 'success', ok: true, status: response.status, data: parsed as T };
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        kind: 'error',
        ok: false,
        status: response.status,
        message: `${label} failed schema validation (malformed body): ${result.error.message}`,
        cause: result.error,
      };
    }
    return { kind: 'success', ok: true, status: response.status, data: result.data };
  }

  /**
   * @param schema Submission-result schema used to validate a non-empty 2xx body.
   *   On parse failure the outcome becomes `kind:'error'` (ok:false) — a 2xx with a
   *   malformed body is never reported as success (Handler coding convention / evidence
   *   integrity). An empty 2xx body short-circuits to `{}` success (nothing to validate).
   */
  private async post<T>(
    path: string,
    body: unknown,
    schema?: ZodType<T>,
  ): Promise<AuthorityClientOutcome<T>> {
    const headers = this.postHeaders();
    if (!headers.Authorization) {
      return {
        kind: 'error',
        ok: false,
        message: 'customer_api_key_unconfigured_fails_closed: customer API key is required for mutating Authority calls',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMS);
    let response: AuthorityFetchResponse;
    try {
      response = await this.fetchImpl(joinURL(this.baseURL, path), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      return classifyThrown<T>(error);
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return classifyThrown<T>(error);
    }

    if (!response.ok) {
      return {
        kind: 'http_error',
        ok: false,
        status: response.status,
        message: `authority server rejected request (${response.status})${text ? `: ${text}` : ''}`,
      };
    }

    // Empty 2xx body: nothing to validate, succeed with {} (preserves the legacy
    // 204/empty-body contract; mode logic still gates on the absent `accepted` flag).
    if (!text) {
      return { kind: 'success', ok: true, status: response.status, data: {} as T };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return classifyThrown<T>(error);
    }

    // No schema (defensive: callers always pass one) -> behave as before.
    if (!schema) {
      return { kind: 'success', ok: true, status: response.status, data: parsed as T };
    }

    // 2xx but the body fails the submission-result schema: a malformed/unconfirmed
    // server response must NOT be accepted as success. Map to `error` (ok:false) so
    // enforce -> 0 local write and shadow -> warning + local write kept.
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        kind: 'error',
        ok: false,
        status: response.status,
        message: `authority response failed schema validation (malformed body): ${result.error.message}`,
        cause: result.error,
      };
    }
    return { kind: 'success', ok: true, status: response.status, data: result.data };
  }

  private postHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const customerApiKey = this.auth.customerApiKey?.trim();
    if (customerApiKey) headers.Authorization = `Bearer ${customerApiKey}`;
    return headers;
  }
}

export function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authority gate evaluation + native receipt verification (B6 / B15)
//
// The single async orchestration the executor's gate.evaluate step delegates to:
//   evaluate -> (fetch receipt if only an id is returned) -> verify native receipt.
// It NEVER mints a receipt. `receiptVerified` is true ONLY when the server returned
// a native gate_decision receipt AND verifyLatticeAuthorityReceipt accepted it for
// an `approve` decision. Every other path (reject / blocked / missing or unverified
// receipt / transport error) returns receiptVerified=false so the caller fails closed.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthorityGateVerifyConfig {
  /** Server public key used to verify the native receipt signature. */
  serverPublicKey: string;
  serverPublicKeyEncoding?: LatticeAuthorityKeyEncoding;
  serverPublicKeyAlgorithm?: string;
  expectedProjectId?: string;
  expectedStoryId?: string;
  expectedServerKeyId?: string;
  /** When set, the receipt decisionDigest must match exactly (B6 step 8). */
  expectedDecisionDigest?: string;
  /** Freshness window; enforced when provided (enforce default 600000). */
  maxAgeMs?: number;
  clockSkewMs?: number;
  now?: Date;
}

export type AuthorityGateStatus =
  | 'verified'
  | 'rejected'
  | 'blocked'
  | 'receipt_unavailable'
  | 'receipt_unverified'
  | 'error';

export interface AuthorityGateDecision {
  status: AuthorityGateStatus;
  /** The server gate verdict, when the evaluate call succeeded. */
  decision?: AuthorityGateDecisionValue;
  /** True ONLY for a verified native gate_decision receipt on an `approve`. */
  receiptVerified: boolean;
  receiptId?: string;
  decisionDigest?: string;
  /** X5 gate input digest certified by this gate request. */
  gateInputDigest?: string;
  /** inputDigest bound into the verified native gate_decision receipt. */
  receiptInputDigest?: string;
  reason: string;
}

function requestGateInputDigest(request: GateEvaluateRequestContract | Record<string, unknown>): string | undefined {
  const direct = (request as Record<string, unknown>).gateInputDigest;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : undefined;
}

function normalizePythonDigestJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizePythonDigestJson).filter(item => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareJsonKeyByCodePoint(a, b))) {
      const normalized = normalizePythonDigestJson(item);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function compareJsonKeyByCodePoint(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const max = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < max; index += 1) {
    const diff = (aPoints[index]?.codePointAt(0) ?? 0) - (bPoints[index]?.codePointAt(0) ?? 0);
    if (diff !== 0) return diff;
  }
  return aPoints.length - bPoints.length;
}

function pythonAuthorityDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizePythonDigestJson(value)), 'utf8')
    .digest('hex');
}

function requestReceiptInputDigest(request: GateEvaluateRequestContract | Record<string, unknown>): string | undefined {
  const decision = (request as Record<string, unknown>).decision;
  if (!decision || typeof decision !== 'object') return undefined;
  const input = { ...(decision as Record<string, unknown>) };
  const repo = input.repo;
  if (repo && typeof repo === 'object') {
    const raw = repo as Record<string, unknown>;
    input.repo = {
      headHash: raw.headHash,
      materialHash: raw.materialHash,
      baseHash: raw.baseHash ?? null,
      treeHash: raw.treeHash ?? null,
      diffHash: raw.diffHash ?? null,
      manifestHash: raw.manifestHash ?? null,
      dirty: raw.dirty ?? false,
    };
  }
  return pythonAuthorityDigest(input);
}

/**
 * @task B-e3d9
 * @checklist CHK-001
 * @title Fail closed on unsupported algorithm in production receipt verification material
 * @type bugfix
 * @priority high
 * @description
 *   Thread the discovered Authority `serverKey.algorithm` through the receipt
 *   verification config so production receipt checks reject unsupported algorithm
 *   values based on verification material, instead of silently treating every
 *   discovered key as Ed25519-compatible.
 * @changes
 *   - [CHK-001] Carry policy-discovered `serverKey.algorithm` into receipt verification material.
 *   - [CHK-001] Reject unsupported algorithm values fail-closed during production receipt verification.
 */
/**
 * Run the gate evaluation + native receipt verification loop. Pure orchestration
 * over the typed client methods + the native verifier — no client-side minting.
 */
export async function evaluateAuthorityGate(
  client: AuthorityClient,
  request: GateEvaluateRequestContract | Record<string, unknown>,
  verify: AuthorityGateVerifyConfig,
  expectedGateInputDigest = requestGateInputDigest(request),
  expectedReceiptInputDigest = requestReceiptInputDigest(request) ?? expectedGateInputDigest,
): Promise<AuthorityGateDecision> {
  const evaluation = await client.evaluateGate(request);
  if (!evaluation.ok || !evaluation.data) {
    return {
      status: 'error',
      receiptVerified: false,
      reason: `gate evaluate call failed (${evaluation.kind})${evaluation.message ? `: ${evaluation.message}` : ''}`,
    };
  }
  const result = evaluation.data;
  if (result.decision !== 'approve') {
    return {
      status: result.decision === 'reject' ? 'rejected' : 'blocked',
      decision: result.decision,
      receiptVerified: false,
      reason: result.reason ?? `authority gate decision: ${result.decision}`,
    };
  }

  // approve: a verified native gate_decision receipt is required before DONE.
  let receiptBody: unknown = result.receipt;
  if (receiptBody === undefined && result.receiptId) {
    const fetched = await client.fetchReceipt(result.receiptId);
    if (!fetched.ok || !fetched.data) {
      return {
        status: 'receipt_unavailable',
        decision: 'approve',
        receiptVerified: false,
        receiptId: result.receiptId,
        reason: `approve decision but receipt fetch failed (${fetched.kind})${fetched.message ? `: ${fetched.message}` : ''}`,
      };
    }
    receiptBody = fetched.data;
  }
  if (receiptBody === undefined) {
    return {
      status: 'receipt_unavailable',
      decision: 'approve',
      receiptVerified: false,
      reason: 'approve decision but no native gate_decision receipt was returned (inline or by id)',
    };
  }

  const verification = verifyLatticeAuthorityReceipt(receiptBody, {
    serverPublicKey: verify.serverPublicKey,
    serverPublicKeyEncoding: verify.serverPublicKeyEncoding,
    serverPublicKeyAlgorithm: verify.serverPublicKeyAlgorithm,
    expectedKind: 'gate_decision',
    expectedProjectId: verify.expectedProjectId,
    expectedStoryId: verify.expectedStoryId,
    expectedServerKeyId: verify.expectedServerKeyId,
    expectedDecisionDigest: verify.expectedDecisionDigest ?? result.decisionDigest,
    maxAgeMs: verify.maxAgeMs,
    clockSkewMs: verify.clockSkewMs,
    now: verify.now,
  });
  if (!verification.verified) {
    return {
      status: 'receipt_unverified',
      decision: 'approve',
      receiptVerified: false,
      receiptId: verification.receipt.receiptId,
      decisionDigest: verification.receipt.decisionDigest,
      receiptInputDigest: verification.receipt.inputDigest,
      reason: verification.reason,
    };
  }
  if (expectedReceiptInputDigest && verification.receipt.inputDigest !== expectedReceiptInputDigest) {
    return {
      status: 'receipt_unverified',
      decision: 'approve',
      receiptVerified: false,
      receiptId: verification.receipt.receiptId,
      decisionDigest: verification.receipt.decisionDigest,
      gateInputDigest: expectedGateInputDigest,
      receiptInputDigest: verification.receipt.inputDigest,
      reason: `Lattice Authority receipt binding mismatch: inputDigest expected ${expectedReceiptInputDigest}, got ${verification.receipt.inputDigest}`,
    };
  }
  return {
    status: 'verified',
    decision: 'approve',
    receiptVerified: true,
    receiptId: verification.receipt.receiptId,
    decisionDigest: verification.receipt.decisionDigest,
    gateInputDigest: expectedGateInputDigest ?? verification.receipt.inputDigest,
    receiptInputDigest: verification.receipt.inputDigest,
    reason: verification.reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Planner/executor authority wiring (B6 / B7 minimal production path)
//
// `evaluateAuthorityGate` above is pure gate orchestration. The executor's
// gate.evaluate step consumes a SYNCHRONOUS evaluator, so the async authority
// round-trip (append run/evidence events -> evaluate gate -> verify receipt)
// must be resolved BEFORE executePlannedSteps runs. `resolveAuthorityGateEvaluator`
// is that resolution: for an authority/DONE job it appends executor evidence,
// requests the gate, verifies the native receipt, and returns a synchronous
// evaluator that yields the already-verified outcome. It FAILS CLOSED (returns no
// evaluator) whenever authority mode is off, the server URL is unset, or no server
// verification key is available — so the executor blocks with
// `authority_gate_decision_receipt_required` exactly as it does today. Local /
// non-DONE jobs return immediately with no settings load and no network.
// ─────────────────────────────────────────────────────────────────────────────

/** Run-event + evidence wiring that precedes the gate request. */
export interface AuthorityGateWiringInput {
  gateRequest: GateEvaluateRequestContract;
  gateEnvelope?: Record<string, unknown>;
  verify: AuthorityGateVerifyConfig;
  /** Optional run-events envelope appended before requesting the gate. */
  runEvents?: AuthorityRunEventsEnvelope | AuthorityRunEventsEnvelope[];
  /** Optional evidence envelopes submitted (batch, all-or-nothing) before the gate. */
  evidence?: EvidenceEnvelopeContract[];
}

export interface AuthorityGateWiringResult {
  decision: AuthorityGateDecision;
  /** Transport outcome of the run-events append, when run events were sent. */
  runEventsAck?: AuthorityClientOutcomeKind;
  /** Transport outcome of the evidence batch submission, when evidence was sent. */
  evidenceAck?: AuthorityClientOutcomeKind;
}

function preGateUploadFailureDecision(
  label: 'run_events' | 'evidence',
  outcome: AuthorityClientOutcome<unknown>,
): AuthorityGateDecision {
  const status = outcome.status !== undefined ? ` status=${outcome.status}` : '';
  const message = outcome.message ? `: ${outcome.message}` : '';
  return {
    status: 'blocked',
    decision: 'blocked',
    receiptVerified: false,
    reason: `required_authority_${label}_upload_failed:${outcome.kind}${status}${message}`,
  };
}

/**
 * Append run/evidence events and then run the gate + receipt verify loop.
 *
 * For authority/DONE, these uploads are required gate inputs, not diagnostics:
 * a failed required upload must block before `/v1/gates/evaluate`, otherwise a
 * receipt could certify a run whose live evidence never reached Authority.
 */
export async function runAuthorityGateWiring(
  client: AuthorityClient,
  input: AuthorityGateWiringInput,
): Promise<AuthorityGateWiringResult> {
  let runEventsAck: AuthorityClientOutcomeKind | undefined;
  let evidenceAck: AuthorityClientOutcomeKind | undefined;
  if (input.runEvents) {
    const envelopes = Array.isArray(input.runEvents) ? input.runEvents : [input.runEvents];
    for (const envelope of envelopes) {
      const ack = await client.appendRunEvents(envelope.runId, envelope);
      runEventsAck = ack.kind;
      if (!ack.ok) {
        return { decision: preGateUploadFailureDecision('run_events', ack), runEventsAck, evidenceAck };
      }
    }
  }
  if (input.evidence && input.evidence.length > 0) {
    const ack = await client.submitEvidenceBatch(input.evidence);
    evidenceAck = ack.kind;
    if (!ack.ok) {
      return { decision: preGateUploadFailureDecision('evidence', ack), runEventsAck, evidenceAck };
    }
  }
  const decision = await evaluateAuthorityGate(client, input.gateEnvelope ?? input.gateRequest, input.verify, input.gateRequest.gateInputDigest);
  return { decision, runEventsAck, evidenceAck };
}

/** Project a resolved gate decision onto the executor's synchronous outcome port. */
function gateDecisionToOutcome(decision: AuthorityGateDecision): AuthorityGateOutcome {
  return {
    receiptVerified: decision.receiptVerified,
    decision: decision.decision,
    receiptId: decision.receiptId,
    decisionDigest: decision.decisionDigest,
    gateInputDigest: decision.gateInputDigest,
    receiptInputDigest: decision.receiptInputDigest,
    reason: decision.reason,
  };
}

export interface AuthorityGateEvaluatorOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: AuthorityFetch;
  /** Test seam: fixed clock for event timestamps + receipt freshness. */
  now?: () => Date;
  /** Project root the `.lattice/authority.md` key-file path resolves against. */
  cwd?: string;
  /** Test seam: replace the default authority.md fs reader. */
  fileReader?: AuthorityFileReader;
}

export interface AuthorityGateEvaluatorResolution {
  /**
   * Synchronous evaluator for executePlannedSteps. `undefined` means the executor
   * must fail closed at the authority gate (no server config / unverifiable).
   */
  evaluator?: AuthorityGateEvaluator;
  /** True only when a live authority gate round-trip was performed. */
  configured: boolean;
  /** Mechanical reason for the resolution (fail-closed cause or gate status). */
  reason: string;
  decision?: AuthorityGateDecision;
  runEventsAck?: AuthorityClientOutcomeKind;
  evidenceAck?: AuthorityClientOutcomeKind;
}

function authorityEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const lattice = env[`LATTICE_AUTHORITY_${name}`];
  return typeof lattice === 'string' && lattice.trim() !== '' ? lattice.trim() : undefined;
}

function numericAuthorityEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = authorityEnvValue(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pythonCanonicalTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.000Z$/, 'Z').replace(/\.(\d{3})Z$/, '.$1000Z');
}

function authorityProjectId(
  jobPlan: JobPlan,
  env: Record<string, string | undefined>,
  config?: AuthorityConfig,
): string {
  return jobPlan.jobCreateRequestEnvelope?.projectId
    ?? jobPlan.jobCreateRequest?.projectId
    ?? authorityEnvValue(env, 'PROJECT_ID')
    ?? config?.projectId
    ?? 'local-project';
}

/** Planned-step records the pre-resolved gate will certify before the gate step. */
function preGateStepRecords(jobPlan: JobPlan): PlannedStepExecution[] {
  const records: PlannedStepExecution[] = [];
  for (const step of jobPlan.plannedSteps) {
    if (step.type === 'gate.evaluate') break;
    records.push({
      stepId: step.stepId,
      type: step.type,
      status: 'passed',
      evidenceBinding: step.evidenceBinding,
      evidenceDigest: '',
      startedAt: '',
      endedAt: '',
      attempts: 1,
      summary: {},
    });
  }
  return records;
}

/**
 * Durable evidence refs the live gate is asked to certify. This resolver mirrors
 * `buildGateEvidenceRefResolver` without importing `evidence-uploader` here, which
 * would create an authority-client/evidence-uploader runtime cycle.
 */
function preGateEvidenceRef(jobPlan: JobPlan, step: PlannedStepExecution): string {
  return `${jobPlan.plannerRunId}:${step.stepId}:${evidenceKindForStep(step.type)}`;
}

function preGateEvidenceRefs(jobPlan: JobPlan, records = preGateStepRecords(jobPlan)): string[] {
  return records.map(step => preGateEvidenceRef(jobPlan, step));
}

function evidenceKindForStep(stepType: JobPlan['plannedSteps'][number]['type']): string {
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

interface AuthorityActorMaterial {
  actorId: string;
  role: string;
  privateKey: string;
  privateKeyEncoding: LatticeAuthorityKeyEncoding;
}

function readAuthorityKey(
  env: Record<string, string | undefined>,
  prefix: string,
  options: AuthorityConfigLoadOptions = {},
): string | undefined {
  const inline = authorityEnvValue(env, `${prefix}_KEY`);
  if (inline) return inline;
  const path = authorityEnvValue(env, `${prefix}_KEY_PATH`);
  if (!path) return undefined;
  return readTrimmedSecret(resolvePath(options.cwd ?? process.cwd(), path), options.fileReader ?? defaultAuthorityFileReader);
}

function authorityKeyFromConfig(
  config: AuthorityConfig | undefined,
  options: AuthorityConfigLoadOptions = {},
): string | undefined {
  const material = config?.keyMaterial;
  if (!material) return undefined;
  if (material.actorKey?.trim()) return material.actorKey.trim();
  if (!material.actorKeyPath) return undefined;
  return readTrimmedSecret(resolvePath(options.cwd ?? process.cwd(), material.actorKeyPath), options.fileReader ?? defaultAuthorityFileReader);
}

function resolveAuthorityActorMaterial(
  env: Record<string, string | undefined>,
  prefix: string,
  fallback?: Partial<AuthorityActorMaterial>,
  options: AuthorityConfigLoadOptions = {},
): AuthorityActorMaterial | null {
  const key = readAuthorityKey(env, prefix, options) ?? fallback?.privateKey;
  if (!key) return null;
  const actorId = authorityEnvValue(env, `${prefix}_ID`) ?? fallback?.actorId;
  if (!actorId) return null;
  return {
    actorId,
    role: authorityEnvValue(env, `${prefix}_ROLE`) ?? fallback?.role ?? 'runner',
    privateKey: key,
    privateKeyEncoding: (authorityEnvValue(env, `${prefix}_KEY_ENCODING`) ?? fallback?.privateKeyEncoding ?? 'auto') as LatticeAuthorityKeyEncoding,
  };
}

function resolveRunnerActorMaterial(
  env: Record<string, string | undefined>,
  jobPlan: JobPlan,
  config?: AuthorityConfig,
  options: AuthorityConfigLoadOptions = {},
): AuthorityActorMaterial | null {
  return resolveAuthorityActorMaterial(env, 'ACTOR', {
    actorId: config?.keyMaterial.actorId ?? jobPlan.jobCreateRequestEnvelope?.actorId ?? 'lattice-runner',
    role: config?.keyMaterial.actorRole ?? jobPlan.jobCreateRequestEnvelope?.actorRole ?? 'runner',
    privateKey: authorityKeyFromConfig(config, options),
    privateKeyEncoding: (config?.keyMaterial.actorKeyEncoding as LatticeAuthorityKeyEncoding | undefined) ?? 'auto',
  }, options);
}

function resolveGateActorMaterial(
  env: Record<string, string | undefined>,
  jobPlan: JobPlan,
  config?: AuthorityConfig,
  options: AuthorityConfigLoadOptions = {},
): AuthorityActorMaterial | null {
  const gateKey = readAuthorityKey(env, 'GATE_ACTOR', options);
  if (gateKey) {
    const role = authorityEnvValue(env, 'GATE_ACTOR_ROLE');
    if (!role || !roleCanRequestGate(role)) return null;
    return {
      actorId: authorityEnvValue(env, 'GATE_ACTOR_ID') ?? 'lattice-main',
      role,
      privateKey: gateKey,
      privateKeyEncoding: (authorityEnvValue(env, 'GATE_ACTOR_KEY_ENCODING') ?? 'auto') as LatticeAuthorityKeyEncoding,
    };
  }

  const runner = resolveRunnerActorMaterial(env, jobPlan, config, options);
  if (runner && roleCanRequestGate(runner.role)) return runner;
  return null;
}

function roleCanRequestGate(role: string): boolean {
  return role === 'main' || role === 'human';
}

function signHexEnvelope<T extends object>(
  envelope: T,
  actor: AuthorityActorMaterial,
): T & { signature: string } {
  const privateKeyBase64 = normalizePrivateKeyToBase64(actor.privateKey, actor.privateKeyEncoding);
  const signature = Buffer.from(signCanonical(stripSignature(envelope), privateKeyBase64), 'base64').toString('hex');
  return { ...envelope, signature };
}

function authorityRepoSnapshot(
  env: Record<string, string | undefined>,
  request?: GateEvaluateRequestContract,
): { headHash: string; materialHash: string; dirty: boolean } {
  const repo = request?.repo;
  return {
    headHash: repo?.headHash ?? authorityEnvValue(env, 'HEAD_HASH') ?? 'unknown-head',
    materialHash: repo?.materialHash ?? request?.materialHash ?? authorityEnvValue(env, 'MATERIAL_HASH') ?? 'unknown-material',
    dirty: repo?.dirty ?? authorityEnvValue(env, 'DIRTY') === 'true',
  };
}

function buildGateEvaluateEnvelope(
  request: GateEvaluateRequestContract,
  actor: AuthorityActorMaterial,
  env: Record<string, string | undefined>,
  createdAt: string,
): Record<string, unknown> {
  const targetPhase = request.targetPhase.toLowerCase();
  const envelope = {
    actorId: actor.actorId,
    role: actor.role,
    nonce: `${request.gateInputDigest}:gate-evaluate`,
    timestamp: createdAt,
    decision: {
      decisionId: request.gateInputDigest,
      projectId: request.projectId,
      storyId: request.storyId,
      targetPhase,
      repo: authorityRepoSnapshot(env, request),
      policyMode: 'balanced',
      authorityMode: 'enforce',
      evidenceHashes: request.evidenceRefs ?? [],
      requestedByActorId: actor.actorId,
      requestedAt: createdAt,
    },
  };
  return signHexEnvelope(envelope, actor);
}

function buildRunEventsForJob(
  jobPlan: JobPlan,
  refs: string[],
  env: Record<string, string | undefined>,
  createdAt: string,
  config?: AuthorityConfig,
  options: AuthorityConfigLoadOptions = {},
): AuthorityRunEventsEnvelope[] {
  const actor = resolveRunnerActorMaterial(env, jobPlan, config, options);
  if (!actor) return [];
  const runId = jobPlan.authorityRunId ?? authorityEnvValue(env, 'SESSION_ID') ?? config?.sessionId ?? jobPlan.plannerRunId;
  const events: AuthorityRunEvent[] = refs.map((ref, index) => ({
    type: 'lattice.evidence.ref',
    payload: { eventId: `${jobPlan.jobPlanDigest}:evt-${index + 1}`, evidenceBinding: ref, plannerRunId: jobPlan.plannerRunId },
  }));
  events.push({
    type: 'lattice.execution.summary',
    payload: { eventId: `${jobPlan.jobPlanDigest}:evt-summary`, plannedStepCount: jobPlan.plannedSteps.length, evidenceRefCount: refs.length },
  });
  return events.map((event, index) => signHexEnvelope(buildAuthorityRunEventsEnvelope(
    {
      actorId: actor.actorId,
      role: actor.role,
      nonce: `${jobPlan.jobPlanDigest}:run-events:${index + 1}`,
      timestamp: createdAt,
    },
    runId,
    [event],
  ), actor));
}

function buildJobRunEvidence(
  jobPlan: JobPlan,
  projectId: string,
  refs: string[],
  env: Record<string, string | undefined>,
  createdAt: string,
  actor: AuthorityActorMaterial,
): EvidenceEnvelopeContract {
  const producerRunId = jobPlan.authorityRunId ?? authorityEnvValue(env, 'SESSION_ID') ?? jobPlan.plannerRunId;
  const runnerId = authorityEnvValue(env, 'RUNNER_ID');
  const deviceId = authorityEnvValue(env, 'DEVICE_ID');
  const commandDigest = canonicalDigest({
    kind: 'lattice.planned_steps.run',
    jobPlanDigest: jobPlan.jobPlanDigest,
    plannedSteps: jobPlan.plannedSteps.map(step => ({ stepId: step.stepId, type: step.type })),
  });
  const transcriptHash = canonicalDigest({
    kind: 'lattice.planned_steps.evidence_refs',
    jobPlanDigest: jobPlan.jobPlanDigest,
    evidenceRefs: refs,
  });
  const envelope: EvidenceEnvelopeContract = {
    evidenceId: `${jobPlan.storyId}:${jobPlan.jobPlanDigest}:run`,
    projectId,
    storyId: jobPlan.storyId,
    producerActorId: actor.actorId,
    role: actor.role,
    kind: 'docs_check',
    trustLevel: 1,
    repo: authorityRepoSnapshot(env),
    producerRunId,
    coveredRefs: refs,
    uncoveredRefs: [],
    failedRefs: [],
    claims: [],
    coverage: [],
    negativeControls: [],
    oracleSpecs: [],
    observedAssertions: [],
    artifactDigests: [],
    inspectedArtifacts: [],
    inspectedFiles: [],
    inspectedHunks: [],
    inspectedPackRefs: [],
    commandDigest,
    transcriptHash,
    note: `Lattice runner evidence refs: ${refs.join(', ')}`,
    clientName: 'lattice-cli',
    clientVersion: authorityEnvValue(env, 'CLIENT_VERSION') ?? 'unknown',
    authorityMode: 'enforce',
    commandCatalogDigest: authorityEnvValue(env, 'COMMAND_CATALOG_DIGEST'),
    evidenceSchemaDigest: authorityEnvValue(env, 'EVIDENCE_SCHEMA_DIGEST'),
    ...(runnerId ? { runnerId } : {}),
    ...(deviceId ? { deviceId } : {}),
    reviewedClaimIds: [],
    unresolvedLimitations: [],
    nonce: `${jobPlan.jobPlanDigest}:run-evidence`,
    createdAt,
  };
  return signHexEnvelope(envelope, actor);
}

function secondsFromMs(ms: unknown, fallback: number): number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
    ? Math.max(1, Math.ceil(ms / 1000))
    : fallback;
}

type ServerProviderResolution =
  | { ok: true; provider: 'codex' | 'claude-code' | 'gemini' }
  | { ok: false; reason: string };

function serverProviderFromPlan(jobPlan: JobPlan, override?: string): ServerProviderResolution {
  if (override === 'codex' || override === 'claude-code' || override === 'gemini') return { ok: true, provider: override };
  const primary = jobPlan.providerPolicy?.primaryProvider;
  if (primary === 'codex') return { ok: true, provider: 'codex' };
  if (primary === 'claude') return { ok: true, provider: 'claude-code' };
  return {
    ok: false,
    reason: `authority job create requires an explicit real provider (codex/claude-code/gemini); JobPlan primaryProvider=${primary ?? '<missing>'} is not server-runnable`,
  };
}

function normalizeServerProvider(value: unknown): 'codex' | 'claude-code' | 'gemini' | null {
  if (value === 'codex' || value === 'gemini' || value === 'claude-code') return value;
  if (value === 'claude') return 'claude-code';
  return null;
}

function serverProviderList(value: unknown): Array<'codex' | 'claude-code' | 'gemini'> {
  if (!Array.isArray(value)) return [];
  const providers: Array<'codex' | 'claude-code' | 'gemini'> = [];
  for (const item of value) {
    const provider = normalizeServerProvider(item);
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

function serverProviderPolicyFromPlan(
  jobPlan: JobPlan,
  provider: 'codex' | 'claude-code' | 'gemini',
): Record<string, unknown> {
  const raw = (jobPlan.providerPolicy ?? {}) as Record<string, unknown>;
  const allowedProviders = serverProviderList(raw.allowedProviders);
  if (!allowedProviders.includes(provider)) allowedProviders.unshift(provider);
  const policy: Record<string, unknown> = {
    allowedProviders,
    forbiddenProviders: serverProviderList(raw.forbiddenProviders),
    fallbackProviders: serverProviderList(raw.fallbackProviders),
    requireDistinctVerifierProvider: raw.requireDistinctVerifierProvider === true,
  };
  if (typeof raw.pinnedModel === 'string' && raw.pinnedModel.trim()) {
    policy.pinnedModel = raw.pinnedModel.trim();
  }
  if (typeof raw.pinnedVendor === 'string' && raw.pinnedVendor.trim()) {
    policy.pinnedVendor = raw.pinnedVendor.trim();
  }
  return policy;
}

function serverStepForAuthority(step: JobPlan['plannedSteps'][number]): Record<string, unknown> {
  return {
    ...step,
    evidenceBinding: { ref: step.evidenceBinding },
    ...(step.validationBinding ? { validationBinding: { ref: step.validationBinding } } : {}),
    ...(step.repairBinding ? { repairBinding: { ref: step.repairBinding } } : {}),
  };
}

function jobPolicyFromPlan(jobPlan: JobPlan, provider: 'codex' | 'claude-code' | 'gemini'): {
  stopPolicy: Record<string, unknown>;
  evidencePolicy: Record<string, unknown>;
  receiptPolicy: Record<string, unknown>;
  providerPolicy: Record<string, unknown>;
  worktreePolicy: Record<string, unknown>;
  multiHostPolicy: Record<string, unknown>;
  leaseMetadata: Record<string, unknown>;
} {
  const retry = jobPlan.retryPolicy;
  const stop = jobPlan.stopPolicy;
  const lease = jobPlan.lease;
  const activeMultiHost = jobPlan.multiHostPolicy.requireMultiHost || jobPlan.multiHostPolicy.fullAuthorityDoneRequired;
  const requiredHosts = activeMultiHost
    ? Math.max(2, jobPlan.multiHostPolicy.requiredHostVerdictCount || jobPlan.multiHostPolicy.minIndependentHosts || 2)
    : 0;
  return {
    stopPolicy: {
      stopOnFirstFailure: true,
      maxRuntimeSeconds: secondsFromMs(stop?.maxWallClockMs, 3600),
      maxTotalAttempts: Math.max(1, (stop?.maxSteps ?? jobPlan.plannedSteps.length) * Math.max(1, retry?.maxAttemptsPerStep ?? 1)),
      requireStopSummary: true,
      stopOnEvidenceGap: true,
    },
    evidencePolicy: {
      requireEvidence: true,
      requiredEvidenceKinds: ['docs_check'],
      blockUntilEvidenceUploaded: true,
      requiredTrustLevel: 1,
    },
    receiptPolicy: {
      requireReceipt: jobPlan.mode === 'authority' && jobPlan.until === 'DONE',
      requiredReceiptKinds: ['gate_decision'],
      requireGateReceipt: jobPlan.mode === 'authority' && jobPlan.until === 'DONE',
      targetPhase: jobPlan.until,
    },
    providerPolicy: {
      ...serverProviderPolicyFromPlan(jobPlan, provider),
    },
    worktreePolicy: {
      ...(jobPlan.worktreePolicy ?? {}),
      isolation: 'shared',
      requiresCleanWorktree: false,
      cleanupOnCompletion: false,
      allowDirtyReuse: true,
    },
    multiHostPolicy: {
      requiredIndependentHosts: requiredHosts,
      requiredPassingHosts: requiredHosts,
      requireIndependentHostQuorum: requiredHosts > 0,
      forbidSameHostAsProducer: requiredHosts > 0,
    },
    leaseMetadata: {
      defaultTtlSeconds: secondsFromMs(lease?.leaseTtlMs, 3600),
      maxTtlSeconds: Math.max(secondsFromMs(lease?.leaseTtlMs, 3600), 3600),
      heartbeatIntervalSeconds: secondsFromMs(lease?.renewalThresholdMs, 60),
      labels: {
        plannerRunId: jobPlan.plannerRunId,
        jobPlanDigest: jobPlan.jobPlanDigest,
      },
    },
  };
}

/**
 * Resolve the server verification config: pinned env key first, else the server
 * key discovered from policy. Returns undefined when neither is available so the
 * caller fails closed (no key = no verifiable receipt = no authority DONE).
 */
// ─────────────────────────────────────────────────────────────────────────────
// Authority config I/O shell: read + parse root authority_trust.env and
// .lattice/authority.md, then resolve the full AuthorityConfig (precedence:
// CLI > env > authority_trust.env > authority.md > mode default).
//
// `resolveAuthorityConfig` (authority-mode.ts) is pure; this shell is the only
// place that touches the filesystem. Authority trust files are read ONLY when
// authority mode is enabled (shadow/enforce) — `off` mode performs zero file
// I/O and stays byte-identical to loadAuthoritySettings (preserving
// "off = zero network").
// ─────────────────────────────────────────────────────────────────────────────

/** Injectable file reader: returns file text, or undefined when absent/unreadable. */
export type AuthorityFileReader = (path: string) => string | undefined;

const defaultAuthorityFileReader: AuthorityFileReader = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

export interface AuthorityConfigLoadOptions {
  /** Project root the key-file path is resolved against. Defaults to process.cwd(). */
  cwd?: string;
  /** Test seam: replace the default fs reader. */
  fileReader?: AuthorityFileReader;
}

export interface AuthorityTrustEnvReadResult {
  env?: Record<string, string | undefined>;
  loaded: boolean;
  path: string;
}

/**
 * Read + parse the root `authority_trust.env` profile. The path comes from
 * LATTICE_AUTHORITY_TRUST_ENV_FILE (override) or the default
 * `authority_trust.env`, resolved against `cwd`. Missing / unreadable file is
 * non-fatal.
 */
export function readAuthorityTrustEnvConfig(
  env: Record<string, string | undefined>,
  options: AuthorityConfigLoadOptions = {},
): AuthorityTrustEnvReadResult {
  const cwd = options.cwd ?? process.cwd();
  const rel = authorityEnvValue(env, 'TRUST_ENV_FILE') ?? DEFAULT_AUTHORITY_TRUST_ENV_FILE;
  const path = resolvePath(cwd, rel);
  const reader = options.fileReader ?? defaultAuthorityFileReader;
  const text = reader(path);
  if (typeof text !== 'string') return { loaded: false, path };
  return { env: normalizeAuthorityTrustEnv(parseAuthorityTrustEnv(text, env)), loaded: true, path };
}

/**
 * Read + parse the `.lattice/authority.md` key-management file. The path comes
 * from LATTICE_AUTHORITY_KEY_FILE (override) or the {@link DEFAULT_AUTHORITY_KEY_FILE}
 * default, resolved against `cwd`. Missing / unreadable file -> `loaded:false`.
 */
export function readAuthorityMdConfig(
  env: Record<string, string | undefined>,
  options: AuthorityConfigLoadOptions = {},
): { md?: AuthorityMdConfig; loaded: boolean; path: string } {
  const cwd = options.cwd ?? process.cwd();
  const rel = authorityEnvValue(env, 'KEY_FILE') ?? DEFAULT_AUTHORITY_KEY_FILE;
  const path = resolvePath(cwd, rel);
  const reader = options.fileReader ?? defaultAuthorityFileReader;
  const text = reader(path);
  if (typeof text !== 'string') return { loaded: false, path };
  return { md: parseAuthorityMd(text), loaded: true, path };
}

export type AuthorityCustomerApiKeySource = 'env' | 'path' | 'authority_trust_env' | 'authority_md' | 'none';

export interface AuthorityCustomerApiKeyResolution {
  value?: string;
  source: AuthorityCustomerApiKeySource;
  path?: string;
}

export interface AuthorityCustomerApiKeyLoadOptions extends AuthorityConfigLoadOptions {
  /** Already-parsed authority.md contents; avoids a second read when callers have it. */
  authorityMd?: AuthorityMdConfig;
  /** Already-parsed authority_trust.env contents; avoids a second read. */
  authorityTrustEnv?: Record<string, string | undefined>;
  /** File path for authorityTrustEnv; relative trust-env sidecar paths resolve beside it. */
  authorityTrustEnvPath?: string;
}

function readTrimmedSecret(path: string, reader: AuthorityFileReader): string | undefined {
  const text = reader(path);
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the customer API key used to authorize mutating Authority requests.
 * This function returns the key to the in-process HTTP client only; callers must
 * not print it. Precedence: env inline > env path > authority_trust.env
 * inline > authority_trust.env path > authority.md inline > authority.md
 * path. GET policy discovery remains keyless.
 */
export function resolveAuthorityCustomerApiKey(
  env: Record<string, string | undefined> = process.env,
  options: AuthorityCustomerApiKeyLoadOptions = {},
): AuthorityCustomerApiKeyResolution {
  const inline = authorityEnvValue(env, 'CUSTOMER_API_KEY');
  if (inline) return { value: inline, source: 'env' };

  const cwd = options.cwd ?? process.cwd();
  const reader = options.fileReader ?? defaultAuthorityFileReader;
  const envPath = authorityEnvValue(env, 'CUSTOMER_API_KEY_PATH');
  if (envPath) {
    const path = resolvePath(cwd, envPath);
    const value = readTrimmedSecret(path, reader);
    return value ? { value, source: 'path', path } : { source: 'none', path };
  }

  const trust = options.authorityTrustEnv === undefined
    ? readAuthorityTrustEnvConfig(env, options)
    : undefined;
  const trustEnv = options.authorityTrustEnv ?? trust?.env;
  const trustEnvPath = options.authorityTrustEnvPath ?? trust?.path;
  const trustInline = trustEnv ? authorityEnvValue(trustEnv, 'CUSTOMER_API_KEY') : undefined;
  if (trustInline) return { value: trustInline, source: 'authority_trust_env' };
  const trustPath = trustEnv ? authorityEnvValue(trustEnv, 'CUSTOMER_API_KEY_PATH') : undefined;
  if (trustPath) {
    const trustBaseDir = trustEnvPath ? dirname(resolvePath(cwd, trustEnvPath)) : cwd;
    const path = resolvePath(trustBaseDir, trustPath);
    const value = readTrimmedSecret(path, reader);
    return value ? { value, source: 'authority_trust_env', path } : { source: 'none', path };
  }

  const md = options.authorityMd ?? readAuthorityMdConfig(env, options).md;
  if (md?.customerApiKey?.trim()) {
    return { value: md.customerApiKey.trim(), source: 'authority_md' };
  }
  if (md?.customerApiKeyPath?.trim()) {
    const path = resolvePath(cwd, md.customerApiKeyPath.trim());
    const value = readTrimmedSecret(path, reader);
    return value ? { value, source: 'authority_md', path } : { source: 'none', path };
  }

  return { source: 'none' };
}

export function resolveAuthorityClientAuth(
  env: Record<string, string | undefined> = process.env,
  options: AuthorityCustomerApiKeyLoadOptions = {},
): AuthorityClientAuth {
  const customer = resolveAuthorityCustomerApiKey(env, options);
  return customer.value ? { customerApiKey: customer.value } : {};
}

/**
 * Load the full AuthorityConfig: env/CLI override + authority.md + mode default,
 * with the production-inert verdict stamped. `off` mode short-circuits before any
 * file read so it stays byte-identical to the pure env resolver.
 */
export function loadAuthorityConfig(
  env: Record<string, string | undefined> = process.env,
  override: AuthoritySettingsOverride = {},
  options: AuthorityConfigLoadOptions = {},
): AuthorityConfig {
  const mode = normalizeAuthorityMode(
    override.authorityMode !== undefined ? override.authorityMode : readAuthorityEnv(env, 'MODE'),
  );
  if (!authorityModeEnabled(mode)) {
    // off: no file I/O, no authority.md, no localhost default.
    return resolveAuthorityConfig({ env, override });
  }
  const trust = readAuthorityTrustEnvConfig(env, options);
  const { md, loaded } = readAuthorityMdConfig(env, options);
  return resolveAuthorityConfig({
    env,
    override,
    authorityTrustEnv: trust.env,
    authorityTrustEnvLoaded: trust.loaded,
    authorityMd: md,
    authorityMdLoaded: loaded,
  });
}

export interface AuthorityJobCreateFromPlanOptions extends AuthorityVerdictBackingOptions {
  provider?: 'codex' | 'claude-code' | 'gemini';
  role?: 'planner' | 'implementer' | 'reviewer' | 'explorer' | 'tester';
  promptRef?: string;
  promptHash?: string;
  cwd?: string;
  canWrite?: boolean;
  canRunShell?: boolean;
  mutatesStory?: boolean;
  now?: () => Date;
}

export interface AuthorityJobCreateFromPlanOutcome {
  backing: 'server';
  ok: boolean;
  accepted: boolean;
  transport: AuthorityClientOutcomeKind;
  jobId?: string;
  runId?: string;
  storyId?: string;
  plannedStepsDigest?: string;
  job?: Record<string, unknown>;
  run?: Record<string, unknown>;
  reason?: string;
}

function firstRecordString(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function extractCreatedJobSummary(data: AuthorityJobCreateResult | undefined): {
  jobId?: string;
  runId?: string;
  storyId?: string;
  plannedStepsDigest?: string;
  job?: Record<string, unknown>;
  run?: Record<string, unknown>;
} {
  const job = data?.job;
  const run = data?.run;
  const spec = job && typeof job.spec === 'object' && job.spec !== null && !Array.isArray(job.spec)
    ? job.spec as Record<string, unknown>
    : undefined;
  return {
    jobId: firstRecordString(job, 'jobId', 'job_id') ?? firstRecordString(spec, 'jobId', 'job_id'),
    runId: firstRecordString(job, 'runId', 'run_id') ?? firstRecordString(spec, 'runId', 'run_id') ?? firstRecordString(run, 'runId', 'run_id'),
    storyId: firstRecordString(job, 'storyId', 'story_id') ?? firstRecordString(spec, 'storyId', 'story_id'),
    plannedStepsDigest: firstRecordString(spec, 'plannedStepsDigest', 'planned_steps_digest'),
    job,
    run,
  };
}

export function buildAuthorityJobCreateEnvelopeFromPlan(
  jobPlan: JobPlan,
  options: AuthorityJobCreateFromPlanOptions = {},
): Record<string, unknown> | null {
  const env = options.env ?? process.env;
  const settings = loadAuthorityConfig(
    env,
    { authorityURL: options.authorityURL },
    { cwd: options.cwd, fileReader: options.fileReader },
  );
  const actor = resolveGateActorMaterial(env, jobPlan, settings, { cwd: options.cwd, fileReader: options.fileReader });
  if (!actor) return null;
  const providerResolution = serverProviderFromPlan(jobPlan, options.provider);
  if (!providerResolution.ok) return null;
  const provider = providerResolution.provider;
  const projectId = authorityProjectId(jobPlan, env, settings);
  const nowDate = options.now ? options.now() : new Date();
  const now = pythonCanonicalTimestamp(nowDate);
  const expiresAt = pythonCanonicalTimestamp(new Date(nowDate.getTime() + 24 * 60 * 60 * 1000));
  const runId = authorityEnvValue(env, 'SESSION_ID');
  const plannerIdempotencyKey = jobPlan.jobCreateRequestEnvelope?.idempotencyKey;
  const submissionIdempotencyKey = canonicalDigest({
    projectId,
    storyId: jobPlan.storyId,
    jobPlanDigest: jobPlan.jobPlanDigest,
    plannerIdempotencyKey: plannerIdempotencyKey ?? null,
    runId: runId ?? `created-at:${now}`,
  });
  const policy = jobPolicyFromPlan(jobPlan, provider);
  const request = {
    projectId,
    provider,
    role: options.role ?? 'implementer',
    promptRef: options.promptRef ?? `planner:${jobPlan.plannerRunId}`,
    promptHash: options.promptHash ?? jobPlan.plannerDigest ?? jobPlan.jobPlanDigest,
    storyId: jobPlan.storyId,
    runId,
    cwdPolicy: 'same-worktree',
    cwd: options.cwd,
    permissions: {
      canWrite: options.canWrite === true,
      canRunShell: options.canRunShell !== false,
      canNetwork: false,
      requiresApproval: false,
      allowedCommands: [],
    },
    repo: authorityRepoSnapshot(env),
    mutatesStory: options.mutatesStory === true,
    plannedSteps: jobPlan.plannedSteps.map(serverStepForAuthority),
    ...policy,
    plannerDigests: {
      promptDigest: jobPlan.plannerDigest,
      planDigest: jobPlan.jobPlanDigest,
    },
    expectedArtifacts: [],
    envPolicy: {},
    commandPreview: ['lattice', 'autopilot', 'execute', '--mode=authority', `--storyId=${jobPlan.storyId}`, `--until=${jobPlan.until}`],
    verificationTargets: [],
    idempotencyKey: submissionIdempotencyKey,
    expiresAt,
    metadata: {
      mode: jobPlan.mode,
      until: jobPlan.until,
      storyId: jobPlan.storyId,
      plannerRunId: jobPlan.plannerRunId,
      jobPlanDigest: jobPlan.jobPlanDigest,
      plannerDigest: jobPlan.plannerDigest,
      ...(plannerIdempotencyKey ? { plannerJobCreateIdempotencyKey: plannerIdempotencyKey } : {}),
      developmentWorkflow: jobPlan.developmentWorkflow,
      plannedSteps: jobPlan.plannedSteps,
      coverageMap: jobPlan.coverageMap,
      multiHostPolicy: jobPlan.multiHostPolicy,
      ...(jobPlan.jobCreateRequestEnvelope?.plannedStepsDigest
        ? { latticePlannerPlannedStepsDigest: jobPlan.jobCreateRequestEnvelope.plannedStepsDigest }
        : {}),
    },
  };
  return signHexEnvelope({
    actorId: actor.actorId,
    role: actor.role,
    nonce: `${jobPlan.jobPlanDigest}:job-create:${now}`,
    timestamp: now,
    request,
  }, actor);
}

export async function submitAuthorityJobFromPlan(
  jobPlan: JobPlan,
  options: AuthorityJobCreateFromPlanOptions = {},
): Promise<AuthorityJobCreateFromPlanOutcome> {
  const backing = resolveAuthorityVerdictBacking(options);
  if (backing.mode !== 'server' || !backing.client) {
    return {
      backing: 'server',
      ok: false,
      accepted: false,
      transport: 'error',
      reason: backing.reason,
    };
  }
  const providerResolution = serverProviderFromPlan(jobPlan, options.provider);
  if (!providerResolution.ok) {
    return {
      backing: 'server',
      ok: false,
      accepted: false,
      transport: 'error',
      reason: providerResolution.reason,
    };
  }
  const envelope = buildAuthorityJobCreateEnvelopeFromPlan(jobPlan, options);
  if (!envelope) {
    return {
      backing: 'server',
      ok: false,
      accepted: false,
      transport: 'error',
      reason: 'authority job create requires a main/human actor key',
    };
  }
  const out = await backing.client.createJob(envelope);
  if (!out.ok) {
    return {
      backing: 'server',
      ok: false,
      accepted: false,
      transport: out.kind,
      reason: out.message ?? `job create failed (${out.kind})`,
    };
  }
  const summary = extractCreatedJobSummary(out.data);
  return {
    backing: 'server',
    ok: true,
    accepted: true,
    transport: out.kind,
    ...summary,
  };
}

async function resolveGateVerifyConfig(
  client: AuthorityClient,
  jobPlan: JobPlan,
  env: Record<string, string | undefined>,
  config: AuthorityConfig,
  now?: () => Date,
): Promise<AuthorityGateVerifyConfig | undefined> {
  // Server key material precedence: env > authority.md (both already folded into
  // config's keyMaterial) > policy discovery. Policy metadata remains relevant even
  // when the public key is pinned: `serverKey.algorithm` is part of the production
  // receipt verification contract, but the policy public key must not override a pin.
  let serverPublicKey = config.keyMaterial.serverPublicKey;
  let encoding = config.keyMaterial.serverPublicKeyEncoding as LatticeAuthorityKeyEncoding | undefined;
  let serverKeyId = config.keyMaterial.serverKeyId;
  let serverPublicKeyAlgorithm: string | undefined;
  const policy = await client.discoverPolicy();
  const key = policy.ok ? policy.data?.serverKey : undefined;
  if (key) {
    if (!serverPublicKey && key.publicKeyHex) {
      serverPublicKey = key.publicKeyHex;
      encoding = (key.encoding as LatticeAuthorityKeyEncoding | undefined) ?? 'hex';
    }
    serverKeyId = serverKeyId ?? key.keyId;
    serverPublicKeyAlgorithm = key.algorithm;
  }
  if (!serverPublicKey) return undefined;
  return {
    serverPublicKey,
    serverPublicKeyEncoding: encoding ?? 'auto',
    ...(serverPublicKeyAlgorithm !== undefined ? { serverPublicKeyAlgorithm } : {}),
    expectedProjectId: authorityProjectId(jobPlan, env, config),
    expectedStoryId: jobPlan.storyId,
    expectedServerKeyId: serverKeyId,
    maxAgeMs: numericAuthorityEnv(env, 'RECEIPT_MAX_AGE_MS', 600_000),
    clockSkewMs: numericAuthorityEnv(env, 'RECEIPT_CLOCK_SKEW_MS', 300_000),
    ...(now ? { now: now() } : {}),
  };
}

/**
 * Resolve the synchronous authority gate evaluator that executePlannedSteps will
 * call at its gate.evaluate step. See the section banner above for the fail-closed
 * contract. The returned evaluator never mints a receipt: it merely replays the
 * already-verified gate decision through the executor's synchronous port.
 */
export async function resolveAuthorityGateEvaluator(
  jobPlan: JobPlan,
  options: AuthorityGateEvaluatorOptions = {},
): Promise<AuthorityGateEvaluatorResolution> {
  // Local / non-DONE jobs never consult the authority gate. No settings load, no
  // network — local non-authority mode stays byte-identical to before.
  if (jobPlan.mode !== 'authority' || jobPlan.until !== 'DONE') {
    return { configured: false, reason: 'non_authority_or_non_done_job' };
  }
  const env = options.env ?? process.env;
  const settings = loadAuthorityConfig(env, {}, { cwd: options.cwd, fileReader: options.fileReader });
  if (!authorityModeEnabled(settings.mode)) {
    return { configured: false, reason: 'authority_mode_off_fails_closed' };
  }
  // Production-inert material (localhost auto-default URL or an authority.md
  // local-test profile) must never silently satisfy a production Authority DONE.
  if (settings.productionInert) {
    return {
      configured: false,
      reason: `authority_settings_production_inert_fails_closed:${settings.productionInertReasons.join(',')}`,
    };
  }
  if (!settings.baseURL) {
    return { configured: false, reason: 'authority_url_unconfigured_fails_closed' };
  }
  const auth = resolveAuthorityClientAuth(env, { cwd: options.cwd, fileReader: options.fileReader });
  if (!auth.customerApiKey?.trim()) {
    return { configured: false, reason: 'customer_api_key_unconfigured_fails_closed' };
  }
  const client = new AuthorityClient(
    settings.baseURL,
    options.fetchImpl,
    settings.timeoutMS,
    auth,
  );
  const verify = await resolveGateVerifyConfig(client, jobPlan, env, settings, options.now);
  if (!verify) {
    return { configured: false, reason: 'server_public_key_unavailable_fails_closed' };
  }
  const gateActor = resolveGateActorMaterial(env, jobPlan, settings, { cwd: options.cwd, fileReader: options.fileReader });
  if (!gateActor) {
    return { configured: false, reason: 'authority_gate_actor_key_unconfigured_fails_closed' };
  }
  if (!roleCanRequestGate(gateActor.role)) {
    return { configured: false, reason: `authority_gate_actor_role_not_allowed_fails_closed:${gateActor.role}` };
  }
  const runnerActor = resolveRunnerActorMaterial(env, jobPlan, settings, { cwd: options.cwd, fileReader: options.fileReader });
  if (!runnerActor) {
    return { configured: false, reason: 'authority_runner_actor_key_unconfigured_fails_closed' };
  }
  const projectId = authorityProjectId(jobPlan, env, settings);
  const priorSteps = preGateStepRecords(jobPlan);
  const refs = preGateEvidenceRefs(jobPlan, priorSteps);
  const createdAt = pythonCanonicalTimestamp(options.now ? options.now() : new Date());
  const gateRequest = buildAuthorityGateInput(
    jobPlan,
    priorSteps,
    step => preGateEvidenceRef(jobPlan, step),
    projectId,
  );
  const wiring = await runAuthorityGateWiring(client, {
    gateRequest,
    gateEnvelope: buildGateEvaluateEnvelope(gateRequest, gateActor, env, createdAt),
    verify,
    runEvents: buildRunEventsForJob(jobPlan, refs, env, createdAt, settings, { cwd: options.cwd, fileReader: options.fileReader }),
    evidence: [buildJobRunEvidence(jobPlan, projectId, refs, env, createdAt, runnerActor)],
  });
  return {
    configured: true,
    reason: `authority_gate_${wiring.decision.status}`,
    evaluator: () => gateDecisionToOutcome(wiring.decision),
    decision: wiring.decision,
    runEventsAck: wiring.runEventsAck,
    evidenceAck: wiring.evidenceAck,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner-client gate (B-1123 milestone 2)
//
// The headless runner endpoints must not be reachable when authority mode is
// `off` or LATTICE_AUTHORITY_URL is unset. Off-mode callers must observe zero
// network calls (verification intent CHK-002 adversarial). This guard is the
// single mechanical entry point for "should the runner client even exist?".
// ─────────────────────────────────────────────────────────────────────────────

export interface RunnerClientGateOptions {
  fetchImpl?: AuthorityFetch;
  timeoutMS?: number;
  customerApiKey?: string;
  cwd?: string;
  fileReader?: AuthorityFileReader;
}

export interface RunnerClientGateResult {
  /** The wrapped client, or undefined when the gate refuses (off / missing URL). */
  client?: AuthorityClient;
  /** Settings snapshot used to make the decision. */
  settings: AuthoritySettings;
  /** True iff the gate allows runner traffic. */
  enabled: boolean;
  /** Human-readable reason for refusal (only set when enabled=false). */
  refusedReason?: string;
}

/**
 * Decide whether the runner client should be instantiated for the given
 * settings. Centralizes the "off-mode = zero network calls" guarantee so the
 * smoke harness can prove it without spawning network code.
 *
 * Runtime re-validation (Handler coding convention): we re-check mode and URL here, not
 * only at env load time — a caller passing an arbitrary AuthoritySettings
 * object still cannot bypass the off / missing-URL gate.
 */
export function createRunnerAuthorityClient(
  settings: AuthoritySettings,
  options: RunnerClientGateOptions = {},
): RunnerClientGateResult {
  if (!authorityModeEnabled(settings.mode)) {
    return {
      settings,
      enabled: false,
      refusedReason: `authority mode is "${settings.mode}" (off); runner client refuses to instantiate (zero network calls)`,
    };
  }
  const url = settings.baseURL;
  if (typeof url !== 'string' || url.trim().length === 0) {
    return {
      settings,
      enabled: false,
      refusedReason: 'LATTICE_AUTHORITY_URL is not configured; runner client refuses to instantiate (zero network calls)',
    };
  }
  const customerApiKey = options.customerApiKey?.trim();
  if (!customerApiKey) {
    return {
      settings,
      enabled: false,
      refusedReason: 'LATTICE_AUTHORITY_CUSTOMER_API_KEY or LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH is not configured; runner client refuses mutating Authority traffic (zero network calls)',
    };
  }
  const client = new AuthorityClient(
    url,
    options.fetchImpl,
    typeof options.timeoutMS === 'number' && options.timeoutMS > 0 ? options.timeoutMS : settings.timeoutMS,
    { customerApiKey },
  );
  return { client, settings, enabled: true };
}

/** Convenience: load settings from env + override and apply the runner gate. */
export function loadRunnerAuthorityClient(
  env: Record<string, string | undefined> = process.env,
  override: Parameters<typeof loadAuthoritySettings>[1] = {},
  options: RunnerClientGateOptions = {},
): RunnerClientGateResult {
  const settings = loadAuthorityConfig(env, override, { cwd: options.cwd, fileReader: options.fileReader });
  const key = authorityModeEnabled(settings.mode)
    ? resolveAuthorityCustomerApiKey(env, { cwd: options.cwd, fileReader: options.fileReader }).value
    : undefined;
  return createRunnerAuthorityClient(settings, { ...options, customerApiKey: options.customerApiKey ?? key });
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-host verdict command backing (truth source §X9, M16)
//
// The `authority verdict submit|list` and `authority job status` commands are
// SERVER-backed when authority mode is enforce/shadow AND a URL is configured;
// otherwise they fall back to LOCAL `.koala` verdict storage (preserved verbatim by
// the handler). This is the same gate the runner client uses, so off-mode / no-URL
// callers make zero network calls. The functions below are the server-backed
// orchestration: receipt-before-verdict ordering, transport, and the
// receipt + reconciliation combine for fullAuthorityDone.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthorityVerdictBackingOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: AuthorityFetch;
  /** CLI --authorityURL override (precedence over LATTICE_AUTHORITY_URL). */
  authorityURL?: string;
  timeoutMS?: number;
  cwd?: string;
  fileReader?: AuthorityFileReader;
}

export interface AuthorityVerdictBacking {
  /** `server` when authority config is present; `local` otherwise. */
  mode: 'server' | 'local';
  client?: AuthorityClient;
  settings: AuthorityConfig;
  reason: string;
}

/**
 * Decide whether the verdict commands talk to the Authority server or local storage.
 * Server-backed iff authority mode is enabled (enforce/shadow) AND a URL is set.
 * Protected verdict list/status reads use authenticated GET when the server has a
 * customer key configured; verdict submit still fails closed inside
 * {@link AuthorityClient.post} when no customer key is configured.
 */
export function resolveAuthorityVerdictBacking(
  options: AuthorityVerdictBackingOptions = {},
): AuthorityVerdictBacking {
  const env = options.env ?? process.env;
  const settings = loadAuthorityConfig(
    env,
    { authorityURL: options.authorityURL },
    { cwd: options.cwd, fileReader: options.fileReader },
  );
  if (
    authorityModeEnabled(settings.mode) &&
    typeof settings.baseURL === 'string' &&
    settings.baseURL.trim().length > 0 &&
    !settings.productionInert
  ) {
    const auth = resolveAuthorityClientAuth(env, { cwd: options.cwd, fileReader: options.fileReader });
    const client = new AuthorityClient(
      settings.baseURL,
      options.fetchImpl,
      typeof options.timeoutMS === 'number' && options.timeoutMS > 0 ? options.timeoutMS : settings.timeoutMS,
      auth,
    );
    return {
      mode: 'server',
      client,
      settings,
      reason: 'authority_url_configured_server_backed',
    };
  }
  return {
    mode: 'local',
    settings,
    reason: !authorityModeEnabled(settings.mode)
      ? `authority mode is "${settings.mode}" (off); verdict commands use local storage`
      : settings.productionInert
        ? `authority settings are production-inert (${settings.productionInertReasons.join(',')}); verdict commands use local storage`
        : 'LATTICE_AUTHORITY_URL is not configured; verdict commands use local storage',
  };
}

export interface AuthorityVerdictSubmitOutcome {
  backing: 'server';
  ok: boolean;
  accepted: boolean;
  jobId: string;
  receipt?: AuthorityVerdictReceipt;
  reconciliation?: AuthorityVerdictReconciliation;
  transport: AuthorityClientOutcomeKind;
  reason?: string;
}

export interface AuthorityVerdictSubmitOptions extends AuthorityConfigLoadOptions {
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

function verdictFindingPayload(findings: string[] | undefined): Array<Record<string, unknown>> {
  if (!Array.isArray(findings)) return [];
  return findings
    .map(finding => (typeof finding === 'string' ? finding.trim() : ''))
    .filter(Boolean)
    .map(summary => ({ summary, severity: 'info' }));
}

function buildAuthorityHostVerdictEnvelope(
  jobId: string,
  claim: AuthorityVerdictClaim,
  actor: AuthorityActorMaterial,
  options: AuthorityVerdictSubmitOptions,
): Record<string, unknown> {
  const now = pythonCanonicalTimestamp(options.now ? options.now() : new Date());
  const submission: Record<string, unknown> = {
    jobId,
    runId: claim.runId,
    storyId: claim.storyId || undefined,
    reviewWaveId: claim.reviewWaveId,
    reviewPromptProfile: claim.reviewPromptProfile,
    reviewPromptDigest: claim.reviewPromptDigest,
    role: claim.role,
    provider: claim.provider,
    model: claim.model,
    verdict: claim.decision,
    checkedEvidenceRefs: claim.checkedEvidenceRefs ?? [],
    checkedReceiptId: claim.checkedReceiptId,
    checkedGateInputDigest: claim.checkedGateInputDigest,
    checkedValidationDigest: claim.checkedValidationDigest,
    checkedMaterialHash: claim.checkedMaterialHash,
    checkedCommit: claim.checkedCommit,
    commandsRun: claim.commandsRun ?? [],
    findings: verdictFindingPayload(claim.findings),
    artifactDigest: claim.artifactDigest,
  };
  return signHexEnvelope({
    actorId: actor.actorId,
    role: actor.role,
    nonce: randomUUID(),
    timestamp: now,
    jobId,
    submission,
  }, actor);
}

function isAuthorityVerdictReceipt(value: unknown): value is AuthorityVerdictReceipt {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { verdictId?: unknown }).verdictId === 'string'
    && typeof (value as { hostId?: unknown }).hostId === 'string'
    && typeof (value as { decision?: unknown }).decision === 'string';
}

/**
 * Submit one host verdict to the Authority server, enforcing receipt-before-verdict
 * ordering BEFORE any network call. A claim that does not name the verified
 * gate_decision receipt (and its gate input digest) it inspected is rejected locally
 * with `transport:'error'` and no POST, so a verdict can never be recorded ahead of
 * its receipt (§X9).
 */
export async function submitAuthorityHostVerdict(
  client: AuthorityClient,
  jobId: string,
  claim: AuthorityVerdictClaim,
  options: AuthorityVerdictSubmitOptions = {},
): Promise<AuthorityVerdictSubmitOutcome> {
  const ordering = checkReceiptBeforeVerdict(claim);
  if (!ordering.ok) {
    return { backing: 'server', ok: false, accepted: false, jobId, transport: 'error', reason: ordering.reason };
  }
  if (!claim.reviewWaveId?.trim()) {
    return { backing: 'server', ok: false, accepted: false, jobId, transport: 'error', reason: 'review_wave_id_required_before_verdict' };
  }
  if (!claim.artifactDigest?.trim()) {
    return { backing: 'server', ok: false, accepted: false, jobId, transport: 'error', reason: 'artifact_digest_required_before_verdict' };
  }
  const prompt = checkFinalHostReviewPromptDigest(claim);
  if (!prompt.ok) {
    return { backing: 'server', ok: false, accepted: false, jobId, transport: 'error', reason: prompt.reason };
  }
  const env = options.env ?? process.env;
  const actor = resolveAuthorityActorMaterial(env, 'ACTOR', undefined, { cwd: options.cwd, fileReader: options.fileReader });
  if (!actor) {
    return { backing: 'server', ok: false, accepted: false, jobId, transport: 'error', reason: 'authority_verdict_actor_key_unconfigured_fails_closed' };
  }
  const envelope = buildAuthorityHostVerdictEnvelope(jobId, claim, actor, options);
  const out = await client.submitJobVerdict(jobId, envelope);
  if (!out.ok) {
    return {
      backing: 'server',
      ok: false,
      accepted: false,
      jobId,
      transport: out.kind,
      reason: out.message ?? `verdict submission failed (${out.kind})`,
    };
  }
  const verdictReceipt = out.data?.verdict ?? (isAuthorityVerdictReceipt(out.data?.receipt) ? out.data?.receipt : undefined);
  const accepted = out.data?.accepted === true;
  if (!accepted) {
    return {
      backing: 'server',
      ok: false,
      accepted: false,
      jobId,
      transport: out.kind,
      reason: out.data?.reason ?? 'authority_verdict_not_accepted_by_server',
    };
  }
  return {
    backing: 'server',
    ok: true,
    accepted,
    jobId,
    receipt: verdictReceipt,
    reconciliation: out.data?.reconciliation,
    transport: out.kind,
    reason: out.data?.reason,
  };
}

export interface AuthorityVerdictListOutcome {
  backing: 'server';
  ok: boolean;
  jobId: string;
  verdicts: AuthorityVerdictReceipt[];
  reconciliation?: AuthorityVerdictReconciliation;
  transport: AuthorityClientOutcomeKind;
  reason?: string;
}

/** List the server-stored verdict records + Authority-computed reconciliation. */
export async function listAuthorityHostVerdicts(
  client: AuthorityClient,
  jobId: string,
): Promise<AuthorityVerdictListOutcome> {
  const out = await client.listJobVerdicts(jobId);
  if (!out.ok) {
    return {
      backing: 'server',
      ok: false,
      jobId,
      verdicts: [],
      transport: out.kind,
      reason: out.message ?? `verdict list failed (${out.kind})`,
    };
  }
  return {
    backing: 'server',
    ok: true,
    jobId,
    verdicts: out.data?.verdicts ?? [],
    reconciliation: out.data?.reconciliation,
    transport: out.kind,
    reason: undefined,
  };
}

export interface AuthorityJobVerdictStatusInput {
  jobId: string;
  runId?: string;
  disagreementBehavior?: DisagreementBehavior;
  /**
   * Optional parsed native gate_decision receipt JSON for the run. When supplied it is
   * verified (Ed25519 + bindings) and its receiptId anchors the fresh review wave.
   * Without it `authorityDone`/`fullAuthorityDone` stay false (cannot prove the
   * per-run receipt) — honest fail-closed.
   */
  receipt?: unknown;
  expectedProjectId?: string;
  expectedStoryId?: string;
  expectedServerKeyId?: string;
  expectedDecisionDigest?: string;
  /** Native gate_decision receipt inputDigest expected from the verified Authority receipt. */
  expectedReceiptInputDigest?: string;
  /** Digest that server-backed final host verdicts checked; Python Authority requires this to equal the gate_decision receipt inputDigest. */
  expectedGateInputDigest?: string;
  receiptMaxAgeMs?: number;
  receiptClockSkewMs?: number;
  now?: Date;
}

export interface AuthorityJobVerdictStatus {
  backing: 'server';
  ok: boolean;
  jobId: string;
  runId: string;
  transport: AuthorityClientOutcomeKind;
  certification?: AuthorityCertificationView;
  reason?: string;
}

/**
 * Resolve the server verification material (pinned env key first, else policy
 * discovery). Policy metadata is still consulted for pinned keys so unsupported
 * declared algorithms fail closed without letting policy replace the trust anchor.
 * Returns undefined when neither key source is available so the caller fails closed.
 */
async function resolveServerVerifyMaterial(
  client: AuthorityClient,
  env: Record<string, string | undefined>,
): Promise<{
  serverPublicKey: string;
  encoding: LatticeAuthorityKeyEncoding;
  serverKeyId?: string;
  serverPublicKeyAlgorithm?: string;
} | undefined> {
  let serverPublicKey = authorityEnvValue(env, 'SERVER_PUBLIC_KEY');
  let encoding = authorityEnvValue(env, 'SERVER_PUBLIC_KEY_ENCODING') as LatticeAuthorityKeyEncoding | undefined;
  let serverKeyId = authorityEnvValue(env, 'SERVER_KEY_ID');
  let serverPublicKeyAlgorithm: string | undefined;
  const policy = await client.discoverPolicy();
  const key = policy.ok ? policy.data?.serverKey : undefined;
  if (key) {
    if (!serverPublicKey && key.publicKeyHex) {
      serverPublicKey = key.publicKeyHex;
      encoding = (key.encoding as LatticeAuthorityKeyEncoding | undefined) ?? 'hex';
    }
    serverKeyId = serverKeyId ?? key.keyId;
    serverPublicKeyAlgorithm = key.algorithm;
  }
  if (!serverPublicKey) return undefined;
  return {
    serverPublicKey,
    encoding: encoding ?? 'auto',
    serverKeyId,
    ...(serverPublicKeyAlgorithm !== undefined ? { serverPublicKeyAlgorithm } : {}),
  };
}

function missingReceiptBindings(input: AuthorityJobVerdictStatusInput): string[] {
  const missing: string[] = [];
  if (!input.expectedProjectId?.trim()) missing.push('expectedProjectId');
  if (!input.expectedStoryId?.trim()) missing.push('expectedStoryId');
  if (!input.expectedDecisionDigest?.trim()) missing.push('expectedDecisionDigest');
  if (!input.expectedReceiptInputDigest?.trim()) missing.push('expectedReceiptInputDigest');
  if (!input.expectedGateInputDigest?.trim()) missing.push('expectedGateInputDigest');
  return missing;
}

/**
 * Server-backed `authority job status`: combine the server multi-host reconciliation
 * with the per-run native gate_decision receipt verification into the single release
 * certification view. fullAuthorityDone requires BOTH a verified per-run receipt AND
 * a satisfied independent-host reconciliation; a fresh receipt makes prior verdicts
 * stale (§X9). The CLI never recomputes server independence — it only overlays
 * fail-closed receipt + staleness gates.
 */
export async function authorityJobVerdictStatus(
  client: AuthorityClient,
  input: AuthorityJobVerdictStatusInput,
  env: Record<string, string | undefined> = process.env,
): Promise<AuthorityJobVerdictStatus> {
  const runId = input.runId ?? 'default-run';
  const listed = await client.listJobVerdicts(input.jobId);
  if (!listed.ok) {
    return {
      backing: 'server',
      ok: false,
      jobId: input.jobId,
      runId,
      transport: listed.kind,
      reason: listed.message ?? `verdict list failed (${listed.kind})`,
    };
  }
  const verdicts = listed.data?.verdicts ?? [];
  const verdictsForRun = verdicts.filter(verdict => verdict.runId === runId);

  // Per-run receipt verification (optional). A verified gate_decision receipt is the
  // per-run authorityDone half of fullAuthorityDone.
  let receiptVerified = false;
  let receiptId: string | undefined;
  if (input.receipt !== undefined && input.receipt !== null) {
    const missingBindings = missingReceiptBindings(input);
    const material = missingBindings.length === 0 ? await resolveServerVerifyMaterial(client, env) : undefined;
    if (material) {
      const verification = verifyLatticeAuthorityReceipt(input.receipt, {
        serverPublicKey: material.serverPublicKey,
        serverPublicKeyEncoding: material.encoding,
        serverPublicKeyAlgorithm: material.serverPublicKeyAlgorithm,
        expectedKind: 'gate_decision',
        expectedProjectId: input.expectedProjectId,
        expectedStoryId: input.expectedStoryId,
        expectedServerKeyId: input.expectedServerKeyId ?? material.serverKeyId,
        expectedDecisionDigest: input.expectedDecisionDigest,
        maxAgeMs: input.receiptMaxAgeMs ?? numericAuthorityEnv(env, 'RECEIPT_MAX_AGE_MS', 600_000),
        clockSkewMs: input.receiptClockSkewMs ?? numericAuthorityEnv(env, 'RECEIPT_CLOCK_SKEW_MS', 300_000),
        ...(input.now ? { now: input.now } : {}),
      });
      receiptVerified = verification.verified && verification.receipt.inputDigest === input.expectedReceiptInputDigest;
      receiptId = verification.receipt.receiptId;
    }
  }

  // Fresh review-wave staleness: with a known current receiptId, verdicts that checked
  // a prior receipt are stale (§X9 post-repair fresh wave).
  const partition = receiptId ? partitionFreshWaveVerdicts(verdictsForRun, receiptId, input.expectedGateInputDigest) : undefined;
  const reconciliation = deriveSignedServerReviewWaveReconciliation(listed.data!.reconciliation, partition?.fresh ?? verdictsForRun);
  const certification = reconcileAuthorityCertification({
    reconciliation,
    receiptVerified,
    receiptId,
    disagreementBehavior: input.disagreementBehavior,
    staleVerdictIds: partition?.staleVerdictIds,
  });

  return {
    backing: 'server',
    ok: true,
    jobId: input.jobId,
    runId,
    transport: listed.kind,
    certification,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for endpoints that may return either a signed AuthorityReceipt, an
 * empty acknowledgement object `{}`, or a passthrough object with arbitrary
 * server fields. Using passthrough keeps unknown server fields intact for
 * downstream consumers and audit logs.
 */
const AuthorityReceiptOrEmptySchema: ZodType<AuthorityReceipt | Record<string, unknown>> =
  z.union([AuthorityReceiptSchema, z.record(z.string(), z.unknown())]);

/** Schema for /v1/runners/{runnerId}/jobs/claim — JobSpec or null when none available. */
const JobSpecOrNullSchema: ZodType<JobSpec | null> =
  z.union([JobSpecSchema, z.null()]);

/** Runtime re-validation: non-empty string path parameter (Handler coding convention). */
function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertServerRelativePath(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (!value.startsWith('/') || /^https?:\/\//i.test(value)) {
    throw new Error(`${label} must be a server-relative path starting with /`);
  }
}

// Re-export runner contract schemas as a single barrel for callers that prefer
// importing schemas from authority-client.ts. The authoritative module remains
// authority-runner-contracts.ts.
export {
  ActorKeyRegistrationSchema,
  RunnerRegistrationSchema,
  RunnerHeartbeatSchema,
  JobClaimSchema,
  JobSpecSchema,
  JobLeaseHeartbeatSchema,
  JobReleaseSchema,
  ProviderEventsEnvelopeSchema,
  AuthorityReceiptSchema,
};
