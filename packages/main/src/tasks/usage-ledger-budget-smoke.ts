#!/usr/bin/env node
/**
 * B-dd44 CHK-004 / CHK-005: smoke suite for the fail-closed hard-budget block
 * (Touchpoint 4) on the Claude dispatch seam.
 *
 * Hard invariants exercised here:
 *   - INV-A: budget UNSET or ledger flag OFF => the guard is a no-op and the
 *     dispatch arg shape is byte-identical (buildClaudeSpawnArgs OFF/ON parity).
 *   - INV-B: a BLOCK fires ONLY when the ledger flag is ON AND a hard budget is
 *     configured AND the preflight estimate strictly EXCEEDS it.
 *   - INV-C: a budget-check error PROCEEDS (never wrongly blocks).
 *   - INV-D: the pure policy/predicate/blocked-record-builder live in
 *     dispatch-usage.ts and produce a validated, well-formed blocked record.
 *
 * Coverage:
 *   - CHK-001 directly: resolveHardBudget valid/unset/invalid/fallback/precedence;
 *     isOverHardBudget true/false/boundary/zero.
 *   - CHK-002 directly: buildBlockedBudgetRecord -> valid, decision.kind=blocked,
 *     budgetPolicyId, reasonCode, supersedes the estimate, not provider-reported,
 *     privacy/authority contract, forbidden-field scan clean, never throws.
 *   - CHK-003/CHK-004: shouldBlockDispatch + recordBudgetBlock across the four
 *     quadrants (OFF / ON+no-budget / ON+budget+over / ON+budget+under) plus the
 *     fail-open-on-error and exact-boundary cases. Asserts the blocked record is
 *     written + the estimate superseded, and is NOT counted as provider-reported
 *     in summarizeRecords.
 *   - CHK-005: usage-ledger imports ZERO other modules (static scan); the budget
 *     exports are imported only by lattice-dispatch + this smoke.
 *
 * Runs entirely in an OS temp dir; never pollutes the repo. Prints per-check
 * lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { buildClaudeSpawnArgs } from '../core/lattice-dispatch.js';
import {
  buildBlockedBudgetRecord,
  HARD_BUDGET_REASON_CODE,
  isOverHardBudget,
  recordBudgetBlock,
  recordDispatchPreflight,
  resolveHardBudget,
  shouldBlockDispatch,
  type DispatchUsageContext,
} from '../core/usage-ledger/dispatch-usage.js';
import { mintCallCorrelation } from '../core/usage-ledger/ids.js';
import {
  scanForbiddenFields,
  validateUsageLedgerRecord,
} from '../core/usage-ledger/record.js';
import { summarizeRecords } from '../core/usage-ledger/summary.js';
import { resolveLedgerPath, verifyLedgerChain } from '../core/usage-ledger/writer.js';

let passed = 0;
const failures: string[] = [];

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

const ON = { LATTICE_USAGE_LEDGER: '1' } as NodeJS.ProcessEnv;
// Ledger is default-ON, so OFF must be the EXPLICIT escape hatch, not an empty
// env (an empty/unset env now reads as ON).
const OFF = { LATTICE_USAGE_LEDGER: '0' } as NodeJS.ProcessEnv;

const root = mkdtempSync(join(tmpdir(), 'usage-ledger-budget-'));

function ctx(over: Partial<DispatchUsageContext> = {}): DispatchUsageContext {
  return {
    storyId: 'S-budget',
    phase: 'dispatch',
    agentType: 'lattice-dispatch:claude-code',
    model: 'claude-code',
    ...over,
  };
}

function opts(env: NodeJS.ProcessEnv) {
  return {
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    command: 'claude --print <prompt-file>',
    host: { kind: 'claude-code' },
    env,
  };
}

/**
 * B-dd44 F-001 regression guard: PRODUCTION-shaped opts with NO explicit `env`
 * key. This is exactly what the dispatch seam builds, so the budget path must
 * fall back to process.env. The original smoke always passed an explicit env and
 * therefore missed that the production path resolved a null budget (silent
 * no-op). Tests using this MUST set/restore process.env themselves.
 */
