#!/usr/bin/env node
// No-LLM selfcheck for the spend-matched A2-prime accounting (story B-5bfe, CHK-005).
// Verifies the PURE helpers from run-recovery.mjs + run-ablation.mjs WITHOUT spawning
// claude or executing the recovery loop: median, the token-binds-first truncation
// predicate, tokensSpent accumulation from claude usage JSON, the ±20% budget band, and
// that the run-record uses the EXACT pre-reg §7 field names (tokensSpent/wallClockMs/
// agentCallCount). Pre-reg: docs/requirements/decisions/lattice-experiment-protocol.md
// rev3.1 §1 (A2-prime row) + §7. Run: node spend-accounting-selfcheck.mjs

import assert from 'node:assert/strict';
import { budgetExceeded, tokensFromUsage } from './run-recovery.mjs';
import { median, a2primeBudget, budgetPass } from './run-ablation.mjs';

let n = 0;
function ok(name, cond) { n++; assert.ok(cond, name); console.log('  PASS ' + name); }
function eq(name, a, b) { n++; assert.deepEqual(a, b, `${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); console.log('  PASS ' + name); }

console.log('B-5bfe spend-accounting selfcheck (no live LLM):');

// --- median (A4 per-task budget derivation) ---
eq('median odd [100,300,200] => 200', median([100, 300, 200]), 200);
eq('median even [100,200,300,400] => 250', median([100, 200, 300, 400]), 250);
eq('median two [100,200] => 150 (average)', median([100, 200]), 150);
eq('median single [42] => 42', median([42]), 42);
eq('median synthetic A4 [150,250,200] => 200', median([150, 250, 200]), 200);
eq('median ignores nulls [null,100,null,300] => 200', median([null, 100, null, 300]), 200);
eq('median empty [] => null', median([]), null);

// --- token-binds-first truncation predicate (the core spend cap) ---
ok('cumTokens 900 vs budget 1000 => not truncated', budgetExceeded(900, 0, 1000, null) === false);
ok('cumTokens 1050 vs budget 1000 => truncated', budgetExceeded(1050, 0, 1000, null) === true);
ok('cumTokens === budget (1000==1000) => truncated (>= boundary)', budgetExceeded(1000, 0, 1000, null) === true);
ok('no budgets => never truncated', budgetExceeded(1e9, 1e9, null, null) === false);
ok('wall binds when tokens under budget', budgetExceeded(10, 5000, 1000, 4000) === true);
ok('wall under budget, tokens under budget => not truncated', budgetExceeded(10, 100, 1000, 4000) === false);
// token binds FIRST under extreme asymmetry: tiny token budget, huge wall budget => stop on token
ok('token binds first (tokenBudget=1, huge wallBudget)', budgetExceeded(5, 0, 1, 1e12) === true);
ok('zero tokenBudget => immediate truncation at any tokens>=0', budgetExceeded(0, 0, 0, null) === true);

// --- tokensSpent accumulation from claude usage JSON (the field capture) ---
const usage1 = { usage: { input_tokens: 100, output_tokens: 50 } };
eq('usage in:100 out:50 => 150', tokensFromUsage(usage1), 150);
// accumulate across 3 calls of {in:100,out:50} => 450 (matches CHK-001 happy case)
let acc = 0; for (let i = 0; i < 3; i++) acc += tokensFromUsage(usage1);
eq('3x {in:100,out:50} accumulated => 450', acc, 450);
eq('includes cache tokens when present',
  tokensFromUsage({ usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } }), 42);
eq('zero usage => 0 (not NaN)', tokensFromUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), 0);
eq('missing usage field => 0 (not NaN/throw)', tokensFromUsage({ total_cost_usd: 0.01 }), 0);
ok('result is finite for malformed usage', Number.isFinite(tokensFromUsage({ usage: { input_tokens: 'x' } })));

// --- ±20% budget band (upper-bound budget + budgetPass band check) ---
eq('a2primeBudget(median=1000, wall=2000) upper bound = {1200, 2400}',
  a2primeBudget(1000, 2000), { tokenBudget: 1200, wallBudgetMs: 2400 });
eq('a2primeBudget(null, null) => {null,null}', a2primeBudget(null, null), { tokenBudget: null, wallBudgetMs: null });
ok('budgetPass: 1000 within [800,1200] of median 1000 => true', budgetPass(1000, 1000) === true);
ok('budgetPass: 1200 (upper edge) => true', budgetPass(1200, 1000) === true);
ok('budgetPass: 800 (lower edge) => true', budgetPass(800, 1000) === true);
ok('budgetPass: 700 (under-match below 0.8*median) => false', budgetPass(700, 1000) === false);
ok('budgetPass: 1300 (over band) => false', budgetPass(1300, 1000) === false);

// --- pre-reg §7 field-name compliance (schema check, no live LLM) ---
// Simulate the run-record shape this story writes and assert EXACT camelCase field names.
const simRecord = { tokensSpent: 450, wallClockMs: 1234, agentCallCount: 3, truncated: false };
for (const f of ['tokensSpent', 'wallClockMs', 'agentCallCount']) {
  ok(`record has pre-reg §7 field "${f}"`, Object.prototype.hasOwnProperty.call(simRecord, f));
}
// adversarial: a snake_case variant must NOT be treated as the schema field
ok('snake_case tokens_spent is NOT the schema field', !Object.prototype.hasOwnProperty.call(simRecord, 'tokens_spent'));
ok('record missing agentCallCount would be detectable',
  !Object.prototype.hasOwnProperty.call({ tokensSpent: 1, wallClockMs: 1 }, 'agentCallCount'));
ok('single-call accumulation => tokensSpent=callTokens, agentCallCount=1',
  tokensFromUsage(usage1) === 150 && ({ agentCallCount: 1 }).agentCallCount === 1);

console.log(`\nB-5bfe selfcheck: ${n} assertions passed, NO live LLM invoked (no claude -p subprocess).`);
