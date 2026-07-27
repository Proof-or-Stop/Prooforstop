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
 *   5. HONOURED BY PROVENANCE, NOT SHAPE. Rules 1-2 are asserted through a FILE,
 *      where the read boundary strips the planted key first. The write boundary
 *      takes ANY caller-supplied `RedEvidenceData`, so an IN-MEMORY payload
 *      reaches it with `malformedRecords` intact and no shape check can tell it
 *      from a derived one. Only entries this module derived are honoured, and a
 *      payload claiming otherwise is REFUSED rather than quietly written without
 *      the records it claims are quarantined.
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
  retainQuarantinedRecordsOnWrite,
  classifyRedEvidenceArtifact,
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

// ════════════════════════════════════════════════════════════════════════════
// 5. adversarial — PROVENANCE, NOT SHAPE, AT THE WRITE BOUNDARY (F-009).
//
//    Sections 1-3 plant through a FILE, so the read boundary strips the key
//    before any consumer sees it. That is not the whole surface.
//    `store.writeRedEvidence` hands ANY caller-supplied `RedEvidenceData`
//    straight to `retainQuarantinedRecordsOnWrite`, so an IN-MEMORY payload
//    that never went through `store.readRedEvidence` arrives at the write path
//    with its `malformedRecords` intact. The cross-host reviewer reproduced it
//    on the pre-fix tree by calling that guard directly on an object literal:
//
//      retainQuarantinedRecordsOnWrite({ records:[OK_RECORD], malformedRecords:
//        [{ index:0, id:'INJECTED-PAYLOAD', reason:'…', violations:['…'],
//           value: PAYLOAD }] })
//        -> records = [ 'INJECTED-PAYLOAD', 'RED-ok' ]   and the key is GONE
//
//    A SHAPE check cannot close that, and no stricter shape check ever will: a
//    derived entry has no shape a caller cannot type out, so `plantedEntry`
//    below is INDISTINGUISHABLE from the real thing by inspection of its bytes.
//    The acceptance rule must therefore be PROVENANCE — only entries this
//    module's own derivation produced are honoured — and provenance is a fact
//    about WHERE A VALUE CAME FROM, which is not carried in the value.
//
//    Two properties are pinned here, because closing the injection by ignoring
//    an underived claim would open a second hole in the other direction:
//
//      INJECTION   nothing a caller hand-builds may reach `records`.
//      NOT SILENT  a payload that CLAIMS quarantined records the write path
//                  cannot honour is REFUSED, not quietly written without them.
//                  Writing it anyway drops those records from disk — the one
//                  outcome D-4 forbids — and the caller would never know.
// ════════════════════════════════════════════════════════════════════════════
const attempt = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (e) {
    return { threw: true, error: e };
  }
};

/** The reviewer's exact payload: never read from disk, structurally perfect. */
const handBuiltPayload = () => ({
  schemaVersion: 'proofstory.red_evidence.v1',
  storyId: STORY_ID,
  records: [OK_RECORD],
  createdAt: NOW,
  updatedAt: NOW,
  malformedRecords: [plantedEntry(0, PAYLOAD)],
});

// 5a. The guard, called directly — the reviewer's reproduction.
{
  const payload = handBuiltPayload();
  if (redEvidenceQuarantinedRecords(payload).length !== 0) {
    fail('provenance',
      'a hand-built `malformedRecords` entry was accepted as derived read-time classification. It is shaped exactly like '
      + 'one the validator emits — because a derived entry has no shape a caller cannot type out — so SHAPE cannot be the '
      + 'acceptance rule here.');
  }
  const r = attempt(() => retainQuarantinedRecordsOnWrite(payload));
  if (r.threw && isRawBuiltin(r.error)) {
    fail('provenance', `the write boundary crashed on a hand-built payload instead of refusing it: ${r.error.constructor.name}: ${r.error.message}`);
  }
  if (!r.threw && injectedInto(r.value?.records)) {
    fail('provenance',
      `THE WRITE BOUNDARY INJECTED A HAND-BUILT PAYLOAD INTO \`records\`: ${canon(ids(r.value?.records))}. `
      + '`records` is the evidence the live DEV / REVIEW / DONE gates read, so an in-process caller that never read the '
      + 'artifact just wrote an unvalidated record into it — and the `malformedRecords` key is stripped on the way out, so '
      + 'nothing on disk records that it happened.');
  }
  if (!r.threw) {
    fail('provenance',
      'the write boundary silently ACCEPTED a payload claiming quarantined records it cannot have derived. Even when the '
      + 'claim is not honoured, passing it through writes an envelope whose `records` omits every record the payload says '
      + 'is quarantined — a silent deletion of on-disk evidence. It must REFUSE.');
  }
}

// 5b. The same payload through the REAL production write boundary.
{
  const { root, store, artifactPath } = seed([OK_RECORD]);
  attempt(() => store.writeRedEvidence(STORY_ID, handBuiltPayload()));
  const disk = attempt(() => readRaw(artifactPath));
  if (injectedInto(disk.value?.records)) {
    fail('provenance', `\`store.writeRedEvidence\` put a hand-built payload on disk: ${canon(ids(disk.value?.records))}`);
  }
  if (canon(disk.value?.records) !== canon([OK_RECORD])) {
    fail('provenance', `a refused write still altered the artifact on disk: ${canon(ids(disk.value?.records))}, expected ${canon(ids([OK_RECORD]))}`);
  }
  rmSync(root, { recursive: true, force: true });
}

