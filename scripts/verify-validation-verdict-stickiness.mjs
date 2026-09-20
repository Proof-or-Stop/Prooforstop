// Lab validation-verdict-stickiness: a validation PASS earned on an identity
// (command set, committed material, story files, compiled artifacts) that an
// earlier or later EXECUTED run FAILED on is not fresh evidence. Nothing
// changed and the verdict flipped, so the failure stands until the material or
// the build changes; an infrastructure failure (timeout, refused launch) is not
// a verdict and does not stick. RED marker: stale verdict admitted after a failure on the same identity
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    validationTerminals: terminals,
  });
  const admit = (terminals) => evaluateValidationEvidenceAdmissibility({
    evidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    validationTerminals: terminals,
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
    validationTerminals: [failed],
  });
  check(failedReuse.reusable === false && !failedReuse.refusalReasons.includes('verdict-flip-unattested'),
    `control: a record of a failed execution refuses on its own terms, without the flip reason (${failedReuse.refusalReasons.join(',')})`);
  const failedAdmit = evaluateValidationEvidenceAdmissibility({
    evidence: { ...evidence, result: 'FAIL' }, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    validationTerminals: [failed],
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

  // -------------------------------------------------------------------------
  // 4. The report groups the fixture's terminals by full identity.
  // -------------------------------------------------------------------------
  const report = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/report-validation-verdict-flips.mjs'), '--root', root, '--json'], { encoding: 'utf8' }));
  check(report.terminals === 2 && report.identities === 1, `report must see the two executed terminals as one identity (${JSON.stringify(report)})`);
  check(report.flippedIdentities === 0, 'report: an infrastructure failure plus a validation failure is not a pass/fail flip');
  store.appendProcessEvent(storyId, { ...terminal({ ...real, storyId, result: 'pass' }), timestamp: undefined });
  const flipped = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/report-validation-verdict-flips.mjs'), '--root', root, '--json'], { encoding: 'utf8' }));
  check(flipped.flippedIdentities === 1 && flipped.redundantExecutions === 2, `report must count the flip and the re-executions (${JSON.stringify(flipped)})`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. Source guards: the producer records the failure kind and both consumers
//    read the Story's terminals.
// ---------------------------------------------------------------------------
const verifierSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
const terminalStart = verifierSource.indexOf("type: 'validation_terminal',");
expectRepaired(terminalStart >= 0 && verifierSource.slice(terminalStart, terminalStart + 2200).includes('failureKind'), 'validation_terminal events do not record the failure kind, so an infrastructure failure cannot be told from a verdict (source-text guard)');
expectRepaired(verifierSource.includes('validationTerminals: readValidationTerminals(args.ctx.store, args.storyId)'), 'the routine reuse path does not hand the Story terminals to the evaluator (source-text guard)');
const admissionHandler = readFileSync(join(repoRoot, 'packages/main/src/handlers/validation-pass-admissibility.ts'), 'utf8');
expectRepaired(admissionHandler.includes('validationTerminals: readValidationTerminals(ctx.store, storyId)'), 'the DONE-side admissibility handler does not hand the Story terminals to the evaluator (source-text guard)');

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
} else {
  expectRepaired(false, 'done-prepare-generated-metadata does not expose the reused-terminal trust decision');
}

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-verdict-stickiness: ${checks} checks passed`);
