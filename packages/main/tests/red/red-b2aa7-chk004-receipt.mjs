#!/usr/bin/env node
/**
 * CHK-004 verification receipt (B-2aa7) — read-boundary artifact validation with
 * D-4 quarantine.
 *
 * CHK-004's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and derives the verdict from a pinned
 * command's real output. This file is that pinned command.
 *
 * ── WHY IT IS NOT A NEW BLOCK IN THE SHARED ARTIFACT FILE ───────────────────
 *
 * `red-b2aa7-artifact-validation.mjs` is written SERIALLY by CHK-001, CHK-010,
 * CHK-009 and CHK-011 (plan.md "Parallelism": it is the one place the write sets
 * genuinely collide), and CHK-009/CHK-011 hold the next two turns. CHK-004
 * therefore reports from its own file, exactly as CHK-001, CHK-002 and CHK-010
 * did. It also lets this receipt cover a row the shared file has NO row for:
 * §10.2.1 **E6**, the FILE-level `schemaVersion`.
 *
 * ── WHAT MAKES THE MARKERS CONDITION-GATED ─────────────────────────────────
 *
 * Every observation drives the REAL production pair the live enforce gates call
 * — `store.readRedEvidence` for the read boundary, then
 * `evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(...))` for the
 * verdict — over a throwaway store. A marker prints ONLY when every one of its
 * conditions is separately true, so a pinned `--selector` cannot match a run in
 * which any of them failed. Each intent additionally carries a DISCRIMINATING
 * CONTROL: a fixture that differs from the positive case in exactly the member
 * under test, so a check that would hold for any artifact whatsoever cannot pass.
 *
 * ── OBSERVED PRE-FIX / POST-FIX SPLIT (the gating proof) ───────────────────
 *
 * Replayed against the pre-fix tree with the recipe in
 * `red-w2c-v1-verdict-invariance.mjs`'s header (`git archive HEAD` into a temp
 * dir, symlink node_modules, build, copy this file in), the markers observed
 * were:
 *
 *   pre-fix  : WELL_FORMED_ARTIFACT_LOADS_UNCHANGED
 *   post-fix : WELL_FORMED_ARTIFACT_LOADS_UNCHANGED, ENVELOPE_ROWS_E5_E6_E7,
 *              QUARANTINE_RETAINS_AND_ATTRIBUTES
 *
 * The two markers asserting NEW behaviour are therefore genuinely gated on the
 * fix. The first is deliberately NOT: happy:0 is a no-change intent ("loads
 * unchanged, verdict identical to pre-fix"), so it MUST hold on both trees — its
 * non-vacuity comes from its control, not from flipping. The validation leaf is
 * imported optionally for exactly this replay; on a tree without it,
 * `prototypeRejected` is false rather than an import crash.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk004-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
//
// NOTE ON THE PRE-FIX REPLAY described above: this file is fail-closed by
// design. On a tree without the fix its markers are SUPPOSED to be withheld, so
// the replay's expected outcome is a NON-ZERO exit naming them — which is the
// negative control stated positively, not a contradiction of it.
const canonicalCore = process.argv.includes('--canonical-core');
const REQUIRED_MARKERS = new Map([
  ['WELL_FORMED_ARTIFACT_LOADS_UNCHANGED',
    'a well-formed artifact no longer round-trips byte-identically through the read boundary, or it grew a quarantine '
    + 'surface, or the gate stopped returning SATISFIED, or the pre-fix-pinned five-scenario digest stopped reproducing — '
    + 'i.e. the fix changed behaviour on input that was never broken'],
  ['ENVELOPE_ROWS_E5_E6_E7',
    'an envelope row regressed: a non-object JSON root is read as ABSENT again (E5), a missing/unknown file-level '
    + 'schemaVersion silently degrades to v1 again (E6), or an unparseable file leaks a raw SyntaxError instead of a '
    + 'typed RedEvidenceArtifactError naming the path (E7)'],
  ['QUARANTINE_RETAINS_AND_ATTRIBUTES',
    'quarantine stopped RETAINING the rejected entry verbatim with its index/reason/violations, or the v1 field set is no '
    + 'longer fully enforced, or a blank observedFailure is no longer legacy-tolerated per D-5, or an envelope fault is '
    + 'misattributed as a record fault, or array / prototype-inherited records are no longer rejected'],
]);

if (canonicalCore) {
  REQUIRED_MARKERS.delete('WELL_FORMED_ARTIFACT_LOADS_UNCHANGED');
  REQUIRED_MARKERS.set('CANONICAL_WELL_FORMED_ARTIFACT', 'well-formed artifact roundtrip and malformed-record negative control must hold');
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
      `red-b2aa7-chk004-receipt: emitted unregistered marker "${name}". Marker text is a pinned selector in this story's `
      + 'recorded verificationEvidence; renaming one invalidates that evidence. Update the ledger and the evidence together.',
    );
  }
  emitted.add(name);
  console.log(line);
}

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);

// The CHK-004 validation leaf, imported OPTIONALLY so this receipt still RUNS on
// a tree where it does not exist. That is what makes the pre-fix replay a real
// negative control: the markers below must be suppressed because their
// CONDITIONS fail, not because the file aborted at import.
const partitionRedEvidenceRecords = await import(`${DIST}/core/red-evidence-artifact-validation.js`)
  .then((m) => m.partitionRedEvidenceRecords)
  .catch(() => null);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-2aa7-chk004';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-chk004-${process.pid}`);

const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'b2aa7', title: 'B-2aa7 CHK-004 receipt',
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

/** A well-formed legacy v1 record that DOES satisfy the gate predicate. */
const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};

