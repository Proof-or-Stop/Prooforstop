#!/usr/bin/env node
/**
 * CHK-006 verification receipt (B-2aa7) — CONSUMER behaviour on a corrupt
 * red-evidence artifact (audit §9 and §10.4 rows C1 / C2 / C3).
 *
 * CHK-006's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and derives the verdict from a pinned
 * command's real output. This file is that pinned command.
 *
 * ── WHY IT IS NOT A NEW BLOCK IN THE SHARED ARTIFACT FILE ───────────────────
 *
 * `red-b2aa7-artifact-validation.mjs` is written SERIALLY by CHK-001, CHK-010,
 * CHK-009 and CHK-011 (plan.md "Parallelism": the one place the write sets
 * genuinely collide) and CHK-009 holds it now. CHK-006 therefore reports from
 * its own file, exactly as CHK-001, CHK-002, CHK-004 and CHK-010 did.
 *
 * ── WHAT IS ACTUALLY DRIVEN ─────────────────────────────────────────────────
 *
 * The REAL production consumers, reached BY SYMBOL through the built handlers
 * and gates — `createProofStoryHandlers`, `createRedEvidenceHandlers`,
 * `createStoryReviewHandlers`, `proofStoryDiagnosticInput`,
 * `getGuardFailureReason` — over a throwaway store. Nothing here re-implements a
 * consumer or asserts against a string a test author wrote.
 *
 * Every consumer is measured the same way, because "renders corruption" is not
 * the requirement — "renders corruption DISTINCTLY FROM ABSENCE" is:
 *
 *   1. it carries the shared corruption marker, AND
 *   2. its output DIFFERS from the same consumer's output on an ABSENT artifact,
 *   3. while the ABSENT and CLEAN runs carry NO marker at all.
 *
 * (3) is the discriminating control. Without it a consumer that shouted
 * "corrupt" unconditionally would pass, which is the inverse defect and just as
 * bad — an artifact that is merely not configured must never read as broken.
 *
 * Markers print ONLY when every one of their conditions is separately true, so a
 * pinned `--selector` cannot match a run in which any of them failed.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk006-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

// ── Fail-closed marker ledger ───────────────────────────────────────────────
// `proof-or-stop validate` grades a command by its EXIT CODE alone. Printing a marker
// only when a check holds is what makes the pinned selectors meaningful, but on
// its own it makes this file a crash-detector when run by validate: a regression
// would print fewer markers and STILL exit 0. Every marker below is therefore
// REQUIRED. `emit` records what was actually printed and the epilogue exits
// non-zero naming any marker that was withheld, and why that is a regression.
const REQUIRED_MARKERS = new Map([
  ['RED_EVIDENCE_GET_DISPLAYS_CORRUPTION',
    'the read path stopped DISPLAYING corruption and went back to aborting on it, or the quarantined original is no longer '
    + 'shown verbatim at records[1] with json status=corrupt, or a control broke (absent no longer renders "not configured", '
    + 'clean no longer renders "configured", or one of them now carries the corruption marker)'],
  ['RED_EVIDENCE_ADD_REPAIRS_WITHOUT_LOSS',
    'the repair round trip stopped being lossless: the malformed original is no longer preserved byte-identically on disk, a '
    + 'derived quarantine key is now persisted, the next read no longer re-quarantines the same entry, an unreadable envelope '
    + 'is no longer refused with an actionable "Nothing written" + repair command, or the clean write path changed'],
  ['EVERY_CONSUMER_DISTINGUISHES_CORRUPTION_FROM_ABSENCE',
    'some consumer re-derived by symbol no longer NAMES corruption for a rejected envelope or a quarantined record, no longer '
    + 'differs from its own absent-artifact output, or now marks an absent/clean artifact — i.e. corrupt evidence can read as '
    + 'merely absent again, which is the C3 silent-downgrade defect this row exists to keep out'],
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
      `red-b2aa7-chk006-receipt: emitted unregistered marker "${name}". Marker text is a pinned selector in this story's `
      + 'recorded verificationEvidence; renaming one invalidates that evidence. Update the ledger and the evidence together.',
    );
  }
  emitted.add(name);
  console.log(line);
}

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { computeMilestoneLedgerHash, appendRedEvidence } = await import(`${DIST}/core/proofstory.js`);
const { createProofStoryHandlers } = await import(`${DIST}/handlers/proofstory.js`);
const { createRedEvidenceHandlers } = await import(`${DIST}/handlers/red-evidence.js`);
const { createStoryReviewHandlers } = await import(`${DIST}/handlers/story-review.js`);
const { runReviewToTestPreflightGate, runLegacyReceiptTransitionGate } = await import(`${DIST}/handlers/phase-gates.js`);
const { getGuardFailureReason } = await import(`${DIST}/core/machine.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);

// The shared corruption vocabulary, imported from PRODUCTION rather than copied,
// so this receipt cannot drift from the phrase the consumers actually emit.
// `redEvidenceRepairGuidance` is imported for the same reason: the repair command
// it renders names the CLI bin, which is brand-dependent (B-cdf6 renamed it to
// `proof-or-stop` per docs/requirements/decisions/brand-rename-mapping.md:121,
// "Hardcoded `proofOrStop <cmd>` hints and error strings ... RENAMED"). Hardcoding the
// bin name here made this receipt fail on a pure rename while every behaviour it
// guards still held. Deriving it pins what production ACTUALLY emits — strictly
// stronger, because a dropped or reworded guidance line still fails the check.
const {
  RED_EVIDENCE_CORRUPT_MARKER,
  redEvidenceRepairGuidance,
} = await import(`${DIST}/core/red-evidence-artifact-validation.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-2aa7-chk006';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-chk006-${process.pid}`);

mkdirSync(root, { recursive: true });
writeFileSync(
  join(root, 'proof-or-stop.config.json'),
  JSON.stringify({ proofStory: { devGateMode: 'enforce', reviewGateMode: 'enforce', doneGateMode: 'enforce' } }, null, 2),
  'utf8',
);

const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'b2aa7', title: 'B-2aa7 CHK-006 receipt',
  description: 'Fix an authentication session security regression (behavior change).',
  type: 'bug', phase: 'PLAN', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
});
store.writeChecklist(storyId, {
  items: [{ id: 'CHK-001', title: 'auth fix', status: 'done', startTime: NOW, endTime: NOW }],
});
// B-a7c5 CHK-001: getGuardFailureReason's DEV branch now checks dev-memory
// preflight-ack FIRST, before the proofStoryDevGateFailure/red-evidence checks
// this receipt exists to exercise. Without this, every consumer variant
// (absent/clean/rejected/quarantined) would short-circuit to the SAME
// missing-ack message, making the 'core/machine.ts proofStoryDevGateFailure'
// row indistinguishable across cases -- not a real corruption-detection
// regression, just an earlier gate shadowing a later one this fixture never
// satisfied.
store.writeDevMemoryPreflightAck(storyId, {
  schemaVersion: 'lattice.dev_memory_preflight_ack.v1',
  storyId,
  packDigest: 'red-b2aa7-chk006-receipt-synthetic-digest',
  topHitIds: [],
  acknowledgedAt: NOW,
  acknowledgedBy: 'red-b2aa7-chk006-receipt',
});
const milestones = [{
  id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
  requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned',
}];
store.writeMilestoneLedger(storyId, {
  schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
  ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW,
});

const ctx = { store, root, scanRoot: root };
const proofstory = createProofStoryHandlers(ctx);
const redEvidence = createRedEvidenceHandlers(ctx);
const storyReview = createStoryReviewHandlers(ctx);

const ARTIFACT_DIR = join(root, loadConfig(root).storyDir, storyId);
const ARTIFACT_PATH = join(ARTIFACT_DIR, 'red-evidence.json');

/** A well-formed legacy v1 record that DOES satisfy the gate predicate. */
const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};
/** Malformed under the legacy v1 schema: every mandatory field but `id` is missing. */
const malformed = { id: 'corrupt' };

