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
// ════════════════════════════════════════════════════════════════════════════

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
