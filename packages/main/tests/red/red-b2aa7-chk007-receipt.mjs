#!/usr/bin/env node
/**
 * CHK-007 verification receipt (B-2aa7) — post-fix invariance + validate
 * registration.
 *
 * CHK-007's three verification intents are EXECUTABLE: per B-ec67 the tool
 * refuses a caller-authored "result: pass" and derives the verdict from a pinned
 * command's real output. This file is that pinned command.
 *
 * Unlike its sibling receipts it FAILS CLOSED (exit 1, same shape as
 * `red-b2aa7-migration-scan.mjs`): a check that cannot be confirmed prints its
 * reason on stderr and the process exits non-zero, so this file stays meaningful
 * when `lattice validate` runs it, where only the exit code is read.
 *
 * ── WHAT IT ASSERTS ─────────────────────────────────────────────────────────
 *
 *   1. happy       INVARIANCE_DIGEST_UNCHANGED_POST_FIX — the PROTECTED harness
 *                  `red-w2c-v1-verdict-invariance.mjs` is run as a child on the
 *                  FINISHED tree and must exit 0 printing the digest that the
 *                  CHK-002 baseline commit pins. The expected value is read out
 *                  of that commit's BLOB, never written here, so editing the
 *                  working-tree constant cannot make this pass.
 *   2. edge        D5_BLANK_OBSERVED_FAILURE_TOLERATED — decision D-5 (audit
 *                  §8.4): a blank / empty `observedFailure` is legacy-tolerated.
 *                  It must still produce UNSATISFIED, with a FULL diagnostic
 *                  report byte-identical to an ABSENT artifact (no new
 *                  diagnostic), and must NEVER be quarantined. That is exactly
 *                  scenario 3 of the harness, whose report shape the digest
 *                  above depends on; the linkage is checked mechanically rather
 *                  than asserted in prose.
 *   3. adversarial PIN_NOT_REPINNED_HARNESS_UNTOUCHED — the digest was not made
 *                  to pass by moving the pin: the working-tree harness is
 *                  BYTE-IDENTICAL to its blob at the baseline commit. Proven
 *                  non-vacuous by re-running the same detector over two mutated
 *                  in-memory copies (a re-pin and an edit that leaves the pin
 *                  alone), each of which it must flag.
 *   4.             VALIDATE_REGISTRATION_COMPLETE — every permanent regression
 *                  check of this story is registered in `lattice.config.json`
 *                  `validate.commands`, proven non-vacuous per entry.
 *   5.             VACUOUS_PREFIX_RECEIPTS_EXCLUDED — see below.
 *
 * ── WHY TWO RECEIPTS ARE DELIBERATELY *NOT* REGISTERED ──────────────────────
 *
 * `red-b2aa7-chk001-receipt.mjs` and `red-b2aa7-chk010-receipt.mjs` certify
 * PRE-FIX observations, so both gate every marker on BLOCK A of
 * `red-b2aa7-artifact-validation.mjs` still being RED (chk001: `run.status !== 0`
 * plus `redCount === total`; chk010: the same, via its `preFixTree` gate). On the
 * finished tree BLOCK A is green, so both print NOTHING and exit 0 — measured,
 * not assumed: 0 bytes on stdout and on stderr, exit 0.
 *
 * Registering them would add two `lattice validate` commands that pass forever
 * while asserting nothing: a vacuous check masquerading as coverage, which is
 * the defect class this story exists to remove. They stay unregistered, and
 * check 5 below enforces that decision — and, because it also requires them to
 * be SILENT, it doubles as a regression detector: if either starts emitting
 * markers again, BLOCK A has gone red and the fix has regressed.
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-b2aa7-chk007-receipt.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');           // packages/main
const repoRoot = join(pkgRoot, '..', '..');       // repository root
const DIST = join(pkgRoot, 'dist');

const HARNESS_REL = 'packages/main/tests/red/red-w2c-v1-verdict-invariance.mjs';
const HARNESS_ABS = join(repoRoot, HARNESS_REL);
const BASELINE_RECEIPT = join(here, 'red-b2aa7-baseline-receipt.mjs');
const CONFIG_PATH = join(repoRoot, 'lattice.config.json');

const failures = [];
const fail = (check, why) => failures.push(`${check}: ${why}`);
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

/** The pinned five-scenario digest, wherever it is being read from. */
const PIN_RE = /V1_VERDICT_DIGEST\s*=\s*'([0-9a-f]{64})'/;
/** The digest the harness actually printed on this run. */
const OBSERVED_RE = /five-scenario FULL-diagnostic sha256 = ([0-9a-f]{64})/;

