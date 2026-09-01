#!/usr/bin/env node
/**
 * RED for B-bf52: `gateFailureDigest` collapses genuinely different gate failures
 * into one counter key, so the convergence breaker freezes a story that is
 * making real incremental progress.
 *
 * Correct behavior (what the breaker's own doc comment promises in
 * packages/main/src/core/convergence-breaker.ts):
 *   "two rejections that differ only in INCIDENTAL detail collapse to the same key"
 *   => rejections that differ in SUBSTANTIVE detail must NOT collapse.
 *
 * This script asserts the correct behavior; it EXITS NONZERO while the bug is
 * present. It is tracked (rather than left under gitignored tmp/) so it is
 * durable evidence: run it against this branch's build and against a build of
 * main to see the classes this story moves.
 *
 *   node packages/main/tests/red/red-s3-digest-collapse.mjs
 *   PROOF_OR_STOP_DIST=/path/to/a/main/checkout/packages/main/dist node packages/main/tests/red/red-s3-digest-collapse.mjs
 *
 * ── SCOPE, and what was REMOVED at the B-cc54 reconciliation ─────────────────
 *
 * The harness originally asserted four substantive-difference classes. Two of
 * them, C1a and C1b, are DELETED rather than left as passing assertions, and the
 * deletion is recorded here rather than made silently:
 *
 *   C1a  two real ProofStory DEV-gate rejections differing in ONE outstanding gap
 *   C1b  two real DEV-gate rejections differing in gap COUNT
 *
 * Both collapsed because the fixed DEV-gate header alone runs past the digest's
 * 200-character normalized prefix, so the part naming WHICH gap is unmet never
 * reached the hash. B-cc54 landed on main first (v0.3.231) and fixed exactly that
 * class by a better route than this story had planned: it leaves the truncation
 * and the normalization rules untouched and folds structurally-extracted gap-id
 * signals into the hash basis, so distinctness comes from STRUCTURE rather than
 * from re-classifying free-text tokens. That class is therefore B-cc54's to
 * deliver and B-cc54's to guard — its regression suite is
 * packages/main/src/tasks/gate-repeat-block-smoke.ts, registered as a
 * doneRequiredCommand. Keeping C1a/C1b here would assert a landed contract twice
 * while pinning it to a mechanism this story does not supply, and a later change
 * to B-cc54's design would then fail in a file that has no authority over it.
 *
 * ── The BOUNDED piece of the CHK-001 class this story DOES deliver (C1c) ──────
 *
 * B-cc54's signals fold only supplies distinctness when the reason CARRIES a
 * structured signal. A rejection that carries NONE — no bracketed reason code, no
 * bulleted snake_case gap id, no missing_/invalid_/stale_ token — falls back to
 * the 200-character prefix alone, so two such rejections that are byte-identical
 * for 200 characters and only then name the offending path still collapse under
 * main. That is a real shape (a scope-gate refusal whose invariant advice
 * precedes the path). B-bf52 F-031 delivers exactly this bounded piece: the
 * prefix cut is made SIGNALS-CONDITIONAL, so a signal-less reason is bounded at
 * 16,384 characters instead of 200 and its late divergence reaches the hash,
 * while a signal-bearing reason keeps B-cc54's 200-char prefix untouched. C1c
 * asserts that piece and does NOT overlap B-cc54's contract, because its fixtures
 * extract ZERO signals — the branch B-cc54's mechanism never reaches.
 *
 * What remains is the two normalizer-OVERREACH classes B-cc54 does not touch
 * and which still collapsed against main immediately before this story's change:
 *
 *   C2  different phase targets, e.g. DEV/REVIEW vs DEV/TEST — main's path rule
 *       rewrites from ANY slash in a token, so both became `dev#`
 *   C4  different files under a shared first path segment, e.g. src/core/a.ts vs
 *       src/core/b.ts — the same path rule, greedy from the first slash
 *
 * ── C3 IS WITHDRAWN AND MOVED TO THE COLLAPSE SIDE (F-058) ───────────────────
 *
 * C3 was "different checklist items, e.g. CHK-001 vs CHK-002, must key apart".
 * This harness asserted it for fifteen review rounds. It is NOT delivered, and the
 * assertion is INVERTED rather than deleted, because the collapse is now a decided
 * contract and needs a standing test.
 *
 * The reason is a proof, not a budget. core/machine.ts:1190 interpolates RAW
 * third-party test output into the reason the digest keys on, and in that channel
 * the bare token `bug-2` (an ordinary TAP subtest name) is TEXTUALLY IDENTICAL to a
 * bare artifact ordinal such as the `BUG-002` of `Cannot enter DONE: 1 unfixed
 * bug(s): BUG-002`. Recognising the artifact ordinal therefore necessarily
 * recognises the third-party label, and eight successive attempts to separate them
 * (rounds 7-14) each leaked to a shape their author had not enumerated. For a
 * circuit breaker the safe direction is to COLLAPSE — too fine a key lets a stuck
 * agent mint a fresh key on every retry and the brake never fires, while too coarse
 * a key fires the brake early at the cost of one human acknowledgement. So the
 * artifact-id apparatus is deleted and every ordinal collapses, exactly as main
 * does it. Delivering C3 needs the digest to consult STORY STATE rather than
 * message text; that is named as a follow-up in core/convergence-breaker.ts.
 *
 * Five incidental-difference classes must KEEP collapsing (regression guard):
 *   K1  ISO timestamps (K1a) and bare attempt ordinals (K1b)
 *   K2  machine-specific absolute paths (/Users/... vs /private/var/...)
 *   K3  hex ids / digests
 *   K4  story-id digits (b-1234 vs b-5678) — B-cc54's own contract
 *   K5  artifact ordinals (the withdrawn C3) and the third-party label that is
 *       indistinguishable from one
 */
