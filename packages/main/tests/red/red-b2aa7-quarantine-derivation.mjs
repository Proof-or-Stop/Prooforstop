#!/usr/bin/env node
/**
 * B-2aa7 — `malformedRecords` INJECTION at the read boundary (cross-host HIGH).
 *
 * ── THE DEFECT THIS REPRODUCES ──────────────────────────────────────────────
 *
 * `malformedRecords` is DERIVED state: what the validator concluded about one
 * read. It is not part of the on-disk schema and an artifact does not get to
 * assert it about itself.
 *
 * It could. When every record validated, `classifyRedEvidenceArtifact` returned
 * the parsed envelope UNCHANGED, so a `malformedRecords` key sitting ON DISK —
 * planted by a crafted artifact, or merely left behind by a stale one — survived
 * into the typed domain. `redEvidenceQuarantinedRecords` then read it as trusted
 * read-time classification, and `retainQuarantinedRecordsOnWrite` iterated it and
 * re-inserted each entry's `value` into `records`. Measured on the pre-fix tree:
 *
 *     read:  records = [ 'RED-ok' ] ; malformedRecords treated as trusted = true
 *     write: records = [ 'INJECTED-PAYLOAD', 'RED-ok' ]      <-- and it is on disk
 *
 * `records` is the evidence the live DEV / REVIEW / DONE gates read, so this is
 * a write primitive into gate evidence, reachable from a file. A non-array value
 * under the same key was additionally a CRASH: `.map` in
 * `renderRedEvidenceQuarantineNotice` — which runs on `core/machine.ts`,
 * `handlers/phase-gates.ts` and `handlers/story-review.ts` — and `for…of` in the
 * write path. A STRING was worse than a crash: it iterated as its own
 * CHARACTERS, the same misattribution class §2.4 removed from the record path.
 *
 * This is the story's own thesis failing on its own code: the guard added to stop
 * unvalidated data being trusted was itself trusting an unvalidated on-disk field.
 *
 * ── WHAT MUST HOLD ──────────────────────────────────────────────────────────
 *
 *   1. DERIVED, NEVER INHERITED. Whatever the read path reports under
 *      `malformedRecords` is this read's own classification — including the
 *      all-records-valid case, where the answer is "none" and the key is absent.
 *      A planted value is stripped, not merged, not honoured.
 *   2. NOT INJECTABLE. Nothing planted can reach `records` on a subsequent write.
 *      Asserted on the RAW BYTES on disk, not through the read boundary, which
 *      would hide it.
 *   3. TOTAL. A non-array, or an array of junk, crashes neither the read, nor the
 *      live gate pair, nor the operator notice, nor the write.
 *   4. NO REGRESSION. A genuinely malformed record is still quarantined, still
 *      survives the write verbatim and in place, and is still re-derived by the
 *      next read. (The concurrent case is `red-b2aa7-write-quarantine-race.mjs`.)
 *
 * Every case is driven through the REAL `store.readRedEvidence` /
 * `store.writeRedEvidence` and the REAL gate pair the enforce gates call
 * (`proofStoryDiagnosticInput` → `evaluateProofStoryDiagnostics`), never through
 * the validator in isolation — the injection is only interesting because it lands
 * in gate evidence.
 *
 * Non-vacuity is asserted twice: the injection detector is re-run over a
 * deliberately injected disk state and must flag it, and the acceptance rule that
 * filters junk is shown to accept 100% of GENUINELY derived entries, so a clean
 * result cannot come from a filter that rejects everything.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-quarantine-derivation.mjs
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);
const {
  redEvidenceQuarantinedRecords,
  renderRedEvidenceQuarantineNotice,
} = await import(`${DIST}/core/red-evidence-artifact-validation.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const STORY_ID = 'B-2aa7-quarantine-derivation';

const failures = [];
const fail = (check, why) => failures.push(`${check}: ${why}`);
const canon = (v) => JSON.stringify(v);
const ids = (rs) => (Array.isArray(rs) ? rs.map((r) => (r && typeof r === 'object' ? (r.id ?? '<no id>') : String(r))) : `<not an array: ${canon(rs)}>`);

/** A well-formed legacy v1 record: it must be untouched by every case below. */
const OK_RECORD = {
  id: 'RED-ok', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance' },
  createdAt: NOW,
};

/** A v1 RESIDUAL record (no per-record schemaVersion) that violates the v1 schema. */
const GENUINELY_MALFORMED = { id: 'LEGACY-broken', trigger: 'hand-edited on disk' };

