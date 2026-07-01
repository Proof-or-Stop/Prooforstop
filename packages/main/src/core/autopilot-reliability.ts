/**
 * @task B-3b99
 * @checklist CHK-001
 * @title Map Autopilot provider health pause and resume events
 * @type refactor
 * @priority high
 * @description
 *   Machine-visible mapping for Autopilot v2 reliability provider-health
 *   transition semantics. Transient provider failures emit health_probe,
 *   provider_unhealthy, and either waiting_for_provider_health while the
 *   process is alive or paused_requires_resume when the process is no longer
 *   alive. Recovery emits health_probe, health_recovered, and resumed from
 *   committed checkpoint state.
 * @changes
 *   - [CHK-001] health_probe and provider_unhealthy classify retryable provider health failures.
 *   - [CHK-001] waiting_for_provider_health maps to in-process wait/re-probe semantics.
 *   - [CHK-001] paused_requires_resume maps to a safe-boundary pause that requires autopilot_resume or autopilot_watch.
 *   - [CHK-001] health_recovered and resumed map to provider recovery followed by checkpoint-safe continuation.
 */
export const AUTOPILOT_RELIABILITY_SCHEMA_VERSION = 'lattice.autopilot_reliability.v1' as const;

export const CURRENT_AUTOPILOT_HOST_BASELINE = ['codex', 'claude-code', 'antigravity'] as const;
export const LEGACY_AUTOPILOT_HOSTS = ['gemini'] as const;

export type CurrentAutopilotHost = typeof CURRENT_AUTOPILOT_HOST_BASELINE[number];
export type LegacyAutopilotHost = typeof LEGACY_AUTOPILOT_HOSTS[number];

export type AutopilotFailureClass =
  | 'transient_provider_overload'
  | 'temporary_rate_limit'
  | 'network_unreachable'
  | 'quota_exhausted'
  | 'auth_required'
  | 'session_expired'
  | 'policy_blocked'
  | 'terminal_step_error';

export type AutopilotRecoveryState =
  | 'waiting_for_provider_health'
  | 'paused_requires_resume'
  | 'blocked_requires_human'
  | 'terminal_step_error';

export type AutopilotHealthEventType =
  | 'health_probe'
  | 'provider_unhealthy'
  | 'waiting_for_provider_health'
  | 'paused_requires_resume'
  | 'health_recovered'
  | 'resumed';

export interface AutopilotFailureClassification {
  schemaVersion: typeof AUTOPILOT_RELIABILITY_SCHEMA_VERSION;
  failureClass: AutopilotFailureClass;
  retryableProviderHealth: boolean;
  requiresHuman: boolean;
  healthCategory?: 'llm_rate_limit' | 'llm_overload' | 'llm_network';
  reason: string;
}

export interface AutopilotHealthEvent {
  at: string;
  type: AutopilotHealthEventType;
  message: string;
  failureClass?: AutopilotFailureClass;
  healthCategory?: AutopilotFailureClassification['healthCategory'];
  retryAfterMs?: number;
}

export interface AutopilotHealthTransition {
  classification: AutopilotFailureClassification;
  nextState: AutopilotRecoveryState;
  retryAfterMs: number;
  events: AutopilotHealthEvent[];
  nextAction: string;
}

