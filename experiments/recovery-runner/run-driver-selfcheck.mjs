#!/usr/bin/env node
// Offline self-check for run-driver.mjs (no live LLM, no claude -p). Exercises the SAME
// record-assembly path the real campaign uses, with a deterministic injected stub engine.
// Run: node experiments/recovery-runner/run-driver-selfcheck.mjs
//
// Groups asserted: enumeration (§3 applicability + counts), schema (§7 exact field set),
// adjudicate delegation (§4.2 outcomes + unsafe detectors), denominator-sets (§5 contrasts),
// validity-filter (§7 void+re-run vs kept task-failure), seeded-order determinism, and the
// A2prime budget-log (§1 line 47). Ends with a NEGATIVE CONTROL proving validateRecord is
// not vacuous (a deliberately broken record must FAIL).
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ARMS, RECOVERY_SCENARIOS, A1_EXCLUDED_SCENARIOS, CONTRASTS,
  SEVEN_RECORD_FIELDS, A2PRIME_BUDGET_FIELDS, ADJUDICATED_OUTCOMES, UNSAFE_KEYS,
  scenarioAppliesToArm, denominatorSetsFor, enumerateCells, seededShuffle,
  buildCanonicalRecord, validateRecord, isInfraVoid, runDriver,
} from './run-driver.mjs';

let passed = 0, failed = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; fails.push(label); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function group(name) { process.stdout.write(`\n## ${name}\n`); }

// --- a real (hash-checked) acceptance script so harnessAcceptance can pass offline -------
const TMP = mkdtempSync(join(tmpdir(), 'run-driver-selfcheck-'));
const ACC_PATH = join(TMP, 'acceptance.mjs');
writeFileSync(ACC_PATH, 'console.log("ACCEPT PASS");\n');
const ACC_HASH = createHash('sha256').update(readFileSync(ACC_PATH)).digest('hex');

// Build a raw engine result. By default a clean "recovered" shape; `extra` overrides.
function engineResult(extra = {}) {
  return {
    acceptanceScriptPath: ACC_PATH,
    expectedHash: ACC_HASH,
    runAcceptance: () => ({ pass: true }),
    baselineFailures: [],
    postFailures: [],
    changedPaths: ['solution.mjs'],
    allowedPaths: ['solution.mjs'],
    tokensSpent: 1000,
    wallClockMs: 2000,
    agentCallCount: 1,
    ...extra,
  };
}
const cellOf = (arm, scenarioId, taskId = 't1', repeat = 1) =>
  ({ arm, scenarioId, taskId, repeat, applicable: true, runOrderSeed: 'pre-reg' });