/** The payload a planted classification tries to smuggle into `records`. */
const PAYLOAD = { id: 'INJECTED-PAYLOAD', trigger: 'never validated by anything' };

/** A structurally PERFECT quarantine entry — same shape the validator derives. */
const plantedEntry = (index, value) => ({
  index,
  id: (value && value.id) ?? null,
  reason: `records[${index}] planted by a crafted or stale artifact`,
  violations: ['planted'],
  value,
});

/** A throwaway store with a live red-evidence trigger and a confirmed ledger. */
function seed(records, planted) {
  const root = mkdtempSync(join(tmpdir(), 'red-b2aa7-derivation-'));
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, {
    storyId: STORY_ID, name: 'b2aa7', title: 'B-2aa7 quarantine derivation',
    description: 'Fix an authentication session security regression (behavior change).',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
  });
  const milestones = [{
    id: 'M1', sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
    requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned',
  }];
  store.writeMilestoneLedger(STORY_ID, {
    schemaVersion: 'proofstory.milestone_ledger.v1', storyId: STORY_ID, state: 'confirmed',
    ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW,
  });

  const artifactPath = join(root, loadConfig(root).storyDir, STORY_ID, 'red-evidence.json');
  const envelope = { schemaVersion: 'proofstory.red_evidence.v1', storyId: STORY_ID, createdAt: NOW, updatedAt: NOW };
  // `records` is omitted entirely when null: the records-less envelope is the
  // shortest injection vector of all — nothing to validate, and a fabricated
  // classification straight into the typed domain.
  if (records !== null) envelope.records = records;
  if (planted !== undefined) envelope.malformedRecords = planted;
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  return { root, store, artifactPath };
}

/** The raw bytes on disk — NOT the read boundary, which would hide an injection. */
const readRaw = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** A bare builtin escaping is a CRASH; the module's own typed errors are not. */
const isRawBuiltin = (e) => e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError;

/**
 * Drive every live surface over one on-disk artifact and report what happened.
 * Nothing here throws: a crash is DATA, so a crashing surface is reported as a
 * failed check rather than aborting the file at the first one.
 */
function observe(records, planted) {
  const { root, store, artifactPath } = seed(records, planted);
  const o = { crashes: [], read: null, quarantined: [], notice: null, wrote: false, disk: null, reread: null };
  const run = (label, fn) => {
    try {
      return fn();
    } catch (e) {
      if (isRawBuiltin(e)) o.crashes.push(`${label}: ${e.constructor.name}: ${e.message}`);
      else o.crashes.push(`${label}: ${e?.constructor?.name ?? 'Error'}: ${e?.message ?? String(e)}`);
      return undefined;
    }
  };
  try {
    o.read = run('read', () => store.readRedEvidence(STORY_ID)) ?? null;
    o.quarantined = run('quarantinedRecords', () => redEvidenceQuarantinedRecords(o.read)) ?? [];
    o.notice = run('renderNotice', () => renderRedEvidenceQuarantineNotice(STORY_ID, o.read)) ?? null;
    // The LIVE gate pair: this is where a `.map` on a non-array used to escape.
    run('gate', () => evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, STORY_ID, root)));
    // A read-then-write round trip, which is what every appender in the system does.
    o.wrote = run('write', () => { store.writeRedEvidence(STORY_ID, o.read); return true; }) === true;
    o.disk = run('readRaw', () => readRaw(artifactPath)) ?? null;
    o.reread = run('reread', () => store.readRedEvidence(STORY_ID)) ?? null;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return o;
}

/**
 * THE INJECTION DETECTOR. Re-used below on a deliberately injected disk state, so
 * a clean verdict cannot be the detector failing to look.
 */
const injectedInto = (diskRecords) =>
  (Array.isArray(diskRecords) ? diskRecords : []).some((r) => canon(r) === canon(PAYLOAD) || (r && r.id === PAYLOAD.id));

