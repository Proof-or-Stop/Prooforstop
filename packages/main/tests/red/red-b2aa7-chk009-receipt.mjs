#!/usr/bin/env node
/**
 * CHK-009 verification receipt (B-2aa7) — order independence.
 *
 * CHK-009's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and instead runs a pinned command and
 * derives the verdict from its actual output. This file is that pinned command.
 *
 * Two independent sources, both real:
 *
 *   PART 1  runs `red-b2aa7-artifact-validation.mjs` as a child process and
 *           re-checks the OBSERVED FACTS on its BLOCK C `proof C1/C2/C3` lines —
 *           not merely that they were printed. Markers 1 and 2 come from here.
 *   PART 2  reproduces, IN PROCESS, the exact O2 silence this story exists to
 *           remove, by driving the live gate over the SAME bytes twice: once
 *           through the validated read boundary and once with that boundary
 *           BYPASSED (`JSON.parse` straight into the typed domain — which is
 *           what `store.readRedEvidence` did before CHK-004). Marker 3 is that
 *           differential.
 *
 * ── WHY PART 2 IS A SIMULATION AND WHAT THE REAL PIN WAS ────────────────────
 *
 * The authoritative pre-fix observation is NOT reproducible in this tree: CHK-004
 * fixed the read boundary and CHK-005 made the predicate total, so neither the
 * O1 crash nor the O2 silence can be provoked here through the production path.
 * It was therefore taken on a rebuilt archive of the pre-fix commit `6d7c20bb4b`
 * (`git archive` → `npm --prefix packages/main run build` → same harness), where
 * this very artifact file reports all three BLOCK C rows RED with their
 * documented witness:
 *
 *   C1  38 permutations over 4 record sets → 2 distinct observables per set
 *       (satisfier-first SATISFIED and silent; malformed-first bare TypeError)
 *   C2  0/12 reported, 12/12 silent pass-through
 *   C3  satisfier-first detected 0 of 3; malformed-first threw; orders disagree
 *
 * PART 2 reproduces the SILENT half of that live, because the pre-fix data path
 * — an unvalidated parsed value handed to the gate — is still expressible.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk009-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');
const ARTIFACT = join(here, 'red-b2aa7-artifact-validation.mjs');

// ── Fail-closed marker ledger ───────────────────────────────────────────────
// `proof-or-stop validate` grades a command by its EXIT CODE alone. Printing a marker
// only when a check holds is what makes the pinned selectors meaningful, but on
// its own it makes this file a crash-detector when run by validate: a regression
// would print fewer markers and STILL exit 0. Every marker below is therefore
// REQUIRED. `emit` records what was actually printed and the epilogue exits
// non-zero naming any marker that was withheld, and why that is a regression.
const canonicalCore = process.argv.includes('--canonical-core');
const REQUIRED_MARKERS = new Map([
  ['ORDER_INDEPENDENT_VERDICT',
    "the artifact's BLOCK C1 no longer shows the 38 permutations over 4 record sets collapsing to one position-free "
    + 'observable each, or a bare TypeError escaped, or the comparator stopped being discriminated by all three negative '
    + 'controls — i.e. the verdict depends on record ORDER again, or the check that says so went vacuous'],
  ['MALFORMED_REPORTED_BEHIND_SATISFIER',
    'BLOCK C2/C3 no longer show all 12 flavour x depth cases retained at their TRUE index with 0 silent pass-throughs, or 3 '
    + 'malformed entries stacked behind one satisfier are no longer ALL reported — i.e. `Array.prototype.some` '
    + 'short-circuiting can hide a malformed record behind a satisfying one again'],
  ['O2_SILENT_CORRUPTION_PINNED',
    'the live O2 reproduction broke: with the read boundary BYPASSED the gate no longer silently returns SATISFIED while the '
    + 'malformed record sits unreported (so the pinned defect is no longer being demonstrated), or through the VALIDATED '
    + 'boundary the same bytes are no longer quarantined verbatim at index 1 with the verdict unchanged (so the fix regressed)'],
]);

if (canonicalCore) {
  REQUIRED_MARKERS.clear();
  REQUIRED_MARKERS.set('CANONICAL_O2_BOUNDARY_DIFFERENTIAL',
    'the direct bypass/validated read comparison must retain corruption at index 1 with unchanged verdict');
}
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
      `red-b2aa7-chk009-receipt: emitted unregistered marker "${name}". Marker text is a pinned selector in this story's `
      + 'recorded verificationEvidence; renaming one invalidates that evidence. Update the ledger and the evidence together.',
    );
  }
  emitted.add(name);
  console.log(line);
}

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — the artifact's own BLOCK C evidence
// ════════════════════════════════════════════════════════════════════════════
let artifactFullyGreen = false;
if (!canonicalCore) {
const run = spawnSync(process.execPath, [ARTIFACT], { encoding: 'utf8' });
const stdout = run.stdout ?? '';

const state = new Map();
for (const line of stdout.split('\n')) {
  const m = /^\s*\[(RED |GREEN)\]\s+(\S+)\s/.exec(line);
  if (m) state.set(m[2], m[1].trim());
}
const proofs = {};
for (const line of stdout.split('\n')) {
  const m = /^\s*proof (C\d+):\s*(.*)$/.exec(line);
  if (m) proofs[m[1]] = m[2];
}
const tally = /(\d+) RED \/ (\d+) GREEN of (\d+) rows/.exec(stdout);
const redCount = tally ? Number(tally[1]) : -1;
const greenCount = tally ? Number(tally[2]) : -1;
const total = tally ? Number(tally[3]) : -1;

const C1 = 'C1-verdict-order-independent';
const C2 = 'C2-malformed-reported-behind-satisfier';
const C3 = 'C3-detection-exhaustive-not-first-match';

/**
 * Structural gate shared by every marker. BLOCK B rows are FATAL on failure and
 * a BLOCK C row that fails for an undocumented reason aborts the run with a
 * STALE ROW assertion, so reaching a green tally proves the whole file — BLOCK A
 * repro rows, BLOCK B invariants and BLOCK C order rows alike — ran and held.
 */