import { strict as assert } from 'node:assert';

const DIST = process.env.PROOF_OR_STOP_DIST || new URL('../../dist', import.meta.url).pathname;
const { gateFailureDigest } = await import(`${DIST}/core/convergence-breaker.js`);

let failures = 0;
let total = 0;
const check = (label, fn) => {
  total++;
  try {
    fn();
    console.log(`  [PASS] ${label}`);
  } catch (e) {
    console.log(`  [FAIL] ${label} — ${e.message}`);
    failures++;
  }
};

const CMD = 'story_advance';
const differ = (label, a, b) =>
  check(label, () =>
    assert.notEqual(
      gateFailureDigest(CMD, a),
      gateFailureDigest(CMD, b),
      `substantively different reasons collapsed to ${gateFailureDigest(CMD, a)}`,
    ),
  );
const same = (label, a, b) =>
  check(label, () =>
    assert.equal(
      gateFailureDigest(CMD, a),
      gateFailureDigest(CMD, b),
      'incidental-only difference must still collapse',
    ),
  );

console.log(`S3 RED — gateFailureDigest must distinguish paths/phases and must collapse ordinals (dist: ${DIST})`);

// (C1a and C1b removed — see the ownership note in the header. That class is
// delivered and guarded by B-cc54, not by this story.)

// C1c: the SIGNAL-LESS piece of the CHK-001 class this story delivers (F-031).
// Both reasons carry NO structured signal and are identical for their first 200
// normalized characters, diverging only in the trailing path — so B-cc54's
// signals fold cannot tell them apart and only the signals-conditional prefix
// can. This FAILS against a build of main (unconditional 200-char cut collapses
// them) and passes here. The body is the real scope-gate advice
// (nextActionForViolation, core/scope-contract.ts) so no bracketed reason code,
// bulleted gap id, or missing_/invalid_/stale_ token is present.
const scopeGateBlock = (path) =>
  'Cannot enter TEST: the scope gate is blocking for B-bf52. The story scope contract is in enforce mode, so every changed path must be '
  + 'declared by the contract, covered by a shared classifier rule, or carry an explicit acknowledgement that a reviewer can see. '
  + 'Run scope_contract_acknowledge with a reviewer-visible reason, add the path to the contract, or revert it. Blocking path: ' + path;
differ(
  'C1c signal-less long rejections diverging past char 200 are distinct',
  scopeGateBlock('packages/main/src/core/alpha.ts'),
  scopeGateBlock('packages/main/src/core/beta.ts'),
);

// C2: different transition targets are different failures.
differ(
  'C2 different phase targets are distinct',
  'transition refused: phase DEV/REVIEW is blocked by an unmet gate',
  'transition refused: phase DEV/TEST is blocked by an unmet gate',
);

// C4: different in-repo files are different failures.
differ(
  'C4 different in-repo file paths are distinct',
  'scope violation: story touched src/core/alpha.ts outside its contract',
  'scope violation: story touched src/core/beta.ts outside its contract',
);

