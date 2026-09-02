#!/usr/bin/env node
/**
 * F-005 / CL-003 regression receipt (B-2aa7) — the §3.3 expectedRedTargets
 * membership gate is DECOUPLED from the red-evidence artifact.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `assertTargetInExpected` (handlers/red-evidence.ts) built a whole
 * `proofStoryDiagnosticInput` just to call `resolveExpectedRedTargets`. That
 * shared builder eagerly calls `store.readRedEvidence()`, and this was the ONE
 * production call site of it that was not wrapped in
 * `withRedEvidenceCorruptionContext` (phase-gates.ts wraps both of its own). So a
 * corrupt `red-evidence.json` aborted the membership gate — a decision that never
 * reads the artifact — with a bare `RedEvidenceArtifactError` carrying neither
 * `redEvidenceRepairGuidance()` nor the NOT-ABSENCE sentence every other CHK-006
 * consumer attaches.
 *
 * It was sharpest inside ONE command: `red_evidence_binding_set` read the artifact
 * twice — once through the wrapped `readRedEvidenceForChain` and once through this
 * unwrapped call — so which message the operator saw depended on which read fired
 * first (rejected envelope → the bare unwrapped one; quarantined → the wrapped one).
 *
 * ── WHY red-b2aa7-chk006-receipt.mjs DID NOT CATCH IT ───────────────────────
 *
 * That receipt asserts each consumer NAMES the corruption, and the bare error does
 * carry the marker phrase. It passes identically before and after the fix. The
 * missing part was the ACTIONABLE remainder, which is what this file pins.
 *
 * ── WHAT IS PINNED ──────────────────────────────────────────────────────────
 *
 *   A. The binding path now emits the SAME actionable failure as the reference
 *      consumer: corruption marker + NOT-ABSENCE sentence + repair command +
 *      "Nothing written".
 *   B. The membership gate never reads the artifact: on a CORRUPT artifact an
 *      out-of-set target is refused by the MEMBERSHIP rule, which is only
 *      reachable if the gate ran to completion without touching red-evidence.
 *      (Pre-fix this same call aborted with the corruption error.)
 *   C. The computed set is UNCHANGED — the narrow input and the full
 *      `proofStoryDiagnosticInput` resolve to the same Set across fixtures, so no
 *      membership verdict moved.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-f005-receipt.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

// ── Fail-closed marker ledger ───────────────────────────────────────────────
// `proof-or-stop validate` grades by EXIT CODE alone, so a check that silently stopped
// holding would otherwise still exit 0. Every marker below is REQUIRED and the
// epilogue exits non-zero naming any that was withheld.
const REQUIRED_MARKERS = new Map([
  ['BINDING_SET_CORRUPTION_IS_ACTIONABLE',
    'red_evidence_binding_set went back to failing on a corrupt artifact WITHOUT the repair guidance / NOT-ABSENCE sentence / '
    + '"Nothing written" that every other CHK-006 consumer attaches — i.e. the unwrapped proofStoryDiagnosticInput call in '
    + 'assertTargetInExpected (or another unwrapped read on that path) is back'],
  ['MEMBERSHIP_GATE_DOES_NOT_READ_RED_EVIDENCE',
    'the §3.3 membership gate is coupled to red-evidence again: on a CORRUPT artifact an out-of-set target no longer reaches '
    + 'the membership refusal, meaning the gate now aborts on an artifact it never consults'],
  ['EXPECTED_RED_TARGETS_SET_UNCHANGED',
    'the narrow ExpectedRedTargetsInput no longer resolves to the same Set as the full proofStoryDiagnosticInput — the '
    + 'decoupling changed a membership verdict, which it must never do'],
]);

const emitted = new Set();
function emit(line) {
  const name = String(line).split(/[\s(]/)[0];
  if (!REQUIRED_MARKERS.has(name)) {
    console.error(`red-b2aa7-f005-receipt: marker "${name}" is not in the required ledger — reworded or stray marker.`);
    process.exitCode = 1;
    return;
  }
  emitted.add(name);
  console.log(line);
}

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { createProofStoryHandlers } = await import(`${DIST}/handlers/proofstory.js`);
const { createRedEvidenceHandlers } = await import(`${DIST}/handlers/red-evidence.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { computeMilestoneLedgerHash, resolveExpectedRedTargets } = await import(`${DIST}/core/proofstory.js`);
const { readTrustedProofStoryScopeArtifacts } = await import(`${DIST}/core/closeout-trust.js`);
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
const storyId = 'B-2aa7-f005';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-f005-${process.pid}`);
mkdirSync(root, { recursive: true });

const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'b2aa7-f005', title: 'B-2aa7 F-005 receipt',
  description: 'Fix an authentication session security regression (behavior change).',
  type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
});
store.writeChecklist(storyId, {
  items: [{ id: 'CHK-001', title: 'auth fix', status: 'done', startTime: NOW, endTime: NOW }],
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

const ARTIFACT_DIR = join(root, loadConfig(root).storyDir, storyId);
const ARTIFACT_PATH = join(ARTIFACT_DIR, 'red-evidence.json');

function writeRaw(text) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, 'utf8');
}
/** REJECTED envelope: the §10.2.1 E5 case — the JSON root is not an object. */
const setRejected = () => writeRaw('[]\n');
const setAbsent = () => { if (existsSync(ARTIFACT_PATH)) rmSync(ARTIFACT_PATH); };