// ════════════════════════════════════════════════════════════════════════════
// 1. happy — a planted classification over ALL-VALID records is neither trusted
//    nor injectable. THE ROW THE CROSS-HOST REVIEWER REPRODUCED BY HAND.
// ════════════════════════════════════════════════════════════════════════════
{
  const o = observe([OK_RECORD], [plantedEntry(0, PAYLOAD)]);
  if (o.crashes.length > 0) fail('happy', `a planted classification crashed a live surface: ${o.crashes.join(' | ')}`);
  if (o.read !== null && o.read.malformedRecords !== undefined) {
    fail('happy',
      'the planted `malformedRecords` SURVIVED INTO THE TYPED DOMAIN. Every record validated, so this read derived NO '
      + `quarantine, yet the typed value carries ${canon(o.read.malformedRecords)} — the artifact asserted a fact about a `
      + 'read that had not happened. It must be stripped, not inherited.');
  }
  if (o.quarantined.length !== 0) {
    fail('happy', `the planted entry was treated as trusted read-time classification (${o.quarantined.length} entr(ies) reported)`);
  }
  if (o.notice !== null) fail('happy', 'a clean artifact rendered a corruption notice, which is the inverse defect: a false corruption report');
  if (injectedInto(o.disk?.records)) {
    fail('happy',
      `THE PLANTED PAYLOAD WAS INJECTED INTO ON-DISK \`records\`: ${canon(ids(o.disk.records))}. `
      + '`records` is the evidence the live DEV / REVIEW / DONE gates read, so this is a write primitive into gate evidence '
      + 'reachable from a file.');
  }
  if (canon(o.disk?.records) !== canon([OK_RECORD])) {
    fail('happy', `the round trip did not leave the one well-formed record alone: ${canon(ids(o.disk?.records))}`);
  }
  if (Object.prototype.hasOwnProperty.call(o.disk ?? {}, 'malformedRecords')) {
    fail('happy', 'the write persisted a `malformedRecords` key; it is read-time classification, never part of the on-disk schema');
  }

  // NON-VACUITY — the detector flags the very injection this row denies.
  if (!injectedInto([PAYLOAD, OK_RECORD]) || injectedInto([OK_RECORD])) {
    fail('happy', 'the injection detector did not discriminate an injected records array from a clean one, so a clean verdict proves nothing');
  }
}

// A records-less envelope: nothing to validate, so nothing may be derived either.
{
  const o = observe(null, [plantedEntry(0, PAYLOAD)]);
  if (o.crashes.length > 0) fail('happy-recordless', `a records-less planted artifact crashed a live surface: ${o.crashes.join(' | ')}`);
  if (o.read !== null && o.read.malformedRecords !== undefined) {
    fail('happy-recordless', 'a records-less envelope inherited a planted `malformedRecords`; an artifact with no records cannot have had one quarantined');
  }
  if (injectedInto(o.disk?.records)) fail('happy-recordless', `the payload was injected into a records-less artifact: ${canon(ids(o.disk?.records))}`);
}

