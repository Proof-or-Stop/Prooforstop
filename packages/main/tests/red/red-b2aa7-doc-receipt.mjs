#!/usr/bin/env node
/**
 * CHK-008 verification receipt (B-2aa7).
 *
 * The three CHK-008 verification intents are `type: cli`, i.e. EXECUTABLE intents:
 * per B-ec67 the tool refuses a caller-authored "result: pass" and instead runs a
 * pinned command and derives the verdict from its actual output. This file is that
 * pinned command. Each check prints a distinct marker ONLY when the condition
 * genuinely holds, so a failing condition yields no marker and the pinned selector
 * cannot match.
 *
 * It lives beside the story's other red artifacts because the scope contract
 * (enforce mode) allows `packages/main/tests/red/` as a test path.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-doc-receipt.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DOC = 'docs/requirements/decisions/red-evidence-legacy-v1-record-validation-audit.md';

/** Commit that landed the decision record (CHK-008). */
const DOC_COMMIT = 'b8c458422e';
/** First `scope_check_save` commit — i.e. the PLAN scope review. */
const SCOPE_REVIEW_COMMIT = '45ab9155f1';

const doc = readFileSync(DOC, 'utf8');

// ── Fail-closed marker ledger ───────────────────────────────────────────────
// `proof-or-stop validate` grades a command by its EXIT CODE alone. Printing a marker
// only when a check holds is what makes the pinned selectors meaningful, but on
// its own it makes this file a crash-detector when run by validate: a regression
// would print fewer markers and STILL exit 0. Every marker below is therefore
// REQUIRED. `emit` records what was actually printed and the epilogue exits
// non-zero naming any marker that was withheld, and why that is a regression.
const REQUIRED_MARKERS = new Map([
  ['DOC_LANDED_WITH_DECISIONS',
    `the decision record ${DOC} is no longer part of commit ${DOC_COMMIT}'s diff, or no longer carries the D-8 `
    + 'decisions the other ten checklist items cite — so those citations no longer resolve for a reader outside the authoring session'],
  ['DOC_PRECEDES_SCOPE_REVIEW',
    `commit ${DOC_COMMIT} is no longer an ancestor of the scope-review commit ${SCOPE_REVIEW_COMMIT}, i.e. the record no `
    + 'longer demonstrably predates the PLAN scope review it was supposed to inform'],
  ['STALE_HEADER_REMOVED',
    'the stale pre-merge header is back, or the "Superseded" rewrite is gone — the document once again contradicts its own '
    + '§0.0 about which tree its citations describe, which is the INIT-006 defect class this row exists to keep out'],
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
      `red-b2aa7-doc-receipt: emitted unregistered marker "${name}". Marker text is a pinned selector in this story's `
      + 'recorded verificationEvidence; renaming one invalidates that evidence. Update the ledger and the evidence together.',
    );
  }
  emitted.add(name);
  console.log(line);
}

// 1. happy — the record is in this story's diff AND carries the decisions the
//    other ten checklist items cite, so those citations resolve for a reader
//    with no access to the authoring session.
const landedFiles = execFileSync('git', ['show', '--name-only', '--format=', DOC_COMMIT], { encoding: 'utf8' });
if (landedFiles.includes(DOC) && doc.includes('D-8')) {
  emit('DOC_LANDED_WITH_DECISIONS');
}

// 2. edge — ORDERING, proven rather than asserted. `--ancestry-path` yields the
//    scope-review commit only if the doc commit is genuinely one of its ancestors;
//    had the doc landed after the review, the output would be empty.
const ancestry = execFileSync(
  'git',
  ['rev-list', '--ancestry-path', `${DOC_COMMIT}..${SCOPE_REVIEW_COMMIT}`],
  { encoding: 'utf8' },
);
if (ancestry.includes(SCOPE_REVIEW_COMMIT)) {
  emit('DOC_PRECEDES_SCOPE_REVIEW');
}

// 3. adversarial — the stale pre-merge header was actually rewritten, not merely
//    supplemented. The old line contradicted the document's own §0.0 about which
//    tree the citations describe; that self-contradiction was the INIT-006 defect
//    class, so this asserts the contradiction is GONE, not that new text was added.
if (doc.includes('Superseded') && !doc.includes('Cross-check tree: the')) {
  emit('STALE_HEADER_REMOVED');
}

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-doc-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
}
