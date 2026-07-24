#!/usr/bin/env node
/**
 * DIFFERENTIAL PROBE for B-bf52 (F-052, F-053, F-054): this branch's
 * `gateFailureDigest` against a SEPARATELY BUILT comparison normalizer — normally
 * a freshly built `main`.
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
 * ── THIS PROBE HAS PASSED TWICE DURING A LIVE REGRESSION (F-053, F-054) ──────
 *
 * Stated plainly and first, rather than folded into a changelog, because it is
 * the same defect class the probe exists to catch — and it has now happened
 * TWICE, each time because a manufacture vector was missing from the matrix
 * below. Each miss added the missing vector; nothing else about the probe
 * changed, which is the honest summary of what this file's history proves about
 * green runs of it.
 *
 *   round 11  The matrix PASSED while `(bug-2` and `(bug-5` — a NON-id token in
 *             an UNMATCHED opening paren — digested APART on this branch and
 *             COLLAPSED on main. Cause: every wrapper in the matrix was BALANCED
 *             (`[CHK-001]`, `"CHK-001"`, `(CHK-001).`, `|bug-N|`, `%bug-N%`), so
 *             the matrix could not express the defect. Repair: the four
 *             `F-053 …` unmatched-wrapper rows.
 *   round 12  The matrix PASSED again while `bug-2:` and `bug-5:` — an ordinary
 *             TAP subtest name whose trailing colon the round-12 sentence strip
 *             removed unconditionally — digested APART on this branch and
 *             COLLAPSED on main. Cause: no row in the matrix ended in a STRIPPED
 *             PUNCTUATION CHARACTER, so again the matrix could not express the
 *             defect. Repair: the `F-054 …` rows, which carry a non-id body
 *             ending in EACH character the deleted strip removed.
 *
 * A probe whose matrix cannot express the defect it exists to catch is not a
 * guard against that defect — it is the same failure as an evidence note that
 * restates a claim instead of proving it, and it is worse than having no probe,
 * because it reads as a measurement. So the way to check that a repair is real is
 * to make the defect again: restore the reduction in a scratch copy of the
 * normalizer and confirm this script FAILS on exactly the rows that name it. A
 * probe that has never been observed red on the defect is exactly the thing this
 * paragraph is about.
 *
 * THE F-054 DEMONSTRATION, RUN AND RECORDED. Restore the round-12 sentence strip
 * `[,;:.!?]+$` in front of the whole-token test in an ISOLATED copy of the built
 * normalizer (a detached worktree's dist, so nothing in the story worktree moves),
 * point LATTICE_DIST at it and run this script against a freshly built main. The
 * observed result, which is what a repaired matrix has to look like:
 *
 *   exit code 1, 0 BAR 1 violations, 8 BAR 2 violations, on exactly the eight rows
 *   whose body ends in a stripped character — `bug-N:`, `bug-N,`, `bug-N.`,
 *   `bug-N;`, `bug-N!`, `bug-N?`, `bug-N:.` and `chk-NNN:` — plus 4 WARN rows
 *   reporting that the F-054 accepted cost has stopped being paid
 *   (`CHK-NNN` comma-attached, `CHK-NNN` semicolon-attached, and the two `SEP-…`
 *   renders). No other row moves: the unbalanced-wrapper and leading-punctuation
 *   rows stay tied, because a trailing strip does not reach them.
 *
 * Run the round-12 reduction IN FULL (sentence strip then balanced peel) and the
 * wrapper rows join them. The two demonstrations together are why the matrix below
 * is believed to express this defect class, rather than assumed to.
 *
 * It is the companion of red-s3-digest-collapse.mjs. That harness asserts an
 * ABSOLUTE contract (these classes must key apart, those must collapse). This one
 * asserts a RELATIVE one: whatever the branch does, it must not be worse than the
 * comparison build, in either of the two directions that matter for a breaker.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   # branch-only: prints the per-rejection cost, SKIPS the differential lane
 *   node packages/main/tests/red/red-s3-differential-probe.mjs
 *
 *   # full: differential lane against a comparison build
 *   node packages/main/tests/red/red-s3-differential-probe.mjs /path/to/main/packages/main/dist
 *   LATTICE_COMPARE_DIST=/path/to/main/packages/main/dist \
 *     node packages/main/tests/red/red-s3-differential-probe.mjs
 *
 *   # the branch build under test can be pointed elsewhere too
 *   LATTICE_DIST=/path/to/a/build/packages/main/dist node ... red-s3-differential-probe.mjs
 *
 * To produce a comparison build (a detached worktree keeps the story worktree
 * clean, and `--detach` means no branch is created or moved):
 *
 *   git worktree add --detach /tmp/probe-main main
 *   ln -s "$PWD/node_modules" /tmp/probe-main/node_modules
 *   node_modules/.bin/tsc -p /tmp/probe-main/packages/main/tsconfig.json
 *
 * ── THE BAR (both directions must be zero) ───────────────────────────────────
 *
 *   BAR 1  zero pairs where the BRANCH COLLAPSES what the COMPARISON
 *          DISTINGUISHES ON A RETRY-STABLE ORDINAL. That is the branch being
 *          strictly coarser: a real distinction the comparison build could see and
 *          this one cannot.
 *
 *          The qualification is load-bearing and was added after measuring the
 *          unqualified form. Comparing this branch against round 10 of ITSELF, the
 *          unqualified BAR 1 fired twice — on `timeout:bug-N` and `x:chk-NNN`,
 *          where round 10 keyed apart because of the very leak F-052 removed. The
 *          branch collapsing those is CORRECT, and scoring it as a violation would
 *          make the probe demand that every future build preserve its
 *          predecessor's bugs. A distinction the comparison draws on an ordinal
 *          that a retry re-mints is the comparison's defect, not this build's
 *          obligation, so BAR 1 is restricted to the kinds where distinguishing is
 *          legitimate and those rows are reported as the comparison leaking.
 *   BAR 2  zero pairs where the BRANCH DISTINGUISHES an ordinal that is NOT
 *          RETRY-STABLE. This is the direction that matters most and the one
 *          rounds 7-11 leaked four times: if a rejection keys apart on an ordinal
 *          that the retry it asks for RE-MINTS, a stuck agent mints a fresh key on
 *          every attempt and the breaker never trips. For a circuit breaker,
 *          firing too early is a false freeze; never firing is the unbounded loop
 *          the module exists to stop.
 *
 * Every pair therefore carries the DIRECTION EXPECTED of it, and the report prints
 * that expectation next to what was observed.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BRANCH_DIST = process.env.LATTICE_DIST || new URL('../../dist', import.meta.url).pathname;
const COMPARE_DIST = process.argv[2] || process.env.LATTICE_COMPARE_DIST || '';
const CMD = 'story_advance';

const branch = await import(`${BRANCH_DIST}/core/convergence-breaker.js`);

// ── producers, quoted as they render ─────────────────────────────────────────
// Every fixture below is composed from a REAL story_advance rejection site, not
// invented; the file:line citations are in tasks/convergence-breaker-smoke.ts
// next to the matrix case each pair mirrors.
const tap = (line) =>
  `Cannot enter DONE: test FAIL: # tests 1\n# pass 0\n# fail 1\nnot ok 1 - ${line}`;
const blockingFinding = (o) =>
  `Cannot enter TEST: 1 open blocking finding(s): B-bf52:${o} [high] the substantive-id guard admits a non-id [review_finding_blocking]`;
const intentRef = (r) =>
  `Cannot enter REVIEW: 1 required verification intent(s) lack passing evidence or waiver:\n  - ${r} [missing] the acceptance check has no passing evidence`;
const checklistPending = (ids) =>
  `Cannot enter REVIEW: ${ids.length} checklist item(s) not done: ${ids.join(', ')}`;
const sepPending = (ids) =>
  `Cannot enter INIT_CHECK: ${ids.length} scope extension proposal(s) are still pending: ${ids.join(', ')}. [scope_extension_proposal_pending]`;
const excludedKeyword = (id) =>
  `Cannot enter INIT_CHECK: excluded scope keyword "quantum" appears in checklist (${id}). [excluded_keyword]`;
const twoFindings = (citedItemId) =>
  `Cannot enter TEST: 2 open blocking finding(s): B-bf52:F-012 [high] no passing evidence for ${citedItemId}; B-bf52:F-013 [high] the second blocker is held constant [review_finding_blocking]`;
const staleRun = (o) =>
  `Cannot enter TEST: pass B-bf52:RP-001 bound reviewRunId B-bf52:${o} is stale: HEAD moved since the run was started.`;
const reviewLoop = (o) =>
  `Cannot enter TEST: active review loop(s): loopId=B-bf52:${o}, decision=revise [open_review_loop]`;
const initIssue = (i) =>
  `Cannot enter INIT_CHECK: init-check reviewer recorded high/critical issues.\n  - product-reviewer: high ${i} the story boundary is not decidable`;
const unfixedBug = (id) => `Cannot enter DONE: 1 unfixed bug(s): ${id}`;
const unfixedBugs = (ids) => `Cannot enter DONE: ${ids.length} unfixed bug(s): ${ids.join(', ')}`;
// core/machine.ts:753-756 renders every open blocking finding and :1181 appends the
// bracketed reason code, so an id cited at the end of the LAST description is BARE.
const citedInLastFinding = (citedItemId) =>
  `Cannot enter TEST: 1 open blocking finding(s): B-bf52:F-012 [high] no passing verification evidence for ${citedItemId} [review_finding_blocking]`;
// core/proofstory.ts:1026, surfaced as one diagnostic gap line by the DEV gate. The
// id is COMMA-attached in the render, which is why it is an F-054 cost row.
const requirementGap = (requirementId) =>
  `Cannot enter DEV: ProofStory DEV gate is enforce and required intent artifacts are incomplete.\n`
  + `Diagnostic gaps (1):\n`
  + `  - milestone_source_requirement_unbound [warn; milestone-ledger.json]: M1 references sourceRequirementId ${requirementId}, which is not in original intent keyRequirementIds.`;

/**
 * KINDS, and the direction each expects.
 *
 *   bare-id           a BARE lifecycle artifact id (bug/chk/f/req/sep) varies as
 *                     the WHOLE whitespace-delimited token, in a position this
 *                     tree really renders. Retry-stable: the id names WHICH
 *                     artifact must be fixed and survives the retry. The branch MAY
 *                     be finer than the comparison here, and on main it will be,
 *                     because main rewrites every ordinal. After F-054 this is the
 *                     ONLY kind on which the branch beats main, so these rows are
 *                     what make "the cost is bounded" a measurement.
 *   pathish           a path or phase token varies (the C2/C4 classes). Also a
 *                     legitimate place for the branch to be finer.
 *   cost-composite    a REAL first-party COLON composite (`B-bf52:F-012`,
 *                     `CHK-001:happy:0`) whose varying ordinal IS retry-stable.
 *                     Distinguishing it would not be unsafe — it is simply not
 *                     reachable without interior `:` structure in the id pattern,
 *                     and F-052 measured that such structure admits arbitrary
 *                     non-ids. So the branch ACCEPTS collapsing these and ties with
 *                     the comparison. Reported in its own column: a divergence here
 *                     means the accepted cost stopped being paid (the qualifier is
 *                     back), which is a design regression the matrix case
 *                     `open-blocking-finding-composite-id` fails on — it is NOT one
 *                     of the two bars, and this script does not double-count it.
 *   cost-attached     the F-054 ACCEPTED COST, and the new one. A REAL artifact id
 *                     with punctuation ATTACHED — `(CHK-001).` from
 *                     core/machine.ts:204, `CHK-001,` from the list join at :1169,
 *                     `SEP-B-bf52-001.` from :273, `CHK-001;` from the `'; '` join
 *                     at :756, and bracketed/quoted/parenthesised ids in embedded
 *                     test output. Round 12 protected these with a punctuation
 *                     strip; that strip is the step every manufacture vector needs,
 *                     so it is deleted and these now tie with main. Same reporting
 *                     rule as cost-composite: branch-finer here is a WARN (the cost
 *                     stopped being paid), not a bar, because the matrix cases
 *                     tagged `substantive-id-no-reduction` are what fail.
 *   forged-composite  a colon-joined NON-id, e.g. codex's `timeout:bug-2`. Must tie.
 *   welded            an artifact id welded into a larger token. Must tie.
 *   manufactured-by-reduction
 *                     THE CLASS THIS STORY KEEPS BEING BROKEN BY. A token that is
 *                     NOT an artifact id, but that some REDUCTION applied before
 *                     the whole-token test would turn into one: an unbalanced
 *                     wrapper (`(bug-2`, `bug-2)`, `(bug-2]`, `"bug-2` — F-053) or
 *                     a body ending in a stripped punctuation character (`bug-2:`,
 *                     `bug-2,`, `bug-2.`, and the rest of the round-12 class —
 *                     F-054). Every one of these is ordinary raw test output, which
 *                     core/machine.ts:1190 embeds verbatim, and main collapses all
 *                     of them. Must tie; branch-finer is BAR 2, because it means a
 *                     reduction is back and a stuck agent can mint a fresh key on
 *                     every retry. It replaces the round-12 `unmatched-wrapper`
 *                     kind, which named only half the class.
 *   volatile          nothing substantive varies (timestamps, hashes, attempt
 *                     counts, story-id digits, re-minted bookkeeping ids). Must tie.
 */
