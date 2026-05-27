import type { ZodType } from 'zod';
import {
  AuthorityEvidenceBatchSubmissionResultSchema,
  AuthorityEvidenceSubmissionResultSchema,
  AuthorityPolicyContractSchema,
  AUTHORITY_POLICY_OVERCLAIM_KEYS,
  detectPolicyOverclaim,
  type AuthorityEvidenceBatchSubmissionResult,
  type AuthorityEvidenceSubmissionResult,
  type AuthorityPolicyContract,
  type EvidenceEnvelopeContract,
  buildAuthorityEvidenceBatchSubmission,
  buildAuthorityEvidenceSubmission,
} from './authority-contracts.js';
import { DEFAULT_AUTHORITY_TIMEOUT_MS } from './authority-mode.js';

/**
 * HTTP client that POSTs verification evidence envelopes to the cross-repo Python
 * authority server (KOALA_AUTHORITY_URL). The defining responsibility for B-94a6 is
 * to mechanically distinguish every transport / server outcome, so that shadow mode
 * (CHK-003) can degrade ANY failure to a warning while enforce mode (CHK-004) can
 * gate strictly on success.
 *
 * Outcome taxonomy (mutually exclusive, see {@link AuthorityClientOutcome}):
 *  - success           : HTTP 2xx + non-empty body that PASSES the submission-result
 *                        schema (Handler 编码约定: a 2xx whose body fails schema is
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
  ) {}

  /** POST a single evidence envelope to /v1/evidence. */
  async submitEvidence(
    envelope: EvidenceEnvelopeContract,
  ): Promise<AuthorityClientOutcome<AuthorityEvidenceSubmissionResult>> {
    return this.post<AuthorityEvidenceSubmissionResult>(
      '/v1/evidence',
      buildAuthorityEvidenceSubmission(envelope),
      AuthorityEvidenceSubmissionResultSchema,
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
  ): Promise<AuthorityClientOutcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMS);
    let response: AuthorityFetchResponse;
    try {
      response = await this.fetchImpl(joinURL(this.baseURL, path), {
        method: 'GET',
        headers: { Accept: 'application/json' },
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
      return { kind: 'success', ok: true, status: response.status, data: {} as T };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return classifyThrown<T>(error);
    }

    // Overclaim guard (M1): reject if any overclaim key is present at top level.
    const overclaim = detectPolicyOverclaim(parsed);
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
        message: `authority policy response failed schema validation (malformed body): ${result.error.message}`,
        cause: result.error,
      };
    }
    return { kind: 'success', ok: true, status: response.status, data: result.data };
  }

  /**
   * @param schema Submission-result schema used to validate a non-empty 2xx body.
   *   On parse failure the outcome becomes `kind:'error'` (ok:false) — a 2xx with a
   *   malformed body is never reported as success (Handler 编码约定 / evidence
   *   integrity). An empty 2xx body short-circuits to `{}` success (nothing to validate).
   */
  private async post<T>(
    path: string,
    body: unknown,
    schema?: ZodType<T>,
  ): Promise<AuthorityClientOutcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMS);
    let response: AuthorityFetchResponse;
    try {
      response = await this.fetchImpl(joinURL(this.baseURL, path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
}

export function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