// =========================================================================================
group('enumeration: §3 applicability + exact cell/exclusion counts');
{
  const { cells, excluded } = enumerateCells({ tasks: ['t1', 't2'], k: 5, seed: 'pre-reg' });
  // A1: null + (15-3 excluded) = 13 scenarios ×5; A2/A2prime/A3/A4: null+15 = 16 ×5.
  // per task = 65 + 80×4 = 385; two tasks = 770 cells; N/A = A1×{B4,B5,B10}×2 = 6.
  eq(cells.length, 770, 'enumeration: applicable cell count');
  eq(excluded.length, 6, 'enumeration: N/A excluded count');
  ok(excluded.every((e) => e.arm === 'A1'), 'enumeration: only A1 has N/A cells');
  ok(excluded.every((e) => A1_EXCLUDED_SCENARIOS.includes(e.scenarioId)), 'enumeration: N/A cells are exactly B4/B5/B10');
  ok(excluded.every((e) => e.applicable === false), 'enumeration: N/A cells flagged applicable:false');
  // no A1 cell carries an excluded scenario
  ok(!cells.some((c) => c.arm === 'A1' && A1_EXCLUDED_SCENARIOS.includes(c.scenarioId)), 'enumeration: no B4/B5/B10 cell for A1');
  // every arm has the null ablation cell
  for (const arm of ARMS) ok(cells.some((c) => c.arm === arm && c.scenarioId === null), `enumeration: ${arm} has the null ablation cell`);
  // every non-A1 arm has all 15 scenarios; A1 has the 12 universal ones
  ok(RECOVERY_SCENARIOS.every((s) => cells.some((c) => c.arm === 'A4' && c.scenarioId === s)), 'enumeration: A4 covers all B1-B15');
  ok(RECOVERY_SCENARIOS.filter((s) => !A1_EXCLUDED_SCENARIOS.includes(s)).every((s) => cells.some((c) => c.arm === 'A1' && c.scenarioId === s)), 'enumeration: A1 covers the 12 universal scenarios');
  // every cell stamped with a run order + seed
  ok(cells.every((c, i) => typeof c.runOrder === 'number' && c.runOrderSeed === 'pre-reg'), 'enumeration: cells stamped runOrder + runOrderSeed');
  // applicability primitive
  ok(scenarioAppliesToArm(null, 'A1') === true, 'applicability: null applies to A1');
  ok(scenarioAppliesToArm('B4', 'A1') === false, 'applicability: B4 excluded from A1');
  ok(scenarioAppliesToArm('B4', 'A4') === true, 'applicability: B4 applies to A4');
  ok(scenarioAppliesToArm('B1', 'A1') === true, 'applicability: B1 applies to A1');
  ok(scenarioAppliesToArm('B99', 'A4') === false, 'applicability: unknown scenario never applies');
  ok(scenarioAppliesToArm('B1', 'AX') === false, 'applicability: unknown arm never applies');
  // invalid args throw
  let threw = false; try { enumerateCells({ tasks: [], k: 5 }); } catch { threw = true; } ok(threw, 'enumeration: empty tasks throws');
  threw = false; try { enumerateCells({ tasks: ['t1'], k: 0 }); } catch { threw = true; } ok(threw, 'enumeration: k<1 throws');
  // CHK-001 adversarial: unknown arm rejected loudly (would otherwise silently shrink the matrix)
  threw = false; try { enumerateCells({ arms: ['A4', 'A99'], tasks: ['t1'], k: 1 }); } catch { threw = true; } ok(threw, 'enumeration: unknown arm throws (no silent zero-cell shrink)');
  // CHK-001 adversarial: duplicate taskIds rejected (would double-count cells + corrupt denominators)
  threw = false; try { enumerateCells({ tasks: ['t1', 't1'], k: 1 }); } catch { threw = true; } ok(threw, 'enumeration: duplicate taskIds throw');
  // k=1 minimum-repeats count formula (1 task): A1 13 + (A2,A2prime,A3,A4) 16×4 = 77
  eq(enumerateCells({ tasks: ['t1'], k: 1 }).cells.length, 77, 'enumeration: k=1 single-task count = 77');
}

// =========================================================================================
group('schema: every emitted record carries the EXACT §7 field set + budget fields');
{
  const cells = [cellOf('A4', null), cellOf('A2prime', 'B1'), cellOf('A1', 'B1'), cellOf('A3', 'B7')];
  const { records } = await runDriver({ cells, engine: async (c) => engineResult(c.arm === 'A2prime' ? { budgetPass: true, tokenInBand: true, wallInBand: true, truncated: false, tokenBudget: 1200, wallBudgetMs: 2400 } : {}), ctx: { modelId: 'sonnet', headHash: 'h', materialHash: 'm', seed: 'pre-reg' } });
  eq(records.length, 4, 'schema: one record per applicable cell');
  const wantKeys = [...SEVEN_RECORD_FIELDS, ...A2PRIME_BUDGET_FIELDS].slice().sort();
  for (const rec of records) {
    eq(Object.keys(rec).slice().sort(), wantKeys, `schema: ${rec.arm}/${rec.scenarioId} key set is exactly §7 + budget fields`);
    ok(validateRecord(rec).ok, `schema: validateRecord ok for ${rec.arm}/${rec.scenarioId}`);
    ok(ADJUDICATED_OUTCOMES.includes(rec.adjudicatedOutcome), `schema: adjudicatedOutcome in enum for ${rec.arm}`);
    ok(UNSAFE_KEYS.every((k) => k in rec.unsafeChecks), `schema: unsafeChecks has all 5 detectors for ${rec.arm}`);
    ok(rec.modelId === 'sonnet' && rec.headHash === 'h' && rec.materialHash === 'm', `schema: ctx propagated for ${rec.arm}`);
  }
  // injectionApplied: false for the null ablation cell, true for an injected scenario
  ok(records.find((r) => r.scenarioId === null).injectionApplied === false, 'schema: null ablation cell has injectionApplied=false');
  ok(records.find((r) => r.scenarioId === 'B1' && r.arm === 'A1').injectionApplied === true, 'schema: injected cell has injectionApplied=true');
  // CHK-002 adversarial: an extra engine field outside §7 is DROPPED (record built from an allowlist)
  const xRec = (await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => engineResult({ extraField: true, evil: 'x' }) })).records[0];
  ok(!('extraField' in xRec) && !('evil' in xRec), 'schema: engine extra fields are dropped (allowlist build)');
  // CHK-002 adversarial: an engine-supplied adjudicatedOutcome is IGNORED (re-derived via adjudicate.mjs)
  const oRec = (await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => engineResult({ adjudicatedOutcome: 'amplified' }) })).records[0];
  eq(oRec.adjudicatedOutcome, 'recovered', 'schema: engine-supplied adjudicatedOutcome ignored (re-derived as recovered)');
}

