#!/usr/bin/env node
/**
 * RED artifact (B-2aa7) — the legacy v1 red-evidence ARTIFACT is not validated
 * before the LIVE dev/review/done enforce gate evaluates it.
 *
 * Repro-first: this file is written BEFORE the fix and MUST FAIL on the pre-fix
 * tree. Every row is driven through `proofStoryDiagnosticInput` →
 * `evaluateProofStoryDiagnostics` — the pair the live enforce gates actually
 * call — never through the predicate in isolation.
 *
 * ── HOW A ROW WORKS (read this before adding one) ───────────────────────────
 *
 * Each RED row carries TWO predicates over the same observation:
 *
 *   `required(o)`      what the fix must make true. FALSE on the pre-fix tree —
 *                      this is what turns the file red.
 *   `preFixDefect(o)`  the documented defect signature that must be observable
 *                      on the pre-fix tree. Asserted whenever `required` is
 *                      false, so a red row PROVES it failed for the documented
 *                      reason rather than a typo, a stale row, or a broken
 *                      fixture. The two are mutually exclusive by construction
 *                      and that exclusivity is itself asserted.
 *
 * A row whose observation matches NEITHER predicate is a STALE row: the world
 * moved and the row no longer describes it. That hard-fails with a distinct
 * message. This is the failure mode that would otherwise let a row pass
 * vacuously — exactly what happened to the `record === null` / `record === "a
 * string"` cases, which sibling story B-506e closed at `4d417a0c4b` and which
 * are therefore DELIBERATELY ABSENT from this file.
 *
 * ── THE THREE DEFECT CLASSES NEED THREE DIFFERENT ASSERTION SHAPES ──────────
 *
 * Conflating them produces a wrong test, so they are kept apart:
 *
 *   CRASH          a bare `TypeError` escapes today.
 *                  required → no bare TypeError may escape.
 *   SILENT         no throw at all, but a WRONG OBSERVABLE VALUE: the corrupt
 *                  artifact is byte-identical, at the diagnostic report, to an
 *                  ABSENT one. Writing "assert no throw" here would PASS today
 *                  and prove nothing; the assertion must be about the value.
 *                  required → corruption is distinguishable from absence.
 *   UNTYPED-THROW  an unparseable file lets a RAW `SyntaxError` escape, naming
 *                  nothing. Its post-fix requirement is a TYPED error NAMING
 *                  THE PATH — *not* the absence of a throw. Folding this into
 *                  SILENT would encode the wrong requirement.
 *
 * ── DISCREPANCY FOUND WHILE RE-DERIVING (standing rule 1) ───────────────────
 *
 * `records: "x"` is grouped with `records: {}` / `records: 42` as a CRASH case
 * in some of this story's prose. Probed against the CURRENT tree, it is NOT a
 * bare TypeError: `store.readRedEvidence`'s `for (const record of data.records)`
 * iterates the STRING'S CHARACTERS, hands `'x'` to `classifyRedRecordSchema`,
 * and throws a TYPED `RedEvidenceSchemaError: red-evidence: a record must be an
 * object` — blaming a RECORD for an ENVELOPE fault, and naming neither the
 * envelope nor the file. That is a distinct defect (misattribution, not a
 * crash) with a distinct requirement, so it lives in its own labelled block
 * A.2 rather than being asserted as a TypeError it demonstrably is not. The
 * audit's own §0.0 and §2.4 agree with the probe; only the CRASH grouping does
 * not.
 *
 * ── SHARED FILE — WHO WRITES WHAT ───────────────────────────────────────────
 *
 * CHK-009, CHK-010 and CHK-011 all extend THIS file, and CHK-010's rows have
 * the OPPOSITE pre-fix expectation to CHK-001's. The blocks below are labelled
 * with that expectation; keep new rows inside the block that matches them.
 *
 *   BLOCK A  CHK-001  RED rows           — MUST FAIL pre-fix
 *   BLOCK B  CHK-010  invariant rows     — MUST PASS pre-fix (and post-fix)
 *   BLOCK C  CHK-009  order independence — MUST FAIL pre-fix (added once CHK-004 landed)
 *   BLOCK D  CHK-011  validator fuzz     — added after CHK-004 lands
 *
 * Run:  node packages/main/tests/red/red-b2aa7-artifact-validation.mjs
 */
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..'); // packages/main
const DIST = join(pkgRoot, 'dist');

const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-2aa7-red';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-artifact-${process.pid}`);

// ── fixture store ───────────────────────────────────────────────────────────
// Same shape as red-w2c-v1-verdict-invariance.mjs: a throwaway store root
// outside any repo, a story whose description makes the red-evidence trigger
// live, and a confirmed milestone ledger so `expectedRedTargets` is non-empty
// (otherwise the predicate short-circuits and no row would prove anything).
const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'b2aa7', title: 'B-2aa7 artifact validation',
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

const STORY_DIR_REL = loadConfig(root).storyDir;
const ARTIFACT_DIR = join(root, STORY_DIR_REL, storyId);
const ARTIFACT_PATH = join(ARTIFACT_DIR, 'red-evidence.json');
const ARTIFACT_REL = join(STORY_DIR_REL, storyId, 'red-evidence.json');

/** A well-formed legacy v1 record that DOES satisfy the gate predicate. */
const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};

/** A malformed versionless record: classifies 'v1', has no `observedFailure`. */
const malformed = { id: 'corrupt' };

// ── fixture writers ─────────────────────────────────────────────────────────
// Raw writes on purpose: `store.writeRedEvidence` cannot express a corrupt
// envelope or a non-object JSON root, and those are half the defect surface.
function writeRawArtifact(text) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(ARTIFACT_PATH, text, 'utf8');
}
function writeEnvelope(records) {
  writeRawArtifact(JSON.stringify(
    { schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW },
    null, 2,
  ) + '\n');
}
function removeArtifact() {
  if (existsSync(ARTIFACT_PATH)) rmSync(ARTIFACT_PATH);
}

/** Recursive canonical form (keys sorted, undefined dropped) — local on purpose. */
function canon(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
}

/**
 * Drive the LIVE gate pair over whatever is currently on disk and record every
 * observable: what the read boundary returned or threw, what the gate threw,
 * and the canonical FULL diagnostic report.
 */
function observe(setup) {
  setup();
  const o = {
    readThrew: false, readError: null, readValue: undefined,
    threw: false, error: null, report: null, missingRedEvidence: null,
  };
  try {
    o.readValue = store.readRedEvidence(storyId);
  } catch (e) {
    o.readThrew = true; o.readError = e;
  }
  try {
    const report = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root));
    o.report = canon(report);
    o.missingRedEvidence = report.missingRedEvidence.map((row) => row.code);
  } catch (e) {
    o.threw = true; o.error = e;
  }
  return o;
}

function describe(o) {
  // BLOCK C rows observe a WHOLE FAMILY of permutations rather than one fixture,
  // so they carry their own one-line summary; a single `threw`/`report` pair
  // cannot express "these 24 orders disagreed with each other".
  if (typeof o.summary === 'string') return o.summary;
  if (o.threw) return `THREW ${o.error?.constructor?.name}(${o.error?.name}): ${o.error?.message}`;
  const read = o.readThrew
    ? `read THREW ${o.readError?.constructor?.name}`
    : `read returned ${o.readValue === null ? 'null' : typeof o.readValue}`;
  return `no throw; ${read}; missingRedEvidence=${JSON.stringify(o.missingRedEvidence)}`;
}

// ── predicates ──────────────────────────────────────────────────────────────
const RAW_BUILTIN_ERRORS = new Set([Error, TypeError, SyntaxError, RangeError, ReferenceError, EvalError, URIError]);

/** A bare `TypeError` — the CRASH signature. A typed subclass is NOT one. */
function isBareTypeError(e) {
  return e instanceof TypeError && e.constructor === TypeError;
}
/** A raw JS builtin, i.e. NOT a typed domain error carrying a diagnosis. */
function isRawBuiltinError(e) {
  return RAW_BUILTIN_ERRORS.has(e?.constructor);
}
/** Does the message identify the artifact it is complaining about? */
function namesArtifactPath(message) {
  const s = String(message ?? '');
  return s.includes(ARTIFACT_PATH) || s.includes(ARTIFACT_REL);
}
/** Does the message say nothing that would let an operator find the file? */
function namesNothing(message) {
  const s = String(message ?? '');
  return !namesArtifactPath(s) && !s.includes('red-evidence.json') && !s.includes(storyId);
}
/** The observed misattribution: an ENVELOPE fault reported as a RECORD fault. */
const MISATTRIBUTES_TO_RECORD = /a record must be an object/i;

/**
 * Implementation-agnostic detector for a D-4 quarantine surface: any own key on
 * the loaded envelope, outside the known v1 keys, holding a NON-EMPTY array.
 * Deliberately not pinned to a field name — CHK-004 has not chosen one yet.
 * EXTENSION POINT: once the real field lands, narrow this to it.
 */
const V1_ENVELOPE_KEYS = new Set(['schemaVersion', 'storyId', 'records', 'createdAt', 'updatedAt']);
function hasQuarantineSurface(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some(
    (key) => !V1_ENVELOPE_KEYS.has(key) && Array.isArray(value[key]) && value[key].length > 0,
  );
}

// ── baselines the SILENT rows are measured against ──────────────────────────
// Computed FIRST, from the real gate, so "indistinguishable from absent" is an
// observed byte comparison rather than a claim.
const ABSENT = observe(removeArtifact);
assert.ok(!ABSENT.threw, 'fixture: an ABSENT artifact must not throw — the SILENT baseline depends on it');
const CLEAN = observe(() => writeEnvelope([satisfying]));
assert.ok(!CLEAN.threw, 'fixture: a well-formed artifact must not throw');
assert.deepEqual(CLEAN.missingRedEvidence, [], 'fixture: the well-formed record must SATISFY the gate, else the ordering rows prove nothing');
assert.notEqual(
  ABSENT.report, CLEAN.report,
  'fixture: the ABSENT and CLEAN reports must differ, otherwise "indistinguishable from absent" is unmeasurable',
);

// ── EXCLUSION GUARD — why two obvious rows are NOT in BLOCK A ───────────────
// `record === null` and `record === "a string"` look like they belong in the
// CRASH block and did belong there before sibling story B-506e merged into main
// at 4d417a0c4b. They are excluded because they are ALREADY CLOSED: including
// them would add rows that pass before this story writes a line of fix, which
// is precisely the vacuity CHK-001 exists to avoid.
//
// That exclusion is asserted, not claimed. If B-506e's fix ever regresses, this
// guard fires and tells you the exclusion is no longer justified — at which
// point the rows belong back in BLOCK A.
for (const [label, record] of [['record === null', null], ['record === "a string"', 'a string']]) {
  const o = observe(() => writeEnvelope([record]));
  assert.ok(o.threw, `exclusion guard: ${label} is excluded from BLOCK A because B-506e closed it — but it no longer fails closed at all`);
  assert.ok(
    !isBareTypeError(o.error),
    `exclusion guard: ${label} is excluded from BLOCK A because B-506e turned it into a TYPED error, but it threw a bare TypeError again (${o.error?.message}). B-506e regressed: this row now belongs IN block A.`,
  );
  assert.equal(
    o.error?.name, 'RedEvidenceSchemaError',
    `exclusion guard: ${label} must still yield the typed RedEvidenceSchemaError B-506e introduced (got ${o.error?.constructor?.name})`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// BLOCK A — CHK-001 · RED rows.        PRE-FIX EXPECTATION: **MUST FAIL**
// ════════════════════════════════════════════════════════════════════════════
const RED_ROWS = [];

// ── A.1 CRASH — a bare TypeError escapes the live gate ──────────────────────
// required: no bare TypeError may escape. preFixDefect: one does.
function crashRow(id, label, setup) {
  return {
    id, block: 'A.1', klass: 'CRASH', label, setup,
    preFixDefectDesc: 'a bare TypeError escapes the live enforce gate',
    preFixDefect: (o) => o.threw && isBareTypeError(o.error),
    requiredDesc: 'no bare TypeError escapes: the gate returns a controlled verdict, or a typed diagnostic',
    required: (o) => !(o.threw && isBareTypeError(o.error)),
  };
}
RED_ROWS.push(
  // Records. Each classifies 'v1' (versionless) and reaches
  // `record.observedFailure.trim()` in redEvidenceRecordSatisfied.
  crashRow('A1-record-versionless', '{ id: "corrupt" } — versionless, no observedFailure', () => writeEnvelope([malformed])),
  crashRow('A2-observedFailure-null', 'observedFailure: null', () => writeEnvelope([{ ...satisfying, observedFailure: null }])),
  crashRow('A3-observedFailure-number', 'observedFailure: 123', () => writeEnvelope([{ ...satisfying, observedFailure: 123 }])),
  // typeof [] === 'object' and it has no schemaVersion, so the classifier still
  // returns 'v1' for an ARRAY record and it is handed to the v1 predicate.
  crashRow('A4-record-is-array', 'the record itself is an array', () => writeEnvelope([[]])),
  // ORDERING: malformed FIRST so Array.prototype.some() cannot short-circuit
  // past it on the satisfying record that follows.
  crashRow('A5-malformed-first', 'malformed FIRST, satisfying after (some() cannot short-circuit)', () => writeEnvelope([malformed, satisfying])),
  // Envelope. These never reach a record at all: `for (const record of
  // data.records ?? [])` in store.readRedEvidence is handed a non-iterable.
  crashRow('A6-envelope-object', 'records: {} — non-iterable envelope', () => writeRawArtifact(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records: {}, createdAt: NOW, updatedAt: NOW }))),
  crashRow('A7-envelope-number', 'records: 42 — non-iterable envelope', () => writeRawArtifact(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records: 42, createdAt: NOW, updatedAt: NOW }))),
);

