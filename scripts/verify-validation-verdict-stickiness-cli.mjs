// Lab validation-verdict-stickiness, end to end through the built CLI. The rule,
// its core consumers, the report and the source guards are in
// scripts/verify-validation-verdict-stickiness.mjs; this script runs the CLI on
// disposable fixture projects. A validation PASS earned on an identity
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
    const runCli = (extraEnv = {}) => {
      const r = spawnSync(process.execPath, [cli, 'validate', `--story=${storyId}`, '--json'], {
        cwd: root, encoding: 'utf8', timeout: 300_000,
        env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_SESSION_ID: 'verdict-stickiness', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', npm_config_yes: 'true', STICKINESS_SWITCH: switchPath, ...extraEnv },
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

  // Audit 7: a provider result that parses but whose fields are not of the
  // types the pipeline coerces - String() of {toString: null} throws - is as
  // unusable as one that does not parse. Normalization never throws.
  expectRepaired(typeof verifierModule.normalizeValidatorResult === 'function', 'the validator result is not normalized before it is coerced');
  if (typeof verifierModule.normalizeValidatorResult === 'function') {
    const normalize = (value) => { try { return verifierModule.normalizeValidatorResult(typeof value === 'string' ? value : JSON.stringify(value)); } catch (error) { return { threw: String(error) }; } };
    const unusable = [
      { provider: 'fixture', status: { toString: null }, allPass: false }, { provider: 'fixture', status: 'pass', allPass: 'yes' }, { provider: 'fixture', status: 'pass', allPassed: 1 },
      { provider: 'fixture', status: 'pass', summary: { toString: null } }, { provider: 'fixture', status: 'pass', details: 'not-a-list' }, { provider: 7, status: 'pass' }, { provider: '  ', status: 'pass' }, { provider: { name: 'fixture' }, status: 'pass' }, ['fixture'], '{"provider":"fixture","status":fail}',
    ];
    expectRepaired(unusable.every((value) => { const result = normalize(value); return !result.threw && result.status === 'fail' && result.allPass === false && result.provider === 'proof-or-stop-verifier-malformed-validator-output'; }),
      `an unusable provider result was not turned into a validation failure (${JSON.stringify(unusable.map(normalize).map((r) => r.threw ?? r.status))})`);
    const usable = normalize({ provider: 'fixture', status: 'pass', allPass: true, summary: 'ok', details: ['a', { toString: null }, 3], warnings: [] });
    check(usable.status === 'pass' && usable.allPass === true && usable.provider === 'fixture' && JSON.stringify(usable.details) === JSON.stringify(['a', '{"toString":null}', '3']), `control: a usable result passes through, with list entries made strings (${JSON.stringify(usable)})`);
  }
  // Audit 8: normalization is total. A details entry nested thousands of
  // levels deep parses, and overflows the stack when it is serialized again.
  const deepText = (levels) => `{"provider":"flaky-fixture","status":"fail","allPass":false,"details":[{"toJSON":null,"v":${'['.repeat(levels)}${']'.repeat(levels)}}]}`;
  if (typeof verifierModule.normalizeValidatorResult === 'function') {
    let deepResult; try { deepResult = verifierModule.normalizeValidatorResult(deepText(8000)); } catch (error) { deepResult = { threw: String(error) }; }
    expectRepaired(!deepResult.threw && deepResult.status === 'fail' && deepResult.provider === 'proof-or-stop-verifier-malformed-validator-output', `a deeply nested provider result threw out of normalization (${String(deepResult.threw ?? deepResult.provider).slice(0, 120)})`);
    let deepElsewhere; try { deepElsewhere = verifierModule.normalizeValidatorResult(`{"provider":"flaky-fixture","status":"pass","allPass":true,"extra":${'['.repeat(8000)}${']'.repeat(8000)}}`); } catch (error) { deepElsewhere = { threw: String(error) }; }
    expectRepaired(!deepElsewhere.threw && deepElsewhere.status === 'fail', 'a provider result nested too deeply outside its lists was accepted, to overflow when it is persisted');
    const shallow = verifierModule.normalizeValidatorResult(`{"provider":"flaky-fixture","status":"pass","allPass":true,"extra":${'['.repeat(40)}${']'.repeat(40)}}`);
    check(shallow.status === 'pass' && shallow.provider === 'flaky-fixture', 'control: ordinary nesting is a usable result');
  }
  const deeplyNested = seed('deeply-nested', `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nif (verdict === 'pass') { console.log(JSON.stringify({ provider: 'flaky-fixture', status: 'pass', allPass: true, summary: 'pass', details: [], warnings: [] })); process.exit(0); }\nconsole.log('{"provider":"flaky-fixture","status":"fail","allPass":false,"details":[{"toJSON":null,"v":' + '['.repeat(8000) + ']'.repeat(8000) + '}]}');\nprocess.exit(1);\n`);
  writeFileSync(switchPath, 'fail\n');
  const deepRun = deeplyNested.runCli();
  check(deepRun.status !== 0, `control: a failing run with deeply nested output fails (${deepRun.text.slice(0, 200)})`);
  expectRepaired(kinds(deeplyNested.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]) && deeplyNested.evidence()?.result === 'FAIL',
    `a failing run with deeply nested validator output left no record (${kinds(deeplyNested.history())} evidence=${deeplyNested.evidence()?.result}; ${deepRun.text.slice(0, 200)})`);
  deeplyNested.admit();
  writeFileSync(switchPath, 'pass\n');
  const deepRetry = deeplyNested.runCli();
  expectRepaired(deepRetry.status !== 0 && deepRetry.text.includes('verdict_flip_refused') && deeplyNested.evidence()?.result !== 'PASS', 'deeply nested failing output exempted the retry from stickiness');

  // Audit 9: a structured candidate is one that names a provider, whatever
  // value it gives it. A printed FAILURE with exit code zero and a numeric,
  // empty or object-valued provider used to fall through to the exit-code
  // wrapper and publish a PASS.
  const providerFixture = (name, providerJson) => seed(name, `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nif (verdict === 'pass') { console.log(JSON.stringify({ provider: 'flaky-fixture', status: 'pass', allPass: true, summary: 'pass', details: [], warnings: [] })); process.exit(0); }\nconsole.log('{"provider":${providerJson},"status":"fail","allPass":false}');\nprocess.exit(0);\n`);
  let numericProvider;
  for (const [name, providerJson] of [['provider-number', '7'], ['provider-empty', '""'], ['provider-object', '{"name":"fixture"}']]) {
    const fixture = providerFixture(name, providerJson);
    writeFileSync(switchPath, 'fail\n');
    const run = fixture.runCli();
    expectRepaired(run.status !== 0 && fixture.evidence()?.result === 'FAIL' && kinds(fixture.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]),
      `a printed failure with exit code zero and provider ${providerJson} was not recorded as a validation failure (exit=${run.status} evidence=${fixture.evidence()?.result} ${kinds(fixture.history())})`);
    if (name === 'provider-number') numericProvider = fixture;
  }
  numericProvider.admit();
  writeFileSync(switchPath, 'pass\n');
  const providerRetry = numericProvider.runCli();
  expectRepaired(providerRetry.status !== 0 && providerRetry.text.includes('verdict_flip_refused') && numericProvider.evidence()?.result !== 'PASS', 'a printed failure with an unusable provider exempted the retry from stickiness');

  // Audit 10: JSON lets a key be written with escapes, so the literal text
  // "provider" proves nothing. What marks a structured attempt is checked as a
  // pure function in scripts/verify-validation-verdict-stickiness.mjs; here a
  // printed failure with an escaped provider key goes through the built CLI.
  const escapedKey = seed('escaped-key', `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nif (verdict === 'pass') { console.log(JSON.stringify({ provider: 'flaky-fixture', status: 'pass', allPass: true, summary: 'pass', details: [], warnings: [] })); process.exit(0); }\nconsole.log('{"\\\\u0070rovider":"flaky-fixture","status":"fail","allPass":false}');\nprocess.exit(0);\n`);
  writeFileSync(switchPath, 'fail\n');
  const escapedRun = escapedKey.runCli();
  expectRepaired(escapedRun.status !== 0 && escapedKey.evidence()?.result === 'FAIL' && kinds(escapedKey.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]),
    `a printed failure with exit code zero and an escaped provider key was not recorded as a validation failure (exit=${escapedRun.status} evidence=${escapedKey.evidence()?.result} ${kinds(escapedKey.history())})`);
  escapedKey.admit();
  writeFileSync(switchPath, 'pass\n');
  const escapedRetry = escapedKey.runCli();
  expectRepaired(escapedRetry.status !== 0 && escapedRetry.text.includes('verdict_flip_refused') && escapedKey.evidence()?.result !== 'PASS', 'an escaped provider key exempted the retry from stickiness');

  // Audit 10: a validate file cannot claim that its printed verdict is a
  // dynamic-authority aggregate. It prints a failure carrying that claim and
  // then hangs until the executor kills it: a semantic failure beside a
  // timeout, which is a verdict, and sticks.
  const forged = seed('forged-authority', `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nif (verdict === 'pass') { console.log(JSON.stringify({ provider: 'flaky-fixture', status: 'pass', allPass: true, summary: 'pass', details: [], warnings: [] })); process.exit(0); }\nconsole.log(JSON.stringify({ provider: 'flaky-fixture', status: 'fail', allPass: false, dynamicValidation: { authority: 'enforce-authority', mode: 'enforce-low-risk' } }));\nsetTimeout(() => process.exit(1), 120000);\n`);
  const shortBudget = { PROOF_OR_STOP_VALIDATE_FILE_TIMEOUT_MS: '4000' };
  writeFileSync(switchPath, 'fail\n');
  const forgedRun = forged.runCli(shortBudget);
  check(forgedRun.status !== 0 && forged.evidence()?.commandExecution?.failureKind === 'infra_failure', `control: the forged run is killed at its deadline (${forgedRun.text.slice(0, 300)})`);
  expectRepaired(kinds(forged.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]), `a validate file claimed a dynamic authority and its printed failure was classified as infrastructure (${kinds(forged.history())})`);
  forged.admit();
  writeFileSync(switchPath, 'pass\n');
  const forgedRetry = forged.runCli(shortBudget);
  expectRepaired(forgedRetry.status !== 0 && forgedRetry.text.includes('verdict_flip_refused') && forged.evidence()?.result !== 'PASS', 'a forged dynamic authority exempted the retry from stickiness');

  const unusableStatus = seed('unusable-status', `const verdict = require('node:fs').readFileSync(process.env.STICKINESS_SWITCH, 'utf8').trim();\nif (verdict === 'pass') { console.log(JSON.stringify({ provider: 'flaky-fixture', status: 'pass', allPass: true, summary: 'pass', details: [], warnings: [] })); process.exit(0); }\nconsole.log(JSON.stringify({ provider: 'flaky-fixture', status: { toString: null }, allPass: false }));\nprocess.exit(1);\n`);
  writeFileSync(switchPath, 'fail\n');
  const unusableRun = unusableStatus.runCli();
  check(unusableRun.status !== 0, `control: a failing run with an unusable status fails (${unusableRun.text.slice(0, 300)})`);
  expectRepaired(kinds(unusableStatus.history()) === JSON.stringify([['fail', 'executed', 'validation_failure']]) && unusableStatus.evidence()?.result === 'FAIL',
    `a failing run whose printed status could not be coerced left no record (${kinds(unusableStatus.history())} evidence=${unusableStatus.evidence()?.result}; ${unusableRun.text.slice(0, 300)})`);
  unusableStatus.admit();
  writeFileSync(switchPath, 'pass\n');
  const unusableRetry = unusableStatus.runCli();
  expectRepaired(unusableRetry.status !== 0 && unusableRetry.text.includes('verdict_flip_refused') && unusableStatus.evidence()?.result !== 'PASS', 'an uncoercible printed status exempted the retry from stickiness');

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

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-verdict-stickiness-cli: ${checks} checks passed`);
