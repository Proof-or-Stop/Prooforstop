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
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const { evaluateRoutineValidationReuse, buildRoutineValidationIdentity } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { evaluateValidationEvidenceAdmissibility } = await import('../packages/main/src/core/validation-evidence-admissibility.ts');
const { currentGitHead, currentMaterialHash, currentStoryFilesHash } = await import('../packages/main/src/core/evidence-freshness.ts');
const { runDoneRequiredValidation, evaluateDoneRequiredEvidence, validateReceiptBuildBinding } = await import('../packages/main/src/core/done-required-validation.ts');
const { executeValidationPlan } = await import('../packages/main/src/core/validation-executor.ts');
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
  if (binding) check(/^[a-f0-9]{64}$/.test(binding.currentBuildArtifactsHash(root) ?? ''), 'a confirmed missing root still yields a definite identity (absent marker)');

  // Audit #6: an observation failure is not "absent". A root this process
  // cannot lstat (its parent denies search) must make the identity unavailable
  // and every consumer must refuse, exactly as for a symbolic link.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('skip: the EACCES case needs an unprivileged user');
  } else {
    const parent = join(root, 'packages/main');
    chmodSync(parent, 0o000);
    try {
      if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'an artifact root that cannot be inspected (EACCES) was digested as a valid identity');
      const r = reuse();
      expectRepaired(r.reusable === false && r.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS while the artifact root could not be inspected (reasons=${r.refusalReasons.join(',')})`);
      const a = admissibility();
      expectRepaired(a.ok === false && a.reasonCodes.includes('build_artifacts_unavailable'), `admissibility accepted a PASS while the artifact root could not be inspected (codes=${a.reasonCodes.join(',')})`);
    } finally {
      chmodSync(parent, 0o755);
    }
  }

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

  // Per-receipt binding: every receipt records the dist it started against and
  // the dist it left behind. A receipt without those observations cannot vouch.
  expectRepaired(evidence.receipts.every((receipt) => /^[a-f0-9]{64}$/.test(receipt.buildArtifactsBefore ?? '') && /^[a-f0-9]{64}$/.test(receipt.buildArtifactsAfter ?? '')),
    'DONE-required receipts do not record the build identity before and after execution');
  const { buildArtifactsBefore: _receiptStripped, ...unboundReceipt } = evidence.receipts[0];
  f.store.writeDoneRequiredEvidence(f.storyId, { ...evidence, receipts: [unboundReceipt, ...evidence.receipts.slice(1)] });
  const unbound = evaluate();
  expectRepaired(unbound.ok === false && unbound.reasons.some((reason) => reason.startsWith('missing-receipt-build-binding[0]')), `a receipt without its build observations was accepted (reasons=${unbound.reasons.join(', ')})`);
  f.store.writeDoneRequiredEvidence(f.storyId, evidence);
  check(evaluate().ok === true, 'restoring the receipt observations makes the PASS admissible again');

  // A command that is not a registered packages/main build must not rewrite the
  // artifacts under test: the run fails instead of binding whatever it left.
  const REBUILD = "require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rebuilt during the run\\n')";
  const g = doneRequiredFixture('done-required-unregistered-rebuild', [
    { label: 'rewrites dist', command: 'node', args: ['-e', REBUILD] },
    { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] },
  ]);
  const unregistered = await runDoneRequiredValidation({ projectRoot: g.root, storyId: g.storyId, store: g.store, gitCwd: g.root });
  check(readFileSync(g.mainFile, 'utf8').includes('rebuilt during the run'), 'the rewriting command must have rewritten dist');
  expectRepaired(unregistered.status === 'FAIL' && unregistered.reasons.some((reason) => reason.startsWith('build-artifacts-changed-during-command[0]')),
    `a non-build command rewrote dist during the run and the evidence still passed (status=${unregistered.status}, reasons=${unregistered.reasons.join(', ')})`);
  expectRepaired(evaluateDoneRequiredEvidence({ projectRoot: g.root, storyId: g.storyId, store: g.store, gitCwd: g.root }).ok === false,
    'evidence whose dist was rewritten by a non-build command was admitted');

  // A registered build may rewrite dist; the later test executes the rebuilt
  // build and the evidence binds that build, not the pre-run one.
  const REGISTERED_REBUILD_COMMANDS = [
    { label: 'build', command: 'node', args: ['-e', REBUILD], providesBuildProof: 'packages-main-build' },
    { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] },
  ];
  const h = doneRequiredFixture('done-required-registered-rebuild', REGISTERED_REBUILD_COMMANDS);
  const preRun = binding ? binding.currentBuildArtifactsHash(h.root) : undefined;
  const registered = await runDoneRequiredValidation({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root });
  check(registered.status === 'PASS', `registered build followed by a test must PASS (reasons=${registered.reasons.join(', ')})`);
  if (binding) {
    check(registered.buildArtifactsHash === binding.currentBuildArtifactsHash(h.root), 'the PASS must bind the rebuilt dist the test executed');
    check(registered.buildArtifactsHash !== preRun, 'the PASS must not bind the pre-run dist');
    check(registered.receipts[1].buildArtifactsBefore === registered.buildArtifactsHash, 'the test receipt must have started against the bound build');
  }
  check(evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root }).ok === true, 'a PASS bound to the rebuilt dist is admissible while that dist stays');

  // Audit #5: receipts are a sequential chain, so each one must start on the
  // bytes the previous one left behind, and the bound identity must be the
  // registered build's own output. Evidence whose build receipt recorded
  // output X while the test started on (and the evidence binds) R describes a
  // dist that was replaced between the two receipts; every per-receipt rule
  // holds on it, only the chain is broken. The writer and the evaluator share
  // validateReceiptBuildBinding, so the evaluator path proves both.
  if (binding) {
    const replaced = 'f'.repeat(64);
    const chainBroken = {
      ...registered,
      receipts: [
        { ...registered.receipts[0], buildArtifactsAfter: replaced },
        ...registered.receipts.slice(1),
      ],
    };
    h.store.writeDoneRequiredEvidence(h.storyId, chainBroken);
    const broken = evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root });
    expectRepaired(broken.ok === false && broken.reasons.some((reason) => reason.startsWith('build-artifacts-changed-between-receipts[1]')),
      `a test receipt that did not start on the previous receipt's output was accepted (reasons=${broken.reasons.join(', ')})`);
    expectRepaired(broken.ok === false && broken.reasons.some((reason) => reason.startsWith('build-artifacts-differ-from-registered-build')),
      `evidence bound to bytes other than the registered build's output was accepted (reasons=${broken.reasons.join(', ')})`);
    h.store.writeDoneRequiredEvidence(h.storyId, registered);
    check(evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root }).ok === true, 'restoring the receipt chain makes the PASS admissible again');
    // The writer cannot be driven into a deterministic between-receipts write
    // (its two observations are microseconds apart in one process), so its
    // coverage is the same validator called with the writer's own argument
    // shape, plus a guard that the writer still calls it that way.
    const writerShape = validateReceiptBuildBinding({ receipts: chainBroken.receipts, buildArtifactsHash: chainBroken.buildArtifactsHash }, h.root, REGISTERED_REBUILD_COMMANDS);
    expectRepaired(writerShape.some((reason) => reason.startsWith('build-artifacts-changed-between-receipts[1]')) && writerShape.some((reason) => reason.startsWith('build-artifacts-differ-from-registered-build')),
      `the writer-shape validator accepted a broken receipt chain (reasons=${writerShape.join(', ')})`);
    check(validateReceiptBuildBinding({ receipts: registered.receipts, buildArtifactsHash: registered.buildArtifactsHash }, h.root, REGISTERED_REBUILD_COMMANDS).length === 0, 'control: the intact receipt chain yields no binding reasons');
    const doneRequiredSource = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
    expectRepaired(doneRequiredSource.includes('validateReceiptBuildBinding({ receipts, buildArtifactsHash: executionBuildArtifactsHash }'), 'the DONE-required writer does not validate its receipts against the end-of-execution identity (source-text guard)');
  }

  // A registered build that lands AFTER the tests invalidates them: the tests
  // executed a build that was replaced before the evidence was bound.
  const k = doneRequiredFixture('done-required-rebuild-after-tests', [
    { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] },
    { label: 'build', command: 'node', args: ['-e', REBUILD], providesBuildProof: 'packages-main-build' },
  ]);
  const late = await runDoneRequiredValidation({ projectRoot: k.root, storyId: k.storyId, store: k.store, gitCwd: k.root });
  expectRepaired(late.status === 'FAIL' && late.reasons.some((reason) => reason.startsWith('receipt-not-bound-to-final-build[0]')),
    `a build that replaced the tested dist after the tests still produced PASS (status=${late.status}, reasons=${late.reasons.join(', ')})`);

  // Reused PASS republication keeps the authenticated prior binding and never
  // adopts the dist on disk; it is refused when the two differ.
  if (binding) {
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    const same = binding.resolveReusedBuildArtifactsBinding({ prior: A, current: A });
    check(same.ok === true && same.buildArtifactsHash === A, 'reuse keeps the prior binding when the dist is unchanged');
    check(binding.resolveReusedBuildArtifactsBinding({ prior: A, current: B }).ok === false, 'reuse must refuse when the dist differs from the prior binding');
    check(binding.resolveReusedBuildArtifactsBinding({ prior: undefined, current: A }).ok === false, 'reuse must refuse an unbound prior PASS');
    check(binding.resolveReusedBuildArtifactsBinding({ prior: A, current: undefined }).ok === false, 'reuse must refuse when the current identity is unavailable');
  }
  const verifierSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
  const reusedStart = verifierSource.indexOf('function reusedStoryValidationResult(');
  const reusedEnd = verifierSource.indexOf('\n}\n', reusedStart);
  check(reusedStart >= 0 && reusedEnd > reusedStart, 'reusedStoryValidationResult must be defined');
  expectRepaired(verifierSource.slice(reusedStart, reusedEnd).includes('resolveReusedBuildArtifactsBinding('), 'reused PASS republication does not preserve the prior build binding (source-text guard)');
  // The identity is observed by the executor at execution boundaries; the
  // handler decorator must not derive it from the tree after the fact.
  const decoratorStart = verifierSource.indexOf('function decorateAndMaybePersistStoryValidation(');
  const decoratorEnd = verifierSource.indexOf('\n}\n', decoratorStart);
  check(decoratorStart >= 0 && decoratorEnd > decoratorStart, 'decorateAndMaybePersistStoryValidation must be defined');
  expectRepaired(!verifierSource.slice(decoratorStart, decoratorEnd).includes('currentBuildArtifactsHash('), 'the handler decorator still derives the build identity instead of taking the executor observation (source-text guard)');
  const doneRequiredSource = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
  expectRepaired((doneRequiredSource.match(/validateReceiptBuildBinding\(/g) ?? []).length >= 3, 'per-receipt build binding is not enforced by both the DONE-required writer and evaluator (source-text guard)');
} finally {
  rmTree(sandbox);
}

