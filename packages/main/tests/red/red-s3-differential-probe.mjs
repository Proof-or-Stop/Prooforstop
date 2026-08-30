#!/usr/bin/env node
/**
 * DIFFERENTIAL PROBE for B-bf52: this branch's `gateFailureDigest` against a
 * SEPARATELY BUILT comparison normalizer — normally a freshly built `main`.
 *
 * WHY THIS FILE EXISTS, stated plainly because it is a correction. Rounds 9-11 of
 * this story quoted differential results and per-rejection cost figures in prose
 * evidence — "a 35-pair probe", "0.328 ms / 2.39x" — that no committed command
 * computed. They were ad-hoc scratchpad runs, and the proof that this is a real
 * defect rather than a bookkeeping nit is that two such quotations of the SAME
 * measurement disagreed (0.328 ms / 2.39x in one place, 0.369 ms / 2.74x in
 * another). An unrepeatable number is not evidence. This script is the artifact
 * those claims should have cited: every figure any later note quotes about this
 * story's differential behaviour or its cost must come from running it.
 *
 * ── WHAT ROUND 15 REMOVED FROM THIS FILE, AND WHY (F-058) ────────────────────
 *
 * Through round 14 this probe was mostly a leak matrix: 87 pairs, nine kinds, and
 * row groups named F-043, F-048, F-051, F-052, F-053, F-054 and F-056 — one group
 * per shape that had defeated the branch's artifact-id guard. THAT GUARD NO LONGER
 * EXISTS. The allowlist, the id pattern, the whole-token walk and the placeholder
 * encode/decode are deleted from core/convergence-breaker.ts, so every ordinal
 * collapses exactly as it does on main, and every one of those rows became a pair
 * that ties for a reason unrelated to the shape it was quoting. A row that cannot
 * fail for the reason its label names is a false attestation, so they are retired;
 * git history at the round-14 commit still has them.
 *
 * The reason the guard went is worth stating here rather than only in the source,
 * because it is what this file measured three times without being able to say it:
 * core/machine.ts:1190 interpolates RAW third-party test output into the reason the
 * digest keys on, and in that channel a bare token like `bug-2` is TEXTUALLY
 * IDENTICAL to a bare artifact ordinal such as the `BUG-002` of `Cannot enter DONE:
 * 1 unfixed bug(s): BUG-002`. Any rule recognising one recognises the other. The
 * eight leaks were eight measurements of that, not eight oversights, and for a
 * circuit breaker the safe direction is to collapse: too fine a key lets a stuck
 * agent mint a fresh key on every retry so the brake never fires, while too coarse a
 * key fires it early at the cost of one human acknowledgement.
 *
 * ── THIS PROBE PASSED THREE TIMES DURING A LIVE REGRESSION ───────────────────
 *
 * Kept at the top, because it is the most important thing this file's history
 * proves and it is still true of the reduced matrix below. Three times (rounds 11,
 * 12 and 13) this script exited 0 while the branch was measurably WORSE than main,
 * each time because the matrix could not EXPRESS the defect: every wrapper in it was
 * balanced, then no row ended in a stripped punctuation character, then no row put
 * an ordinary word between a prefix and an ordinal. Each miss was repaired by adding
 * the missing vector, and each repair was verified by making the defect again in an
 * isolated copy of the built normalizer and confirming this script went RED on
 * exactly the rows that name it.
 *
 * SO: when this file passes, read it as "no vector IN THIS MATRIX is worse than the
 * comparison", never as "this build is not worse than the comparison". And the way
 * to check that a guard is real is still to make the defect again — see the
 * round-15 demonstration below, which is the one that applies to the rules that
 * REMAIN.
 *
 * ── THE ROUND-15 RED-ON-DEFECT DEMONSTRATION, RUN AND RECORDED ───────────────
 *
 * After F-058 this branch differs from main in exactly two rules, so those two are
 * what a demonstration has to reach:
 *
 *   the POSIX path rule, narrowed to token start (C2 and C4);
 *   the prefix cut, made signals-conditional (C1c).
 *
 * The path rule is the one a differential comparison alone CANNOT catch, and that
 * is why BAR 3 exists below. Widen the rule back to main's slash-anywhere
 * `\/[^\s"']+` in an isolated copy of the built normalizer (a detached worktree's
 * dist, so nothing in the story worktree moves), point PROOF_OR_STOP_DIST at it and run
 * against a freshly built main. OBSERVED, and it is the reason BAR 3 is not
 * decoration:
 *
 *   exit 1, 0 BAR 1 violations, 0 BAR 2 violations, 4 BAR 3 violations — the four
 *   DELIVERED rows, named. Every one of them collapses on BOTH sides under the
 *   defect, so both differential bars score a truthful, useless zero and all 17
 *   pairs report as ties. Nothing about a two-sided comparison can see a regression
 *   whose entire effect is to make the branch AGREE with the comparison.
 *
 * The same run on the shipped build: exit 0, 4/4 delivered classes distinguished,
 * 0 BAR 1, 0 BAR 2, 0 BAR 3, 13 ties.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   # branch-only: prints the per-rejection cost and BAR 3, SKIPS the differential lane
 *   node packages/main/tests/red/red-s3-differential-probe.mjs
 *
 *   # full: differential lane against a comparison build
 *   node packages/main/tests/red/red-s3-differential-probe.mjs /path/to/main/packages/main/dist
 *   PROOF_OR_STOP_COMPARE_DIST=/path/to/main/packages/main/dist \
 *     node packages/main/tests/red/red-s3-differential-probe.mjs
 *
 *   # the branch build under test can be pointed elsewhere too
 *   PROOF_OR_STOP_DIST=/path/to/a/build/packages/main/dist node ... red-s3-differential-probe.mjs
 *
 * To produce a comparison build (a detached worktree keeps the story worktree
 * clean, and `--detach` means no branch is created or moved):
 *
 *   git worktree add --detach /tmp/probe-main main
 *   ln -s "$PWD/node_modules" /tmp/probe-main/node_modules
 *   node_modules/.bin/tsc -p /tmp/probe-main/packages/main/tsconfig.json
 *
 * ── THE BARS (all three must be zero) ────────────────────────────────────────
 *
 *   BAR 1  zero pairs where the BRANCH COLLAPSES what the COMPARISON DISTINGUISHES
 *          on a DELIVERED class. That is the branch being strictly coarser: a real
 *          distinction the comparison build could see and this one cannot.
 *
 *          The qualification is load-bearing and was added after measuring the
 *          unqualified form. Comparing this branch against round 10 of ITSELF, the
 *          unqualified BAR 1 fired twice — on `timeout:bug-N` and `x:chk-NNN`,
 *          where round 10 keyed apart because of a leak that was later removed. The
 *          branch collapsing those is CORRECT, and scoring it as a violation would
 *          make the probe demand that every future build preserve its predecessor's
 *          bugs. A distinction the comparison draws on an ordinal that a retry
 *          re-mints is the comparison's defect, not this build's obligation.
 *   BAR 2  zero pairs where the BRANCH DISTINGUISHES a VOLATILE class. This is the
 *          direction that matters most for a brake: if a rejection keys apart on
 *          something the retry it asks for re-mints, a stuck agent mints a fresh key
 *          on every attempt and the breaker never trips. It is also the direction in
 *          which the deleted artifact-id apparatus would announce its return — the
 *          F-058 rows below are ordinary artifact ordinals and the third-party label
 *          that is indistinguishable from one, and all of them must tie.
 *   BAR 3  zero DELIVERED pairs that the BRANCH ITSELF collapses. An ABSOLUTE check
 *          living in a differential file, and it is here deliberately: after F-058
 *          the only classes this story delivers are ones main ALSO collapses, so a
 *          branch that regressed would simply agree with main and score zero on both
 *          differential bars. BAR 3 is what makes this file red on a re-widened path
 *          rule or an unconditional prefix cut. It runs even when no comparison
 *          build is given.
 *
 * Every pair therefore carries the DIRECTION EXPECTED of it, and the report prints
 * that expectation next to what was observed.
 *
 * It is the companion of red-s3-digest-collapse.mjs. That harness asserts the
 * ABSOLUTE contract class by class; this one asserts a RELATIVE one — whatever the
 * branch does, it must not be worse than the comparison build — plus the one
 * absolute check (BAR 3) that the relative comparison structurally cannot make.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BRANCH_DIST = process.env.PROOF_OR_STOP_DIST || new URL('../../dist', import.meta.url).pathname;
const COMPARE_DIST = process.argv[2] || process.env.PROOF_OR_STOP_COMPARE_DIST || '';
const CMD = 'story_advance';

const branch = await import(`${BRANCH_DIST}/core/convergence-breaker.js`);

// ── producers, quoted as they render ─────────────────────────────────────────
// Every fixture below is composed from a REAL story_advance rejection site, not
// invented; the file:line citations are in tasks/convergence-breaker-smoke.ts
// next to the matrix case each pair mirrors.
const tap = (line) =>
  `Cannot enter DONE: test FAIL: # tests 1\n# pass 0\n# fail 1\nnot ok 1 - ${line}`;
const checklistPending = (ids) =>
  `Cannot enter REVIEW: ${ids.length} checklist item(s) not done: ${ids.join(', ')}`;
const unfixedBug = (id) => `Cannot enter DONE: 1 unfixed bug(s): ${id}`;
const reviewLoop = (o) =>
  `Cannot enter TEST: active review loop(s): loopId=B-bf52:${o}, decision=revise [open_review_loop]`;
const initIssue = (i) =>
  `Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues.\n  - product-reviewer: high ${i} the story boundary is not decidable`;
// core/machine.ts:753-756 renders every open blocking finding and :1181 appends the
// bracketed reason code, so a path named in the LAST description is the whole token.
const citedPathInLastFinding = (citedPath) =>
  `Cannot enter TEST: 1 open blocking finding(s): B-bf52:F-012 [high] no passing verification evidence for the change to ${citedPath} [review_finding_blocking]`;
// The real SIGNAL-LESS scope-gate rejection (C1c): no bracketed reason code, no
// bulleted snake_case gap id, no missing_/invalid_/stale_ token, and the offending
// path LAST — past character 200 of the normalized reason.
const scopeGateBlock = (path) =>
  'Cannot enter TEST: the scope gate is blocking for B-bf52. The story scope contract is in enforce mode, so every changed path must be '
  + 'declared by the contract, covered by a shared classifier rule, or carry an explicit acknowledgement that a reviewer can see. '
  + 'Run scope_contract_acknowledge with a reviewer-visible reason, add the path to the contract, or revert it. Blocking path: ' + path;

/**
 * KINDS, and the direction each expects. Round 15 reduced these from nine to two,
 * because seven of them classified shapes that only mattered while an artifact-id
 * guard existed.
 *
 *   delivered   a class THIS STORY DELIVERS: the branch must distinguish the pair.
 *               Two rules produce them — the POSIX path rule narrowed to token start
 *               (C2 phase targets, C4 in-repo file paths) and the signals-conditional
 *               prefix cut (C1c, a signal-less rejection diverging past character
 *               200). Against main these rows are branch-finer, because main
 *               collapses them; against a build that also narrows the path rule they
 *               tie. Either is fine. What is NOT fine is the branch collapsing one,
 *               which is BAR 3.
 *   volatile    nothing that survives a retry varies: timestamps, hashes, attempt
 *               counts, story-id digits, machine paths, re-minted bookkeeping ids —
 *               and, after F-058, artifact ordinals and the third-party labels that
 *               are indistinguishable from them. Must tie; branch-finer is BAR 2.
 */