artifactFullyGreen =
  run.status === 0
  && redCount === 0 && total > 0 && greenCount === total
  && state.get(C1) === 'GREEN' && state.get(C2) === 'GREEN' && state.get(C3) === 'GREEN';

// 1. happy — the SAME record set produces the SAME verdict in every permutation.
//    Checked on the row's own observed counters: four families totalling 38
//    permutations each collapsing to exactly ONE position-free observable, no
//    permutation escaping a bare TypeError, and all three negative controls
//    discriminating (so the comparator ignores ORDER and nothing else).
const c1 = proofs.C1 ?? '';
const orderIndependent =
  artifactFullyGreen
  && /families=4;/.test(c1)
  && /permutations=38;/.test(c1)
  && /distinctPerFamily=1,1,1,1;/.test(c1)
  && /bareTypeErrors=0;/.test(c1)
  && /negControls\(addMalformed\/swapFlavour\/absent\)=discriminated/.test(c1);
if (orderIndependent) {
  emit(`ORDER_INDEPENDENT_VERDICT (38 permutations over 4 record sets collapse to 1 position-free observable each — same read result, same gap codes, same FULL diagnostic report, same quarantined set; 0 bare TypeErrors; comparator discriminated by all 3 negative controls)`);
}

// 2. edge — a malformed entry is REPORTED even when satisfying records precede
//    it, so `Array.prototype.some` short-circuiting can no longer hide it. All
//    12 (flavour × depth) cases report, none passes through silently, and every
//    one is attributed to its TRUE index — which is what makes C1's deliberate
//    index-stripping safe rather than a blind spot.
const c2 = proofs.C2 ?? '';
const reportedBehindSatisfier =
  artifactFullyGreen
  && /cases=12;/.test(c2)
  && /reportedAtTrueIndex=12\/12;/.test(c2)
  && /silentPassThrough=0\/12;/.test(c2)
  && /flavours=4; depths=1,2,3;/.test(c2)
  && /attributedIndexExact=12\/12;/.test(c2)
  && /attributedIndices=\[1,2,3,1,2,3,1,2,3,1,2,3\]/.test(c2)
  && /satisfierFirstReported=3;/.test(proofs.C3 ?? '')
  && /ordersAgree=true/.test(proofs.C3 ?? '');
if (reportedBehindSatisfier) {
  emit(`MALFORMED_REPORTED_BEHIND_SATISFIER (12/12 flavour x depth cases retained verbatim at their true index 1/2/3, 0/12 silent; and 3 malformed entries stacked behind one satisfier are ALL reported, so detection is exhaustive rather than first-match)`);
}

}

