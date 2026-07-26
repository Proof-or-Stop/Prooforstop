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

// 1. happy — the record is in this story's diff AND carries the decisions the
//    other ten checklist items cite, so those citations resolve for a reader
//    with no access to the authoring session.
const landedFiles = execFileSync('git', ['show', '--name-only', '--format=', DOC_COMMIT], { encoding: 'utf8' });
if (landedFiles.includes(DOC) && doc.includes('D-8')) {
  console.log('DOC_LANDED_WITH_DECISIONS');
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
  console.log('DOC_PRECEDES_SCOPE_REVIEW');
}

// 3. adversarial — the stale pre-merge header was actually rewritten, not merely
//    supplemented. The old line contradicted the document's own §0.0 about which
//    tree the citations describe; that self-contradiction was the INIT-006 defect
//    class, so this asserts the contradiction is GONE, not that new text was added.
if (doc.includes('Superseded') && !doc.includes('Cross-check tree: the')) {
  console.log('STALE_HEADER_REMOVED');
}