export function classifyAutopilotProviderFailure(input: unknown): AutopilotFailureClassification {
  const message = String(input instanceof Error ? input.message : input ?? '').trim();
  const normalized = message.toLowerCase();
  const result = (
    failureClass: AutopilotFailureClass,
    retryableProviderHealth: boolean,
    requiresHuman: boolean,
    reason: string,
    healthCategory?: AutopilotFailureClassification['healthCategory'],
  ): AutopilotFailureClassification => ({
    schemaVersion: AUTOPILOT_RELIABILITY_SCHEMA_VERSION,
    failureClass,
    retryableProviderHealth,
    requiresHuman,
    ...(healthCategory ? { healthCategory } : {}),
    reason,
  });

  if (/\b(auth|unauthorized|forbidden|login required|not logged in|api key|credential|permission denied)\b/.test(normalized)) {
    return result('auth_required', false, true, message || 'provider authentication is required');
  }
  if (/\b(quota|insufficient_quota|billing|credits? exhausted)\b/.test(normalized)) {
    return result('quota_exhausted', false, true, message || 'provider quota is exhausted');
  }
  if (/\b(policy|policy_blocked|blocked by policy|scope violation|not allowed|disallowed|authority receipt)\b/.test(normalized)) {
    return result('policy_blocked', false, true, message || 'policy blocked the provider call');
  }
  if (/\b(session expired|expired session|refresh token|reauth)\b/.test(normalized)) {
    return result('session_expired', false, true, message || 'provider session expired');
  }
  if (/\b(429|rate limit|rate-limit|ratelimit|too many requests|session limit)\b/.test(normalized)) {
    return result('temporary_rate_limit', true, false, message || 'provider rate limit', 'llm_rate_limit');
  }
  if (/\b(503|529|overload|overloaded|temporarily unavailable|service unavailable|server busy|throttl)\b/.test(normalized)) {
    return result('transient_provider_overload', true, false, message || 'provider is overloaded', 'llm_overload');
  }
  if (/\b(econnreset|etimedout|econnrefused|enotfound|network|socket hang up|connection reset|timeout|timed out)\b/.test(normalized)) {
    return result('network_unreachable', true, false, message || 'provider network failure', 'llm_network');
  }
  return result('terminal_step_error', false, false, message || 'terminal step error');
}

export function buildProviderHealthTransition(options: {
  error: unknown;
  nowIso: string;
  processAlive: boolean;
  retryAfterMs?: number;
}): AutopilotHealthTransition {
  const classification = classifyAutopilotProviderFailure(options.error);
  const retryAfterMs = Math.max(1_000, Math.floor(options.retryAfterMs ?? 60_000));
  if (!classification.retryableProviderHealth) {
    const nextState: AutopilotRecoveryState = classification.requiresHuman ? 'blocked_requires_human' : 'terminal_step_error';
    return {
      classification,
      nextState,
      retryAfterMs: 0,
      events: [{
        at: options.nowIso,
        type: 'health_probe',
        message: `provider health probe classified ${classification.failureClass} as non-transient`,
        failureClass: classification.failureClass,
      }],
      nextAction: classification.requiresHuman
        ? 'Human action is required before retrying this autopilot run.'
        : 'Terminal step error: inspect the dispatch evidence before retrying.',
    };
  }

  const nextState: AutopilotRecoveryState = options.processAlive
    ? 'waiting_for_provider_health'
    : 'paused_requires_resume';
  return {
    classification,
    nextState,
    retryAfterMs,
    events: [
      {
        at: options.nowIso,
        type: 'health_probe',
        message: `provider health probe detected ${classification.failureClass}`,
        failureClass: classification.failureClass,
        healthCategory: classification.healthCategory,
        retryAfterMs,
      },
      {
        at: options.nowIso,
        type: 'provider_unhealthy',
        message: classification.reason,
        failureClass: classification.failureClass,
        healthCategory: classification.healthCategory,
        retryAfterMs,
      },
      {
        at: options.nowIso,
        type: nextState,
        message: nextState === 'waiting_for_provider_health'
          ? `waiting ${retryAfterMs}ms for provider health before retry/resume`
          : 'paused at a safe boundary; autopilot_resume or autopilot_watch must relaunch from committed checkpoints',
        failureClass: classification.failureClass,
        healthCategory: classification.healthCategory,
        retryAfterMs,
      },
    ],
    nextAction: nextState === 'waiting_for_provider_health'
      ? `Provider is transiently unhealthy; wait ${retryAfterMs}ms, then re-probe before retrying.`
      : 'Provider is transiently unhealthy and the run is paused at a safe boundary; run autopilot_resume or autopilot_watch after health recovers.',
  };
}