// ---------------------------------------------------------------------------
// Routine plans: the executor observes every command and stamps the binding.
// The validate-file path feeds this same executor with a single command, so a
// validate-file-shaped plan is exercised here directly (the `npx tsx` wrapper
// itself is not run: tsx is not installed in this checkout).
// ---------------------------------------------------------------------------
{
  const planSandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-plan-'));
  try {
    const root = join(planSandbox, 'plan'); mkdirSync(root);
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['config', 'user.email', 'fixture@example.invalid']);
    git(root, ['config', 'user.name', 'Build Binding Fixture']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, '.gitignore'), 'dist\n');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
    // A validate-file-shaped entrypoint: exits 0 after rewriting the compiled artifacts it just tested.
    writeFileSync(join(root, 'validate.js'), "require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rewritten by validate.js\\n'); process.exit(0);\n");
    writeFileSync(join(root, 'validate-clean.js'), 'process.exit(0);\n');
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'plan fixture']);
    const mainDist = join(root, 'packages/main/dist/tasks'); mkdirSync(mainDist, { recursive: true });
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);
    mkdirSync(join(root, 'packages/utils/dist'), { recursive: true });
    writeFileSync(join(root, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
    const run = (commands) => executeValidationPlan({ provider: 'build-binding-fixture', commands, warnings: [] }, root, undefined, undefined, {});
    const REWRITE = "require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rewritten\\n')";

    // Control: a plan that leaves the artifacts alone passes and binds them.
    const clean = await run([{ label: 'validate file', command: 'node', args: ['validate-clean.js'], timeoutMs: 20_000 }]);
    check(clean.allPass === true, `control: untouched plan must pass (${clean.details.join(' | ')})`);
    expectRepaired(/^[a-f0-9]{64}$/.test(clean.buildArtifactsHash ?? ''), 'routine plan result does not carry the executor build binding');
    if (binding) expectRepaired(clean.buildArtifactsHash === binding.currentBuildArtifactsHash(root), 'routine plan binding does not equal the artifacts on disk at plan end');
    expectRepaired(clean.commands.every((command) => /^[a-f0-9]{64}$/.test(command.buildArtifactsBefore ?? '') && /^[a-f0-9]{64}$/.test(command.buildArtifactsAfter ?? '') && command.buildArtifactsRole === 'test'),
      'routine command results do not carry before/after observations and a role');

    // Audit #6: an artifact root the executor cannot inspect fails the plan as
    // unavailable; it never binds an "absent" tree.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('skip: the executor EACCES case needs an unprivileged user');
    } else {
      chmodSync(join(root, 'packages/main'), 0o000);
      let blind;
      try {
        blind = await run([{ label: 'validate file', command: 'node', args: ['validate-clean.js'], timeoutMs: 20_000 }]);
      } finally {
        chmodSync(join(root, 'packages/main'), 0o755);
      }
      expectRepaired(blind.allPass === false && blind.details.some((line) => line.includes('build_artifacts_identity_unavailable')),
        `a plan whose artifact root could not be inspected still passed (${blind.details.join(' | ')})`);
      expectRepaired(!blind.buildArtifactsHash, 'a plan whose artifact root could not be inspected must not carry a build binding');
    }

    // Target: a validate-file-shaped command that rewrites the artifacts it tested.
    const rewritten = await run([{ label: 'validate file', command: 'node', args: ['validate.js'], timeoutMs: 20_000 }]);
    check(readFileSync(join(mainDist, 'x.js'), 'utf8').includes('rewritten by validate.js'), 'the validate file must have rewritten dist');
    expectRepaired(rewritten.allPass === false && rewritten.details.some((line) => line.includes('build_artifacts_changed_by_non_build_command')),
      `a validate file that rewrote dist still produced a passing plan (${rewritten.details.join(' | ')})`);
    expectRepaired(!rewritten.buildArtifactsHash, 'a plan whose artifacts were rewritten by a non-build command must not carry a build binding');
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // A non-build command among several rewrites dist: the whole plan is refused.
    const mixed = await run([
      { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 },
      { label: 'rewrites dist', command: 'node', args: ['-e', REWRITE], timeoutMs: 20_000 },
    ]);
    expectRepaired(mixed.allPass === false && mixed.details.some((line) => line.includes('build_artifacts_changed_by_non_build_command')),
      `a non-build command rewrote dist inside a routine plan and the plan still passed (${mixed.details.join(' | ')})`);
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // A registered build may rewrite dist and runs first, so every test executes
    // the rebuilt artifacts and the plan binds them.
    const preRun = binding ? binding.currentBuildArtifactsHash(root) : undefined;
    const built = await run([
      { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 },
      { label: 'build', command: 'node', args: ['-e', REWRITE], timeoutMs: 20_000, providesBuildProof: 'packages-main-build' },
    ]);
    check(built.allPass === true, `registered build plus test must pass (${built.details.join(' | ')})`);
    if (binding) {
      check(built.buildArtifactsHash === binding.currentBuildArtifactsHash(root), 'the plan must bind the rebuilt artifacts');
      check(built.buildArtifactsHash !== preRun, 'the plan must not bind the pre-run artifacts');
    }
    const buildCommand = built.commands.find((command) => command.label === 'build');
    const testCommand = built.commands.find((command) => command.label === 'pass');
    expectRepaired(buildCommand?.buildArtifactsRole === 'build' && testCommand?.buildArtifactsRole === 'test', 'executor must recognise the registered build command');
    expectRepaired(Boolean(testCommand?.buildArtifactsBefore) && testCommand?.buildArtifactsBefore === buildCommand?.buildArtifactsAfter,
      'the registered build must run before the test so the test starts against the rebuilt artifacts');

    // A rewrite that preserves every size and restores every timestamp is
    // invisible to an lstat fingerprint. Every per-command observation is a
    // content digest, so the rewriting command is attributed by name and the
    // plan cannot end on bytes the registered build did not produce.
    const STAMP = '2026-01-02T03:04:05.678Z';
    const stamped = (body) => `const fs = require('node:fs'); const p = 'packages/main/dist/tasks/x.js'; fs.writeFileSync(p, ${JSON.stringify(body)}); const d = new Date('${STAMP}'); fs.utimesSync(p, d, d);`;
    const BUILD_STAMPED = stamped('process.exit(0); // build A\n');
    const EVASIVE_REWRITE = stamped('process.exit(1); // build B\n');
    const evasive = await run([
      { label: 'build', command: 'node', args: ['-e', BUILD_STAMPED], timeoutMs: 20_000, providesBuildProof: 'packages-main-build' },
      { label: 'stealthy rewrite', command: 'node', args: ['-e', EVASIVE_REWRITE], timeoutMs: 20_000 },
    ]);
    const stealthy = evasive.commands.find((command) => command.label === 'stealthy rewrite');
    check(readFileSync(join(mainDist, 'x.js'), 'utf8').includes('build B'), 'the stealthy rewrite must have replaced the bytes');
    expectRepaired(Boolean(stealthy?.buildArtifactsBefore) && stealthy?.buildArtifactsBefore !== stealthy?.buildArtifactsAfter,
      'the equal-length, timestamp-restoring rewrite was invisible to the per-command observation (size/mtime fingerprint instead of a content digest)');
    expectRepaired(evasive.allPass === false && evasive.details.some((line) => line.includes('stealthy rewrite') && line.includes('build_artifacts_changed_by_non_build_command')),
      `a size- and timestamp-preserving rewrite was not attributed to the command that made it (${evasive.details.join(' | ')})`);
    expectRepaired(evasive.details.some((line) => line.includes('build_artifacts_changed_after_build')),
      `a size- and timestamp-preserving rewrite after the registered build still produced a passing plan (${evasive.details.join(' | ')})`);
    expectRepaired(!evasive.buildArtifactsHash, 'a plan whose final bytes differ from the registered build output must not carry a build binding');
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // Audit #5 evasion: swap the build for one the test passes against, run
    // the test, then restore the registered build's exact bytes and timestamps.
    // The plan ends on the registered build's own output, so a start/end
    // content comparison and lstat fingerprints both see nothing; the test
    // nevertheless executed bytes the plan never binds.
    const FAILING_BUILD_A = stamped('process.exit(1); // build A\n');
    const PASSING_SWAP_B = stamped('process.exit(0); // build B\n');
    const abab = await run([
      { label: 'build', command: 'node', args: ['-e', FAILING_BUILD_A], timeoutMs: 20_000, providesBuildProof: 'packages-main-build' },
      { label: 'swap in build B', command: 'node', args: ['-e', PASSING_SWAP_B], timeoutMs: 20_000 },
      { label: 'test that passes only against build B', command: 'node', args: ['packages/main/dist/tasks/x.js'], timeoutMs: 20_000 },
      { label: 'restore build A', command: 'node', args: ['-e', FAILING_BUILD_A], timeoutMs: 20_000 },
    ]);
    const ababBuild = abab.commands.find((command) => command.label === 'build');
    const ababSwap = abab.commands.find((command) => command.label === 'swap in build B');
    const ababTest = abab.commands.find((command) => command.label === 'test that passes only against build B');
    check(readFileSync(join(mainDist, 'x.js'), 'utf8').includes('build A'), 'the restore must have put build A back');
    check(ababTest?.code === 0, `trap: the test must have passed against the swapped build (code=${ababTest?.code})`);
    if (binding) check(binding.currentBuildArtifactsHash(root) === ababBuild?.buildArtifactsAfter, 'trap: the plan must end on exactly the bytes the registered build produced');
    expectRepaired(Boolean(ababSwap?.buildArtifactsBefore) && ababSwap?.buildArtifactsBefore !== ababSwap?.buildArtifactsAfter,
      'the swap that preserved size and timestamps was invisible to the per-command observation');
    expectRepaired(abab.allPass === false && abab.details.some((line) => line.includes('swap in build B') && line.includes('build_artifacts_changed_by_non_build_command')),
      `a swap-test-restore sequence around a registered build still produced a passing plan (${abab.details.join(' | ')})`);
    expectRepaired(abab.details.some((line) => line.includes('test that passes only against build B') && line.includes('receipt_not_bound_to_final_build')),
      `the test that executed the swapped bytes was not refused as unbound to the final build (${abab.details.join(' | ')})`);
    expectRepaired(!abab.buildArtifactsHash, 'a plan whose test executed swapped bytes must not carry a build binding');
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // The validate-file handler path cannot bypass the executor.
    const verifierSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
    const validateFileStart = verifierSource.indexOf('const runValidateFile = ');
    check(validateFileStart >= 0, 'runValidateFile must be defined');
    expectRepaired(verifierSource.slice(validateFileStart, validateFileStart + 1200).includes('executeValidationPlan('), 'the validate-file path does not execute through the observing executor (source-text guard)');
    const executorSource = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
    expectRepaired(executorSource.includes('receipt_not_bound_to_final_build') && executorSource.includes('build_artifacts_changed_by_non_build_command'),
      'the executor does not enforce the per-command build binding rules (source-text guard)');
    // The validate-file result is rebuilt from the child's output; it must carry
    // the executor binding and discard any binding the child printed itself.
    const bindingHelperStart = verifierSource.indexOf('const withExecutorBinding = ');
    expectRepaired(bindingHelperStart >= 0 && verifierSource.slice(bindingHelperStart, bindingHelperStart + 900).includes('validation.buildArtifactsHash')
      && verifierSource.includes('const bound = withExecutorBinding(value);'),
      'the validate-file result assemblies do not carry the executor build binding (source-text guard)');
  } finally {
    rmTree(planSandbox);
  }
}

