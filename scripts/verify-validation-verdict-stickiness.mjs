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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    check(refusal({ terminals: [terminal()] }, null) === null && stickiness.verdictIdentityFromParts({ ...identityA, buildArtifactsHash: 'short' }) === null, 'control: an identity with a missing or malformed part is never matched');
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
  const seed = (name, validateTs, priority = 'should') => {
    const root = join(cliSandbox, name); mkdirSync(root);
    const storyId = 'B-stk-cli';
    const git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\nnode_modules\ndist\n');
    writeFileSync(join(root, 'source.ts'), 'export const stickiness = true;\n');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'light' } }, null, 2));
    writeFileSync(join(root, 'validate.ts'), validateTs);
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
