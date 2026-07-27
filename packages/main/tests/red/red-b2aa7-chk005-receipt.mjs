#!/usr/bin/env node
/**
 * CHK-005 verification receipt (B-2aa7) — the gate predicate is TOTAL.
 *
 * CHK-005 adds the defense-in-depth half of decision D-2: `redEvidenceRecordSatisfied`
 * (`packages/main/src/core/proofstory.ts`) must never throw on arbitrary input, even
 * when a malformed record is injected DIRECTLY into the diagnostic input and never
 * passes the read boundary. Its three intents are `type: logic`, i.e. EXECUTABLE
 * (B-ec67): the tool refuses a caller-authored "result: pass" and derives the verdict
 * from a pinned command's real output. This file is that command.
 *
 * Each marker prints ONLY when its condition genuinely holds; a failing condition
 * prints nothing, so the pinned selector cannot match. The file authors NO sha256
 * literal of its own — the invariance digest is read out of the protected harness, so
 * this receipt can never become a second place the constant is pinned.
 *
 * It does not touch `red-w2c-v1-verdict-invariance.mjs` (scope contract:
 * `protectedFiles`) nor `red-b2aa7-artifact-validation.mjs` (owned by CHK-001 /
 * CHK-009 / CHK-010 / CHK-011); it RUNS the former as a child process and reads it
 * as text.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk005-receipt.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const HARNESS = 'packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs';
const PREDICATE = 'packages/main/src/core/proofstory.ts';

/**
 * The last commit BEFORE the CHK-005 guard landed. Check 3 diffs the predicate
 * against the blob at this commit, so "only the shape guard was added" is asserted
 * against real history rather than against a remembered shape. Re-pinning this to a
 * post-fix commit makes check 3 fail: the guard would then be present on both sides
 * and the "exactly one executable line added" condition could not hold.
 */
const PRE_FIX_COMMIT = '3826486e80342e12370e869408be08c82ba4dbd5';

// stderr is discarded: an unresolvable pin is handled below by withholding the
// marker, so git's own `fatal:` chatter would only add noise to a receipt whose
// contract is "print a marker or print nothing".
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { classifyRedRecordSchemaSafe } = await import(`${DIST}/core/red-evidence/record-v2.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-chk005';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-chk005-${process.pid}`);

// ── a store whose red-evidence artifact on disk is CLEAN and EMPTY ───────────
const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'chk005', title: 'B-2aa7 CHK-005 predicate totality',
  description: 'Fix an authentication session security regression (behavior change).',
  type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
});
const milestones = [{
  id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
  requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned',
}];
store.writeMilestoneLedger(storyId, {
  schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
  ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW,
});
store.writeRedEvidence(storyId, {
  schemaVersion: 'proofstory.red_evidence.v1', storyId, records: [], createdAt: NOW, updatedAt: NOW,
});

/**
 * The base input, built by the SAME production entrypoint the live enforce gates
 * call. Records are then substituted into the RETURNED object, so the injected
 * values are handed straight to the predicate and never see `store.readRedEvidence`.
 */
const baseInput = proofStoryDiagnosticInput(store, storyId, root);

/** Evaluate with `records` replaced. Returns a verdict, or the error that escaped. */
function verdictFor(records) {
  try {
    const report = evaluateProofStoryDiagnostics({
      ...baseInput,
      redEvidence: { ...baseInput.redEvidence, records },
    });
    return { threw: false, satisfied: report.missingRedEvidence.length === 0 };
  } catch (err) {
    return { threw: true, error: `${err?.constructor?.name}: ${err?.message}` };
  }
}

/**
 * The EXACT expression the predicate used to open with, evaluated on the record in
 * isolation. A row only belongs to the class this guard closes if this throws a
 * TypeError — that is what makes the totality claim non-vacuous.
 */
function unguardedDereferenceThrows(record) {
  try {
    record.observedFailure.trim();
    return false;
  } catch (err) {
    return err instanceof TypeError;
  }
}

