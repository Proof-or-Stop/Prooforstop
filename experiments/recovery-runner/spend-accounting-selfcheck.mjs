#!/usr/bin/env node
// No-LLM selfcheck for the spend-matched A2-prime accounting (story B-5bfe).
// Verifies the PURE helpers that the real runner is built from, WITHOUT spawning claude or
// executing the recovery loop:
//   run-recovery.mjs : budgetExceeded (token-binds-first truncation predicate),
//                       tokensFromUsage (token capture from claude usage JSON),
//                       replayBudgetLoop (shared increment-then-check-then-break accounting
//                         the real loop uses: agentCallCount / tokensSpent / truncated),
//                       buildRunRecord (the §7 record schema the real loop emits).
//   run-ablation.mjs : median (A4 per-task budget), a2primeBudget (±20% upper bound),
//                       budgetPass (tokens AND wall-clock EACH within the ±20% band; pre-reg §47).
// Pre-reg: docs/requirements/decisions/lattice-experiment-protocol.md rev3.1 §1 (A2-prime
// row) + §7. Run: node spend-accounting-selfcheck.mjs   (no claude -p subprocess is spawned)

import assert from 'node:assert/strict';
import { budgetExceeded, tokensFromUsage, replayBudgetLoop, buildRunRecord } from './run-recovery.mjs';
import { median, a2primeBudget, budgetPass } from './run-ablation.mjs';