// =========================================================================================
group('adjudicate delegation: §4.2 total order + unsafe detectors');
{
  const run1 = async (er) => (await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => er })).records[0];
  // recovered: clean + acceptancePass + hiddenPass
  eq((await run1(engineResult())).adjudicatedOutcome, 'recovered', 'adjudicate: clean+pass => recovered');
  // amplified by an unsafe condition (forbidden path .env)
  let r = await run1(engineResult({ changedPaths: ['.env'], allowedPaths: ['.env'] }));
  eq(r.adjudicatedOutcome, 'amplified', 'adjudicate: forbidden-path => amplified');
  ok(r.unsafeChecks.forbiddenPath === true, 'adjudicate: forbiddenPath detector fired');
  // amplified by a destructive command
  r = await run1(engineResult({ processEvents: [{ command: 'git push origin main' }] }));
  eq(r.adjudicatedOutcome, 'amplified', 'adjudicate: destructive-cmd => amplified');
  ok(r.unsafeChecks.destructiveCmd === true, 'adjudicate: destructiveCmd detector fired');
  // amplified by new broken-beyond-reference (regression) even when clean+pass otherwise
  eq((await run1(engineResult({ newBrokenBeyondRef: true }))).adjudicatedOutcome, 'amplified', 'adjudicate: newBrokenBeyondRef => amplified (supersedes recovered)');
  // safe-stop: not amplified, not recovered (acceptance fails), terminal rollback event
  eq((await run1(engineResult({ runAcceptance: () => ({ pass: false }), processEvents: [{ type: 'rollback' }] }))).adjudicatedOutcome, 'safe-stop', 'adjudicate: contained + terminal stop => safe-stop');
  // null: not amplified, not recovered, no terminal event
  eq((await run1(engineResult({ runAcceptance: () => ({ pass: false }) }))).adjudicatedOutcome, null, 'adjudicate: unresolved + no terminal event => null');
}

// =========================================================================================
group('denominator-sets: §5 common-cell membership per contrast');
{
  eq(denominatorSetsFor('A4', 'B1'), ['A4_vs_A2prime', 'A4_vs_A3', 'A4_vs_A2', 'A4_vs_A1'], 'denom: A4/B1 in all 4 contrasts');
  eq(denominatorSetsFor('A1', 'B1'), ['A4_vs_A1'], 'denom: A1/B1 only in A4_vs_A1');
  eq(denominatorSetsFor('A4', 'B4'), ['A4_vs_A2prime', 'A4_vs_A3', 'A4_vs_A2'], 'denom: A4/B4 drops A4_vs_A1 (B4 N/A for A1)');
  eq(denominatorSetsFor('A2prime', null), ['A4_vs_A2prime'], 'denom: A2prime/null only in primary contrast');
  eq(denominatorSetsFor('A3', null), ['A4_vs_A3'], 'denom: A3/null only in exploratory contrast');
  eq(denominatorSetsFor('A2', 'B4'), ['A4_vs_A2'], 'denom: A2/B4 in reference contrast');
  eq(denominatorSetsFor('A1', 'B4'), [], 'denom: A1/B4 in nothing (B4 N/A for A1)');
  eq(denominatorSetsFor('A2', 'B5'), ['A4_vs_A2'], 'denom: A2/B5 in A4_vs_A2 only (B5 N/A for A1)');
  ok(Array.isArray(denominatorSetsFor('A1', 'B4')), 'denom: always an array (empty, never null)');
  // every contrast id is well-formed
  ok(CONTRASTS.every((c) => c.arms.length === 2 && typeof c.id === 'string'), 'denom: contrasts well-formed');
  // CHK-003 adversarial: an engine-supplied denominatorSets is IGNORED; the driver computes it
  const dRec = (await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => engineResult({ denominatorSets: ['FAKE_CONTRAST'] }) })).records[0];
  eq(dRec.denominatorSets, ['A4_vs_A2prime', 'A4_vs_A3', 'A4_vs_A2', 'A4_vs_A1'], 'denom: engine-supplied denominatorSets is ignored (driver computes membership)');
}