// ── the v1 fixtures, byte-for-byte the ones the protected harness uses ───────
const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};
const blankObservedFailure = { ...satisfying, id: 'RED-v1-blank', observedFailure: '   ' };
const emptyObservedFailure = { ...satisfying, id: 'RED-v1-empty', observedFailure: '' };
const foreignTarget = {
  ...satisfying, id: 'RED-v1-foreign', acceptanceTargetRef: 'M-not-in-ledger',
  greenRelation: { ...satisfying.greenRelation, targetRef: 'M-not-in-ledger' },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. happy — every WELL-FORMED input still gets the same verdict as before.
// ─────────────────────────────────────────────────────────────────────────────
//
// "As before" is anchored two ways. (a) The protected five-scenario invariance
// harness is RUN as a child process and must print the digest it pinned on the
// pre-fix tree — that digest is read out of the harness, never authored here.
// (b) The same well-formed fixtures are re-driven through the DIRECT-injection path
// used by check 2, so the new guard is proven to pass well-formed records rather
// than merely to be absent from the harness's code path.
const harnessRun = spawnSync(process.execPath, [join(here, 'red-w2c-v1-verdict-invariance.mjs')], { encoding: 'utf8' });
const pinnedDigest = /V1_VERDICT_DIGEST\s*=\s*'([0-9a-f]{64})'/.exec(readFileSync(HARNESS, 'utf8'))?.[1] ?? null;
const printedDigest = /five-scenario FULL-diagnostic sha256 = ([0-9a-f]{64})/.exec(harnessRun.stdout ?? '')?.[1] ?? null;
const digestHeld = pinnedDigest !== null && printedDigest === pinnedDigest && harnessRun.status === 0;

const WELL_FORMED = [
  ['satisfying', [satisfying], true],
  ['blank-observedFailure', [blankObservedFailure], false],
  ['empty-observedFailure', [emptyObservedFailure], false],
  ['foreign-acceptance-target', [foreignTarget], false],
  ['mixed-store', [blankObservedFailure, foreignTarget, satisfying], true],
];
const wellFormedHeld = WELL_FORMED.every(([, records, expected]) => {
  const got = verdictFor(records);
  return got.threw === false && got.satisfied === expected;
});

// D-5 / audit §8.4: a blank or empty `observedFailure` is LEGACY-TOLERATED input,
// not malformed. It must stay on the ordinary non-satisfier route — the unguarded
// dereference never threw on it, so the new guard must not be what rejects it, or
// scenario 3 of the harness changes shape.
const blankStaysOrdinary = [blankObservedFailure, emptyObservedFailure].every((record) =>
  classifyRedRecordSchemaSafe(record) === 'v1'
  && unguardedDereferenceThrows(record) === false
  && verdictFor([record]).satisfied === false);

if (digestHeld && wellFormedHeld && blankStaysOrdinary) {
  console.log(
    `WELL_FORMED_VERDICTS_UNCHANGED (${WELL_FORMED.length} well-formed fixtures re-driven through direct injection; `
    + `protected harness re-run exits 0 at its own pinned digest ${printedDigest}; `
    + 'blank/empty observedFailure still UNSATISFIED via the ordinary non-satisfier route, not via the new guard)',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. edge — the predicate is TOTAL on a record injected past the read boundary.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every row must satisfy three conditions together, or the marker is withheld:
//   (i)   `classifyRedRecordSchemaSafe` still calls it 'v1' — i.e. it lands in the
//         RESIDUAL class that the B-506e skip guards do NOT catch;
//   (ii)  the pre-fix opening expression `record.observedFailure.trim()` throws a
//         TypeError on it — so the row is genuinely in the crash class and the
//         totality claim is not vacuous;
//   (iii) the real gate nevertheless returns a verdict.
const arrayRecord = [];
const arrayHoldingRecord = [satisfying];
const nullProto = Object.create(null);
const deepJunk = { id: 'deep', nested: { a: [1, { b: null }], c: {} } };
const numericObservedFailure = { ...satisfying, observedFailure: 123 };
const nullObservedFailure = { ...satisfying, observedFailure: null };
const absentObservedFailure = (() => { const r = { ...satisfying }; delete r.observedFailure; return r; })();

const MALFORMED = [
  ['versionless {id:"corrupt"}', { id: 'corrupt' }],
  ['observedFailure: null', nullObservedFailure],
  ['observedFailure: 123', numericObservedFailure],
  ['observedFailure absent', absentObservedFailure],
  ['record is [] (array)', arrayRecord],
  ['record is [satisfying] (array wrapping a record)', arrayHoldingRecord],
  ['record is {}', {}],
  ['Object.create(null)', nullProto],
  ['deeply nested junk', deepJunk],
];

const rowResults = MALFORMED.map(([label, record]) => {
  const residualV1 = classifyRedRecordSchemaSafe(record) === 'v1';
  const wouldCrash = unguardedDereferenceThrows(record);
  const alone = verdictFor([record]);
  // Ordering matters: `some()` short-circuits, so a malformed record must also be
  // survivable when it comes FIRST, before any satisfying record can rescue the run.
  const first = verdictFor([record, satisfying]);
  const last = verdictFor([satisfying, record]);
  const render = (got) => (got.threw ? `THREW ${got.error}` : got.satisfied ? 'SATISFIED' : 'UNSATISFIED');
  return {
    label, residualV1, wouldCrash,
    total: alone.threw === false && first.threw === false && last.threw === false,
    verdicts: `alone=${render(alone)} first=${render(first)} last=${render(last)}`,
  };
});

// The injection genuinely bypassed the read boundary: the artifact on disk still
// holds ZERO records and none of the injected ids ever reached it.
const onDisk = readFileSync(join(root, '.lattice/story/actives', storyId, 'red-evidence.json'), 'utf8');
const bypassedReadBoundary =
  store.readRedEvidence(storyId).records.length === 0
  && !onDisk.includes('corrupt')
  && !onDisk.includes('RED-v1');

const totalOnInjection =
  rowResults.length > 0
  && rowResults.every((r) => r.residualV1 && r.wouldCrash && r.total)
  && bypassedReadBoundary;

if (totalOnInjection) {
  console.log(
    `PREDICATE_TOTAL_ON_DIRECT_INJECTION (${rowResults.length}/${rowResults.length} malformed records: each still classifies as the RESIDUAL 'v1', `
    + 'each still crashes the pre-fix unguarded dereference with a TypeError, and each now yields a verdict in every position '
    + '(alone / first / last); artifact on disk still holds 0 records, so nothing was read through store.readRedEvidence)',
  );
} else {
  for (const r of rowResults.filter((row) => !(row.residualV1 && row.wouldCrash && row.total))) {
    console.error(`  row not total: ${r.label} residualV1=${r.residualV1} wouldCrash=${r.wouldCrash} total=${r.total} ${r.verdicts}`);
  }
  if (!bypassedReadBoundary) console.error('  injection did not bypass the read boundary');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. adversarial — ONLY the shape guard was added; no other check moved.
// ─────────────────────────────────────────────────────────────────────────────
//
// Asserted by diffing the predicate BODY against the blob at PRE_FIX_COMMIT rather
// than by reading the working tree twice. Comment and blank lines are dropped on
// both sides (comments are not behaviour); of the remaining executable lines,
// removing the ones that mention the new helper must leave a sequence
// BYTE-IDENTICAL to the pre-fix one, in the same ORDER — so a reordered, rewritten
// or deleted check cannot pass this.
//
// The added line must also BE the guard, verbatim. Merely MENTIONING the helper is
// not enough: a control run that replaced the guard with `void isShapedLegacyV1Record;`
// kept this marker alive until the exact form was pinned, while check 2 correctly
// went red — this equality is what stops check 3 from vouching for a no-op.
const GUARD_LINE = 'if (!isShapedLegacyV1Record(record)) return false;';
function predicateBody(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith('function redEvidenceRecordSatisfied('));
  if (start === -1) return null;
  const end = lines.findIndex((line, idx) => idx > start && line === '}');
  if (end === -1) return null;
  return lines.slice(start, end + 1);
}

const executable = (body) => body
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));

// The pin must RESOLVE, sit on this story's history, and carry the predicate — and
// failing any of those withholds the marker rather than aborting the receipt (a
// crash would take the other two markers down with it and could be mistaken for an
// environment fault).
let preFixSource = null;
try {
  git('rev-parse', '--verify', `${PRE_FIX_COMMIT}^{commit}`);
  execFileSync('git', ['merge-base', '--is-ancestor', PRE_FIX_COMMIT, 'HEAD'], { stdio: 'ignore' });
  preFixSource = git('show', `${PRE_FIX_COMMIT}:${PREDICATE}`);
} catch {
  preFixSource = null;
}
const currentSource = readFileSync(PREDICATE, 'utf8');

const preFixBody = preFixSource === null ? null : predicateBody(preFixSource);
const currentBody = predicateBody(currentSource);

let onlyGuardAdded = false;
let addedLines = [];
if (preFixBody && currentBody) {
  const preFixExec = executable(preFixBody);
  const currentExec = executable(currentBody);
  addedLines = currentExec.filter((line) => line.includes('isShapedLegacyV1Record'));
  const currentMinusGuard = currentExec.filter((line) => !line.includes('isShapedLegacyV1Record'));

  const guardIdx = currentExec.findIndex((line) => line.includes('isShapedLegacyV1Record'));
  const derefIdx = currentExec.findIndex((line) => line.includes('record.observedFailure.trim()'));

  onlyGuardAdded =
    // exactly one executable line was added, and it is the guard VERBATIM
    addedLines.length === 1
    && addedLines[0] === GUARD_LINE
    // every other executable line is unchanged AND in the same order
    && currentMinusGuard.length === preFixExec.length
    && currentMinusGuard.every((line, idx) => line === preFixExec[idx])
    // the guard runs BEFORE the dereference it protects
    && guardIdx !== -1 && derefIdx !== -1 && guardIdx < derefIdx
    // the helper is genuinely new, not a repurposed existing symbol
    && !preFixSource.includes('isShapedLegacyV1Record')
    && /function isShapedLegacyV1Record\(/.test(currentSource);
}

if (onlyGuardAdded) {
  console.log(
    `ONLY_THE_SHAPE_GUARD_WAS_ADDED (predicate body diffed against ${PRE_FIX_COMMIT.slice(0, 10)}: `
    + `1 executable line added — ${addedLines[0]} — placed before the dereference it protects; `
    + `the other ${executable(preFixBody ?? []).length} executable lines are byte-identical and in the same order)`,
  );
}
