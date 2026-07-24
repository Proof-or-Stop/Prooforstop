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
 *   LATTICE_DIST=/path/to/a/main/checkout/packages/main/dist node packages/main/tests/red/red-s3-digest-collapse.mjs
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
 * What remains is the three normalizer-OVERREACH classes B-cc54 does not touch
 * and which still collapsed against main immediately before this story's change:
 *
 *   C2  different phase targets, e.g. DEV/REVIEW vs DEV/TEST — main's path rule
 *       rewrites from ANY slash in a token, so both became `dev#`
 *   C3  different checklist items, e.g. CHK-001 vs CHK-002 — main's `/\d+/g` runs
 *       inside identifier tokens, so both became `chk-#`
 *   C4  different files under a shared first path segment, e.g. src/core/a.ts vs
 *       src/core/b.ts — the same path rule, greedy from the first slash
 *
 * Four incidental-difference classes must KEEP collapsing (regression guard):
 *   K1  ISO timestamps (K1a) and bare attempt ordinals (K1b)
 *   K2  machine-specific absolute paths (/Users/... vs /private/var/...)
 *   K3  hex ids / digests
 *   K4  story-id digits (b-1234 vs b-5678) — B-cc54's own contract
 */
import { strict as assert } from 'node:assert';

const DIST = process.env.LATTICE_DIST || new URL('../../dist', import.meta.url).pathname;
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

console.log(`S3 RED — gateFailureDigest must distinguish substantive gate failures (dist: ${DIST})`);

// (C1a and C1b removed — see the ownership note in the header. That class is
// delivered and guarded by B-cc54, not by this story.)

// C2: different transition targets are different failures.
differ(
  'C2 different phase targets are distinct',
  'transition refused: phase DEV/REVIEW is blocked by an unmet gate',
  'transition refused: phase DEV/TEST is blocked by an unmet gate',
);

// C3: different checklist items are different failures.
differ(
  'C3 different checklist item ids are distinct',
  'verification gap: missing evidence coverage for CHK-001',
  'verification gap: missing evidence coverage for CHK-002',
);

// C4: different in-repo files are different failures.
differ(
  'C4 different in-repo file paths are distinct',
  'scope violation: story touched src/core/alpha.ts outside its contract',
  'scope violation: story touched src/core/beta.ts outside its contract',
);

// K1..K4: incidental differences must still collapse (regression guard).
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
//               while C3 requires the former to stay distinct. The separation is
//               SEMANTIC: an ordinal naming WHICH lifecycle artifact failed is
//               substantive, and this repo mints those ids from a bounded
//               vocabulary (SUBSTANTIVE_ID_PREFIXES). Everything else, including
//               a bare ordinal and a story id, normalizes exactly as main did.
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
  'validation lock held at /Users/jek/Documents/Work/proofbound/.lattice/locks/validate',
  'validation lock held at /private/var/folders/zz/T/lattice-abc/.lattice/locks/validate',
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

console.log(
  failures === 0
    ? `S3 RED: ${total}/${total} pass — defect is FIXED`
    : `S3 RED: ${failures}/${total} FAIL — defect is PRESENT`,
);
process.exit(failures === 0 ? 0 : 1);