// ════════════════════════════════════════════════════════════════════════════
// 1. happy — the digest is UNCHANGED post-fix, measured against the CHK-002
//    baseline commit's blob rather than against the working tree.
// ════════════════════════════════════════════════════════════════════════════

// CHK-002 recorded the commit its passing baseline run was taken at. Read it from
// that receipt so there is ONE source for it in the tree, not two that can drift.
const BASELINE_COMMIT = /const BASELINE_COMMIT = '([0-9a-f]{40})'/
  .exec(readFileSync(BASELINE_RECEIPT, 'utf8'))?.[1] ?? null;

let baselineHarnessText = null;
let baselinePin = null;
if (BASELINE_COMMIT === null) {
  fail('happy', `could not read BASELINE_COMMIT out of ${BASELINE_RECEIPT}`);
} else {
  try {
    baselineHarnessText = git('show', `${BASELINE_COMMIT}:${HARNESS_REL}`);
  } catch (e) {
    fail('happy', `git show ${BASELINE_COMMIT}:${HARNESS_REL} failed: ${e?.message ?? e}`);
  }
  baselinePin = baselineHarnessText === null ? null : (PIN_RE.exec(baselineHarnessText)?.[1] ?? null);
  if (baselinePin === null) fail('happy', `no pinned digest found in the harness at ${BASELINE_COMMIT}`);
}

const invariance = spawnSync(process.execPath, [HARNESS_ABS], { cwd: repoRoot, encoding: 'utf8' });
const invarianceOut = `${invariance.stdout ?? ''}${invariance.stderr ?? ''}`;
const observedDigest = OBSERVED_RE.exec(invarianceOut)?.[1] ?? null;
const harnessOk = invariance.status === 0 && /red-w2c-v1-verdict-invariance: OK/.test(invarianceOut);

/** THE COMPARATOR (re-used on a mutated input below so it cannot pass vacuously). */
const digestMoved = (pinned, seen) => pinned === null || seen === null || pinned !== seen;
const flipHex = (hex) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

const comparatorDiscriminates =
  baselinePin !== null && observedDigest !== null
  && digestMoved(flipHex(baselinePin), observedDigest) === true
  && digestMoved(baselinePin, observedDigest) === false;

if (!harnessOk) {
  fail('happy', `the protected harness did not pass on this tree (exit=${invariance.status}):\n${invarianceOut.trim()}`);
}
if (observedDigest === null) fail('happy', 'the harness printed no five-scenario digest line');
if (baselinePin !== null && observedDigest !== null && digestMoved(baselinePin, observedDigest)) {
  fail('happy',
    `THE V1 VERDICT MOVED — baseline ${BASELINE_COMMIT} pins ${baselinePin} but this tree produced ${observedDigest}. `
    + 'The fix changed a verdict it was not permitted to change. Do NOT re-pin the constant to make this pass.');
}
if (harnessOk && observedDigest !== null && baselinePin !== null && !comparatorDiscriminates) {
  fail('happy', 'the digest comparator did not discriminate a perturbed pin, so a match would prove nothing');
}

const digestUnchanged =
  harnessOk && observedDigest !== null && baselinePin !== null
  && !digestMoved(baselinePin, observedDigest) && comparatorDiscriminates;

