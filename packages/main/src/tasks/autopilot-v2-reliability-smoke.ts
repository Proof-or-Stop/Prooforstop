import assert from 'node:assert/strict';
/**
 * @task B-3b99
 * @checklist CHK-001
 * @title Smoke provider health pause and resume event mapping
 * @type chore
 * @priority high
 * @description
 *   Smoke-backed evidence for Autopilot event tokens health_probe,
 *   provider_unhealthy, waiting_for_provider_health, paused_requires_resume,
 *   health_recovered, and resumed. The assertions below exercise both
 *   process-alive waiting semantics and safe-boundary paused resume semantics.
 * @changes
 *   - [CHK-001] Assert paused transient provider failure emits health_probe, provider_unhealthy, paused_requires_resume.
 *   - [CHK-001] Assert live transient provider failure emits waiting_for_provider_health.
 *   - [CHK-001] Assert recovered provider health emits health_probe, health_recovered, resumed.
 */
import {
  buildProviderHealthRecoveredEvents,
  buildProviderHealthTransition,
  canStartLiveDispatch,
  claimAutopilotStep,
  classifyAutopilotProviderFailure,
  completeAutopilotStepClaim,
  createAutopilotProcessPoolState,
  createAutopilotThrottleState,
  recordThrottleWindow,
} from '../core/autopilot-reliability.js';
import { HOST_RUNTIME_BASELINE } from '../core/lattice-dispatch.js';

function assertM2(): void {
  const rate = classifyAutopilotProviderFailure('HTTP 429 too many requests');
  assert.equal(rate.failureClass, 'temporary_rate_limit');
  assert.equal(rate.retryableProviderHealth, true);
  assert.equal(rate.healthCategory, 'llm_rate_limit');

  const overload = classifyAutopilotProviderFailure('529 overloaded');
  assert.equal(overload.failureClass, 'transient_provider_overload');
  assert.equal(overload.retryableProviderHealth, true);

  const network = classifyAutopilotProviderFailure('ECONNRESET socket hang up');
  assert.equal(network.failureClass, 'network_unreachable');
  assert.equal(network.retryableProviderHealth, true);

  for (const [message, failureClass] of [
    ['quota exhausted for this account', 'quota_exhausted'],
    ['auth required: missing API key', 'auth_required'],
    ['blocked by policy', 'policy_blocked'],
    ['command failed with exit code 2', 'terminal_step_error'],
  ] as const) {
    const classification = classifyAutopilotProviderFailure(message);
    assert.equal(classification.failureClass, failureClass);
    assert.equal(classification.retryableProviderHealth, false);
  }

  const localBudgetBlock = classifyAutopilotProviderFailure(
    'claude-code dispatch blocked by hard budget: provider call skipped before spawn',
  );
  assert.equal(localBudgetBlock.failureClass, 'terminal_step_error');
  assert.equal(localBudgetBlock.retryableProviderHealth, false);
  assert.equal(localBudgetBlock.requiresHuman, false);

  const paused = buildProviderHealthTransition({
    error: 'HTTP 503 service unavailable',
    nowIso: '2026-06-28T00:00:00.000Z',
    processAlive: false,
    retryAfterMs: 5_000,
  });
  assert.equal(paused.nextState, 'paused_requires_resume');
  assert.deepEqual(paused.events.map(event => event.type), [
    'health_probe',
    'provider_unhealthy',
    'paused_requires_resume',
  ]);

  const waiting = buildProviderHealthTransition({
    error: 'HTTP 429 rate limit',
    nowIso: '2026-06-28T00:00:00.000Z',
    processAlive: true,
  });
  assert.equal(waiting.nextState, 'waiting_for_provider_health');
  assert.ok(waiting.events.some(event => event.type === 'waiting_for_provider_health'));

  assert.deepEqual(buildProviderHealthRecoveredEvents('2026-06-28T00:00:01.000Z').map(event => event.type), [
    'health_probe',
    'health_recovered',
    'resumed',
  ]);
}

function assertM3(): void {
  for (const invalidMaxConcurrentLive of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const clamped = createAutopilotThrottleState(invalidMaxConcurrentLive);
    assert.equal(clamped.maxConcurrentLive, 1);
    assert.equal(clamped.currentLimit, 1);
    assert.equal(canStartLiveDispatch(clamped), true);
  }

  let state = createAutopilotThrottleState(3);
  assert.equal(state.maxConcurrentLive, 3);
  assert.equal(state.currentLimit, 1);
  assert.equal(canStartLiveDispatch(state), true);

  let decision = recordThrottleWindow(state, { completed: 2, providerFailures: 0 });
  assert.equal(decision.event.type, 'throttle_raise');
  assert.equal(decision.state.currentLimit, 2);
  state = decision.state;

  decision = recordThrottleWindow(state, { completed: 2, providerFailures: 0 });
  assert.equal(decision.event.type, 'throttle_raise');
  assert.equal(decision.state.currentLimit, 3);
  state = decision.state;

  decision = recordThrottleWindow(state, { completed: 0, providerFailures: 1 });
  assert.equal(decision.event.type, 'throttle_backoff');
  assert.equal(decision.state.currentLimit, 1);
  assert.ok(decision.state.interDispatchDelayMs >= 1_000);
  state = decision.state;

  decision = recordThrottleWindow(state, { completed: 0, providerFailures: 0 });
  assert.equal(decision.event.type, 'throttle_hold');
  assert.equal(decision.state.currentLimit, 1);
}

function assertM4(): void {
  let state = createAutopilotProcessPoolState();
  const first = claimAutopilotStep(state, 'step-1', 'worker-a', 1_000, 100);
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error('unreachable');
  state = first.state;

  const duplicate = claimAutopilotStep(state, 'step-1', 'worker-b', 1_050, 100);
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) throw new Error('unreachable');
  assert.equal(duplicate.reason, 'live_claim_exists');

  const reclaimed = claimAutopilotStep(state, 'step-1', 'worker-b', 1_101, 100);
  assert.equal(reclaimed.ok, true);
  if (!reclaimed.ok) throw new Error('unreachable');
  assert.equal(reclaimed.reclaimed, true);
  state = reclaimed.state;

  const staleComplete = completeAutopilotStepClaim(state, 'step-1', 'worker-a', first.claim.fencingToken, 1_110);
  assert.equal(staleComplete.ok, false);
  assert.equal(staleComplete.reason, 'wrong_owner');

  const staleFence = completeAutopilotStepClaim(state, 'step-1', 'worker-b', first.claim.fencingToken, 1_110);
  assert.equal(staleFence.ok, false);
  assert.equal(staleFence.reason, 'stale_fencing_token');

  const completed = completeAutopilotStepClaim(state, 'step-1', 'worker-b', reclaimed.claim.fencingToken, 1_150);
  assert.equal(completed.ok, true);
  if (!completed.ok) throw new Error('unreachable');
  state = completed.state;

  const afterDone = claimAutopilotStep(state, 'step-1', 'worker-c', 1_160, 100);
  assert.equal(afterDone.ok, false);
  if (afterDone.ok) throw new Error('unreachable');
  assert.equal(afterDone.reason, 'already_completed');
}

function assertHostBaseline(): void {
  assert.deepEqual([...HOST_RUNTIME_BASELINE.current], ['codex', 'claude-code', 'antigravity']);
  assert.deepEqual([...HOST_RUNTIME_BASELINE.legacyDeprecated], ['gemini']);
}

assertM2();
assertM3();
assertM4();
assertHostBaseline();

console.log('autopilot-v2-reliability smoke PASS');
