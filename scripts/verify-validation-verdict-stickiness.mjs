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
    // Audit 9: the dynamic-authority callers pass their AGGREGATE verdict in
    // the semantic parameter. It only repeats the command outcomes, so it
    // cannot turn an infrastructure-only run into a verdict; an independent
    // semantic rejection - what a validate file printed - still does.
    expectRepaired(classify([timedOut], { semanticCommandPass: false, semanticIsAggregate: true }) === 'infra_failure', 'an aggregate verdict turned an infrastructure-only dynamic run into a verdict about the code');
    check(classify([timedOut], { semanticCommandPass: false }) === 'validation_failure', 'control: an independent semantic rejection beside a timeout is still a verdict');
    check(classify([timedOut, broke], { semanticCommandPass: false, semanticIsAggregate: true }) === 'validation_failure' && classify([], { semanticCommandPass: false, semanticIsAggregate: true }) === 'validation_failure',
      'control: an aggregate failure with a real command failure, or with no failed command to explain it, is a verdict');
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
  // Audit 7: a copy is the same line of the SAME Story. An identical line in
  // another Story's directory - legacy lines carry no storyId - is that
  // Story's own event; the checkout and worktree copies of one Story are one.
  const storyLessLine = (extra = {}) => { const { storyId: _none, ...rest } = terminal({ ...real, materialHash: H('7'), ...extra }); return JSON.stringify(rest); };
  const eventsFile = (...segments) => { const dir = join(root, ...segments); mkdirSync(dir, { recursive: true }); return join(dir, 'process-events.jsonl'); };
  writeFileSync(eventsFile('.proof-or-stop/story/actives', 'B-dup-a'), `${storyLessLine()}\n`);
  writeFileSync(eventsFile('.proof-or-stop/story/actives', 'B-dup-b'), `${storyLessLine()}\n`);
  const twoDirectories = runReport();
  expectRepaired(twoDirectories.terminals === coverageOnlyReport.terminals + 2 && twoDirectories.identities === coverageOnlyReport.identities + 2,
    `identical lines in two Story directories were counted as one event (${coverageOnlyReport.terminals} -> ${twoDirectories.terminals} terminals, ${coverageOnlyReport.identities} -> ${twoDirectories.identities} identities)`);
  writeFileSync(eventsFile('.worktrees/B-dup-a/.proof-or-stop/story/actives', 'B-dup-a'), `${storyLessLine()}\n${storyLessLine({ result: 'pass', failureKind: undefined })}\n`);
  const withWorktreeCopy = runReport();
  check(withWorktreeCopy.terminals === twoDirectories.terminals + 1 && withWorktreeCopy.identities === twoDirectories.identities && withWorktreeCopy.flippedIdentities === twoDirectories.flippedIdentities + 1,
    `control: a Story's worktree copy continues its checkout copy instead of repeating it (${JSON.stringify({ before: twoDirectories.terminals, after: withWorktreeCopy.terminals, flipped: withWorktreeCopy.flippedIdentities })})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}


// ---------------------------------------------------------------------------
// 4b. The end-to-end runs through the built CLI are their own registered
//     command, scripts/verify-validation-verdict-stickiness-cli.mjs: forty
//     fixture runs of the CLI do not fit beside this script in one budget.
// ---------------------------------------------------------------------------
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
// Audit 9: the end-to-end regression executes the compiled CLI, so it reserves
// that tree and cannot be scheduled beside a command that rebuilds or replaces it.
// Only the compiled-tree claim of that command is compared: another shared
// claim must not be what makes the two conflict.
const registeredCommands = JSON.parse(readFileSync(join(repoRoot, 'proof-or-stop.config.json'), 'utf8')).validate.commands;
const ownCommand = registeredCommands.find((command) => Array.isArray(command?.args) && command.args[0] === 'scripts/verify-validation-verdict-stickiness-cli.mjs');
const rebuildCommand = registeredCommands.find((command) => Array.isArray(command?.resources) && command.resources.some((claim) => claim.class === 'fixed-path' && claim.key === 'packages/main/dist' && claim.access === 'exclusive'));
check(Boolean(ownCommand) && Boolean(rebuildCommand), 'control: the end-to-end regression and a command that holds packages/main/dist exclusively are both registered');
const scheduler = await import('../packages/main/src/core/keyed-scheduler.ts');
const [ownEntry, rebuildEntry] = scheduler.canonicalizeEntries([{ name: 'regression', resources: ownCommand.resources ?? [] }, { name: 'rebuild', resources: rebuildCommand.resources.filter((claim) => claim.class === 'fixed-path' && claim.key === 'packages/main/dist') }], repoRoot);
expectRepaired(scheduler.claimsConflict(ownEntry, rebuildEntry) === true, 'the end-to-end regression executes packages/main/dist/cli.js without reserving that tree, so it may run beside a rebuild of it');
// Audit 9 and 10: only a validate file prints an independent semantic verdict,
// and which one the semantic argument is comes from the caller through a
// registry of result objects, never from a field a validate file can print.
expectRepaired(verifierSource.includes('aggregateVerdictResults.has(result),') && (verifierSource.match(/aggregateVerdictResults\.add\(authoritative\);/g) ?? []).length === 2
  && !/semanticIsAggregate:\s*result\??\.dynamicValidation/.test(verifierSource) && verifierSource.includes('dynamicValidation: _printedDynamic, ...rest }'),
  'the origin of the semantic verdict is read from the result a validate file can shape (source-text guard)');
// Audit 10 and the finish-time audit: what marks an ATTEMPT at a structured
// provider result. JSON lets a key be written with escapes, so the literal
// text "provider" proves nothing; an attempt is marked by the protocol's own
// key names in the parsed object, or - where the output does not parse or is
// truncated before its closing brace - in its text with the escapes decoded.
// An attempt that cannot be used is a recorded failure, never plain text that
// passes on exit code zero. The key "status" alone marks nothing.
const verifierModule = await import('../packages/main/src/handlers/verifier.ts');
expectRepaired(typeof verifierModule.structuredValidatorCandidate === 'function' && typeof verifierModule.normalizeValidatorResult === 'function', 'a structured validator result is still recognized by a literal key');
if (typeof verifierModule.structuredValidatorCandidate === 'function' && typeof verifierModule.normalizeValidatorResult === 'function') {
  const candidate = verifierModule.structuredValidatorCandidate;
  const failsWhenNormalized = (text) => { const span = candidate(text); return span !== null && verifierModule.normalizeValidatorResult(span[0], text).status === 'fail'; };
  expectRepaired(failsWhenNormalized('{"\\u0070rovider":"fixture","status":"fail","allPass":false}') && failsWhenNormalized('{"\\u0070rovider":"fixture","status":fail}'), 'a result whose provider key is written with an escape was read as plain text');
  expectRepaired(failsWhenNormalized('{"provider":"fixture","status":"fail","allPass":false'), 'a provider result truncated before its closing brace was read as plain text');
  expectRepaired(failsWhenNormalized('{"status":fail,"allPass":false}') && failsWhenNormalized('log\n{"status":"fail","allPassed":false}'), 'a result that names allPass or allPassed but no provider was read as plain text');
  const usableSpan = candidate('log line\n{"provider":"fixture","status":"pass","allPass":true}\n');
  check(usableSpan !== null && verifierModule.normalizeValidatorResult(usableSpan[0]).status === 'pass', 'control: a usable provider result after a log line is recognized and passes through');
  check(candidate('all 12 tests passed') === null && candidate('{ debug } done') === null && candidate('[1,2]') === null, 'control: plain text, braces in a log line and a non-object are not structured attempts');
  // An earlier repair in this Lab also took "status" for a marker, which would
  // have failed every plain-text validate file whose log prints a JSON object.
  expectRepaired(candidate('GET /health -> {"status":"ok"}\nall tests passed') === null && candidate('{"status":fail}') === null,
    'ordinary output that prints a status was read as a failed attempt at a structured result; the key "status" alone marks nothing');
}
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
expectRepaired(/failureKind: _printedKind,[^}]*\.\.\.rest \}/.test(verifierSource) && verifierSource.includes("failureKind: validation.failureKind ?? 'validation_failure'"),
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
