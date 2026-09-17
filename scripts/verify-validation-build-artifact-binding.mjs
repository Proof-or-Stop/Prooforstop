#!/usr/bin/env node
// Lab validation-build-artifact-binding RED/GREEN.
//
// Bug: routine validation evidence and the DONE-required evidence bind headHash,
// materialHash and storyFilesHash, all derived from the COMMITTED tree. The
// registered validation commands execute packages/main/dist and
// packages/utils/dist, which are gitignored and therefore invisible to every one
// of those digests. Two runs can carry a byte-identical binding while executing
// different compiled code, and a PASS produced against one dist stays reusable
// and admissible after dist changes. On main this surfaced as 57 same-identity
// re-executions of which 23 flipped the verdict (all fail->pass) across 22 Stories.
//
// This script drives the real public evaluators and the real DONE-required
// writer against disposable repositories whose dist trees it controls. It never
// manufactures gate receipts and never imports the repair for its assertions:
// the optional helper import below only builds routine evidence the way the
// repaired writer would, so the same assertions run before and after the fix.
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ts = createRequire(import.meta.url)('typescript');
// Compile checkout source with TypeScript, including parameter properties.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const { evaluateRoutineValidationReuse, buildRoutineValidationIdentity } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { evaluateValidationEvidenceAdmissibility } = await import('../packages/main/src/core/validation-evidence-admissibility.ts');
const { currentGitHead, currentMaterialHash, currentStoryFilesHash } = await import('../packages/main/src/core/evidence-freshness.ts');
const { runDoneRequiredValidation, evaluateDoneRequiredEvidence } = await import('../packages/main/src/core/done-required-validation.ts');
const { StoryStore } = await import('../packages/main/src/core/store.ts');
const { resetConfigCache } = await import('../packages/main/src/core/config.ts');
const { persistSyntheticAdmittedWindowForTest } = await import('../packages/main/src/core/certification-window.ts');
const { deriveCertificationDomainInputHashes } = await import('../packages/main/src/handlers/certification-window.ts');
// Present only after the repair. Used to build routine evidence exactly as the
// repaired writer does; never used as the subject of an assertion.
const binding = await import('../packages/main/src/core/build-artifacts-identity.ts').catch(() => null);

const MARKER = 'stale build artifacts admitted as fresh validation evidence';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const sandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-'));
const red = [];
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
function expectRepaired(value, message) { if (value) checks++; else red.push(message); }
function git(root, args) { return execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function rmTree(path) { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

const BUILD_A = 'process.exit(0); // compiled from probe.ts, build A\n';
const BUILD_B = 'process.exit(1); // compiled from probe.ts, build B: same source binding, different code\n';

// ---------------------------------------------------------------------------
// Routine validation: reuse and admissibility consumers.
// ---------------------------------------------------------------------------
function routineFixture() {
  const root = join(sandbox, 'routine'); mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Build Binding Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, '.gitignore'), 'dist\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed isolated fixture']);
  git(root, ['checkout', '-qb', 'story/B-bab']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/probe.ts'), 'export const probe = 1;\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'story: probe source']);
  const mainDist = join(root, 'packages/main/dist/tasks'); mkdirSync(mainDist, { recursive: true });
  const utilsDist = join(root, 'packages/utils/dist'); mkdirSync(utilsDist, { recursive: true });
  writeFileSync(join(utilsDist, 'index.js'), 'export const utils = 1;\n');
  return { root, probe: join(mainDist, 'probe-smoke.js'), mainDist };
}