// ── A.2 ENVELOPE MISATTRIBUTION — typed, but blames the wrong thing ─────────
// Its own shape because it is empirically NOT a bare TypeError (see the
// DISCREPANCY note in the header). It throws a TYPED error whose message
// blames a RECORD for an ENVELOPE fault and names no artifact.
RED_ROWS.push({
  id: 'A8-envelope-string',
  block: 'A.2', klass: 'ENVELOPE-MISATTRIBUTION',
  label: 'records: "x" — the string\'s characters are iterated as records',
  setup: () => writeRawArtifact(JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records: 'x', createdAt: NOW, updatedAt: NOW })),
  preFixDefectDesc: 'a typed error that MISATTRIBUTES an envelope fault to a record, naming no artifact',
  preFixDefect: (o) =>
    o.threw && !isBareTypeError(o.error)
    && MISATTRIBUTES_TO_RECORD.test(String(o.error?.message))
    && !namesArtifactPath(o.error?.message),
  requiredDesc: 'an envelope fault is reported AS an envelope fault and names the artifact path — never as a record fault',
  required: (o) => o.threw
    ? (!isBareTypeError(o.error)
      && namesArtifactPath(o.error?.message)
      && !MISATTRIBUTES_TO_RECORD.test(String(o.error?.message)))
    : (o.report !== ABSENT.report || hasQuarantineSurface(o.readValue)),
});

// ── A.3 SILENT — no throw, WRONG OBSERVABLE VALUE ───────────────────────────
// The trap this block exists to avoid: "assert no throw" PASSES today. The
// assertion must be about the VALUE — the corrupt artifact is byte-identical,
// at the full diagnostic report, to an artifact that does not exist, so every
// consumer reads corruption as ABSENT evidence.
function silentRootRow(id, label, rootText) {
  return {
    id, block: 'A.3', klass: 'SILENT', label,
    setup: () => writeRawArtifact(rootText),
    preFixDefectDesc: 'no throw; the raw parsed value flows into the typed domain and the FULL diagnostic report is byte-identical to an ABSENT artifact',
    preFixDefect: (o) =>
      !o.threw && !o.readThrew
      && o.report === ABSENT.report
      && !hasQuarantineSurface(o.readValue)
      && canon(o.readValue) === canon(JSON.parse(rootText)),
    requiredDesc: 'a corrupt artifact is DISTINGUISHABLE from an absent one (typed rejection, a differing report, or a quarantine surface)',
    required: (o) =>
      o.threw || o.readThrew || o.report !== ABSENT.report || hasQuarantineSurface(o.readValue),
  };
}
RED_ROWS.push(
  silentRootRow('A9-root-array', 'JSON root is []', '[]'),
  silentRootRow('A10-root-string', 'JSON root is "x"', '"x"'),
  silentRootRow('A11-root-null', 'JSON root is null — indistinguishable even in the returned value', 'null'),
  silentRootRow('A12-root-number', 'JSON root is 42', '42'),
);

// Row O2: the ordering mirror of A5. A satisfying record FIRST means some()
// short-circuits and the malformed record that follows is never evaluated: the
// gate reports SATISFIED while the artifact is corrupt.
RED_ROWS.push({
  id: 'A13-satisfying-first',
  block: 'A.3', klass: 'SILENT',
  label: 'satisfying FIRST, malformed after (row O2) — some() short-circuits past the corruption',
  setup: () => writeEnvelope([satisfying, malformed]),
  preFixDefectDesc: 'no throw; verdict SATISFIED and the FULL diagnostic report is byte-identical to a CLEAN artifact — the corruption is invisible',
  preFixDefect: (o) =>
    !o.threw && !o.readThrew
    && Array.isArray(o.missingRedEvidence) && o.missingRedEvidence.length === 0
    && o.report === CLEAN.report
    && !hasQuarantineSurface(o.readValue),
  requiredDesc: 'the malformed entry is surfaced even though a satisfying record precedes it — corruption is not hidden by array order',
  required: (o) =>
    o.threw || o.readThrew || o.report !== CLEAN.report || hasQuarantineSurface(o.readValue),
});

// ── A.4 UNTYPED-THROW — distinct from BOTH blocks above ─────────────────────
// This case DOES throw today. Its requirement is NOT "does not throw"; it is a
// TYPED error that NAMES THE PATH. Folding it into A.3 would encode the wrong
// requirement and a fix that merely swallowed the SyntaxError would satisfy it.
RED_ROWS.push({
  id: 'A14-unparseable-file',
  block: 'A.4', klass: 'UNTYPED-THROW',
  label: 'the file is not valid JSON',
  setup: () => writeRawArtifact('{ this is not json'),
  preFixDefectDesc: 'a RAW SyntaxError escapes from the JSON.parse in the read boundary, naming neither the path nor the file nor the story',
  preFixDefect: (o) =>
    o.threw
    && o.error instanceof SyntaxError
    && isRawBuiltinError(o.error)
    && namesNothing(o.error?.message),
  requiredDesc: 'it STILL THROWS, but a TYPED (non-builtin) error that NAMES THE ARTIFACT PATH — the absence of a throw would NOT satisfy this row',
  required: (o) =>
    o.threw && !isRawBuiltinError(o.error) && namesArtifactPath(o.error?.message),
});

// ════════════════════════════════════════════════════════════════════════════
// BLOCK B — CHK-010 · invariant rows.  PRE-FIX EXPECTATION: **MUST PASS**
//
// Behaviour this fix must NOT change (V2, E4, absent-vs-malformed). Rows here
// are plain checks that hold BOTH before and after the fix, so they use a
// different shape: `check(ctx)` throws on failure and a failure is immediately
// fatal — unlike BLOCK A, where failure is the expected pre-fix state.
//
// ── WHY THIS BLOCK EXISTS: THE PINCER ───────────────────────────────────────
//
// BLOCK A requires the fix to make a CORRUPT artifact distinguishable from an
// ABSENT one. There are two ways to satisfy that and only one is correct:
//
//   ✓ move the CORRUPT side  — reject it, quarantine it, report it.
//   ✗ move the ABSENT side   — make "not configured" throw, or emit a
//                              corruption verdict for an artifact that is
//                              merely empty, `records`-less, or v2-only.
//
// BLOCK A cannot tell those two apart: both turn its rows green. THIS block
// pins the ABSENT side so the second route fails, and pins the v2 record union
// so a read-boundary validator cannot buy the distinction by rejecting records
// it does not recognise. Together they force the distinction to be created by
// moving the corrupt side, which is the only route that fixes anything.
//
// These rows were authored ON THE PRE-FIX TREE and observed to PASS there
// (CHK-010 depends on CHK-001, not on CHK-004, for exactly that reason: after
// the fix lands, "this already held before" is no longer observable). CHK-007
// re-runs them post-fix; unchanged behaviour there is the regression proof.
//
// ── EVERY ROW CARRIES ITS OWN NEGATIVE CONTROL ──────────────────────────────
//
// A row that would hold no matter what pins nothing. Each row therefore also
// asserts that its OWN predicate FAILS on a deliberately wrong fixture. Each
// control is chosen so its outcome is the same on BOTH trees (a corrupt
// envelope, an unsupported `schemaVersion`) — a control must never quietly
// become a RED row.
// ════════════════════════════════════════════════════════════════════════════
const {
  RED_EVIDENCE_V2_SCHEMA_VERSION, computeRecordDigest, computeSpecDigest,
  recordDigestMatches, isRedEvidenceV2, classifyRedRecordSchemaSafe,
} = await import(`${DIST}/core/red-evidence/record-v2.js`);
const { redAssertOperationKey, controlOperationKey, deriveRecordId } = await import(`${DIST}/core/red-evidence/operation-key.js`);

const V2 = RED_EVIDENCE_V2_SCHEMA_VERSION;

