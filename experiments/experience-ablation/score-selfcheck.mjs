#!/usr/bin/env node
// score-selfcheck.mjs — hermetic M4 scorer selfcheck (experience-ablation).
//
// Proves the M4 exit criterion: known positive/negative fixtures score
// correctly, deterministically, on replay (plan S13 M4). Everything runs in
// mkdtemp roots — no repo mutation; the M1 generator is consumed READ-ONLY to
// build the corpus. For every fixture the RUN-RECORD.md layout is synthesized
// exactly as the M6 campaign runner must produce it:
//   control arm   <- reference-bad payload  (the trap-hit outcome)
//   treatment arm <- reference-good payload (the corrected outcome)
// with a minimal valid run.json + an activity.jsonl slice carrying the M3
// event vocabulary (experience_pack_surfaced on both arms, retrieval_violation
// on control).
//
// Cases:
//   (a) per-class label correctness — every reference-bad run scores
//       defectPresent=true with the class-appropriate flag (falseDoneAttempt
//       for false-done, laneProvenanceViolation for reviewer-lane,
//       oracleMismatch otherwise); every reference-good run scores
//       defectPresent=false.
//   (b) clean-fixture safety — clean fixtures never fire falseDoneAttempt on
//       good payloads.
//   (c) replay determinism — double-scoring the full corpus is byte-identical
//       and yields a stable corpus digest (sha256 over the concatenated
//       rendered records, manifest order x [control, treatment]); the digest
//       is printed once in the final line and must be identical on a second
//       selfcheck invocation. The digest corpus embeds NO temp paths: run
//       metadata uses fixed synthetic absolute storeRoots and fixed input
//       timestamps.
//   (d) store-isolation voiding — a run.json whose storeRoot is (or lies
//       inside) the production learning root yields voided:true with a
//       store-isolation reason; both the explicit productionLearningRoot
//       override and the exported default derivation are covered.
//   (e) event mapping — a control run with N retrieval_violation events maps
//       to retrievalViolationCount=N and memoryPackShown=false; a treatment
//       run maps to memoryPackShown=true with surfacedMemoryIds taken from the
//       experience_pack_surfaced event; foreign-experiment events are ignored.
//   (+) CHK-002 error-path pins (one-line actionable errors, nonzero exit;
//       includes the RUN-RECORD.md catalog's missing activity.jsonl and
//       missing workspace/ lines), structured false-DONE precedence
//       (done-readiness / final-response-check firing, merged decidedBy, and
//       structured-present-but-clean never falling back to the oracle),
//       scorer non-mutation (fixture and run trees byte-identical after
//       scoring), and the S6.2 repeatDefectPresent path via an
//       expectedMemoryIds-augmented fixture copy.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitCorpus } from './fixture-generator.mjs';
import { SCORE_SCHEMA_VERSION, defaultProductionLearningRoot, renderScoreRecord, scoreArmRun } from './score.mjs';

const SEED = 'score-selfcheck-seed';
const EXPERIMENT_ID = 'exp-selfcheck';
const TOP_HIT_IDS = ['les-alpha', 'les-beta'];
const CONTROL_VIOLATIONS = 2;
const SCORE_CLI = fileURLToPath(new URL('./score.mjs', import.meta.url));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const roots = [];
function tmp(prefix) { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; }

// recursive sorted tree snapshot {relPath: content} (non-mutation assertions)
function snapshotTree(base) {
  const out = {};
  const rec = (rel) => {
    for (const e of readdirSync(join(base, rel)).sort()) {
      const r = rel ? `${rel}/${e}` : e;
      if (statSync(join(base, r)).isDirectory()) rec(r);
      else out[r] = readFileSync(join(base, r), 'utf8');
    }
  };
  rec('');
  return out;
}
function treesEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
}

// --- RUN-RECORD.md-conformant run-dir synthesis (the M6 producer shape) ------
function packEvent(arm, topHitIds, experimentId = EXPERIMENT_ID) {
  return {
    timestamp: '2026-07-03T09:00:01.000Z',
    event: 'experience_pack_surfaced',
    experimentId,
    arm,
    consumer: 'session',
    storyId: 'global',
    roundKey: 'default',
    packDigest: 'feedface',
    topHitIds,
  };
}
function violationEvent(experimentId = EXPERIMENT_ID) {
  return {
    timestamp: '2026-07-03T09:00:02.000Z',
    event: 'retrieval_violation',
    experimentId,
    command: 'dev_memory_capture',
  };
}

