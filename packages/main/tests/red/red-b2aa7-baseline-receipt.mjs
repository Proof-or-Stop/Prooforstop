#!/usr/bin/env node
/**
 * CHK-002 baseline receipt (B-2aa7) — the PRE-FIX invariance baseline.
 *
 * CHK-002 records that `packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs`
 * passes on the tree that still carries the defect, so that CHK-007 can re-run the
 * same harness after the fix and assert the digest did not move. Two of CHK-002's
 * three verification intents are not answered by that harness's own output:
 *
 *   - CHK-002:edge:0        the baseline must NAME the commit it was taken at, and
 *                           that commit must genuinely predate the fix;
 *   - CHK-002:adversarial:0 the pinned constant must not have been edited, and the
 *                           phantom digest of audit §7.1 must appear nowhere as a
 *                           pinned value.
 *
 * Those intents are `type: logic`, i.e. EXECUTABLE (B-ec67): the tool refuses a
 * caller-authored "result: pass" and derives the verdict from a pinned command's
 * real output. This file is that command. Each check prints its marker ONLY when
 * the condition genuinely holds; a failing condition prints nothing, so the pinned
 * selector cannot match.
 *
 * It lives beside the story's other red artifacts because the scope contract
 * (enforce mode) allows `packages/main/tests/red/` as a test path. It does NOT
 * touch red-w2c-v1-verdict-invariance.mjs, which that same contract marks
 * `protectedFiles`.
 *
 * DELIBERATE: this file contains no sha256 literal of its own. The real pinned
 * digest is read out of the harness, and the phantom digest is read out of the
 * audit document that documents it (§7.1). Writing the phantom here would put it
 * back into the tree as a literal — the exact mistake §7.1 exists to prevent —
 * and would also make check 2 self-defeating, since it scans for that string.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-baseline-receipt.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The commit the baseline run was taken at. `node packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs`
 * was run on this tree and exited 0 printing the harness's own pinned digest.
 */
const BASELINE_COMMIT = '6d7c20bb4ba5bca0d7197c414284cbc4c56b3f02';

const HARNESS = 'packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs';
const PREDICATE = 'packages/main/src/core/proofstory.ts';
/** The validation leaf CHK-004 creates; its absence is part of "pre-fix". */
const VALIDATION_LEAF = 'packages/main/src/core/red-evidence-artifact-validation.ts';
const AUDIT_DOC = 'docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

// ── Fail-closed marker ledger ───────────────────────────────────────────────
// `proof-or-stop validate` grades a command by its EXIT CODE alone. Printing a marker
// only when a check holds is what makes the pinned selectors meaningful, but on
// its own it makes this file a crash-detector when run by validate: a regression
// would print fewer markers and STILL exit 0. Every marker below is therefore
// REQUIRED. `emit` records what was actually printed and the epilogue exits
// non-zero naming any marker that was withheld, and why that is a regression.
const REQUIRED_MARKERS = new Map([
  ['BASELINE_COMMIT_PREDATES_FIX',
    `the pinned baseline commit ${BASELINE_COMMIT} no longer resolves, is no longer an ancestor of HEAD, or its BLOB no longer `
    + 'shows the PRE-FIX shape (unguarded dereference adjacent to the schema classify, and no CHK-004 validation leaf). '
    + 'The CHK-002 invariance baseline would then be pinned to a tree that already contains the fix, making the '
    + 'CHK-007 "digest unchanged" comparison vacuous'],
  ['PINNED_CONSTANT_INTACT_PHANTOM_UNPINNED',
    `the protected harness ${HARNESS} is no longer byte-identical to main's copy (its pinned digest was re-pinned or an `
    + 'assertion around it was relaxed), or the phantom digest of audit §7.1 has been written back into the tree as a '
    + 'literal — the exact mistake §7.1 exists to prevent'],
]);

const emitted = new Set();
/**
 * Print a marker line and record it. The recorded name is derived from the line
 * ACTUALLY printed, so the ledger cannot silently drift from the output — and a
 * reworded marker (which would invalidate the recorded verificationEvidence
 * selectors) is rejected outright rather than quietly passing.
 */