try {
  const { root, probe, mainDist } = routineFixture();
  writeFileSync(probe, BUILD_A);
  const head = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  check(head && materialHash && storyFilesHash, `fixture identity must resolve head/material/storyFiles (got ${head}/${materialHash}/${storyFilesHash})`);

  const identity = buildRoutineValidationIdentity({
    projectRoot: root, sourceKind: 'configured', sourceInputs: { fixture: 'build-binding' },
    commands: [{ label: 'probe', command: 'node', args: ['packages/main/dist/tasks/probe-smoke.js'] }],
    profile: 'balanced', verificationPolicyInputs: { fixture: 'build-binding' },
  });
  check(identity.commands[0].executableDigest, 'identity must bind the node executable (existing behaviour)');
  const currentBuild = () => binding ? binding.currentBuildArtifactsHash(root) : undefined;
  const recordedBuild = currentBuild();
  const evidence = {
    command: 'proof-or-stop validate --story=B-bab --json',
    output: JSON.stringify({ allPass: true }),
    result: 'PASS',
    timestamp: new Date().toISOString(),
    headHash: head, materialHash, storyFilesHash,
    ...(recordedBuild ? { buildArtifactsHash: recordedBuild } : {}),
    verificationCoverage: { missingRequired: 0 },
    commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
    disposition: 'executed',
    routineValidationIdentity: identity,
  };
  const reuse = () => evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
    currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, clean: true, headBefore: head, headAfter: head,
    ...(binding ? { currentBuildArtifactsHash: currentBuild() } : {}),
  });
  const admissibility = () => evaluateValidationEvidenceAdmissibility({
    evidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage',
    blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
  });
  const expectRefusedByBuild = (label) => {
    const r = reuse();
    expectRepaired(r.reusable === false, `reuse: ${label}`);
    if (!r.reusable) check(r.refusalReasons.every((reason) => reason === 'build-artifacts-hash-changed-or-missing'), `only the build binding may refuse reuse here (got ${r.refusalReasons.join(',')})`);
    const a = admissibility();
    expectRepaired(a.ok === false, `admissibility: ${label}`);
    if (!a.ok) check(a.reasonCodes.every((code) => code.startsWith('build_artifacts_')), `only the build binding may refuse admission here (got ${a.reasonCodes.join(',')})`);
    return { r, a };
  };

  // Controls: with the recorded dist in place everything else is fresh, so both consumers admit.
  const reuseBefore = reuse();
  check(reuseBefore.reusable === true, `control: PASS against build A must be reusable (refusalReasons=${reuseBefore.refusalReasons.join(',')})`);
  const admitBefore = admissibility();
  check(admitBefore.ok === true, `control: PASS against build A must be admissible (reasonCodes=${admitBefore.reasonCodes.join(',')})`);

  // Target: the compiled artifact changes while HEAD, materialHash and storyFilesHash stay identical.
  writeFileSync(probe, BUILD_B);
  check(currentGitHead(root) === head && currentMaterialHash(root, 'HEAD', root) === materialHash
    && currentStoryFilesHash(root, 'HEAD', root) === storyFilesHash, 'dist change must leave every committed-tree digest identical');
  const changed = expectRefusedByBuild('PASS recorded against build A was accepted after dist changed to build B');
  if (!changed.r.reusable) check(changed.r.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), 'reuse refusal must name the build binding');
  if (!changed.a.ok) check(changed.a.reasonCodes.includes('build_artifacts_mismatch'), `admissibility refusal must name the mismatch (got ${changed.a.reasonCodes.join(',')})`);

  // The binding keys on content, not on time: restoring build A admits again.
  writeFileSync(probe, BUILD_A);
  check(reuse().reusable === true, 'restoring build A must make the recorded PASS reusable again');
  check(admissibility().ok === true, 'restoring build A must make the recorded PASS admissible again');

  // Symbolic links: a link inside dist can point at bytes that change without any
  // regular file below the root changing, so the identity must become unavailable.
  const outside = join(sandbox, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'target.js'), 'export const linked = 1;\n');
  const linkedFile = join(mainDist, 'linked.js');
  symlinkSync(join(outside, 'target.js'), linkedFile);
  if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'a symbolic link inside dist must make the build identity unavailable');
  expectRefusedByBuild('PASS was accepted while dist contained a symbolic link to an outside file');
  writeFileSync(join(outside, 'target.js'), 'export const linked = 2;\n');
  expectRefusedByBuild('PASS was accepted after the target of a linked file changed');
  rmSync(linkedFile);
  const outsideDir = join(sandbox, 'outside-dir'); mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, 'inner.js'), 'export const inner = 1;\n');
  const linkedDir = join(mainDist, 'linked-dir');
  symlinkSync(outsideDir, linkedDir, 'dir');
  expectRefusedByBuild('PASS was accepted while dist contained a linked directory');
  writeFileSync(join(outsideDir, 'inner.js'), 'export const inner = 2;\n');
  expectRefusedByBuild('PASS was accepted after a file beneath a linked directory changed');
  rmSync(linkedDir);
  check(reuse().reusable === true, 'removing the links restores the recorded identity');
  check(admissibility().ok === true, 'removing the links restores admissibility');

  // A missing artifact tree is not the recorded one either.
  rmTree(join(root, 'packages/main/dist'));
  expectRefusedByBuild('PASS recorded against build A was accepted after packages/main/dist disappeared');

  // Source-text guards (not runtime proof): the canonical terminal event must
  // carry the binding, the executed result must be stamped with the identity at
  // the end of execution, and both writers must refuse to publish when the dist
  // moves between execution and publication.
  const verifier = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
  const guard = (source, fn, needle, message) => {
    const start = source.indexOf(`function ${fn}(`);
    const end = source.indexOf('\n}\n', start);
    check(start >= 0 && end > start, `${fn} must be defined`);
    expectRepaired(source.slice(start, end).includes(needle), message);
  };
  guard(verifier, 'recordValidationTerminal', 'buildArtifactsHash', 'validation_terminal event does not record buildArtifactsHash (source-text guard)');
  guard(verifier, 'decorateAndMaybePersistStoryValidation', 'buildArtifactsHash', 'executed result is not stamped with the end-of-execution build identity (source-text guard)');
  guard(verifier, 'persistStoryValidationEvidence', 'build_artifacts_drift_before_publication', 'routine writer does not refuse publication when the dist moved after execution (source-text guard)');
  const doneRequired = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
  guard(doneRequired, 'runDoneRequiredValidation', 'build-artifacts-changed-before-publication', 'DONE-required writer does not fail evidence when the dist moved after execution (source-text guard)');
} finally {
  // Routine fixture is removed with the sandbox below.
}