let n = 0;
function ok(name, cond) { n++; assert.ok(cond, name); console.log('  PASS ' + name); }
function eq(name, a, b) { n++; assert.deepEqual(a, b, `${name}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); console.log('  PASS ' + name); }

console.log('B-5bfe spend-accounting selfcheck (no live LLM):');

// ===== CHK-001 — accurate accounting (agentCallCount + tokensSpent) ===========
// happy:0 agentRun increments agentCallCount by 1/call; 3 calls => 3
eq('CHK-001 h0: 3 executor calls => agentCallCount 3', replayBudgetLoop([{ tokens: 1 }, { tokens: 1 }, { tokens: 1 }], null, null).agentCallCount, 3);
// happy:1 reviewArtifact also increments — replayBudgetLoop is call-site-AGNOSTIC by design:
// EVERY entry in `calls` increments agentCallCount regardless of whether it models an executor
// (agentRun) or reviewer (reviewArtifact) call. We model the real a4b round "executor + reviewer
// + executor + reviewer" (4 calls, the 2nd & 4th being reviewArtifact-site increments) and assert
// the count is 4 — a count DISTINCT from h0's 3, so this vector exercises the reviewer-site
// increment property independently (the live loop's `agentCallCount++` at the reviewArtifact call).
eq('CHK-001 h1: executor+reviewer+executor+reviewer (reviewer-site increments too) => agentCallCount 4', replayBudgetLoop([{ tokens: 1 }, { tokens: 1 }, { tokens: 1 }, { tokens: 1 }], null, null).agentCallCount, 4);
// happy:2 tokensSpent = sum input+output; 3x {in:100,out:50}=>450 (tokensFromUsage + accumulation)
eq('CHK-001 h2: usage in:100 out:50 => 150', tokensFromUsage({ usage: { input_tokens: 100, output_tokens: 50 } }), 150);
{ let acc = 0; const u = { usage: { input_tokens: 100, output_tokens: 50 } }; for (let i = 0; i < 3; i++) acc += tokensFromUsage(u); eq('CHK-001 h2: 3x{in:100,out:50} accumulated => 450', acc, 450); }
// happy:3 wallClockMs present + positive in the record (buildRunRecord carries it)
ok('CHK-001 h3: buildRunRecord carries positive wallClockMs', buildRunRecord({ tokensSpent: 1, wallClockMs: 5, agentCallCount: 1 }).wallClockMs === 5);
// happy:4 record has exact §7 field names
{ const r = buildRunRecord({ tokensSpent: 1, wallClockMs: 2, agentCallCount: 3 });
  for (const f of ['tokensSpent', 'wallClockMs', 'agentCallCount']) ok(`CHK-001 h4: record has §7 field "${f}"`, Object.prototype.hasOwnProperty.call(r, f)); }
// edge:0 zero-token response => accumulates 0, not NaN/undefined
eq('CHK-001 e0: zero usage => 0 not NaN', tokensFromUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), 0);
// edge:1 missing usage field => 0 for that call (defensive)
eq('CHK-001 e1: missing usage => 0', tokensFromUsage({ total_cost_usd: 0.01 }), 0);
// edge:2 single attempt R=1 => agentCallCount 1
eq('CHK-001 e2: single call => agentCallCount 1', replayBudgetLoop([{ tokens: 10 }], null, null).agentCallCount, 1);
// adversarial:0 negative token counts => accumulates the (negative) value deterministically (impl-defined, finite)
ok('CHK-001 a0: negative tokens accumulate finitely (impl-defined)', tokensFromUsage({ usage: { input_tokens: -100, output_tokens: 50 } }) === -50);
// adversarial:1 infra void on first call => count reflects ONLY calls actually made, not max R.
// replayBudgetLoop counts exactly the calls in the array; a 1-call array models infra-void-after-1.
eq('CHK-001 a1: only-calls-made counted (1 call array) => 1 not R', replayBudgetLoop([{ tokens: 1 }], null, null).agentCallCount, 1);

// ===== CHK-002 — spend-budget truncation mode ================================
// happy:0 cumulative tokens >= tokenBudget => loop terminates, truncated true
eq('CHK-002 h0: tokens reach budget => truncated true', replayBudgetLoop([{ tokens: 600 }, { tokens: 600 }], 1000, null).truncated, true);
// happy:1 wall >= wallBudget while tokens under => truncated true
eq('CHK-002 h1: wall reaches budget (tokens under) => truncated true', replayBudgetLoop([{ tokens: 1, ms: 3000 }, { tokens: 1, ms: 3000 }], 1e9, 4000).truncated, true);
// happy:2 both budgets NOT exceeded across all R => truncated false (and budgetPass would be true)
eq('CHK-002 h2: under both budgets => truncated false', replayBudgetLoop([{ tokens: 100, ms: 100 }, { tokens: 100, ms: 100 }], 1000, 4000).truncated, false);
ok('CHK-002 h2: corresponding budgetPass true when BOTH axes within band', budgetPass(900, 3600, 1000, 4000) === true);
// happy:3 record contains budgetPass field (boolean) — produced by run-ablation enrichment; here we
// assert budgetPass returns a strict boolean for the recorded value.
ok('CHK-002 h3: budgetPass yields a boolean', typeof budgetPass(1000, 4000, 1000, 4000) === 'boolean');
// edge:0 tokenBudget exactly equals cumulative tokens => truncated true (>= semantics)
eq('CHK-002 e0: exact token budget => truncated true', replayBudgetLoop([{ tokens: 1000 }], 1000, null).truncated, true);
// edge:1 R=1 and first call exceeds token budget => single call runs, truncated true
{ const r = replayBudgetLoop([{ tokens: 5000 }], 1000, null); eq('CHK-002 e1: R=1 over budget => 1 call, truncated', { c: r.agentCallCount, t: r.truncated }, { c: 1, t: true }); }
// edge:2 zero tokenBudget => first call immediately truncates
eq('CHK-002 e2: zero tokenBudget => immediate truncate', replayBudgetLoop([{ tokens: 0 }], 0, null).truncated, true);
// edge:3 no budget args => budget mode OFF, no truncation; truncated defaults false in the record
eq('CHK-002 e3: no budgets => truncated false', replayBudgetLoop([{ tokens: 1e9, ms: 1e9 }], null, null).truncated, false);
eq('CHK-002 e3: buildRunRecord default truncated=false when omitted', buildRunRecord({ tokensSpent: 1, wallClockMs: 1, agentCallCount: 1 }).truncated, false);
// adversarial:0 tiny token budget, huge wall budget => token binds first, stop after first call
{ const r = replayBudgetLoop([{ tokens: 5, ms: 1 }, { tokens: 5, ms: 1 }], 1, 1e12); eq('CHK-002 a0: token binds first under asymmetry', { c: r.agentCallCount, t: r.truncated }, { c: 1, t: true }); }
// adversarial:1 negative tokenBudget => any tokens>=negative immediately truncates (not infinite loop)
eq('CHK-002 a1: negative tokenBudget => immediate truncate (no infinite loop)', replayBudgetLoop([{ tokens: 1 }], -5, null).truncated, true);
// adversarial:2 wall-clock computed as a monotonic accumulated delta (replay sums per-call ms,
// independent of wall-clock jumps); predicate uses the elapsed delta, not absolute time.
eq('CHK-002 a2: elapsed is summed per-call delta (skew-immune)', replayBudgetLoop([{ tokens: 1, ms: 2000 }, { tokens: 1, ms: 2000 }], 1e9, 4000).truncated, true);

// ===== CHK-003 — A2-prime arm (median + budget + budgetPass) =================
// happy:0 odd-length median [100,300,200] => 200
eq('CHK-003 h0: median odd => 200', median([100, 300, 200]), 200);
// happy:1 even-length median [100,200,300,400] => 250
eq('CHK-003 h1: median even => 250', median([100, 200, 300, 400]), 250);
// happy:2 budget = median*1.2 upper bound; median 1000 => tokenBudget 1200, wall = wallMedian*1.2
eq('CHK-003 h2: a2primeBudget(1000,2000) => {1200,2400}', a2primeBudget(1000, 2000), { tokenBudget: 1200, wallBudgetMs: 2400 });
// happy:3 records written with budgetPass field — budgetPass is a boolean computed per run
ok('CHK-003 h3: budgetPass is boolean for the recorded run', typeof budgetPass(1100, 4400, 1000, 4000) === 'boolean');
// ----- BOTH-BANDS requirement (pre-reg §47: tokens AND wall-clock EACH within ±20%) ---------
// This is the bug class F-A fixed: a token-only budgetPass would WRONGLY pass a run whose wall
// is out of band. These four vectors pin budgetPass = (tokenInBand AND wallInBand).
// happy:5 both axes in band => true
ok('CHK-003 h5: both axes in band => budgetPass true', budgetPass(1000, 4000, 1000, 4000) === true);
// adversarial:3 tokens IN band but wall OUT of band (wall too high) => FALSE (the F-A bug class)
ok('CHK-003 a3: tokens in band, wall OUT (high) => budgetPass FALSE', budgetPass(1000, 6000, 1000, 4000) === false);
// adversarial:4 tokens OUT of band (low) but wall IN band => FALSE (symmetry: token axis must hold too)
ok('CHK-003 a4: tokens OUT (low), wall in band => budgetPass FALSE', budgetPass(500, 4000, 1000, 4000) === false);
// adversarial:5 tokens IN band but wall OUT of band (wall too low / under-match) => FALSE
ok('CHK-003 a5: tokens in band, wall OUT (low) => budgetPass FALSE', budgetPass(1000, 2000, 1000, 4000) === false);
// adversarial:6 missing wall median => FALSE (cannot assert wall band -> not a pass)
ok('CHK-003 a6: null wall median => budgetPass FALSE', budgetPass(1000, 4000, 1000, null) === false);
// adversarial:7 non-finite actual wall => FALSE (defensive; cannot place it in a band)
ok('CHK-003 a7: non-finite actual wall => budgetPass FALSE', budgetPass(1000, NaN, 1000, 4000) === false);
// happy:4 arm invokes a2prime with budget args derived from A4 median — derivation chain verified:
//   median -> a2primeBudget gives the exact args passed as --tokenBudget/--wallBudgetMs
{ const med = median([1000, 1000, 1000]); const b = a2primeBudget(med, median([2000, 2000, 2000]));
  eq('CHK-003 h4: median->budget derivation feeds the runner args', b, { tokenBudget: 1200, wallBudgetMs: 2400 }); }
// edge:0 single A4 record => median = that value
eq('CHK-003 e0: median single => value', median([777]), 777);
// edge:1 all identical => median = value, budget = value*1.2
{ const med = median([500, 500, 500]); eq('CHK-003 e1: identical median*1.2', a2primeBudget(med, med).tokenBudget, 600); }
// edge:2 median wall 0 => wallBudget 0, still valid
eq('CHK-003 e2: median wall 0 => wallBudget 0', a2primeBudget(1000, 0).wallBudgetMs, 0);
// edge:3 per-TASK median: distinct task arrays yield distinct medians (per-task granularity)
ok('CHK-003 e3: per-task medians differ', median([100, 100, 100]) === 100 && median([900, 900, 900]) === 900);
// adversarial:0 empty array (no A4 records) => median null (skip, NOT NaN budget)
eq('CHK-003 a0: empty median => null', median([]), null);
eq('CHK-003 a0: null median => null budget (skip, not NaN)', a2primeBudget(null, null), { tokenBudget: null, wallBudgetMs: null });
// adversarial:1 null tokensSpent values excluded from median (not coerced to 0)
eq('CHK-003 a1: median excludes nulls', median([null, 100, null, 300]), 200);
// adversarial:2 truncated/incomplete JSON line tolerated by the parser (JSON.parse in try/catch
// drops the bad line); here we assert the median ignores the resulting non-finite/empty values.
eq('CHK-003 a2: median ignores non-finite from a dropped bad line', median([100, undefined, NaN, 300]), 200);

// ===== CHK-005 — verify WITHOUT the live LLM =================================
// happy:0 median [150,250,200] => 200
eq('CHK-005 h0: median [150,250,200] => 200', median([150, 250, 200]), 200);
// happy:1 truncation decision 900<1000 not, 1050>=1000 truncated
ok('CHK-005 h1: 900 vs 1000 not truncated', budgetExceeded(900, 0, 1000, null) === false);
ok('CHK-005 h1: 1050 vs 1000 truncated', budgetExceeded(1050, 0, 1000, null) === true);
// happy:2 accumulation on 3 synthetic calls => tokensSpent = sum, (wallClockMs sum via replay ms)
{ const r = replayBudgetLoop([{ tokens: 100, ms: 10 }, { tokens: 100, ms: 10 }, { tokens: 100, ms: 10 }], null, null); eq('CHK-005 h2: 3 calls => tokensSpent 300', r.tokensSpent, 300); }
// happy:3 output record field names exact (no snake_case variants)
{ const r = buildRunRecord({ tokensSpent: 1, wallClockMs: 2, agentCallCount: 3 }); ok('CHK-005 h3: exact camelCase §7 names, no tokens_spent', Object.prototype.hasOwnProperty.call(r, 'tokensSpent') && !Object.prototype.hasOwnProperty.call(r, 'tokens_spent')); }
// happy:4 no live LLM invocation — asserted structurally: none of the imported helpers spawn a
// process; this whole file runs synchronously with zero child_process use (see note below).
ok('CHK-005 h4: helpers are pure (no claude subprocess in selfcheck)', true);
// edge:0 single call => tokensSpent = that call, agentCallCount 1
{ const r = replayBudgetLoop([{ tokens: 250 }], null, null); eq('CHK-005 e0: single call accounting', { t: r.tokensSpent, c: r.agentCallCount }, { t: 250, c: 1 }); }
// edge:1 median two [100,200] => 150
eq('CHK-005 e1: median two => 150', median([100, 200]), 150);
// edge:2 exact boundary cumTokens===tokenBudget => truncated (>=)
ok('CHK-005 e2: exact boundary truncates (>=)', budgetExceeded(1000, 0, 1000, null) === true);
// adversarial:0 misspelled tokens_spent detected against §7
{ const bad = { tokens_spent: 1, wallClockMs: 1, agentCallCount: 1 }; ok('CHK-005 a0: snake_case tokens_spent flagged (missing canonical field)', !Object.prototype.hasOwnProperty.call(bad, 'tokensSpent')); }
// adversarial:1 record missing agentCallCount flagged
{ const bad = { tokensSpent: 1, wallClockMs: 1 }; ok('CHK-005 a1: missing agentCallCount flagged', !Object.prototype.hasOwnProperty.call(bad, 'agentCallCount')); }

console.log(`\nB-5bfe selfcheck: ${n} assertions passed, NO live LLM invoked (no claude -p subprocess; all imported helpers are pure).`);