const DELIVERED = new Set(['delivered']);

const EXPECT = {
  delivered: 'branch distinguishes (tie or branch-finer vs the comparison)',
  volatile: 'tie (must not be finer)',
};

const BAR2_REASON = {
  volatile: 'the varying token does not survive the retry the rejection asks for',
};

const PAIRS = [
  // ── DELIVERED: the narrowed POSIX path rule (C2 and C4) ────────────────────
  ['delivered C2 phase pair DEV/REVIEW vs DEV/TEST', 'delivered', 'transition refused: phase DEV/REVIEW is blocked by an unmet gate', 'transition refused: phase DEV/TEST is blocked by an unmet gate'],
  ['delivered C4 in-repo file path', 'delivered', 'scope violation: story touched src/core/alpha.ts outside its contract', 'scope violation: story touched src/core/beta.ts outside its contract'],
  // The same class through a REAL producer rather than an illustrative sentence,
  // with the cited path inside the 200-character prefix window.
  ['delivered C4 cited path in a blocking finding (machine.ts:756/1181)', 'delivered', citedPathInLastFinding('src/core/alpha.ts'), citedPathInLastFinding('src/core/beta.ts')],
  // ── DELIVERED: the signals-conditional prefix cut (C1c) ────────────────────
  // Both sides carry NO signal and are byte-identical for their first 200 normalized
  // characters, so only the relaxed signal-less bound can tell them apart. main's
  // unconditional 200-char cut collapses them.
  ['delivered C1c signal-less rejection diverging past char 200', 'delivered', scopeGateBlock('packages/main/src/core/alpha.ts'), scopeGateBlock('packages/main/src/core/beta.ts')],
  // ── VOLATILE: F-058, artifact ordinals and their indistinguishable twin ────
  // These four rows are the round-15 record of the withdrawn C3. The first is
  // codex's exact reproducer — an ordinary TAP subtest name in the raw output
  // core/machine.ts:1190 embeds — and the other three are REAL first-party artifact
  // renders. They are the same string shape, which is the whole finding, so they sit
  // in the same lane and all four must tie. Branch-finer on ANY of them means an
  // artifact-id rule is back in the normalizer.
  ['F-058 third-party TAP label bug-N (codex reproducer)', 'volatile', tap('bug-2 reproducer still red'), tap('bug-5 reproducer still red')],
  ['F-058 artifact ordinal BUG-NNN (machine.ts:1195)', 'volatile', unfixedBug('BUG-001'), unfixedBug('BUG-002')],
  ['F-058 artifact ordinal CHK-NNN space-delimited', 'volatile', 'verification gap: missing evidence coverage for CHK-001', 'verification gap: missing evidence coverage for CHK-002'],
  ['F-058 artifact ordinal CHK-NNN last in list (machine.ts:1169)', 'volatile', checklistPending(['CHK-009', 'CHK-001']), checklistPending(['CHK-009', 'CHK-002'])],
  // ── VOLATILE: re-minted bookkeeping ids ────────────────────────────────────
  // These would have to collapse even if an id rule ever came back, because the
  // remediation the rejection prints is exactly what renumbers them.
  ['volatile re-minted review loop RL-N', 'volatile', reviewLoop('RL-001'), reviewLoop('RL-002')],
  ['volatile re-minted init-check issue I-N', 'volatile', initIssue('I-1'), initIssue('I-2')],
  // ── VOLATILE: incidental noise ─────────────────────────────────────────────
  ['volatile bare attempt ordinal', 'volatile', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 41)'],
  ['volatile ISO timestamp', 'volatile', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)', 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 3)'],
  ['volatile hex digest', 'volatile', 'material digest mismatch a1b2c3d4e5f6789', 'material digest mismatch f6e5d4c3b2a1987'],
  ['volatile story-id digits (B-cc54 contract)', 'volatile', 'gate blocked for b-1234', 'gate blocked for b-5678'],
  ['volatile machine-absolute path', 'volatile', 'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate', 'validation lock held at /private/var/folders/zz/T/proof-or-stop-abc/.proof-or-stop/locks/validate'],
  ['volatile heartbeat age', 'volatile', 'B-bf52 is owned by session s1, heartbeat 45s ago', 'B-bf52 is owned by session s1, heartbeat 52s ago'],
  ['volatile lane counts', 'volatile', 'review assurance floor is unmet: 0/4 reviewer lanes have a current-round pass', 'review assurance floor is unmet: 1/4 reviewer lanes have a current-round pass'],
];