/** A GENUINELY valid v2 red-assert record: derived id, derived operationKey, self-omitting digest. */
function makeV2Assert(target, seq, prior, supersedes) {
  const greenRelation = { targetRef: target, relation: 'same_acceptance' };
  const specDigest = computeSpecDigest(target, greenRelation);
  const operationKey = redAssertOperationKey({
    storyId, acceptanceTargetRef: target, baselineHeadHash: 'v2-base-head', baselineMaterialHash: 'v2-base-mat',
    specDigest, assertionDigest: 'sha256:a', policyDigest: 'sha256:p',
  });
  const draft = {
    id: deriveRecordId('red-assert', operationKey, seq), schemaVersion: V2, operation: 'red-assert',
    seq, priorRecordDigest: prior, supersedes, storyId, acceptanceTargetRef: target,
    trigger: 'auth regression', observedFailure: 'v2 observed failure',
    baselineHeadHash: 'v2-base-head', baselineMaterialHash: 'v2-base-mat', greenRelation,
    assertion: {}, policySnapshot: {}, specDigest, operationKey, runReceipt: {}, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

/** A GENUINELY valid v2 QUARANTINE control record — one of the two operations this repo writes. */
function makeV2Quarantine(target, seq, prior, supersedes, recoversRecordId, referencedRecordDigest) {
  const reason = 'quarantined by the CHK-010 invariant fixture';
  const operationKey = controlOperationKey({
    operation: 'quarantine', storyId, acceptanceTargetRef: target, recoversRecordId, referencedRecordDigest, reason,
  });
  const draft = {
    id: deriveRecordId('quarantine', operationKey, seq), schemaVersion: V2, operation: 'quarantine',
    seq, priorRecordDigest: prior, supersedes, storyId, acceptanceTargetRef: target,
    recoversRecordId, referencedRecordDigest, linkKind: 'quarantines', reason,
    approvedBy: 'lattice-implementer@sess-chk010', operationKey, createdAt: NOW,
  };
  return { ...draft, recordDigest: computeRecordDigest(draft) };
}

const v2Assert = makeV2Assert('M1', 1, null, null);
const v2Quarantine = makeV2Quarantine('M1', 2, v2Assert.recordDigest, v2Assert.id, v2Assert.id, v2Assert.recordDigest);

// The DISCRIMINATOR-ISOLATION pair. `v1Twin` and `v2Hybrid` are the SAME object
// except for the single `schemaVersion` member, and both carry every field the
// v1 predicate needs to be SATISFIED. So "the v1 predicate skips v2" is
// observable as a VERDICT FLIP caused by that one member — not as an accident
// of a canonical v2 record happening to lack `failingCommand`.
const v1Twin = { ...satisfying, operation: 'red-assert', seq: 1, priorRecordDigest: null, supersedes: null, storyId };
const v2Hybrid = { ...v1Twin, schemaVersion: V2 };

/** E4: a v1 envelope with NO `records` member at all. */
const E4_TEXT = JSON.stringify(
  { schemaVersion: 'proofstory.red_evidence.v1', storyId, createdAt: NOW, updatedAt: NOW }, null, 2,
) + '\n';
/** The shared negative control: a genuinely CORRUPT envelope (`records: {}`, BLOCK A row A6). */
const CORRUPT_ENVELOPE_TEXT = JSON.stringify(
  { schemaVersion: 'proofstory.red_evidence.v1', storyId, records: {}, createdAt: NOW, updatedAt: NOW },
);

/**
 * The one shared predicate every BLOCK B row is built on: "this artifact is on
 * the ORDINARY not-configured path". Kept in one place so the negative controls
 * falsify the SAME predicate the positive assertions use — a control that
 * falsified a paraphrase would prove nothing.
 */
function onOrdinaryNotConfiguredPath(o) {
  return !o.threw && !o.readThrew
    && Array.isArray(o.missingRedEvidence) && o.missingRedEvidence.length === 1
    && o.missingRedEvidence[0] === 'missing_red_evidence'
    && !hasQuarantineSurface(o.readValue)
    && o.report === ABSENT.report;
}
function assertOrdinaryNotConfigured(o, label) {
  assert.ok(!o.readThrew, `${label}: the read boundary must NOT throw — this is the ordinary not-configured path, not a fault (got ${o.readError?.constructor?.name}: ${o.readError?.message})`);
  assert.ok(!o.threw, `${label}: the live enforce gate must NOT throw (got ${o.error?.constructor?.name}: ${o.error?.message})`);
  assert.deepEqual(o.missingRedEvidence, ['missing_red_evidence'], `${label}: must stay UNSATISFIED via the ORDINARY not-configured gap code`);
  assert.ok(!hasQuarantineSurface(o.readValue), `${label}: must NOT be quarantined — ABSENT is not MALFORMED, and conflating them regresses the distinction this story exists to create`);
  assert.equal(o.report, ABSENT.report, `${label}: the FULL diagnostic report must remain byte-identical to an ABSENT artifact. Reclassifying it as corruption is exactly the overreach CHK-010 exists to catch.`);
  assert.ok(onOrdinaryNotConfiguredPath(o), `${label}: shared predicate disagrees with the assertions above — fix the row, not the tree`);
}

const INVARIANT_ROWS = [];

// ── B1 · V2 (§10.1 row V2) — a valid v2 record is skipped, and UNCHANGED ─────
INVARIANT_ROWS.push({
  id: 'B1-v2-record-skipped-unchanged',
  label: 'a valid v2 record loads byte-identically and is still correctly SKIPPED by the v1 predicate',
  check: (c) => {
    // The fixtures must really be v2, or every assertion below is about
    // something else. Proven through the production classifier + digest check.
    for (const [name, record] of [['red-assert', v2Assert], ['quarantine', v2Quarantine]]) {
      assert.ok(isRedEvidenceV2(record), `fixture: the ${name} fixture must be a v2 record`);
      assert.equal(classifyRedRecordSchemaSafe(record), 'v2', `fixture: the ${name} fixture must CLASSIFY as v2`);
      assert.ok(recordDigestMatches(record), `fixture: the ${name} fixture must be VALID — its recordDigest must recompute from its own bytes`);
    }

    // (i) The read boundary ACCEPTS it: no throw, no quarantine, and the stored
    //     bytes round-trip unchanged. A validator that rejected records it does
    //     not recognise would fail here.
    const chain = c.observe(() => c.writeEnvelope([v2Assert, v2Quarantine]));
    assert.ok(!chain.readThrew, `V2: a valid v2 chain must LOAD, not be rejected (got ${chain.readError?.constructor?.name}: ${chain.readError?.message})`);
    assert.equal(
      c.canon(chain.readValue?.records), c.canon([v2Assert, v2Quarantine]),
      'V2: a valid v2 record must round-trip through the read boundary BYTE-IDENTICALLY — not dropped, not mutated, not reordered',
    );
    assert.ok(!hasQuarantineSurface(chain.readValue), 'V2: a VALID v2 record must never be quarantined');
    // (ii) …and the v1 predicate skips it, so it contributes NOTHING to the v1
    //      diagnostic: the report is byte-identical to having no artifact at all.
    assertOrdinaryNotConfigured(chain, 'V2 (valid v2 chain, no v1 record)');

    // (iii) THE SKIP IS LOAD-BEARING, not an accident. `v1Twin` and `v2Hybrid`
    //       differ by the `schemaVersion` member ALONE, and both carry every
    //       field the v1 predicate needs. The verdict must flip on that member.
    assert.equal(
      c.canon({ ...v2Hybrid, schemaVersion: undefined }), c.canon(v1Twin),
      'fixture: v2Hybrid and v1Twin must differ by the schemaVersion member ALONE, else the flip below proves nothing',
    );
    const asV1 = c.observe(() => c.writeEnvelope([v1Twin]));
    assert.ok(!asV1.threw && !asV1.readThrew, 'fixture: the v1 twin must evaluate cleanly');
    assert.deepEqual(asV1.missingRedEvidence, [], 'fixture: the v1 twin MUST satisfy the gate — otherwise "v2 is skipped" is unobservable');
    const asV2 = c.observe(() => c.writeEnvelope([v2Hybrid]));
    assert.ok(!asV2.threw && !asV2.readThrew, 'V2: a hybrid v2 record must not crash the gate — the DISCRIMINATOR governs, not field presence');
    assert.deepEqual(
      asV2.missingRedEvidence, ['missing_red_evidence'],
      'V2: a record carrying the v2 discriminator must be SKIPPED even though it carries every v1 satisfier field',
    );
    assertOrdinaryNotConfigured(asV2, 'V2 (hybrid v2 record carrying all v1 fields)');

    // (iv) NON-INTERFERENCE, in both orders: a valid v2 record next to a
    //      satisfying v1 record leaves the verdict and the whole report alone.
    for (const [order, records] of [['v2 first', [v2Assert, c.satisfying]], ['v1 first', [c.satisfying, v2Assert]]]) {
      const mixed = c.observe(() => c.writeEnvelope(records));
      assert.ok(!mixed.threw && !mixed.readThrew, `V2: a mixed v1+v2 store must not throw (${order})`);
      assert.equal(mixed.report, c.CLEAN.report, `V2: a valid v2 record must not perturb the v1 verdict (${order}) — the report must stay byte-identical to a v1-only satisfying store`);
    }

    // (v) NEGATIVE CONTROL — the "accepted unchanged" predicate DISCRIMINATES.
    //     An UNSUPPORTED per-record schemaVersion must NOT get the v2 treatment
    //     (B-506e's fail-closed property, §10.5 "must not regress"). Phrased as
    //     a disjunction so it holds whether the fix throws or quarantines.
    const unsupported = { ...v2Assert, schemaVersion: 'proofstory.red_evidence.v3' };
    const bad = c.observe(() => c.writeEnvelope([unsupported]));
    assert.ok(
      !onOrdinaryNotConfiguredPath(bad),
      'negative control FAILED: an UNSUPPORTED schemaVersion was handled exactly like a valid v2 record, so this row would pass for any record whatsoever and pins nothing',
    );
    console.log(`      proof B1: v2Loads=byte-identical; v2Quarantined=false; skipFlip=${JSON.stringify(asV1.missingRedEvidence)}->${JSON.stringify(asV2.missingRedEvidence)} on schemaVersion alone; nonInterference=2/2 orders; negControl(schemaVersion=v3)=discriminated`);
  },
});

// ── B2 · E4 (§10.2.1 row E4) — an ABSENT `records` key is NOT corruption ─────
INVARIANT_ROWS.push({
  id: 'B2-records-key-absent-stays-not-configured',
  label: 'an artifact whose `records` key is ABSENT still yields UNSATISFIED via the ordinary not-configured path',
  check: (c) => {
    const o = c.observe(() => c.writeRawArtifact(E4_TEXT));
    // The fixture must really be the E4 shape: the envelope loads, and `records`
    // is genuinely ABSENT (not null, not [], not a mangled value).
    assert.ok(o.readValue !== null && typeof o.readValue === 'object' && !Array.isArray(o.readValue), 'fixture E4: the envelope itself must still load as an object');
    assert.ok(!('records' in o.readValue), 'fixture E4: the `records` key must be genuinely ABSENT, otherwise this row tests a different case');
    assertOrdinaryNotConfigured(o, 'E4 (`records` key absent)');

    // An EMPTY records array is the same not-configured case and must land on
    // the same path — a validator that demanded a present, non-empty `records`
    // would reclassify one or both of these as corruption.
    const empty = c.observe(() => c.writeEnvelope([]));
    assertOrdinaryNotConfigured(empty, 'E4 sibling (`records: []`)');
    assert.equal(o.report, empty.report, 'E4: an absent `records` key and an empty `records` array must be reported identically — both are "not configured"');

    // NEGATIVE CONTROL — the predicate DISCRIMINATES. A genuinely corrupt
    // envelope (`records: {}`, BLOCK A row A6) must never be read as ordinary
    // not-configured. True on BOTH trees: pre-fix it escapes as a bare
    // TypeError, post-fix it must be rejected or quarantined.
    const corrupt = c.observe(() => c.writeRawArtifact(CORRUPT_ENVELOPE_TEXT));
    assert.ok(
      !onOrdinaryNotConfiguredPath(corrupt),
      'negative control FAILED: a CORRUPT envelope (`records: {}`) was accepted as ordinary not-configured, so this row would pass for any artifact whatsoever and pins nothing',
    );
    console.log(`      proof B2: recordsKeyPresent=false; readThrew=false; codes=${JSON.stringify(o.missingRedEvidence)}; report==ABSENT=true; quarantined=false; recordsAbsent==recordsEmpty=true; negControl(records:{})=discriminated`);
  },
});

// ── B3 · the ABSENT side of the distinction must not move ───────────────────
INVARIANT_ROWS.push({
  id: 'B3-absent-side-not-reclassified-as-corruption',
  label: 'the whole NOT-CONFIGURED family stays on one path — the fix must earn BLOCK A by moving the CORRUPT side, not this one',
  check: (c) => {
    // (i) The ABSENT baseline's OWN observable shape, pinned. A fix that made
    //     "no artifact" throw, or emit a corruption code, would "distinguish"
    //     corruption from absence by moving the wrong side and would still turn
    //     BLOCK A's SILENT rows green. This is the assertion that stops it.
    const absent = c.observe(c.removeArtifact);
    assert.equal(absent.readValue, null, 'ABSENT: a missing artifact must read as null — never a thrown or quarantined corruption verdict');
    assertOrdinaryNotConfigured(absent, 'ABSENT (no artifact at all)');

    // (ii) Every member of the not-configured family reports identically. Each
    //      is a shape a read-boundary validator could plausibly mistake for
    //      malformed input; none of them is malformed.
    const family = [
      ['no artifact at all', c.removeArtifact],
      ['`records` key absent', () => c.writeRawArtifact(E4_TEXT)],
      ['`records: []`', () => c.writeEnvelope([])],
      ['only a valid v2 record', () => c.writeEnvelope([v2Assert])],
    ];
    for (const [label, setup] of family) {
      assertOrdinaryNotConfigured(c.observe(setup), `not-configured family — ${label}`);
    }

    // (iii) …and that path stays DISTINCT from the SATISFIED one, so "identical
    //       to absent" never degenerates into "identical to everything".
    assert.notEqual(c.ABSENT.report, c.CLEAN.report, 'the not-configured path must stay distinct from the satisfied path');

    // (iv) NEGATIVE CONTROL — the family predicate DISCRIMINATES. A corrupt
    //      envelope is NOT a family member on either tree.
    //
    //      NOTE the deliberate asymmetry: this row does NOT assert that a
    //      corrupt artifact is currently distinguishable from an absent one.
    //      Pre-fix it is NOT (BLOCK A rows A9-A12 are the live witnesses of
    //      exactly that), and asserting it here would make this row fail on the
    //      pre-fix tree — inverting CHK-010's entire premise. The corrupt half
    //      is BLOCK A's job; this row owns the absent half.
    const corrupt = c.observe(() => c.writeRawArtifact(CORRUPT_ENVELOPE_TEXT));
    assert.ok(
      !onOrdinaryNotConfiguredPath(corrupt),
      'negative control FAILED: a CORRUPT envelope joined the not-configured family, so the family predicate admits anything and pins nothing',
    );
    console.log(`      proof B3: absentReadsNull=true; family=${family.length}/4 on the ordinary not-configured path; notConfigured!=satisfied=true; negControl(records:{})=discriminated`);
  },
});

// ════════════════════════════════════════════════════════════════════════════
// BLOCK C — CHK-009 · order independence.  PRE-FIX EXPECTATION: **MUST FAIL**
//
// Asserts post-fix behaviour, so its rows live in RED_ROWS with BLOCK A's
// `required` / `preFixDefect` shape — NOT in INVARIANT_ROWS.
//
// ── WHAT THIS BLOCK OWNS THAT BLOCK A DOES NOT ──────────────────────────────
//
// `redEvidenceSatisfied` calls `Array.prototype.some`, which SHORT-CIRCUITS on
// the first satisfying record. So whether corruption was NOTICED depended on
// where in the array it sat (§2.3 finding on row I, acceptance matrix §10.3):
//
//   O1  malformed FIRST      → the malformed record is reached → bare TypeError.
//   O2  satisfying FIRST     → `some()` returns true at index 0 and the
//                              malformed record is NEVER EXAMINED → the gate
//                              says SATISFIED over a corrupt artifact, silently.
//
// BLOCK A carries O1 (row A5) and O2 (row A13) as INDIVIDUAL rows. Neither
// states the property that actually failed, which is a RELATION BETWEEN them:
// the same record set produced two different outcomes purely because of order.
// A fix could turn both A5 and A13 green and still be order-dependent (e.g. by
// only ever examining records up to the first satisfier). These rows compare
// permutations against EACH OTHER, which is the only shape that can catch that.
//
// ── OBSERVED PRE-FIX, NOT ASSUMED ───────────────────────────────────────────
//
// The fix had already landed on this tree when these rows were written, so O2's
// old behaviour was re-observed on a rebuilt archive of the pre-fix commit
// `6d7c20bb4b` (`git archive` → `npm run build` → same harness). Verbatim:
//
//   O1 [malformed, satisfying] → gate THREW TypeError(TypeError):
//                                Cannot read properties of undefined (reading 'trim')
//   O2 [satisfying, malformed] → no throw; gate codes []; report byte-identical
//                                to CLEAN; records loaded verbatim, unreported
//   O1.report === O2.report ? false      O2.report === CLEAN.report ? true
//
// and over whole permutation families the split was exactly 2 outcomes:
// 2-set → 2 distinct, 3-set (6 perms) → 2 distinct, 4-set (24 perms) → 2
// distinct, partitioned precisely by whether index 0 was malformed. That is the
// `preFixDefect` signature below, so these rows go RED on that tree and green
// here — they are not vacuous.
//
// ── WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT ──────────────────────────
//
// `index` and the index embedded in `reason` are POSITION-DEPENDENT BY DESIGN:
// they are an accurate pointer to where the bad entry sits, not part of the
// verdict, and an artifact validator that reported the same index for every
// order would be broken. C1 therefore compares a POSITION-FREE observable with
// those two members stripped — and row C2 separately asserts the index IS
// present and correct, so stripping it cannot hide a lost pointer.
// ════════════════════════════════════════════════════════════════════════════

/** Every permutation of `items`, deterministically ordered. */
function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

/** Every entry on a quarantine surface — same surface `hasQuarantineSurface` detects. */
function quarantineEntries(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const key of Object.keys(value)) {
    if (V1_ENVELOPE_KEYS.has(key) || !Array.isArray(value[key])) continue;
    out.push(...value[key]);
  }
  return out;
}

/** Stripped from C1's comparison because they SHOULD track position (see header). */
const POSITION_DEPENDENT_KEYS = new Set(['index', 'reason']);
function positionFreeQuarantine(value) {
  return quarantineEntries(value)
    .map((entry) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? canon(Object.fromEntries(Object.entries(entry).filter(([key]) => !POSITION_DEPENDENT_KEYS.has(key))))
      : canon(entry)))
    .sort();
}