// 5c. NON-VACUITY + THE DISCRIMINATOR. The genuine article must still be
//     honoured by the very same call, and a BYTE-IDENTICAL copy of it must not
//     be — which is only possible if the rule reads provenance rather than bytes.
{
  const { root, store } = seed([GENUINELY_MALFORMED, OK_RECORD]);
  const derived = store.readRedEvidence(STORY_ID);
  if ((derived?.malformedRecords ?? []).length !== 1) {
    fail('provenance', 'the fixture did not derive a real quarantine, so this row proves nothing about provenance');
  } else {
    const kept = attempt(() => retainQuarantinedRecordsOnWrite(derived));
    if (kept.threw) {
      fail('provenance',
        `the write boundary refused a GENUINELY derived payload: ${kept.error?.message ?? String(kept.error)}. The rule must `
        + 'accept everything the validator produces, or the refusals above are a function that refuses everything.');
    } else if (canon(kept.value?.records) !== canon([GENUINELY_MALFORMED, OK_RECORD])) {
      fail('provenance',
        `the write boundary did not restore the genuinely quarantined original: ${canon(ids(kept.value?.records))}, expected `
        + `${canon(ids([GENUINELY_MALFORMED, OK_RECORD]))}. Retention must survive the provenance rule.`);
    }

    // Same bytes, different provenance. A copy is a value a caller built.
    const copy = JSON.parse(JSON.stringify(derived));
    if (canon(copy) !== canon(derived)) {
      fail('provenance', 'the copy is not byte-identical to the derived payload, so it cannot isolate provenance from shape');
    }
    if (redEvidenceQuarantinedRecords(copy).length !== 0) {
      fail('provenance',
        'a byte-identical COPY of a derived payload was accepted as derived classification. It serialises to the same bytes '
        + 'as the real one, so accepting it means the rule is reading the bytes — and anything a caller can type out then '
        + 'passes too, which is exactly the hole.');
    }
    const copied = attempt(() => retainQuarantinedRecordsOnWrite(copy));
    if (!copied.threw) {
      fail('provenance',
        'a byte-identical COPY of a derived payload was written without refusal. It is not the object graph the read '
        + 'produced, so its retention claim cannot be honoured — and writing it silently drops the quarantined original '
        + 'that is still on disk.');
    }
  }
  rmSync(root, { recursive: true, force: true });
}

// 5d. THE LIMIT OF THE RULE, pinned so the source comment cannot outrun it.
//
//     `classifyRedEvidenceArtifact` is EXPORTED, so a caller can run bytes of
//     their own through the derivation and receive registered entries without
//     touching a file. The rule does not claim otherwise, and must not: what it
//     guarantees is that a registered entry's `index`/`value` were COMPUTED from
//     a `records` array rather than DECLARED about one. So the payload can only
//     come back out of `records` if the caller put it into `records` first — at
//     which point they have written nothing they could not have written by
//     handing the same array to `store.writeRedEvidence`, which validates none
//     of it. What 5a-5c close is the DECLARED entry whose `value` was never in
//     `records` at all.
{
  const own = attempt(() => retainQuarantinedRecordsOnWrite(
    classifyRedEvidenceArtifact({
      schemaVersion: 'proofstory.red_evidence.v1', storyId: STORY_ID,
      records: [PAYLOAD, OK_RECORD], createdAt: NOW, updatedAt: NOW,
    }, 'in-memory').data,
  ));
  if (own.threw) {
    fail('provenance', `self-classified bytes were refused: ${own.error?.message ?? String(own.error)}. The derivation must accept its own output.`);
  } else if (canon(own.value?.records) !== canon([PAYLOAD, OK_RECORD])) {
    fail('provenance',
      `self-classifying an in-memory array did not reproduce it verbatim: ${canon(ids(own.value?.records))}, expected `
      + `${canon(ids([PAYLOAD, OK_RECORD]))}. The documented limit is that a caller gets back the array they supplied — `
      + 'no more (which would be an injection) and no less (which would be a loss).');
  }
}

if (!failures.some((f) => f.startsWith('provenance:'))) {
  console.log(
    'CLASSIFICATION_IS_HONOURED_BY_PROVENANCE_NOT_SHAPE (a hand-built `RedEvidenceData` carrying a structurally PERFECT '
    + '`malformedRecords` entry — the cross-host reviewer\'s own reproduction — is reported as zero quarantined records and '
    + 'is REFUSED by the write boundary rather than crashed on, silently accepted, or injected: neither the direct guard nor '
    + '`store.writeRedEvidence` puts INJECTED-PAYLOAD into `records`, and the on-disk artifact is untouched. Controls: the '
    + 'GENUINELY derived payload from a real read is still accepted by the same call and still restores its quarantined '
    + 'original in place, while a BYTE-IDENTICAL JSON copy of that same payload is not — so the rule provably reads '
    + 'provenance and not the bytes. Its documented LIMIT is pinned too: bytes self-classified through the exported '
    + '`classifyRedEvidenceArtifact` are accepted, and reproduce the caller\'s own array verbatim — no record the caller '
    + 'did not already supply)',
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