function writeRaw(text) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, 'utf8');
}
function writeEnvelope(records, overrides = {}) {
  const envelope = { schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW, ...overrides };
  if (overrides.schemaVersion === undefined && 'schemaVersion' in overrides) delete envelope.schemaVersion;
  writeRaw(JSON.stringify(envelope, null, 2) + '\n');
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

/** Drive the REAL read boundary and the REAL gate pair over what is on disk. */
function observe(setup) {
  setup();
  const o = { readThrew: false, readError: null, readValue: undefined, threw: false, error: null, report: null, codes: null };
  try {
    o.readValue = store.readRedEvidence(storyId);
  } catch (e) {
    o.readThrew = true; o.readError = e;
  }
  try {
    const report = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root));
    o.report = canon(report);
    o.codes = report.missingRedEvidence.map((row) => row.code);
  } catch (e) {
    o.threw = true; o.error = e;
  }
  return o;
}

const RAW_BUILTINS = new Set([Error, TypeError, SyntaxError, RangeError, ReferenceError, EvalError, URIError]);
const isRawBuiltin = (e) => RAW_BUILTINS.has(e?.constructor);
const namesPath = (e) => String(e?.message ?? '').includes(ARTIFACT_PATH);
/** The misattribution signature: an ENVELOPE fault reported as a RECORD fault. */
const MISATTRIBUTES = /a record must be an object/i;

/** A typed envelope rejection that names the artifact and blames the envelope. */
function isTypedEnvelopeRejection(o, code) {
  return o.readThrew
    && !isRawBuiltin(o.readError)
    && o.readError?.name === 'RedEvidenceArtifactError'
    && o.readError?.code === code
    && namesPath(o.readError)
    && !MISATTRIBUTES.test(String(o.readError?.message));
}

// Baselines, computed from the real gate FIRST so every comparison below is an
// observed byte comparison rather than a claim.
const ABSENT = observe(removeArtifact);
const CLEAN = observe(() => writeEnvelope([satisfying]));

// ════════════════════════════════════════════════════════════════════════════
// 1. happy — a well-formed v1 artifact loads UNCHANGED and its gate verdict is
//    IDENTICAL TO PRE-FIX.
//
//    "Unchanged" is checked at the read boundary (the envelope and its records
//    round-trip byte-identically and acquire no quarantine surface). "Identical
//    to pre-fix" is checked by running the PROTECTED invariance harness as a
//    child process: its digest was pinned on the PRE-FIX tree by CHK-002, so a
//    match is a direct pre-fix/post-fix comparison, not a self-report.
// ════════════════════════════════════════════════════════════════════════════
const V1_VERDICT_DIGEST = '2d584cc157e83ebb2f8396735f04d46946f0ba90d18a55d9fb2f263d706a11ec';
const invariance = canonicalCore ? null : spawnSync(process.execPath, [join(here, 'red-w2c-v1-verdict-invariance.mjs')], { encoding: 'utf8' });
const invarianceOut = `${invariance?.stdout ?? ''}${invariance?.stderr ?? ''}`;

const cleanEnvelopeOnDisk = { schemaVersion: 'proofstory.red_evidence.v1', storyId, records: [satisfying], createdAt: NOW, updatedAt: NOW };
const clean = observe(() => writeEnvelope([satisfying]));
// The DISCRIMINATING CONTROL: the same envelope with one malformed record
// appended MUST NOT be reported as unchanged, or "unchanged" would hold for any
// artifact whatsoever.
const controlDirty = observe(() => writeEnvelope([satisfying, { id: 'corrupt' }]));