/**
 * Everything observable about a store that must NOT depend on the order records
 * happen to sit in: what the read boundary threw or returned (as a sorted
 * multiset), what the gate threw, the gate's gap codes, and the FULL diagnostic
 * report. Two permutations of one record set must produce the same string.
 */
function positionFreeObservable(o) {
  const records = (o.readValue !== null && typeof o.readValue === 'object' && Array.isArray(o.readValue.records))
    ? o.readValue.records.map(canon).sort()
    : null;
  return canon({
    threw: o.threw,
    errorCtor: o.threw ? (o.error?.constructor?.name ?? null) : null,
    errorName: o.threw ? (o.error?.name ?? null) : null,
    readThrew: o.readThrew,
    readErrorCtor: o.readThrew ? (o.readError?.constructor?.name ?? null) : null,
    codes: o.missingRedEvidence,
    report: o.report,
    records,
    quarantined: positionFreeQuarantine(o.readValue),
  });
}

/** Four malformed FLAVOURS, so "order independent" is not proven for one shape only. */
const malformedNull = { ...satisfying, id: 'corrupt-null', observedFailure: null };
const malformedNumber = { ...satisfying, id: 'corrupt-number', observedFailure: 123 };
const malformedArray = [];

function recordLabel(record) {
  if (Array.isArray(record)) return '[]';
  return (record !== null && typeof record === 'object' && typeof record.id === 'string') ? record.id : String(record);
}

/**
 * The corruption is REPORTED at `index`, in a way an operator can act on.
 * Phrased as a disjunction so the row states the REQUIREMENT (corruption must
 * not pass unnoticed) rather than one implementation of it: a wholesale typed
 * rejection naming the artifact is an equally valid way to not stay silent.
 */
function reportsMalformedAtIndex(o, index, entry) {
  if (o.readThrew || o.threw) {
    const e = o.readThrew ? o.readError : o.error;
    return !isRawBuiltinError(e) && namesArtifactPath(e?.message);
  }
  const hit = quarantineEntries(o.readValue)
    .find((q) => q !== null && typeof q === 'object' && !Array.isArray(q) && q.index === index);
  if (!hit) return false;
  // RETAIN-AND-REPORT: the rejected entry verbatim, its true index named in the
  // reason, and gone from the clean set the typed domain sees.
  if (canon(hit.value) !== canon(entry)) return false;
  if (!String(hit.reason ?? '').includes(`[${index}]`)) return false;
  const clean = Array.isArray(o.readValue?.records) ? o.readValue.records : [];
  return !clean.some((record) => canon(record) === canon(entry));
}

/** The documented pre-fix signature: `some()` short-circuited past it entirely. */
function passedThroughSilently(o, storedRecords) {
  return !o.threw && !o.readThrew
    && Array.isArray(o.missingRedEvidence) && o.missingRedEvidence.length === 0
    && o.report === CLEAN.report
    && !hasQuarantineSurface(o.readValue)
    && canon(o.readValue?.records) === canon(storedRecords);
}

// ── C1 · the verdict must not depend on position ────────────────────────────
const ORDER_FAMILIES = [
  ['{satisfying, id-only} — the exact §10.3 O1/O2 pair', [satisfying, malformed]],
  ['{satisfying, id-only, observedFailure:123}', [satisfying, malformed, malformedNumber]],
  ['{satisfying, id-only, ARRAY record}', [satisfying, malformed, malformedArray]],
  ['{satisfying, id-only, observedFailure:null, ARRAY record}', [satisfying, malformed, malformedNull, malformedArray]],
];

function observeOrderFamilies() {
  const families = ORDER_FAMILIES.map(([label, set]) => {
    const runs = permutations(set).map((perm) => {
      const o = observe(() => writeEnvelope(perm));
      return { order: perm.map(recordLabel).join('|'), leadsWithSatisfier: perm[0] === satisfying, o, observable: positionFreeObservable(o) };
    });
    return {
      label, size: set.length, runs,
      distinct: [...new Set(runs.map((r) => r.observable))],
      satisfierFirst: runs.filter((r) => r.leadsWithSatisfier),
      malformedFirst: runs.filter((r) => !r.leadsWithSatisfier),
    };
  });

  // NEGATIVE CONTROLS — the comparator must ignore ORDER and nothing else. All
  // three were verified to hold on BOTH trees, so a control can never quietly
  // become a RED row of its own.
  const oneSatisfier = positionFreeObservable(observe(() => writeEnvelope([satisfying])));
  const withMalformed = positionFreeObservable(observe(() => writeEnvelope([satisfying, malformed])));
  const otherFlavour = positionFreeObservable(observe(() => writeEnvelope([satisfying, malformedNumber])));
  const absent = positionFreeObservable(observe(removeArtifact));
  assert.notEqual(withMalformed, oneSatisfier, 'negative control FAILED: ADDING a malformed record left the position-free observable unchanged, so C1 would hold for any store whatsoever and pins nothing');
  assert.notEqual(withMalformed, otherFlavour, 'negative control FAILED: SWAPPING one malformed flavour for another left the position-free observable unchanged — it is insensitive to content, not just to order');
  assert.notEqual(oneSatisfier, absent, 'negative control FAILED: a SATISFIED store and an ABSENT one share one position-free observable, so the comparator collapses everything');

  const total = families.reduce((n, f) => n + f.runs.length, 0);
  const distincts = families.map((f) => `${f.size}-set:${f.runs.length}perm->${f.distinct.length}`).join(', ');
  return {
    families,
    summary: `${total} permutations over ${families.length} record sets; distinct position-free observables per set: ${distincts}`,
    proofLine: `families=${families.length}; permutations=${total}; distinctPerFamily=${families.map((f) => f.distinct.length).join(',')}; `
      + `bareTypeErrors=${families.reduce((n, f) => n + f.runs.filter((r) => r.o.threw && isBareTypeError(r.o.error)).length, 0)}; `
      + 'negControls(addMalformed/swapFlavour/absent)=discriminated',
  };
}

RED_ROWS.push({
  id: 'C1-verdict-order-independent',
  block: 'C.1', klass: 'ORDER-DEPENDENCE',
  label: 'the SAME record set yields the SAME verdict in EVERY permutation (§10.3 rows O1 + O2, compared against each other)',
  observeRow: observeOrderFamilies,
  preFixDefectDesc: 'the verdict SPLITS on array position — every family collapses to exactly TWO outcomes, partitioned precisely by whether index 0 is malformed: satisfier-first is SATISFIED with no throw and a report byte-identical to CLEAN, malformed-first escapes a bare TypeError',
  preFixDefect: (o) => o.families.length > 0 && o.families.every((f) =>
    f.distinct.length === 2
    && f.satisfierFirst.length > 0 && f.malformedFirst.length > 0
    && new Set(f.satisfierFirst.map((r) => r.observable)).size === 1
    && new Set(f.malformedFirst.map((r) => r.observable)).size === 1
    && f.satisfierFirst.every((r) => !r.o.threw && !r.o.readThrew
      && Array.isArray(r.o.missingRedEvidence) && r.o.missingRedEvidence.length === 0
      && r.o.report === CLEAN.report && !hasQuarantineSurface(r.o.readValue))
    && f.malformedFirst.every((r) => r.o.threw && isBareTypeError(r.o.error))),
  requiredDesc: 'every permutation of every family collapses to ONE position-free observable — same read result, same gap codes, same FULL diagnostic report, same quarantined set — and no permutation escapes a bare TypeError',
  required: (o) => o.families.length > 0 && o.families.every((f) =>
    f.distinct.length === 1 && f.runs.every((r) => !(r.o.threw && isBareTypeError(r.o.error)))),
});

// ── C2 · a malformed entry BEHIND a satisfying record is still reported ─────
// The half `some()` used to swallow whole. Every malformed flavour, at every
// depth behind 1-3 satisfying records, so no fix can pass by special-casing
// index 1 or the one shape BLOCK A row A13 happens to use.
function observeSatisfierPrefixed() {
  const flavours = [
    ['{ id: "corrupt" } — versionless', malformed],
    ['observedFailure: null', malformedNull],
    ['observedFailure: 123', malformedNumber],
    ['the record itself is an ARRAY', malformedArray],
  ];
  const cases = [];
  for (const [flavourLabel, entry] of flavours) {
    for (const depth of [1, 2, 3]) {
      const stored = [...Array.from({ length: depth }, () => satisfying), entry];
      const o = observe(() => writeEnvelope(stored));
      cases.push({
        label: `${flavourLabel} behind ${depth} satisfying record(s)`,
        depth, entry, stored, o,
        reported: reportsMalformedAtIndex(o, depth, entry),
        silent: passedThroughSilently(o, stored),
        // Independent of `reported`: the index this run actually attributed the
        // entry to. Printed so C1's index-stripping cannot hide a lost pointer.
        attributedIndex: quarantineEntries(o.readValue)
          .filter((q) => q !== null && typeof q === 'object' && !Array.isArray(q) && canon(q.value) === canon(entry))
          .map((q) => q.index).join('&'),
      });
    }
  }
  const reported = cases.filter((c) => c.reported).length;
  const silent = cases.filter((c) => c.silent).length;
  const indicesExact = cases.filter((c) => c.attributedIndex === String(c.depth)).length;
  return {
    cases,
    summary: `${cases.length} (flavour × depth) cases with a satisfying record FIRST: ${reported} reported at the true index, ${silent} passed through silently`,
    proofLine: `cases=${cases.length}; reportedAtTrueIndex=${reported}/${cases.length}; silentPassThrough=${silent}/${cases.length}; `
      + `flavours=${flavours.length}; depths=1,2,3; attributedIndexExact=${indicesExact}/${cases.length}; `
      + `attributedIndices=[${cases.map((c) => c.attributedIndex || 'none').join(',')}]`,
  };
}

