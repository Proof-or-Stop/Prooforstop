#!/usr/bin/env node

// Budget metering acceptance smoke (X6 + §B5 stopPolicy + §B16 budgetUsage, M9/M15).
//
// Proves the budget meter and the executor's fail-closed `budget_exceeded` stop:
//   1. the pure meter tracks token/cost, provider-call, and wall-clock usage and
//      decides per-dimension limits with precedence + an operator next action;
//   2. limit resolution is reduce-only (a CLI override may only TIGHTEN a plan budget);
//   3. the planner emits a `budgetPolicy` on every JobPlan and the consistency gate
//      rejects a malformed budget;
//   4. the executor stops `blocked` with `stopReason=budget_exceeded` BEFORE the gate
//      in local mode, and a generous budget never false-positives.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import {
  BUDGET_EXCEEDED_STOP_REASON,
  budgetLimitsFromPolicy,
  createBudgetMeter,
  resolveBudgetLimits,
} from '../core/budget-meter.js';
import { executePlannedSteps } from '../core/planned-steps-executor.js';
import {
  assertJobPolicyConsistency,
  buildJobPlan,
  buildPlannerDraft,
  type JobPlan,
  type PlannedStep,
  type PlannerStoreLike,
} from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

const root = mkdtempSync(join(tmpdir(), 'lattice-budget-meter-'));

function writeConfig(): void {
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/requirements/decisions/lattice-authority-live-integration.md'), '# Requirements\n');
  resetConfigCache();
}

/** Minimal in-memory store: the executor only reads story phase + appends events. */
function makeStore(phase: string): PlannerStoreLike {
  const events: Array<Record<string, unknown>> = [];
  const story = { storyId: 'B-budget', phase } as unknown as StoryInfo;
  return {
    readStory: () => story,
    storyExists: () => true,
    listStoryIds: () => ['B-budget'],
    appendProcessEvent: (_id, event) => { events.push(event); },
  };
}

/** Auto-advancing clock: every now() call moves the wall-clock forward by stepMs. */
function advancingClock(stepMs: number, baseMs = 1_700_000_000_000): () => Date {
  let calls = 0;
  return () => new Date(baseMs + (calls++) * stepMs);
}

/** Fixed clock: wall-clock never advances, so the wall-clock budget never trips. */
function fixedClock(baseMs = 1_700_000_000_000): () => Date {
  return () => new Date(baseMs);
}

function buildPlan(mode: 'local', storyId: string): JobPlan {
  const draft = buildPlannerDraft(root, {
    request: `Bound a ${mode} run with explicit budget metering and a fail-closed stop`,
    mode,
    until: 'DONE',
    allowUnattendedPlanning: true,
  });
  return buildJobPlan(draft, storyId, 'local-project', {});
}

