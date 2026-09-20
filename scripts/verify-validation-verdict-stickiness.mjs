// Lab validation-verdict-stickiness: a validation PASS earned on an identity
// (command set, committed material, story files, compiled artifacts) that an
// earlier or later EXECUTED run FAILED on is not fresh evidence. Nothing
// changed and the verdict flipped, so the failure stands until the material or
// the build changes; an infrastructure failure (timeout, refused launch) is not
// a verdict and does not stick. RED marker: stale verdict admitted after a failure on the same identity
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const ts = createRequire(import.meta.url)('typescript');
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });
import assert from 'node:assert/strict';

const MARKER = 'stale verdict admitted after a failure on the same identity';
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const red = [];
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
function expectRepaired(value, message) { if (value) checks++; else red.push(message); }

const { evaluateRoutineValidationReuse, buildRoutineValidationIdentity } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { evaluateValidationEvidenceAdmissibility } = await import('../packages/main/src/core/validation-evidence-admissibility.ts');
const { currentGitHead, currentMaterialHash, currentStoryFilesHash } = await import('../packages/main/src/core/evidence-freshness.ts');
const { currentBuildArtifactsHash } = await import('../packages/main/src/core/build-artifacts-identity.ts');
const { signTestValidationEvidence } = await import('../packages/main/src/core/validation-artifact-signing.ts');
const { assessStoredValidationPassAdmissibility } = await import('../packages/main/src/handlers/validation-pass-admissibility.ts');
const { StoryStore } = await import('../packages/main/src/core/store.ts');
const stickiness = await import('../packages/main/src/core/validation-verdict-stickiness.ts').catch(() => null);

const H = (c) => c.repeat(64);
const identityA = { commandSetHash: H('1'), materialHash: H('2'), storyFilesHash: H('3'), buildArtifactsHash: H('4') };
const terminal = (overrides = {}) => ({
  type: 'validation_terminal', storyId: 'B-stk', disposition: 'executed', result: 'fail', failureKind: 'validation_failure',
  timestamp: '2026-09-20T00:00:00.000Z', ...identityA, ...overrides,
});

// ---------------------------------------------------------------------------
// 1. The rule itself, as a pure function over terminal facts.
// ---------------------------------------------------------------------------
if (stickiness?.stickyFailuresFor) {
  const sticky = (terminals, identity = identityA) => stickiness.stickyFailuresFor(identity, terminals);
  expectRepaired(sticky([terminal()]).length === 1, 'an executed validation failure on the same identity is not sticky');
  check(sticky([terminal({ failureKind: 'infra_failure' })]).length === 0, 'an infrastructure failure is not a verdict and must not stick');
  check(sticky([terminal({ disposition: 'reused' })]).length === 0, 'a reused terminal executed nothing and must not stick');
  check(sticky([terminal({ result: 'pass' })]).length === 0, 'a pass is not a failure');
  check(sticky([terminal({ buildArtifactsHash: H('9') })]).length === 0, 'a failure against other compiled artifacts is another identity');
  check(sticky([terminal({ materialHash: H('9') })]).length === 0, 'a failure on other material is another identity');
  check(sticky([terminal({ buildArtifactsHash: undefined })]).length === 0, 'a legacy terminal without the compiled-artifact identity cannot be matched and must not stick');
  expectRepaired(sticky([terminal({ failureKind: undefined })]).length === 1, 'a failure that recorded no failureKind must be treated as a verdict (fail closed), not as infrastructure');
  check(sticky([terminal({ timestamp: '2027-01-01T00:00:00.000Z' })]).length === 1, 'order does not matter: a later failure on the same identity still dominates an earlier pass');
  // Audit 2: a coverage-only failure - every required command passed, only
  // required coverage was missing - is the failure the reuse evaluator later
  // republishes as a PASS. It is not a verdict about the code.
  expectRepaired(sticky([terminal({ failureKind: 'coverage_incomplete' })]).length === 0, 'a coverage-only failure stuck, which would refuse the coverage recovery the evaluator is built to allow');
  // Audit 2: one refusal for both publications, the executed and the reused.
  expectRepaired(typeof stickiness.passPublicationRefusal === 'function', 'there is no shared publication refusal for the executed and the reused publication');
  if (typeof stickiness.passPublicationRefusal === 'function') {
    const refusal = stickiness.passPublicationRefusal;
    check(String(refusal({ terminals: [terminal()] }, identityA)).includes('[verdict_flip_refused]'), 'publication must refuse a PASS on an identity with an executed failure');
    check(String(refusal({ unreadable: 'line 3 is not valid JSON' }, identityA)).includes('[validation_history_unreadable]'), 'publication must refuse a PASS over an unreadable history');
    check(refusal({ terminals: [terminal({ failureKind: 'coverage_incomplete' }), terminal({ failureKind: 'infra_failure' })] }, identityA) === null, 'control: coverage-only and infrastructure failures do not refuse publication');
    // Audit 3: a PASS whose identity cannot be formed is an unknown, not a
    // pass-through. Legacy TERMINALS stay unmatched; new PASS evidence is not
    // left unbound. This is the expression both publications evaluate when
    // identity construction failed and handed them no command-set digest.
    const unbuilt = stickiness.verdictIdentityFromParts({ commandSetHash: undefined, materialHash: identityA.materialHash, storyFilesHash: identityA.storyFilesHash, buildArtifactsHash: identityA.buildArtifactsHash });
    check(unbuilt === null && stickiness.verdictIdentityFromParts({ ...identityA, buildArtifactsHash: 'short' }) === null, 'control: an identity with a missing or malformed part is not an identity');
    expectRepaired(String(refusal({ terminals: [] }, unbuilt)).includes('[validation_identity_unavailable]'), 'a PASS without its full identity was publishable');
    expectRepaired(String(refusal({ unreadable: 'line 3 is not valid JSON' }, unbuilt)).includes('[validation_identity_unavailable]'), 'a PASS without its full identity was publishable over an unreadable history');
  }
  // Audit 3: the terminal's kind comes from the executor's command outcomes.
  // Infrastructure is an exemption only when infrastructure is all that failed.
  const reuseModule = await import('../packages/main/src/core/validation-evidence-reuse.ts');
  expectRepaired(typeof reuseModule.classifyValidationTerminalFailure === 'function', 'there is no terminal failure classifier over command outcomes');
  if (typeof reuseModule.classifyValidationTerminalFailure === 'function') {
    const failingRecord = { result: 'FAIL', verificationCoverage: { missingRequired: 0 }, commandExecution: { status: 'FAIL' } };
    const classify = (commandResults, extra = {}) => reuseModule.classifyValidationTerminalFailure({ record: failingRecord, commandResults, ...extra });
    const ok = { code: 0 }, broke = { code: 1 }, timedOut = { code: 124, timedOut: true }, refused = { code: 1, failureKind: 'infra_failure' };
    expectRepaired(classify([timedOut, broke]) === 'validation_failure', 'a real command failure beside a timeout was classified as infrastructure');
    expectRepaired(classify([refused, broke]) === 'validation_failure', 'a real command failure beside a refused launch was classified as infrastructure');
    check(classify([timedOut, ok]) === 'infra_failure' && classify([refused]) === 'infra_failure', 'control: a run where infrastructure is all that failed is an infrastructure failure');
    check(classify([timedOut, { ...broke, optional: true }]) === 'infra_failure', 'control: an optional command failure is not a verdict');
    check(classify([timedOut], { semanticCommandPass: false }) === 'validation_failure', 'a failed semantic verdict beside a timeout is a verdict');
    check(classify([timedOut], { concurrentPollutionBlocking: true }) === 'validation_failure' && classify([{ code: 0, worktreePollution: { blocking: true } }, timedOut]) === 'validation_failure', 'blocking worktree pollution is a verdict');
    check(classify([ok]) === 'validation_failure', 'control: a failure no command explains fails closed as a verdict');
    const okExecution = { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 };
    check(reuseModule.classifyValidationTerminalFailure({ record: { result: 'FAIL', verificationCoverage: { missingRequired: 1 }, commandExecution: okExecution }, commandResults: [ok], expectedCommandCount: 1 }) === 'coverage_incomplete', 'control: passing commands with missing required coverage are a coverage-only failure');
    // Audit 4: classification is not reuse eligibility. A failed OPTIONAL
    // command beside the coverage gap makes the record unreusable, not a verdict.
    const optionalFailed = { ...okExecution, commandCount: 2, optionalFailureCount: 1 };
    expectRepaired(reuseModule.classifyValidationTerminalFailure({ record: { result: 'FAIL', verificationCoverage: { missingRequired: 1 }, commandExecution: optionalFailed }, commandResults: [ok, { ...broke, optional: true }] }) === 'coverage_incomplete',
      'a coverage gap beside a failed optional command was classified as a verdict about the code');
    check(reuseModule.isReusableCommandPass(optionalFailed, 2) === false, 'control: a record with a failed optional command is still not reusable');
    check(reuseModule.classifyValidationTerminalFailure({ record: { result: 'FAIL', verificationCoverage: { missingRequired: 1 }, commandExecution: { ...okExecution, status: 'FAIL', requiredFailureCount: 1 } }, commandResults: [broke] }) === 'validation_failure', 'control: a required failure beside the coverage gap is a verdict');
  }
} else {
  expectRepaired(false, 'core/validation-verdict-stickiness does not exist');
}

