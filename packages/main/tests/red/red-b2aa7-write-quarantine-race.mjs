#!/usr/bin/env node
/**
 * B-2aa7 — the WRITE-BOUNDARY quarantine race (cross-host reviewer finding).
 *
 * ── THE DEFECT THIS REPRODUCES ──────────────────────────────────────────────
 *
 * D-4 quarantine is retain-and-report: `store.readRedEvidence` returns a CLEAN
 * `records` array and RETAINS the rejected originals on the derived
 * `malformedRecords` key. Consumers that rebuild an envelope from the clean
 * array must therefore put the originals back before writing, which is what
 * `restoreQuarantinedRecords` is for and what `red_evidence_create` does.
 *
 * The chain commands could not do that. `red_evidence_quarantine` /
 * `red_evidence_recover` protect themselves with a corruption PRECHECK
 * (`readRedEvidenceForChain`, handlers/red-evidence.ts) that refuses when the
 * artifact holds quarantined records — but that precheck runs BEFORE the chain
 * lock, and `appendControlRecord` (core/red-evidence/append.ts, owned by the
 * merged sibling B-506e and a BLOCKED path here) takes the lock and performs its
 * OWN second read inside it, then rebuilds from that read's `data.records`.
 *
 * So the precheck guards a DIFFERENT read than the one the write is built from.
 * If the artifact becomes malformed in the window between them — concurrent CLI
 * activity, or an operator editing the file — the locked read quarantines the
 * new entries and the rebuild writes back only the clean subset, DELETING the
 * quarantined originals from `records`. A pre-lock refusal cannot close a
 * post-lock window.
 *
 * ── WHY THE INTERLEAVING IS SIMULATED RATHER THAN RACED ─────────────────────
 *
 * The window is between two reads of ONE process, so the fault does not need two
 * processes: it needs the artifact to change between read #1 and read #2. This
 * file drives the REAL registered `red_evidence_quarantine` handler and makes
 * the mutation land in exactly that window, detected mechanically rather than by
 * counting calls — the injection fires when the chain LOCK DIR exists, i.e. on
 * the read `appendControlRecord` performs under its own lock. Read #1 (the
 * precheck) therefore sees a CLEAN artifact, which the run asserts, so the
 * handler's refusal provably did not fire and what is measured is the write
 * boundary, not the precheck.
 *
 * ── WHAT MUST HOLD ──────────────────────────────────────────────────────────
 *
 *   1. The quarantined ORIGINAL is still in the on-disk `records` array,
 *      verbatim and at its original index (retain-and-report, never drop).
 *   2. The append still happened — the control record is on disk. Preserving
 *      evidence must not be paid for by losing the operation.
 *   3. The derived `malformedRecords` key is NOT persisted. It is read-time
 *      classification, not part of the on-disk schema (types.ts: "never written
 *      to disk by the canonical writer"), and persisting it would both pollute
 *      the envelope and let a later non-spreading appender drop the originals
 *      for good.
 *   4. Reading the result back re-derives the SAME quarantine — the artifact is
 *      still reported as corrupt, so nothing was laundered clean.
 *
 * Both index placements (before and after the well-formed record) are exercised,
 * because restoring at the wrong index would silently reorder the artifact.
 *
 * A CONTROL run without injection pins that the ordinary path is untouched, and
 * every race run asserts its own injection actually fired, so this file cannot
 * pass vacuously.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-write-quarantine-race.mjs
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const {
  RED_EVIDENCE_V2_SCHEMA_VERSION,
  computeRecordDigest,
  computeSpecDigest,
} = await import(`${DIST}/core/red-evidence/record-v2.js`);
const { redAssertOperationKey, deriveRecordId } = await import(`${DIST}/core/red-evidence/operation-key.js`);
const { redEvidenceChainLockDir } = await import(`${DIST}/core/red-evidence/append.js`);
const { createMainRegistry } = await import(`${DIST}/registry.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const TARGET = 'M1';

const failures = [];
const fail = (check, why) => failures.push(`${check}: ${why}`);
const canon = (v) => JSON.stringify(v);

/**
 * The entry injected mid-race: no per-record `schemaVersion`, so it is a v1
 * RESIDUAL record, and it violates the v1 schema (only `id` and `trigger`), so
 * the read boundary quarantines it. This is the value that must survive.
 */
const MALFORMED = { id: 'LEGACY-broken', trigger: 'hand-edited during the append window' };