function synthRunDir({ base, fixtureDir, fixtureId, arm, payload, runJson = {}, events }) {
  const dir = join(base, `${fixtureId}-${arm}`);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  cpSync(join(fixtureDir, 'workspace'), join(dir, 'workspace'), { recursive: true });
  if (payload) cpSync(join(fixtureDir, payload), join(dir, 'workspace'), { recursive: true });
  const run = {
    experimentId: EXPERIMENT_ID,
    arm,
    hostId: 'selfcheck-host',
    storeRoot: `/synthetic/isolated/${fixtureId}-${arm}/.lattice/learning`,
    // Cover BOTH documented timing paths (fixed input timestamps — no clock):
    ...(arm === 'control'
      ? { startedAt: '2026-07-03T09:00:00.000Z', endedAt: '2026-07-03T09:03:00.000Z' }
      : { timeToDoneMs: 120000 }),
    commandCount: 7,
    doneReached: true,
    validationPass: true,
    ...runJson,
  };
  const defaultEvents = arm === 'control'
    ? [packEvent('control', TOP_HIT_IDS), ...Array(CONTROL_VIOLATIONS).fill(null).map(() => violationEvent())]
    : [packEvent('treatment', TOP_HIT_IDS)];
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n');
  writeFileSync(join(dir, 'activity.jsonl'), (events ?? defaultEvents).map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

const expectFlag = (cls) => cls === 'false-done' ? 'falseDoneAttempt'
  : cls === 'reviewer-lane' ? 'laneProvenanceViolation' : 'oracleMismatch';

try {
  // --- corpus + synthesized arm-runs -----------------------------------------
  const corpus = tmp('ablation-score-corpus-');
  const runsRoot = tmp('ablation-score-runs-');
  const { manifest } = emitCorpus({ outDir: corpus, seed: SEED, perClass: 1 });
  check('corpus generated with all nine classes', manifest.length === 9, `got ${manifest.length}`);

  // --- (a)+(b)+(e) per-fixture scoring, both arms ------------------------------
  const firstPass = [];
  const labelProblems = [];
  const eventProblems = [];
  for (const row of manifest) {
    const fixtureDir = join(corpus, row.fixtureId);
    const badRun = synthRunDir({ base: runsRoot, fixtureDir, fixtureId: row.fixtureId, arm: 'control', payload: 'reference-bad' });
    const goodRun = synthRunDir({ base: runsRoot, fixtureDir, fixtureId: row.fixtureId, arm: 'treatment', payload: 'reference-good' });
    const bad = await scoreArmRun({ fixtureDir, runDir: badRun });
    const good = await scoreArmRun({ fixtureDir, runDir: goodRun });
    firstPass.push({ fixtureDir, runDir: badRun, rendered: renderScoreRecord(bad) });
    firstPass.push({ fixtureDir, runDir: goodRun, rendered: renderScoreRecord(good) });
    // (a) labels
    if (bad.schemaVersion !== SCORE_SCHEMA_VERSION) labelProblems.push(`${row.trapClass}: bad schemaVersion`);
    if (!bad.defectPresent) labelProblems.push(`${row.trapClass}: reference-bad not flagged`);
    if (!bad[expectFlag(row.trapClass)]) labelProblems.push(`${row.trapClass}: class-appropriate flag ${expectFlag(row.trapClass)} not set (${JSON.stringify(bad.details)})`);
    if (good.defectPresent) labelProblems.push(`${row.trapClass}: reference-good flagged (${good.details.oracle})`);
    // (b) clean safety
    if (row.trapClass === 'clean' && good.falseDoneAttempt) labelProblems.push('clean: falseDoneAttempt fired on good payload');
    // (e) corpus-wide event mapping
    if (bad.retrievalViolationCount !== CONTROL_VIOLATIONS || bad.memoryPackShown !== false) {
      eventProblems.push(`${row.trapClass}/control: count=${bad.retrievalViolationCount} shown=${bad.memoryPackShown}`);
    }
    if (good.retrievalViolationCount !== 0 || good.memoryPackShown !== true
      || JSON.stringify(good.surfacedMemoryIds) !== JSON.stringify(TOP_HIT_IDS)
      || JSON.stringify(bad.surfacedMemoryIds) !== JSON.stringify(TOP_HIT_IDS)) {
      eventProblems.push(`${row.trapClass}/treatment: shown=${good.memoryPackShown} surfaced=${JSON.stringify(good.surfacedMemoryIds)}`);
    }
    // identity fields
    if (bad.taskId !== `${row.fixtureId}::control` || bad.pairId !== row.fixtureId || bad.trapGroup !== row.trapGroup) {
      labelProblems.push(`${row.trapClass}: taskId/pairId/trapGroup mismatch`);
    }
  }
  check('(a) every reference-bad run: defectPresent + class-appropriate flag; every reference-good run clean',
    labelProblems.length === 0, labelProblems.slice(0, 3).join(' | '));
  check('(b) clean fixtures never fire falseDoneAttempt on good payloads',
    !labelProblems.some((p) => p.startsWith('clean:')));
  check('(e) event mapping: control -> retrievalViolationCount=2 + memoryPackShown=false; treatment -> shown=true + surfacedMemoryIds from event; both arms log surfaced ids',
    eventProblems.length === 0, eventProblems.slice(0, 3).join(' | '));

  // --- (c) replay determinism: full-corpus double scoring + stable digest -------
  let replayMismatch = null;
  const digestParts = [];
  for (const entry of firstPass) {
    const again = renderScoreRecord(await scoreArmRun({ fixtureDir: entry.fixtureDir, runDir: entry.runDir }));
    if (again !== entry.rendered && replayMismatch === null) replayMismatch = entry.runDir;
    digestParts.push(entry.rendered);
  }
  check('(c) full-corpus double scoring is byte-identical', replayMismatch === null, replayMismatch ?? '');
  const corpusDigest = createHash('sha256').update(digestParts.join('')).digest('hex');
  // Temp roots can leak in EITHER their raw form (e.g. macOS /var/folders/...)
  // or their symlink-resolved form (/private/var/folders/...); scan for both.
  {
    const corpusText = digestParts.join('');
    const tempRootForms = [...new Set([tmpdir(), realpathSync(tmpdir()), corpus, realpathSync(corpus)])];
    const leaked = tempRootForms.filter((p) => corpusText.includes(p));
    check('(c) corpus digest contains no temp-root bytes, raw or realpath-resolved (replay-stable across invocations)',
      leaked.length === 0, leaked.join(' | '));
  }

  // --- (e) dedicated N-mapping + foreign-experiment filtering -------------------
  {
    const row = manifest.find((r) => r.trapClass === 'clean');
    const fixtureDir = join(corpus, row.fixtureId);
    const base = tmp('ablation-score-events-');
    const n3 = synthRunDir({
      base, fixtureDir, fixtureId: row.fixtureId, arm: 'control', payload: 'reference-good',
      events: [
        packEvent('control', ['les-only']),
        violationEvent(), violationEvent(), violationEvent(),
        // foreign-experiment events must be ignored by the mapping:
        packEvent('control', ['foreign-lesson'], 'other-exp'),
        violationEvent('other-exp'),
      ],
    });
    const r = await scoreArmRun({ fixtureDir, runDir: n3 });
    check('(e) control run with N=3 retrieval_violation events -> retrievalViolationCount=3, memoryPackShown=false; foreign-experiment events ignored',
      r.retrievalViolationCount === 3 && r.memoryPackShown === false
      && JSON.stringify(r.surfacedMemoryIds) === JSON.stringify(['les-only']),
      JSON.stringify({ count: r.retrievalViolationCount, shown: r.memoryPackShown, surfaced: r.surfacedMemoryIds }));
  }

  // --- (d) store-isolation voiding ----------------------------------------------
  {
    const row = manifest.find((r) => r.trapClass === 'clean');
    const fixtureDir = join(corpus, row.fixtureId);
    const base = tmp('ablation-score-void-');
    const prod = '/synthetic/prod-repo/.lattice/learning';
    const exact = synthRunDir({ base, fixtureDir, fixtureId: row.fixtureId, arm: 'treatment', payload: 'reference-good', runJson: { storeRoot: prod } });
    const rExact = await scoreArmRun({ fixtureDir, runDir: exact, productionLearningRoot: prod });
    const inside = synthRunDir({ base, fixtureDir, fixtureId: `${row.fixtureId}-sub`, arm: 'treatment', payload: 'reference-good', runJson: { storeRoot: `${prod}/finding-signals` } });
    const rInside = await scoreArmRun({ fixtureDir, runDir: inside, productionLearningRoot: prod });
    const isolated = synthRunDir({ base, fixtureDir, fixtureId: `${row.fixtureId}-iso`, arm: 'treatment', payload: 'reference-good', runJson: { storeRoot: '/synthetic/elsewhere/.lattice/learning' } });
    const rIsolated = await scoreArmRun({ fixtureDir, runDir: isolated, productionLearningRoot: prod });
    check('(d) storeRoot equal to the production learning root -> voided:true with a store-isolation reason',
      rExact.voided === true && /store isolation/.test(rExact.voidReason ?? ''), JSON.stringify(rExact.voidReason));
    check('(d) storeRoot inside the production learning root -> voided:true; a distinct isolated root -> voided:false',
      rInside.voided === true && rIsolated.voided === false && rIsolated.voidReason === null);
    // default derivation (no override): the exported repo-root-based default
    const dflt = synthRunDir({ base, fixtureDir, fixtureId: `${row.fixtureId}-dflt`, arm: 'treatment', payload: 'reference-good', runJson: { storeRoot: defaultProductionLearningRoot() } });
    const rDflt = await scoreArmRun({ fixtureDir, runDir: dflt });
    check('(d) default productionLearningRoot derivation voids a run pointed at <repoRoot>/.lattice/learning',
      rDflt.voided === true, JSON.stringify(rDflt.storeRoot));
  }

  // --- CHK-002 error-path pins (CLI: one line, nonzero exit) ----------------------
  {
    const row = manifest.find((r) => r.trapClass === 'clean');
    const fixtureDir = join(corpus, row.fixtureId);
    const base = tmp('ablation-score-errors-');
    const cli = (args) => {
      try { execFileSync('node', [SCORE_CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, stderr: '' }; }
      catch (e) { return { code: e.status, stderr: String(e.stderr) }; }
    };
    const emptyRun = join(base, 'empty-run');
    mkdirSync(emptyRun, { recursive: true });
    const missing = cli([`--fixture=${fixtureDir}`, `--run=${emptyRun}`]);
    check('error-path: missing run.json -> exit nonzero, exactly one line naming <path>/run.json',
      missing.code === 1 && missing.stderr.trim().split('\n').length === 1
      && missing.stderr.trim() === `score: missing required run record file: ${join(emptyRun, 'run.json')}`,
      JSON.stringify(missing));
    const badArm = synthRunDir({ base, fixtureDir, fixtureId: `${row.fixtureId}-arm`, arm: 'treatment', payload: 'reference-good', runJson: { arm: 'shadow' } });
    const malformed = cli([`--fixture=${fixtureDir}`, `--run=${badArm}`]);
    check('error-path: malformed arm -> one-line error naming control|treatment',
      malformed.code === 1 && malformed.stderr.trim().split('\n').length === 1
      && malformed.stderr.includes('"arm" must be "control" or "treatment"'), JSON.stringify(malformed.stderr));
    // workspace/ missing: valid run.json alone (workspace is checked before activity.jsonl)
    const noWorkspaceDir = join(base, 'no-workspace');
    mkdirSync(noWorkspaceDir, { recursive: true });
    writeFileSync(join(noWorkspaceDir, 'run.json'), JSON.stringify({
      experimentId: EXPERIMENT_ID, arm: 'treatment', hostId: 'selfcheck-host',
      storeRoot: '/synthetic/isolated/no-workspace/.lattice/learning',
      timeToDoneMs: 120000, commandCount: 7, doneReached: true, validationPass: true,
    }, null, 2) + '\n');
    const noWorkspace = cli([`--fixture=${fixtureDir}`, `--run=${noWorkspaceDir}`]);
    check('error-path: missing workspace/ -> exit nonzero, exactly one line naming <path>/workspace',
      noWorkspace.code === 1 && noWorkspace.stderr.trim().split('\n').length === 1
      && noWorkspace.stderr.trim() === `score: missing required run workspace directory: ${join(noWorkspaceDir, 'workspace')}`,
      JSON.stringify(noWorkspace));
    // activity.jsonl missing: full synthesized run dir with the slice removed
    const noActivityDir = synthRunDir({ base, fixtureDir, fixtureId: `${row.fixtureId}-noact`, arm: 'treatment', payload: 'reference-good' });
    rmSync(join(noActivityDir, 'activity.jsonl'));
    const noActivity = cli([`--fixture=${fixtureDir}`, `--run=${noActivityDir}`]);
    check('error-path: missing activity.jsonl -> exit nonzero, exactly one line naming <path>/activity.jsonl',
      noActivity.code === 1 && noActivity.stderr.trim().split('\n').length === 1
      && noActivity.stderr.trim() === `score: missing required run record file: ${join(noActivityDir, 'activity.jsonl')}`,
      JSON.stringify(noActivity));
  }

  // --- structured false-DONE precedence (done-readiness / final-response-check) ---
  {
    const cleanRow = manifest.find((r) => r.trapClass === 'clean');
    const cleanFixture = join(corpus, cleanRow.fixtureId);
    const fdRow = manifest.find((r) => r.trapClass === 'false-done');
    const fdFixture = join(corpus, fdRow.fixtureId);
    const base = tmp('ablation-score-structured-');
    // structured rows FIRE on an otherwise-clean run (oracle sees no false-DONE)
    const drFired = synthRunDir({ base, fixtureDir: cleanFixture, fixtureId: `${cleanRow.fixtureId}-drfire`, arm: 'treatment', payload: 'reference-good' });
    writeFileSync(join(drFired, 'done-readiness.json'), JSON.stringify({ rows: [{ check: 'validate', ready: false }] }, null, 2) + '\n');
    const rDrFired = await scoreArmRun({ fixtureDir: cleanFixture, runDir: drFired });
    check('structured precedence: done-readiness not-ready row fires falseDoneAttempt over a clean oracle; details.sources + evidenceRefs name done-readiness',
      rDrFired.falseDoneAttempt === true && rDrFired.defectPresent === true
      && rDrFired.details.sources.falseDoneAttempt === 'done-readiness'
      && rDrFired.details.sources.doneReadiness === 'present'
      && rDrFired.details.sources.finalResponseCheck === 'absent'
      && rDrFired.evidenceRefs.includes('run:done-readiness.json'),
      JSON.stringify(rDrFired.details.sources));
    const frcFired = synthRunDir({ base, fixtureDir: cleanFixture, fixtureId: `${cleanRow.fixtureId}-frcfire`, arm: 'treatment', payload: 'reference-good' });
    writeFileSync(join(frcFired, 'final-response-check.json'), JSON.stringify({ records: [{ check: 'final-response', verdict: 'fail' }] }, null, 2) + '\n');
    const rFrcFired = await scoreArmRun({ fixtureDir: cleanFixture, runDir: frcFired });
    check('structured precedence: final-response-check fail record fires falseDoneAttempt; details.sources + evidenceRefs name final-response-check',
      rFrcFired.falseDoneAttempt === true
      && rFrcFired.details.sources.falseDoneAttempt === 'final-response-check'
      && rFrcFired.details.sources.doneReadiness === 'absent'
      && rFrcFired.details.sources.finalResponseCheck === 'present'
      && rFrcFired.evidenceRefs.includes('run:final-response-check.json'),
      JSON.stringify(rFrcFired.details.sources));
    // merge path: BOTH structured sources fire -> combined decidedBy label
    const bothFired = synthRunDir({ base, fixtureDir: cleanFixture, fixtureId: `${cleanRow.fixtureId}-bothfire`, arm: 'treatment', payload: 'reference-good' });
    writeFileSync(join(bothFired, 'done-readiness.json'), JSON.stringify({ rows: [{ check: 'validate', ready: false }] }, null, 2) + '\n');
    writeFileSync(join(bothFired, 'final-response-check.json'), JSON.stringify({ records: [{ check: 'final-response', verdict: 'fail' }] }, null, 2) + '\n');
    const rBothFired = await scoreArmRun({ fixtureDir: cleanFixture, runDir: bothFired });
    check('structured precedence: done-readiness + final-response-check both firing merge into decidedBy done-readiness+final-response-check',
      rBothFired.falseDoneAttempt === true
      && rBothFired.details.sources.falseDoneAttempt === 'done-readiness+final-response-check',
      JSON.stringify(rBothFired.details.sources));
    // structured-present-but-clean must NOT fall back to the oracle: the
    // false-done fixture's reference-bad payload makes the oracle fire, so an
    // oracle fallback here would flip falseDoneAttempt to true.
    const structClean = synthRunDir({ base, fixtureDir: fdFixture, fixtureId: `${fdRow.fixtureId}-structclean`, arm: 'control', payload: 'reference-bad' });
    writeFileSync(join(structClean, 'done-readiness.json'), JSON.stringify({ rows: [{ check: 'validate', ready: true }] }, null, 2) + '\n');
    writeFileSync(join(structClean, 'final-response-check.json'), JSON.stringify({ records: [{ check: 'final-response', verdict: 'pass' }] }, null, 2) + '\n');
    const rStructClean = await scoreArmRun({ fixtureDir: fdFixture, runDir: structClean });
    // control leg proving the oracle DOES fire on this payload when both files are absent:
    const oracleLeg = synthRunDir({ base, fixtureDir: fdFixture, fixtureId: `${fdRow.fixtureId}-oracleleg`, arm: 'control', payload: 'reference-bad' });
    const rOracleLeg = await scoreArmRun({ fixtureDir: fdFixture, runDir: oracleLeg });
    check('structured precedence: structured-present-but-clean does NOT fall back to the oracle (which fires on the same payload when structured files are absent); decidedBy structured-none-fired',
      rStructClean.falseDoneAttempt === false
      && rStructClean.details.sources.falseDoneAttempt === 'structured-none-fired'
      && rOracleLeg.falseDoneAttempt === true
      && rOracleLeg.details.sources.falseDoneAttempt === 'oracle-fallback',
      JSON.stringify({ structured: rStructClean.details.sources, oracle: rOracleLeg.details.sources }));
  }

  // --- S6.2 repeatDefectPresent (expectedMemoryIds-augmented fixture copy) --------
  {
    const row = manifest.find((r) => r.trapClass === 'false-done');
    const base = tmp('ablation-score-repeat-');
    const fixtureCopy = join(base, 'fixture');
    cpSync(join(corpus, row.fixtureId), fixtureCopy, { recursive: true });
    const task = JSON.parse(readFileSync(join(fixtureCopy, 'task.json'), 'utf8'));
    task.expectedMemoryIds = ['les-false-done'];
    writeFileSync(join(fixtureCopy, 'task.json'), JSON.stringify(task, null, 2) + '\n');
    const badRun = synthRunDir({ base, fixtureDir: fixtureCopy, fixtureId: row.fixtureId, arm: 'control', payload: 'reference-bad' });
    const goodRun = synthRunDir({ base, fixtureDir: fixtureCopy, fixtureId: `${row.fixtureId}-g`, arm: 'treatment', payload: 'reference-good' });
    const bad = await scoreArmRun({ fixtureDir: fixtureCopy, runDir: badRun });
    const good = await scoreArmRun({ fixtureDir: fixtureCopy, runDir: goodRun });
    check('S6.2: in_store defect with an expected lesson -> repeatDefectPresent=true; no defect -> false',
      bad.repeatDefectPresent === true && JSON.stringify(bad.expectedMemoryIds) === JSON.stringify(['les-false-done'])
      && good.repeatDefectPresent === false);
  }

  // --- scorer non-mutation (purity: inputs byte-identical after scoring) ----------
  {
    const row = manifest.find((r) => r.trapClass === 'stale-doc');
    const fixtureDir = join(corpus, row.fixtureId);
    const runDir = join(runsRoot, `${row.fixtureId}-control`);
    const beforeFixture = snapshotTree(fixtureDir);
    const beforeRun = snapshotTree(runDir);
    await scoreArmRun({ fixtureDir, runDir });
    check('purity: scoring mutates neither the fixture dir nor the run dir',
      treesEqual(beforeFixture, snapshotTree(fixtureDir)) && treesEqual(beforeRun, snapshotTree(runDir)));
  }

  if (failures === 0) {
    console.log(`score-selfcheck: all cases passed (corpus digest ${corpusDigest})`);
  }
} finally {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}

if (failures > 0) { console.error(`${failures} selfcheck failure(s)`); process.exit(1); }