// ---------------------------------------------------------------------------
// 2. Consumers: admissibility and routine reuse refuse a flipped PASS.
// ---------------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), 'pos-verdict-stickiness-'));
try {
  const root = join(sandbox, 'repo'); mkdirSync(root);
  const git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Verdict Fixture']); git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', workflow: { profile: 'light' } }));
  writeFileSync(join(root, '.gitignore'), 'dist\n.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\n');
  writeFileSync(join(root, 'source.ts'), 'export const stickiness = true;\n');
  mkdirSync(join(root, 'packages/main/dist/tasks'), { recursive: true }); writeFileSync(join(root, 'packages/main/dist/tasks/x.js'), 'process.exit(0);\n');
  mkdirSync(join(root, 'packages/utils/dist'), { recursive: true }); writeFileSync(join(root, 'packages/utils/dist/index.js'), 'export const u = 1;\n');
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const storyId = 'B-stk';
  const store = new StoryStore(root);
  const now = '2026-09-20T00:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'verdict-stickiness', title: 'Verdict stickiness fixture', description: 'Disposable fixture for the fail-sticky rule.', type: 'chore', phase: 'TEST', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, riskSignals: [], currentReviewRound: now, events: [] });
  store.writeChecklist(storyId, { items: [] });
  git(['add', '.proof-or-stop']); git(['commit', '-qm', 'story']);
  const head = currentGitHead(root), materialHash = currentMaterialHash(root, 'HEAD', root), storyFilesHash = currentStoryFilesHash(root, 'HEAD', root), buildArtifactsHash = currentBuildArtifactsHash(root, root);
  check(head && materialHash && storyFilesHash && buildArtifactsHash, 'fixture identity must resolve');
  const identity = buildRoutineValidationIdentity({ projectRoot: root, sourceKind: 'configured', sourceInputs: { fixture: 'stickiness' }, commands: [{ label: 'probe', command: 'node', args: ['packages/main/dist/tasks/x.js'] }], profile: 'balanced', verificationPolicyInputs: {} });
  const real = { commandSetHash: identity.digest, materialHash, storyFilesHash, buildArtifactsHash };
  const evidence = {
    command: `proof-or-stop validate --story=${storyId} --json`, output: JSON.stringify({ allPass: true }), result: 'PASS', timestamp: now,
    headHash: head, materialHash, storyFilesHash, buildArtifactsHash, buildArtifactsProtection: 'enforced:sandbox-exec',
    verificationCoverage: { missingRequired: 0 }, disposition: 'executed', routineValidationIdentity: identity,
    commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
  };
  const failed = terminal({ ...real, storyId });
  const infraFailed = terminal({ ...real, storyId, failureKind: 'infra_failure' });
  const reuse = (terminals) => evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
    currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, currentBuildArtifactsHash: buildArtifactsHash, clean: true, headBefore: head, headAfter: head,
    validationHistory: { terminals },
  });
  const admit = (terminals) => evaluateValidationEvidenceAdmissibility({
    evidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    validationHistory: { terminals },
  });
  check(reuse([]).reusable === true && admit([]).ok === true, 'control: with no failure on record the PASS is reusable and admissible');
  expectRepaired(reuse([failed]).refusalReasons.includes('verdict-flip-unattested'), `routine reuse accepted a PASS whose identity had failed (${reuse([failed]).refusalReasons.join(',') || 'no refusal'})`);
  expectRepaired(admit([failed]).reasonCodes.includes('verdict_flip_unattested'), `admissibility accepted a PASS whose identity had failed (${admit([failed]).reasonCodes.join(',') || 'no refusal'})`);
  check(reuse([infraFailed]).reusable === true && admit([infraFailed]).ok === true, 'control: an infrastructure failure on the identity does not stick');
  check(reuse([terminal({ ...real, storyId, buildArtifactsHash: H('9') })]).reusable === true, 'control: a failure against other compiled artifacts does not stick');
  // A record of a failed execution is refused on its own terms and is not a
  // flipped verdict: the flip reason belongs only to a record claiming PASS.
  const failedExecution = { ...evidence, commandExecution: { ...evidence.commandExecution, status: 'FAIL', requiredFailureCount: 1 } };
  const failedReuse = evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence: failedExecution, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
    currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, currentBuildArtifactsHash: buildArtifactsHash, clean: true, headBefore: head, headAfter: head,
    validationHistory: { terminals: [failed] },
  });
  check(failedReuse.reusable === false && !failedReuse.refusalReasons.includes('verdict-flip-unattested'),
    `control: a record of a failed execution refuses on its own terms, without the flip reason (${failedReuse.refusalReasons.join(',')})`);
  // Audit 2: a coverage-only FAIL is republished as a PASS once coverage is
  // complete, so it is a candidate like any PASS and is judged against the
  // same history. Its own coverage-only terminal does not refuse the recovery.
  const coverageOnly = { ...evidence, result: 'FAIL', verificationCoverage: { missingRequired: 1 } };
  const reuseCoverageOnly = (validationHistory) => evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence: coverageOnly, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
    currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, currentBuildArtifactsHash: buildArtifactsHash, clean: true, headBefore: head, headAfter: head,
    validationHistory,
  });
  check(reuseCoverageOnly({ terminals: [] }).reusable === true, `control: a coverage-only FAIL is reusable once coverage is complete (${reuseCoverageOnly({ terminals: [] }).refusalReasons.join(',')})`);
  check(reuseCoverageOnly({ terminals: [terminal({ ...real, storyId, failureKind: 'coverage_incomplete' })] }).reusable === true, 'control: the coverage-only failure on record does not refuse its own recovery');
  expectRepaired(reuseCoverageOnly({ terminals: [failed] }).refusalReasons.includes('verdict-flip-unattested'),
    `a coverage-only FAIL was reusable as a PASS although an executed run failed on its identity (${reuseCoverageOnly({ terminals: [failed] }).refusalReasons.join(',') || 'no refusal'})`);
  expectRepaired(reuseCoverageOnly({ unreadable: 'process-events.jsonl: line 3 is not valid JSON' }).refusalReasons.includes('validation-history-unreadable'),
    'a coverage-only FAIL was reusable as a PASS over an unreadable history');
  // Audit 3: a stored PASS that does not carry its full identity cannot be
  // matched against the history, so it is refused rather than waved through.
  const { routineValidationIdentity: _noIdentity, ...unboundEvidence } = evidence;
  const unboundAdmit = evaluateValidationEvidenceAdmissibility({
    evidence: unboundEvidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    validationHistory: { terminals: [failed] },
  });
  expectRepaired(unboundAdmit.reasonCodes.includes('validation_identity_incomplete'), `a PASS without a routine identity was admitted although its identity had failed (${unboundAdmit.reasonCodes.join(',') || 'admitted'})`);
  const failedAdmit = evaluateValidationEvidenceAdmissibility({
    evidence: { ...evidence, result: 'FAIL' }, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    validationHistory: { terminals: [failed] },
  });
  check(failedAdmit.reasonCodes.includes('result_not_pass') && !failedAdmit.reasonCodes.includes('verdict_flip_unattested'),
    `control: a FAIL record is refused as not-PASS, not as a flip (${failedAdmit.reasonCodes.join(',')})`);

  // -------------------------------------------------------------------------
  // 3. The real DONE-side consumer reads the Story's own process events.
  // -------------------------------------------------------------------------
  store.writeTestEvidence(storyId, signTestValidationEvidence(storyId, evidence, root));
  const ctx = { root, store, scanRoot: root };
  const codesWith = (events) => {
    for (const event of events) store.appendProcessEvent(storyId, event);
    const result = assessStoredValidationPassAdmissibility(ctx, storyId, { allowDynamicCoverage: true });
    return result.reasonCodes;
  };
  const baseline = codesWith([]);
  check(!baseline.includes('verdict_flip_unattested'), 'control: the stored PASS is not refused for a flip before any failure is recorded');
  const afterInfra = codesWith([{ ...infraFailed, timestamp: undefined }]);
  check(!afterInfra.includes('verdict_flip_unattested'), 'control: an infrastructure failure on record does not refuse the stored PASS');
  const afterFail = codesWith([{ ...failed, timestamp: undefined }]);
  expectRepaired(afterFail.includes('verdict_flip_unattested'), `the DONE-side consumer admitted a stored PASS after an executed failure on the same identity (codes=${afterFail.join(',')})`);

  // Audit: an unreadable history proves nothing and must refuse, never pass
  // as an empty history. A missing file is an empty history.
  const unreadableReuse = evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
    currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, currentBuildArtifactsHash: buildArtifactsHash, clean: true, headBefore: head, headAfter: head,
    validationHistory: { unreadable: 'process-events.jsonl: line 3 is not valid JSON' },
  });
  expectRepaired(unreadableReuse.reusable === false && unreadableReuse.refusalReasons.includes('validation-history-unreadable'),
    `an unreadable history let reuse proceed (${unreadableReuse.refusalReasons.join(',') || 'no refusal'})`);
  const unreadableAdmit = evaluateValidationEvidenceAdmissibility({
    evidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    validationHistory: { unreadable: 'process-events.jsonl: line 3 is not valid JSON' },
  });
  expectRepaired(unreadableAdmit.reasonCodes.includes('validation_history_unreadable'), `an unreadable history let admission proceed (${unreadableAdmit.reasonCodes.join(',')})`);
  if (stickiness?.readValidationHistory) {
    const fresh = stickiness.readValidationHistory({ storyDirPath: () => join(sandbox, 'no-such-story') }, 'B-none');
    check('terminals' in fresh && fresh.terminals.length === 0, 'control: a Story with no process-events file has an empty history, not an unreadable one');
    const throwing = stickiness.readValidationHistory({ storyDirPath: () => { throw new Error('boom'); } }, storyId);
    expectRepaired('unreadable' in throwing, 'a store that cannot locate the Story was read as an empty history');
    // Audit 3: only a CONFIRMED absence is an empty history. A lookup that is
    // denied, or that runs through something that is not a directory, proves nothing.
    const notADirectory = join(sandbox, 'plain-file'); writeFileSync(notADirectory, 'x');
    expectRepaired('unreadable' in stickiness.readValidationHistory({ storyDirPath: () => join(notADirectory, 'story') }, storyId), 'a lookup through a non-directory was read as an empty history');
    const locked = join(sandbox, 'locked'); mkdirSync(join(locked, 'story'), { recursive: true }); writeFileSync(join(locked, 'story/process-events.jsonl'), '');
    chmodSync(locked, 0o000);
    let denied; try { denied = stickiness.readValidationHistory({ storyDirPath: () => join(locked, 'story') }, storyId); } finally { chmodSync(locked, 0o755); }
    expectRepaired(process.getuid?.() === 0 || 'unreadable' in denied, 'a denied lookup was read as an empty history');
    // ... and a line is a process event only if it has a type, a validation
    // terminal only if its result and disposition are ones this rule knows.
    const historyOf = (lines) => { const dir = mkdtempSync(join(sandbox, 'history-')); writeFileSync(join(dir, 'process-events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return stickiness.readValidationHistory({ storyDirPath: () => dir }, storyId); };
    expectRepaired('unreadable' in historyOf([{}]), 'an object that is not a process event was read as history');
    expectRepaired('unreadable' in historyOf([{ type: '' }]) && 'unreadable' in historyOf([{ type: 7 }]), 'a line without a usable type was read as history');
    expectRepaired('unreadable' in historyOf([terminal({ result: 'maybe' })]) && 'unreadable' in historyOf([terminal({ disposition: undefined })]), 'a malformed validation terminal was read as history');
    const legacyHistory = historyOf([{ type: 'dispatch', storyId }, terminal({ buildArtifactsHash: undefined, failureKind: undefined }), terminal({ result: 'pass', disposition: 'reused', failureKind: undefined })]);
    check('terminals' in legacyHistory && legacyHistory.terminals.length === 2, 'control: other events, legacy terminals and reused terminals are a readable history');
    // Audit 5: an executed failure that claims the compiled-artifact identity
    // but lost a part of it - a lookup that failed when it was written - can
    // be matched by nothing. Skipping it would let the unchanged retry publish.
    const lostMaterial = historyOf([terminal({ materialHash: '' })]);
    const lostStoryFiles = historyOf([terminal({ storyFilesHash: undefined })]);
    expectRepaired('unreadable' in lostMaterial && 'unreadable' in lostStoryFiles, 'an executed failure with a lost material or story-files binding was skipped as history');
    expectRepaired(typeof stickiness.passPublicationRefusal === 'function' && String(stickiness.passPublicationRefusal(lostMaterial, identityA)).includes('[validation_history_unreadable]'),
      'an unchanged retry could publish a PASS past a failure whose binding was lost');
    const tolerated = historyOf([terminal({ buildArtifactsHash: undefined, materialHash: '' }), terminal({ result: 'pass', materialHash: '' }), terminal({ disposition: 'reused', result: 'pass', storyFilesHash: '' })]);
    check('terminals' in tolerated && tolerated.terminals.length === 3, 'control: a legacy failure, and a pass or reused terminal, never need a complete identity to be history');
  }
  const eventsPath = join(root, '.proof-or-stop/story/actives', storyId, 'process-events.jsonl');
  const intact = readFileSync(eventsPath, 'utf8');
  writeFileSync(eventsPath, intact + '{not json\n');
  const corrupt = assessStoredValidationPassAdmissibility(ctx, storyId, { allowDynamicCoverage: true }).reasonCodes;
  expectRepaired(corrupt.includes('validation_history_unreadable'), `the DONE-side consumer admitted a PASS over a corrupt history (codes=${corrupt.join(',')})`);
  writeFileSync(eventsPath, intact);

  // -------------------------------------------------------------------------
  // 4. The report groups the fixture's terminals by full identity.
  // -------------------------------------------------------------------------
  const report = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/report-validation-verdict-flips.mjs'), '--root', root, '--json'], { encoding: 'utf8' }));
  check(report.terminals === 2 && report.identities === 1, `report must see the two executed terminals as one identity (${JSON.stringify(report)})`);
  check(report.flippedIdentities === 0, 'report: an infrastructure failure plus a validation failure is not a pass/fail flip');
  store.appendProcessEvent(storyId, { ...terminal({ ...real, storyId, result: 'pass' }), timestamp: undefined });
  const flipped = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/report-validation-verdict-flips.mjs'), '--root', root, '--json'], { encoding: 'utf8' }));
  check(flipped.flippedIdentities === 1 && flipped.redundantExecutions === 2, `report must count the flip and the re-executions (${JSON.stringify(flipped)})`);
  // Audit: another Story with the same identity is another history. One Story
  // that failed and one that passed is neither a retry nor a flip.
  const otherStory = 'B-stk-other';
  store.writeStory(otherStory, { storyId: otherStory, name: 'verdict-stickiness-other', title: 'Other Story', description: 'Second Story sharing the identity.', type: 'chore', phase: 'TEST', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, riskSignals: [], currentReviewRound: now, events: [] });
  store.writeChecklist(otherStory, { items: [] });
  store.appendProcessEvent(otherStory, { ...terminal({ ...real, storyId: otherStory, result: 'pass' }), timestamp: undefined });
  const twoStories = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/report-validation-verdict-flips.mjs'), '--root', root, '--json'], { encoding: 'utf8' }));
  expectRepaired(twoStories.identities === 2 && twoStories.flippedIdentities === 1 && twoStories.flips.every((flip) => flip.storyId === storyId),
    `the report merged two Stories' histories on one identity (${JSON.stringify(twoStories)})`);
  // A failure that an older PASS replaces without executing anything leaves no
  // second execution to count, so the report counts it on its own, in log order.
  const runReport = (...flags) => JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/report-validation-verdict-flips.mjs'), '--root', root, ...flags, '--json'], { encoding: 'utf8' }));
  check(twoStories.failThenExecutedPassIdentities === 1 && twoStories.failThenReusedPassIdentities === 0,
    `report must count the executed pass that followed the failure, and no reused one yet (${JSON.stringify(twoStories)})`);
  store.appendProcessEvent(storyId, { ...terminal({ ...real, storyId, disposition: 'reused', result: 'pass', failureKind: undefined }), timestamp: undefined });
  store.appendProcessEvent(otherStory, { ...terminal({ ...real, storyId: otherStory, disposition: 'reused', result: 'pass', failureKind: undefined }), timestamp: undefined });
  const reusedAfterFail = runReport();
  check(reusedAfterFail.failThenReusedPassIdentities === 1 && reusedAfterFail.reusedPassesAfterFail === 1 && reusedAfterFail.identities === 2 && reusedAfterFail.redundantExecutions === 2,
    `report must count a reused pass after a failure only in the Story that failed, and never as an execution (${JSON.stringify(reusedAfterFail)})`);
  // Terminals from before the artifact binding are never folded into the full
  // identity; --legacy reports them apart, under the identity they do carry.
  store.appendProcessEvent(storyId, { ...terminal({ ...real, storyId, buildArtifactsHash: undefined }), timestamp: undefined });
  store.appendProcessEvent(storyId, { ...terminal({ ...real, storyId, buildArtifactsHash: undefined, disposition: 'reused', result: 'pass', failureKind: undefined }), timestamp: undefined });
  const legacyHidden = runReport();
  check(legacyHidden.legacy === undefined && legacyHidden.ungroupableLegacyTerminals === 1 && legacyHidden.identities === 2 && legacyHidden.failThenReusedPassIdentities === 1,
    `legacy terminals must stay out of the full identity (${JSON.stringify(legacyHidden)})`);
  const legacyShown = runReport('--legacy');
  check(legacyShown.legacy?.identities === 1 && legacyShown.legacy.failThenReusedPassIdentities === 1 && legacyShown.legacy.identityParts.length === 3 && legacyShown.identities === 2,
    `--legacy must report legacy terminals in their own block under the three-part identity (${JSON.stringify(legacyShown)})`);
  // A coverage-only failure is not a verdict: the pass that follows it, in the
  // Story that never failed a command, is neither a flip nor a pass after a failure.
  store.appendProcessEvent(otherStory, { ...terminal({ ...real, storyId: otherStory, failureKind: 'coverage_incomplete' }), timestamp: undefined });
  store.appendProcessEvent(otherStory, { ...terminal({ ...real, storyId: otherStory, disposition: 'reused', result: 'pass', failureKind: undefined }), timestamp: undefined });
  const coverageOnlyReport = runReport();
  check(coverageOnlyReport.flippedIdentities === 1 && coverageOnlyReport.failThenReusedPassIdentities === 1 && coverageOnlyReport.reusedPassesAfterFail === 1 && coverageOnlyReport.flips.every((flip) => flip.storyId === storyId),
    `the report counted a coverage-only failure as a verdict (${JSON.stringify(coverageOnlyReport)})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 4b. End to end through the built CLI. The validate file reads a switch
//     OUTSIDE the repository, so two runs share every byte of the identity
//     (command set, committed material, story files, compiled artifacts) while
//     their verdicts differ: the flaky test, as the history recorded it.
// ---------------------------------------------------------------------------
const cli = join(repoRoot, 'packages/main/dist/cli.js');
check(existsSync(cli), `the end-to-end retry regression requires a built CLI at ${cli}`);
const { persistSyntheticAdmittedWindowForTest } = await import('../packages/main/src/core/certification-window.ts');
const { deriveCertificationDomainInputHashes } = await import('../packages/main/src/handlers/certification-window.ts');
const cliSandbox = mkdtempSync(join(tmpdir(), 'pos-verdict-stickiness-cli-'));
const switchPath = join(cliSandbox, 'switch.txt');
try {
  const seed = (name, validateTs, priority = 'should', prepare = () => {}) => {
    const root = join(cliSandbox, name); mkdirSync(root);
    const storyId = 'B-stk-cli';
    const git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\nnode_modules\ndist\n');
    writeFileSync(join(root, 'source.ts'), 'export const stickiness = true;\n');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'light' } }, null, 2));
    writeFileSync(join(root, 'validate.ts'), validateTs);
    prepare(root);
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules/.bin/tsx'), '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
    git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Verdict Fixture']); git(['config', 'commit.gpgsign', 'false']);
    git(['add', '.']); git(['commit', '-qm', 'base']); git(['checkout', '-qb', `story/${storyId}`]);
    const now = '2026-09-20T00:00:00.000Z';
    const store = new StoryStore(root);
    store.writeStory(storyId, { storyId, name: 'verdict-stickiness-cli', title: 'Verdict stickiness through the CLI', description: 'Disposable fixture: a flaky validate file on an unchanged identity.', type: 'bug', phase: 'TEST', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, riskSignals: [], currentReviewRound: now, events: [{ phase: 'TEST', action: 'advance', timestamp: now }] });
    store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'flaky', context: 'validate file', status: 'done', verificationIntent: { happy: [{ desc: 'validate file runs', type: 'logic', priority }], edge: [], adversarial: [] }, startTime: now, endTime: now }] });
    const admit = () => {
      persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes: deriveCertificationDomainInputHashes(root, 'HEAD', root) });
      git(['add', '.proof-or-stop']); git(['commit', '-qm', 'admit one execution']);
    };
    admit();
    mkdirSync(join(root, 'packages/main/dist/tasks'), { recursive: true }); writeFileSync(join(root, 'packages/main/dist/tasks/x.js'), 'process.exit(0);\n');
    mkdirSync(join(root, 'packages/utils/dist'), { recursive: true }); writeFileSync(join(root, 'packages/utils/dist/index.js'), 'export const u = 1;\n');
    const runCli = () => {
      const r = spawnSync(process.execPath, [cli, 'validate', `--story=${storyId}`, '--json'], {
        cwd: root, encoding: 'utf8', timeout: 300_000,
        env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_SESSION_ID: 'verdict-stickiness', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', npm_config_yes: 'true', STICKINESS_SWITCH: switchPath },
      });
      return { status: r.status, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
    };
    const evidencePath = join(root, `.proof-or-stop/story/actives/${storyId}/test-evidence.json`);
    const evidence = () => existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
    const history = () => (stickiness ? stickiness.readValidationHistory(store, storyId) : { terminals: [] });
    return { root, storyId, store, git, admit, runCli, evidence, history };
  };
  const flaky = (extraJson = '') => `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nconsole.log(JSON.stringify({ provider: 'flaky-fixture', status: verdict === 'pass' ? 'pass' : 'fail', allPass: verdict === 'pass', summary: verdict, details: [], warnings: []${extraJson} }));\nprocess.exit(verdict === 'pass' ? 0 : 1);\n`;
  const kinds = (h) => JSON.stringify(('terminals' in h ? h.terminals : []).map((t) => [t.result, t.disposition, t.failureKind]));

  // FAIL then PASS on the identical identity: the retry is refused at publication.
  const retry = seed('retry', flaky());
  writeFileSync(switchPath, 'fail\n');
  const firstRun = retry.runCli();
  check(firstRun.status !== 0 && retry.evidence()?.result !== 'PASS', `control: the failing run must fail (${firstRun.text.slice(0, 300)})`);
  const firstHistory = retry.history();
  check('terminals' in firstHistory && firstHistory.terminals.some((t) => t.result === 'fail' && t.disposition === 'executed'), `control: the failing run recorded an executed failure terminal (${kinds(firstHistory)})`);
  expectRepaired('terminals' in firstHistory && firstHistory.terminals.filter((t) => t.result === 'fail').every((t) => t.failureKind === 'validation_failure'),
    `the failing run's terminal does not record a validation failure kind (${kinds(firstHistory)})`);
  retry.admit();
  writeFileSync(switchPath, 'pass\n');
  const secondRun = retry.runCli();
  expectRepaired(secondRun.status !== 0, 'a PASS retry on the identical identity after a FAIL was reported as success');
  expectRepaired(secondRun.text.includes('verdict_flip_refused'), `the retry's output does not name the refusal (${secondRun.text.slice(0, 400)})`);
  expectRepaired(retry.evidence()?.result !== 'PASS', 'a PASS was published for a retry on an identity that had failed');

  // A validate file that claims its failure was infrastructure is still a
  // validation failure, and still sticks.
  const spoof = seed('spoof', flaky(", failureKind: 'infra_failure'"));
  writeFileSync(switchPath, 'fail\n');
  const spoofFirst = spoof.runCli();
  check(spoofFirst.status !== 0, `control: the spoofing failing run must fail (${spoofFirst.text.slice(0, 200)})`);
  const spoofHistory = spoof.history();
  expectRepaired('terminals' in spoofHistory && spoofHistory.terminals.some((t) => t.result === 'fail' && t.disposition === 'executed' && t.failureKind === 'validation_failure'),
    `a child-printed infra_failure was recorded as the terminal's failure kind (${kinds(spoofHistory)})`);
  spoof.admit();
  writeFileSync(switchPath, 'pass\n');
  const spoofSecond = spoof.runCli();
  expectRepaired(spoofSecond.status !== 0 && spoofSecond.text.includes('verdict_flip_refused'), 'a spoofed infrastructure classification exempted the retry from stickiness');

  // PASS then PASS: nothing sticks, the second run succeeds.
  const steady = seed('steady', flaky());
  writeFileSync(switchPath, 'pass\n');
  const steadyFirst = steady.runCli();
  check(steadyFirst.status === 0 && steady.evidence()?.result === 'PASS', `control: a passing run must pass (${steadyFirst.text.slice(0, 300)})`);
  // Audit 2: the terminal the REAL reuse path appends must be the one
  // done_prepare trusts, bound to the reused evidence's identity and protection.
  const reusedRun = steady.runCli();
  const reusedHistory = steady.history();
  const realReused = 'terminals' in reusedHistory ? reusedHistory.terminals.find((t) => t.disposition === 'reused') : undefined;
  check(reusedRun.status === 0 && Boolean(realReused), `control: a second run on an unchanged identity is reused (${kinds(reusedHistory)} ${reusedRun.text.slice(0, 200)})`);
  const reusedEvidence = steady.evidence();
  const trust = (await import('../packages/main/src/core/done-prepare-generated-metadata.ts')).isTrustedReusedValidationTerminal;
  const story = steady.store.readStory(steady.storyId);
  const binding = realReused ? {
    storyId: steady.storyId, attemptId: story.currentReviewRound ?? '', reviewRound: story.currentReviewRound ?? '', phase: 'TEST', disposition: 'reused', result: 'pass', commandExecutions: 0,
    commandSetHash: reusedEvidence.routineValidationIdentity.digest, materialHash: reusedEvidence.materialHash, storyFilesHash: reusedEvidence.storyFilesHash,
    buildArtifactsHash: reusedEvidence.buildArtifactsHash, buildArtifactsProtection: reusedEvidence.buildArtifactsProtection,
    notBefore: '2000-01-01T00:00:00.000Z', notAfter: '2100-01-01T00:00:00.000Z',
  } : null;
  expectRepaired(Boolean(realReused) && typeof realReused.buildArtifactsProtection === 'string' && realReused.buildArtifactsProtection === reusedEvidence?.buildArtifactsProtection && realReused.buildArtifactsHash === reusedEvidence?.buildArtifactsHash,
    `the real reused terminal does not carry the reused evidence's compiled-artifact identity and protection (${JSON.stringify(realReused)})`);
  expectRepaired(Boolean(binding) && typeof trust === 'function' && trust(realReused, binding) === true, 'done_prepare refuses the terminal the real reuse path writes');
  steady.admit();
  const steadySecond = steady.runCli();
  check(steadySecond.status === 0 && !steadySecond.text.includes('verdict_flip_refused'), `control: a second pass on a never-failed identity must not be refused (${steadySecond.text.slice(0, 300)})`);

  // Audit 2: a real coverage-only failure - the commands pass, a required
  // intent has no evidence - records its own kind, from the executor's facts.
  const uncovered = seed('uncovered', flaky(), 'must');
  writeFileSync(switchPath, 'pass\n');
  const uncoveredRun = uncovered.runCli();
  const uncoveredEvidence = uncovered.evidence();
  check(uncoveredRun.status !== 0 && uncoveredEvidence?.result === 'FAIL' && uncoveredEvidence?.commandExecution?.status === 'PASS' && uncoveredEvidence?.verificationCoverage?.missingRequired === 1,
    `control: passing commands with a missing required intent fail on coverage alone (${uncoveredRun.text.slice(0, 300)})`);
  expectRepaired(kinds(uncovered.history()) === JSON.stringify([['fail', 'executed', 'coverage_incomplete']]), `a coverage-only failure is not recorded as one (${kinds(uncovered.history())})`);
  // A commands failure with the same missing coverage is a verdict all the same.
  const uncoveredFailing = seed('uncovered-failing', flaky(), 'must');
  writeFileSync(switchPath, 'fail\n');
  uncoveredFailing.runCli();
  check(kinds(uncoveredFailing.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]), `control: failing commands are a validation failure whatever the coverage (${kinds(uncoveredFailing.history())})`);

  // Audit 3: two configured commands. One times out; whether the other really
  // fails decides what the run is. The switch lives in a gitignored runtime
  // directory, so neither the material nor the command set changes between runs.
  const seedCommands = (name) => {
    const readSwitch = "require('node:fs').readFileSync(require('node:path').join(__dirname, '.proof-or-stop/runtime/switch.txt'), 'utf8').trim()";
    const fixture = seed(name, '', 'should', (root) => {
      rmSync(join(root, 'validate.ts'));
      writeFileSync(join(root, 'verdict.cjs'), `process.exit(${readSwitch} === 'mixed' ? 1 : 0);\n`);
      writeFileSync(join(root, 'slow.cjs'), `if (${readSwitch} === 'pass') process.exit(0);\nsetTimeout(() => process.exit(0), 60000);\n`);
      const config = JSON.parse(readFileSync(join(root, 'proof-or-stop.config.json'), 'utf8'));
      writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ ...config, validate: { commands: [{ command: 'node', args: ['slow.cjs'], timeoutMs: 3000 }, { command: 'node', args: ['verdict.cjs'], timeoutMs: 30000 }] } }, null, 2));
    });
    mkdirSync(join(fixture.root, '.proof-or-stop/runtime'), { recursive: true });
    const runWith = (value) => { writeFileSync(join(fixture.root, '.proof-or-stop/runtime/switch.txt'), `${value}\n`); return fixture.runCli(); };
    return { ...fixture, runWith };
  };
  const mixed = seedCommands('mixed');
  const mixedRun = mixed.runWith('mixed');
  check(mixedRun.status !== 0 && mixed.evidence()?.commandExecution?.requiredFailureCount === 2, `control: a timeout and a real failure are two required failures (${mixedRun.text.slice(0, 300)})`);
  expectRepaired(kinds(mixed.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]), `a real command failure beside a timeout was recorded as infrastructure (${kinds(mixed.history())}; evidence ${mixed.evidence()?.failureKind})`);
  mixed.admit();
  const mixedRetry = mixed.runWith('pass');
  expectRepaired(mixedRetry.status !== 0 && mixedRetry.text.includes('verdict_flip_refused') && mixed.evidence()?.result !== 'PASS', 'a timeout beside a real failure exempted the retry from stickiness');
  // An infrastructure-only timeout is classified alike in the evidence and
  // in the terminal, and the unchanged inputs may recover.
  const timeoutOnly = seedCommands('timeout-only');
  const timeoutRun = timeoutOnly.runWith('timeout');
  check(timeoutRun.status !== 0 && timeoutOnly.evidence()?.failureKind === 'infra_failure', `control: a timeout alone is an infrastructure failure in the evidence (${timeoutRun.text.slice(0, 300)})`);
  expectRepaired(kinds(timeoutOnly.history()) === JSON.stringify([['fail', 'executed', 'infra_failure']]), `the terminal and the evidence disagree about an infrastructure-only timeout (${kinds(timeoutOnly.history())})`);
  timeoutOnly.admit();
  const timeoutRetry = timeoutOnly.runWith('pass');
  check(timeoutRetry.status === 0 && timeoutOnly.evidence()?.result === 'PASS', `control: unchanged inputs recover after an infrastructure-only timeout (${timeoutRetry.text.slice(0, 400)})`);

  // Audit 4: a coverage gap beside a failed OPTIONAL command. The record is not
  // reusable, so recovery is a fresh execution - which must not be refused as a
  // flip, because no required command ever failed. Coverage is completed by a
  // permanent waiver, which leaves the routine identity unchanged.
  const optionalGap = seed('optional-gap', '', 'must', (root) => {
    rmSync(join(root, 'validate.ts'));
    writeFileSync(join(root, 'required.cjs'), 'process.exit(0);\n');
    writeFileSync(join(root, 'optional.cjs'), 'process.exit(1);\n');
    const config = JSON.parse(readFileSync(join(root, 'proof-or-stop.config.json'), 'utf8'));
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ ...config, validate: { commands: [{ command: 'node', args: ['required.cjs'] }, { command: 'node', args: ['optional.cjs'], optional: true }] } }, null, 2));
  });
  const gapRun = optionalGap.runCli();
  const gapEvidence = optionalGap.evidence();
  check(gapRun.status !== 0 && gapEvidence?.result === 'FAIL' && gapEvidence?.commandExecution?.status === 'PASS' && gapEvidence?.commandExecution?.optionalFailureCount === 1 && gapEvidence?.verificationCoverage?.missingRequired === 1,
    `control: required commands pass, an optional one fails, required coverage is missing (${gapRun.text.slice(0, 300)})`);
  expectRepaired(kinds(optionalGap.history()) === JSON.stringify([['fail', 'executed', 'coverage_incomplete']]), `a coverage gap beside a failed optional command was recorded as a verdict (${kinds(optionalGap.history())})`);
  const gapIdentity = gapEvidence?.routineValidationIdentity?.digest;
  const gapChecklist = optionalGap.store.readChecklist(optionalGap.storyId);
  gapChecklist.items[0].verificationEvidence = [{ intentRef: 'CHK-001:happy:0', kind: 'waiver', waiverType: 'permanent', result: 'pass', note: 'Fixture waiver: the intent is covered by agreement for this regression, not by a command.' }];
  optionalGap.store.writeChecklist(optionalGap.storyId, gapChecklist);
  optionalGap.git(['add', '.proof-or-stop']); optionalGap.git(['commit', '-qm', 'waive the required intent']);
  optionalGap.admit();
  const gapRecovery = optionalGap.runCli();
  check(optionalGap.evidence()?.routineValidationIdentity?.digest === gapIdentity && optionalGap.evidence()?.disposition === 'executed',
    `control: the recovery is a fresh execution on the unchanged identity (${optionalGap.evidence()?.disposition} ${kinds(optionalGap.history())})`);
  expectRepaired(gapRecovery.status === 0 && optionalGap.evidence()?.result === 'PASS' && !gapRecovery.text.includes('verdict_flip_refused'),
    `a coverage gap beside a failed optional command permanently refused the recovery (${gapRecovery.text.slice(0, 400)})`);

  // Audit 4: a run whose routine identity cannot be built is refused BEFORE it
  // launches. Executing it would record a failure under a digest no later
  // identity matches, so an unchanged retry would not be recognised as one.
  // Every Story run builds its identity through this one function before it
  // executes anything; a transient snapshot error is injected into it.
  const { buildStoryRoutineIdentity } = await import('../packages/main/src/handlers/verifier.ts');
  const unbound = seed('unbound', flaky());
  expectRepaired(typeof buildStoryRoutineIdentity === 'function', 'the routine identity builder cannot be exercised');
  if (typeof buildStoryRoutineIdentity === 'function') {
    const transientStore = new Proxy(unbound.store, { get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return prop === 'readChecklist' ? () => { throw new Error('transient snapshot error'); } : value.bind(target);
    } });
    const build = (store) => buildStoryRoutineIdentity({ ctx: { root: unbound.root, store, scanRoot: unbound.root }, storyId: unbound.storyId, sourceKind: 'no-validator', commands: [] });
    let refusal = '', unbuilt;
    try { unbuilt = build(transientStore); } catch (error) { refusal = String(error?.message ?? error); }
    expectRepaired(unbuilt === undefined && refusal.includes('[validation_identity_unavailable]') && refusal.includes('transient snapshot error'),
      `an identity that could not be built was handed to the caller as ${JSON.stringify(unbuilt)} instead of refusing the run (${refusal.slice(0, 200) || 'no refusal'})`);
    check(/^[a-f0-9]{64}$/.test(build(unbound.store)?.identity?.digest ?? ''), 'control: the same inputs build an identity once the snapshot can be read');
  }
  writeFileSync(switchPath, 'pass\n');
  const afterUnbound = unbound.runCli();
  check(afterUnbound.status === 0 && unbound.evidence()?.result === 'PASS', `control: the unchanged inputs validate once the identity can be built (${afterUnbound.text.slice(0, 300)})`);

  // Audit 6: the material and the story files are identified BEFORE launch and
  // kept with the identity; a lookup that fails only after the commands ran
  // falls back to them, so an executed verdict is recorded, never dropped.
  const verifierModule = await import('../packages/main/src/handlers/verifier.ts');
  expectRepaired(typeof verifierModule.preLaunchBindingsFor === 'function' && typeof verifierModule.publicationBindings === 'function', 'nothing is bound before launch');
  if (typeof verifierModule.preLaunchBindingsFor === 'function' && typeof verifierModule.publicationBindings === 'function') {
    const boundRun = verifierModule.buildStoryRoutineIdentity({ ctx: { root: unbound.root, store: unbound.store, scanRoot: unbound.root }, storyId: unbound.storyId, sourceKind: 'no-validator', commands: [] });
    const before = verifierModule.preLaunchBindingsFor(boundRun.identity);
    expectRepaired(before?.materialHash === currentMaterialHash(unbound.root, 'HEAD', unbound.root) && before?.storyFilesHash === currentStoryFilesHash(unbound.root, 'HEAD', unbound.root) && /^[a-f0-9]{64}$/.test(before?.materialHash ?? ''),
      `a run was not bound to its material and story files before launch (${JSON.stringify(before)})`);
    const lost = verifierModule.publicationBindings({ materialHash: undefined, storyFilesHash: undefined }, before);
    expectRepaired(lost.materialHash === before?.materialHash && lost.storyFilesHash === before?.storyFilesHash, 'a lookup that failed after the commands ran left the publication unbound');
    const fresh = verifierModule.publicationBindings({ materialHash: H('e'), storyFilesHash: H('f') }, before);
    check(fresh.materialHash === H('e') && fresh.storyFilesHash === H('f'), 'control: a publication lookup that succeeds is what the record binds');
    check(verifierModule.publicationBindings({}, undefined).materialHash === undefined, 'control: a run that was never bound stays unbound and is refused');
  }

  // Audit 6: a validate file that fails and prints a provider result that does
  // not parse is a recorded validation failure, not an exception that leaves
  // the run without a record; the valid PASS it prints next is a flipped verdict.
  const malformed = seed('malformed', `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nif (verdict === 'pass') { console.log(JSON.stringify({ provider: 'flaky-fixture', status: 'pass', allPass: true, summary: 'pass', details: [], warnings: [] })); process.exit(0); }\nconsole.log('{"provider":"flaky-fixture","status":fail}');\nprocess.exit(1);\n`);
  writeFileSync(switchPath, 'fail\n');
  const malformedRun = malformed.runCli();
  check(malformedRun.status !== 0, `control: malformed failing output fails the run (${malformedRun.text.slice(0, 300)})`);
  expectRepaired(kinds(malformed.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]) && malformed.evidence()?.result === 'FAIL',
    `a failing run with malformed validator output left no record (${kinds(malformed.history())} evidence=${malformed.evidence()?.result}; ${malformedRun.text.slice(0, 300)})`);
  malformed.admit();
  writeFileSync(switchPath, 'pass\n');
  const malformedRetry = malformed.runCli();
  expectRepaired(malformedRetry.status !== 0 && malformedRetry.text.includes('verdict_flip_refused') && malformed.evidence()?.result !== 'PASS', 'malformed failing output exempted the retry from stickiness');

  // Audit 5: the terminal records exactly the identity its publication
  // validated. Here nothing it could look up exists - the context has no
  // repository at all - and the bindings are not the fixture's own, so any
  // second lookup would show as an empty or a different hash.
  const { recordValidationTerminal } = await import('../packages/main/src/handlers/verifier.ts');
  expectRepaired(typeof recordValidationTerminal === 'function', 'the terminal writer cannot be exercised');
  if (typeof recordValidationTerminal === 'function') {
    const validated = { commandSetHash: H('a'), materialHash: H('b'), storyFilesHash: H('c'), buildArtifactsHash: H('d') };
    let written = false;
    try { written = Boolean(recordValidationTerminal({ root: join(cliSandbox, 'no-repository'), store: unbound.store, scanRoot: join(cliSandbox, 'no-repository') }, unbound.storyId, { status: 'fail', allPass: false, failureKind: 'validation_failure', disposition: 'executed', commandExecutions: 1 }, validated)); } catch { written = false; }
    const lastTerminal = 'terminals' in unbound.history() ? unbound.history().terminals.at(-1) : undefined;
    expectRepaired(written && Object.entries(validated).every(([key, value]) => lastTerminal?.[key] === value) && lastTerminal?.result === 'fail' && lastTerminal?.failureKind === 'validation_failure',
      `the terminal did not record the identity its publication validated (${JSON.stringify(lastTerminal)})`);
    check(stickiness.stickyFailuresFor(validated, unbound.history().terminals ?? []).length === 1, 'control: that failure is matched by exactly the validated identity');
  }

  // Audit 4: a plain-text validate-file run is a dry run. It publishes neither
  // evidence nor terminal, so its PASS is evidence nowhere and nothing flips.
  const dryRun = seed('dry-run', flaky());
  const runText = () => spawnSync(process.execPath, [cli, 'validate', `--story=${dryRun.storyId}`], { cwd: dryRun.root, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: dryRun.root, PROOF_OR_STOP_SESSION_ID: 'verdict-stickiness', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', npm_config_yes: 'true', STICKINESS_SWITCH: switchPath } });
  writeFileSync(switchPath, 'fail\n'); const textFail = runText();
  dryRun.admit();
  writeFileSync(switchPath, 'pass\n'); const textPass = runText();
  check(textFail.status !== 0 && textPass.status === 0 && dryRun.evidence() === null && kinds(dryRun.history()) === '[]',
    `control: a plain-text run reports its verdict and publishes nothing, PASS included (fail=${textFail.status} pass=${textPass.status} evidence=${dryRun.evidence()?.result} ${kinds(dryRun.history())} ${`${textPass.stdout}${textPass.stderr}`.slice(0, 300)})`);

  // Audit 2: a flipped verdict laundered through a coverage-only FAIL. The
  // stored record says the commands passed and only coverage was missing; the
  // history says an executed run FAILED on that identity. Coverage is complete
  // now, so before the repair the evaluator republished the record as a PASS.
  // The record is a trusted fixture, re-signed the way the reuse smoke does it.
  const { signTestValidationEvidence: signEvidence } = await import('../packages/main/src/core/validation-artifact-signing.ts');
  const launder = (name, failureKind) => {
    const fixture = seed(name, flaky());
    writeFileSync(switchPath, 'pass\n');
    const earned = fixture.runCli();
    const pass = fixture.evidence();
    check(earned.status === 0 && pass?.result === 'PASS', `control: ${name} earns a PASS first (${earned.text.slice(0, 200)})`);
    fixture.store.writeTestEvidence(fixture.storyId, signEvidence(fixture.storyId, { ...pass, result: 'FAIL', failureKind: 'validation_failure', verificationCoverage: { ...pass.verificationCoverage, required: 1, missingRequired: 1 } }, fixture.root));
    fixture.store.appendProcessEvent(fixture.storyId, { ...terminal({ storyId: fixture.storyId, failureKind, commandSetHash: pass.routineValidationIdentity.digest, materialHash: pass.materialHash, storyFilesHash: pass.storyFilesHash, buildArtifactsHash: pass.buildArtifactsHash }), timestamp: undefined });
    fixture.git(['add', '.proof-or-stop']); fixture.git(['commit', '-qm', 'record a coverage-only failure and the failure history']);
    fixture.admit();
    return { fixture, run: fixture.runCli() };
  };
  const recovered = launder('recovered', 'coverage_incomplete');
  check(recovered.run.status === 0 && recovered.fixture.evidence()?.result === 'PASS' && recovered.fixture.evidence()?.disposition === 'reused',
    `control: a genuine coverage-only failure still recovers by reuse once coverage is complete (${recovered.run.text.slice(0, 400)})`);
  const laundered = launder('laundered', 'validation_failure');
  expectRepaired(laundered.run.status !== 0 && laundered.fixture.evidence()?.result !== 'PASS',
    `a failed identity was republished as a PASS through a coverage-only record (exit=${laundered.run.status} evidence=${laundered.fixture.evidence()?.result}/${laundered.fixture.evidence()?.disposition})`);
  expectRepaired(laundered.run.text.includes('verdict_flip_refused') || laundered.run.text.includes('verdict-flip-unattested'), `the laundered retry's output does not name the refusal (${laundered.run.text.slice(0, 400)})`);
} finally {
  rmSync(cliSandbox, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. Source guards: the producer records the failure kind and both consumers
//    read the Story's terminals.
// ---------------------------------------------------------------------------
const verifierSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
const terminalStart = verifierSource.indexOf("type: 'validation_terminal',");
expectRepaired(terminalStart >= 0 && verifierSource.slice(terminalStart, terminalStart + 2200).includes('failureKind'), 'validation_terminal events do not record the failure kind, so an infrastructure failure cannot be told from a verdict (source-text guard)');
expectRepaired(verifierSource.includes('validationHistory: readValidationHistory(args.ctx.store, args.storyId)'), 'the routine reuse path does not hand the Story history to the evaluator (source-text guard)');
const admissionHandler = readFileSync(join(repoRoot, 'packages/main/src/handlers/validation-pass-admissibility.ts'), 'utf8');
expectRepaired(admissionHandler.includes('validationHistory: readValidationHistory(ctx.store, storyId)'), 'the DONE-side admissibility handler does not hand the Story history to the evaluator (source-text guard)');
// Audit: the flip is refused where the PASS would be published, and the
// validate-file path never trusts a child-printed failure kind.
expectRepaired((verifierSource.match(/passPublicationRefusal\(/g) ?? []).length === 2,
  'the executed and the reused publication do not both read the shared publication refusal (source-text guard)');
// Audit 3: every executed PASS asks, with whatever identity it has; a missing
// identity is the refusal's business, never a reason not to ask.
expectRepaired(/if \(allPass\) \{\s+const flipRefusal = passPublicationRefusal\(/.test(verifierSource) && verifierSource.includes('verdictIdentityFromParts({ commandSetHash: identity.digest, ...hashes })') && !/if \(allPass && identity/.test(verifierSource),
  'the executed publication asks the shared refusal only when it already has an identity (source-text guard)');
expectRepaired(verifierSource.includes('failureKind: classifyValidationTerminalFailure({'), 'the executed terminal kind is not derived from the command outcomes (source-text guard)');
// Audit 6: the publication binds through the pre-launch fallback.
expectRepaired(verifierSource.includes('}, preLaunchBindings.get(identity)),') && verifierSource.includes('preLaunchBindings.set(identity, { materialHash, storyFilesHash });'),
  'the publication does not fall back to what the run was bound to before launch (source-text guard)');
// Audit 5: every publication is bound as completely as a PASS, and the
// terminal writer takes that identity instead of looking anything up again.
const writerStart = verifierSource.indexOf('export function recordValidationTerminal(');
const writerSource = writerStart >= 0 ? verifierSource.slice(writerStart, verifierSource.indexOf('\n}\n', writerStart)) : '';
expectRepaired(writerSource.length > 0 && !/currentMaterialHash\(|currentStoryFilesHash\(|currentBuildArtifactsHash\(/.test(writerSource) && writerSource.includes('materialHash: bindings.materialHash'),
  'the terminal writer still looks its bindings up a second time (source-text guard)');
expectRepaired(/if \(!verdictIdentity\) \{\s+return persistenceFailure\(/.test(verifierSource), 'a failure can still be published without its full identity (source-text guard)');
// Audit 4: a terminal's command set is the routine identity digest, never a
// differently built fallback that no later identity could match.
expectRepaired(!verifierSource.includes('commandSetHash: identity?.digest ??') && (verifierSource.includes('commandSetHash: identity.digest,') || verifierSource.includes('commandSetHash: bindings.commandSetHash,')), 'a terminal can still record a fallback command-set digest (source-text guard)');
expectRepaired(verifierSource.includes('failureKind: _printedKind, ...rest }') && verifierSource.includes("failureKind: validation.failureKind ?? 'validation_failure'"),
  'the validate-file path still trusts a child-printed failureKind (source-text guard)');

// ---------------------------------------------------------------------------
// 6. done_prepare must still trust the terminal the verifier writes for a
//    reused PASS. The compiled-artifact identity and its protection label are
//    on every terminal since the artifact binding landed; the trust allowlist
//    had not followed, so a done_prepare that reused validation refused its
//    own appended terminal as an untrusted process-events delta.
// ---------------------------------------------------------------------------
const metadata = await import('../packages/main/src/core/done-prepare-generated-metadata.ts');
if (typeof metadata.isTrustedReusedValidationTerminal === 'function') {
  const expected = { storyId: 'B-stk', attemptId: 'r1', reviewRound: 'r1', commandSetHash: H('1'), materialHash: H('2'), storyFilesHash: H('3'), phase: 'TEST', disposition: 'reused', result: 'pass', commandExecutions: 0, notBefore: '2026-09-20T00:00:00.000Z', notAfter: '2026-09-21T00:00:00.000Z' };
  // Exactly what recordValidationTerminal writes for a reused PASS today.
  const reusedTerminal = { type: 'validation_terminal', storyId: 'B-stk', attemptId: 'r1', phase: 'TEST', reviewRound: 'r1', commandSetHash: H('1'), disposition: 'reused', commandExecutions: 0, result: 'pass', materialHash: H('2'), storyFilesHash: H('3'), buildArtifactsHash: H('4'), buildArtifactsProtection: 'enforced:sandbox-exec', timestamp: '2026-09-20T12:00:00.000Z' };
  expectRepaired(metadata.isTrustedReusedValidationTerminal(reusedTerminal, expected) === true, 'done_prepare refuses the reused validation terminal the verifier itself writes (compiled-artifact identity and protection are not in its trust allowlist)');
  check(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, forged: true }, expected) === false, 'control: a terminal with an unknown key is not trusted');
  check(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, failureKind: 'validation_failure' }, expected) === false, 'control: a reused terminal never carries a failure kind; one that does is not trusted');
  check(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, result: 'fail' }, expected) === false, 'control: the binding fixes the reused result');
  // Audit: the artifact fields are typed and bound, never merely permitted.
  expectRepaired(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, buildArtifactsHash: { forged: true } }, expected) === false, 'an object-valued compiled-artifact hash was trusted');
  expectRepaired(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, buildArtifactsProtection: 7 }, expected) === false, 'a numeric protection label was trusted');
  expectRepaired(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, buildArtifactsProtection: 'unenforced:none' }, expected) === false, 'an unenforced protection label was trusted on a reused terminal');
  const bound = { ...expected, buildArtifactsHash: H('4'), buildArtifactsProtection: 'enforced:sandbox-exec' };
  check(metadata.isTrustedReusedValidationTerminal(reusedTerminal, bound) === true, 'control: a terminal carrying exactly the bound artifact identity and protection is trusted');
  expectRepaired(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, buildArtifactsHash: H('5') }, bound) === false, 'a terminal whose compiled-artifact hash differs from the reused evidence was trusted');
  expectRepaired(metadata.isTrustedReusedValidationTerminal({ ...reusedTerminal, buildArtifactsProtection: 'enforced:bwrap' }, bound) === false, 'a terminal whose protection label differs from the reused evidence was trusted');
} else {
  expectRepaired(false, 'done-prepare-generated-metadata does not expose the reused-terminal trust decision');
}

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-verdict-stickiness: ${checks} checks passed`);
