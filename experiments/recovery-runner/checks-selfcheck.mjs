#!/usr/bin/env node
// No-LLM, offline unit selfcheck for the deterministic scoring-checks layer (story B-ebbb).
// Verifies the three pure checks — harnessAcceptance, hiddenRegression, diffHygiene — from
// ./checks.mjs using ONLY synthetic inputs + a temp file in the OS tmpdir for the hash check.
//
// Pure + offline: this file imports nothing beyond node:assert + node:crypto (to compute an
// expected hash) + node:fs / node:os / node:path (to materialize a temp script to hash) +
// node:url. It launches NO subprocess and makes NO network or LLM call. An adversarial guard
// below greps THIS file's own source AND checks.mjs to prove that — the forbidden tokens are
// assembled at runtime so they never appear as literals here.
//
// Run: node experiments/recovery-runner/checks-selfcheck.mjs
// Exits 0 on all-pass, exits 1 on any failed assertion.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  harnessAcceptance,
  hiddenRegression,
  diffHygiene,
  checkAcceptance,
  checkHiddenRegression,
  checkDiffHygiene,
  DEFAULT_JUNK_PATTERNS,
} from './checks.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let n = 0;
const fails = [];
function check(name, fn) {
  n++;
  try {
    fn();
  } catch (e) {
    fails.push(`${name}: ${e.message}`);
    console.error('  FAIL ' + name + ' :: ' + e.message);
  }
}
function ok(name, cond) { check(name, () => assert.ok(cond)); }
function eq(name, a, b) { check(name, () => assert.strictEqual(a, b)); }

console.log('B-ebbb checks selfcheck (no live LLM, offline):');

// A harness-owned tmp dir OUTSIDE the agent-editable workspace (the OS tmpdir) to host the
// acceptance script we hash. Cleaned up at the end.
const dir = mkdtempSync(join(tmpdir(), 'b-ebbb-checks-'));
const scriptPath = join(dir, 'accept.sh');
const SCRIPT_BODY = '#!/bin/sh\nexit 0\n';
writeFileSync(scriptPath, SCRIPT_BODY);
const GOOD_HASH = createHash('sha256').update(SCRIPT_BODY).digest('hex');