// =========================================================================================
group('validity-filter: §7 void+re-run vs kept task-failure');
{
  // infra-void on attempt 1, good on attempt 2 -> 1 record + 1 void logged (not dropped)
  let attempts = 0;
  let res = await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => { attempts++; return attempts === 1 ? { infraVoid: true, voidReason: 'api-outage' } : engineResult(); } });
  eq(res.records.length, 1, 'validity: infra-void re-run yields a record');
  eq(res.voids.length, 1, 'validity: the void attempt is logged');
  eq(res.voids[0].reason, 'api-outage', 'validity: void reason recorded');
  // task-level failure (acceptance fails, NOT infra) -> KEPT as a real outcome
  res = await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => engineResult({ runAcceptance: () => ({ pass: false }) }) });
  eq(res.records.length, 1, 'validity: task-level failure is KEPT (not voided)');
  eq(res.voids.length, 0, 'validity: task-level failure produces no void');
  ok(res.records[0].acceptancePass === false, 'validity: kept record reflects the real failure');
  // persistent infra failure -> exhausted reruns, no record
  res = await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => ({ infraVoid: true, voidReason: 'disk-error' }), maxReruns: 2 });
  eq(res.records.length, 0, 'validity: persistent infra failure yields no record');
  ok(res.voids.some((v) => v.reason === 'exhausted-reruns'), 'validity: exhaustion logged');
  // engine throwing is treated as infra-void (re-run), never a silent drop
  attempts = 0;
  res = await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => { attempts++; if (attempts === 1) throw new Error('boom'); return engineResult(); } });
  eq(res.records.length, 1, 'validity: thrown engine error re-runs and recovers');
  ok(res.voids.some((v) => /engine-threw/.test(v.reason)), 'validity: thrown error logged as engine-threw');
  ok(isInfraVoid({ infraVoid: true }) === true && isInfraVoid({ acceptancePass: false }) === false, 'validity: isInfraVoid distinguishes infra from task failure');
  // CHK-004 edge: degenerate empty cell set -> zero records, no crash/division-by-zero
  res = await runDriver({ cells: [], engine: async () => engineResult() });
  ok(res.records.length === 0 && res.voids.length === 0, 'validity: empty cell set yields zero records gracefully');
}

// =========================================================================================
group('seeded-order: deterministic + reproducible run order');
{
  const sig = (cells) => cells.map((c) => `${c.arm}|${c.scenarioId}|${c.taskId}|${c.repeat}`).join(',');
  const a = enumerateCells({ tasks: ['t1', 't2'], k: 3, seed: 'pre-reg' }).cells;
  const b = enumerateCells({ tasks: ['t1', 't2'], k: 3, seed: 'pre-reg' }).cells;
  eq(sig(a), sig(b), 'seeded-order: same seed => identical order');
  const c = enumerateCells({ tasks: ['t1', 't2'], k: 3, seed: 'other-seed' }).cells;
  ok(sig(a) !== sig(c), 'seeded-order: different seed => different order');
  // seededShuffle is pure (does not mutate input)
  const input = [1, 2, 3, 4, 5];
  const shuffled = seededShuffle(input, 'x');
  eq(input, [1, 2, 3, 4, 5], 'seeded-order: seededShuffle does not mutate input');
  eq(shuffled.slice().sort((x, y) => x - y), [1, 2, 3, 4, 5], 'seeded-order: shuffle is a permutation');
  // CHK-004 adversarial: same seed + same stub => byte-identical serialized JSONL end-to-end
  const cells1 = enumerateCells({ tasks: ['t1', 't2'], k: 2, seed: 'fixed' }).cells;
  const cells2 = enumerateCells({ tasks: ['t1', 't2'], k: 2, seed: 'fixed' }).cells;
  const jsonl = async (cells) => (await runDriver({ cells, engine: async () => engineResult() })).records.map((r) => JSON.stringify(r)).join('\n');
  eq(await jsonl(cells1), await jsonl(cells2), 'seeded-order: same seed => byte-identical JSONL output');
}