function drive(setup, fn) {
  setup();
  try { return { threw: false, text: String(fn()) }; }
  catch (e) { return { threw: true, text: String(e && e.message ? e.message : e) }; }
}
const hasMarker = (o) => o.text.includes(RED_EVIDENCE_CORRUPT_MARKER);

// ════════════════════════════════════════════════════════════════════════════
// A. The binding path fails as ACTIONABLY as the reference consumer.
//
//    Measured against `red_evidence_get` — a correctly-wrapped CHK-006 consumer
//    — rather than against a string written here, so the bar cannot drift from
//    what production actually emits.
// ════════════════════════════════════════════════════════════════════════════
const reference = drive(setRejected, () => proofstory.red_evidence_get({ storyId }));
const bindingCorrupt = drive(setRejected,
  () => redEvidence.red_evidence_binding_set({ storyId, acceptanceTargetRef: 'M1', adapterId: 'ad', testCaseRef: 'tc' }));

// The two actionable parts the bare error was missing, derived FROM the reference
// output so this receipt pins production wording, not a local copy of it.
// Derived from production (see the import note above) so a brand rename cannot
// break this receipt, while a DROPPED guidance line still does. Asserted to be
// non-vacuous and to still name the diagnostic command + this story's id, so the
// derivation cannot degrade into comparing production against itself.
const repairCommand = redEvidenceRepairGuidance(storyId);
if (!repairCommand.includes('red_evidence_get') || !repairCommand.includes(`--storyId=${storyId}`)) {
  console.error(
    'red-b2aa7-f005-receipt: redEvidenceRepairGuidance no longer renders a `red_evidence_get --storyId=<id>` '
    + 'invocation, so the repair command this receipt pins is not actionable for an operator.',
  );
  process.exitCode = 1;
}
const notAbsenceSentence = 'This is CORRUPTION, not an absent or unconfigured artifact.';
const referenceIsWellFormed =
  hasMarker(reference)
  && reference.text.includes(repairCommand)
  && reference.text.includes(notAbsenceSentence);

// CONTROL: an ABSENT artifact must stay clean — a gate that shouted "corrupt"
// unconditionally would be the inverse defect and just as bad.
const bindingAbsent = drive(setAbsent,
  () => redEvidence.red_evidence_binding_set({ storyId, acceptanceTargetRef: 'M1', adapterId: 'ad', testCaseRef: 'tc' }));

const bindingIsActionable =
  referenceIsWellFormed
  && bindingCorrupt.threw
  && hasMarker(bindingCorrupt)
  && bindingCorrupt.text.includes(notAbsenceSentence)
  && bindingCorrupt.text.includes(repairCommand)
  && bindingCorrupt.text.includes('Nothing written')
  // …and the control stays clean.
  && !hasMarker(bindingAbsent)
  && bindingCorrupt.text !== bindingAbsent.text;