try {
  writeConfig();

  // === 1. Pure meter — token/cost accrual + known/unknown =====================
  {
    const meter = createBudgetMeter({ maxWallClockMs: 0, maxTokenOrCostBudget: 0, maxProviderCalls: 0 }, fixedClock());
    let usage = meter.usage();
    assert.equal(usage.tokenOrCost, 0, 'fresh meter has zero token/cost');
    assert.equal(usage.tokenOrCostKnown, false, 'token/cost is unknown until a provider event reports it');

    // an unknown-cost provider event still counts the provider call but not token/cost
    meter.recordStep({ type: 'provider.fake', summary: { provider: 'fake' } });
    usage = meter.usage();
    assert.equal(usage.providerCalls, 1, 'a provider.* step counts as a provider call');
    assert.equal(usage.tokenOrCostKnown, false, 'unknown token usage keeps tokenOrCostKnown=false (X6)');

    // a known-cost provider event accrues token/cost and flips known=true
    meter.recordStep({ type: 'provider.codex', summary: { tokensUsed: 1200 } });
    meter.recordStep({ type: 'provider.claude', summary: { costUnits: 800 } });
    usage = meter.usage();
    assert.equal(usage.providerCalls, 3, 'all three provider steps counted');
    assert.equal(usage.tokenOrCost, 2000, 'known tokensUsed + costUnits accumulate (1200 + 800)');
    assert.equal(usage.tokenOrCostKnown, true, 'a reported token/cost number flips tokenOrCostKnown=true');

    // a non-provider step increments steps but not provider calls
    meter.recordStep({ type: 'validate.run', summary: {} });
    usage = meter.usage();
    assert.equal(usage.providerCalls, 3, 'non-provider step must not count as a provider call');
    assert.equal(usage.steps, 4, 'every recorded step increments the step counter');
  }

  // === 2. Pure meter — per-dimension limit decisions + next action ============
  {
    // provider-call budget
    const m1 = createBudgetMeter({ maxWallClockMs: 0, maxTokenOrCostBudget: 0, maxProviderCalls: 2 }, fixedClock());
    m1.recordStep({ type: 'provider.fake' });
    m1.recordStep({ type: 'provider.fake' });
    assert.equal(m1.evaluate().exceeded, false, '2 provider calls is at the 2-call budget, not over it');
    m1.recordStep({ type: 'provider.fake' });
    const r1 = m1.evaluate();
    assert.equal(r1.exceeded, true, '3 provider calls exceeds the 2-call budget');
    assert.equal(r1.exceededDimension, 'provider_calls');
    assert.equal(r1.stopReason, BUDGET_EXCEEDED_STOP_REASON);
    assert.match(r1.nextAction ?? '', /provider calls 3 exceeded the 2-call budget/);
    assert.match(r1.nextAction ?? '', /stops blocked/);
    assert.match(r1.nextAction ?? '', /never triggers provider fallback/);

    // token/cost budget
    const m2 = createBudgetMeter({ maxWallClockMs: 0, maxTokenOrCostBudget: 1000, maxProviderCalls: 0 }, fixedClock());
    m2.recordStep({ type: 'provider.codex', summary: { tokensUsed: 600 } });
    assert.equal(m2.evaluate().exceeded, false, '600 tokens is within the 1000 budget');
    m2.recordStep({ type: 'provider.codex', summary: { tokensUsed: 600 } });
    const r2 = m2.evaluate();
    assert.equal(r2.exceeded, true, '1200 tokens exceeds the 1000 budget');
    assert.equal(r2.exceededDimension, 'token_or_cost');
    assert.match(r2.nextAction ?? '', /token\/cost usage 1200 exceeded the 1000 budget/);

    // wall-clock budget + precedence (time wins over a simultaneously-tripped token bound)
    const clock = advancingClock(5000);
    const m3 = createBudgetMeter({ maxWallClockMs: 1, maxTokenOrCostBudget: 1, maxProviderCalls: 1 }, clock);
    m3.recordStep({ type: 'provider.codex', summary: { tokensUsed: 10 } });
    const r3 = m3.evaluate();
    assert.equal(r3.exceeded, true, 'an advancing clock trips the 1ms wall-clock budget');
    assert.equal(r3.exceededDimension, 'wall_clock', 'wall-clock takes precedence over other tripped dimensions');
    assert(r3.usage.wallClockMs >= 5000, 'wall-clock usage reflects the advanced clock');

    // a zero/disabled limit never trips, even with large usage
    const m4 = createBudgetMeter({ maxWallClockMs: 0, maxTokenOrCostBudget: 0, maxProviderCalls: 0 }, fixedClock());
    for (let i = 0; i < 50; i++) m4.recordStep({ type: 'provider.fake', summary: { tokensUsed: 9999 } });
    assert.equal(m4.evaluate().exceeded, false, 'all-zero limits disable every budget dimension (0 = no limit)');
  }

  // === 3. Limit resolution — reduce-only + policy derivation ==================
  {
    const limits = budgetLimitsFromPolicy(
      { maxWallClockMs: 1000, maxTokenOrCostBudget: 0, maxProviderCalls: 8 },
      { maxWallClockMs: 999 },
    );
    assert.equal(limits.maxWallClockMs, 1000, 'plannerPolicy wall-clock wins over the stopPolicy fallback when present');
    assert.equal(limits.maxTokenOrCostBudget, 0, 'a 0 token budget stays disabled');
    assert.equal(limits.maxProviderCalls, 8);

    const plan = buildPlan('local', 'B-budget-resolve');
    const base = resolveBudgetLimits(plan);
    assert.equal(base.maxWallClockMs, 3600000, 'plan budgetPolicy carries the default 1h wall-clock budget');
    assert.equal(base.maxProviderCalls, 8, 'plan budgetPolicy carries the default 8 provider-call budget');

    // reduce-only: an override may only TIGHTEN
    const tightened = resolveBudgetLimits(plan, { maxWallClockMs: 1000, maxProviderCalls: 100, maxTokenOrCostBudget: 500 });
    assert.equal(tightened.maxWallClockMs, 1000, 'a smaller override wall-clock tightens the budget');
    assert.equal(tightened.maxProviderCalls, 8, 'a larger override must NOT expand the provider-call budget (reduce-only)');
    assert.equal(tightened.maxTokenOrCostBudget, 500, 'an override activates a token budget the plan left disabled');
  }

  // === 4. Planner emits budgetPolicy + consistency gate rejects a bad budget ==
  {
    for (const mode of ['local'] as const) {
      const plan = buildPlan(mode, `B-budget-policy-${mode}`);
      assert(plan.budgetPolicy, `${mode} JobPlan must carry a budgetPolicy block`);
      assert.equal(plan.budgetPolicy!.maxWallClockMs, 3600000, `${mode} budgetPolicy emits the default wall-clock budget`);
      assert.equal(plan.budgetPolicy!.maxProviderCalls, 8, `${mode} budgetPolicy emits the default provider-call budget`);
      assert.equal(plan.budgetPolicy!.maxTokenOrCostBudget, 0, `${mode} budgetPolicy leaves the token/cost budget disabled by default`);
      assert.equal(assertJobPolicyConsistency(plan), plan, `a planner-built ${mode} plan must pass the policy-consistency gate with a budgetPolicy`);
    }
    const clean = buildPlan('local', 'B-budget-neg');
    const mutate = (fn: (p: any) => void): any => { const p = JSON.parse(JSON.stringify(clean)); fn(p); return p; };
    assert.throws(
      () => assertJobPolicyConsistency(mutate(p => { p.budgetPolicy.maxTokenOrCostBudget = -1; })),
      /budgetPolicy.maxTokenOrCostBudget must be a finite number/,
      'a negative token budget must be rejected before execution',
    );
    assert.throws(
      () => assertJobPolicyConsistency(mutate(p => { p.budgetPolicy.maxProviderCalls = Number.NaN; })),
      /budgetPolicy.maxProviderCalls must be a finite number/,
      'a non-finite provider-call budget must be rejected',
    );
  }

  // === 5. Executor — LOCAL mode stops budget_exceeded BEFORE the gate =========
  {
    const plan = buildPlan('local', 'B-budget-local');
    const store = makeStore('DEV');
    const exec = executePlannedSteps({
      root,
      store,
      jobPlan: plan,
      now: advancingClock(5000),
      budget: { maxWallClockMs: 1 },
    });
    assert.equal(exec.status, 'blocked', 'a wall-clock-exhausted local run stops blocked, never done');
    assert.equal(exec.stopReason, BUDGET_EXCEEDED_STOP_REASON, 'the local stop reason is budget_exceeded');
    assert(exec.budgetUsage, 'execution result must surface budgetUsage (§B16)');
    assert.equal(exec.budgetUsage!.exceeded, true);
    assert.equal(exec.budgetUsage!.exceededDimension, 'wall_clock');
    assert.equal(exec.localDone, false, 'budget exhaustion must not claim local DONE');
    assert.equal(exec.receiptVerified, false, 'budget exhaustion must not claim a verified receipt');
    assert.equal(exec.authorityDone, false);
    assert(!exec.steps.some(step => step.type === 'gate.evaluate'), 'execution must stop BEFORE the gate step on budget exhaustion');
    assert(!exec.steps.some(step => step.type === 'stop.summary'), 'no terminal stop.summary runs after a budget stop');
    assert(exec.nextActions.some(a => /Budget exceeded/i.test(a)), 'a budget stop must report a budget next action');
    assert(exec.nextActions.some(a => /never triggers provider fallback/i.test(a)), 'the next action must state budget exhaustion does not trigger fallback');
  }

  // === 6. Executor — local mode is fail-closed on budget exhaustion ===========
  {
    const plan = buildPlan('local', 'B-budget-auth');
    const store = makeStore('DEV');
    const exec = executePlannedSteps({
      root,
      store,
      jobPlan: plan,
      now: advancingClock(5000),
      budget: { maxWallClockMs: 1 },
      // Budget must stop the run before the gate is ever reached, so DONE is unreachable.
    });
    assert.equal(exec.status, 'blocked', 'an exhausted local run stops blocked');
    assert.equal(exec.stopReason, BUDGET_EXCEEDED_STOP_REASON, 'local budget exhaustion uses the budget_exceeded stop');
    assert.equal(exec.authorityDone, false, 'authorityDone remains false on budget exhaustion');
    assert.equal(exec.fullAuthorityDone, false);
    assert.equal(exec.receiptVerified, false, 'no receipt is verified when the run never reaches the gate');
    assert(!exec.steps.some(step => step.type === 'gate.evaluate'), 'local execution must stop before the gate on budget exhaustion');
    assert.equal(exec.budgetUsage!.exceeded, true);
  }

  // === 7. Executor — token/cost budget over a real provider step =============
  {
    const plan = buildPlan('local', 'B-budget-token');
    const fakeStep = plan.plannedSteps.find((s: PlannedStep) => s.type === 'provider.fake');
    assert(fakeStep, 'plan must contain a provider.fake step to drive the token budget');
    // Fixtures-only seam: declare a deterministic token cost the meter will accrue.
    (fakeStep as PlannedStep).args.tokensUsed = 5000;
    const store = makeStore('DEV');
    const exec = executePlannedSteps({
      root,
      store,
      jobPlan: plan,
      now: fixedClock(),                 // fixed clock: wall-clock never trips
      budget: { maxTokenOrCostBudget: 1000 },
    });
    assert.equal(exec.status, 'blocked', 'a token-exhausted run stops blocked');
    assert.equal(exec.stopReason, BUDGET_EXCEEDED_STOP_REASON);
    assert.equal(exec.budgetUsage!.exceededDimension, 'token_or_cost', 'the tripped dimension is token/cost, not wall-clock');
    assert.equal(exec.budgetUsage!.usage.tokenOrCostKnown, true, 'the provider event reported a known token cost');
    assert(exec.budgetUsage!.usage.tokenOrCost >= 5000, 'the meter accrued the declared provider token cost');
    assert(!exec.steps.some(step => step.type === 'gate.evaluate'), 'token exhaustion stops before the gate');
  }

  // === 8. Executor — a generous budget never false-positives =================
  {
    const plan = buildPlan('local', 'B-budget-ok');
    const store = makeStore('DEV');
    const exec = executePlannedSteps({
      root,
      store,
      jobPlan: plan,
      now: fixedClock(),
      // no override: plan defaults (1h wall-clock, 8 provider calls, token disabled)
    });
    assert.notEqual(exec.stopReason, BUDGET_EXCEEDED_STOP_REASON, 'a run within budget must NOT report budget_exceeded');
    assert.equal(exec.budgetUsage!.exceeded, false, 'a within-budget run reports budgetUsage.exceeded=false');
    assert(exec.budgetUsage!.usage.steps > 0, 'budgetUsage records the executed step count');
  }

  console.log('budget-meter-smoke: OK');
} catch (error) {
  console.error('budget-meter-smoke: FAIL');
  console.error(error);
  process.exit(1);
}