/** A store + a seeded v2 red-assert head on TARGET, in a throwaway root. */
function seed(root) {
  const storyId = 'B-2aa7-write-race';
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'b2aa7', title: 'B-2aa7 write-boundary race',
    description: 'Fix an authentication session security regression (behavior change).',
    type: 'bug', phase: 'DEV', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
  });
  const milestones = [{
    id: TARGET, sourceRequirementId: 'REQ-1', claim: 'auth fix', doneMeans: 'test passes',
    requiredEvidence: [], checklistRefs: ['CHK-001'], verificationIntentRefs: ['CHK-001:happy:0'], status: 'planned',
  }];
  store.writeMilestoneLedger(storyId, {
    schemaVersion: 'proofstory.milestone_ledger.v1', storyId, state: 'confirmed',
    ledgerHash: computeMilestoneLedgerHash(milestones), milestones, createdAt: NOW, updatedAt: NOW,
  });

  const greenRelation = { targetRef: TARGET, relation: 'same_acceptance' };
  const specDigest = computeSpecDigest(TARGET, greenRelation);
  const operationKey = redAssertOperationKey({
    storyId, acceptanceTargetRef: TARGET, baselineHeadHash: 'h', baselineMaterialHash: 'm',
    specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p',
  });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, 1), schemaVersion: RED_EVIDENCE_V2_SCHEMA_VERSION,
    operation: 'red-assert', seq: 1, priorRecordDigest: null, supersedes: null, storyId,
    acceptanceTargetRef: TARGET, trigger: 't', observedFailure: 'f', baselineHeadHash: 'h',
    baselineMaterialHash: 'm', greenRelation, assertion: {}, policySnapshot: {}, specDigest,
    operationKey, runReceipt: {}, createdAt: NOW,
  };
  const redAssert = { ...draft, recordDigest: computeRecordDigest(draft) };
  store.writeRedEvidence(storyId, {
    schemaVersion: 'proofstory.red_evidence.v1', storyId, records: [redAssert], createdAt: NOW, updatedAt: NOW,
  });

  const artifactPath = join(root, loadConfig(root).storyDir, storyId, 'red-evidence.json');
  return { store, storyId, redAssert, artifactPath };
}

/** The raw bytes on disk — NOT the read boundary, which would hide the loss. */
function readRaw(artifactPath) {
  return JSON.parse(readFileSync(artifactPath, 'utf8'));
}

function writeRaw(artifactPath, value) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * One run of the REAL `red_evidence_quarantine` handler.
 *
 * `injectAt` — when a number, another writer inserts {@link MALFORMED} at that
 * index of the on-disk `records` array in the window between the pre-lock
 * precheck read and the locked read that the write is rebuilt from. `null` is
 * the CONTROL: no injection at all.
 */