RED_ROWS.push({
  id: 'C2-malformed-reported-behind-satisfier',
  block: 'C.2', klass: 'ORDER-DEPENDENCE',
  label: 'a malformed entry is REPORTED even when satisfying records precede it (§10.3 row O2, every flavour × every depth)',
  observeRow: observeSatisfierPrefixed,
  preFixDefectDesc: 'every case passes through SILENTLY: no throw, verdict SATISFIED, report byte-identical to CLEAN, no quarantine surface, and the records array loads byte-identically to the corrupt bytes on disk — `some()` never examined the entry',
  preFixDefect: (o) => o.cases.length > 0 && o.cases.every((c) => c.silent),
  requiredDesc: 'every case REPORTS the entry: retained verbatim at its TRUE index with that index named in the reason and removed from the clean record set — or the artifact is rejected wholesale by a typed error naming the path',
  required: (o) => o.cases.length > 0 && o.cases.every((c) => c.reported),
});

// ── C3 · detection is EXHAUSTIVE, not first-match ───────────────────────────
// `some()` stopped at the first satisfier; a fix that merely stopped at the
// first MALFORMED entry instead would still be position-sensitive. Three
// malformed entries behind one satisfier: all three must be accounted for.
function observeExhaustiveDetection() {
  const malformedSet = [malformed, malformedNull, malformedArray];
  const orders = [
    ['satisfier FIRST (pre-fix: `some()` stopped at index 0)', [satisfying, ...malformedSet], 1],
    ['malformed FIRST (pre-fix: crashed on index 0)', [...malformedSet, satisfying], 0],
  ];
  const runs = orders.map(([label, stored, firstMalformedIndex]) => {
    const o = observe(() => writeEnvelope(stored));
    const reported = malformedSet.filter((entry, i) => reportsMalformedAtIndex(o, firstMalformedIndex + i, entry)).length;
    const wholesale = (o.readThrew && !isRawBuiltinError(o.readError)) || (o.threw && !isRawBuiltinError(o.error));
    return { label, stored, o, reported, wholesale, observable: positionFreeObservable(o) };
  });
  const [satisfierFirst, malformedFirst] = runs;
  return {
    runs, satisfierFirst, malformedFirst, expected: malformedSet.length,
    agree: satisfierFirst.observable === malformedFirst.observable,
    summary: `3 malformed entries + 1 satisfier: satisfier-first reported ${satisfierFirst.reported}/3, malformed-first reported ${malformedFirst.reported}/3, observables agree=${satisfierFirst.observable === malformedFirst.observable}`,
    proofLine: `expected=3; satisfierFirstReported=${satisfierFirst.reported}; malformedFirstReported=${malformedFirst.reported}; `
      + `ordersAgree=${satisfierFirst.observable === malformedFirst.observable}; `
      + `satisfierFirstThrew=${satisfierFirst.o.threw}; malformedFirstThrew=${malformedFirst.o.threw}`,
  };
}

RED_ROWS.push({
  id: 'C3-detection-exhaustive-not-first-match',
  block: 'C.3', klass: 'ORDER-DEPENDENCE',
  label: 'detection examines EVERY entry, not just up to the first match — 3 malformed entries behind a satisfying record are all accounted for',
  observeRow: observeExhaustiveDetection,
  preFixDefectDesc: 'the number of corruptions DETECTED depends on position: satisfier-first detects 0 of 3 with no throw and verdict SATISFIED, while malformed-first escapes a bare TypeError, so the two orders disagree',
  preFixDefect: (o) =>
    o.satisfierFirst.reported === 0
    && passedThroughSilently(o.satisfierFirst.o, o.satisfierFirst.stored)
    && o.malformedFirst.o.threw && isBareTypeError(o.malformedFirst.o.error)
    && !o.agree,
  requiredDesc: 'BOTH orders account for all 3 — each entry reported at its true index, or the artifact rejected wholesale by a typed error — and the two orders share ONE position-free observable',
  required: (o) => o.agree && o.runs.every((r) => r.wholesale || r.reported === o.expected),
});

// ════════════════════════════════════════════════════════════════════════════
// BLOCK D — CHK-011 · validator totality fuzz over arbitrary acyclic JSON.
//
// Asserts post-fix behaviour, so its rows belong in RED_ROWS (same
// `required` / `preFixDefect` shape) — NOT in INVARIANT_ROWS.
//
// ── WHY A PROPERTY, AND NOT SIMPLY MORE ROWS ────────────────────────────────
//
// Every enumerated row above was written from an OBSERVED failure. Those rows
// prove the KNOWN cases and say nothing whatsoever about the unknown ones —
// which is, in test form, precisely the blind spot that produced this defect:
// `'v1'` was a RESIDUAL class, trusted because nobody had yet seen it break.
// Decision document §10.5 therefore states the requirement as a PROPERTY —
// "the validator itself cannot throw on any JSON shape" — and a property is the
// only assertion shape that can fail on an input nobody thought to list.
//
// ── DETERMINISTIC BY CONSTRUCTION ───────────────────────────────────────────
//
// A flaky property test is worse than none: an irreproducible failure gets
// re-run until it is green, which is how a real defect becomes "that test is
// flaky". The generator is a seeded PRNG and consumes nothing else — no
// `Math.random`, no clock, no directory listing, no environment beyond the seed
// itself. The seed is PRINTED, together with a `corpusDigest` over the
// canonical form of every generated value, so two runs are provably the SAME
// corpus and `RED_B2AA7_FUZZ_SEED=<seed> node <this file>` reproduces any
// failure exactly. `red-b2aa7-chk011-receipt.mjs` re-runs this file three times
// and checks both halves mechanically: same seed → byte-identical proof lines;
// different seed → a different corpus that still holds the property.
//
// ── THE THREE THINGS THAT KEEP IT FROM BEING DECORATION ─────────────────────
//
// A fuzz can pass for bad reasons: too few inputs, inputs too boring to reach
// the code under test, or inputs so harmless that ANY implementation would
// survive them. All three are closed by fatal fixture assertions inside the
// observer, and all three counts are printed:
//
//   COVERAGE  the corpus demonstrably contains what §10.5 / CHK-011 name —
//             empty containers, deep nesting, mixed-primitive arrays, unusual
//             but legal keys, `Object.create(null)`, own `__proto__` keys and
//             prototype-INHERITED fields. Counted by walking the corpus, never
//             assumed. That walk doubles as the ACYCLICITY proof.
//   REACH     the classifications actually observed span EVERY envelope fault
//             code, the record-schema fault, the quarantine outcome AND the
//             clean accept. A corpus that only ever bounced off
//             `root_not_object` would never enter record-level code at all.
//   POTENCY   the SAME corpus, fed to an unguarded transcription of the PRE-FIX
//             read path, still crashes it with raw builtin errors. So "the
//             validator never threw" is a fact about the VALIDATOR, not about a
//             corpus of inputs that could not have broken anything.
//
// ── WHAT IS DELIBERATELY NOT FUZZED ─────────────────────────────────────────
//
// `validateRedEvidenceEnvelope` and `validateRedEvidenceArtifact` THROW BY
// DESIGN (§10.2.1 row E7 requires a throw, just a typed one naming the path),
// so "never throws" is the wrong property for them and asserting it would
// encode a requirement the audit explicitly rejects. The total entry points are
// `classifyRedEvidenceArtifact` (D1) and `partitionRedEvidenceRecords` (D2);
// row D3 covers the throwing wrapper with the property it actually has — no RAW
// builtin ever escapes the live read boundary, and every typed rejection names
// the artifact.
//
// Nesting is capped at ~200 levels. Beyond that `JSON.parse` itself is the
// binding constraint, so a deeper fixture would be fuzzing V8's parser rather
// than this validator, and a `RangeError` from the harness's own recursion
// would read as a defect in code that never ran.
// ════════════════════════════════════════════════════════════════════════════
const { createHash } = await import('node:crypto');

// The validator is imported DEFENSIVELY. On the pre-fix tree this module does
// not exist at all, and a bare top-level import would abort the whole harness
// before any row could report. Instead its absence becomes row D1's documented
// pre-fix defect: the §10.5 property had no implementation to hold it.
let VALIDATOR = null;
let VALIDATOR_IMPORT_ERROR = null;
try {
  VALIDATOR = await import(`${DIST}/core/red-evidence-artifact-validation.js`);
} catch (e) {
  VALIDATOR_IMPORT_ERROR = e;
}

const FUZZ_SEED = process.env.RED_B2AA7_FUZZ_SEED ?? 'B-2aa7/CHK-011/fuzz/v1';
const FUZZ_STRATUM_SIZE = 1200;
const FUZZ_VALUE_DEPTH = 4;
/** Floor below which "a property" would just be a case list with extra steps. */
const FUZZ_MIN_CASES = 4000;
/**
 * Floors for the two things that make the case count meaningful: how many
 * DISTINCT shapes the corpus holds that appear nowhere in the enumerated rows,
 * and how many arrays row D2 gets to partition. Both are lower than the case
 * count because primitives legitimately recur — the point is that neither can
 * quietly collapse to a handful without failing here.
 */
const FUZZ_MIN_NOVEL = 3000;
const FUZZ_MIN_ARRAYS = 2000;
/** How many generated artifacts are also driven through the LIVE gate pair (~95ms each). */
const FUZZ_GATE_SAMPLE = 16;
/** Floor for the potency control: the corpus must genuinely break unguarded code. */
const FUZZ_MIN_POTENCY = 100;

// ── seeded PRNG ─────────────────────────────────────────────────────────────
// FNV-1a over the seed string, then mulberry32. Small, pure, and reproducible
// across Node versions — `Math.random` is unusable here by definition.
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(fnv1a32(FUZZ_SEED));
const rndInt = (n) => Math.floor(rnd() * n);
const rndPick = (items) => items[rndInt(items.length)];

// ── the alphabet ────────────────────────────────────────────────────────────
// Primitives are all JSON-REPRESENTABLE on purpose (no NaN, no Infinity, no
// undefined, no BigInt): the property under test is about JSON shapes, and a
// value that cannot survive `JSON.stringify` could not have come off disk.
// `-0`, `1e308` and a 300-character string are legal JSON and are included.
const FUZZ_PRIMITIVES = [
  null, true, false,
  0, -0, 1, -1, 42, 123, -7.5, 0.1, 1e308, -1e-7, Number.MAX_SAFE_INTEGER,
  '', ' ', '   ', 'x', 'a string', 'null', 'undefined', '0', 'true',
  'proofstory.red_evidence.v1', 'proofstory.red_evidence.v2', 'proofstory.red_evidence.v3',
  'same_acceptance', 'regression_to_green', 'not_a_relation', 'M1',
  '__proto__', 'constructor', ' ', '✓ unicode ☃', '\\', '"', 'a'.repeat(300),
];
// Keys are unusual BUT LEGAL. `__proto__` / `constructor` / `toString` /
// `hasOwnProperty` are the ones that break naive `record[key]` and
// `key in record` validators; '' and '0' and ' ' are legal JSON keys that
// hand-written fixtures never contain.
const FUZZ_KEYS = [
  '', ' ', 'a', 'id', 'trigger', 'createdAt', 'records', 'schemaVersion', 'storyId',
  'observedFailure', 'greenRelation', 'targetRef', 'relation', 'acceptanceTargetRef',
  'baselineHeadHash', 'baselineMaterialHash', 'failingCommand', 'malformedRecords',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf',
  '0', '1', '-1', 'length', 'a.b', 'a b', '✓', 'null', '"', '\\',
];

/**
 * A prototype carrying every field the v1 schema demands. An object created
 * from it answers `record.observedFailure` while OWNING nothing — the §10.2 row
 * M8 shape, and the exact reason the validator uses `hasOwnProperty` rather
 * than a plain property read. `JSON.parse` can never produce this, so only a
 * generator can put it in front of the validator.
 */