// ---------------------------------------------------------------------------
// DONE-required validation: the real writer and the real freshness evaluator.
// ---------------------------------------------------------------------------
function doneRequiredFixture(name, doneRequiredCommands) {
  const root = join(sandbox, name); mkdirSync(root);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    workflow: { profile: 'light' }, doneRequiredCommands,
  }, null, 2));
  resetConfigCache();
  writeFileSync(join(root, '.gitignore'), 'dist\n');
  writeFileSync(join(root, 'README.md'), '# done required build binding fixture\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Build Binding Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.gitignore', 'README.md', 'proof-or-stop.config.json']); git(root, ['commit', '-qm', 'base']);
  const store = new StoryStore(root);
  const storyId = 'B-bab-done';
  const now = '2026-06-20T00:00:00.000Z';
  store.writeStory(storyId, { storyId, name: 'build-binding-done-required', title: 'DONE required build binding', description: 'Disposable DONE-required build binding fixture.', type: 'chore', phase: 'TEST', priority: 'medium', createdAt: now, startedAt: now, endedAt: null });
  store.writeChecklist(storyId, { items: [] });
  const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
  check(Boolean(causalInputHashes), 'DONE-required fixture must derive causal input hashes');
  persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
  const mainDist = join(root, 'packages/main/dist/tasks'); mkdirSync(mainDist, { recursive: true });
  writeFileSync(join(mainDist, 'x.js'), BUILD_A);
  const utilsDist = join(root, 'packages/utils/dist'); mkdirSync(utilsDist, { recursive: true });
  writeFileSync(join(utilsDist, 'index.js'), 'export const utils = 1;\n');
  return { root, store, storyId, mainFile: join(mainDist, 'x.js'), utilsFile: join(utilsDist, 'index.js') };
}