// K1..K5: incidental differences must still collapse (regression guard).
//
// DECISION HISTORY for K1b, recorded rather than erased, because it was flipped
// and then flipped back:
//
//   rounds 1-3  K1 held as one bundled `same` assertion (ISO + ordinal).
//   round 4     K1b was RE-DECIDED to `differ`, on the reasoning that a bare
//               number in free text is not SYNTACTICALLY decidable as
//               substantive or volatile (`CHK-002` vs `RR-002`, `attempt 3` vs
//               `port 3000`), and that the tie should break toward "distinct"
//               because `(attempt N)` had no producer in this repo outside this
//               fixture. On that basis the general digit rule was deleted.
//   round 5     K1b is REVERTED to `same`, and so is the rule deletion. The
//               round-4 premise was false: while this branch sat behind main,
//               B-cc54 landed with a regression suite whose
//               CHK-001:adversarial:0 REQUIRES `attempt 7` and `attempt 91` to
//               digest identically, so `(attempt N)` does have a live consumer —
//               a landed gate contract.
//   round 6     The syntactic framing itself is abandoned. Round 4 was right
//               that no syntactic rule separates `CHK-001` from `b-1234`; K4
//               below is the proof, since B-cc54 requires the latter to collapse
//               while C3 required the former to stay distinct. The separation was
//               attempted SEMANTICALLY instead: an ordinal naming WHICH lifecycle
//               artifact failed was treated as substantive, drawn from a bounded
//               hand-written vocabulary of id prefixes.
//   round 15    THE SEMANTIC ROUTE FAILS TOO, and K1b's `same` outlives the
//               reasoning that once qualified it (F-058). A semantic rule still has
//               to RECOGNISE its vocabulary in text, and in the raw third-party
//               output core/machine.ts:1190 embeds, `bug-2` and `BUG-002` are the
//               same string shape — so the vocabulary cannot be recognised without
//               also recognising arbitrary labels. Eight rounds of pattern
//               refinement measured that. C3 is withdrawn (see the header), the
//               vocabulary is deleted, and K5 below asserts the collapse that
//               replaces it. K1b's verdict never changed through any of this.
same(
  'K1a ISO timestamps still collapse (ordinal held constant)',
  'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)',
  'gate BLOCKED for B-bbaf at 2026-07-14T09:59:59Z (attempt 3)',
);
same(
  'K1b bare ordinals still collapse (round-4 re-decision REVERTED; see comment above)',
  'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 3)',
  'gate BLOCKED for B-bbaf at 2026-07-14T00:00:00Z (attempt 41)',
);
same(
  'K2 machine-specific absolute paths still collapse',
  'validation lock held at /Users/jek/Documents/Work/proofbound/.proof-or-stop/locks/validate',
  'validation lock held at /private/var/folders/zz/T/proof-or-stop-abc/.proof-or-stop/locks/validate',
);
same(
  'K3 hex ids and digests still collapse',
  'material digest mismatch a1b2c3d4e5f6789',
  'material digest mismatch f6e5d4c3b2a1987',
);
same(
  'K4 story-id digits still collapse (B-cc54 CHK-002:adversarial:2, verbatim)',
  'gate blocked for b-1234',
  'gate blocked for b-5678',
);
// K5: the WITHDRAWN C3, asserted in the direction the story actually delivers.
//
// Read the two assertions together — that is the whole content of F-058. The first
// is a real first-party render (core/machine.ts:1195). The second is ordinary raw
// test output, which core/machine.ts:1190 embeds verbatim into the very reason this
// digest keys on. Lower-cased and whitespace-delimited, the token under decision is
// the same string shape in both, so no rule over message text can key the first pair
// apart while keeping the second pair together. Eight rounds of pattern refinement
// measured that; the ninth records it.
//
// These two lines are the standing guard on the decision: if a later change makes
// either pair key APART, the artifact-id apparatus is back and with it the leak that
// let a stuck agent mint a fresh counter key on every retry.
same(
  'K5a artifact ordinals collapse — the WITHDRAWN C3, from a real producer (F-058)',
  'Cannot enter DONE: 1 unfixed bug(s): BUG-001',
  'Cannot enter DONE: 1 unfixed bug(s): BUG-002',
);
same(
  'K5b a third-party TAP label of the SAME shape collapses too (F-058, codex reproducer)',
  'Cannot enter DONE: test FAIL: # tests 1\n# pass 0\n# fail 1\nnot ok 1 - bug-2 reproducer still red',
  'Cannot enter DONE: test FAIL: # tests 1\n# pass 0\n# fail 1\nnot ok 1 - bug-5 reproducer still red',
);

console.log(
  failures === 0
    ? `S3 RED: ${total}/${total} pass — defect is FIXED`
    : `S3 RED: ${failures}/${total} FAIL — defect is PRESENT`,
);
process.exit(failures === 0 ? 0 : 1);