const FUZZ_INHERITED_PROTO = Object.freeze({
  id: 'inherited-id', trigger: 'inherited trigger', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'inherited-head', baselineMaterialHash: 'inherited-mat',
  observedFailure: 'inherited observed failure', createdAt: NOW,
  greenRelation: Object.freeze({ targetRef: 'M1', relation: 'same_acceptance' }),
});

/**
 * `target.__proto__ = v` on a plain object REPLACES THE PROTOTYPE instead of
 * creating an own key, which would silently drop the very shape being
 * generated. `defineProperty` creates a real own data property that shadows the
 * accessor — which is also exactly what `JSON.parse` does.
 */
function defineOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
function makeObject(entries, proto = 'plain') {
  const target = proto === 'null' ? Object.create(null)
    : proto === 'inherited' ? Object.create(FUZZ_INHERITED_PROTO)
      : {};
  for (const [key, value] of entries) defineOwn(target, key, value);
  return target;
}

// ── generators ──────────────────────────────────────────────────────────────
function randomValue(depth) {
  const roll = rnd();
  if (depth <= 0 || roll < 0.45) return rndPick(FUZZ_PRIMITIVES);
  if (roll < 0.68) return Array.from({ length: rndInt(5) }, () => randomValue(depth - 1));
  const proto = rnd() < 0.14 ? 'null' : rnd() < 0.1 ? 'inherited' : 'plain';
  const entries = [];
  const count = rndInt(6);
  for (let i = 0; i < count; i += 1) entries.push([rndPick(FUZZ_KEYS), randomValue(depth - 1)]);
  return makeObject(entries, proto);
}

/** A chain `levels` deep, alternating array / object / null-prototype object. */
function deepValue(levels, leaf) {
  let value = leaf;
  for (let i = 0; i < levels; i += 1) {
    value = i % 3 === 0
      ? [value]
      : makeObject([[i % 3 === 1 ? 'records' : 'a', value]], i % 7 === 5 ? 'null' : 'plain');
  }
  return value;
}

const V1_FILE_VERSION = 'proofstory.red_evidence.v1';

/** A well-formed v1 ENVELOPE around whatever `records` is handed in. */
function fuzzEnvelope(records, proto = 'plain') {
  return makeObject([
    ['schemaVersion', V1_FILE_VERSION], ['storyId', storyId],
    ['records', records], ['createdAt', NOW], ['updatedAt', NOW],
  ], proto);
}

/** An envelope with a randomly correct / wrong / ABSENT file-level version (E5/E6/E1-E3). */
function randomEnvelope() {
  const entries = [];
  const versionRoll = rnd();
  if (versionRoll < 0.55) entries.push(['schemaVersion', V1_FILE_VERSION]);
  else if (versionRoll < 0.82) entries.push(['schemaVersion', randomValue(1)]);
  // else: no `schemaVersion` member at all — row E6, which must NOT degrade to v1.
  if (rnd() < 0.86) entries.push(['records', randomValue(FUZZ_VALUE_DEPTH - 1)]);
  if (rnd() < 0.5) entries.push(['storyId', rnd() < 0.5 ? storyId : rndPick(FUZZ_PRIMITIVES)]);
  if (rnd() < 0.4) entries.push([rndPick(FUZZ_KEYS), randomValue(2)]);
  return makeObject(entries, rnd() < 0.1 ? 'null' : 'plain');
}

/** Field paths of the SATISFYING record, i.e. the ones full v1 validation reads. */
const FUZZ_MUTANT_PATHS = [
  ['id'], ['trigger'], ['acceptanceTargetRef'], ['baselineHeadHash'], ['baselineMaterialHash'],
  ['observedFailure'], ['createdAt'], ['failingCommand'], ['schemaVersion'],
  ['greenRelation'], ['greenRelation', 'targetRef'], ['greenRelation', 'relation'],
];

/**
 * A single-point mutation of the record that DOES satisfy the gate. These are
 * the inputs that get furthest into the validator: they pass the envelope, they
 * classify `'v1'`, and only then does one field turn out to be wrong.
 */
function mutantRecord() {
  const clone = { ...satisfying, greenRelation: { ...satisfying.greenRelation } };
  const path = rndPick(FUZZ_MUTANT_PATHS);
  const drop = rnd() < 0.3;
  if (path.length === 1) {
    if (drop) delete clone[path[0]];
    else clone[path[0]] = randomValue(2);
  } else {
    const parent = clone[path[0]];
    if (parent !== null && typeof parent === 'object') {
      if (drop) delete parent[path[1]];
      else parent[path[1]] = randomValue(2);
    }
  }
  const proto = rnd() < 0.12 ? 'null' : rnd() < 0.12 ? 'inherited' : 'plain';
  // For the inherited shape, strip the own field so the ONLY way to see it is
  // through the prototype chain (row M8).
  if (proto === 'inherited') delete clone.observedFailure;
  const entries = Object.entries(clone);
  if (rnd() < 0.15) entries.push([rndPick(FUZZ_KEYS), randomValue(1)]);
  return makeObject(entries, proto);
}

/**
 * Hand-forced structural edges. These consume NO randomness, so every one of
 * them is present under EVERY seed — the named requirements of CHK-011 are
 * guaranteed rather than left to a lucky draw, while the four random strata
 * supply the shapes nobody thought to name.
 */
function structuralCases() {
  const allFieldsNoProto = makeObject(Object.entries(satisfying), 'null');
  const inheritedOnly = makeObject([], 'inherited');
  const protoKeyed = makeObject([['__proto__', fuzzEnvelope([satisfying])]]);
  return [
    ['empty object', {}],
    ['empty array', []],
    ['empty string', ''],
    ['blank string', '   '],
    ['zero', 0],
    ['negative zero', -0],
    ['false', false],
    ['null root', null],
    ['null-prototype empty object', Object.create(null)],
    ['null-prototype envelope, empty records', fuzzEnvelope([], 'null')],
    ['envelope with records: []', fuzzEnvelope([])],
    ['envelope with records: [{}]', fuzzEnvelope([{}])],
    ['envelope with records: [[]] (an ARRAY record)', fuzzEnvelope([[]])],
    ['envelope with records: [[], {}, null, 0, "", true]', fuzzEnvelope([[], {}, null, 0, '', true])],
    ['envelope with a null-prototype record carrying EVERY v1 field', fuzzEnvelope([allFieldsNoProto])],
    ['envelope with a record that OWNS nothing and inherits every v1 field (row M8)', fuzzEnvelope([inheritedOnly])],
    ['envelope with an empty null-prototype record', fuzzEnvelope([Object.create(null)])],
    ['envelope whose records is an ARRAY-LIKE object {0:…, length:1}', fuzzEnvelope(makeObject([['0', satisfying], ['length', 1]]))],
    ['envelope whose records is a null-prototype object', fuzzEnvelope(Object.create(null))],
    ['envelope whose records is the empty string', fuzzEnvelope('')],
    ['envelope whose records is a nested empty array', fuzzEnvelope([[[]]])],
    ['envelope with 300 empty-object records (breadth)', fuzzEnvelope(Array.from({ length: 300 }, () => ({})))],
    ['envelope with schemaVersion: {}', makeObject([['schemaVersion', {}], ['records', []]])],
    ['envelope with schemaVersion: []', makeObject([['schemaVersion', []], ['records', []]])],
    ['envelope with schemaVersion: null', makeObject([['schemaVersion', null], ['records', []]])],
    ['envelope with schemaVersion: ""', makeObject([['schemaVersion', ''], ['records', []]])],
    ['envelope with NO schemaVersion member (row E6)', makeObject([['records', []]])],
    ['envelope with NO records member (row E4)', makeObject([['schemaVersion', V1_FILE_VERSION]])],
    ['object with an OWN "__proto__" key holding a whole envelope', protoKeyed],
    ['envelope whose records hold an own-"__proto__" record', fuzzEnvelope([makeObject([['__proto__', satisfying]])])],
    ['object with an own "constructor" key', makeObject([['constructor', 'not a function'], ['records', []]])],
    ['object with an own "toString" key holding an array', makeObject([['toString', [1, 2]]])],
    ['object with the empty string as a key', makeObject([['', 'empty key']])],
    ['mixed-primitive array', [null, true, 0, '', 1e308, 'x', -0.5]],
    ['array of empty containers', [[], {}, [], {}]],
    ['deep chain, 2 levels', deepValue(2, satisfying)],
    ['deep chain, 8 levels', deepValue(8, {})],
    ['deep chain, 64 levels', deepValue(64, [])],
    ['deep chain, 200 levels', deepValue(200, null)],
    ['envelope whose records is a 200-level deep chain', fuzzEnvelope(deepValue(200, []))],
    ['envelope whose record field is a 200-level deep chain', fuzzEnvelope([{ ...satisfying, observedFailure: deepValue(200, 'x') }])],
    ['envelope whose schemaVersion is a 200-level deep chain', makeObject([['schemaVersion', deepValue(200, 'x')], ['records', []]])],
    ['a valid v2 record beside a mutant', fuzzEnvelope([v2Assert, { ...satisfying, observedFailure: null }])],
    ['every enumerated malformed flavour at once', fuzzEnvelope([malformed, malformedNull, malformedNumber, malformedArray, satisfying])],
    ['300-character string root', 'a'.repeat(300)],
    ['array containing the envelope itself (nested, not cyclic)', [fuzzEnvelope([satisfying])]],
  ];
}

/**
 * The PRE-FIX read+predicate path, transcribed with its guards REMOVED — the
 * POTENCY control. Not a paraphrase: the envelope was never validated
 * (`store.readRedEvidence` handed the raw parsed value to the typed domain,
 * audit §2.4), and the predicate went straight from the schema discriminant to
 * `record.observedFailure.trim()`, THE crash site of audit §2.1, with no shape
 * guard in front of it (CHK-005 added that guard; this is the code as it stood
 * before). Feeding the corpus to this proves the corpus can break something —
 * without which "the validator never threw" would be a fact about the inputs.
 */
function unguardedPreFixReader(parsed) {
  const records = parsed?.records ?? [];
  return records.some((record) => {
    if (isRedEvidenceV2(record)) return false;
    if (classifyRedRecordSchemaSafe(record) !== 'v1') return false;
    return record.observedFailure.trim().length > 0;
  });
}

/**
 * Walk a generated value: collect coverage counters AND prove acyclicity. The
 * `path` set holds only the ancestors of the current node, so shared subtrees
 * (a DAG, which the generators do produce) are fine and only a genuine cycle is
 * reported. A cycle would make `canon` and `JSON.stringify` diverge, so this is
 * a real precondition of the corpus, not paperwork.
 */
function walkValue(value, path, stats) {
  if (value === null || typeof value !== 'object') {
    stats.primitiveKinds.add(value === null ? 'null' : typeof value);
    return 1;
  }
  if (path.has(value)) { stats.cycles += 1; return 1; }
  path.add(value);
  let deepest = 0;
  if (Array.isArray(value)) {
    stats.arrays += 1;
    if (value.length === 0) stats.emptyArrays += 1;
    const primitiveKinds = new Set(
      value.filter((v) => v === null || typeof v !== 'object').map((v) => (v === null ? 'null' : typeof v)),
    );
    if (primitiveKinds.size >= 3) stats.mixedPrimitiveArrays += 1;
    for (const item of value) deepest = Math.max(deepest, walkValue(item, path, stats));
  } else {
    stats.objects += 1;
    const proto = Object.getPrototypeOf(value);
    if (proto === null) stats.nullProtoObjects += 1;
    else if (proto !== Object.prototype) stats.inheritedProtoObjects += 1;
    const keys = Object.keys(value);
    if (keys.length === 0) stats.emptyObjects += 1;
    for (const key of keys) {
      stats.distinctKeys.add(key);
      if (key === '__proto__') stats.protoOwnKeys += 1;
      deepest = Math.max(deepest, walkValue(value[key], path, stats));
    }
  }
  path.delete(value);
  return deepest + 1;
}