function runQuarantine(injectAt) {
  const root = mkdtempSync(join(tmpdir(), 'red-b2aa7-write-race-'));
  try {
    const { store, storyId, redAssert, artifactPath } = seed(root);
    const lockDir = redEvidenceChainLockDir(store, storyId, TARGET);

    const observed = { prelockReads: 0, lockedReads: 0, prelockSawQuarantine: null, injected: false };
    const realRead = store.readRedEvidence.bind(store);
    store.readRedEvidence = (sid) => {
      const underLock = existsSync(lockDir);
      // THE WINDOW: the lock is held, the precheck is already behind us, and the
      // read that the rebuilt envelope will be derived from has not happened yet.
      if (underLock && injectAt !== null && !observed.injected) {
        const disk = readRaw(artifactPath);
        disk.records.splice(injectAt, 0, MALFORMED);
        writeRaw(artifactPath, disk);
        observed.injected = true;
      }
      const value = realRead(sid);
      if (underLock) observed.lockedReads += 1;
      else {
        observed.prelockReads += 1;
        // The precheck refuses on a quarantining read; record what it actually
        // saw so a "no loss" result can never be an artifact of it refusing.
        if (observed.prelockSawQuarantine === null) {
          observed.prelockSawQuarantine = (value?.malformedRecords ?? []).length > 0;
        }
      }
      return value;
    };

    const registry = createMainRegistry({ store, root, scanRoot: root });
    const quarantine = registry.get('red_evidence_quarantine');
    if (!quarantine) throw new Error('red_evidence_quarantine is not registered');

    let error = null;
    try {
      quarantine({ storyId, recordId: redAssert.id, reason: 'write-boundary race repro', agent: 'proof-or-stop-implementer' });
    } catch (e) {
      error = e?.message ?? String(e);
    }

    const disk = readRaw(artifactPath);
    // Re-read through the REAL boundary with the patch removed, to see what the
    // next reader would make of what was just written.
    store.readRedEvidence = realRead;
    const reread = store.readRedEvidence(storyId);
    return { observed, error, disk, reread, redAssert };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CONTROL — no injection. The ordinary path must be exactly what it was.
// ════════════════════════════════════════════════════════════════════════════
const control = runQuarantine(null);
if (control.error !== null) {
  fail('control', `the uncontended quarantine failed: ${control.error}`);
} else {
  if (control.disk.records.length !== 2) {
    fail('control', `expected 2 records after an uncontended append, found ${control.disk.records.length}`);
  }
  if (canon(control.disk.records[0]) !== canon(control.redAssert)) {
    fail('control', 'the uncontended append did not leave the seeded red-assert record first');
  }
  if (control.disk.records[1]?.operation !== 'quarantine') {
    fail('control', 'the uncontended append did not write a quarantine control record');
  }
  if (Object.prototype.hasOwnProperty.call(control.disk, 'malformedRecords')) {
    fail('control', 'an uncontended write persisted a `malformedRecords` key, which is derived read-time state');
  }
  if (control.observed.lockedReads < 1 || control.observed.prelockReads < 1) {
    fail('control',
      `the two-read structure this test targets was not observed (prelock=${control.observed.prelockReads}, `
      + `locked=${control.observed.lockedReads}); the injection point may no longer be the write's source read`);
  }
}
if (failures.length === 0) {
  console.log(
    `CONTROL_UNCONTENDED_APPEND_UNCHANGED (red_evidence_quarantine over a clean artifact wrote 2 records — the seeded `
    + `red-assert plus one quarantine control record — with no malformedRecords key; the pre-lock precheck read and the `
    + `separate locked read were both observed, which is the structure the race below exploits)`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// THE RACE — malformed record injected between the precheck and the locked read.
// ════════════════════════════════════════════════════════════════════════════
for (const injectAt of [0, 1]) {
  const label = injectAt === 0 ? 'race-before' : 'race-after';
  const run = runQuarantine(injectAt);

  // NON-VACUITY: the injection has to have actually happened, in the right
  // window, or nothing below is evidence of anything.
  if (!run.observed.injected) {
    fail(label, 'the malformed record was never injected — the chain lock dir was not observed during any read');
    continue;
  }
  if (run.observed.prelockSawQuarantine !== false) {
    fail(label,
      `the PRE-LOCK precheck read already saw the quarantine (${run.observed.prelockSawQuarantine}), so the handler's `
      + 'refusal could have produced this result; the injection did not land inside the post-lock window');
    continue;
  }
  if (run.observed.lockedReads < 1) {
    fail(label, 'no read happened under the chain lock, so the write was not rebuilt from a locked read');
    continue;
  }

  const records = Array.isArray(run.disk.records) ? run.disk.records : [];

  // 1. THE LOAD-BEARING ASSERTION — the original survives, verbatim, in place.
  const surviving = records.findIndex((r) => canon(r) === canon(MALFORMED));
  if (surviving === -1) {
    fail(label,
      `THE QUARANTINED ORIGINAL WAS DELETED. It was at records[${injectAt}] on disk when the locked read ran, and the `
      + `envelope written back holds only ${records.length} record(s): ${canon(records.map((r) => r?.id ?? '<no id>'))}. `
      + 'D-4 quarantine is retain-and-report — the write boundary must never drop what the read boundary quarantined.');
  } else if (surviving !== injectAt) {
    fail(label, `the quarantined original survived but moved from index ${injectAt} to ${surviving}, reordering the artifact`);
  }

  // 2. The append still happened: retention must not cost the operation.
  const control = records.filter((r) => r?.operation === 'quarantine');
  if (run.error !== null) {
    fail(label, `the append failed instead of retaining the quarantined record: ${run.error}`);
  } else if (control.length !== 1) {
    fail(label, `expected exactly 1 quarantine control record on disk, found ${control.length}`);
  } else if (records.length !== 3) {
    fail(label, `expected 3 records (seeded red-assert + injected original + control record), found ${records.length}`);
  }

  // 3. THE TRAP — the derived key must not be persisted by the guard.
  if (Object.prototype.hasOwnProperty.call(run.disk, 'malformedRecords')) {
    fail(label,
      '`malformedRecords` was written to disk. It is read-time classification, not part of the on-disk schema; '
      + 'persisting it pollutes the envelope and lets a later non-spreading appender drop the originals for good.');
  }

  // 4. Nothing was laundered clean: the next read re-derives the same quarantine.
  const requarantined = run.reread?.malformedRecords ?? [];
  if (requarantined.length !== 1 || canon(requarantined[0]?.value) !== canon(MALFORMED)) {
    fail(label,
      `re-reading the written artifact re-derived ${requarantined.length} quarantined record(s) instead of the one `
      + 'that was injected, so the corruption is no longer reported to the next reader');
  }
}

if (failures.length > 0) {
  console.error(`\nred-b2aa7-write-quarantine-race: ${failures.length} check(s) failed`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  'red-b2aa7-write-quarantine-race: OK (a malformed record injected between the pre-lock corruption precheck and the '
  + 'locked read that appendControlRecord rebuilds from — at index 0 and at index 1 — survives VERBATIM and IN PLACE in '
  + 'the on-disk records array; the quarantine control record is still appended, the derived malformedRecords key is not '
  + 'persisted, and the next read re-derives the same quarantine)',
);
process.exit(0);