if (bindingIsActionable) {
  emit(
    'BINDING_SET_CORRUPTION_IS_ACTIONABLE (red_evidence_binding_set on a rejected envelope now carries the corruption marker, '
    + 'the NOT-ABSENCE sentence and the repair command — every actionable part the reference consumer red_evidence_get emits — '
    + 'plus "Nothing written"; control: an ABSENT artifact carries none of it and produces different output)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// B. The membership gate never reads the artifact.
//
//    On a CORRUPT artifact, an OUT-OF-SET target must be refused by the §3.3
//    MEMBERSHIP rule. That refusal is only reachable if the gate ran to
//    completion without touching red-evidence — pre-fix this exact call aborted
//    with the corruption error instead, because the gate built a full diagnostic
//    input. This is the decoupling, asserted by reachability rather than by
//    reading the source.
// ════════════════════════════════════════════════════════════════════════════
const outOfSetOnCorrupt = drive(setRejected,
  () => redEvidence.red_evidence_binding_set({ storyId, acceptanceTargetRef: 'NOT-A-TARGET', adapterId: 'ad', testCaseRef: 'tc' }));
// Same call on an ABSENT artifact — the membership verdict must be identical,
// i.e. the artifact's state is irrelevant to this decision.
const outOfSetOnAbsent = drive(setAbsent,
  () => redEvidence.red_evidence_binding_set({ storyId, acceptanceTargetRef: 'NOT-A-TARGET', adapterId: 'ad', testCaseRef: 'tc' }));

const membershipIsDecoupled =
  outOfSetOnCorrupt.threw
  && outOfSetOnCorrupt.text.includes('is not in expectedRedTargets')
  && outOfSetOnCorrupt.text.includes('§3.3 write-time membership gate')
  && outOfSetOnCorrupt.text.includes('nothing written')
  // The gate did NOT abort on the artifact it does not consult…
  && !hasMarker(outOfSetOnCorrupt)
  // …and the verdict is byte-identical to the absent-artifact run.
  && outOfSetOnCorrupt.text === outOfSetOnAbsent.text
  // Case-sensitivity of the membership rule is unchanged (a near-miss is refused).
  && drive(setAbsent, () => redEvidence.red_evidence_binding_set({ storyId, acceptanceTargetRef: 'm1', adapterId: 'ad', testCaseRef: 'tc' }))
    .text.includes('is not in expectedRedTargets');

if (membershipIsDecoupled) {
  emit(
    'MEMBERSHIP_GATE_DOES_NOT_READ_RED_EVIDENCE (on a CORRUPT artifact an out-of-set target is refused by the §3.3 MEMBERSHIP '
    + 'rule, not by an artifact abort — reachable only if the gate completed without reading red-evidence; the refusal is '
    + 'byte-identical to the absent-artifact run, carries no corruption marker, and case-sensitivity is unchanged)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// C. The computed set is UNCHANGED.
//
//    The narrow input the gate now builds must resolve to the same Set as the
//    full `proofStoryDiagnosticInput` did, over every fixture — including the
//    empty one. Compared on a CLEAN artifact because the full builder cannot be
//    evaluated on a corrupt one at all (which is the whole point).
// ════════════════════════════════════════════════════════════════════════════
setAbsent();
const sameSet = (id) => {
  const full = resolveExpectedRedTargets(proofStoryDiagnosticInput(store, id, root));
  // The SAME three readers production's `expectedRedTargetsInput` uses — the
  // ledger through `readTrustedProofStoryScopeArtifacts`, exactly as the full
  // builder does, so this pins the real equivalence rather than an easier one.
  const narrow = resolveExpectedRedTargets({
    originalIntentSnapshot: store.readOriginalIntentSnapshot(id),
    proofStoryContract: store.readProofStoryContract(id),
    milestoneLedger: readTrustedProofStoryScopeArtifacts(store, id).ledger,
  });
  const canon = (s) => JSON.stringify([...s].sort());
  return { equal: canon(full) === canon(narrow), size: full.size, targets: canon(full) };
};

const withLedger = sameSet(storyId);

// Second fixture: a story with NO ledger / contract / snapshot at all — the empty
// set must also agree, so the equality is not an artefact of one shape.
const emptyId = 'B-2aa7-f005-empty';
store.writeStory(emptyId, {
  storyId: emptyId, name: 'b2aa7-f005-empty', title: 'B-2aa7 F-005 receipt (empty)',
  description: 'No proofstory scope artifacts at all.',
  type: 'bug', phase: 'DEV', priority: 'low', createdAt: NOW, startedAt: NOW, endedAt: null,
});
const withoutLedger = sameSet(emptyId);

const setUnchanged =
  withLedger.equal && withoutLedger.equal
  // …and the populated fixture is genuinely non-trivial (an all-empty comparison
  // would make the equality vacuous).
  && withLedger.size > 0
  && withoutLedger.size === 0;

if (setUnchanged) {
  emit(
    `EXPECTED_RED_TARGETS_SET_UNCHANGED (the narrow ExpectedRedTargetsInput and the full proofStoryDiagnosticInput resolve to `
    + `the same Set on both fixtures: populated=${withLedger.targets} (size ${withLedger.size}, non-vacuous) and `
    + `bare-story=<empty>; no membership verdict moved)`,
  );
}

rmSync(root, { recursive: true, force: true });

// ── Fail closed ─────────────────────────────────────────────────────────────
const withheld = [...REQUIRED_MARKERS.keys()].filter((marker) => !emitted.has(marker));
if (withheld.length > 0) {
  console.error(
    `\nred-b2aa7-f005-receipt: ${withheld.length} of ${REQUIRED_MARKERS.size} required marker(s) WITHHELD. `
    + 'Each marker is printed ONLY when its check genuinely holds, so a withheld marker is a REGRESSION, not a neutral result:',
  );
  for (const marker of withheld) console.error(`  - ${marker}: ${REQUIRED_MARKERS.get(marker)}`);
  process.exitCode = 1;
} else {
  console.log('\nred-b2aa7-f005-receipt: OK (the §3.3 membership gate is decoupled from red-evidence; the binding path fails as actionably as every other CHK-006 consumer; the computed target set is unchanged)');
}