const loadsUnchanged =
  !clean.readThrew && !clean.threw
  && canon(clean.readValue) === canon(cleanEnvelopeOnDisk)
  && clean.readValue.malformedRecords === undefined
  && Array.isArray(clean.codes) && clean.codes.length === 0
  && canon(controlDirty.readValue) !== canon(cleanEnvelopeOnDisk);
const verdictIdenticalToPreFix = invariance?.status === 0 && invarianceOut.includes(V1_VERDICT_DIGEST);

if (canonicalCore && loadsUnchanged) {
  emit('CANONICAL_WELL_FORMED_ARTIFACT (byte-identical clean roundtrip, satisfied gate, malformed negative control; invariance scheduled independently)');
}
if (!canonicalCore && loadsUnchanged && verdictIdenticalToPreFix) {
  emit(
    `WELL_FORMED_ARTIFACT_LOADS_UNCHANGED (envelope + records round-trip byte-identically, no quarantine surface, gate SATISFIED; `
    + `the pre-fix-pinned five-scenario digest ${V1_VERDICT_DIGEST} still reproduces; control=one malformed record appended is discriminated)`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. edge — envelope rows E5, E6 and E7 each behave as specified.
// ════════════════════════════════════════════════════════════════════════════

// E5 — a JSON root that is not an object is REJECTED, not read as ABSENT.
// Pre-fix each of these flowed through as the raw parsed value and produced a
// report byte-identical to an absent artifact, which is why "does not equal the
// ABSENT report" is asserted alongside the typed rejection.
const e5 = ['[]', '"x"', 'null', '42'].map((text) => {
  const o = observe(() => writeRaw(text));
  return isTypedEnvelopeRejection(o, 'root_not_object') && o.report !== ABSENT.report;
});
const e5Rejected = e5.length === 4 && e5.every(Boolean);

// E6 — a missing / unknown FILE-level schemaVersion must NOT silently degrade to
// v1 (D-1: the FILE declares the era). Both fixtures carry the SAME satisfying
// v1 record as CLEAN, so the only difference from an artifact that SATISFIES the
// gate is the envelope's `schemaVersion` member: the rejection is caused by that
// member alone, which is the discriminating control for this row.
const e6Missing = observe(() => writeRaw(JSON.stringify({ storyId, records: [satisfying], createdAt: NOW, updatedAt: NOW })));
const e6Unknown = observe(() => writeRaw(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v9', storyId, records: [satisfying], createdAt: NOW, updatedAt: NOW })));
const e6NoDegrade =
  isTypedEnvelopeRejection(e6Missing, 'schema_version_missing')
  && isTypedEnvelopeRejection(e6Unknown, 'schema_version_unknown')
  // …and the control proves the record itself would otherwise have SATISFIED.
  && Array.isArray(CLEAN.codes) && CLEAN.codes.length === 0;

// E7 — an unparseable file must STILL THROW, but a TYPED error NAMING THE PATH.
// The absence of a throw would NOT satisfy this row, so `readThrew` is required.
const e7 = observe(() => writeRaw('{ this is not json'));
const e7Typed =
  e7.readThrew
  && !isRawBuiltin(e7.readError)
  && !(e7.readError instanceof SyntaxError)
  && e7.readError?.name === 'RedEvidenceArtifactError'
  && e7.readError?.code === 'unparseable'
  && namesPath(e7.readError);

if (e5Rejected && e6NoDegrade && e7Typed) {
  emit(
    `ENVELOPE_ROWS_E5_E6_E7 (E5: 4/4 non-object roots rejected as root_not_object and no longer read as ABSENT; `
    + `E6: missing -> schema_version_missing and unknown -> schema_version_unknown, neither degrading to v1 while the same record SATISFIES under a v1 envelope; `
    + `E7: still THROWS, typed RedEvidenceArtifactError(unparseable) naming the path, not a raw SyntaxError)`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. adversarial — quarantine RETAINS and the fault is ATTRIBUTED correctly.
// ════════════════════════════════════════════════════════════════════════════

// Retain-and-report. The malformed entry is removed from `records` but kept
// VERBATIM with its index, its identifying field and the reason — a clean empty
// array would read exactly like an absent artifact.
const malformed = { id: 'corrupt' };
const quarantined = observe(() => writeEnvelope([satisfying, malformed]));
const entries = quarantined.readValue?.malformedRecords ?? [];
const entry = entries[0];
const retainedAndReported =
  !quarantined.readThrew && !quarantined.threw
  && entries.length === 1
  && entry.index === 1                                  // the ON-DISK position
  && entry.id === 'corrupt'                             // the identifying field
  && canon(entry.value) === canon(malformed)            // RETAINED verbatim
  && typeof entry.reason === 'string' && entry.reason.includes('missing:observedFailure')
  && canon(quarantined.readValue.records) === canon([satisfying]);

// The FULL v1 field set is enforced, not just the field the predicate reads: a
// record missing ONLY `trigger` is SATISFIED pre-fix and is the witness that
// full validation (D-3 Axis A = (ii)) rather than the rejected narrow option
// was implemented.
const { trigger: _dropped, ...noTrigger } = satisfying;
const fullValidation = observe(() => writeEnvelope([noTrigger]));
const fullFieldSetEnforced =
  (fullValidation.readValue?.malformedRecords ?? []).length === 1
  && (fullValidation.readValue.malformedRecords[0].violations ?? []).includes('missing:trigger');

// D-5, the one place quarantine is deliberately OVERRIDDEN: a blank
// `observedFailure` is legacy-tolerated. It must stay UNSATISFIED with NO new
// diagnostic and must NEVER be quarantined, or scenario 3 of the invariance
// harness changes shape and the pinned digest moves.
const blank = observe(() => writeEnvelope([{ ...satisfying, observedFailure: '   ' }]));
const blankToleratedNotQuarantined =
  !blank.readThrew && !blank.threw
  && blank.readValue?.malformedRecords === undefined
  && canon(blank.codes) === canon(['missing_red_evidence'])
  && blank.report === ABSENT.report;

// An ENVELOPE fault is NEVER reported as a RECORD fault. Pre-fix `records: "x"`
// iterated the string's CHARACTERS and reported `a record must be an object`,
// blaming a record that does not exist and naming no artifact.
const envelopeString = observe(() => writeRaw(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records: 'x', createdAt: NOW, updatedAt: NOW })));
const notMisattributed =
  isTypedEnvelopeRejection(envelopeString, 'records_not_array')
  && /envelope/i.test(String(envelopeString.readError?.message))
  && (envelopeString.readValue?.malformedRecords ?? []).length === 0;

// An ARRAY record is rejected: `typeof [] === 'object'` and it carries no
// `schemaVersion`, so the schema classifier still calls it 'v1'.
const arrayRecord = observe(() => writeEnvelope([[]]));
const arrayRejected =
  (arrayRecord.readValue?.malformedRecords ?? []).length === 1
  && (arrayRecord.readValue.malformedRecords[0].violations ?? []).some((v) => v.startsWith('not-a-plain-object'));

// A PROTOTYPE-INHERITED `observedFailure` is rejected. `JSON.parse` cannot build
// such a value, so this drives the production leaf directly — the same function
// the read boundary calls — rather than pretending it can come off disk.
const inherited = Object.create({ observedFailure: 'inherited, not stored' });
Object.assign(inherited, { ...satisfying, observedFailure: undefined });
delete inherited.observedFailure;
const nullProto = Object.assign(Object.create(null), satisfying);
const protoPartition = partitionRedEvidenceRecords
  ? partitionRedEvidenceRecords([inherited, nullProto])
  : { records: [], malformed: [] };
const prototypeRejected =
  partitionRedEvidenceRecords !== null
  // The inherited value is visible to a plain `record.observedFailure` read…
  && inherited.observedFailure === 'inherited, not stored'
  // …but it is not a STORED field, so it counts as missing and is quarantined.
  && protoPartition.malformed.length === 1
  && protoPartition.malformed[0].index === 0
  && protoPartition.malformed[0].violations.includes('missing:observedFailure')
  // Control: a null-PROTOTYPE object whose fields are genuinely OWN is accepted,
  // so this row rejects prototype REACH-THROUGH, not exotic containers.
  && protoPartition.records.length === 1;

if (retainedAndReported && fullFieldSetEnforced && blankToleratedNotQuarantined && notMisattributed && arrayRejected && prototypeRejected) {
  emit(
    `QUARANTINE_RETAINS_AND_ATTRIBUTES (rejected entry RETAINED verbatim at index=1 id="corrupt" with reason and violations while records stays clean; `
    + `full v1 field set enforced (missing:trigger flips a record the predicate never reads); `
    + `blank observedFailure legacy-tolerated per D-5 — UNSATISFIED, no new diagnostic, never quarantined; `
    + `envelope fault reported as records_not_array naming the path, never as "a record must be an object"; `
    + `array record and prototype-inherited observedFailure both rejected, own-field null-prototype control accepted)`,
  );
}

rmSync(root, { recursive: true, force: true });

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-chk004-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
}