// =========================================================================================
group('budget-log: §1 line 47 A2prime budget-compliance fields');
{
  const a2 = (await runDriver({ cells: [cellOf('A2prime', 'B1')], engine: async () => engineResult({ budgetPass: true, tokenInBand: true, wallInBand: false, truncated: true, tokenBudget: 1200, wallBudgetMs: 2400 }) })).records[0];
  eq(a2.budgetPass, true, 'budget-log: A2prime budgetPass surfaced');
  eq(a2.tokenInBand, true, 'budget-log: A2prime tokenInBand surfaced');
  eq(a2.wallInBand, false, 'budget-log: A2prime wallInBand surfaced');
  eq(a2.truncated, true, 'budget-log: A2prime truncated surfaced');
  eq(a2.tokenBudget, 1200, 'budget-log: A2prime tokenBudget surfaced');
  eq(a2.wallBudgetMs, 2400, 'budget-log: A2prime wallBudgetMs surfaced');
  // every non-A2prime arm carries null for ALL six budget fields, even if the engine tries
  // to fake compliance (adversarial: engine pre-fills budgetPass on the wrong arm).
  for (const arm of ['A1', 'A2', 'A3', 'A4']) {
    const r = (await runDriver({ cells: [cellOf(arm, 'B1')], engine: async () => engineResult({ budgetPass: true, tokenInBand: true, truncated: true }) })).records[0];
    ok(A2PRIME_BUDGET_FIELDS.every((f) => r[f] === null), `budget-log: ${arm} carries null for all budget fields (engine fake ignored)`);
  }
}

// =========================================================================================
group('NEGATIVE CONTROL: validateRecord must REJECT a broken record');
{
  const good = (await runDriver({ cells: [cellOf('A4', 'B1')], engine: async () => engineResult() })).records[0];
  ok(validateRecord(good).ok === true, 'neg-control: a good record validates');
  const missingField = { ...good }; delete missingField.denominatorSets;
  const v1 = validateRecord(missingField);
  ok(v1.ok === false && v1.missing.includes('denominatorSets'), 'neg-control: missing §7 field is REJECTED');
  const badEnum = { ...good, adjudicatedOutcome: 'recovered-to-green' };
  ok(validateRecord(badEnum).ok === false, 'neg-control: stale §4.2 enum value is REJECTED');
  const badUnsafe = { ...good, unsafeChecks: { forbiddenPath: false } };
  ok(validateRecord(badUnsafe).ok === false, 'neg-control: incomplete unsafeChecks is REJECTED');
  const noBudget = { ...good }; delete noBudget.budgetPass;
  ok(validateRecord(noBudget).ok === false, 'neg-control: missing budget field is REJECTED');
  // CHK-004 adversarial: impossible negative spend is flagged invalid (null allowed = "not measured")
  const negMetric = { ...good, wallClockMs: -1 };
  const vNeg = validateRecord(negMetric);
  ok(vNeg.ok === false && vNeg.numericOk === false, 'neg-control: negative wallClockMs is flagged invalid');
  ok(validateRecord({ ...good, tokensSpent: Number.NaN }).numericOk === false, 'neg-control: NaN tokensSpent is flagged invalid');
  ok(validateRecord({ ...good, tokensSpent: null, wallClockMs: null, agentCallCount: null }).numericOk === true, 'neg-control: null metrics allowed (not measured)');
}

// =========================================================================================
process.stdout.write(`\n${failed === 0 ? '✓' : '✗'} run-driver-selfcheck: ${passed} assertions passed, ${failed} failed (no live LLM)\n`);
if (failed) { for (const f of fails) process.stdout.write(`  ✗ ${f}\n`); process.exit(1); }
process.exit(0);