function writeRaw(text) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, 'utf8');
}
function writeEnvelope(records) {
  writeRaw(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW }, null, 2) + '\n');
}
function readRawArtifact() {
  return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));
}
function removeArtifact() {
  if (existsSync(ARTIFACT_PATH)) rmSync(ARTIFACT_PATH);
}

/** Recursive canonical form (keys sorted, undefined dropped). */
function canon(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
}

/**
 * Run a consumer ONCE over whatever is on disk and flatten "returned" / "threw"
 * to one string. Exactly once matters: some of these consumers write.
 */
function drive(setup, fn) {
  setup();
  try {
    const out = fn();
    return { threw: false, text: typeof out === 'string' ? out : JSON.stringify(out) };
  } catch (e) {
    return { threw: true, text: String(e?.message ?? e) };
  }
}
/** As {@link drive}, for the two phase gates whose entry point is async. */
async function driveAsync(setup, fn) {
  setup();
  try {
    const out = await fn();
    return { threw: false, text: typeof out === 'string' ? out : JSON.stringify(out) };
  } catch (e) {
    return { threw: true, text: String(e?.message ?? e) };
  }
}
const driveOnce = drive;

const hasMarker = (o) => o.text.includes(RED_EVIDENCE_CORRUPT_MARKER);

// The two corruption shapes, deliberately different in KIND:
//   REJECTED    — an envelope fault; the read boundary throws (rows E1/E2/E3).
//   QUARANTINED — a record fault; the read boundary does NOT throw, `records`
//                 arrives clean, and that is precisely how corruption sneaks
//                 through as absence.
const setAbsent = () => removeArtifact();
const setClean = () => writeEnvelope([satisfying]);
const setRejected = () => writeRaw(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records: 'x', createdAt: NOW, updatedAt: NOW }));
const setQuarantined = () => writeEnvelope([satisfying, malformed]);