export function buildProviderHealthRecoveredEvents(nowIso: string, message = 'provider health recovered; resume may proceed'): AutopilotHealthEvent[] {
  return [
    { at: nowIso, type: 'health_probe', message: 'provider health probe succeeded' },
    { at: nowIso, type: 'health_recovered', message },
    { at: nowIso, type: 'resumed', message: 'autopilot resumed from committed checkpoint state' },
  ];
}

export type AutopilotThrottleEventType = 'throttle_hold' | 'throttle_raise' | 'throttle_backoff';

export interface AutopilotThrottleState {
  schemaVersion: typeof AUTOPILOT_RELIABILITY_SCHEMA_VERSION;
  maxConcurrentLive: number;
  currentLimit: number;
  inFlight: number;
  interDispatchDelayMs: number;
  stableWindows: number;
  backoffWindows: number;
}

export interface AutopilotThrottleWindow {
  completed: number;
  providerFailures: number;
  terminalFailures?: number;
}

export interface AutopilotThrottleDecision {
  state: AutopilotThrottleState;
  event: {
    type: AutopilotThrottleEventType;
    maxConcurrentLive: number;
    currentLimit: number;
    interDispatchDelayMs: number;
    window: Required<AutopilotThrottleWindow>;
    message: string;
  };
}

export function createAutopilotThrottleState(maxConcurrentLive: number): AutopilotThrottleState {
  const max = clampPositiveInteger(maxConcurrentLive, 1, 64);
  return {
    schemaVersion: AUTOPILOT_RELIABILITY_SCHEMA_VERSION,
    maxConcurrentLive: max,
    currentLimit: Math.min(1, max),
    inFlight: 0,
    interDispatchDelayMs: 0,
    stableWindows: 0,
    backoffWindows: 0,
  };
}

export function canStartLiveDispatch(state: AutopilotThrottleState): boolean {
  return state.inFlight < Math.min(state.currentLimit, state.maxConcurrentLive);
}

export function acquireLiveDispatch(state: AutopilotThrottleState): AutopilotThrottleState {
  if (!canStartLiveDispatch(state)) return state;
  return { ...state, inFlight: state.inFlight + 1 };
}

export function releaseLiveDispatch(state: AutopilotThrottleState): AutopilotThrottleState {
  return { ...state, inFlight: Math.max(0, state.inFlight - 1) };
}

export function recordThrottleWindow(state: AutopilotThrottleState, input: AutopilotThrottleWindow): AutopilotThrottleDecision {
  const window = {
    completed: Math.max(0, Math.floor(input.completed)),
    providerFailures: Math.max(0, Math.floor(input.providerFailures)),
    terminalFailures: Math.max(0, Math.floor(input.terminalFailures ?? 0)),
  };
  if (window.providerFailures > 0) {
    const currentLimit = Math.max(1, Math.floor(state.currentLimit / 2));
    const interDispatchDelayMs = Math.min(300_000, Math.max(1_000, state.interDispatchDelayMs === 0 ? 1_000 : state.interDispatchDelayMs * 2));
    const next = {
      ...state,
      currentLimit,
      interDispatchDelayMs,
      stableWindows: 0,
      backoffWindows: state.backoffWindows + 1,
    };
    return {
      state: next,
      event: {
        type: 'throttle_backoff',
        maxConcurrentLive: next.maxConcurrentLive,
        currentLimit,
        interDispatchDelayMs,
        window,
        message: 'provider health failures observed; reducing live concurrency and increasing inter-dispatch delay',
      },
    };
  }
  if (window.completed > 0 && window.terminalFailures === 0 && state.currentLimit < state.maxConcurrentLive) {
    const currentLimit = Math.min(state.maxConcurrentLive, state.currentLimit + 1);
    const interDispatchDelayMs = state.interDispatchDelayMs === 0 ? 0 : Math.floor(state.interDispatchDelayMs / 2);
    const next = {
      ...state,
      currentLimit,
      interDispatchDelayMs,
      stableWindows: state.stableWindows + 1,
    };
    return {
      state: next,
      event: {
        type: 'throttle_raise',
        maxConcurrentLive: next.maxConcurrentLive,
        currentLimit,
        interDispatchDelayMs,
        window,
        message: 'stable window observed; cautiously raising live concurrency',
      },
    };
  }
  const next = { ...state, stableWindows: window.completed > 0 ? state.stableWindows + 1 : state.stableWindows };
  return {
    state: next,
    event: {
      type: 'throttle_hold',
      maxConcurrentLive: next.maxConcurrentLive,
      currentLimit: next.currentLimit,
      interDispatchDelayMs: next.interDispatchDelayMs,
      window,
      message: 'holding live concurrency',
    },
  };
}