/**
 * The kinds on which DISTINGUISHING is legitimate, i.e. whose varying ordinal
 * survives the retry the rejection asks for. Only these can trigger BAR 1 (the
 * branch is not obliged to preserve a distinction the comparison draws on an
 * ordinal a retry re-mints), and only these may be branch-finer without
 * triggering BAR 2.
 */
const RETRY_STABLE = new Set(['bare-id', 'pathish']);

/** The kinds whose divergence is a recorded design decision, not one of the bars. */
const ACCEPTED_COST = new Set(['cost-composite', 'cost-attached']);

const EXPECT = {
  'bare-id': 'tie or branch-finer',
  pathish: 'tie or branch-finer',
  'cost-composite': 'tie (accepted cost)',
  'cost-attached': 'tie (accepted cost)',
  'forged-composite': 'tie (must not be finer)',
  welded: 'tie (must not be finer)',
  'manufactured-by-reduction': 'tie (must not be finer)',
  volatile: 'tie (must not be finer)',
};

const PAIRS = [
  // ── F-052: codex's forged pair and the three colon composites ──────────────
  ['F-052 forged label qualifier timeout:bug-N (codex)', 'forged-composite', tap('timeout:bug-2 reproducer still red'), tap('timeout:bug-5 reproducer still red')],
  ['F-052 real PREFIX composite B-bf52:F-NNN', 'cost-composite', blockingFinding('F-012'), blockingFinding('F-013')],
  ['F-052 real SUFFIX composite CHK-NNN:lane:idx', 'cost-composite', intentRef('CHK-001:happy:0'), intentRef('CHK-002:happy:0')],
  ['F-052 repeated qualifier a:b:bug-N', 'forged-composite', tap('a:b:bug-2 reproducer still red'), tap('a:b:bug-5 reproducer still red')],
  ['F-052 trailing colon label bug-N:timeout', 'forged-composite', tap('bug-2:timeout reproducer still red'), tap('bug-5:timeout reproducer still red')],
  ['F-052 label-qualified chk x:chk-NNN', 'forged-composite', tap('x:chk-001 has no evidence'), tap('x:chk-002 has no evidence')],
  // ── F-043 (round 7): hyphen-joined HEADS ───────────────────────────────────
  ['F-043 hyphen head de-bug-N', 'welded', tap('de-bug-2 reproducer still red'), tap('de-bug-7 reproducer still red')],
  ['F-043 hyphen head scenario-f-N', 'welded', tap('scenario-f-2 rejects an unsigned receipt'), tap('scenario-f-5 rejects an unsigned receipt')],
  ['F-043 hyphen head over-req-N', 'welded', tap('over-req-3 milestone binding'), tap('over-req-9 milestone binding')],
  // ── F-048 (round 8): slash HEAD and DOUBLED prefix ─────────────────────────
  ['F-048a slash head scenario/bug-N', 'welded', tap('scenario/bug-2 still red'), tap('scenario/bug-5 still red')],
  ['F-048a slash head suite/req-N', 'welded', tap('suite/req-2 binding'), tap('suite/req-5 binding')],
  ['F-048b doubled prefix BUG-BUG-N', 'welded', tap('BUG-BUG-2 reproducer still red'), tap('BUG-BUG-5 reproducer still red')],
  ['F-048b doubled prefix CHK-CHK-N', 'welded', tap('CHK-CHK-2 still red'), tap('CHK-CHK-5 still red')],
  // ── F-051 (round 9): welded TAILS ──────────────────────────────────────────
  ['F-051 letter tail bug-Nx', 'welded', tap('bug-2x reproducer still red'), tap('bug-5x reproducer still red')],
  ['F-051 slash tail bug-N/x', 'welded', tap('bug-2/x reproducer still red'), tap('bug-5/x reproducer still red')],
  ['F-051 dot tail bug-N.x', 'welded', tap('bug-2.x reproducer still red'), tap('bug-5.x reproducer still red')],
  ['F-051 hyphen tail bug-N-x', 'welded', tap('bug-2-x reproducer still red'), tap('bug-5-x reproducer still red')],
  ['F-051 non-ascii tail bug-Ne-acute', 'welded', tap('bug-2é reproducer still red'), tap('bug-5é reproducer still red')],
  // ── other welding characters, probed rather than assumed ───────────────────
  // The enumeration era failed four times because its author listed the characters
  // he had thought of. These rows are here so the whole-token claim is tested
  // against characters nobody enumerated, including non-ascii and shell metachars.
  ['welded underscore head suite_bug-N', 'welded', tap('suite_bug-2 still red'), tap('suite_bug-5 still red')],
  ['welded underscore tail bug-N_x', 'welded', tap('bug-2_x still red'), tap('bug-5_x still red')],
  ['welded equals head itemId=CHK-NNN', 'welded', 'Cannot enter REVIEW: itemId=CHK-001 has no evidence', 'Cannot enter REVIEW: itemId=CHK-002 has no evidence'],
  ['welded equals tail bug-N=x', 'welded', tap('bug-2=x still red'), tap('bug-5=x still red')],
  ['welded hash head #bug-N', 'welded', tap('#bug-2 still red'), tap('#bug-5 still red')],
  ['welded at head @bug-N', 'welded', tap('@bug-2 still red'), tap('@bug-5 still red')],
  ['welded backslash head x\\bug-N', 'welded', tap('x\\bug-2 still red'), tap('x\\bug-5 still red')],
  ['welded plus tail bug-N+x', 'welded', tap('bug-2+x still red'), tap('bug-5+x still red')],
  ['welded tilde head ~bug-N', 'welded', tap('~bug-2 still red'), tap('~bug-5 still red')],
  ['welded pipe wrap |bug-N|', 'welded', tap('|bug-2| still red'), tap('|bug-5| still red')],
  ['welded percent wrap %bug-N%', 'welded', tap('%bug-2% still red'), tap('%bug-5% still red')],
  ['welded ampersand head &bug-N', 'welded', tap('&bug-2 still red'), tap('&bug-5 still red')],
  ['welded star wrap *bug-N*', 'welded', tap('*bug-2* still red'), tap('*bug-5* still red')],
  ['welded non-ascii head e-acute-bug-N', 'welded', tap('ébug-2 still red'), tap('ébug-5 still red')],
  ['welded colon-equals loopId=B-bf52:RL-NNN', 'welded', reviewLoop('RL-001'), reviewLoop('RL-002')],
  ['welded colon reviewRunId B-bf52:RR-NNN', 'welded', staleRun('RR-002'), staleRun('RR-003')],
  // ── F-053 (round 12): UNMATCHED wrappers, and the rows round 11 lacked ─────
  // Every wrapper row in round 11's matrix was BALANCED, which is why it passed
  // while `(bug-2` leaked. These four are the unbalanced shapes.
  ['F-053 unmatched OPEN paren (bug-N', 'manufactured-by-reduction', tap('(bug-2 reproducer still red'), tap('(bug-5 reproducer still red')],
  ['F-053 unmatched CLOSE paren bug-N)', 'manufactured-by-reduction', tap('bug-2) reproducer still red'), tap('bug-5) reproducer still red')],
  ['F-053 MISMATCHED pair (bug-N]', 'manufactured-by-reduction', tap('(bug-2] reproducer still red'), tap('(bug-5] reproducer still red')],
  ['F-053 unmatched OPEN quote "bug-N', 'manufactured-by-reduction', tap('"bug-2 reproducer still red'), tap('"bug-5 reproducer still red')],
  // ── F-054 (round 13): a non-id body ending in EACH stripped character ──────
  // The rows round 12's matrix lacked, and the reason it passed while `bug-2:`
  // leaked: not one row in it ended in a character the sentence strip removed. The
  // first three are the characters F-055 requires by name; the rest complete the
  // round-12 class `[,;:.!?]` so no member of it can be re-introduced quietly, and
  // the two leading-punctuation rows cover the same manufacture from the head.
  //
  // Each is an ordinary TAP subtest name. `bug-2:` is a case label followed by a
  // colon, `bug-2,` an entry in a list of test names, `bug-2.` a sentence-final
  // one — core/machine.ts:1190 embeds this output raw, and main collapses all of
  // them. Distinguishing any is BAR 2.
  ['F-054 trailing COLON name bug-N:', 'manufactured-by-reduction', tap('bug-2: reproducer still red'), tap('bug-5: reproducer still red')],
  ['F-054 trailing COMMA name bug-N,', 'manufactured-by-reduction', tap('bug-2, reproducer still red'), tap('bug-5, reproducer still red')],
  ['F-054 trailing PERIOD name bug-N.', 'manufactured-by-reduction', tap('bug-2. reproducer still red'), tap('bug-5. reproducer still red')],
  ['F-054 trailing SEMICOLON name bug-N;', 'manufactured-by-reduction', tap('bug-2; reproducer still red'), tap('bug-5; reproducer still red')],
  ['F-054 trailing BANG name bug-N!', 'manufactured-by-reduction', tap('bug-2! reproducer still red'), tap('bug-5! reproducer still red')],
  ['F-054 trailing QUESTION name bug-N?', 'manufactured-by-reduction', tap('bug-2? reproducer still red'), tap('bug-5? reproducer still red')],
  ['F-054 trailing colon+period name bug-N:.', 'manufactured-by-reduction', tap('bug-2:. reproducer still red'), tap('bug-5:. reproducer still red')],
  ['F-054 trailing punct on a CHK body chk-NNN:', 'manufactured-by-reduction', tap('chk-001: has no evidence'), tap('chk-002: has no evidence')],
  ['F-054 leading bracket only [bug-N', 'manufactured-by-reduction', tap('[bug-2 reproducer still red'), tap('[bug-5 reproducer still red')],
  ['F-054 leading brace only {bug-N', 'manufactured-by-reduction', tap('{bug-2 reproducer still red'), tap('{bug-5 reproducer still red')],
  ['F-054 leading angle only <bug-N', 'manufactured-by-reduction', tap('<bug-2 reproducer still red'), tap('<bug-5 reproducer still red')],
  ['F-054 leading single-quote only \'bug-N', 'manufactured-by-reduction', tap("'bug-2 reproducer still red"), tap("'bug-5 reproducer still red")],
  // ── The F-054 ACCEPTED COST: real ids with punctuation attached ────────────
  // Round 12 protected every one of these; they now tie with main. Kept as rows,
  // rather than deleted with the strip, so the cost is measured on every run
  // instead of asserted in prose — and so that a build which is FINER here is
  // reported as "the accepted cost is not being paid", which is what a
  // re-introduced reduction looks like from this side.
  ['F-054 cost balanced paren (bug-N)', 'cost-attached', tap('(bug-2) reproducer still red'), tap('(bug-5) reproducer still red')],
  ['F-054 cost balanced paren + comma (bug-N),', 'cost-attached', tap('(bug-2), reproducer still red'), tap('(bug-5), reproducer still red')],
  ['F-054 cost balanced bracket [bug-N]', 'cost-attached', tap('[bug-2] reproducer still red'), tap('[bug-5] reproducer still red')],
  ['F-054 cost balanced quotes "bug-N"', 'cost-attached', tap('"bug-2" reproducer still red'), tap('"bug-5" reproducer still red')],
  ['F-054 cost CHK-NNN comma-attached (machine.ts:1169)', 'cost-attached', checklistPending(['CHK-001', 'CHK-009']), checklistPending(['CHK-002', 'CHK-009'])],
  ['F-054 cost CHK-NNN parenthesized + period (machine.ts:204)', 'cost-attached', excludedKeyword('CHK-001'), excludedKeyword('CHK-002')],
  ['F-054 cost CHK-NNN bracketed', 'cost-attached', tap('[CHK-001] has no passing verification evidence'), tap('[CHK-002] has no passing verification evidence')],
  ['F-054 cost CHK-NNN double-quoted', 'cost-attached', tap('"CHK-001" is not waived'), tap('"CHK-002" is not waived')],
  ['F-054 cost CHK-NNN semicolon-attached (machine.ts:756)', 'cost-attached', twoFindings('CHK-001'), twoFindings('CHK-002')],
  ['F-054 cost SEP compound sentence-final period (machine.ts:273)', 'cost-attached', sepPending(['SEP-B-bf52-001']), sepPending(['SEP-B-bf52-002'])],
  ['F-054 cost SEP compound comma-attached (machine.ts:273)', 'cost-attached', sepPending(['SEP-B-bf52-001', 'SEP-B-bf52-009']), sepPending(['SEP-B-bf52-002', 'SEP-B-bf52-009'])],
  ['F-054 cost REQ-NNN comma-attached (proofstory.ts:1026)', 'cost-attached', requirementGap('REQ-001'), requirementGap('REQ-002')],
  // ── BARE ids in every real delimiter position (the BOUND on both costs) ────
  // If the cost were unbounded — if artifact ids had simply stopped being
  // protected — these rows would tie too. They are what makes "only BARE ids beat
  // main, and they still do" a measurement instead of an assurance. Every one is a
  // position a real producer in this tree renders, or the raw-test-output channel
  // core/machine.ts:1190 embeds.
  ['bare CHK-NNN space-delimited', 'bare-id', 'verification gap: missing evidence coverage for CHK-001', 'verification gap: missing evidence coverage for CHK-002'],
  ['bare CHK-NNN at reason start', 'bare-id', 'CHK-001 has no passing verification evidence [verification_evidence_missing]', 'CHK-002 has no passing verification evidence [verification_evidence_missing]'],
  ['bare F-NNN space-delimited', 'bare-id', 'review blocker: finding F-012 is still open and unresolved', 'review blocker: finding F-013 is still open and unresolved'],
  ['bare BUG-NNN after colon-space (machine.ts:1195)', 'bare-id', unfixedBug('BUG-001'), unfixedBug('BUG-002')],
  ['bare BUG-NNN last in list (machine.ts:1195)', 'bare-id', unfixedBugs(['BUG-009', 'BUG-001']), unfixedBugs(['BUG-009', 'BUG-002'])],
  ['bare CHK-NNN last in list (machine.ts:1169)', 'bare-id', checklistPending(['CHK-009', 'CHK-001']), checklistPending(['CHK-009', 'CHK-002'])],
  ['bare CHK-NNN cited before the reason code (machine.ts:756/1181)', 'bare-id', citedInLastFinding('CHK-001'), citedInLastFinding('CHK-002')],
  ['bare SEP compound in raw test output', 'bare-id', tap('SEP-B-bf52-001 was never decided before the freeze check'), tap('SEP-B-bf52-002 was never decided before the freeze check')],
  ['bare REQ-NNN in raw test output', 'bare-id', tap('REQ-001 milestone binding'), tap('REQ-002 milestone binding')],
  // ── retry-volatile shapes: must tie ────────────────────────────────────────
  ['volatile bare attempt ordinal', 'volatile', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 41)'],
  ['volatile ISO timestamp', 'volatile', 'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)', 'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 3)'],
  ['volatile hex digest', 'volatile', 'material digest mismatch a1b2c3d4e5f6789', 'material digest mismatch f6e5d4c3b2a1987'],
  ['volatile story-id digits (B-cc54 contract)', 'volatile', 'gate blocked for b-1234', 'gate blocked for b-5678'],
  ['volatile machine-absolute path', 'volatile', 'validation lock held at /Users/jek/Documents/Work/proofbound/.lattice/locks/validate', 'validation lock held at /private/var/folders/zz/T/lattice-abc/.lattice/locks/validate'],
  ['volatile heartbeat age', 'volatile', 'B-bf52 is owned by session s1, heartbeat 45s ago', 'B-bf52 is owned by session s1, heartbeat 52s ago'],
  ['volatile lane counts', 'volatile', 'review assurance floor is unmet: 0/4 reviewer lanes have a current-round pass', 'review assurance floor is unmet: 1/4 reviewer lanes have a current-round pass'],
  ['volatile re-minted init-check issue I-N', 'volatile', initIssue('I-1'), initIssue('I-2')],
  // ── paths and phases: where the branch is legitimately finer ───────────────
  ['pathish phase pair DEV/REVIEW vs DEV/TEST', 'pathish', 'transition refused: phase DEV/REVIEW is blocked by an unmet gate', 'transition refused: phase DEV/TEST is blocked by an unmet gate'],
  ['pathish in-repo file path', 'pathish', 'scope violation: story touched src/core/alpha.ts outside its contract', 'scope violation: story touched src/core/beta.ts outside its contract'],
];