// ════════════════════════════════════════════════════════════════════════════
// 1. happy — `red_evidence_get` DISPLAYS the corruption instead of aborting.
//
//    §9: this is the DIAGNOSTIC command, so a throwing read boundary breaks it
//    FIRST and locks the operator out of inspecting the file they must repair.
//    Both corruption shapes must be displayed, the quarantined originals must be
//    shown VERBATIM, and neither may reuse the not-configured wording.
// ════════════════════════════════════════════════════════════════════════════
const getAbsent = drive(setAbsent, () => proofstory.red_evidence_get({ storyId }));
const getClean = drive(setClean, () => proofstory.red_evidence_get({ storyId }));
const getRejected = drive(setRejected, () => proofstory.red_evidence_get({ storyId }));
const getQuarantined = drive(setQuarantined, () => proofstory.red_evidence_get({ storyId }));
const getQuarantinedJson = drive(setQuarantined, () => proofstory.red_evidence_get({ storyId, json: true }));

const displaysWithoutAborting =
  // DISPLAY, not abort: neither corruption shape throws out of the command…
  !getRejected.threw && !getQuarantined.threw
  // …both say CORRUPT…
  && hasMarker(getRejected) && hasMarker(getQuarantined)
  // …and neither is rendered with the ABSENT wording.
  && !getRejected.text.includes('not configured')
  && !getQuarantined.text.includes('not configured')
  // The quarantined originals are actually SHOWN, verbatim, with their index —
  // a summary count would not let an operator repair the file.
  && getQuarantined.text.includes('"id": "corrupt"')
  && getQuarantined.text.includes('records[1]')
  && JSON.parse(getQuarantinedJson.text).status === 'corrupt'
  && JSON.parse(getQuarantinedJson.text).corruption.records[0].index === 1
  // CONTROL: absence and cleanliness must NOT be reported as corruption, or the
  // marker would be unconditional and prove nothing.
  && !hasMarker(getAbsent) && !hasMarker(getClean)
  && getAbsent.text.includes('not configured')
  && getClean.text.includes('Red evidence: configured');