// ── the per-rejection cost lane ──────────────────────────────────────────────
// Built here rather than quoted in prose. The METHOD is the reproducible part; the
// absolute milliseconds are machine- and load-dependent and the output says so, so
// that a later reader compares ratios and re-runs rather than trusting a number.
//
// After F-058 the branch runs main's rule chain with ONE rule swapped, so the
// normalization itself is the same price. The remaining delta has ONE known source
// and it is worth naming so a later reader does not go looking for a phantom: this
// fixture is signal-less and 16,384 characters, so the signals-conditional cut hands
// the whole reason to sha1 where main hands it 200 characters. That is the measured
// cost of C1c, not an artifact of the normalizer, and it is bounded by design — the
// 16,384 ceiling exists precisely so a pathological embedded transcript stays cheap.
// Through round 14 this lane existed to price a whole-token walk that no longer runs.
const buildCostFixture = () => {
  const head = 'Cannot enter TEST: the scope gate is blocking for B-bf52. The story scope contract is in enforce mode, so every changed path must be '
    + 'declared by the contract, covered by a shared classifier rule, or carry an explicit acknowledgement that a reviewer can see. ';
  let body = '';
  let i = 0;
  while ((head + body).length < 16_384) {
    body += `not ok ${i} - packages/main/src/core/seg-${i}.ts CHK-0${i % 10} bug-${i} de-bug-${i} bug-fix-${i} timeout:bug-${i} B-bf52:F-0${i % 10} `;
    i += 1;
  }
  const reason = (head + body).slice(0, 16_384);
  assert.equal(reason.length, 16_384, 'cost fixture must be exactly 16384 characters');
  return reason;
};
const COST_REASON = buildCostFixture();
const COST_WARMUP = 200;
const COST_ITERS = 400;
const COST_REPS = 9;
const benchMedianMs = (mod) => {
  for (let k = 0; k < COST_WARMUP; k += 1) mod.gateFailureDigest(CMD, COST_REASON);
  const samples = [];
  for (let rep = 0; rep < COST_REPS; rep += 1) {
    const t0 = performance.now();
    for (let k = 0; k < COST_ITERS; k += 1) mod.gateFailureDigest(CMD, COST_REASON);
    samples.push((performance.now() - t0) / COST_ITERS);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], min: samples[0], max: samples[samples.length - 1] };
};
const fmt = (s) => `${s.median.toFixed(3)} ms/call (min ${s.min.toFixed(3)}, max ${s.max.toFixed(3)})`;