// ── the per-rejection cost lane ──────────────────────────────────────────────
// Built here rather than quoted in prose. The METHOD is the reproducible part; the
// absolute milliseconds are machine- and load-dependent and the output says so, so
// that a later reader compares ratios and re-runs rather than trusting a number.
const buildCostFixture = () => {
  const head = 'Cannot enter TEST: the scope gate is blocking for B-bf52. The story scope contract is in enforce mode, so every changed path must be '
    + 'declared by the contract, covered by a shared classifier rule, or carry an explicit acknowledgement that a reviewer can see. ';
  let body = '';
  let i = 0;
  while ((head + body).length < 16_384) {
    body += `not ok ${i} - packages/main/src/core/seg-${i}.ts CHK-0${i % 10} bug-${i} de-bug-${i} timeout:bug-${i} B-bf52:F-0${i % 10} `;
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
if (!compare) {
  console.log(`  comparison dist: (none)\n`);
  console.log(`SKIP differential lane — ${skipReason}.`);
  console.log('  The differential lane needs a SECOND build to compare against; it is skipped rather');
  console.log('  than failed so this file is runnable in a clean checkout. Pass one as argv[1] or in');
  console.log('  LATTICE_COMPARE_DIST. To produce one (detached: no branch is created or moved):');
  console.log('    git worktree add --detach /tmp/probe-main main');
  console.log('    ln -s "$PWD/node_modules" /tmp/probe-main/node_modules');
  console.log('    node_modules/.bin/tsc -p /tmp/probe-main/packages/main/tsconfig.json');
  console.log(`    node packages/main/tests/red/red-s3-differential-probe.mjs /tmp/probe-main/packages/main/dist`);
  console.log(`\n  (${PAIRS.length} pairs are defined and were NOT evaluated.)`);
} else {
  const rel = (mod, a, b) =>
    (mod.gateFailureDigest(CMD, a) === mod.gateFailureDigest(CMD, b) ? 'same' : 'differ');
  let tied = 0;
  let finerOk = 0;
  let costUnpaid = 0;
  let costPaid = 0;
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
    } else if (ACCEPTED_COST.has(kind)) {
      // Checked BEFORE the bars, in BOTH directions, because these kinds are the
      // one place a divergence is a recorded design decision rather than a defect.
      // Against `main` this never fires (main collapses these too). Against a build
      // that still HAS interior `:` structure (round 10) or a punctuation strip
      // (rounds 9-12), branch=same/comparison=differ is exactly the accepted cost
      // being paid, and scoring it as BAR 1 would turn the intended change into a
      // failure.
      const what = kind === 'cost-composite'
        ? 'a REAL colon composite (F-052)'
        : 'a REAL id with punctuation ATTACHED (F-054)';
      verdict = rb === 'differ'
        ? `WARN branch finer on ${what} — the accepted cost is NOT being paid`
        : `OK   accepted cost — branch collapses ${what} the comparison keeps`;
      if (rb === 'differ') costUnpaid += 1; else costPaid += 1;
    } else if (rb === 'same' && rc === 'differ') {
      if (RETRY_STABLE.has(kind)) {
        verdict = 'FAIL BAR 1 — branch COLLAPSES what the comparison DISTINGUISHES (retry-stable)';
        bar1 += 1;
      } else {
        // The comparison keys apart on an ordinal a retry re-mints. That is the
        // comparison build leaking, not this one regressing — collapsing it is the
        // fail-safe direction and the whole point of the whole-token rule.
        verdict = `OK   comparison LEAKS here (${kind}) and the branch does not`;
        comparisonLeaks += 1;
      }
    } else if (RETRY_STABLE.has(kind)) {
      verdict = 'OK   branch finer on a retry-stable bare id';
      finerOk += 1;
    } else {
      verdict = `FAIL BAR 2 — branch DISTINGUISHES a non-retry-stable ordinal (${kind})`;
      bar2 += 1;
    }
    if (rc === 'differ' && RETRY_STABLE.has(kind)) bar1Eligible += 1;
    console.log(`  ${verdict}`);
    console.log(`       pair     ${name}`);
    console.log(`       kind     ${kind}   expected: ${EXPECT[kind]}`);
    console.log(`       observed branch=${rb}  comparison=${rc}`);
  }
  console.log(`\nDIFFERENTIAL TOTALS over ${PAIRS.length} pairs:`);
  console.log(`  ${tied} tie`);
  console.log(`  ${finerOk} branch-finer on a retry-stable BARE artifact id (expected, and the BOUND on both costs)`);
  console.log(`  ${costPaid} accepted-cost pairs where the comparison keeps a colon composite or an attached id and the branch does not`);
  console.log(`  ${costUnpaid} branch-finer on an accepted-cost pair  (F-052/F-054 expect 0; a WARN, not a bar — the`);
  console.log('        matrix cases open-blocking-finding-composite-id and the substantive-id-no-reduction group');
  console.log('        in tasks/convergence-breaker-smoke.ts are what fail if a cost stops being paid, so this');
  console.log('        script does not double-count them)');
  console.log(`  ${comparisonLeaks} pairs where the COMPARISON build leaks (keys apart on a re-minted ordinal) and this one does not`);
  console.log(`  ${bar1} BAR 1 violations (must be 0)`);
  console.log(`  ${bar2} BAR 2 violations (must be 0)`);
  // Do not let a vacuous zero read as evidence. BAR 1 can only fire on a pair the
  // COMPARISON build distinguishes on a RETRY-STABLE ordinal, so if the comparison
  // collapses every such pair, its zero is arithmetically true and empty. Against
  // `main` that is exactly the situation — main rewrites every ordinal to `#` — so
  // BAR 2 is the load-bearing bar there, and BAR 1 becomes meaningful only against
  // a comparison build that is finer somewhere it is entitled to be. Saying so is
  // the same discipline that caught `bcc54-cross-vendor-noise` guarding a fold it
  // never reached.
  if (bar1Eligible === 0) {
    console.log('\n  CAVEAT — BAR 1 IS VACUOUS AGAINST THIS COMPARISON BUILD. It distinguishes 0 of the');
    console.log(`  ${PAIRS.length} pairs on a retry-stable ordinal, so no pair COULD have violated BAR 1 and the`);
    console.log('  zero above proves nothing. Read BAR 2 as the load-bearing result here. BAR 1 becomes a');
    console.log('  real check only against a comparison build that is finer where it is entitled to be.');
  } else {
    console.log(`\n  (BAR 1 is non-vacuous here: the comparison distinguishes ${bar1Eligible} of ${PAIRS.length} pairs on a retry-stable ordinal.)`);
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