if (failures.length === 0) {
  console.log(
    'DERIVED_NOT_INHERITED (an artifact whose records ALL validate, plus a structurally perfect hand-written '
    + '`malformedRecords` entry carrying INJECTED-PAYLOAD: the read reports NO quarantine and carries no `malformedRecords` '
    + 'key at all, no corruption notice is rendered, and a read-then-write round trip leaves the on-disk `records` array '
    + 'byte-identical — the payload never reaches gate evidence. Same for a records-less envelope. Detector proven to '
    + 'discriminate an injected array from a clean one)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. edge — TOTALITY. A non-array under that key must not crash anything.
//
//    A string is called out separately: pre-fix it did not merely crash, it
//    ITERATED AS ITS OWN CHARACTERS and reported six quarantined "records".
// ════════════════════════════════════════════════════════════════════════════
const NON_ARRAYS = [
  ['object', { nope: 1 }],
  ['string', 'string'],
  ['number', 42],
  ['null', null],
  ['boolean', true],
  ['nested-array-lookalike', { length: 2, 0: plantedEntry(0, PAYLOAD) }],
];
let nonArrayOk = true;
for (const [label, planted] of NON_ARRAYS) {
  const o = observe([OK_RECORD], planted);
  if (o.crashes.length > 0) {
    nonArrayOk = false;
    fail('edge', `\`malformedRecords\` = ${label} crashed a live surface: ${o.crashes.join(' | ')}`);
  }
  if (o.quarantined.length !== 0) {
    nonArrayOk = false;
    fail('edge',
      `\`malformedRecords\` = ${label} yielded ${o.quarantined.length} "quarantined record(s)". A non-array is not a `
      + 'classification; for a string this is character iteration, the §2.4 misattribution in a new place.');
  }
  if (o.notice !== null) { nonArrayOk = false; fail('edge', `\`malformedRecords\` = ${label} rendered a corruption notice for an artifact with no malformed record`); }
  if (!o.wrote) { nonArrayOk = false; fail('edge', `\`malformedRecords\` = ${label} made the write refuse, so a junk key is a denial of service on an otherwise valid artifact`); }
  if (canon(o.disk?.records) !== canon([OK_RECORD])) { nonArrayOk = false; fail('edge', `\`malformedRecords\` = ${label} altered the on-disk records: ${canon(ids(o.disk?.records))}`); }
  if (Object.prototype.hasOwnProperty.call(o.disk ?? {}, 'malformedRecords')) { nonArrayOk = false; fail('edge', `\`malformedRecords\` = ${label} was persisted to disk`); }
}
if (nonArrayOk) {
  console.log(
    `NON_ARRAY_CLASSIFICATION_IS_TOTAL (${NON_ARRAYS.length} non-array values planted under \`malformedRecords\` — `
    + `${NON_ARRAYS.map(([l]) => l).join(', ')} — each read, gate-evaluated, rendered, written and re-read with no raw `
    + 'builtin escaping, no quarantine reported, no corruption notice, no refusal, and the on-disk records untouched; the '
    + 'string case in particular no longer iterates as its own characters)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 3. adversarial — JUNK ENTRIES inside a well-formed array. `index` and `value`
//    are exactly what the write path dereferences, so this is where a crafted
//    entry buys either a crash or an injected record.
// ════════════════════════════════════════════════════════════════════════════
const JUNK_ENTRIES = [
  ['null entry', [null]],
  ['string entry', ['x']],
  ['array entry', [[]]],
  ['no index', [{ id: null, reason: 'r', violations: [], value: PAYLOAD }]],
  ['index is a string', [{ ...plantedEntry(0, PAYLOAD), index: 'NaN' }]],
  ['index is a float', [{ ...plantedEntry(0, PAYLOAD), index: 0.5 }]],
  ['index is negative', [{ ...plantedEntry(0, PAYLOAD), index: -1 }]],
  ['index is huge', [{ ...plantedEntry(0, PAYLOAD), index: 9_999 }]],
  ['no value key', [{ index: 0, id: null, reason: 'r', violations: [] }]],
  ['reason is not a string', [{ ...plantedEntry(0, PAYLOAD), reason: 42 }]],
  ['violations is not an array', [{ ...plantedEntry(0, PAYLOAD), violations: 'planted' }]],
  ['id is an object', [{ ...plantedEntry(0, PAYLOAD), id: { evil: true } }]],
  ['duplicate indices', [plantedEntry(0, PAYLOAD), plantedEntry(0, PAYLOAD)]],
  ['prototype-inherited entry', [Object.assign(Object.create(plantedEntry(0, PAYLOAD)), {})]],
  ['good entry beside junk', [plantedEntry(0, PAYLOAD), null]],
];
let junkOk = true;
for (const [label, planted] of JUNK_ENTRIES) {
  const o = observe([OK_RECORD], planted);
  if (o.crashes.length > 0) {
    junkOk = false;
    fail('adversarial', `a junk quarantine entry (${label}) crashed a live surface: ${o.crashes.join(' | ')}`);
  }
  if (injectedInto(o.disk?.records)) {
    junkOk = false;
    fail('adversarial', `a junk quarantine entry (${label}) INJECTED its value into on-disk records: ${canon(ids(o.disk?.records))}`);
  }
  if (canon(o.disk?.records) !== canon([OK_RECORD])) {
    junkOk = false;
    fail('adversarial',
      `a junk quarantine entry (${label}) altered the on-disk records to ${canon(ids(o.disk?.records))}. An entry whose `
      + '`value` is absent restores `undefined`, which serialises as a bare `null` record — an injection that does not even '
      + 'need a payload.');
  }
  if (o.quarantined.length !== 0) { junkOk = false; fail('adversarial', `a junk quarantine entry (${label}) was accepted as derived classification`); }
  if (!o.wrote) { junkOk = false; fail('adversarial', `a junk quarantine entry (${label}) made the write refuse, which is a denial of service reachable from a file`); }
}
if (junkOk) {
  console.log(
    `JUNK_ENTRIES_NEITHER_CRASH_NOR_INJECT (${JUNK_ENTRIES.length} malformed quarantine-entry shapes — including a null `
    + 'entry, a missing/float/negative/out-of-range/string `index`, a missing `value` whose restore would serialise as a bare '
    + 'null record, duplicate indices, and a prototype-inherited entry — each read, gate-evaluated, rendered, written and '
    + 're-read with no raw builtin escaping, nothing accepted as classification, nothing injected, and no refusal)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 4. NO REGRESSION — a GENUINELY malformed record is still quarantined, still
//    survives the write verbatim and in place, and is still re-derived.
//
//    This is also the non-vacuity proof for checks 2 and 3: the acceptance rule
//    that rejects junk accepts 100% of what the validator actually derives, so
//    "nothing was accepted" above is a fact about the junk, not about a filter
//    that rejects everything.
// ════════════════════════════════════════════════════════════════════════════
for (const [label, records, atIndex] of [
  ['malformed-first', [GENUINELY_MALFORMED, OK_RECORD], 0],
  ['malformed-last', [OK_RECORD, GENUINELY_MALFORMED], 1],
]) {
  // Planted alongside the real thing: the derived classification must REPLACE
  // the artifact's claim, never merge with it.
  for (const planted of [undefined, [plantedEntry(0, PAYLOAD)], 'junk']) {
    const tag = `${label}/${planted === undefined ? 'no-plant' : `plant=${canon(planted).slice(0, 24)}`}`;
    const o = observe(records, planted);
    if (o.crashes.length > 0) { fail('regression', `${tag} crashed a live surface: ${o.crashes.join(' | ')}`); continue; }

    const derived = o.read?.malformedRecords ?? [];
    if (derived.length !== 1 || canon(derived[0].value) !== canon(GENUINELY_MALFORMED) || derived[0].index !== atIndex) {
      fail('regression',
        `${tag}: the read must derive exactly ONE quarantined record — the genuinely malformed one, verbatim, at on-disk `
        + `index ${atIndex} — but derived ${canon(derived.map((e) => ({ index: e.index, id: e.id })))}`);
      continue;
    }
    // THE COUPLING: every entry the validator derives must survive the acceptance
    // rule, or that rule would be discarding real quarantine state as junk.
    if (o.quarantined.length !== derived.length) {
      fail('regression',
        `${tag}: the acceptance rule kept ${o.quarantined.length} of ${derived.length} GENUINELY DERIVED entries. It must `
        + 'accept everything the validator produces; otherwise the junk rejected above proves nothing.');
    }
    if (o.notice === null || !o.notice.includes('LEGACY-broken')) {
      fail('regression', `${tag}: a quarantined artifact rendered no corruption notice naming the rejected record`);
    }
    if (injectedInto(o.disk?.records)) fail('regression', `${tag}: the payload was injected alongside a real quarantine`);
    if (canon(o.disk?.records) !== canon(records)) {
      fail('regression',
        `${tag}: the quarantined ORIGINAL did not survive the write verbatim and in place — on disk: `
        + `${canon(ids(o.disk?.records))}, expected ${canon(ids(records))}. D-4 quarantine is retain-and-report.`);
    }
    if (Object.prototype.hasOwnProperty.call(o.disk ?? {}, 'malformedRecords')) {
      fail('regression', `${tag}: the derived key was persisted to disk`);
    }
    const requarantined = o.reread?.malformedRecords ?? [];
    if (requarantined.length !== 1 || canon(requarantined[0].value) !== canon(GENUINELY_MALFORMED)) {
      fail('regression', `${tag}: the next read no longer re-derives the quarantine, so the corruption was laundered clean`);
    }
  }
}

if (!failures.some((f) => f.startsWith('regression:'))) {
  console.log(
    'GENUINE_QUARANTINE_UNREGRESSED (a genuinely malformed v1 record at index 0 and at index 1, each with no plant, with a '
    + 'planted INJECTED-PAYLOAD entry and with a junk string plant: exactly ONE quarantined record is derived every time — '
    + 'the real one, verbatim, at its on-disk index, with the plant REPLACED rather than merged — the corruption notice names '
    + 'it, the original survives the write verbatim and in place, the derived key is not persisted, and the next read '
    + 're-derives the same quarantine. The acceptance rule kept 100% of the derived entries, so the junk rejected above was '
    + 'rejected for being junk)',
  );
}

if (failures.length > 0) {
  console.error(`\nred-b2aa7-quarantine-derivation: ${failures.length} check(s) failed`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  'red-b2aa7-quarantine-derivation: OK (`malformedRecords` is strictly derived and never inherited: an on-disk value is '
  + 'stripped at the read boundary in every outcome, is never honoured as classification, and can never be re-inserted into '
  + 'the `records` array the live gates read; non-array and junk values crash neither the read, the gate pair, the operator '
  + 'notice nor the write; and a genuinely malformed record is still quarantined, retained and re-derived)',
);
process.exit(0);