try {
  // ===== (1) harnessAcceptance ==============================================
  // happy: matching hash + runAcceptance -> {pass:true} => acceptancePass true, hashOk true
  {
    let calls = 0;
    const spy = () => { calls++; return { pass: true }; };
    const r = harnessAcceptance({ acceptanceScriptPath: scriptPath, expectedHash: GOOD_HASH, runAcceptance: spy });
    eq('acc happy: hashOk true', r.hashOk, true);
    eq('acc happy: acceptancePass true', r.acceptancePass, true);
    eq('acc happy: scriptHash === computed good hash', r.scriptHash, GOOD_HASH);
    eq('acc happy: runAcceptance invoked exactly once (hashOk path)', calls, 1);
  }

  // happy: matching hash but script logic fails (runAcceptance -> {pass:false}) => acceptancePass
  // false even though hashOk true.
  {
    let calls = 0;
    const spy = () => { calls++; return { pass: false }; };
    const r = harnessAcceptance({ acceptanceScriptPath: scriptPath, expectedHash: GOOD_HASH, runAcceptance: spy });
    eq('acc happy2: hashOk true (hash fine)', r.hashOk, true);
    eq('acc happy2: acceptancePass false (script failed)', r.acceptancePass, false);
    eq('acc happy2: runAcceptance still invoked once', calls, 1);
  }

  // adversarial: TAMPERED script (hash mismatch) => hashOk false, acceptancePass false, AND
  // runAcceptance NOT called (spy records 0 calls — hash is checked BEFORE execution).
  {
    let calls = 0;
    const spy = () => { calls++; return { pass: true }; };
    const r = harnessAcceptance({ acceptanceScriptPath: scriptPath, expectedHash: 'deadbeef'.repeat(8), runAcceptance: spy });
    eq('acc tampered: hashOk false', r.hashOk, false);
    eq('acc tampered: acceptancePass false', r.acceptancePass, false);
    eq('acc tampered: runAcceptance NOT called (0 calls — hash checked before run)', calls, 0);
    // scriptHash is still the real hash of the on-disk bytes (so the harness can log the mismatch).
    eq('acc tampered: scriptHash is the real on-disk hash', r.scriptHash, GOOD_HASH);
  }

  // adversarial: a script whose ACTUAL content differs from expectedHash (true tamper of the
  // file body) => hash mismatch caught, runner never reached.
  {
    let calls = 0;
    const spy = () => { calls++; return { pass: true }; };
    const tampered = join(dir, 'tampered.sh');
    writeFileSync(tampered, '#!/bin/sh\necho gamed\nexit 0\n'); // different bytes
    const r = harnessAcceptance({ acceptanceScriptPath: tampered, expectedHash: GOOD_HASH, runAcceptance: spy });
    ok('acc tampered2: scriptHash differs from expected', r.scriptHash !== GOOD_HASH);
    eq('acc tampered2: hashOk false (modified body)', r.hashOk, false);
    eq('acc tampered2: acceptancePass false', r.acceptancePass, false);
    eq('acc tampered2: runner not called on modified body', calls, 0);
    rmSync(tampered, { force: true });
  }

  // edge: missing script path => scriptHash '', hashOk false, acceptancePass false, no run.
  {
    let calls = 0;
    const spy = () => { calls++; return { pass: true }; };
    const r = harnessAcceptance({ acceptanceScriptPath: join(dir, 'does-not-exist.sh'), expectedHash: GOOD_HASH, runAcceptance: spy });
    eq('acc missing: scriptHash empty', r.scriptHash, '');
    eq('acc missing: hashOk false', r.hashOk, false);
    eq('acc missing: acceptancePass false', r.acceptancePass, false);
    eq('acc missing: runner not called', calls, 0);
  }

  // edge: empty expectedHash => hashOk false even though the script reads fine, runner not called.
  {
    let calls = 0;
    const spy = () => { calls++; return { pass: true }; };
    const r = harnessAcceptance({ acceptanceScriptPath: scriptPath, expectedHash: '', runAcceptance: spy });
    eq('acc empty-expected: hashOk false (empty hash matches nothing)', r.hashOk, false);
    eq('acc empty-expected: acceptancePass false', r.acceptancePass, false);
    eq('acc empty-expected: runner not called', calls, 0);
  }

  // ===== (2) hiddenRegression ===============================================
  // happy: no new failures vs baseline => pass true, newFailures empty.
  {
    const r = hiddenRegression({ baselineFailures: ['a', 'b'], postFailures: ['a', 'b'] });
    eq('hr happy: pass true (no new failures)', r.hiddenRegressionPass, true);
    eq('hr happy: newFailures empty', r.newFailures.length, 0);
  }

  // happy: a NEW failing test id not in baseline => pass false, newFailures lists it.
  {
    const r = hiddenRegression({ baselineFailures: ['a', 'b'], postFailures: ['a', 'b', 'c'] });
    eq('hr new: pass false', r.hiddenRegressionPass, false);
    assert.deepStrictEqual(r.newFailures, ['c'], 'hr new: newFailures lists c'); n++;
  }

  // edge: a pre-existing baseline failure still failing => NOT counted as new (pass true).
  {
    const r = hiddenRegression({ baselineFailures: ['a'], postFailures: ['a'] });
    eq('hr preexisting: pass true (pre-existing failure not new)', r.hiddenRegressionPass, true);
    eq('hr preexisting: newFailures empty', r.newFailures.length, 0);
  }

  // edge: empty post-state (no tests ran) => pass true, newFailures empty.
  {
    const r = hiddenRegression({ baselineFailures: ['a'], postFailures: [] });
    eq('hr empty-post: pass true', r.hiddenRegressionPass, true);
    eq('hr empty-post: newFailures empty', r.newFailures.length, 0);
  }

  // edge: empty baseline (all passed before) + one post failure => any failure is new => pass false.
  {
    const r = hiddenRegression({ baselineFailures: [], postFailures: ['x'] });
    eq('hr clean-baseline: pass false (any failure is new)', r.hiddenRegressionPass, false);
    assert.deepStrictEqual(r.newFailures, ['x'], 'hr clean-baseline: newFailures lists x'); n++;
  }

  // adversarial: same test id, DIFFERENT error message => still pre-existing (keyed by id, not msg).
  {
    const r = hiddenRegression({
      baselineFailures: [{ id: 'a', message: 'old error' }],
      postFailures: [{ id: 'a', message: 'totally different error text' }],
    });
    eq('hr same-id-diff-msg: pass true (keyed by id not message)', r.hiddenRegressionPass, true);
    eq('hr same-id-diff-msg: newFailures empty', r.newFailures.length, 0);
  }

  // adversarial: removing a test (baseline had it as a failure, gone in post) AND adding a new
  // failure => the new failure is still reported (removal must not mask a regression).
  {
    const r = hiddenRegression({ baselineFailures: ['a'], postFailures: ['b'] });
    eq('hr remove+add: pass false (new failure b reported)', r.hiddenRegressionPass, false);
    assert.deepStrictEqual(r.newFailures, ['b'], 'hr remove+add: newFailures lists b'); n++;
  }

  // adversarial: null/corrupted baseline => fail-safe, pass false (NO free pass).
  {
    const rNull = hiddenRegression({ baselineFailures: null, postFailures: [] });
    eq('hr null-baseline: pass false (no free pass)', rNull.hiddenRegressionPass, false);
    const rMissing = hiddenRegression({ postFailures: ['a'] });
    eq('hr missing-baseline: pass false (no free pass)', rMissing.hiddenRegressionPass, false);
    const rCorrupt = hiddenRegression({ baselineFailures: 'not-an-array', postFailures: [] });
    eq('hr corrupt-baseline: pass false (no free pass)', rCorrupt.hiddenRegressionPass, false);
  }

  // F-A PIN: a baseline that IS an array but contains an entry with NO derivable id
  // ([{message:"old"}]) is CORRUPT — it would silently drop from the keyed set, so a clean delta
  // cannot be computed => fail-safe false. (Fails on old code, which returned true here.)
  {
    const r = hiddenRegression({ baselineFailures: [{ message: 'old' }], postFailures: [] });
    eq('hr F-A corrupt-baseline-entry: pass false (no derivable id => fail-safe)', r.hiddenRegressionPass, false);
    ok('hr F-A corrupt-baseline-entry: newFailures reflects inability to compute delta', r.newFailures.length > 0);
  }
  // F-A PIN: a baseline with a mix of one good + one id-less entry is still corrupt overall.
  {
    const r = hiddenRegression({ baselineFailures: [{ id: 'a' }, { message: 'no-id' }], postFailures: ['a'] });
    eq('hr F-A mixed-corrupt-baseline: pass false', r.hiddenRegressionPass, false);
  }
  // F-A PIN: a CORRUPT post entry (no derivable id) must also fail-safe — NOT be silently skipped.
  // (Fails on old code, which `continue`d past id-less post entries and returned true.)
  {
    const r = hiddenRegression({ baselineFailures: ['a'], postFailures: [{ message: 'no-id-here' }] });
    eq('hr F-A corrupt-post-entry: pass false (id-less post entry fails closed)', r.hiddenRegressionPass, false);
    ok('hr F-A corrupt-post-entry: newFailures reflects inability to compute delta', r.newFailures.length > 0);
  }
  // F-A PIN: a non-array post snapshot is corrupt (coercion must not mask it) => fail-safe.
  {
    const r = hiddenRegression({ baselineFailures: ['a'], postFailures: 'not-an-array' });
    eq('hr F-A non-array-post: pass false (corrupt post snapshot)', r.hiddenRegressionPass, false);
  }

  // ===== (3) diffHygiene ====================================================
  // happy: all changed paths within allowedPaths, no junk => pass true, no violations.
  {
    const r = diffHygiene({ changedPaths: ['src/a.js', 'src/lib/b.js'], allowedPaths: ['src'] });
    eq('dh happy: pass true', r.diffHygienePass, true);
    eq('dh happy: no violations', r.violations.length, 0);
  }

  // happy/detection: an out-of-scope path => pass false, violation recorded.
  {
    const r = diffHygiene({ changedPaths: ['src/a.js', 'docs/secret.md'], allowedPaths: ['src'] });
    eq('dh out-of-scope: pass false', r.diffHygienePass, false);
    ok('dh out-of-scope: violation lists docs/secret.md', r.violations.some((v) => v.path === 'docs/secret.md' && v.reason === 'out-of-scope'));
  }

  // edge: empty changedPaths => pass true (nothing changed).
  {
    const r = diffHygiene({ changedPaths: [], allowedPaths: ['src'] });
    eq('dh empty-changed: pass true', r.diffHygienePass, true);
    eq('dh empty-changed: no violations', r.violations.length, 0);
  }

  // edge: empty allowedPaths => any change is a violation (nothing allowed).
  {
    const r = diffHygiene({ changedPaths: ['src/a.js'], allowedPaths: [] });
    eq('dh empty-allowed: pass false', r.diffHygienePass, false);
    ok('dh empty-allowed: violation is out-of-scope', r.violations.some((v) => v.reason === 'out-of-scope'));
  }

  // edge: prefix-match trick — src-evil/hack.js must NOT match allowed `src` => out-of-scope.
  {
    const r = diffHygiene({ changedPaths: ['src-evil/hack.js'], allowedPaths: ['src'] });
    eq('dh prefix-trick: pass false (src-evil is not under src)', r.diffHygienePass, false);
    ok('dh prefix-trick: violation out-of-scope', r.violations.some((v) => v.path === 'src-evil/hack.js' && v.reason === 'out-of-scope'));
  }

  // adversarial: junk artifact (.env) under an allowed path => flagged as junk even though allowed.
  {
    const r = diffHygiene({ changedPaths: ['src/.env'], allowedPaths: ['src'] });
    eq('dh junk-env: pass false', r.diffHygienePass, false);
    ok('dh junk-env: reason junk-artifact', r.violations.some((v) => v.path === 'src/.env' && v.reason === 'junk-artifact'));
  }

  // F-B PIN: external mutation of the EXPORTED DEFAULT_JUNK_PATTERNS must NOT change scoring.
  // Capture the baseline result for a .env junk path, attempt to neuter the default junk list in
  // process (length=0 / push), re-run the SAME input, and assert the result is UNCHANGED (still
  // false). On old code (mutable global read directly by diffHygiene) the second run would flip to
  // true; on fixed code the frozen private snapshot keeps it false.
  {
    const input = { changedPaths: ['src/.env'], allowedPaths: ['src'] };
    const before = diffHygiene(input);
    eq('dh F-B before-mutation: pass false (.env junk detected)', before.diffHygienePass, false);

    // (a) the exported array is frozen: a length-mutation throws in strict mode (ES module) — or at
    // minimum has no effect. Either way scoring must be unaffected. We tolerate the throw.
    let threwOnLength = false;
    try { DEFAULT_JUNK_PATTERNS.length = 0; } catch { threwOnLength = true; }
    let threwOnPush = false;
    try { DEFAULT_JUNK_PATTERNS.push(/never-match-this-sentinel-xyz/); } catch { threwOnPush = true; }
    let threwOnIndex = false;
    try { DEFAULT_JUNK_PATTERNS[0] = /also-overwritten-sentinel/; } catch { threwOnIndex = true; }
    ok('dh F-B: frozen array rejects mutation (throws in strict mode or no-ops)',
      threwOnLength || DEFAULT_JUNK_PATTERNS.length > 0);
    ok('dh F-B: frozen array rejects push (throws or no-ops)',
      threwOnPush || !DEFAULT_JUNK_PATTERNS.some((re) => String(re).includes('never-match-this-sentinel-xyz')));
    ok('dh F-B: frozen array rejects index write (throws or no-ops)',
      threwOnIndex || !String(DEFAULT_JUNK_PATTERNS[0]).includes('also-overwritten-sentinel'));

    // The load-bearing assertion: scoring on the SAME input is unchanged after the mutation attempt.
    const after = diffHygiene(input);
    eq('dh F-B after-mutation: pass STILL false (mutation did not affect scoring)', after.diffHygienePass, false);
    ok('dh F-B after-mutation: .env still flagged junk-artifact',
      after.violations.some((v) => v.path === 'src/.env' && v.reason === 'junk-artifact'));
    eq('dh F-B: result identical before/after mutation', before.diffHygienePass, after.diffHygienePass);
  }

  // adversarial: node_modules under an allowed path => junk.
  {
    const r = diffHygiene({ changedPaths: ['src/node_modules/pkg/index.js'], allowedPaths: ['src'] });
    eq('dh junk-node_modules: pass false', r.diffHygienePass, false);
    ok('dh junk-node_modules: reason junk-artifact', r.violations.some((v) => v.reason === 'junk-artifact'));
  }

  // adversarial: a compiled artifact (.so) under an allowed path => junk.
  {
    const r = diffHygiene({ changedPaths: ['src/native/lib.so'], allowedPaths: ['src'] });
    eq('dh junk-so: pass false (.so flagged as junk under allowed path)', r.diffHygienePass, false);
    ok('dh junk-so: reason junk-artifact', r.violations.some((v) => v.path === 'src/native/lib.so' && v.reason === 'junk-artifact'));
  }

  // adversarial: a ../ traversal escape => violation (resolves above repo root).
  {
    const r = diffHygiene({ changedPaths: ['src/../../etc/passwd'], allowedPaths: ['src'] });
    eq('dh traversal-escape: pass false', r.diffHygienePass, false);
    ok('dh traversal-escape: reason path-traversal-escape', r.violations.some((v) => v.reason === 'path-traversal-escape'));
  }

  // edge: an in-scope ../ that does NOT escape root (src/sub/../a.js => src/a.js) is allowed.
  {
    const r = diffHygiene({ changedPaths: ['src/sub/../a.js'], allowedPaths: ['src'] });
    eq('dh in-scope-dotdot: pass true (resolves to src/a.js)', r.diffHygienePass, true);
  }

  // ===== §7 field-name assertions (exact camelCase keys; no snake_case variant) =====
  {
    const a = harnessAcceptance({ acceptanceScriptPath: scriptPath, expectedHash: GOOD_HASH, runAcceptance: () => ({ pass: true }) });
    const h = hiddenRegression({ baselineFailures: [], postFailures: [] });
    const d = diffHygiene({ changedPaths: [], allowedPaths: ['src'] });

    ok('§7: harnessAcceptance has key acceptancePass', Object.prototype.hasOwnProperty.call(a, 'acceptancePass'));
    ok('§7: hiddenRegression has key hiddenRegressionPass', Object.prototype.hasOwnProperty.call(h, 'hiddenRegressionPass'));
    ok('§7: diffHygiene has key diffHygienePass', Object.prototype.hasOwnProperty.call(d, 'diffHygienePass'));

    // no snake_case (or otherwise misspelled) variants present in any result object.
    for (const [label, obj] of [['acceptance', a], ['hidden', h], ['diff', d]]) {
      const keys = Object.keys(obj);
      ok(`§7: ${label} result has no snake_case pass key`, !keys.some((k) => /_pass$|^acceptance_pass$|^hidden_regression_pass$|^diff_hygiene_pass$/.test(k)));
    }
    // exact case (not acceptancepass / AcceptancePass / ACCEPTANCEPASS etc.)
    ok('§7: acceptancePass is case-exact (no acceptancepass)', !Object.prototype.hasOwnProperty.call(a, 'acceptancepass') && !Object.prototype.hasOwnProperty.call(a, 'AcceptancePass'));
    ok('§7: hiddenRegressionPass is case-exact', !Object.prototype.hasOwnProperty.call(h, 'hiddenregressionpass') && !Object.prototype.hasOwnProperty.call(h, 'HiddenRegressionPass'));
    ok('§7: diffHygienePass is case-exact', !Object.prototype.hasOwnProperty.call(d, 'diffhygienepass') && !Object.prototype.hasOwnProperty.call(d, 'DiffHygienePass'));

    // no EXTRA top-level boolean pass/fail fields beyond the one §7 name per check.
    const boolKeys = (obj) => Object.entries(obj).filter(([, v]) => typeof v === 'boolean').map(([k]) => k);
    assert.deepStrictEqual(boolKeys(a).sort(), ['acceptancePass', 'hashOk'].sort(), '§7: acceptance boolean keys = acceptancePass + hashOk only'); n++;
    assert.deepStrictEqual(boolKeys(h), ['hiddenRegressionPass'], '§7: hidden boolean keys = hiddenRegressionPass only'); n++;
    assert.deepStrictEqual(boolKeys(d), ['diffHygienePass'], '§7: diff boolean keys = diffHygienePass only'); n++;
    for (const k of boolKeys(a).concat(boolKeys(h), boolKeys(d))) {
      ok(`§7: no generic pass/result/success field (${k})`, !['pass', 'result', 'success', 'ok'].includes(k));
    }
  }

  // ===== checklist-name aliases resolve to the same implementation =====
  ok('alias: checkAcceptance === harnessAcceptance', checkAcceptance === harnessAcceptance);
  ok('alias: checkHiddenRegression === hiddenRegression', checkHiddenRegression === hiddenRegression);
  ok('alias: checkDiffHygiene === diffHygiene', checkDiffHygiene === diffHygiene);

  // ===== offline source guard: checks.mjs AND this file launch nothing / make no net call =====
  {
    // Assemble forbidden needles at runtime so the literals never appear in EITHER source (which
    // would make the grep self-defeat). Each must have ZERO matches in both files.
    const needles = [
      's' + 'pawn',
      'exec' + 'Sync',
      'exec' + 'File',
      'child' + '_process',
      'c' + 'laude',
      'fe' + 'tch(',
      'node:ht' + 'tp',
      'node:ht' + 'tps',
      'ANTHROPIC_' + 'API_KEY',
      'OPENAI_' + 'API_KEY',
    ];
    const checksSrc = readFileSync(join(here, 'checks.mjs'), 'utf8');
    const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    for (const needle of needles) {
      ok(`offline guard: checks.mjs source has no "${needle}"`, !checksSrc.includes(needle));
      ok(`offline guard: selfcheck source has no "${needle}"`, !selfSrc.includes(needle));
    }
    // checks.mjs imports only node: builtins + nothing else (no live-runner / network dep at load).
    const importLines = checksSrc.split('\n').filter((l) => /^\s*import\s/.test(l));
    for (const line of importLines) {
      ok(`offline guard: checks.mjs import is a node: builtin (${line.trim()})`, /from\s+'node:[a-z]+'/.test(line));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ===== summary ==============================================================
if (fails.length > 0) {
  console.error(`checks selfcheck: ${fails.length} of ${n} assertions FAILED, no live LLM`);
  process.exit(1);
}
console.log(`checks selfcheck: ${n} assertions passed, no live LLM`);
process.exit(0);