if (displaysWithoutAborting) {
  emit(
    'RED_EVIDENCE_GET_DISPLAYS_CORRUPTION (both a rejected envelope and a quarantined record are DISPLAYED, not aborted; '
    + 'the quarantined original is shown verbatim at records[1] and json status=corrupt; controls: absent still renders '
    + '"not configured" and clean still renders "configured", neither carrying the corruption marker)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. edge — `red_evidence_create` REPAIRS BY APPENDING WITHOUT LOSS, and refuses
//    with an actionable message where repair is impossible (§10.4 row C2).
//
//    THE ROUND TRIP IS THE POINT. Quarantine retains malformed records IN MEMORY
//    ONLY: `records` reaches the typed domain clean, so a read→append→write
//    consumer persists the clean subset and DELETES the originals from disk. The
//    negative control below runs the un-restored append LIVE and shows it losing
//    the record, so this row is gated on the restore actually happening.
// ════════════════════════════════════════════════════════════════════════════
const appendArgs = {
  storyId,
  trigger: 'repairing a corrupt artifact',
  acceptanceTargetRef: 'M1',
  baselineHeadHash: 'repair-head',
  baselineMaterialHash: 'repair-mat',
  observedFailure: 'still failing',
  failingCommand: 'npm test',
  greenRelation: 'same_acceptance',
  greenHeadHash: 'green-head',
  greenMaterialHash: 'green-mat',
  id: 'RED-repair',
};

// NEGATIVE CONTROL, executed rather than asserted: the rebuild every appender
// performs, fed the quarantined read result, with no restoration step.
setQuarantined();
const quarantinedRead = store.readRedEvidence(storyId);
const unrestored = appendRedEvidence(appendArgs, quarantinedRead);
const naiveAppendLosesTheOriginal =
  (quarantinedRead.malformedRecords ?? []).length === 1
  && !unrestored.records.some((r) => canon(r) === canon(malformed));

// THE ROUND TRIP: corrupt artifact -> red_evidence_create -> re-read from disk.
const beforeRepair = (setQuarantined(), readRawArtifact());
const repair = driveOnce(() => {}, () => proofstory.red_evidence_create(appendArgs));
const afterRepair = readRawArtifact();
const rereadAfterRepair = store.readRedEvidence(storyId);

const roundTripPreservesOriginals =
  !repair.threw
  // The malformed original is STILL ON DISK, byte-identical, at the index it
  // occupied before the repair.
  && canon(afterRepair.records[1]) === canon(beforeRepair.records[1])
  && canon(afterRepair.records[1]) === canon(malformed)
  // …the well-formed original kept its position…
  && canon(afterRepair.records[0]) === canon(satisfying)
  // …the repair record was APPENDED…
  && afterRepair.records.length === beforeRepair.records.length + 1
  && afterRepair.records.at(-1)?.id === 'RED-repair'
  // …the derived quarantine key was NOT persisted into the on-disk schema…
  && afterRepair.malformedRecords === undefined
  // …the next read still quarantines the same entry, so the artifact is
  // genuinely unchanged in that respect rather than laundered clean…
  && (rereadAfterRepair.malformedRecords ?? []).length === 1
  && rereadAfterRepair.malformedRecords[0].index === 1
  // …and the operator is TOLD the originals were kept.
  && repair.text.includes('Retained quarantined records: 1');

// Where repair by appending is impossible (no readable envelope at all), the
// command must REFUSE with an actionable message rather than overwrite the file
// — C2's second branch. Nothing may be written by that refusal.
const refuse = driveOnce(setRejected, () => proofstory.red_evidence_create(appendArgs));
const artifactAfterRefusal = readFileSync(ARTIFACT_PATH, 'utf8');
setRejected();

// Derived from production (see the import note above) so a brand rename cannot
// break this receipt, while a DROPPED guidance line still does. Asserted to be
// non-vacuous and to still name the diagnostic command + this story's id, so the
// derivation cannot degrade into comparing production against itself.
const repairCommand = redEvidenceRepairGuidance(storyId);
if (!repairCommand.includes('red_evidence_get') || !repairCommand.includes(`--storyId=${storyId}`)) {
  console.error(
    'red-b2aa7-chk006-receipt: redEvidenceRepairGuidance no longer renders a `red_evidence_get --storyId=<id>` '
    + 'invocation, so the repair command this receipt pins is not actionable for an operator.',
  );
  process.exitCode = 1;
}

const refusesActionably =
  refuse.threw
  && hasMarker(refuse)
  && refuse.text.includes('Nothing written')
  && refuse.text.includes(repairCommand)
  && artifactAfterRefusal === readFileSync(ARTIFACT_PATH, 'utf8');

// CONTROL: on a CLEAN artifact the write path is exactly what it was — no
// retention line, no quarantine key, one appended record.
const cleanAppend = driveOnce(setClean, () => proofstory.red_evidence_create(appendArgs));
const afterCleanAppend = readRawArtifact();
const cleanPathUnchanged =
  !cleanAppend.threw
  && !hasMarker(cleanAppend)
  && !cleanAppend.text.includes('Retained quarantined records')
  && afterCleanAppend.records.length === 2
  && canon(afterCleanAppend.records[0]) === canon(satisfying)
  && afterCleanAppend.malformedRecords === undefined;

if (naiveAppendLosesTheOriginal && roundTripPreservesOriginals && refusesActionably && cleanPathUnchanged) {
  emit(
    'RED_EVIDENCE_ADD_REPAIRS_WITHOUT_LOSS (round trip: corrupt artifact -> red_evidence_create -> re-read; the malformed '
    + 'original is still on disk byte-identically at records[1], the repair record is appended, no derived quarantine key '
    + 'is persisted, and the next read quarantines the same entry again; the un-restored append is shown LIVE to lose it; '
    + 'an unreadable envelope is refused with "Nothing written" and a repair command, writing nothing; control: the clean '
    + 'write path is unchanged)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. adversarial — EVERY consumer found by the fresh by-symbol sweep renders
//    corruption DISTINCTLY FROM ABSENCE, `story_review`'s advisory path (row C3)
//    included.
//
//    C3 is "the row that would otherwise let the fix look complete while a real
//    store degrades silently": that site CATCHES the read failure and renders
//    `unavailable (…)`, which reads as "feature not configured". So it is
//    asserted twice over — the marker must appear AND the old wording must not.
// ════════════════════════════════════════════════════════════════════════════
const consumers = [
  ['handlers/proofstory.ts red_evidence_get', () => proofstory.red_evidence_get({ storyId })],
  ['handlers/proofstory.ts red_evidence_create', () => proofstory.red_evidence_create(appendArgs)],
  ['handlers/proofstory.ts diagnosticInput (proofstory_gate_check)', () => proofstory.proofstory_gate_check({ storyId })],
  ['handlers/phase-gates.ts REVIEW completeness gate', () => runReviewToTestPreflightGate(ctx, storyId, { stop() {} })],
  ['handlers/phase-gates.ts DONE intent-equivalence gate', () => runLegacyReceiptTransitionGate(ctx, storyId, 'DONE')],
  ['core/machine.ts proofStoryDevGateFailure', () => String(getGuardFailureReason(storyId, store, 'DEV', root))],
  ['handlers/red-evidence.ts findV2Record', () => redEvidence.red_evidence_quarantine({ storyId, recordId: 'RED-v2', reason: 'chain control on a corrupt artifact' })],
  ['handlers/red-evidence.ts red_evidence_binding_set', () => redEvidence.red_evidence_binding_set({ storyId, acceptanceTargetRef: 'M1', adapterId: 'ad', testCaseRef: 'tc' })],
  ['handlers/story-review.ts story_review (C3 advisory path)', () => JSON.stringify(storyReview.story_review({ storyId, full: true }))],
];

const rows = [];
for (const [name, fn] of consumers) {
  const absent = await driveAsync(setAbsent, fn);
  const clean = await driveAsync(setClean, fn);
  const rejected = await driveAsync(setRejected, fn);
  const quarantined = await driveAsync(setQuarantined, fn);
  rows.push({
    name,
    // Corruption is NAMED…
    marked: hasMarker(rejected) && hasMarker(quarantined),
    // …and is NOT the same output the consumer produces for an absent artifact…
    distinct: rejected.text !== absent.text && quarantined.text !== absent.text,
    // …while absence and cleanliness stay free of it (the discriminating control).
    controlled: !hasMarker(absent) && !hasMarker(clean),
  });
}
const everyConsumerDistinguishes = rows.length === 9 && rows.every((r) => r.marked && r.distinct && r.controlled);

// C3, asserted specifically: the advisory section must no longer degrade to
// "unavailable (…)", which is the wording that reads as "not configured".
const reviewRejected = drive(setRejected, () => JSON.stringify(storyReview.story_review({ storyId, full: true })));
const reviewQuarantined = drive(setQuarantined, () => JSON.stringify(storyReview.story_review({ storyId, full: true })));
const reviewAbsent = drive(setAbsent, () => JSON.stringify(storyReview.story_review({ storyId, full: true })));
const c3NoLongerReadsAsUnconfigured =
  hasMarker(reviewRejected)
  && reviewRejected.text.includes('ProofStory Diagnostics (advisory only): CORRUPT')
  && !reviewRejected.text.includes('ProofStory Diagnostics (advisory only): unavailable')
  && hasMarker(reviewQuarantined)
  && reviewQuarantined.text.includes('proofstory_red_evidence_corrupt')
  && !hasMarker(reviewAbsent);

if (everyConsumerDistinguishes && c3NoLongerReadsAsUnconfigured) {
  emit(
    `EVERY_CONSUMER_DISTINGUISHES_CORRUPTION_FROM_ABSENCE (${rows.length}/${rows.length} consumers re-derived by symbol: `
    + `${rows.map((r) => r.name).join('; ')} — each names the corruption for BOTH a rejected envelope and a quarantined `
    + `record, each differs from its own absent-artifact output, and none marks an absent or clean artifact; C3: the `
    + `story_review advisory path renders "CORRUPT" and no longer renders "unavailable")`,
  );
}

rmSync(root, { recursive: true, force: true });

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-chk006-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
}