function emit(line) {
  const name = String(line).split(/[\s(]/)[0];
  if (!REQUIRED_MARKERS.has(name)) {
    throw new Error(
      `red-b2aa7-baseline-receipt: emitted unregistered marker "${name}". Marker text is a pinned selector in this story's `
      + 'recorded verificationEvidence; renaming one invalidates that evidence. Update the ledger and the evidence together.',
    );
  }
  emitted.add(name);
  console.log(line);
}

// ── 1. edge — the named baseline commit exists, is on this story's history, and
//    its tree genuinely predates the fix. ────────────────────────────────────
//
// "Predates the fix" is asserted against the BLOB at that commit, not against the
// working tree, so it stays checkable forever: if someone later re-pins
// BASELINE_COMMIT to a post-fix commit to make this pass, both sub-checks fail.
let baselineOk = true;

try {
  git('rev-parse', '--verify', `${BASELINE_COMMIT}^{commit}`);
  // Ancestor-or-equal: the baseline must be on the line of history that leads here,
  // not some detached commit that never reached this story.
  execFileSync('git', ['merge-base', '--is-ancestor', BASELINE_COMMIT, 'HEAD'], { stdio: 'ignore' });
} catch {
  baselineOk = false;
}

if (baselineOk) {
  // Pre-fix shape of redEvidenceRecordSatisfied: the schema classify is IMMEDIATELY
  // followed by the unguarded `record.observedFailure.trim()` dereference. CHK-005
  // inserts a shape guard between exactly those two lines, so adjacency is the
  // precise, symbol-anchored discriminator between the pre- and post-fix predicate.
  const predicateAtBaseline = git('show', `${BASELINE_COMMIT}:${PREDICATE}`).split('\n');
  const classifyIdx = predicateAtBaseline.findIndex(
    (line) => line.includes("classifyRedRecordSchemaSafe(record) !== 'v1'"),
  );
  const derefIsNextLine = classifyIdx !== -1
    && (predicateAtBaseline[classifyIdx + 1] ?? '').includes('record.observedFailure.trim()');

  // The CHK-004 read-boundary validator does not exist yet at the baseline.
  const leafAtBaseline = git('ls-tree', '--name-only', BASELINE_COMMIT, '--', VALIDATION_LEAF).trim();

  if (derefIsNextLine && leafAtBaseline === '') {
    emit(`BASELINE_COMMIT_PREDATES_FIX ${BASELINE_COMMIT}`);
  }
}

// ── 2. adversarial — the pinned constant is untouched and the phantom is unpinned. ──
const PIN_RE = /V1_VERDICT_DIGEST\s*=\s*'([0-9a-f]{64})'/;

const pinnedNow = PIN_RE.exec(readFileSync(HARNESS, 'utf8'))?.[1] ?? null;
const pinnedOnMain = PIN_RE.exec(git('show', `main:${HARNESS}`))?.[1] ?? null;

// Not merely "the constant still matches" — the whole protected file must be
// byte-identical to main's, so no assertion around the constant was relaxed either.
const harnessUntouched = git('diff', '--name-only', `${git('merge-base', 'main', 'HEAD').trim()}..HEAD`, '--', HARNESS).trim() === ''
  && git('diff', '--name-only', 'HEAD', '--', HARNESS).trim() === '';

// The phantom digest is READ from the audit document's §7.1 citation rather than
// written here, so this file never becomes another place it is pinned.
const phantom = /expected sha256 across the 5 v1 scenarios:\s*`([0-9a-f]{64})`/
  .exec(readFileSync(AUDIT_DOC, 'utf8'))?.[1] ?? null;

/** Every tracked file under a source/test root — never dist/ or node_modules/. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let phantomPinned = null;
if (phantom && pinnedNow && phantom !== pinnedNow) {
  phantomPinned = walk('packages/main/src')
    .concat(walk('packages/main/tests'))
    .some((file) => readFileSync(file, 'utf8').includes(phantom));
}

if (
  pinnedNow !== null
  && pinnedOnMain !== null
  && pinnedNow === pinnedOnMain
  && harnessUntouched
  && phantomPinned === false
) {
  emit('PINNED_CONSTANT_INTACT_PHANTOM_UNPINNED');
}

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-baseline-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
}