// ════════════════════════════════════════════════════════════════════════════
// PART 3 (marker 3) — the O2 silence, reproduced live against the same bytes
// ════════════════════════════════════════════════════════════════════════════
const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-2aa7-chk009';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-chk009-${process.pid}`);

const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'b2aa7', title: 'B-2aa7 CHK-009 receipt',
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

const ARTIFACT_DIR = join(root, loadConfig(root).storyDir, storyId);
const ARTIFACT_PATH = join(ARTIFACT_DIR, 'red-evidence.json');

const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};
const malformed = { id: 'corrupt' };

function canon(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
}
function writeEnvelope(records) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT_PATH, JSON.stringify(
    { schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW }, null, 2) + '\n', 'utf8');
}
const V1_ENVELOPE_KEYS = new Set(['schemaVersion', 'storyId', 'records', 'createdAt', 'updatedAt']);
function quarantineEntries(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const key of Object.keys(value)) {
    if (V1_ENVELOPE_KEYS.has(key) || !Array.isArray(value[key])) continue;
    out.push(...value[key]);
  }
  return out;
}
function codesOf(input) {
  return evaluateProofStoryDiagnostics(input).missingRedEvidence.map((row) => row.code);
}

let o2Pinned = false;
let detail = '';
try {
  // The row-O2 store: a SATISFYING record first, a malformed one after it.
  const STORED = [satisfying, malformed];
  writeEnvelope(STORED);

  const validated = proofStoryDiagnosticInput(store, storyId, root);
  // The PRE-FIX data path: the raw parsed value, straight into the typed domain,
  // with no artifact validation between `JSON.parse` and the gate.
  const unvalidated = { ...validated, redEvidence: JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) };

  const validatedCodes = codesOf(validated);
  const unvalidatedCodes = codesOf(unvalidated);

  const quarantined = quarantineEntries(validated.redEvidence);
  const hit = quarantined.find((q) => q !== null && typeof q === 'object' && q.index === 1);

  const silentWithoutValidation =
    // SATISFIED, with no throw — the gate never notices the corruption…
    unvalidatedCodes.length === 0
    // …because the malformed entry is still sitting in `records`, unreported…
    && canon(unvalidated.redEvidence.records) === canon(STORED)
    && quarantineEntries(unvalidated.redEvidence).length === 0;

  const surfacedWithValidation =
    // …whereas through the validated boundary the SAME bytes are quarantined at
    // their true index, retained verbatim, and removed from the clean set.
    hit !== undefined
    && canon(hit.value) === canon(malformed)
    && String(hit.reason ?? '').includes('[1]')
    && canon(validated.redEvidence.records) === canon([satisfying]);

  // The verdict is the SAME on both paths. That is the point: what the fix
  // changed is whether the corruption is REPORTED, not whether the gate passes —
  // so "the fix works" cannot be confused with "the gate started failing".
  const verdictUnchanged = validatedCodes.length === 0 && unvalidatedCodes.length === 0;

  o2Pinned = (canonicalCore || artifactFullyGreen) && silentWithoutValidation && surfacedWithValidation && verdictUnchanged;
  detail = `unvalidatedCodes=${JSON.stringify(unvalidatedCodes)}, unvalidatedQuarantined=${quarantineEntries(unvalidated.redEvidence).length}, `
    + `validatedCodes=${JSON.stringify(validatedCodes)}, validatedQuarantinedIndex=${hit?.index}`;
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 3. adversarial — the pre-fix behaviour is pinned, so the post-fix assertion is
//    not vacuous. Satisfier-first-then-malformed returns SATISFIED with NO THROW
//    and no corruption surfaced whenever the artifact is not validated at the
//    read boundary; the same bytes through the validated boundary are
//    quarantined at index 1. Same verdict, opposite visibility.
if (o2Pinned) {
  emit(`${canonicalCore ? 'CANONICAL_O2_BOUNDARY_DIFFERENTIAL' : 'O2_SILENT_CORRUPTION_PINNED'} (row O2 [satisfying, malformed]: with the read boundary BYPASSED the gate returns SATISFIED with no throw and the malformed record stays in \`records\` unreported; through the validated boundary the SAME bytes are quarantined verbatim at index 1 and removed from the clean set, with the verdict unchanged — ${detail})`);
}

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-chk009-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
}