/** Is this a CLASSIFICATION, i.e. a well-formed member of the documented union? */
function isWellFormedClassification(classified) {
  if (classified === null || typeof classified !== 'object') return false;
  if (classified.ok === true) {
    if (classified.data === null || typeof classified.data !== 'object') return false;
    if (!Array.isArray(classified.malformed)) return false;
    return classified.malformed.every((entry) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && Number.isInteger(entry.index) && entry.index >= 0
      && (entry.id === null || typeof entry.id === 'string')
      && typeof entry.reason === 'string' && entry.reason.length > 0
      && Array.isArray(entry.violations) && entry.violations.length > 0
      && entry.violations.every((v) => typeof v === 'string' && v.length > 0)
      && Object.prototype.hasOwnProperty.call(entry, 'value'));
  }
  if (classified.ok !== false) return false;
  if (classified.fault !== 'envelope' && classified.fault !== 'record_schema') return false;
  const { error } = classified;
  if (!(error instanceof Error) || typeof error.message !== 'string' || error.message.length === 0) return false;
  if (classified.fault === 'record_schema') return error.name === 'RedEvidenceSchemaError';
  // An ENVELOPE fault must name the artifact and must never read as a record
  // fault — the misattribution of row A8, restated as a property.
  return error.name === 'RedEvidenceArtifactError'
    && FUZZ_ENVELOPE_CODES.has(error.code)
    && error.artifactPath === ARTIFACT_PATH
    && namesArtifactPath(error.message)
    && !MISATTRIBUTES_TO_RECORD.test(error.message);
}
const FUZZ_ENVELOPE_CODES = new Set([
  'unparseable', 'root_not_object', 'schema_version_missing', 'schema_version_unknown', 'records_not_array',
]);

/** Built once, shared by D1 / D2 / D3 — the three rows are three properties of ONE corpus. */
let FUZZ = null;
function fuzz() {
  if (FUZZ !== null) return FUZZ;

  // ── build ────────────────────────────────────────────────────────────────
  const corpus = [];
  const add = (stratum, value, label = null) => corpus.push({ stratum, value, label });
  for (let i = 0; i < FUZZ_STRATUM_SIZE; i += 1) add('raw', randomValue(FUZZ_VALUE_DEPTH));
  for (let i = 0; i < FUZZ_STRATUM_SIZE; i += 1) add('envelope', randomEnvelope());
  for (let i = 0; i < FUZZ_STRATUM_SIZE; i += 1) {
    const known = [satisfying, v2Assert, malformed, malformedNull, malformedNumber, malformedArray];
    const entries = Array.from({ length: rndInt(5) }, () => (rnd() < 0.25 ? rndPick(known) : randomValue(3)));
    add('records', fuzzEnvelope(rnd() < 0.9 ? entries : randomValue(2)));
  }
  for (let i = 0; i < FUZZ_STRATUM_SIZE; i += 1) {
    const entries = Array.from({ length: 1 + rndInt(4) }, () => (rnd() < 0.75 ? mutantRecord() : rndPick([satisfying, v2Assert])));
    add('mutants', fuzzEnvelope(entries));
  }
  for (const [label, value] of structuralCases()) add('structural', value, label);

  const strata = {};
  for (const item of corpus) strata[item.stratum] = (strata[item.stratum] ?? 0) + 1;

  // ── COVERAGE + acyclicity ────────────────────────────────────────────────
  const stats = {
    objects: 0, arrays: 0, emptyObjects: 0, emptyArrays: 0, nullProtoObjects: 0,
    inheritedProtoObjects: 0, protoOwnKeys: 0, mixedPrimitiveArrays: 0, cycles: 0,
    distinctKeys: new Set(), primitiveKinds: new Set(),
  };
  let maxDepth = 0;
  const canonSeen = new Set();
  for (const item of corpus) {
    maxDepth = Math.max(maxDepth, walkValue(item.value, new Set(), stats));
    canonSeen.add(canon(item.value));
  }
  const corpusDigest = createHash('sha256').update([...canonSeen].sort().join(' ')).digest('hex');

  assert.ok(corpus.length >= FUZZ_MIN_CASES, `fuzz: only ${corpus.length} generated values — a property over a handful of inputs is just another case list`);
  assert.equal(stats.cycles, 0, 'fuzz: the corpus must be ACYCLIC — a cycle makes canon/JSON.stringify diverge and the property untestable');
  assert.ok(stats.emptyObjects > 0 && stats.emptyArrays > 0, `fuzz coverage: EMPTY CONTAINERS missing (objects=${stats.emptyObjects}, arrays=${stats.emptyArrays})`);
  assert.ok(stats.nullProtoObjects > 0, 'fuzz coverage: no Object.create(null) value was generated — CHK-011 names it explicitly');
  assert.ok(stats.inheritedProtoObjects > 0, 'fuzz coverage: no PROTOTYPE-INHERITED shape was generated — row M8 would go untested');
  assert.ok(stats.protoOwnKeys > 0, 'fuzz coverage: no own "__proto__" key was generated');
  assert.ok(stats.mixedPrimitiveArrays > 0, 'fuzz coverage: no MIXED-PRIMITIVE array was generated');
  assert.ok(maxDepth >= 100, `fuzz coverage: deepest value is only ${maxDepth} levels — "deeply nested" is not covered`);
  assert.ok(stats.distinctKeys.size >= 20, `fuzz coverage: only ${stats.distinctKeys.size} distinct keys — unusual-but-legal keys are not covered`);
  assert.ok(stats.primitiveKinds.size >= 4, `fuzz coverage: only ${[...stats.primitiveKinds].join('/')} primitive kinds`);
  // NOVELTY — the corpus must not be the enumerated rows in disguise. Every
  // fixture BLOCK A / B / C uses, compared against the corpus by canonical form.
  const enumerated = new Set([
    satisfying, malformed, malformedNull, malformedNumber, malformedArray, v2Assert, v2Quarantine,
    v1Twin, v2Hybrid, [], 'x', null, 42, {}, fuzzEnvelope([satisfying]), fuzzEnvelope([]),
  ].map(canon));
  const novel = [...canonSeen].filter((c) => !enumerated.has(c)).length;
  assert.ok(
    novel >= FUZZ_MIN_NOVEL,
    `fuzz NOVELTY: only ${novel} of the ${canonSeen.size} distinct generated shapes appear nowhere in the enumerated fixtures — the property would be re-testing the case list it exists to escape`,
  );

  // ── D1 · classify totality ───────────────────────────────────────────────
  const outcomes = {};
  const bump = (key) => { outcomes[key] = (outcomes[key] ?? 0) + 1; };
  const classifyThrew = [];
  const badShape = [];
  const classifications = new Array(corpus.length).fill(null);
  if (VALIDATOR !== null) {
    corpus.forEach((item, i) => {
      let classified;
      try {
        classified = VALIDATOR.classifyRedEvidenceArtifact(item.value, ARTIFACT_PATH);
      } catch (e) {
        classifyThrew.push({ item, error: e });
        return;
      }
      classifications[i] = classified;
      if (!isWellFormedClassification(classified)) { badShape.push({ item, classified }); return; }
      if (classified.ok) bump(classified.malformed.length > 0 ? 'ok-quarantined' : 'ok-clean');
      else bump(classified.fault === 'envelope' ? `envelope/${classified.error.code}` : 'record_schema');
    });

    // REACH — the corpus must actually get INTO the code. Every envelope fault
    // code, the record-schema fault, quarantine and clean accept, all observed.
    //
    // Deliberately SKIPPED while any value is still throwing. A throw already
    // aborts the classification that would have recorded the outcome, so with
    // throws present a missing outcome is a CONSEQUENCE of the defect, and
    // reporting it as a weak corpus would send a reader to fix the fixture
    // instead of the validator. Row D1 owns that case and names the throw.
    // (Observed while mutation-testing this block: an unguarded dereference
    // reintroduced into `v1RecordViolations` made this fire first, with the
    // wrong diagnosis.)
    if (classifyThrew.length === 0) {
      for (const key of ['ok-clean', 'ok-quarantined', 'record_schema',
        'envelope/root_not_object', 'envelope/schema_version_missing',
        'envelope/schema_version_unknown', 'envelope/records_not_array']) {
        assert.ok(
          (outcomes[key] ?? 0) > 0,
          `fuzz REACH: none of the ${corpus.length} generated values ever produced "${key}", and nothing threw. `
          + `EITHER the corpus degenerated and no longer reaches that branch, OR the branch no longer exists. `
          + `Both are real failures: a property that cannot reach the code proves nothing about it. `
          + `Observed outcomes: ${Object.entries(outcomes).sort().map(([k, n]) => `${k}:${n}`).join(', ') || 'none'}`,
        );
      }
    }
  }

  // ── POTENCY — the same corpus against the unguarded pre-fix transcription ──
  let potency = 0;
  for (const item of corpus) {
    try { unguardedPreFixReader(item.value); } catch (e) { if (isRawBuiltinError(e)) potency += 1; }
  }
  assert.ok(
    potency >= FUZZ_MIN_POTENCY,
    `fuzz POTENCY control FAILED: only ${potency} of ${corpus.length} generated values crash the unguarded PRE-FIX transcription, so "the validator never threw" may be a fact about a harmless corpus rather than about the validator`,
  );

  const firstThrow = classifyThrew[0];
  const firstBad = badShape[0];
  const D1 = {
    moduleMissing: VALIDATOR === null,
    cases: corpus.length,
    throwCount: classifyThrew.length,
    badShapeCount: badShape.length,
    potency,
    summary: VALIDATOR === null
      ? `the artifact validator module does not exist on this tree (${VALIDATOR_IMPORT_ERROR?.constructor?.name}: ${VALIDATOR_IMPORT_ERROR?.message})`
      : `${corpus.length} generated acyclic JSON values: ${classifyThrew.length} made classifyRedEvidenceArtifact THROW, ${badShape.length} returned something that is not a classification`
        + (firstThrow ? ` — first throw on a "${firstThrow.item.stratum}" value (${firstThrow.item.label ?? canon(firstThrow.item.value).slice(0, 120)}): ${firstThrow.error?.constructor?.name}: ${firstThrow.error?.message}` : '')
        + (firstBad ? ` — first bad shape on a "${firstBad.item.stratum}" value: ${canon(firstBad.item.value).slice(0, 120)}` : ''),
    proofLine: `seed=${JSON.stringify(FUZZ_SEED)}; corpus=${corpus.length}; corpusDigest=${corpusDigest}; `
      + `strata=${Object.entries(strata).map(([k, n]) => `${k}:${n}`).join(',')}; `
      + `classifyThrew=${classifyThrew.length}/${corpus.length}; notAClassification=${badShape.length}/${corpus.length}; `
      + `outcomes=${Object.entries(outcomes).sort().map(([k, n]) => `${k}:${n}`).join(',') || 'none'}`,
  };

  // ── D2 · partition totality + losslessness ───────────────────────────────
  // Every ARRAY reachable in the corpus is a candidate `records` array, so the
  // quarantine splitter is exercised over far more shapes than any envelope
  // fixture could reach it with.
  const arrays = [];
  const collectArrays = (value, seen) => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      arrays.push(value);
      for (const item of value) collectArrays(item, seen);
      return;
    }
    for (const key of Object.keys(value)) collectArrays(value[key], seen);
  };
  for (const item of corpus) collectArrays(item.value, new Set());

  const partitionThrew = [];
  const partitionLossy = [];
  if (VALIDATOR !== null) {
    for (const entries of arrays) {
      let partition;
      try {
        partition = VALIDATOR.partitionRedEvidenceRecords(entries);
      } catch (e) { partitionThrew.push({ entries, error: e }); continue; }
      const reason = partitionDefect(partition, entries);
      if (reason !== null) partitionLossy.push({ entries, reason });
    }
  }
  const D2 = {
    moduleMissing: VALIDATOR === null,
    arrays: arrays.length,
    throwCount: partitionThrew.length,
    lossyCount: partitionLossy.length,
    summary: VALIDATOR === null
      ? 'the artifact validator module does not exist on this tree'
      : `${arrays.length} arrays reachable in the corpus: ${partitionThrew.length} made partitionRedEvidenceRecords THROW, ${partitionLossy.length} lost or duplicated an entry`
        + (partitionLossy[0] ? ` — first: ${partitionLossy[0].reason}` : '')
        + (partitionThrew[0] ? ` — first throw: ${partitionThrew[0].error?.constructor?.name}: ${partitionThrew[0].error?.message}` : ''),
    proofLine: `arrays=${arrays.length}; partitionThrew=${partitionThrew.length}/${arrays.length}; `
      + `lossyOrReordered=${partitionLossy.length}/${arrays.length}; `
      + `retainedVerbatim=${arrays.length - partitionLossy.length - partitionThrew.length}/${arrays.length}`,
  };

  // ── D3 · the LIVE read boundary over generated artifacts ─────────────────
  // The pure functions above are the property's subject; this row proves the
  // property is actually WIRED — that the same shapes reach production code and
  // that its THROWING wrapper only ever throws typed errors naming the file.
  const onDisk = corpus.filter((item, i) => i % 4 === 0);
  const rawEscapes = [];
  const unnamed = [];
  let typedRejections = 0;
  for (const item of onDisk) {
    writeRawArtifact(JSON.stringify(item.value) ?? 'null');
    try {
      store.readRedEvidence(storyId);
    } catch (e) {
      if (isRawBuiltinError(e)) { rawEscapes.push({ item, error: e }); continue; }
      typedRejections += 1;
      if (e?.name === 'RedEvidenceArtifactError' && !namesArtifactPath(e.message)) unnamed.push({ item, error: e });
    }
  }
  // …and a small sample all the way through the LIVE gate pair (~95ms each, so
  // this is a sample rather than the corpus — the read boundary above is where
  // the shape coverage lives).
  const gateSample = onDisk.filter((item, i) => i % Math.ceil(onDisk.length / FUZZ_GATE_SAMPLE) === 0).slice(0, FUZZ_GATE_SAMPLE);
  const gateEscapes = [];
  for (const item of gateSample) {
    const o = observe(() => writeRawArtifact(JSON.stringify(item.value) ?? 'null'));
    if (o.readThrew && isRawBuiltinError(o.readError)) gateEscapes.push({ item, error: o.readError });
    else if (o.threw && isRawBuiltinError(o.error)) gateEscapes.push({ item, error: o.error });
  }
  const firstEscape = rawEscapes[0] ?? gateEscapes[0];
  const D3 = {
    artifacts: onDisk.length,
    gateSample: gateSample.length,
    rawEscapeCount: rawEscapes.length + gateEscapes.length,
    unnamedCount: unnamed.length,
    summary: `${onDisk.length} generated artifacts through the live read boundary and ${gateSample.length} through the full gate pair: `
      + `${rawEscapes.length + gateEscapes.length} let a RAW builtin escape, ${unnamed.length} typed rejections named no artifact`
      + (firstEscape ? ` — first on a "${firstEscape.item.stratum}" value: ${firstEscape.error?.constructor?.name}: ${firstEscape.error?.message}` : ''),
    proofLine: `artifacts=${onDisk.length}; readBoundaryRawBuiltins=${rawEscapes.length}/${onDisk.length}; `
      + `typedRejections=${typedRejections}; typedNamingArtifact=${typedRejections - unnamed.length}/${typedRejections}; `
      + `gateSample=${gateSample.length}; gateRawBuiltins=${gateEscapes.length}/${gateSample.length}`,
  };

  console.log(
    `      proof D0: seed=${JSON.stringify(FUZZ_SEED)}; corpus=${corpus.length}; corpusDigest=${corpusDigest}; acyclic=true; `
    // NODE counts, not distinct-value counts: `walkValue` visits every position,
    // so a shared subtree is counted once per path. D2's `arrays` is a different
    // number on purpose — there it is the DISTINCT arrays actually partitioned.
    + `maxDepth=${maxDepth}; objectNodes=${stats.objects}; arrayNodes=${stats.arrays}; emptyObjects=${stats.emptyObjects}; `
    + `emptyArrays=${stats.emptyArrays}; nullPrototype=${stats.nullProtoObjects}; inheritedPrototype=${stats.inheritedProtoObjects}; `
    + `ownProtoKeys=${stats.protoOwnKeys}; mixedPrimitiveArrays=${stats.mixedPrimitiveArrays}; distinctKeys=${stats.distinctKeys.size}; `
    + `novelVsEnumerated=${novel}; potencyAgainstUnguardedPreFixReader=${potency}/${corpus.length}`,
  );

  FUZZ = { D1, D2, D3 };
  return FUZZ;
}