if (digestUnchanged) {
  console.log(
    `INVARIANCE_DIGEST_UNCHANGED_POST_FIX (${observedDigest} — identical to the digest pinned by the CHK-002 baseline `
    + `commit ${BASELINE_COMMIT.slice(0, 10)}, read from that commit's blob rather than from the working tree; `
    + 'the harness exited 0 with its own per-scenario v1 semantics asserted by name; comparator discriminated a perturbed pin)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 2. edge — D-5: a blank `observedFailure` stays legacy-tolerated.
//
//    Driven through the REAL production pair the live enforce gates call
//    (store.readRedEvidence, then evaluateProofStoryDiagnostics over
//    proofStoryDiagnosticInput) on a throwaway store outside the repository.
// ════════════════════════════════════════════════════════════════════════════
const { StoryStore } = await import(`${DIST}/core/store.js`);
const { evaluateProofStoryDiagnostics, computeMilestoneLedgerHash } = await import(`${DIST}/core/proofstory.js`);
const { proofStoryDiagnosticInput } = await import(`${DIST}/handlers/phase-gates.js`);
const { loadConfig } = await import(`${DIST}/core/config.js`);

const NOW = '2026-07-25T00:00:00.000Z';
const storyId = 'B-2aa7-chk007';
const root = join(process.env.TMPDIR || '/tmp', `red-b2aa7-chk007-${process.pid}`);

const store = new StoryStore(root);
store.writeStory(storyId, {
  storyId, name: 'b2aa7', title: 'B-2aa7 CHK-007 receipt',
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

/** The same well-formed v1 record the invariance harness uses for scenario 2. */
const satisfying = {
  id: 'RED-v1', trigger: 'auth regression', acceptanceTargetRef: 'M1',
  baselineHeadHash: 'base-head', baselineMaterialHash: 'base-mat',
  failingCommand: 'npm test', observedFailure: 'assertion failed',
  greenRelation: { targetRef: 'M1', relation: 'same_acceptance', greenHeadHash: 'green-head', greenMaterialHash: 'green-mat' },
  createdAt: NOW,
};

function canon(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
}

function writeRecords(records) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    ARTIFACT_PATH,
    `${JSON.stringify({ schemaVersion: 'proofstory.red_evidence.v1', storyId, records, createdAt: NOW, updatedAt: NOW }, null, 2)}\n`,
    'utf8',
  );
}
function removeArtifact() {
  if (existsSync(ARTIFACT_PATH)) rmSync(ARTIFACT_PATH);
}

/** Drive the REAL read boundary and the REAL gate pair over what is on disk. */
function observe(setup) {
  setup();
  const o = { readThrew: false, readValue: undefined, threw: false, report: null, codes: null };
  try {
    o.readValue = store.readRedEvidence(storyId);
  } catch {
    o.readThrew = true;
  }
  try {
    const report = evaluateProofStoryDiagnostics(proofStoryDiagnosticInput(store, storyId, root));
    o.report = canon(report);
    o.codes = report.missingRedEvidence.map((row) => row.code);
  } catch {
    o.threw = true;
  }
  return o;
}

const ABSENT = observe(removeArtifact);
const CLEAN = observe(() => writeRecords([satisfying]));
// Discriminating control: a genuinely malformed record DOES raise a quarantine
// surface, so "malformedRecords === undefined" below is a fact about the blank
// record and not about this build never quarantining anything.
const CORRUPT = observe(() => writeRecords([{ id: 'corrupt' }]));

const blankVariants = ['   ', ''].map((blank) => {
  const o = observe(() => writeRecords([{ ...satisfying, id: 'RED-v1-blank', observedFailure: blank }]));
  return {
    blank,
    tolerated:
      !o.readThrew && !o.threw
      // never quarantined …
      && o.readValue?.malformedRecords === undefined
      && Array.isArray(o.readValue?.records) && o.readValue.records.length === 1
      // … still UNSATISFIED via the ordinary not-configured gap …
      && canon(o.codes) === canon(['missing_red_evidence'])
      // … and with NO new diagnostic: the FULL report is byte-identical to the
      // report an ABSENT artifact produces, which is the shape scenario 3 pins.
      && o.report === ABSENT.report,
  };
});

const controlsDiscriminate =
  Array.isArray(CLEAN.codes) && CLEAN.codes.length === 0            // the fixture is live: the same record SATISFIES when observedFailure is real
  && CLEAN.report !== ABSENT.report
  && (CORRUPT.readValue?.malformedRecords ?? []).length === 1;      // a genuinely malformed record IS quarantined

// Mechanical linkage to scenario 3, instead of a prose claim that they are the
// same fixture: the harness's blank scenario really is a whitespace
// `observedFailure`, which is what the digest above covers.
const harnessText = readFileSync(HARNESS_ABS, 'utf8');
const scenario3IsBlank =
  /'3-blank-observed-failure'/.test(harnessText)
  && /blankObservedFailure = \{ \.\.\.satisfying, id: 'RED-v1-blank', observedFailure: '\s+' \}/.test(harnessText);

const blankTolerated = blankVariants.every((v) => v.tolerated) && controlsDiscriminate && scenario3IsBlank;

if (!blankVariants.every((v) => v.tolerated)) {
  fail('edge', `D-5 violated for observedFailure=${blankVariants.filter((v) => !v.tolerated).map((v) => JSON.stringify(v.blank)).join(', ')}: `
    + 'a blank observedFailure must stay UNSATISFIED with a report byte-identical to an ABSENT artifact and must never be quarantined');
}
if (!controlsDiscriminate) fail('edge', 'the D-5 controls did not discriminate (a satisfying record must SATISFY and a malformed record must be quarantined)');
if (!scenario3IsBlank) fail('edge', 'could not confirm that the harness scenario 3 is the blank-observedFailure fixture');

if (blankTolerated) {
  console.log(
    'D5_BLANK_OBSERVED_FAILURE_TOLERATED (observedFailure "   " and "" both: read without throwing, retained in the clean set, '
    + 'NEVER quarantined (malformedRecords absent), UNSATISFIED via the ordinary missing_red_evidence gap, and a FULL diagnostic '
    + 'byte-identical to an ABSENT artifact — no new diagnostic, so scenario 3\'s report shape is untouched; controls: the same '
    + 'record with a real observedFailure SATISFIES and a malformed record IS quarantined)',
  );
}

rmSync(root, { recursive: true, force: true });

// ════════════════════════════════════════════════════════════════════════════
// 3. adversarial — the pin was not moved, and the whole protected file is
//    untouched, so no assertion around the constant was relaxed either.
// ════════════════════════════════════════════════════════════════════════════

/** THE DETECTOR (run over the real file AND over mutated copies). */
function repinReport(current, baseline) {
  const pin = PIN_RE.exec(current)?.[1] ?? null;
  const basePin = PIN_RE.exec(baseline)?.[1] ?? null;
  return { repinned: pin === null || basePin === null || pin !== basePin, edited: current !== baseline };
}

let pinIntact = false;
if (baselineHarnessText !== null) {
  const real = repinReport(harnessText, baselineHarnessText);

  // NON-VACUITY, two independent mutations: one that moves the pin, and one that
  // leaves the pin alone but edits the file — the detector must flag each.
  const repinnedCopy = harnessText.replace(PIN_RE, (m, hex) => m.replace(hex, flipHex(hex)));
  const editedCopy = `${harnessText}\n// an edit that leaves the pin alone\n`;
  const mutationsDetected =
    repinReport(repinnedCopy, baselineHarnessText).repinned === true
    && repinReport(editedCopy, baselineHarnessText).repinned === false
    && repinReport(editedCopy, baselineHarnessText).edited === true;

  // The working tree must also be clean of unstaged edits to the protected file.
  let worktreeClean = false;
  try {
    worktreeClean = git('diff', '--name-only', 'HEAD', '--', HARNESS_REL).trim() === '';
  } catch (e) {
    fail('adversarial', `git diff on ${HARNESS_REL} failed: ${e?.message ?? e}`);
  }

  pinIntact = !real.repinned && !real.edited && mutationsDetected && worktreeClean;

  if (real.repinned) fail('adversarial', `the pinned constant was MOVED relative to ${BASELINE_COMMIT} — re-pinning is exactly what this check exists to catch`);
  if (real.edited) fail('adversarial', `${HARNESS_REL} is not byte-identical to its blob at ${BASELINE_COMMIT}; it is a protectedFile of this story's scope contract`);
  if (!mutationsDetected) fail('adversarial', 'the re-pin detector did not flag its own mutated copies, so it cannot be trusted');
  if (!worktreeClean) fail('adversarial', `${HARNESS_REL} has uncommitted working-tree changes`);
}

if (pinIntact) {
  console.log(
    `PIN_NOT_REPINNED_HARNESS_UNTOUCHED (${HARNESS_REL} is byte-identical to its blob at the CHK-002 baseline commit `
    + `${BASELINE_COMMIT.slice(0, 10)} and has no uncommitted changes, so the digest above was matched rather than made to match; `
    + 'detector proven non-vacuous against a re-pinned copy and against an edited copy whose pin was left alone)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 4 + 5. registration completeness, and the deliberate exclusion of the two
//        receipts that are vacuous on the finished tree.
// ════════════════════════════════════════════════════════════════════════════

/**
 * The story's permanent regression checks. `red-b2aa7-artifact-validation.mjs`
 * is the 20-row regression and `red-b2aa7-migration-scan.mjs` is decision D-7,
 * whose obligation is that the scan is RE-RUN at merge time — `lattice validate`
 * is what actually runs then, so leaving it to a remembered manual run is the
 * "relies on someone remembering" failure mode this story exists to remove.
 *
 * This receipt is itself registered in validate.commands (it is the only check
 * here that fails closed) but is deliberately NOT in this list: the list is the
 * set CHK-007 was asked to guarantee, and keeping this file out of it lets the
 * registration of this file be reconsidered by editing the config alone.
 */
const REQUIRED_VALIDATE_COMMANDS = [
  'packages/main/tests/red/red-b2aa7-artifact-validation.mjs',
  'packages/main/tests/red/red-b2aa7-migration-scan.mjs',
  'packages/main/tests/red/red-b2aa7-chk004-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-chk005-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-chk006-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-chk009-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-chk011-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-doc-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-baseline-receipt.mjs',
];

/** Receipts that certify PRE-FIX observations and are therefore silent here. */
const EXCLUDED_VACUOUS_RECEIPTS = [
  'packages/main/tests/red/red-b2aa7-chk001-receipt.mjs',
  'packages/main/tests/red/red-b2aa7-chk010-receipt.mjs',
];

function entryArgv(entry) {
  if (typeof entry === 'string') return entry.trim().split(/\s+/);
  if (entry && typeof entry === 'object') return [entry.command, ...(entry.args ?? [])].map(String);
  return [];
}
function registeredTokens(config) {
  const tokens = new Set();
  for (const entry of config?.validate?.commands ?? []) {
    for (const token of entryArgv(entry)) tokens.add(token);
  }
  return tokens;
}
const missingRegistrations = (config, required) => {
  const tokens = registeredTokens(config);
  return required.filter((script) => !tokens.has(script));
};

const configRaw = readFileSync(CONFIG_PATH, 'utf8');
const config = JSON.parse(configRaw);

const missing = missingRegistrations(config, REQUIRED_VALIDATE_COMMANDS);
if (missing.length > 0) {
  fail('registration', `these permanent regression checks are NOT in lattice.config.json validate.commands, so \`lattice validate\` would not run them: ${missing.join(', ')}`);
}

// NON-VACUITY: strip each REGISTERED entry from an in-memory copy and prove the
// SAME detector names it. Entries that are already missing are reported above;
// re-reporting them here as "undetected" would be noise, not a second defect.
const undetected = [];
for (const script of REQUIRED_VALIDATE_COMMANDS.filter((s) => !missing.includes(s))) {
  const mutated = JSON.parse(configRaw);
  mutated.validate.commands = mutated.validate.commands.filter((entry) => !entryArgv(entry).includes(script));
  if (mutated.validate.commands.length === config.validate.commands.length
    || !missingRegistrations(mutated, REQUIRED_VALIDATE_COMMANDS).includes(script)) {
    undetected.push(script);
  }
}
if (undetected.length > 0) {
  fail('registration', `de-registering these would NOT be detected by this check, so the check is vacuous for them: ${undetected.join(', ')}`);
}

if (missing.length === 0 && undetected.length === 0) {
  console.log(
    `VALIDATE_REGISTRATION_COMPLETE (all ${REQUIRED_VALIDATE_COMMANDS.length} permanent B-2aa7 regression checks are registered in `
    + 'lattice.config.json validate.commands, including the D-7 migration scan that must be re-run at merge time; '
    + 'stripping ANY one of them is detected by this check — proven non-vacuous per entry)',
  );
}

// The exclusion, enforced rather than merely documented.
const tokens = registeredTokens(config);
const wronglyRegistered = EXCLUDED_VACUOUS_RECEIPTS.filter((script) => tokens.has(script));
if (wronglyRegistered.length > 0) {
  fail('exclusion',
    `${wronglyRegistered.join(', ')} must NOT be registered in validate.commands: each gates every marker on BLOCK A of `
    + 'red-b2aa7-artifact-validation.mjs still being RED, because both certify PRE-FIX observations. On the fixed tree they '
    + 'print nothing and exit 0, so registering them adds commands that pass forever while asserting nothing.');
}

const noisy = [];
for (const script of EXCLUDED_VACUOUS_RECEIPTS) {
  const run = spawnSync(process.execPath, [join(repoRoot, script)], { cwd: repoRoot, encoding: 'utf8' });
  const stdout = (run.stdout ?? '').trim();
  const stderr = (run.stderr ?? '').trim();
  if (run.status !== 0 || stdout !== '' || stderr !== '') {
    noisy.push(`${script} (exit=${run.status}, stdout=${JSON.stringify(stdout.slice(0, 200))}, stderr=${JSON.stringify(stderr.slice(0, 200))})`);
  }
}
if (noisy.length > 0) {
  fail('exclusion',
    `these pre-fix receipts were expected to be SILENT and exit 0 on the fixed tree but were not: ${noisy.join('; ')}. `
    + 'Their markers are gated on BLOCK A being RED, so output here means the artifact regressed — investigate the fix, not this check.');
}

if (wronglyRegistered.length === 0 && noisy.length === 0) {
  console.log(
    `VACUOUS_PREFIX_RECEIPTS_EXCLUDED (${EXCLUDED_VACUOUS_RECEIPTS.length} pre-fix receipts verified SILENT — 0 bytes on stdout and stderr, exit 0 — `
    + 'on the finished tree, because every marker in them is gated on BLOCK A of red-b2aa7-artifact-validation.mjs being RED; '
    + 'they are therefore deliberately absent from validate.commands, and this check fails if either is registered or stops being silent)',
  );
}

if (failures.length > 0) {
  console.error(`\nred-b2aa7-chk007-receipt: ${failures.length} check(s) failed`);
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
process.exit(0);
