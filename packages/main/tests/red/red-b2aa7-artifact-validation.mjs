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
 *   BLOCK C  CHK-009  order independence — added after CHK-004 lands
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
// CHK-010 owns this block. Leave it empty until then.
// ════════════════════════════════════════════════════════════════════════════
const INVARIANT_ROWS = [];

// ════════════════════════════════════════════════════════════════════════════
// BLOCK C — CHK-009 · order independence.   Added after CHK-004 lands.
// BLOCK D — CHK-011 · validator totality fuzz over arbitrary acyclic JSON.
//
// Both assert post-fix behaviour, so their rows belong in RED_ROWS (same
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
  const o = observe(row.setup);
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

console.log('\nred-b2aa7-artifact-validation — BLOCK A (CHK-001), pre-fix expectation: MUST FAIL\n');
for (const { row, o } of red) {
  console.log(`  [RED ] ${row.id} (${row.block} ${row.klass}) ${row.label}`);
  console.log(`         witness  : ${row.preFixDefectDesc}`);
  console.log(`         observed : ${describe(o)}`);
  console.log(`         required : ${row.requiredDesc}`);
}
for (const { row } of green) {
  // A GREEN row while other rows are still RED is either a partial fix or a
  // VACUOUS row — one added for a defect that was already closed, which proves
  // nothing. Name it so a reader can tell the two apart instead of reading a
  // shrinking RED count as progress.
  const suffix = red.length > 0 ? '  ← already satisfied while BLOCK A is still RED: confirm this row is not vacuous' : '';
  console.log(`  [GREEN] ${row.id} (${row.block} ${row.klass}) ${row.label}${suffix}`);
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