export interface AutopilotStepClaim {
  stepId: string;
  ownerWorkerId: string;
  leaseId: string;
  leaseExpiresAtMs: number;
  fencingToken: number;
  completed: boolean;
}

export interface AutopilotProcessPoolState {
  schemaVersion: typeof AUTOPILOT_RELIABILITY_SCHEMA_VERSION;
  claims: Record<string, AutopilotStepClaim>;
  nextFencingToken: number;
}

export type AutopilotClaimResult =
  | { ok: true; claim: AutopilotStepClaim; reclaimed: boolean; state: AutopilotProcessPoolState }
  | { ok: false; reason: 'already_completed' | 'live_claim_exists'; existing: AutopilotStepClaim; state: AutopilotProcessPoolState };

export type AutopilotCompleteClaimResult =
  | { ok: true; claim: AutopilotStepClaim; state: AutopilotProcessPoolState }
  | { ok: false; reason: 'missing_claim' | 'stale_fencing_token' | 'lease_expired' | 'wrong_owner' | 'already_completed'; state: AutopilotProcessPoolState };

export function createAutopilotProcessPoolState(): AutopilotProcessPoolState {
  return {
    schemaVersion: AUTOPILOT_RELIABILITY_SCHEMA_VERSION,
    claims: {},
    nextFencingToken: 1,
  };
}

export function claimAutopilotStep(
  state: AutopilotProcessPoolState,
  stepId: string,
  ownerWorkerId: string,
  nowMs: number,
  leaseMs: number,
): AutopilotClaimResult {
  const existing = state.claims[stepId];
  if (existing?.completed) {
    return { ok: false, reason: 'already_completed', existing, state };
  }
  if (existing && existing.leaseExpiresAtMs > nowMs) {
    return { ok: false, reason: 'live_claim_exists', existing, state };
  }

  const fencingToken = state.nextFencingToken;
  const claim: AutopilotStepClaim = {
    stepId,
    ownerWorkerId,
    leaseId: `${ownerWorkerId}-${stepId}-${fencingToken}`,
    leaseExpiresAtMs: nowMs + Math.max(1, Math.floor(leaseMs)),
    fencingToken,
    completed: false,
  };
  return {
    ok: true,
    claim,
    reclaimed: Boolean(existing),
    state: {
      ...state,
      nextFencingToken: fencingToken + 1,
      claims: { ...state.claims, [stepId]: claim },
    },
  };
}

export function completeAutopilotStepClaim(
  state: AutopilotProcessPoolState,
  stepId: string,
  ownerWorkerId: string,
  fencingToken: number,
  nowMs: number,
): AutopilotCompleteClaimResult {
  const claim = state.claims[stepId];
  if (!claim) return { ok: false, reason: 'missing_claim', state };
  if (claim.completed) return { ok: false, reason: 'already_completed', state };
  if (claim.ownerWorkerId !== ownerWorkerId) return { ok: false, reason: 'wrong_owner', state };
  if (claim.fencingToken !== fencingToken) return { ok: false, reason: 'stale_fencing_token', state };
  if (claim.leaseExpiresAtMs <= nowMs) return { ok: false, reason: 'lease_expired', state };

  const completed = { ...claim, completed: true };
  return {
    ok: true,
    claim: completed,
    state: {
      ...state,
      claims: { ...state.claims, [stepId]: completed },
    },
  };
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