// ---------------------------------------------------------------------------
// Validate-file handler path, end to end through the built CLI, with and
// without --json. `npx tsx` resolves a local node_modules/.bin/tsx shim that
// runs the file with Node's native TypeScript stripping, so no network is used.
// ---------------------------------------------------------------------------
{
  const cli = join(repoRoot, 'packages/main/dist/cli.js');
  check(existsSync(cli), `handler-level validate-file regression requires a built CLI at ${cli}`);
  const handlerSandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-handler-'));
  try {
    const seed = (name, validateTs) => {
      const root = join(handlerSandbox, name); mkdirSync(root);
      const storyId = 'B-bab-handler';
      writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\nnode_modules\ndist\n');
      writeFileSync(join(root, 'source.ts'), 'export const handlerBinding = true;\n');
      writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'light' } }, null, 2));
      writeFileSync(join(root, 'validate.ts'), validateTs);
      mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(root, 'node_modules/.bin/tsx'), '#!/bin/sh\nexec node "$@"\n', { mode: 0o755 });
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'fixture@example.invalid']);
      git(root, ['config', 'user.name', 'Build Binding Fixture']);
      git(root, ['config', 'commit.gpgsign', 'false']);
      git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
      git(root, ['checkout', '-qb', `story/${storyId}`]);
      const now = '2026-07-16T00:00:00.000Z';
      const store = new StoryStore(root);
      store.writeStory(storyId, { storyId, name: 'build-binding-handler', title: 'validate-file binding', description: 'Disposable validate-file build binding fixture.', type: 'bug', phase: 'TEST', priority: 'medium', createdAt: now, startedAt: now, endedAt: null, riskSignals: [], currentReviewRound: now, events: [{ phase: 'TEST', action: 'advance', timestamp: now }] });
      store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'binding', context: 'validate file', status: 'done', verificationIntent: { happy: [{ desc: 'validate file runs', type: 'logic', priority: 'should' }], edge: [], adversarial: [] }, startTime: now, endTime: now }] });
      const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
      persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
      git(root, ['add', '.proof-or-stop']); git(root, ['commit', '-qm', 'seed story metadata']);
      const mainDist = join(root, 'packages/main/dist/tasks'); mkdirSync(mainDist, { recursive: true });
      writeFileSync(join(mainDist, 'x.js'), BUILD_A);
      mkdirSync(join(root, 'packages/utils/dist'), { recursive: true });
      writeFileSync(join(root, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
      const evidencePath = join(root, `.proof-or-stop/story/actives/${storyId}/test-evidence.json`);
      const runCli = (extra) => {
        const r = spawnSync(process.execPath, [cli, 'validate', `--story=${storyId}`, ...extra], {
          cwd: root, encoding: 'utf8', timeout: 300_000,
          env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root, PROOF_OR_STOP_SESSION_ID: 'build-binding-handler', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', npm_config_yes: 'true' },
        });
        return { status: r.status, text: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
      };
      const evidence = () => existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null;
      return { root, mainDist, runCli, evidence };
    };
    const PASS_JSON = "console.log(JSON.stringify({ provider: 'validate-file-fixture', status: 'pass', allPass: true, summary: 'semantic PASS', details: [], warnings: [] }));";

    // Control: a validate file that leaves the artifacts alone earns a bound PASS.
    const clean = seed('clean', `${PASS_JSON}\n`);
    const cleanJson = clean.runCli(['--json']);
    check(cleanJson.status === 0, `control: clean validate file must pass with --json (${cleanJson.text.slice(0, 400)})`);
    expectRepaired(/^[a-f0-9]{64}$/.test(clean.evidence()?.buildArtifactsHash ?? ''), 'validate-file PASS evidence does not carry the executor build binding');

    // Target: an exit-zero validate file that rewrites the artifacts it tested,
    // and prints a forged binding of its own.
    const REWRITING = `require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rewritten by validate.ts\\n');\nconsole.log(JSON.stringify({ provider: 'validate-file-fixture', status: 'pass', allPass: true, summary: 'semantic PASS', details: [], warnings: [], buildArtifactsHash: 'f'.repeat(64) }));\n`;
    const rewriting = seed('rewriting', REWRITING);
    const withJson = rewriting.runCli(['--json']);
    check(readFileSync(join(rewriting.mainDist, 'x.js'), 'utf8').includes('rewritten by validate.ts'), 'the validate file must have rewritten dist');
    expectRepaired(withJson.status !== 0, 'an exit-zero validate file that rewrote dist was reported successful with --json');
    expectRepaired(withJson.text.includes('build_artifacts_changed_by_non_build_command'), `--json output does not carry the executor diagnostic (${withJson.text.slice(0, 300)})`);
    expectRepaired(rewriting.evidence()?.result !== 'PASS', 'a PASS was persisted for a validate file that rewrote the artifacts it tested');
    expectRepaired(rewriting.evidence()?.buildArtifactsHash !== 'f'.repeat(64), 'the binding printed by the validate file reached the evidence');
    // The synthetic certification window authorizes exactly one heavy execution
    // per fixture (a second run is refused as pre_cert_window_already_consumed
    // before it renders anything), so the plain-text scenario gets its own.
    const rewritingPlain = seed('rewriting-plain', REWRITING);
    const plain = rewritingPlain.runCli([]);
    check(readFileSync(join(rewritingPlain.mainDist, 'x.js'), 'utf8').includes('rewritten by validate.ts'), 'the validate file must have rewritten dist (plain-text run)');
    expectRepaired(plain.status !== 0, 'an exit-zero validate file that rewrote dist was reported successful without --json');
    expectRepaired(plain.text.includes('build_artifacts_changed_by_non_build_command'), `plain-text output does not carry the executor diagnostic (${plain.text.slice(0, 300)})`);
  } finally {
    rmTree(handlerSandbox);
  }
}

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-build-artifact-binding: ${checks} checks passed`);