function prodOpts() {
  return {
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    command: 'claude --print <prompt-file>',
    host: { kind: 'claude-code' },
    // Intentionally NO `env` key -> the seam relies on the process.env default.
  };
}

/**
 * Run `fn` with a temporary patch to process.env, always restoring the prior
 * values (delete keys that were absent). Keeps the production-path checks hermetic
 * even though they deliberately read the real process.env.
 */
function withProcessEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    prior[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

function readLedger(subRoot: string) {
  const path = resolveLedgerPath(subRoot);
  if (!existsSync(path)) return [];
  return verifyLedgerChain(path);
}

let counter = 0;
function freshRoot(): string {
  return join(root, `case-${counter++}`);
}

/** A RecordContext for the blocked-record builder. */
function recordContext(over: Record<string, unknown> = {}) {
  return {
    recordedAt: '2026-06-16T00:00:00.000Z',
    projectRootHash: 'sha256:deadbeef',
    provider: { name: 'anthropic', model: 'claude-code' },
    ...over,
  };
}

/** A RecordAttribution for the blocked-record builder. */
function attribution(over: Record<string, unknown> = {}) {
  return {
    storyId: 'S-budget',
    phase: 'dispatch',
    agentType: 'lattice-dispatch:claude-code',
    subagentId: null,
    threadId: null,
    ...over,
  };
}

async function main(): Promise<void> {
  // ======================================================================
  // CHK-001: resolveHardBudget + isOverHardBudget (pure)
  // ======================================================================
  await check('CHK-001 happy: LATTICE_ valid -> {hardBudgetTokens, budgetPolicyId}', () => {
    const r = resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '5000' });
    assert.ok(r);
    assert.equal(r?.hardBudgetTokens, 5000);
    assert.equal(r?.budgetPolicyId, 'hard-budget:5000');
  });

  await check('CHK-001 happy: isOverHardBudget(6000,5000)===true (strict exceed)', () => {
    assert.equal(isOverHardBudget(6000, 5000), true);
  });

  await check('CHK-001 happy: isOverHardBudget(4000,5000)===false (within budget)', () => {
    assert.equal(isOverHardBudget(4000, 5000), false);
  });

  await check('CHK-001 edge: unset env -> null (no enforcement)', () => {
    assert.equal(resolveHardBudget({}), null);
    assert.equal(resolveHardBudget(undefined), null);
  });

  await check('CHK-001 edge: KOALA_ fallback used when LATTICE_ unset', () => {
    const r = resolveHardBudget({ KOALA_HARD_BUDGET_TOKENS: '3000' });
    assert.ok(r);
    assert.equal(r?.hardBudgetTokens, 3000);
    assert.equal(r?.budgetPolicyId, 'hard-budget:3000');
  });

  await check('CHK-001 edge: LATTICE_ takes precedence over KOALA_', () => {
    const r = resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '7000', KOALA_HARD_BUDGET_TOKENS: '3000' });
    assert.equal(r?.hardBudgetTokens, 7000);
  });

  await check('CHK-001 edge: 0 / negative / non-numeric / float -> null', () => {
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '0' }), null);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '-100' }), null);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: 'abc' }), null);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '3.14' }), null);
  });

  await check('CHK-001 edge: isOverHardBudget(5000,5000)===false (exact boundary)', () => {
    assert.equal(isOverHardBudget(5000, 5000), false);
  });

  await check('CHK-001 edge: minimum valid (1) accepted; whitespace trimmed', () => {
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '1' })?.hardBudgetTokens, 1);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '  5000  ' })?.hardBudgetTokens, 5000);
  });

  await check('CHK-001 adversarial: unsafe int / Infinity / NaN / empty -> null', () => {
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '9007199254740992' }), null);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: 'Infinity' }), null);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: 'NaN' }), null);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '' }), null);
  });

  await check('CHK-001 adversarial: isOverHardBudget(0,5000)===false; never throws', () => {
    assert.equal(isOverHardBudget(0, 5000), false);
    // Non-finite / non-numeric estimates are fail-open (not over budget).
    assert.equal(isOverHardBudget(Number.NaN, 5000), false);
    assert.equal(isOverHardBudget(Infinity, 5000), false);
  });

  // ======================================================================
  // CHK-002: buildBlockedBudgetRecord (pure, validated)
  // ======================================================================
  await check('CHK-002 happy: decision.kind=blocked, policyId, reasonCode, supersedes', () => {
    const corr = mintCallCorrelation();
    const rec = buildBlockedBudgetRecord(
      'claude-opus-4-8',
      { estimatedInputTokens: 2000, estimateRecordId: 'llmuse_estimate-1' },
      corr,
      attribution(),
      recordContext(),
      'hard-budget:1000',
      HARD_BUDGET_REASON_CODE,
    );
    assert.ok(rec, 'expected a blocked record');
    assert.equal(rec?.decision.kind, 'blocked');
    assert.equal(rec?.decision.budgetPolicyId, 'hard-budget:1000');
    assert.equal(rec?.decision.reasonCode, 'hard_budget_exceeded');
    assert.deepEqual(rec?.supersedesRecordIds, ['llmuse_estimate-1']);
    assert.equal(rec?.usage.inputTokens, 2000);
  });

  await check('CHK-002 happy: passes validateUsageLedgerRecord(expectIntegrity:false)', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 5, estimateRecordId: 'llmuse_e' },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:1',
    );
    assert.ok(rec);
    const result = validateUsageLedgerRecord(rec, { expectIntegrity: false });
    assert.equal(result.ok, true, `validation errors:\n${result.errors.join('\n')}`);
  });

  await check('CHK-002 edge: default reasonCode when omitted', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 10, estimateRecordId: 'llmuse_e' },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:5',
    );
    assert.equal(rec?.decision.reasonCode, 'hard_budget_exceeded');
  });

  await check('CHK-002 edge: usage.source is prompt-size-estimate (NOT provider-reported)', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 10, estimateRecordId: 'llmuse_e' },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:5',
    );
    assert.equal(rec?.usage.source, 'prompt-size-estimate');
    assert.notEqual(rec?.usage.source, 'provider-reported');
  });

  await check('CHK-002 edge: privacy + authority contract on a blocked record', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 10, estimateRecordId: 'llmuse_e' },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:5',
    );
    assert.equal(rec?.privacy.promptStored, false);
    assert.equal(rec?.privacy.transcriptStored, false);
    assert.equal(rec?.authority.mode, 'local');
    assert.equal(rec?.authority.receiptId, null);
    assert.equal(rec?.authority.receiptVerified, false);
  });

  await check('CHK-002 adversarial: null estimateRecordId -> supersedesRecordIds=[]', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 99, estimateRecordId: null },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:5',
    );
    assert.ok(rec, 'a null estimate id must still produce a valid record');
    assert.deepEqual(rec?.supersedesRecordIds, []);
  });

  await check('CHK-002 adversarial: forged policyId (newlines/quotes/unicode) still validates', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 99, estimateRecordId: 'llmuse_e' },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:\n"5" \u{1f600}',
    );
    assert.ok(rec);
    assert.equal(validateUsageLedgerRecord(rec, { expectIntegrity: false }).ok, true);
  });

  await check('CHK-002 adversarial: scanForbiddenFields returns zero hits', () => {
    const rec = buildBlockedBudgetRecord(
      'claude-code',
      { estimatedInputTokens: 42, estimateRecordId: 'llmuse_e' },
      mintCallCorrelation(),
      attribution(),
      recordContext(),
      'hard-budget:5',
    );
    assert.deepEqual(scanForbiddenFields(rec), []);
  });

  await check('CHK-002 adversarial: never throws on minimal/edge inputs', () => {
    let threw = false;
    try {
      buildBlockedBudgetRecord(
        null,
        { estimatedInputTokens: Number.NaN, estimateRecordId: null },
        mintCallCorrelation(),
        attribution({ storyId: null }),
        recordContext(),
        '',
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'buildBlockedBudgetRecord must never throw');
  });

  // ======================================================================
  // CHK-003/CHK-004: shouldBlockDispatch + recordBudgetBlock 4-quadrant logic
  // ======================================================================
  await check('CHK-004 QUADRANT A: ledger OFF -> spawn args byte-identical (no --output-format)', () => {
    // OFF builds the literal original args; the budget guard is never reached.
    assert.deepEqual(buildClaudeSpawnArgs('/tmp/prompt.md', false), ['--print', '/tmp/prompt.md']);
    // shouldBlockDispatch with enabled=false never blocks and never reads a budget.
    const d = shouldBlockDispatch(false, { LATTICE_HARD_BUDGET_TOKENS: '1' }, 999999);
    assert.equal(d.block, false);
    assert.equal(d.budget, null);
  });

  await check('CHK-004 A-vs-B spawn-args parity: ON only appends --output-format json', () => {
    assert.deepEqual(buildClaudeSpawnArgs('/tmp/prompt.md', true), [
      '--print',
      '/tmp/prompt.md',
      '--output-format',
      'json',
    ]);
  });

  await check('CHK-004 QUADRANT B: ON + no budget env -> proceeds, budget null, no record', () => {
    const sub = freshRoot();
    const handle = recordDispatchPreflight(sub, ctx(), 'a small prompt', opts(ON));
    assert.ok(handle, 'preflight must succeed');
    const before = readLedger(sub).length;
    const decision = recordBudgetBlock(sub, ctx(), handle, 'a small prompt', opts(ON));
    assert.equal(decision.blocked, false);
    assert.equal(decision.budgetPolicyId, null);
    // No additional record beyond the preflight estimate.
    assert.equal(readLedger(sub).length, before);
  });

  await check('CHK-004 QUADRANT C: ON + budget set + estimate OVER -> blocked record + skip', () => {
    const sub = freshRoot();
    const env = { ...ON, LATTICE_HARD_BUDGET_TOKENS: '1' };
    // A non-empty prompt estimates >= 1 token, so budget=1 is strictly exceeded.
    const prompt = 'this prompt is definitely larger than one token of budget';
    const handle = recordDispatchPreflight(sub, ctx(), prompt, opts(env));
    assert.ok(handle);
    assert.ok(handle!.estimatedInputTokens > 1, 'estimate must exceed the budget of 1');
    const decision = recordBudgetBlock(sub, ctx(), handle, prompt, opts(env));
    assert.equal(decision.blocked, true, 'over-budget must block');
    assert.equal(decision.budgetPolicyId, 'hard-budget:1');
    assert.equal(decision.hardBudgetTokens, 1);

    const records = readLedger(sub);
    const blockedRec = records.find((r) => r.decision.kind === 'blocked');
    assert.ok(blockedRec, 'a blocked record must be appended');
    assert.equal(blockedRec?.decision.budgetPolicyId, 'hard-budget:1');
    assert.deepEqual(blockedRec?.supersedesRecordIds, [handle!.estimateRecordId]);

    // The blocked record is NOT provider-reported in the summary.
    const summary = summarizeRecords(records);
    assert.equal(summary.providerReportedCount, 0, 'a blocked call never reached the provider');
    assert.equal(summary.providerReportedTotal, 0);
    assert.equal(summary.estimateCount, 0, 'the estimate is superseded by the blocked record');
    assert.equal(summary.unknownCount, 1, 'the blocked record buckets as unknown (no provider usage)');
  });

  await check('CHK-004 QUADRANT D: ON + budget set + estimate UNDER -> proceeds, no record', () => {
    const sub = freshRoot();
    const env = { ...ON, LATTICE_HARD_BUDGET_TOKENS: '100000' };
    const prompt = 'tiny prompt';
    const handle = recordDispatchPreflight(sub, ctx(), prompt, opts(env));
    assert.ok(handle);
    assert.ok(handle!.estimatedInputTokens < 100000, 'estimate must be within the budget');
    const before = readLedger(sub).length;
    const decision = recordBudgetBlock(sub, ctx(), handle, prompt, opts(env));
    assert.equal(decision.blocked, false, 'within-budget must NOT block');
    assert.equal(readLedger(sub).length, before, 'no blocked record when within budget');
    assert.equal(readLedger(sub).find((r) => r.decision.kind === 'blocked'), undefined);
  });

  await check('CHK-004 boundary: estimate EXACTLY equals budget -> proceeds (quadrant D)', () => {
    const sub = freshRoot();
    const prompt = 'boundary prompt';
    const handle = recordDispatchPreflight(sub, ctx(), prompt, opts(ON));
    assert.ok(handle);
    const exact = handle!.estimatedInputTokens;
    const env = { ...ON, LATTICE_HARD_BUDGET_TOKENS: String(exact) };
    const decision = recordBudgetBlock(sub, ctx(), handle, prompt, opts(env));
    assert.equal(decision.blocked, false, 'estimate == budget must NOT block (strict-exceed only)');
  });

  await check('CHK-004 fail-open: budget-check error -> proceeds (no block)', () => {
    // shouldBlockDispatch swallows a throwing estimate; a non-finite estimate is
    // fail-open (treated as not over budget) even with a configured budget.
    const d = shouldBlockDispatch(true, { LATTICE_HARD_BUDGET_TOKENS: '1' }, Number.NaN);
    assert.equal(d.block, false, 'a non-finite estimate must not wrongly block');
  });

  await check('CHK-004 ledger OFF: recordBudgetBlock is a strict no-op (never reads env)', () => {
    const sub = freshRoot();
    // Even with a budget env set, the EXPLICIT ledger OFF (=0) means the guard
    // never resolves or blocks. (The ledger is default-ON, so OFF must be set.)
    const env = { LATTICE_USAGE_LEDGER: '0', LATTICE_HARD_BUDGET_TOKENS: '1' } as NodeJS.ProcessEnv;
    const decision = recordBudgetBlock(sub, ctx(), null, 'a prompt over one token', opts(env));
    assert.equal(decision.blocked, false);
    assert.equal(existsSync(resolveLedgerPath(sub)), false, 'OFF must write nothing');
  });

  await check('CHK-004 adversarial: preflight null (write failed) + over budget -> blocks, supersedes []', () => {
    const sub = freshRoot();
    const env = { ...ON, LATTICE_HARD_BUDGET_TOKENS: '1' };
    const prompt = 'a prompt clearly larger than the one-token budget ceiling';
    // Simulate preflight returning null (e.g. corrupt ledger): pass handle=null.
    const decision = recordBudgetBlock(sub, ctx(), null, prompt, opts(env));
    assert.equal(decision.blocked, true, 'budget block must still fire without a preflight estimate');
    const blockedRec = readLedger(sub).find((r) => r.decision.kind === 'blocked');
    assert.ok(blockedRec);
    assert.deepEqual(blockedRec?.supersedesRecordIds, [], 'nothing to supersede without a preflight id');
  });

  await check('CHK-004 statelessness: rapid sequential resolves read live env each time', () => {
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '100' })?.hardBudgetTokens, 100);
    assert.equal(resolveHardBudget({ LATTICE_HARD_BUDGET_TOKENS: '200' })?.hardBudgetTokens, 200);
    assert.equal(resolveHardBudget({}), null);
  });

  await check('CHK-004 hermetic: ambient LATTICE_HARD_BUDGET_TOKENS does not leak into assertions', () => {
    // The smoke passes env explicitly to every guard call, so an ambient value
    // in process.env never influences these results.
    const d = shouldBlockDispatch(true, {}, 999999);
    assert.equal(d.block, false, 'no budget in the passed env -> never blocks regardless of process.env');
  });

  // ======================================================================
  // B-dd44 F-001 PRODUCTION PATH: no explicit env -> falls back to process.env.
  // The original smoke always passed an explicit env, so it MISSED that the
  // production seam (which threads no env into the budget path) resolved a null
  // budget and silently never enforced. These checks lock the production path.
  // ======================================================================
  await check('F-001 unit: resolveHardBudget(undefined) reads process.env (not null)', () => {
    withProcessEnv({ LATTICE_HARD_BUDGET_TOKENS: '1234' }, () => {
      const r = resolveHardBudget(undefined);
      assert.ok(r, 'resolveHardBudget(undefined) must read process.env, not default to {}');
      assert.equal(r?.hardBudgetTokens, 1234);
      assert.equal(r?.budgetPolicyId, 'hard-budget:1234');
    });
    // After restore, the ambient var is gone -> back to null (no enforcement).
    assert.equal(process.env.LATTICE_HARD_BUDGET_TOKENS, undefined, 'env must be restored');
  });

  await check('F-001 unit: resolveHardBudget(undefined) honors KOALA_ fallback via process.env', () => {
    withProcessEnv({ LATTICE_HARD_BUDGET_TOKENS: undefined, KOALA_HARD_BUDGET_TOKENS: '777' }, () => {
      const r = resolveHardBudget(undefined);
      assert.equal(r?.hardBudgetTokens, 777, 'KOALA_ legacy fallback must work on the production (process.env) path');
    });
  });

  await check('F-001 guard: PRODUCTION-shaped opts (no env key) + over budget -> ENFORCES (blocks)', () => {
    const sub = freshRoot();
    const prompt = 'this production prompt is clearly larger than a one-token budget ceiling';
    withProcessEnv({ LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '1' }, () => {
      // Production seam shape: ledger ON + budget via process.env, opts has NO env.
      const handle = recordDispatchPreflight(sub, ctx(), prompt, prodOpts());
      assert.ok(handle, 'preflight must run on the production path (ledger ON via process.env)');
      const decision = recordBudgetBlock(sub, ctx(), handle, prompt, prodOpts());
      // THIS is the bug the finding caught: pre-fix this returned blocked=false.
      assert.equal(decision.blocked, true, 'production path (no explicit env) MUST enforce the budget');
      assert.equal(decision.budgetPolicyId, 'hard-budget:1');
      const blockedRec = readLedger(sub).find((r) => r.decision.kind === 'blocked');
      assert.ok(blockedRec, 'production path must append the blocked record');
    });
  });

  await check('F-001 guard: PRODUCTION-shaped opts + UNDER budget -> proceeds (no false block)', () => {
    const sub = freshRoot();
    const prompt = 'tiny';
    withProcessEnv({ LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: '100000' }, () => {
      const handle = recordDispatchPreflight(sub, ctx(), prompt, prodOpts());
      const decision = recordBudgetBlock(sub, ctx(), handle, prompt, prodOpts());
      assert.equal(decision.blocked, false, 'within-budget production path must proceed');
      assert.equal(readLedger(sub).find((r) => r.decision.kind === 'blocked'), undefined);
    });
  });

  await check('F-001 guard: PRODUCTION-shaped opts + NO budget env -> proceeds (byte-identical)', () => {
    const sub = freshRoot();
    const prompt = 'a prompt with no budget configured at all';
    withProcessEnv({ LATTICE_USAGE_LEDGER: '1', LATTICE_HARD_BUDGET_TOKENS: undefined, KOALA_HARD_BUDGET_TOKENS: undefined }, () => {
      const handle = recordDispatchPreflight(sub, ctx(), prompt, prodOpts());
      const decision = recordBudgetBlock(sub, ctx(), handle, prompt, prodOpts());
      assert.equal(decision.blocked, false, 'no budget env -> guard is a no-op even on the production path');
      assert.equal(decision.budgetPolicyId, null);
      assert.equal(readLedger(sub).find((r) => r.decision.kind === 'blocked'), undefined);
    });
  });

  await check('F-001 guard: PRODUCTION-shaped opts + ledger OFF -> strict no-op (nothing written)', () => {
    const sub = freshRoot();
    const prompt = 'over one token but the ledger is OFF on the production path';
    // Ledger EXPLICITLY OFF (=0; default is now ON) but a budget IS set: must NOT block.
    withProcessEnv({ LATTICE_USAGE_LEDGER: '0', LATTICE_HARD_BUDGET_TOKENS: '1' }, () => {
      const decision = recordBudgetBlock(sub, ctx(), null, prompt, prodOpts());
      assert.equal(decision.blocked, false, 'OFF must be byte-identical even with a budget set');
      assert.equal(existsSync(resolveLedgerPath(sub)), false, 'OFF writes nothing on the production path');
    });
  });

  // ======================================================================
  // CHK-005: static import-boundary invariants
  // ======================================================================
  await check('CHK-005 STATIC core/usage-ledger imports ZERO other modules (incl. budget code)', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const moduleDir = join(repoRoot, 'packages', 'main', 'src', 'core', 'usage-ledger');
    const tsFiles = walkTs(moduleDir);
    assert.ok(tsFiles.length > 0, 'expected usage-ledger .ts files');
    const importRe = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles) {
      const src = readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) {
        const spec = m[1];
        if (spec.startsWith('node:')) continue;
        if (spec.startsWith('.')) {
          const resolved = resolve(dirname(file), spec);
          const rel = relative(moduleDir, resolved);
          const escapes = rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith('..\\');
          if (escapes) offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
          continue;
        }
        offenders.push(`${file.slice(repoRoot.length + 1)} -> ${spec}`);
      }
    }
    assert.deepEqual(offenders, [], `usage-ledger must import only in-module siblings + node:; offenders:\n${offenders.join('\n')}`);
  });

  await check('CHK-005 STATIC budget exports imported ONLY by lattice-dispatch + this smoke', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const srcRoot = join(repoRoot, 'packages', 'main', 'src');
    const tsFiles = walkTs(srcRoot);
    const budgetSymbols = ['resolveHardBudget', 'isOverHardBudget', 'buildBlockedBudgetRecord', 'recordBudgetBlock', 'shouldBlockDispatch'];
    const importers = new Set<string>();
    for (const file of tsFiles) {
      // The defining module + its own smoke usage is expected; we look for OTHER importers.
      if (file.endsWith(join('usage-ledger', 'dispatch-usage.ts'))) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('dispatch-usage')) continue;
      if (budgetSymbols.some((s) => src.includes(s))) {
        importers.add(relative(srcRoot, file));
      }
    }
    const allowed = new Set([
      join('core', 'lattice-dispatch.ts'),
      join('tasks', 'usage-ledger-budget-smoke.ts'),
      // B-1b28: the default-on smoke exercises the budget guard's inert behavior
      // (no block when the ledger is OFF / no budget configured) as part of its
      // escape-hatch + default-on safety coverage.
      join('tasks', 'usage-ledger-default-on-smoke.ts'),
    ]);
    const unexpected = [...importers].filter((f) => !allowed.has(f));
    assert.deepEqual(unexpected, [], `budget exports must not leak to other modules; unexpected importers:\n${unexpected.join('\n')}`);
  });

  await check('CHK-005 STATIC lattice-dispatch imports usage-ledger ONLY via dispatch-usage.js', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const src = readFileSync(join(repoRoot, 'packages', 'main', 'src', 'core', 'lattice-dispatch.ts'), 'utf8');
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    const specs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      if (m[1].includes('usage-ledger/')) specs.push(m[1]);
    }
    assert.deepEqual(specs, ['./usage-ledger/dispatch-usage.js']);
  });

  await check('isolation: all test artifacts live under the temp root (no repo pollution)', () => {
    assert.ok(root.startsWith(tmpdir()), 'temp root must be under the OS tmpdir');
    assert.ok(statSync(root).isDirectory());
  });
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`\n✗ usage-ledger budget smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-ledger budget smoke passed (${passed} checks)`);
  })
  .catch((err) => {
    console.error('✗ usage-ledger budget smoke crashed');
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
  });

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}