// ── run ──────────────────────────────────────────────────────────────────────
console.log('S3 DIFFERENTIAL PROBE — gateFailureDigest, branch vs a comparison build');
console.log(`  branch dist:     ${BRANCH_DIST}`);

let compare = null;
let skipReason = '';
if (!COMPARE_DIST) {
  skipReason = 'no comparison build was given';
} else if (!existsSync(`${COMPARE_DIST}/core/convergence-breaker.js`)) {
  skipReason = `the given path has no core/convergence-breaker.js: ${COMPARE_DIST}`;
} else {
  compare = await import(`${COMPARE_DIST}/core/convergence-breaker.js`);
  console.log(`  comparison dist: ${COMPARE_DIST}`);
}

let exitCode = 0;

// ── BAR 3: the ABSOLUTE check, run with or without a comparison build ────────
// It goes first because it is the one bar a differential comparison cannot make,
// and the one that catches the two rules this story actually ships being reverted.
const relBranch = (a, b) =>
  (branch.gateFailureDigest(CMD, a) === branch.gateFailureDigest(CMD, b) ? 'same' : 'differ');
let bar3 = 0;
let deliveredRows = 0;
console.log('\nBAR 3 — DELIVERED classes the branch must distinguish (absolute, no comparison needed):');
for (const [name, kind, a, b] of PAIRS) {
  if (!DELIVERED.has(kind)) continue;
  deliveredRows += 1;
  const rb = relBranch(a, b);
  if (rb === 'differ') {
    console.log(`  OK   branch distinguishes — ${name}`);
  } else {
    console.log(`  FAIL BAR 3 — branch COLLAPSES a class this story delivers: ${name}`);
    bar3 += 1;
  }
}
console.log(`  ${deliveredRows - bar3}/${deliveredRows} delivered classes distinguished, ${bar3} BAR 3 violations (must be 0)`);
if (bar3 > 0) exitCode = 1;