/**
 * D-4 says quarantine RETAINS. Stated as a property of the partition rather
 * than of one fixture: nothing is dropped, nothing is duplicated, every
 * rejected entry is the ORIGINAL object at its ORIGINAL index, and the kept
 * entries are the input with exactly those indices removed — order intact.
 * Returns `null` when the partition is sound, or the first defect found.
 */
function partitionDefect(partition, entries) {
  if (partition === null || typeof partition !== 'object') return 'the partition is not an object';
  const { records, malformed: rejected } = partition;
  if (!Array.isArray(records) || !Array.isArray(rejected)) return 'records/malformed are not both arrays';
  if (records.length + rejected.length !== entries.length) {
    return `${entries.length} entries in, ${records.length} kept + ${rejected.length} quarantined out — an entry was DROPPED or DUPLICATED`;
  }
  const takenIndices = new Set();
  for (const entry of rejected) {
    if (!Number.isInteger(entry?.index) || entry.index < 0 || entry.index >= entries.length) return `quarantined index ${String(entry?.index)} is not a position in a ${entries.length}-entry array`;
    if (takenIndices.has(entry.index)) return `index ${entry.index} was quarantined twice`;
    takenIndices.add(entry.index);
    if (!Object.is(entry.value, entries[entry.index])) return `the entry quarantined at index ${entry.index} is not the ORIGINAL value — quarantine must retain verbatim`;
  }
  const expected = entries.filter((_, i) => !takenIndices.has(i));
  for (let i = 0; i < expected.length; i += 1) {
    if (!Object.is(expected[i], records[i])) return `kept record ${i} is not the original entry in its original relative order`;
  }
  return null;
}

// ── D1 · the §10.5 totality property ────────────────────────────────────────
RED_ROWS.push({
  id: 'D1-classify-total-on-arbitrary-json',
  block: 'D.1', klass: 'TOTALITY',
  label: '`classifyRedEvidenceArtifact` returns a well-formed CLASSIFICATION for every generated acyclic JSON value and never throws (§10.5)',
  observeRow: () => fuzz().D1,
  preFixDefectDesc: 'the §10.5 totality property has no implementation to hold it — on the pre-fix tree there is no artifact validator at all — or some generated value makes the documented-total entry point throw, or hands back something that is not a classification',
  preFixDefect: (o) => o.moduleMissing || o.throwCount > 0 || o.badShapeCount > 0,
  requiredDesc: 'every generated value yields a member of the classification union — `{ok:true}` with a retained `malformed` list, or `{ok:false}` with a typed error whose envelope faults carry a known code and NAME the artifact — and not one of them throws',
  required: (o) => !o.moduleMissing && o.cases >= FUZZ_MIN_CASES && o.throwCount === 0 && o.badShapeCount === 0,
});

// ── D2 · quarantine is total AND lossless, as a property ────────────────────
RED_ROWS.push({
  id: 'D2-partition-total-and-lossless',
  block: 'D.2', klass: 'TOTALITY',
  label: '`partitionRedEvidenceRecords` is total over every array in the corpus and never drops, duplicates or rewrites an entry (D-4 retain-and-report)',
  observeRow: () => fuzz().D2,
  preFixDefectDesc: 'there is no quarantine splitter to hold the property, or some generated array makes it throw, or a partition loses / duplicates / reorders an entry — a "clean empty array" being exactly what reads as an ABSENT artifact',
  preFixDefect: (o) => o.moduleMissing || o.throwCount > 0 || o.lossyCount > 0,
  requiredDesc: 'for every array: kept + quarantined accounts for every entry exactly once, each quarantined entry is the ORIGINAL object at its ORIGINAL index, and the kept entries are the input with those indices removed, order intact',
  required: (o) => !o.moduleMissing && o.arrays >= FUZZ_MIN_ARRAYS && o.throwCount === 0 && o.lossyCount === 0,
});

// ── D3 · the property is WIRED, not just true of a pure function ────────────
RED_ROWS.push({
  id: 'D3-read-boundary-total-on-generated-artifacts',
  block: 'D.3', klass: 'TOTALITY',
  label: 'no generated artifact lets a RAW builtin escape the live read boundary or the live gate pair, and every typed rejection names the artifact',
  observeRow: () => fuzz().D3,
  preFixDefectDesc: 'a generated artifact escapes a RAW builtin error (the bare TypeError of §2.1/§2.4, or a raw SyntaxError) from the live read boundary or the live gate — naming nothing an operator could act on',
  preFixDefect: (o) => o.rawEscapeCount > 0,
  requiredDesc: 'the read boundary either returns a value or throws a TYPED error that names the artifact path; no raw builtin escapes to the gate for any generated shape',
  required: (o) => o.artifacts >= 1000 && o.rawEscapeCount === 0 && o.unnamedCount === 0,
});

// ── runner ──────────────────────────────────────────────────────────────────
const ctx = { store, storyId, root, satisfying, malformed, writeEnvelope, writeRawArtifact, removeArtifact, observe, canon, ABSENT, CLEAN };

for (const row of INVARIANT_ROWS) {
  row.check(ctx); // must pass on BOTH trees; a throw here is fatal, not RED
  console.log(`  [PASS] ${row.id}  ${row.label}`);
}

const red = [];
const green = [];
for (const row of RED_ROWS) {
  // BLOCK A rows observe ONE fixture. BLOCK C rows observe a FAMILY of
  // permutations and compare them against each other, which no single
  // observation can express, so they supply their own observer.
  const o = row.observeRow ? row.observeRow() : observe(row.setup);
  const met = row.required(o);
  const defect = row.preFixDefect(o);

  assert.ok(
    !(met && defect),
    `${row.id}: the row's own predicates are not mutually exclusive — required and preFixDefect both matched "${describe(o)}". Fix the row, not the tree.`,
  );
  if (!met) {
    // The row is RED. Prove the failure is the DOCUMENTED defect: a row that
    // fails for an undocumented reason is a stale/broken row, not evidence.
    assert.ok(
      defect,
      `${row.id} [${row.klass}] STALE ROW — the observation matches NEITHER the documented pre-fix defect NOR the requirement.\n`
      + `      observed : ${describe(o)}\n`
      + `      expected pre-fix defect : ${row.preFixDefectDesc}\n`
      + `      required post-fix       : ${row.requiredDesc}\n`
      + `    Re-derive this row against the current tree by symbol; do not adjust the assertion to fit.`,
    );
    red.push({ row, o });
  } else {
    green.push({ row, o });
  }
}

console.log('\nred-b2aa7-artifact-validation — BLOCK A (CHK-001), pre-fix expectation: MUST FAIL  ·  BLOCK C (CHK-009): same expectation\n');
for (const { row, o } of red) {
  console.log(`  [RED ] ${row.id} (${row.block} ${row.klass}) ${row.label}`);
  console.log(`         witness  : ${row.preFixDefectDesc}`);
  console.log(`         observed : ${describe(o)}`);
  console.log(`         required : ${row.requiredDesc}`);
  if (o.proofLine) console.log(`         proof ${row.id.split('-')[0]}: ${o.proofLine}`);
}
for (const { row, o } of green) {
  // A GREEN row while other rows are still RED is either a partial fix or a
  // VACUOUS row — one added for a defect that was already closed, which proves
  // nothing. Name it so a reader can tell the two apart instead of reading a
  // shrinking RED count as progress.
  const suffix = red.length > 0 ? '  ← already satisfied while BLOCK A is still RED: confirm this row is not vacuous' : '';
  console.log(`  [GREEN] ${row.id} (${row.block} ${row.klass}) ${row.label}${suffix}`);
  if (o.proofLine) console.log(`         proof ${row.id.split('-')[0]}: ${o.proofLine}`);
}

const byClass = {};
for (const { row } of red) byClass[row.klass] = (byClass[row.klass] ?? 0) + 1;
console.log(
  `\n  ${red.length} RED / ${green.length} GREEN of ${RED_ROWS.length} rows`
  + ` — witnessed classes: ${Object.entries(byClass).map(([k, n]) => `${k}=${n}`).join(', ') || 'none'}`,
);

assert.equal(
  red.length, 0,
  `red-b2aa7-artifact-validation: ${red.length} row(s) still exhibit the pre-fix defect — the legacy v1 red-evidence artifact is not validated before the live enforce gate evaluates it.\n`
  + `  Each RED row above printed the WITNESS it observed, so this failure is the repro, not an assertion mismatch.\n`
  + `  Unresolved rows: ${red.map(({ row }) => `${row.id}(${row.klass})`).join(', ')}`,
);

console.log('\nred-b2aa7-artifact-validation: OK (every documented defect class is closed)');
