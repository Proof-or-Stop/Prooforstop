import {
  type AuthorityEvidenceBatchSubmissionResult,
  type AuthorityEvidenceSubmissionResult,
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
 *  - success           : HTTP 2xx + parseable body
 *  - http_error        : HTTP 4xx / 5xx (server reachable, request rejected)
 *  - timeout           : request aborted because it exceeded timeoutMS
 *  - connection_refused: TCP connection refused / DNS failure / network unreachable
 *  - error             : any other thrown failure (e.g. JSON parse error)
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
    );
  }

  /** POST a batch of evidence envelopes to /v1/evidence/batch (all-or-nothing). */
  async submitEvidenceBatch(
    envelopes: EvidenceEnvelopeContract[],
  ): Promise<AuthorityClientOutcome<AuthorityEvidenceBatchSubmissionResult>> {
    return this.post<AuthorityEvidenceBatchSubmissionResult>(
      '/v1/evidence/batch',
      buildAuthorityEvidenceBatchSubmission(envelopes),
    );
  }

  private async post<T>(path: string, body: unknown): Promise<AuthorityClientOutcome<T>> {
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

    try {
      const data = (text ? JSON.parse(text) : {}) as T;
      return { kind: 'success', ok: true, status: response.status, data };
    } catch (error) {
      return classifyThrown<T>(error);
    }
  }
}

export function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