if (!compare) {
  console.log(`\n  comparison dist: (none)`);
  console.log(`SKIP differential lane — ${skipReason}.`);
  console.log('  The differential lane needs a SECOND build to compare against; it is skipped rather');
  console.log('  than failed so this file is runnable in a clean checkout. Pass one as argv[1] or in');
  console.log('  PROOF_OR_STOP_COMPARE_DIST. To produce one (detached: no branch is created or moved):');
  console.log('    git worktree add --detach /tmp/probe-main main');
  console.log('    ln -s "$PWD/node_modules" /tmp/probe-main/node_modules');
  console.log('    node_modules/.bin/tsc -p /tmp/probe-main/packages/main/tsconfig.json');
  console.log(`    node packages/main/tests/red/red-s3-differential-probe.mjs /tmp/probe-main/packages/main/dist`);
  console.log(`\n  (${PAIRS.length} pairs are defined; BAR 1 and BAR 2 were NOT evaluated.)`);
} else {
  const rel = (mod, a, b) =>
    (mod.gateFailureDigest(CMD, a) === mod.gateFailureDigest(CMD, b) ? 'same' : 'differ');
  let tied = 0;
  let finerOk = 0;
  let comparisonLeaks = 0;
  let bar1 = 0;
  let bar2 = 0;
  let bar1Eligible = 0;
  console.log('');
  for (const [name, kind, a, b] of PAIRS) {
    const rb = rel(branch, a, b);
    const rc = rel(compare, a, b);
    let verdict;
    if (rb === rc) {
      verdict = `OK   tie(${rb})`;
      tied += 1;
    } else if (rb === 'same' && rc === 'differ') {
      if (DELIVERED.has(kind)) {
        verdict = 'FAIL BAR 1 — branch COLLAPSES what the comparison DISTINGUISHES (delivered class)';
        bar1 += 1;
      } else {
        // The comparison keys apart on something a retry re-mints. That is the
        // comparison build leaking, not this one regressing — collapsing it is the
        // fail-safe direction for a brake.
        verdict = `OK   comparison LEAKS here (${kind}) and the branch does not`;
        comparisonLeaks += 1;
      }
    } else if (DELIVERED.has(kind)) {
      verdict = 'OK   branch finer on a class this story delivers';
      finerOk += 1;
    } else {
      verdict = `FAIL BAR 2 — branch DISTINGUISHES what it must not (${kind}: ${BAR2_REASON[kind] ?? 'the varying token is not retry-stable'})`;
      bar2 += 1;
    }
    if (rc === 'differ' && DELIVERED.has(kind)) bar1Eligible += 1;
    console.log(`  ${verdict}`);
    console.log(`       pair     ${name}`);
    console.log(`       kind     ${kind}   expected: ${EXPECT[kind]}`);
    console.log(`       observed branch=${rb}  comparison=${rc}`);
  }
  console.log(`\nDIFFERENTIAL TOTALS over ${PAIRS.length} pairs:`);
  console.log(`  ${tied} tie`);
  console.log(`  ${finerOk} branch-finer on a DELIVERED class (expected against main, which collapses all of them)`);
  console.log(`  ${comparisonLeaks} pairs where the COMPARISON build leaks (keys apart on something a retry re-mints) and this one does not`);
  console.log(`  ${bar1} BAR 1 violations (must be 0)`);
  console.log(`  ${bar2} BAR 2 violations (must be 0)`);
  // Do not let a vacuous zero read as evidence. BAR 1 can only fire on a pair the
  // COMPARISON build distinguishes on a DELIVERED class, so if the comparison
  // collapses every such pair, its zero is arithmetically true and empty. Against
  // `main` that is exactly the situation — main collapses every class this story
  // delivers, which is why the story exists — so BAR 2 and BAR 3 are the
  // load-bearing results there. Saying so is the same discipline that caught
  // `bcc54-cross-vendor-noise` guarding a fold it never reached.
  if (bar1Eligible === 0) {
    console.log('\n  CAVEAT — BAR 1 IS VACUOUS AGAINST THIS COMPARISON BUILD. It distinguishes 0 of the');
    console.log(`  ${PAIRS.length} pairs on a delivered class, so no pair COULD have violated BAR 1 and the`);
    console.log('  zero above proves nothing. Read BAR 2 and BAR 3 as the load-bearing results here. BAR 1');
    console.log('  becomes a real check only against a comparison build that is finer where it is entitled to be.');
  } else {
    console.log(`\n  (BAR 1 is non-vacuous here: the comparison distinguishes ${bar1Eligible} of ${PAIRS.length} pairs on a delivered class.)`);
  }
  if (bar1 > 0 || bar2 > 0) exitCode = 1;
}

console.log(`\nPER-REJECTION COST on a ${COST_REASON.length}-character reason `
  + `(${COST_REASON.split(/\s+/).length} whitespace tokens; ${COST_WARMUP} warm-up calls, `
  + `median of ${COST_REPS} reps x ${COST_ITERS} calls):`);
const bCost = benchMedianMs(branch);
console.log(`  branch      ${fmt(bCost)}`);
if (compare) {
  const cCost = benchMedianMs(compare);
  console.log(`  comparison  ${fmt(cCost)}`);
  console.log(`  ratio       ${(bCost.median / cCost.median).toFixed(2)}x, delta ${(bCost.median - cCost.median).toFixed(3)} ms per rejection`);
}
console.log('  NOTE: absolute milliseconds are machine- and load-dependent, so quote the RATIO and');
console.log('        the command, not the number. One reason is digested per REFUSED story_advance,');
console.log('        so this is a per-rejection cost and not a per-command one.');

console.log(exitCode === 0
  ? '\nS3 DIFFERENTIAL PROBE: PASS'
  : '\nS3 DIFFERENTIAL PROBE: FAIL — see the BAR lines above');
process.exit(exitCode);