try {
  const f = doneRequiredFixture('done-required', [{ label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  const evaluate = () => evaluateDoneRequiredEvidence({ projectRoot: f.root, storyId: f.storyId, store: f.store, gitCwd: f.root });
  const evidence = await runDoneRequiredValidation({ projectRoot: f.root, storyId: f.storyId, store: f.store, gitCwd: f.root });
  check(evidence.status === 'PASS', `DONE-required run must PASS (reasons=${evidence.reasons.join(', ')})`);
  expectRepaired(/^[a-f0-9]{64}$/.test(evidence.buildArtifactsHash ?? ''), 'DONE-required PASS does not record buildArtifactsHash');
  if (binding) check(evidence.buildArtifactsHash === binding.currentBuildArtifactsHash(f.root), 'DONE-required PASS must bind the dist on disk at the end of execution');
  const before = evaluate();
  check(before.ok === true, `control: fresh DONE-required PASS must be admissible (reasons=${before.reasons.join(', ')})`);

  // Each artifact root changes without any committed identity changing.
  const committedIdentity = [currentGitHead(f.root), currentMaterialHash(f.root, 'HEAD', f.root), currentStoryFilesHash(f.root, 'HEAD', f.root)].join('|');
  writeFileSync(f.mainFile, BUILD_B);
  check([currentGitHead(f.root), currentMaterialHash(f.root, 'HEAD', f.root), currentStoryFilesHash(f.root, 'HEAD', f.root)].join('|') === committedIdentity, 'main dist change must leave the committed identity unchanged');
  const mainDrift = evaluate();
  expectRepaired(mainDrift.ok === false && mainDrift.reasons.includes('stale-buildArtifacts'), `DONE-required PASS accepted after packages/main/dist changed (reasons=${mainDrift.reasons.join(', ')})`);
  writeFileSync(f.mainFile, BUILD_A);
  check(evaluate().ok === true, 'restoring packages/main/dist makes the DONE-required PASS admissible again');
  writeFileSync(f.utilsFile, 'export const utils = 2;\n');
  const utilsDrift = evaluate();
  expectRepaired(utilsDrift.ok === false && utilsDrift.reasons.includes('stale-buildArtifacts'), `DONE-required PASS accepted after packages/utils/dist changed (reasons=${utilsDrift.reasons.join(', ')})`);
  writeFileSync(f.utilsFile, 'export const utils = 1;\n');
  check(evaluate().ok === true, 'restoring packages/utils/dist makes the DONE-required PASS admissible again');

  // Legacy evidence without the binding is refused rather than trusted.
  const { buildArtifactsHash: _legacyStripped, ...legacy } = evidence;
  f.store.writeDoneRequiredEvidence(f.storyId, legacy);
  const missing = evaluate();
  expectRepaired(missing.ok === false && missing.reasons.includes('missing-buildArtifactsHash'), `legacy DONE-required PASS without buildArtifactsHash was accepted (reasons=${missing.reasons.join(', ')})`);
  f.store.writeDoneRequiredEvidence(f.storyId, evidence);
  check(evaluate().ok === true, 'unchanged-build control: the bound PASS is admissible again');

  // The binding is the dist as executed: a command that rebuilds dist during the
  // run binds the rebuilt state, not the pre-run state.
  const g = doneRequiredFixture('done-required-rebuild', [
    { label: 'rebuild', command: 'node', args: ['-e', "require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rebuilt during the run\\n')"] },
    { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] },
  ]);
  const preRun = binding ? binding.currentBuildArtifactsHash(g.root) : undefined;
  const rebuilt = await runDoneRequiredValidation({ projectRoot: g.root, storyId: g.storyId, store: g.store, gitCwd: g.root });
  check(rebuilt.status === 'PASS', `rebuild-during-run must PASS (reasons=${rebuilt.reasons.join(', ')})`);
  check(readFileSync(g.mainFile, 'utf8').includes('rebuilt during the run'), 'the rebuild command must have rewritten dist');
  if (binding) {
    check(rebuilt.buildArtifactsHash === binding.currentBuildArtifactsHash(g.root), 'the PASS must bind the rebuilt dist the later command executed');
    check(rebuilt.buildArtifactsHash !== preRun, 'the PASS must not bind the pre-run dist');
  }
  check(evaluateDoneRequiredEvidence({ projectRoot: g.root, storyId: g.storyId, store: g.store, gitCwd: g.root }).ok === true, 'a PASS bound to the rebuilt dist is admissible while that dist stays');
} finally {
  rmTree(sandbox);
}

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-build-artifact-binding: ${checks} checks passed`);
