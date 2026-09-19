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
import { closeSync, cpSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const { evaluateRoutineValidationReuse, buildRoutineValidationIdentity } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { evaluateValidationEvidenceAdmissibility } = await import('../packages/main/src/core/validation-evidence-admissibility.ts');
const { currentGitHead, currentMaterialHash, currentStoryFilesHash } = await import('../packages/main/src/core/evidence-freshness.ts');
const { runDoneRequiredValidation, evaluateDoneRequiredEvidence, validateReceiptBuildBinding, doneRequiredProtectionRefusal } = await import('../packages/main/src/core/done-required-validation.ts');
const { executeValidationPlan, runValidationCommand, evaluatePlanBuildArtifactsBinding: executorRules } = await import('../packages/main/src/core/validation-executor.ts');
const { probeValidationCausalPreflightFacts } = await import('../packages/main/src/handlers/verifier.ts');
const { acquireOwnerLease } = await import('../packages/main/src/core/story-owner-lease.ts');
const { StoryStore } = await import('../packages/main/src/core/store.ts');
const { resetConfigCache } = await import('../packages/main/src/core/config.ts');
const { persistSyntheticAdmittedWindowForTest } = await import('../packages/main/src/core/certification-window.ts');
const { deriveCertificationDomainInputHashes } = await import('../packages/main/src/handlers/certification-window.ts');
// Present only after the repair. Used to build routine evidence exactly as the
// repaired writer does; never used as the subject of an assertion.
const identityModule = await import('../packages/main/src/core/build-artifacts-identity.ts').catch(() => null);
const protectionModule = await import('../packages/main/src/core/build-artifacts-protection.ts').catch(() => null);
// One handle for the whole binding surface: the identity digest, the shared
// build recogniser, and the write-protection resolver and contract.
const binding = identityModule ? { ...identityModule, ...(protectionModule ?? {}) } : null;

const MARKER = 'stale build artifacts admitted as fresh validation evidence';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const sandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-'));
const red = [];
let checks = 0;
// Whether THIS host demonstrably denies artifact writes (set once the resolver has run).
// Sections that need enforcement to mean anything run only on such a host; the
// others assert the fail-closed outcome instead.
let hostEnforced = false;
function check(value, message) { assert(value, message); checks++; }
function expectRepaired(value, message) { if (value) checks++; else red.push(message); }
function git(root, args) { return execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
/** spawnSync a wrapped launch, delivering its confidential payload (if any) on the descriptor the mechanism named. */
function spawnWrapped(launch, options = {}) {
  if (!launch.confidential) return spawnSync(launch.command, launch.args, { encoding: 'utf8', env: launch.env, timeout: 20_000, ...options });
  const file = join(sandbox, `confidential-${process.pid}-${Math.random().toString(16).slice(2)}`); writeFileSync(file, launch.confidential.payload);
  const fd = openSync(file, 'r');
  const stdio = ['ignore', 'pipe', 'pipe']; while (stdio.length < launch.confidential.fd) stdio.push('ignore'); stdio[launch.confidential.fd] = fd;
  try { return spawnSync(launch.command, launch.args, { encoding: 'utf8', env: launch.env, timeout: 20_000, ...options, stdio }); } finally { closeSync(fd); rmSync(file, { force: true }); }
}
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
    ...(recordedBuild ? { buildArtifactsHash: recordedBuild, buildArtifactsProtection: 'enforced:sandbox-exec' } : {}),
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

  // Audit #7: framing. `path\0bytes\0` let a single file whose bytes contain
  // NUL collide with two files: a.js = X\0b.js\0Y hashed exactly like the pair
  // a.js = X, b.js = Y. Both trees are valid JavaScript; the pair passes and the
  // single file fails (b.js is missing), so a PASS earned on the pair could be
  // reused on the single file. Every field is now length-framed.
  const distRoot = join(root, 'packages/main/dist');
  const COLLIDE_X = 'require("./b.js"); //';
  const COLLIDE_Y = 'process.exit(0);';
  writeFileSync(join(distRoot, 'a.js'), COLLIDE_X);
  writeFileSync(join(distRoot, 'b.js'), COLLIDE_Y);
  const pairIdentity = currentBuild();
  rmSync(join(distRoot, 'b.js'));
  writeFileSync(join(distRoot, 'a.js'), `${COLLIDE_X}\0b.js\0${COLLIDE_Y}`);
  const singleIdentity = currentBuild();
  if (binding) {
    expectRepaired(Boolean(pairIdentity) && Boolean(singleIdentity) && pairIdentity !== singleIdentity,
      'two different artifact trees share a build identity (NUL bytes inside a file collide with the path/content framing)');
    const pairEvidence = { ...evidence, buildArtifactsHash: pairIdentity };
    const pairReuse = evaluateRoutineValidationReuse({
      root, gitCwd: root, evidence: pairEvidence, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
      currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, clean: true, headBefore: head, headAfter: head,
      currentBuildArtifactsHash: singleIdentity,
    });
    expectRepaired(pairReuse.reusable === false && pairReuse.refusalReasons.includes('build-artifacts-hash-changed-or-missing'),
      `a PASS earned on the two-file tree was reusable on the colliding single-file tree (reasons=${pairReuse.refusalReasons.join(',')})`);
    const pairAdmission = evaluateValidationEvidenceAdmissibility({
      evidence: pairEvidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage',
      blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    });
    expectRepaired(pairAdmission.ok === false && pairAdmission.reasonCodes.includes('build_artifacts_mismatch'),
      `a PASS earned on the two-file tree was admissible on the colliding single-file tree (codes=${pairAdmission.reasonCodes.join(',')})`);
  }
  rmSync(join(distRoot, 'a.js'));
  check(currentBuild() === recordedBuild, 'removing the collision files restores the recorded identity');

  // Audit #10 (3): a binding recorded without enforced write protection is an
  // observation of the bytes at the command boundaries, never proof of what
  // the commands executed. It is refused for reuse and admission; a project
  // with no artifact trees at all records `not-applicable` and is accepted.
  if (binding) {
    const withLabel = (label) => ({ ...evidence, ...(label === undefined ? { buildArtifactsProtection: undefined } : { buildArtifactsProtection: label }) });
    const reuseWith = (ev) => evaluateRoutineValidationReuse({
      root, gitCwd: root, evidence: ev, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
      currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, clean: true, headBefore: head, headAfter: head,
      currentBuildArtifactsHash: currentBuild(),
    });
    const admitWith = (ev) => evaluateValidationEvidenceAdmissibility({
      evidence: ev, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage',
      blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
    });
    const unenforced = withLabel('unenforced:no artifact write-protection mechanism is implemented for platform win32');
    expectRepaired(reuseWith(unenforced).refusalReasons.includes('build-artifacts-protection-unenforced'),
      `a PASS recorded without enforced protection was reusable (reasons=${reuseWith(unenforced).refusalReasons.join(',')})`);
    expectRepaired(admitWith(unenforced).reasonCodes.includes('build_artifacts_protection_unenforced'),
      `a PASS recorded without enforced protection was admissible (codes=${admitWith(unenforced).reasonCodes.join(',')})`);
    const unlabeled = withLabel(undefined);
    expectRepaired(reuseWith(unlabeled).refusalReasons.includes('build-artifacts-protection-unenforced'), 'a PASS recording no protection at all was reusable');
    expectRepaired(admitWith(unlabeled).reasonCodes.includes('build_artifacts_protection_unenforced'), 'a PASS recording no protection at all was admissible');
    // Audit #14 (2): the retired not-applicable exemption is a bypass (a
    // command can create, execute and remove a tree inside its window); it
    // never satisfies the contract.
    const notApplicable = withLabel('not-applicable:no-artifact-trees');
    expectRepaired(reuseWith(notApplicable).refusalReasons.includes('build-artifacts-protection-unenforced'), 'a PASS recorded under the retired not-applicable label was reusable');
    expectRepaired(admitWith(notApplicable).reasonCodes.includes('build_artifacts_protection_unenforced'), 'a PASS recorded under the retired not-applicable label was admissible');
    check(reuseWith(evidence).reusable === true && admitWith(evidence).ok === true, 'control: the enforced recorded PASS is still reusable and admissible');
  }

  // Audit #10 (4)/(5): the protection contract and the build recogniser.
  if (binding?.artifactProtectionSatisfied && binding?.logicalCommandCwd) {
    const sat = binding.artifactProtectionSatisfied;
    check(sat('enforced:sandbox-exec') && sat('enforced:bwrap'), 'enforced labels satisfy the contract');
    // Audit #18 (2): a plan of registered builds and nothing else is explicitly
    // build-only, admissible on its own terms, and never outranks a test label.
    if (typeof binding.weakestProtectionLabel === 'function' && binding.BUILD_ONLY_PROTECTION_LABEL) {
      const weakest = binding.weakestProtectionLabel; const buildOnly = binding.BUILD_ONLY_PROTECTION_LABEL;
      expectRepaired(sat(buildOnly), 'the build-only label does not satisfy the contract, so a build-only plan can never be admitted');
      expectRepaired(sat('not-applicable:no-artifact-contract'), 'a project without the artifact contract can never be admitted');
      expectRepaired(weakest([buildOnly, 'enforced:sandbox-exec']) === 'enforced:sandbox-exec' && weakest(['enforced:sandbox-exec', buildOnly]) === 'enforced:sandbox-exec',
        'a build-only member outranked an enforced test label');
      expectRepaired(weakest([buildOnly, 'enforced:sandbox-exec', 'unenforced:x']) === 'unenforced:x' && weakest([undefined, buildOnly]) === buildOnly && weakest([]) === undefined,
        'the weakest-label order is not unenforced < build-only < enforced');
    } else {
      expectRepaired(false, 'core/build-artifacts-protection exports no weakestProtectionLabel / BUILD_ONLY_PROTECTION_LABEL');
    }
    expectRepaired(!sat('unenforced:x') && !sat('registered-build:writes-permitted') && !sat('not-applicable:no-artifact-trees') && !sat(undefined) && !sat(''),
      'an unenforced, retired not-applicable, registered-build, empty or missing label satisfied the executed-build contract');
    // Platform-aware: the mechanism this host is expected to establish, or that
    // it must honestly report as unavailable. macOS: sandbox-exec, which also
    // denies creating an absent tree. Linux with bwrap on PATH: bwrap over
    // existing trees only, so a treeless project is unenforced there (a tree
    // could be created, executed and removed). Anything else: unenforced.
    const bwrapOnPath = process.platform === 'linux' && (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, 'bwrap')));
    const expectedMechanism = process.platform === 'darwin' ? 'enforced:sandbox-exec' : bwrapOnPath ? 'enforced:bwrap' : null;
    const resolved = binding.resolveArtifactWriteProtection(root);
    hostEnforced = resolved.enforced === true;
    if (expectedMechanism === 'enforced:sandbox-exec') {
      expectRepaired(resolved.enforced === true && resolved.label === expectedMechanism,
        `on this host the resolver did not establish and self-test ${expectedMechanism} for a project with artifact trees (${resolved.label})`);
    } else if (expectedMechanism === 'enforced:bwrap') {
      // A bwrap file on PATH is discovery, not enforcement: where the wrapper
      // cannot operate (no user namespaces, say) the resolver must say so,
      // and the fail-closed paths below are what this host then exercises.
      expectRepaired((resolved.enforced === true && resolved.label === expectedMechanism) || (resolved.enforced === false && resolved.label.startsWith('unenforced:bwrap')),
        `with bwrap on PATH the resolver must either demonstrate enforcement or report the wrapper's own failure (${resolved.label})`);
      console.log(`bwrap on PATH: resolver reports ${resolved.label}`);
    } else {
      expectRepaired(resolved.enforced === false && resolved.label.startsWith('unenforced:'),
        `a host with no write-protection mechanism must report a project with artifact trees as unenforced (${resolved.label})`);
    }
    // Audit #21 (3): a project without the compiled-artifact contract (no
    // self-host layout marker, no artifact tree) records that explicitly, on
    // every platform, instead of being refused for lacking trees it never
    // had; the layout marker alone brings the contract back.
    // Audit #22 (2): absence alone is never an exemption (a command could
    // create, execute and remove a tree inside its own window): a project
    // with nothing at the artifact paths is exempt only when its tracked
    // config DECLARES the contract inapplicable; otherwise the contract
    // applies and this host enforces it (macOS denies creating the trees).
    const treeless = join(sandbox, 'treeless'); mkdirSync(treeless);
    const treelessProtection = binding.resolveArtifactWriteProtection(treeless);
    if (process.platform === 'darwin') {
      expectRepaired(treelessProtection.enforced === true && treelessProtection.label === 'enforced:sandbox-exec', `on macOS a project that has not declared the contract inapplicable is protected against creating the trees (${treelessProtection.label})`);
    } else {
      expectRepaired(treelessProtection.label !== 'not-applicable:no-artifact-contract', `absence alone exempted a project from the contract (${treelessProtection.label})`);
    }
    const declared = join(sandbox, 'declared-none'); mkdirSync(declared);
    writeFileSync(join(declared, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', artifactContract: 'none' }));
    const declaredProtection = binding.resolveArtifactWriteProtection(declared);
    expectRepaired(declaredProtection.enforced === false && declaredProtection.label === 'not-applicable:no-artifact-contract',
      `a project that declares the contract inapplicable and has nothing at the artifact paths must record not-applicable:no-artifact-contract (${declaredProtection.label})`);
    if (typeof binding.projectHasArtifactContract === 'function') {
      check(binding.projectHasArtifactContract(treeless) === true && binding.projectHasArtifactContract(declared) === false && binding.projectHasArtifactContract(root) === true, 'the contract applies unless declared inapplicable with nothing at the artifact paths');
      // Audit #22 (1): any ENTRY at a root's path, or a path that cannot be
      // inspected, brings the contract (and the identity walker's refusal)
      // even without the layout marker and with the other root absent.
      for (const [name, make] of [
        ['symlink', (dir) => { mkdirSync(join(dir, 'packages/main'), { recursive: true }); mkdirSync(join(dir, 'elsewhere')); symlinkSync(join(dir, 'elsewhere'), join(dir, 'packages/main/dist'), 'dir'); }],
        ['regular file', (dir) => { mkdirSync(join(dir, 'packages/main'), { recursive: true }); writeFileSync(join(dir, 'packages/main/dist'), 'not a tree\n'); }],
      ]) {
        const invalid = join(sandbox, `invalid-${name.replace(/\s+/g, '-')}`); mkdirSync(invalid);
        writeFileSync(join(invalid, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', artifactContract: 'none' }));
        make(invalid);
        expectRepaired(binding.projectHasArtifactContract(invalid) === true, `a ${name} at an artifact root's path did not bring the contract`);
        expectRepaired(binding.currentBuildArtifactsHash(invalid) === undefined, `a ${name} at an artifact root's path was digested as a valid identity`);
        expectRepaired(binding.resolveArtifactWriteProtection(invalid).label !== 'not-applicable:no-artifact-contract', `a ${name} at an artifact root's path was exempted from the contract`);
      }
      if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
        const opaque = join(sandbox, 'invalid-eacces'); mkdirSync(join(opaque, 'packages/main'), { recursive: true });
        writeFileSync(join(opaque, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', artifactContract: 'none' }));
        chmodSync(join(opaque, 'packages/main'), 0o000);
        try {
          expectRepaired(binding.projectHasArtifactContract(opaque) === true && binding.currentBuildArtifactsHash(opaque) === undefined, 'an artifact root whose parent cannot be inspected was exempted or digested');
        } finally { chmodSync(join(opaque, 'packages/main'), 0o755); }
      }
      const markerOnly = join(sandbox, 'marker-only'); mkdirSync(join(markerOnly, 'packages/main'), { recursive: true });
      writeFileSync(join(markerOnly, 'packages/main/package.json'), '{"name":"marker-only","private":true}\n');
      check(binding.projectHasArtifactContract(markerOnly) === true, 'the layout marker alone establishes the contract');
      const markerProtection = binding.resolveArtifactWriteProtection(markerOnly);
      if (process.platform === 'darwin') {
        check(markerProtection.enforced === true && markerProtection.label === 'enforced:sandbox-exec', `on macOS a self-host layout with no artifact trees yet is protected against creating them (${markerProtection.label})`);
      } else {
        check(markerProtection.label !== 'not-applicable:no-artifact-contract', `a self-host layout is never exempt (${markerProtection.label})`);
      }
      if (binding.currentBuildArtifactsHash) {
        const declaredIdentity = binding.currentBuildArtifactsHash(declared);
        check(/^[a-f0-9]{64}$/.test(declaredIdentity ?? '') && declaredIdentity !== binding.currentBuildArtifactsHash(markerOnly) && declaredIdentity !== binding.currentBuildArtifactsHash(treeless),
          'a project that declared the contract inapplicable has a definite identity distinct from any absent-tree layout under the contract');
      }
    } else {
      expectRepaired(false, 'core/build-artifacts-identity exports no projectHasArtifactContract');
    }
    // Audit #11 (2): the self-test probes every configured root, and bwrap is
    // never reported as enforcing while a configured root is absent (an absent
    // root would stay creatable inside its namespace).
    const protectionSource = readFileSync(join(repoRoot, 'packages/main/src/core/build-artifacts-protection.ts'), 'utf8');
    expectRepaired(protectionSource.includes('for (const root of allRoots) {') && protectionSource.includes('self-test on ${root}'),
      'the protection self-test does not probe every configured artifact root (source-text guard)');
    expectRepaired(protectionSource.includes('const absent = allRoots.filter((root) => !existingRoots.includes(root));') && protectionSource.includes('bwrap cannot protect the absent artifact root(s)'),
      'bwrap can be reported as enforcing while a configured artifact root is absent (source-text guard)');
    // Audit #11 (1): a resolution is valid for one moment. After a registered
    // build, or once a tree exists where the not-applicable exemption was
    // granted, the protection must be re-resolved before a test launches.
    if (binding.artifactProtectionStale && binding.hasAnyArtifactRoot) {
      const stale = binding.artifactProtectionStale;
      expectRepaired(stale({ label: 'not-applicable:no-artifact-trees' }, { buildRanSinceResolve: false, anyRootExists: true }) === true
        && stale({ label: 'not-applicable:no-artifact-contract' }, { buildRanSinceResolve: false, anyRootExists: true }) === true,
        'a not-applicable exemption stayed valid after an artifact tree (or the layout marker) appeared');
      expectRepaired(stale({ label: 'enforced:sandbox-exec' }, { buildRanSinceResolve: true, anyRootExists: true }) === true
        && stale({ label: 'not-applicable:no-artifact-trees' }, { buildRanSinceResolve: true, anyRootExists: false }) === true,
        'a protection resolved before a registered build stayed valid after it');
      check(stale({ label: 'not-applicable:no-artifact-trees' }, { buildRanSinceResolve: false, anyRootExists: false }) === false, 'control: the exemption holds while no tree exists');
      check(stale({ label: 'enforced:sandbox-exec' }, { buildRanSinceResolve: false, anyRootExists: true }) === false, 'control: an enforced resolution holds until a build runs');
      check(binding.hasAnyArtifactRoot(root) === true && binding.hasAnyArtifactRoot(treeless) === true && binding.hasAnyArtifactRoot(declared) === false, 'hasAnyArtifactRoot reports the contract (trees, or an undeclared project) and not a declared-none project');
      const executorSource2 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
      expectRepaired(executorSource2.includes("if (buildArtifactsRole === 'test' && artifactProtectionStale(artifactWriteProtection, { buildRanSinceResolve, anyRootExists: hasAnyArtifactRoot(artifactsRoot, projectRoot) })) {")
        && executorSource2.includes("if (buildArtifactsRole === 'build') buildRanSinceResolve = true;"),
        'the executor does not re-resolve protection before a test that follows a registered build or a newly created tree (source-text guard)');
      const doneRequiredSource3 = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
      expectRepaired(doneRequiredSource3.includes('if (!commandIsRegisteredBuild && artifactProtectionStale(artifactWriteProtection, { buildRanSinceResolve, anyRootExists: hasAnyArtifactRoot(args.gitCwd, args.projectRoot) })) {')
        && doneRequiredSource3.includes('protectionRefusal = doneRequiredProtectionRefusal(artifactWriteProtection.label, policy.commands.slice(i), args.projectRoot, args.gitCwd, canonicalLaunchCwds.slice(i));')
        && doneRequiredSource3.includes('if (commandIsRegisteredBuild) buildRanSinceResolve = true;'),
        'the DONE-required writer does not re-resolve protection (and re-decide the refusal) before a non-build receipt that follows a registered build (source-text guard)');
      // Audit #11 (5): scheduling and launch classify a build the same way.
      // Audit #30 (1): scheduling, the build wave and the launch-time role all
      // read ONE binding derived from the pinned canonical launch directory.
      expectRepaired(executorSource2.includes("isRegisteredPackagesMainBuildCommand(entry.command, projectRoot, artifactsRoot, canonicalLaunchCwds.get(entry.commandIndex)) ? 'build' as const : 'test' as const")
        && executorSource2.includes("buildRoles.get(entry.commandIndex) === 'build' ? { ...entry, priority: (entry.priority ?? 0) + 1 } : entry")
        && executorSource2.includes("const buildArtifactsRole = buildRoles.get(entry.commandIndex) ?? 'test';")
        && executorSource2.includes("const buildEntries = entries.filter((entry) => buildRoles.get(entry.commandIndex) === 'build');")
        && !executorSource2.includes('isRegisteredPackagesMainBuildCommand(entry.command, projectRoot, artifactsRoot) ?'),
        'build classification is not pinned to the canonical launch directory for scheduling, the build wave and the launch role alike (source-text guard)');
      expectRepaired(doneRequiredSource3.includes('isRegisteredPackagesMainBuildCommand(command, args.projectRoot, args.gitCwd, canonicalLaunchCwds[i])')
        && doneRequiredSource3.includes('doneRequiredProtectionRefusal(artifactWriteProtection.label, policy.commands, args.projectRoot, args.gitCwd, canonicalLaunchCwds)')
        && doneRequiredSource3.includes('cwd: canonicalLaunchCwds[i],'),
        'the DONE-required writer classifies or receipts a command on the declared cwd instead of the pinned launch directory (source-text guard)');
    } else {
      expectRepaired(false, 'core/build-artifacts-protection exports no artifactProtectionStale / hasAnyArtifactRoot');
    }
    // (5) one recogniser, judged on the logical cwd.
    const npmBuild = (cwd) => ({ command: 'npm', args: ['run', 'build'], cwd });
    check(binding.isRegisteredPackagesMainBuildCommand(npmBuild('packages/main'), root), 'control: relative packages/main cwd is a registered build');
    expectRepaired(binding.isRegisteredPackagesMainBuildCommand(npmBuild(join(root, 'packages/main')), root), 'a build declared with an absolute cwd was not recognised');
    expectRepaired(binding.isRegisteredPackagesMainBuildCommand(npmBuild('./packages/../packages/main'), root), 'a build declared with a non-normalised relative cwd was not recognised');
    expectRepaired(binding.isRegisteredPackagesMainBuildCommand(npmBuild('packages/main/'), root), 'a build declared with a trailing slash was not recognised');
    const linkedRoot = join(sandbox, 'linked-root'); symlinkSync(root, linkedRoot, 'dir');
    expectRepaired(binding.isRegisteredPackagesMainBuildCommand(npmBuild(join(root, 'packages/main')), linkedRoot), 'a build under a symlinked project root was not recognised');
    rmSync(linkedRoot);
    check(!binding.isRegisteredPackagesMainBuildCommand(npmBuild('packages/utils'), root), 'control: a utils build is not the registered packages/main build');
    // Audit #17 (2): recognition by shape exempts a command from protection,
    // so only a complete, unambiguous invocation qualifies: never a shell
    // command line, never anything appended to the build arguments.
    expectRepaired(!binding.isRegisteredPackagesMainBuildCommand({ command: 'npm', args: ['run', 'build', '&&', 'node', 'swap-test-restore.js'], cwd: 'packages/main', shell: true }, root),
      'a shell command line that starts with the build was exempted from protection as a registered build');
    expectRepaired(!binding.isRegisteredPackagesMainBuildCommand({ command: 'npm', args: ['run', 'build'], cwd: 'packages/main', shell: true }, root),
      'a shell-mode build invocation was recognised by shape (a shell line is one string to the shell)');
    expectRepaired(!binding.isRegisteredPackagesMainBuildCommand({ command: 'npm', args: ['run', 'build', 'extra'], cwd: 'packages/main' }, root)
      && !binding.isRegisteredPackagesMainBuildCommand({ command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build', '--', 'x'], cwd: '.' }, root)
      && !binding.isRegisteredPackagesMainBuildCommand({ command: './tsc', args: ['&&', 'node', 'x.js'], cwd: 'packages/main' }, root),
      'a build invocation with appended arguments was recognised by shape');
    check(binding.isRegisteredPackagesMainBuildCommand({ command: './tsc', args: [], cwd: 'packages/main' }, root) && binding.isRegisteredPackagesMainBuildCommand({ command: 'tsc', args: ['-b'], cwd: 'packages/main' }, root), 'control: the exact tsc forms are recognised');
    check(binding.isRegisteredPackagesMainBuildCommand({ command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'], cwd: './' }, root), 'control: the root-form build with a ./ cwd is recognised');
    check(binding.logicalCommandCwd(root, join(root, 'packages', 'main')) === 'packages/main' && binding.logicalCommandCwd(root, undefined) === '.', 'logical cwd normalises absolute and empty cwds');
    // Audit #27 (1): the cwd is judged exactly where the launcher runs it.
    // Nothing is trimmed and no separator is rewritten on POSIX, where a
    // backslash or a trailing space is part of a directory's name: such a cwd
    // names ANOTHER directory and never earns the build exemption.
    expectRepaired(!binding.isRegisteredPackagesMainBuildCommand(npmBuild('packages/main '), root) && !binding.isRegisteredPackagesMainBuildCommand(npmBuild(' packages/main'), root)
      && binding.logicalCommandCwd(root, 'packages/main ') === 'packages/main ',
      'a cwd with surrounding whitespace was trimmed into the packages/main build');
    if (process.platform !== 'win32') {
      expectRepaired(!binding.isRegisteredPackagesMainBuildCommand(npmBuild('packages\\main'), root) && !binding.isRegisteredPackagesMainBuildCommand(npmBuild(join(root, 'packages\\main')), root),
        'a cwd naming the POSIX directory packages\\main was recognised as the packages/main build');
      expectRepaired(binding.logicalCommandCwd(root, 'packages\\main') === 'packages\\main', `the logical cwd rewrote a POSIX backslash (${binding.logicalCommandCwd(root, 'packages\\main')})`);
      // The DONE-required receipt recogniser judges the same way: a PASS
      // receipt from the other directory that rewrote dist is a non-build
      // rewrite, while the genuine build's receipt is not.
      const otherReceipt = (cwd) => [{ label: 'build', status: 'PASS', command: 'npm', args: ['run', 'build'], cwd: join(root, cwd), buildArtifactsBefore: 'a'.repeat(64), buildArtifactsAfter: 'b'.repeat(64), buildArtifactsProtection: 'enforced:sandbox-exec' }];
      const misnamed = validateReceiptBuildBinding({ receipts: otherReceipt('packages\\main'), buildArtifactsHash: 'b'.repeat(64) }, root, [{ label: 'build', command: 'npm', args: ['run', 'build'], cwd: 'packages\\main' }], root);
      expectRepaired(misnamed.some((reason) => reason.startsWith('build-artifacts-changed-during-command[0]')),
        `a DONE-required receipt from the POSIX directory packages\\main was accepted as the registered build (${misnamed.join(' | ') || 'no reason'})`);
      const genuine = validateReceiptBuildBinding({ receipts: otherReceipt('packages/main'), buildArtifactsHash: 'b'.repeat(64) }, root, [{ label: 'build', command: 'npm', args: ['run', 'build'], cwd: 'packages/main' }], root);
      check(!genuine.some((reason) => reason.startsWith('build-artifacts-changed-during-command')), 'control: the genuine build receipt is recognised');
    }
    if (typeof binding.launchedCommandCwd === 'function') {
      check(binding.launchedCommandCwd(root, undefined) === root && binding.launchedCommandCwd(root, 'packages/main ') === join(root, 'packages/main ') && binding.launchedCommandCwd(root, join(root, 'x')) === join(root, 'x'),
        'launchedCommandCwd resolves exactly as the executor does');
    } else {
      expectRepaired(false, 'core/build-artifacts-identity exports no launchedCommandCwd');
    }
  } else {
    expectRepaired(false, 'core/build-artifacts-identity exports no logicalCommandCwd, or the protection module is not loadable');
  }
  check(reuse().reusable === true && admissibility().ok === true, 'control: the recorded PASS is admissible again after the collision files are removed');

  // Audit #21 (1): the execute bit is part of what a command finds. Identical
  // bytes with the bit flipped are a different build.
  {
    const before = binding ? binding.currentBuildArtifactsHash(root) : undefined;
    chmodSync(probe, 0o755);
    try {
      if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) !== before, 'flipping an artifact\'s execute bit left the identity unchanged');
      const flipped = reuse();
      expectRepaired(flipped.reusable === false && flipped.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS after an artifact's execute bit changed (reasons=${flipped.refusalReasons.join(',')})`);
      expectRepaired(admissibility().ok === false && admissibility().reasonCodes.includes('build_artifacts_mismatch'), `admissibility accepted a PASS after an artifact's execute bit changed (codes=${admissibility().reasonCodes.join(',')})`);
    } finally {
      chmodSync(probe, 0o644);
    }
    check(reuse().reusable === true && admissibility().ok === true, 'restoring the execute bit restores the recorded identity');
    // Audit #22 (3): the exact execute mask, not "any bit": 0755 and 0655 are
    // different builds to the owner who runs them.
    if (binding) {
      chmodSync(probe, 0o755); const owner = binding.currentBuildArtifactsHash(root);
      chmodSync(probe, 0o655); const notOwner = binding.currentBuildArtifactsHash(root);
      chmodSync(probe, 0o644);
      expectRepaired(Boolean(owner) && Boolean(notOwner) && owner !== notOwner, 'modes 0755 and 0655 share an artifact identity');
    }
  }

  // Audit #23 (1): a directory's presence is observable (an entry point may
  // probe for it), so an empty directory added under the tree is a different
  // tree even though no file changed.
  {
    const emptyDir = join(mainDist, 'ready');
    mkdirSync(emptyDir);
    try {
      if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) !== recordedBuild, 'adding an empty directory under the tree left the identity unchanged');
      const withDir = reuse();
      expectRepaired(withDir.reusable === false && withDir.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS after an empty directory appeared under the tree (reasons=${withDir.refusalReasons.join(',')})`);
      expectRepaired(admissibility().ok === false && admissibility().reasonCodes.includes('build_artifacts_mismatch'), `admissibility accepted a PASS after an empty directory appeared under the tree (codes=${admissibility().reasonCodes.join(',')})`);
    } finally {
      rmSync(emptyDir, { recursive: true });
    }
    check(reuse().reusable === true && admissibility().ok === true, 'removing the empty directory restores the recorded identity');
  }

  // Audit #27 (2): a directory's search bits are observable (a chdir or an
  // X_OK probe fails on a 0644 directory with identical contents), so they are
  // part of the identity — for every directory below a root and for the root
  // itself — and a PASS bound to the searchable tree is neither reusable nor
  // admissible once they change.
  if (binding) {
    const emptyDir = join(mainDist, 'ready');
    mkdirSync(emptyDir);
    try {
      const searchable = binding.currentBuildArtifactsHash(root);
      chmodSync(emptyDir, 0o644);
      const unsearchable = binding.currentBuildArtifactsHash(root);
      expectRepaired(Boolean(searchable) && Boolean(unsearchable) && searchable !== unsearchable, 'removing an empty directory\'s search bits left the identity unchanged');
      const modeEvidence = { ...evidence, buildArtifactsHash: searchable };
      const modeReuse = evaluateRoutineValidationReuse({
        root, gitCwd: root, evidence: modeEvidence, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
        currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, clean: true, headBefore: head, headAfter: head,
        currentBuildArtifactsHash: currentBuild(),
      });
      expectRepaired(modeReuse.reusable === false && modeReuse.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS after a directory's search bits changed (reasons=${modeReuse.refusalReasons.join(',')})`);
      const modeAdmission = evaluateValidationEvidenceAdmissibility({ evidence: modeEvidence, expectedCommand: modeEvidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root });
      expectRepaired(modeAdmission.ok === false && modeAdmission.reasonCodes.includes('build_artifacts_mismatch'), `admissibility accepted a PASS after a directory's search bits changed (codes=${modeAdmission.reasonCodes.join(',')})`);
      chmodSync(emptyDir, 0o755);
      check(binding.currentBuildArtifactsHash(root) === searchable, 'control: restoring the search bits restores the identity');
      // A directory this process cannot search is unavailable, never digested
      // as empty. Root bypasses directory permissions (DAC), so the refusal is
      // asserted only where the traversal actually fails; a process that can
      // still traverse it must instead see a digest that reflects the mode.
      writeFileSync(join(emptyDir, 'inner.js'), 'process.exit(0);\n');
      chmodSync(emptyDir, 0o755);
      const searchableWithFile = binding.currentBuildArtifactsHash(root);
      chmodSync(emptyDir, 0o644);
      // Traversable only when an lstat INSIDE the directory succeeds; any
      // failure means the refusal is expected (the safe direction).
      let traversable = false;
      try { lstatSync(join(emptyDir, 'inner.js')); traversable = true; } catch { traversable = false; }
      if (!traversable) {
        expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'a non-empty directory without search permission was digested instead of refused');
      } else {
        const privileged = binding.currentBuildArtifactsHash(root);
        expectRepaired(Boolean(privileged) && privileged !== searchableWithFile, 'a process that can still traverse a 0644 directory saw no change in the identity');
        console.log('non-empty unsearchable directory case: this process can traverse it (privileged); asserted the mode-change digest instead of the refusal');
      }
      chmodSync(emptyDir, 0o755);
    } finally {
      try { chmodSync(emptyDir, 0o755); } catch { /* already restored */ }
      rmSync(emptyDir, { recursive: true, force: true });
    }
    check(reuse().reusable === true && admissibility().ok === true, 'control: the recorded PASS is admissible again after the directory is removed');
    // The artifact ROOT's own search bits, on an empty root.
    const permRoot = join(sandbox, 'perm-root'); mkdirSync(join(permRoot, 'packages/main/dist'), { recursive: true }); mkdirSync(join(permRoot, 'packages/utils/dist'), { recursive: true });
    const rootSearchable = binding.currentBuildArtifactsHash(permRoot);
    chmodSync(join(permRoot, 'packages/utils/dist'), 0o644);
    const rootUnsearchable = binding.currentBuildArtifactsHash(permRoot);
    chmodSync(join(permRoot, 'packages/utils/dist'), 0o755);
    expectRepaired(Boolean(rootSearchable) && Boolean(rootUnsearchable) && rootSearchable !== rootUnsearchable, 'removing an empty artifact root\'s search bits left the identity unchanged');
    check(binding.currentBuildArtifactsHash(permRoot) === rootSearchable, 'control: restoring the root\'s search bits restores the identity');
  }

  // Audit #29 (2): entry names are BYTES. A name that is not valid UTF-8 (a raw
  // 0x80) decodes to the same string as a distinct name spelled with U+FFFD,
  // so a string-addressed walker reads one file twice and the other never; a
  // tree holding such a name is unavailable, not digested around it. Where the
  // filesystem refuses the raw name (APFS does) the case says so; the U+FFFD
  // name alone is an ordinary, distinct artifact.
  if (binding) {
    const replacementName = join(mainDist, 'raw-\uFFFD.js');
    const rawName = Buffer.concat([Buffer.from(join(mainDist, 'raw-')), Buffer.from([0x80]), Buffer.from('.js')]);
    writeFileSync(replacementName, 'process.exit(0); // replacement-character name\n');
    let rawCreated = false;
    try {
      const withReplacement = binding.currentBuildArtifactsHash(root);
      check(Boolean(withReplacement) && withReplacement !== recordedBuild, 'control: a U+FFFD-named artifact is a distinct, digestible entry');
      try { writeFileSync(rawName, 'process.exit(0); // raw-byte name\n'); rawCreated = true; } catch (error) { console.log(`raw-byte filename case skipped: this filesystem refuses the name (${error?.code ?? error})`); }
      if (rawCreated) {
        expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'an artifact whose name is not valid UTF-8 was digested (a string-addressed walker collides it with the U+FFFD name)');
        writeFileSync(rawName, 'process.exit(1); // raw-byte name, rewritten\n');
        expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'a rewritten raw-byte-named artifact still yielded an identity');
      }
    } finally {
      if (rawCreated) rmSync(rawName, { force: true });
      rmSync(replacementName, { force: true });
    }
    check(binding.currentBuildArtifactsHash(root) === recordedBuild, 'control: removing both names restores the recorded identity');
  }

  // Audit #14 (1): a symbolic link on the PATH to a tree (`packages/main`)
  // re-targets the whole tree without touching a byte inside it, and no
  // protection of the resolved tree covers the link: identity unavailable.
  {
    const realMain = join(root, 'packages/main.real');
    const linkMain = join(root, 'packages/main');
    execFileSync('mv', [linkMain, realMain]);
    symlinkSync('main.real', linkMain, 'dir');
    try {
      if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'an artifact tree reached through a symbolic-link ancestor was digested as a valid identity');
      const viaLink = reuse();
      expectRepaired(viaLink.reusable === false && viaLink.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS while the artifact tree was reached through a link (reasons=${viaLink.refusalReasons.join(',')})`);
      expectRepaired(admissibility().ok === false && admissibility().reasonCodes.includes('build_artifacts_unavailable'), `admissibility accepted a PASS while the artifact tree was reached through a link (codes=${admissibility().reasonCodes.join(',')})`);
    } finally {
      rmSync(linkMain);
      execFileSync('mv', [realMain, linkMain]);
    }
    check(reuse().reusable === true && admissibility().ok === true, 'restoring the real directory restores the recorded identity');
  }

  // Audit #12 (1): a hard link is a writable alias outside the tree that no
  // protection OF the tree can cover, so a tree containing a multiply-linked
  // file is not one this process can vouch for: identity unavailable, every
  // consumer refuses, and removing the alias restores the identity.
  const alias = join(sandbox, 'x-alias.js');
  linkSync(probe, alias);
  try {
    if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'an artifact with a hard link outside the tree was digested as a valid identity');
    const linkedReuse = reuse();
    expectRepaired(linkedReuse.reusable === false && linkedReuse.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS while an artifact had a writable alias (reasons=${linkedReuse.refusalReasons.join(',')})`);
    const linkedAdmission = admissibility();
    expectRepaired(linkedAdmission.ok === false && linkedAdmission.reasonCodes.includes('build_artifacts_unavailable'), `admissibility accepted a PASS while an artifact had a writable alias (codes=${linkedAdmission.reasonCodes.join(',')})`);
  } finally {
    rmSync(alias);
  }
  check(reuse().reusable === true && admissibility().ok === true, 'removing the alias restores the recorded identity');

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
  // Audit #19 (2): a regular file AT the root's path is not "absent" — it
  // exists, can change, and can change what a command finds there. It is not
  // a tree either: identity unavailable, every consumer refuses.
  writeFileSync(join(root, 'packages/main/dist'), 'not a directory\n');
  try {
    if (binding) expectRepaired(binding.currentBuildArtifactsHash(root) === undefined, 'a regular file at an artifact root\'s path was digested as the absent tree');
    const fileRoot = reuse();
    expectRepaired(fileRoot.reusable === false && fileRoot.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse accepted a PASS while an artifact root was a regular file (reasons=${fileRoot.refusalReasons.join(',')})`);
    expectRepaired(admissibility().ok === false && admissibility().reasonCodes.includes('build_artifacts_unavailable'), `admissibility accepted a PASS while an artifact root was a regular file (codes=${admissibility().reasonCodes.join(',')})`);
  } finally {
    rmSync(join(root, 'packages/main/dist'));
  }

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
function doneRequiredFixture(name, doneRequiredCommands, prepare) {
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
  // Extra committed layout (directories, symbolic links) goes into the base
  // commit, so the admitted window and the receipts bind the same HEAD.
  prepare?.(root);
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'base']);
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

// Audit #31 (1): a receipt records the pinned canonical launch directory, so
// the evaluator must canonicalise the CONFIGURED cwd the same way: a policy
// command declared in a relative symbolic-link cwd (`alias -> actual`, both
// committed) writes a receipt in `actual` and must evaluate as its own PASS
// for as long as the alias is unchanged; once the alias is re-pointed the
// receipt no longer describes where the command would run and is refused.
if (hostEnforced) {
  const aliased = doneRequiredFixture('done-required-alias-cwd', [{ label: 'aliased', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'alias' }], (root) => {
    mkdirSync(join(root, 'actual')); writeFileSync(join(root, 'actual', '.keep'), '');
    mkdirSync(join(root, 'other')); writeFileSync(join(root, 'other', '.keep'), '');
    symlinkSync('actual', join(root, 'alias'), 'dir');
  });
  const aliasedRun = await runDoneRequiredValidation({ projectRoot: aliased.root, storyId: aliased.storyId, store: aliased.store, gitCwd: aliased.root });
  expectRepaired(aliasedRun.status === 'PASS', `a DONE-required command declared in a relative symlink cwd did not run to a PASS (reasons=${aliasedRun.reasons.join(', ')})`);
  expectRepaired(aliasedRun.receipts?.[0]?.cwd === realpathSync(join(aliased.root, 'actual')), `the receipt does not record the canonical launch directory (${aliasedRun.receipts?.[0]?.cwd})`);
  const aliasedEvaluation = evaluateDoneRequiredEvidence({ projectRoot: aliased.root, storyId: aliased.storyId, store: aliased.store, gitCwd: aliased.root });
  expectRepaired(aliasedEvaluation.ok === true && !aliasedEvaluation.reasons.some((reason) => reason.startsWith('receipt-cwd-mismatch')),
    `an unchanged relative symlink cwd is refused by its own receipt (reasons=${aliasedEvaluation.reasons.join(', ')})`);
  rmSync(join(aliased.root, 'alias')); symlinkSync('other', join(aliased.root, 'alias'), 'dir');
  const retargetedEvaluation = evaluateDoneRequiredEvidence({ projectRoot: aliased.root, storyId: aliased.storyId, store: aliased.store, gitCwd: aliased.root });
  check(retargetedEvaluation.ok === false && retargetedEvaluation.reasons.some((reason) => reason.startsWith('receipt-cwd-mismatch')),
    `a receipt written in actual must be refused once the alias points at other (reasons=${retargetedEvaluation.reasons.join(', ')})`);
  rmSync(join(aliased.root, 'alias')); symlinkSync('actual', join(aliased.root, 'alias'), 'dir');
  check(evaluateDoneRequiredEvidence({ projectRoot: aliased.root, storyId: aliased.storyId, store: aliased.store, gitCwd: aliased.root }).ok === true, 'control: pointing the alias back at actual restores the PASS');
}

// Audit #38 (2), DONE-required: the writer launches, receipts and evaluates a
// `..`-after-symlink cwd at the kernel destination.
if (hostEnforced) {
  const dotdot = doneRequiredFixture('done-required-dotdot-cwd', [{ label: 'dotdot', command: 'node', args: ['validate.js'], cwd: 'alias/../checks' }], (root) => {
    mkdirSync(join(root, 'checks')); writeFileSync(join(root, 'checks', 'validate.js'), 'process.exit(1);\n');
    mkdirSync(join(root, 'elsewhere', 'tree'), { recursive: true }); mkdirSync(join(root, 'elsewhere', 'checks'));
    writeFileSync(join(root, 'elsewhere', 'checks', 'validate.js'), 'process.exit(0);\n');
    symlinkSync('elsewhere/tree', join(root, 'alias'), 'dir');
  });
  const dotdotRun = await runDoneRequiredValidation({ projectRoot: dotdot.root, storyId: dotdot.storyId, store: dotdot.store, gitCwd: dotdot.root });
  expectRepaired(dotdotRun.status === 'PASS' && dotdotRun.receipts?.[0]?.cwd === join(realpathSync(dotdot.root), 'elsewhere', 'checks'),
    `the DONE-required writer launched or receipted a \`..\`-after-symlink cwd at the lexical destination (status=${dotdotRun.status}, cwd=${dotdotRun.receipts?.[0]?.cwd}, reasons=${dotdotRun.reasons.join(', ')})`);
  const dotdotEvaluation = evaluateDoneRequiredEvidence({ projectRoot: dotdot.root, storyId: dotdot.storyId, store: dotdot.store, gitCwd: dotdot.root });
  expectRepaired(dotdotEvaluation.ok === true, `the DONE-required evaluation refuses its own receipt for a \`..\`-after-symlink cwd (reasons=${dotdotEvaluation.reasons.join(', ')})`);
}

if (hostEnforced) {
try {
  const f = doneRequiredFixture('done-required', [{ label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
  const evaluate = () => evaluateDoneRequiredEvidence({ projectRoot: f.root, storyId: f.storyId, store: f.store, gitCwd: f.root });
  const evidence = await runDoneRequiredValidation({ projectRoot: f.root, storyId: f.storyId, store: f.store, gitCwd: f.root });
  check(evidence.status === 'PASS', `DONE-required run must PASS (reasons=${evidence.reasons.join(', ')}; receipts=${JSON.stringify((evidence.receipts ?? []).map((receipt) => ({ label: receipt.label, status: receipt.status, exitCode: receipt.exitCode, output: String(receipt.outputTail ?? receipt.output ?? '').slice(-300) })))})`);
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
  expectRepaired(!readFileSync(g.mainFile, 'utf8').includes('rebuilt during the run'),
    'a non-build DONE-required command rewrote the compiled artifacts; the write was not prevented');
  expectRepaired(unregistered.status === 'FAIL',
    `a non-build command that tried to rewrite dist still produced passing DONE-required evidence (status=${unregistered.status}, reasons=${unregistered.reasons.join(', ')})`);
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

    // Audits #6/#9: DONE-required evidence is the authoritative executed-build
    // proof, so a receipt whose command ran without enforced write protection
    // could have swapped the artifacts inside its own window and cannot carry
    // that claim, whatever its boundary observations say.
    const unprotected = {
      ...registered,
      receipts: registered.receipts.map((receipt, index) => (index === 1
        ? { ...receipt, buildArtifactsProtection: 'unenforced:no artifact write-protection mechanism is implemented for platform linux' }
        : receipt)),
    };
    h.store.writeDoneRequiredEvidence(h.storyId, unprotected);
    const unprotectedResult = evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root });
    expectRepaired(unprotectedResult.ok === false && unprotectedResult.reasons.some((reason) => reason.startsWith('build-artifacts-protection-unenforced[1]')),
      `a DONE-required receipt that ran without enforced artifact write protection was admitted (reasons=${unprotectedResult.reasons.join(', ')})`);
    const legacyProtection = { ...registered, receipts: registered.receipts.map((receipt, index) => (index === 1 ? { ...receipt, buildArtifactsProtection: undefined } : receipt)) };
    h.store.writeDoneRequiredEvidence(h.storyId, legacyProtection);
    const legacyResult = evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root });
    expectRepaired(legacyResult.ok === false && legacyResult.reasons.some((reason) => reason.startsWith('build-artifacts-protection-unenforced[1]')),
      `a receipt recording no protection at all was admitted (reasons=${legacyResult.reasons.join(', ')})`);
    const notApplicableReceipts = { ...registered, receipts: registered.receipts.map((receipt, index) => (index === 1 ? { ...receipt, buildArtifactsProtection: 'not-applicable:no-artifact-trees' } : receipt)) };
    h.store.writeDoneRequiredEvidence(h.storyId, notApplicableReceipts);
    const retiredLabel = evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root });
    expectRepaired(retiredLabel.ok === false && retiredLabel.reasons.some((reason) => reason.startsWith('build-artifacts-protection-unenforced[1]')),
      `a receipt carrying the retired not-applicable label was admitted (reasons=${retiredLabel.reasons.join(', ')})`);
    h.store.writeDoneRequiredEvidence(h.storyId, registered);
    check(evaluateDoneRequiredEvidence({ projectRoot: h.root, storyId: h.storyId, store: h.store, gitCwd: h.root }).ok === true, 'restoring the enforced receipts makes the PASS admissible again');
    // Audit #10 (4): an unsupported host is refused BEFORE the first launch,
    // with the remedy, not after the whole suite has run for nothing. Pure
    // rule (the resolver cannot be made unenforced on this host), plus a guard
    // that the writer consults it ahead of the command loop.
    // Audit #20 (1): the receipt recogniser judges the DECLARED shell mode of
    // the policy command, not the transport flag the executor records (which
    // is true for every command on Windows).
    {
      const buildArgs = ['--prefix', 'packages/main', 'run', 'build'];
      const identityAfter = binding ? binding.currentBuildArtifactsHash(h.root) : 'x'.repeat(64);
      const transportShellReceipt = { label: 'build', command: 'npm', args: buildArgs, cwd: h.root, shell: true, status: 'PASS', exitCode: 0, buildArtifactsBefore: identityAfter, buildArtifactsAfter: identityAfter, buildArtifactsProtection: 'registered-build:writes-permitted' };
      const declared = validateReceiptBuildBinding({ receipts: [transportShellReceipt], buildArtifactsHash: identityAfter }, h.root, [{ label: 'build', command: 'npm', args: buildArgs, cwd: '.' }], h.root);
      expectRepaired(declared.length === 0, `a Windows-transport shell receipt of a declared (non-shell) build was not recognised as the registered build (${declared.join(' | ')})`);
      const declaredShell = validateReceiptBuildBinding({ receipts: [transportShellReceipt], buildArtifactsHash: identityAfter }, h.root, [{ label: 'build', command: 'npm', args: buildArgs, cwd: '.', shell: true }], h.root);
      check(declaredShell.some((reason) => reason.startsWith('build-artifacts-protection-unenforced[0]')), 'control: a policy that DECLARES a shell command line is not a registered build');
    }
    if (typeof doneRequiredProtectionRefusal === 'function') {
      const unenforcedLabel = 'unenforced:no artifact write-protection mechanism is implemented for platform win32';
      // Only the commands that would run under THIS resolution are judged: a
      // non-build command BEFORE the first registered build is refused up
      // front; one AFTER it is decided after the build re-resolves protection
      // (the build may create the very tree that made the host unenforced).
      const refused = doneRequiredProtectionRefusal(unenforcedLabel, [...REGISTERED_REBUILD_COMMANDS].reverse(), h.root);
      expectRepaired(typeof refused === 'string' && refused.startsWith('build-artifacts-protection-unavailable:') && refused.includes(unenforcedLabel) && refused.includes('(pass)') && refused.includes('nothing was executed'),
        `an unenforced host with a non-build DONE-required command before any build was not refused up front (${refused})`);
      expectRepaired(doneRequiredProtectionRefusal(unenforcedLabel, REGISTERED_REBUILD_COMMANDS, h.root) === undefined,
        'a non-build command that follows the registered build was refused before the build could repair the artifact topology');
      check(doneRequiredProtectionRefusal(unenforcedLabel, [REGISTERED_REBUILD_COMMANDS[0]], h.root) === undefined, 'control: a policy made only of registered builds needs no protection');
      // Linux: the namespace must not expose the host mount namespace through
      // /proc/<host-pid>/root (or cwd, fd) aliases: PID isolation + private /proc.
      const protectionSource3 = readFileSync(join(repoRoot, 'packages/main/src/core/build-artifacts-protection.ts'), 'utf8');
      expectRepaired(protectionSource3.includes("'--unshare-pid', '--proc', '/proc'"), 'the bwrap wrapper exposes the host /proc (source-text guard)');
      // Audit #15 (1): the ancestors of a tree are bound read-only (a mount
      // travels with a renamed directory) with every other child re-bound
      // writable, and the self-test probes that the ancestor cannot be moved.
      // Audit #16 (2) refines audit #15 (1): the ancestors are bind-mounted onto
      // themselves WRITABLE (a mount point cannot be renamed or removed from
      // inside the namespace) instead of read-only, so legitimate writes beside
      // them keep working; the self-test still probes that the ancestor cannot
      // be moved aside.
      expectRepaired(protectionSource3.includes("const binds = [...chain].sort().flatMap((directory) => ['--bind', directory, directory]);") && !protectionSource3.includes("'--ro-bind', projectRoot, projectRoot")
        && protectionSource3.includes("self-test did not deny moving"),
        'the bwrap wrapper leaves the artifact ancestors renameable, makes the project read-only, or does not probe the rename (source-text guard)');
      // Audit #17 (1): the chain reaches the filesystem root, and the self-test
      // probes that the project's own parent cannot be moved aside.
      expectRepaired(protectionSource3.includes("while (dirname(directory) !== directory) { chain.add(directory); directory = dirname(directory); }")
        && protectionSource3.includes("self-test did not deny moving the project's parent"),
        'the bwrap mount chain stops at the project root, so a parent above it can be renamed with every protected mount inside (source-text guard)');
      // Audit #18 (1): the generated bwrap arguments themselves, checked
      // directly (no Linux host needed): the host filesystem first, every
      // ancestor of each tree self-bound EXCEPT the filesystem root, the trees
      // read-only, and the private PID space and /proc AFTER every bind so
      // nothing re-exposes the host's /proc.
      if (typeof binding.bwrapLaunchPrefix === 'function') {
        const prefix = binding.bwrapLaunchPrefix(['/tmp/p/repo/packages/main/dist', '/tmp/p/repo/packages/utils/dist']);
        const pairs = []; for (let i = 0; i + 2 < prefix.length; i++) if (prefix[i] === '--bind' || prefix[i] === '--ro-bind' || prefix[i] === '--dev-bind') pairs.push([prefix[i], prefix[i + 1]]);
        const self = pairs.filter(([flag]) => flag === '--bind').map(([, path]) => path);
        expectRepaired(prefix[0] === '--dev-bind' && prefix[1] === '/' && !self.includes('/') && ['/tmp', '/tmp/p', '/tmp/p/repo', '/tmp/p/repo/packages', '/tmp/p/repo/packages/main', '/tmp/p/repo/packages/utils'].every((dir) => self.includes(dir)),
          `the bwrap chain must self-bind every ancestor up to but excluding the filesystem root (self-binds: ${self.join(', ')})`);
        const lastBind = Math.max(...prefix.map((value, index) => (value === '--bind' || value === '--ro-bind' || value === '--dev-bind' ? index : -1)));
        expectRepaired(prefix.indexOf('--proc') > lastBind && prefix.indexOf('--unshare-pid') > lastBind && prefix.indexOf('--ro-bind') > prefix.lastIndexOf('--bind'),
          `the private /proc must be mounted after every bind, and the trees after their ancestors (${prefix.join(' ')})`);
      } else {
        expectRepaired(false, 'core/build-artifacts-protection exports no bwrapLaunchPrefix');
      }
      // Audit #20 (3): a discoverable wrapper whose startup fails must be
      // reported as unenforced with its own failure, never as enforcement.
      // Exercised on any host through the resolver's platform seam with a
      // wrapper that exits 7 whatever it is asked to run.
      {
        // Audit #38 (1): only a native wrapper is trusted, so every fixture
        // wrapper that must reach the self-test is a compiled program.
        const nativeExitWrapper = (directory, status) => {
          writeFileSync(join(directory, 'wrapper.c'), `int main(void) { return ${status}; }\n`);
          const compiled = spawnSync('cc', ['-std=c11', '-o', join(directory, 'bwrap'), join(directory, 'wrapper.c')], { encoding: 'utf8' });
          check(compiled.status === 0, `control: a native exit-${status} fixture wrapper must compile (${compiled.stderr})`);
        };
        const brokenDir = join(sandbox, 'broken-wrapper'); mkdirSync(brokenDir, { recursive: true });
        nativeExitWrapper(brokenDir, 7);
        // Audit #24 (1): a wrapper this user could replace (it sits in a
        // directory this user can write) is refused before any probe runs,
        // wherever PATH found it; the self-test is reached only through the
        // fixture seam that waives that rule for a disposable wrapper.
        const replaceable = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: brokenDir, cwd: sandbox });
        expectRepaired(replaceable.enforced === false && replaceable.label.includes('could be replaced by a validation command') && /owned by this user|writable by this user/.test(replaceable.label),
          `a wrapper in a directory this user can write was not refused as replaceable (${replaceable.label})`);
        // Audit #28 (1): a failed W_OK check proves nothing for a component
        // this user OWNS (its owner can chmod it writable again), so a
        // read-only user-owned wrapper and a read-only user-owned ancestor
        // are refused as replaceable — without the fixture exemption — and
        // a component whose ownership cannot be inspected is refused too.
        if (process.getuid?.() !== 0) {
          const roDir = join(sandbox, 'ro-owned-wrapper'); mkdirSync(roDir, { recursive: true });
          writeFileSync(join(roDir, 'bwrap'), '#!/bin/sh\nexit 3\n', { mode: 0o555 });
          chmodSync(roDir, 0o555);
          try {
            const roWrapper = binding.wrapperReplaceableBy(join(roDir, 'bwrap'));
            expectRepaired(typeof roWrapper === 'string' && roWrapper.includes('owned by this user'), `a read-only wrapper owned by this user was judged unreplaceable (${roWrapper})`);
            const roAncestor = binding.wrapperReplaceableBy(roDir);
            expectRepaired(typeof roAncestor === 'string' && roAncestor.includes('owned by this user'), `a read-only ancestor directory owned by this user was judged unreplaceable (${roAncestor})`);
            const roResolved = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: roDir, cwd: sandbox });
            expectRepaired(roResolved.enforced === false && roResolved.label.includes('could be replaced by a validation command') && roResolved.label.includes('owned by this user'),
              `the resolver trusted a read-only wrapper this user owns (${roResolved.label})`);
          } finally { chmodSync(roDir, 0o755); }
        }
        const uninspectable = binding.wrapperReplaceableBy(join(sandbox, 'no-such-dir', 'bwrap'));
        expectRepaired(typeof uninspectable === 'string' && uninspectable.includes('cannot be inspected'), `a wrapper whose ownership cannot be inspected was judged unreplaceable (${uninspectable})`);
        const broken = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: brokenDir, cwd: sandbox, unsafeTrustReplaceableWrapperForFixture: true });
        expectRepaired(broken.enforced === false && broken.label.startsWith('unenforced:bwrap self-test'),
          `a discoverable wrapper that cannot operate was not reported as its own unenforced failure (${broken.label})`);
        // Audit #24 (1): a wrapper that merely exits with the "denied" status
        // never earns enforcement: every probe must leave the execution
        // witness that only a probe the wrapper really ran can leave.
        const exit3Dir = join(sandbox, 'exit3-wrapper'); mkdirSync(exit3Dir, { recursive: true });
        nativeExitWrapper(exit3Dir, 3);
        const exit3 = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: exit3Dir, cwd: sandbox, unsafeTrustReplaceableWrapperForFixture: true });
        expectRepaired(exit3.enforced === false && exit3.label.includes('left no execution witness (exit 3)'),
          `a wrapper that only exits 3 was accepted as enforcing (${exit3.label})`);
        const exit3Untrusted = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: exit3Dir, cwd: sandbox });
        expectRepaired(exit3Untrusted.enforced === false && exit3Untrusted.label.includes('could be replaced by a validation command'),
          `an exit-3 wrapper in a writable directory was not refused as replaceable (${exit3Untrusted.label})`);
        if (typeof binding.wrapperReplaceableBy === 'function') {
          expectRepaired(typeof binding.wrapperReplaceableBy(join(exit3Dir, 'bwrap')) === 'string', 'a wrapper in a user-writable directory was judged unreplaceable');
          expectRepaired(typeof binding.wrapperReplaceableBy('/usr/bin/sandbox-exec', 0) === 'string' && binding.wrapperReplaceableBy('/usr/bin/sandbox-exec', 0).includes('root'), 'a root process was not refused as able to replace any wrapper');
          if (process.platform === 'darwin' && process.getuid?.() !== 0) check(binding.wrapperReplaceableBy('/usr/bin/sandbox-exec') === undefined, 'control: the system sandbox-exec is not replaceable by this user');
        } else {
          expectRepaired(false, 'core/build-artifacts-protection exports no wrapperReplaceableBy');
        }
        // Audit #24 (1): the wrapper that passed the self-test is bound by
        // identity and re-verified before every launch. A fixture bwrap that
        // really enforces (it delegates to sandbox-exec with the same profile)
        // earns enforcement; replaced afterwards by an exit-3 script, the
        // resolution reports itself stale, refuses to launch through the
        // replacement, and a fresh resolution refuses the replacement too.
        if (process.platform === 'darwin' && hostEnforced && typeof binding.sandboxExecProfile === 'function') {
          // Audit #38 (1): only a NATIVE wrapper is trusted, so the fixture
          // wrapper is a compiled program: it records the environment it was
          // launched with (the LD_PRELOAD witness), applies `--setenv` the way
          // bwrap does and execs sandbox-exec with the profile for h.root.
          const delegatingDir = join(sandbox, 'delegating-wrapper'); mkdirSync(delegatingDir, { recursive: true });
          const deniedRoots = ['packages/main/dist', 'packages/utils/dist'].map((relative) => join(realpathSync(h.root), relative));
          const wrapperEnvWitness = join(delegatingDir, 'wrapper-env-witness');
          const profilePath = join(delegatingDir, 'profile.sb'); writeFileSync(profilePath, binding.sandboxExecProfile(deniedRoots));
          const nativeWrapperSource = [
            '#include <stdio.h>', '#include <stdlib.h>', '#include <string.h>', '#include <unistd.h>',
            '/* bwrap --args FD: NUL-separated arguments read from a private descriptor; only --setenv NAME VALUE is emulated. */',
            'static void applyArgsFromFd(int fd) {',
            '  static char buffer[1 << 20]; size_t length = 0; ssize_t got;',
            '  while ((got = read(fd, buffer + length, sizeof(buffer) - 1 - length)) > 0) length += (size_t)got;',
            '  buffer[length] = 0; size_t at = 0; const char *tokens[4096]; int count = 0;',
            '  while (at < length && count < 4096) { tokens[count++] = buffer + at; at += strlen(buffer + at) + 1; }',
            '  for (int k = 0; k + 2 < count; ) { if (strcmp(tokens[k], "--setenv") == 0) { setenv(tokens[k + 1], tokens[k + 2], 1); k += 3; } else { k++; } }',
            '}',
            'int main(int argc, char **argv) {',
            '  FILE *witness = fopen(WITNESS_PATH, "w"); if (witness) { const char *preload = getenv("LD_PRELOAD"); fputs(preload ? preload : "unset", witness); fclose(witness); }',
            '  int i = 1; while (i < argc && strcmp(argv[i], "--") != 0) { if (strcmp(argv[i], "--args") == 0 && i + 1 < argc) { applyArgsFromFd(atoi(argv[i + 1])); i += 2; } else if (strcmp(argv[i], "--setenv") == 0) { return 121; /* argv must never carry the environment */ } else { i++; } }',
            '  if (i >= argc) return 125;',
            '  FILE *profileFile = fopen(PROFILE_PATH, "r"); if (!profileFile) return 126;',
            '  static char profile[65536]; size_t length = fread(profile, 1, sizeof(profile) - 1, profileFile); profile[length] = 0; fclose(profileFile);',
            '  char **inner = argv + i + 1; int count = argc - i - 1;',
            '  char **exec = calloc((size_t)count + 4, sizeof(char *)); if (!exec) return 126;',
            '  exec[0] = "sandbox-exec"; exec[1] = "-p"; exec[2] = profile; for (int k = 0; k < count; k++) exec[3 + k] = inner[k];',
            '  execv("/usr/bin/sandbox-exec", exec); perror("execv"); return 127;',
            '}', '',
          ].join('\n');
          writeFileSync(join(delegatingDir, 'bwrap.c'), nativeWrapperSource);
          const compileWrapper = (directory) => spawnSync('cc', ['-std=c11', '-Wall', '-Werror', '-o', join(directory, 'bwrap'), join(delegatingDir, 'bwrap.c'), `-DWITNESS_PATH="${wrapperEnvWitness}"`, `-DPROFILE_PATH="${profilePath}"`], { encoding: 'utf8' });
          const compiled = compileWrapper(delegatingDir);
          check(compiled.status === 0, `control: the native fixture wrapper must compile (${compiled.stderr})`);
          const seam = { platform: 'linux', searchPath: delegatingDir, cwd: sandbox, unsafeTrustReplaceableWrapperForFixture: true };
          const bound = binding.resolveArtifactWriteProtection(h.root, seam);
          check(bound.enforced === true && bound.label === 'enforced:bwrap', `control: a native fixture wrapper that really denies the writes must earn enforcement (${bound.label})`);
          expectRepaired(Array.isArray(bound.interpreters) && bound.interpreters.length === 0, `a native wrapper carries an interpreter chain (${JSON.stringify(bound.interpreters)})`);
          // Audit #25 (1): the wrapper process is launched WITHOUT the
          // variables the dynamic loader honours; they reach only the command
          // inside the sandbox (`--setenv`, placed before `--`). Observed on
          // both sides: the wrapper saw LD_PRELOAD unset, the command saw it.
          // Audit #45 (1): the re-applied variables travel through a private
          // descriptor (`--args FD`), never through argv, so a process listing
          // never sees a credential the launch environment carried.
          let withoutDescriptor = null;
          try { bound.wrap({ command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false, env: { ...process.env, LD_PRELOAD: '/fixture/preload.so' } }); } catch (error) { withoutDescriptor = error; }
          expectRepaired(withoutDescriptor && String(withoutDescriptor.message).includes('[artifact_protection_launch_unsupported]'), `bwrap was handed the environment without a confidential descriptor (${withoutDescriptor ? withoutDescriptor.message : 'no refusal'})`);
          // Audit #46 (1): a NUL inside a value would end one token and begin
          // another (`--bind` after the read-only mounts); refused up front.
          let bwrapNul = null;
          try { bound.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { ...process.env, POS_NUL: `ok\0--bind\0${deniedRoots[0]}\0${deniedRoots[0]}` }, confidentialFd: 3 }); } catch (error) { bwrapNul = error; }
          expectRepaired(bwrapNul && String(bwrapNul.message).includes('[artifact_protection_launch_unsupported]') && String(bwrapNul.message).includes('NUL'), `a NUL-bearing value reached bwrap's argument stream (${bwrapNul ? bwrapNul.message : 'no refusal'})`);
          const preloadLaunch = bound.wrap({ command: process.execPath, args: ['-e', "process.stdout.write('inner=' + process.env.LD_PRELOAD)"], shell: false, env: { ...process.env, LD_PRELOAD: '/fixture/preload.so', POS_SYNTHETIC_SECRET: 'synthetic-credential-0f3a' }, confidentialFd: 3 });
          const argsAt = preloadLaunch.args.indexOf('--args');
          expectRepaired(argsAt >= 0 && preloadLaunch.args[argsAt + 1] === '3' && preloadLaunch.args.indexOf('--') > argsAt && !preloadLaunch.args.some((argument) => argument.includes('/fixture/preload.so') || argument.includes('synthetic-credential-0f3a') || argument === '--setenv')
            && preloadLaunch.confidential?.fd === 3 && preloadLaunch.confidential.payload.toString('utf8').includes('--setenv\0LD_PRELOAD\0/fixture/preload.so\0') && preloadLaunch.confidential.payload.toString('utf8').includes('--setenv\0POS_SYNTHETIC_SECRET\0synthetic-credential-0f3a\0'),
            `the re-applied environment is in bwrap's argv or missing from the confidential payload (${JSON.stringify(preloadLaunch.args.slice(-6))})`);
          expectRepaired(preloadLaunch.env && !('LD_PRELOAD' in preloadLaunch.env) && Object.keys(preloadLaunch.env).every((key) => binding.isWrapperEnvironmentVariable(key)),
            `the bwrap wrapper process was launched with LD_PRELOAD or another withheld variable in its own environment (${Object.keys(preloadLaunch.env).join(',')})`);
          const payloadFile = join(delegatingDir, 'confidential-payload'); writeFileSync(payloadFile, preloadLaunch.confidential.payload);
          const payloadFd = openSync(payloadFile, 'r');
          const preloadRun = spawnSync(preloadLaunch.command, preloadLaunch.args, { encoding: 'utf8', env: preloadLaunch.env, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe', payloadFd] });
          closeSync(payloadFd); rmSync(payloadFile, { force: true });
          expectRepaired(preloadRun.status === 0 && preloadRun.stdout === 'inner=/fixture/preload.so' && readFileSync(wrapperEnvWitness, 'utf8') === 'unset',
            `the wrapper saw LD_PRELOAD=${readFileSync(wrapperEnvWitness, 'utf8')} while the command saw ${JSON.stringify(preloadRun.stdout)} (exit ${preloadRun.status})`);
          // Audit #24 (1): the wrapper that passed the self-test is bound by
          // identity and re-verified before every launch. Replaced by a native
          // program that only exits 3, the resolution reports itself stale,
          // refuses to launch through the replacement, and a fresh resolution
          // refuses the replacement for leaving no witness.
          expectRepaired(bound.wrapper && bound.wrapper.path === realpathSync(join(delegatingDir, 'bwrap')) && /^[a-f0-9]{64}$/.test(bound.wrapper.digest) && typeof bound.verify === 'function' && bound.verify() === undefined,
            'an enforcing resolution does not bind the wrapper executable by identity');
          check(binding.artifactProtectionStale(bound, { buildRanSinceResolve: false, anyRootExists: true }) === false, 'control: the resolution holds while the wrapper is unchanged');
          writeFileSync(join(delegatingDir, 'exit3.c'), 'int main(void) { return 3; }\n');
          const compiledExit3 = spawnSync('cc', ['-std=c11', '-o', join(delegatingDir, 'bwrap'), join(delegatingDir, 'exit3.c')], { encoding: 'utf8' });
          check(compiledExit3.status === 0, `control: the exit-3 replacement must compile (${compiledExit3.stderr})`);
          expectRepaired(typeof bound.verify() === 'string' && bound.verify().includes('changed since it was self-tested'),
            `replacing the wrapper between launches was not detected (${bound.verify()})`);
          expectRepaired(binding.artifactProtectionStale(bound, { buildRanSinceResolve: false, anyRootExists: true }) === true,
            'a resolution whose wrapper was replaced was not reported stale, so the executor would not re-resolve before the next launch');
          let launched = null; let refusal = null;
          try { launched = bound.wrap({ command: process.execPath, args: ['-e', 'process.exit(0)'], shell: false }); } catch (error) { refusal = error; }
          expectRepaired(launched === null && refusal && String(refusal.message).includes('[artifact_protection_wrapper_drift]'),
            `a launch was handed to a wrapper other than the one that passed the self-test (${launched ? JSON.stringify(launched) : refusal?.message})`);
          const rebound = binding.resolveArtifactWriteProtection(h.root, seam);
          expectRepaired(rebound.enforced === false && rebound.label.includes('left no execution witness'),
            `re-resolving against the replacement accepted its exit status as enforcement (${rebound.label})`);
          // Audit #33 / #38 (1): an interpreted wrapper is never trusted. An
          // interpreter reads startup files the LAUNCH chooses before the
          // wrapper's own code runs — zsh reads $HOME/.zshenv — so a launch
          // supplying such a HOME would return the interpreter's clean exit
          // without ever running the command; binding bytes cannot bound that.
          if (typeof binding.wrapperInterpreterChain === 'function') {
            const envShimDir = join(sandbox, 'env-shim'); mkdirSync(envShimDir, { recursive: true });
            writeFileSync(join(envShimDir, 'bwrap'), '#!/usr/bin/env node\nprocess.exit(3)\n', { mode: 0o755 });
            const envShim = binding.resolveArtifactWriteProtection(h.root, { ...seam, searchPath: envShimDir });
            expectRepaired(envShim.enforced === false && envShim.label.includes('resolves its interpreter through PATH'), `a wrapper whose interpreter is resolved through PATH was not refused (${envShim.label})`);
            check(Array.isArray(binding.wrapperInterpreterChain('/usr/bin/sandbox-exec')) && binding.wrapperInterpreterChain('/usr/bin/sandbox-exec').length === 0, 'control: a native executable has an empty interpreter chain');
            const zshShimDir = join(sandbox, 'zsh-shim'); mkdirSync(zshShimDir, { recursive: true });
            writeFileSync(join(zshShimDir, 'bwrap'), `#!/bin/zsh\nwhile [[ "$1" != "--" ]]; do if [[ "$1" == "--setenv" ]]; then export "$2=$3"; shift 3; else shift; fi; done; shift\nexec /usr/bin/sandbox-exec -p "$(cat ${JSON.stringify(profilePath)})" "$@"\n`, { mode: 0o755 });
            // Control: zsh really does run $HOME/.zshenv before the script body,
            // so a launch-chosen HOME decides whether the wrapper runs at all.
            const hijackHome = join(zshShimDir, 'home'); mkdirSync(hijackHome); writeFileSync(join(hijackHome, '.zshenv'), 'exit 0\n');
            const hijacked = spawnSync(join(zshShimDir, 'bwrap'), ['--', process.execPath, '-e', 'process.exit(7)'], { encoding: 'utf8', env: { ...process.env, HOME: hijackHome }, timeout: 20_000 });
            check(hijacked.status === 0, `control: a HOME whose .zshenv exits 0 pre-empts a zsh wrapper entirely (exit ${hijacked.status}, ${(hijacked.stderr || '').slice(0, 80)})`);
            const zshShim = binding.resolveArtifactWriteProtection(h.root, { ...seam, searchPath: zshShimDir });
            expectRepaired(zshShim.enforced === false && zshShim.label.includes('interpreted script') && zshShim.label.includes('/bin/zsh'), `a zsh wrapper was trusted although its startup file is chosen by the launch (${zshShim.label})`);
            const shShimDir = join(sandbox, 'sh-shim'); mkdirSync(shShimDir, { recursive: true });
            writeFileSync(join(shShimDir, 'bwrap'), `#!/bin/sh\nwhile [ "$1" != "--" ]; do if [ "$1" = "--setenv" ]; then export "$2=$3"; shift 3; else shift; fi; done; shift\nexec /usr/bin/sandbox-exec -p "$(cat ${JSON.stringify(profilePath)})" "$@"\n`, { mode: 0o755 });
            const shShim = binding.resolveArtifactWriteProtection(h.root, { ...seam, searchPath: shShimDir });
            expectRepaired(shShim.enforced === false && shShim.label.includes('interpreted script'), `a shell wrapper that really enforces was trusted although it is interpreted (${shShim.label})`);
            const nodeShimDir = join(sandbox, 'node-shim'); mkdirSync(nodeShimDir, { recursive: true });
            writeFileSync(join(nodeShimDir, 'bwrap'), `#!${realpathSync(process.execPath)}\nprocess.exit(3)\n`, { mode: 0o755 });
            const nodeShim = binding.resolveArtifactWriteProtection(h.root, { ...seam, searchPath: nodeShimDir });
            expectRepaired(nodeShim.enforced === false && nodeShim.label.includes('interpreted script'), `a Node-based wrapper was trusted although it is interpreted (${nodeShim.label})`);
          } else {
            expectRepaired(false, 'core/build-artifacts-protection exports no wrapperInterpreterChain');
          }
          // Audit #35 (1): the path a `#!` line DECLARES is resolved one
          // component at a time; every symbolic link on the way is recorded
          // and judged by its own entry (the interpreted wrapper itself is
          // refused, and the refusal names the declared interpreter).
          if (typeof binding.resolvePathRecordingLinks === 'function' && typeof binding.interpreterResolutionDrift === 'function') {
            const aliasShimDir = join(sandbox, 'alias-interpreter-shim'); mkdirSync(aliasShimDir, { recursive: true });
            const interpreterAlias = join(aliasShimDir, 'interp'); symlinkSync('/bin/sh', interpreterAlias);
            const aliasResolution = binding.resolvePathRecordingLinks(interpreterAlias);
            expectRepaired(typeof aliasResolution === 'object' && aliasResolution.canonical === realpathSync('/bin/sh') && aliasResolution.links.some((link) => link.path === realpathSync(aliasShimDir) + '/interp' && link.target === '/bin/sh'),
              `resolving a declared interpreter path did not record the alias it crossed (${JSON.stringify(aliasResolution)})`);
            const aliasEntry = binding.wrapperReplaceableBy(interpreterAlias);
            expectRepaired(typeof aliasEntry === 'string' && aliasEntry.includes('owned by this user'), `a user-owned symbolic-link entry on an interpreter path was judged unreplaceable (${aliasEntry})`);
            writeFileSync(join(aliasShimDir, 'bwrap'), `#!${interpreterAlias}\nexit 3\n`, { mode: 0o755 });
            const aliasChain = binding.wrapperInterpreterChain(join(aliasShimDir, 'bwrap'));
            expectRepaired(Array.isArray(aliasChain) && aliasChain.length === 1 && aliasChain[0].declared === interpreterAlias && aliasChain[0].canonical === realpathSync('/bin/sh') && aliasChain[0].links.length >= 1,
              `the interpreter chain does not keep the declared path and its links (${JSON.stringify(aliasChain)})`);
            const viaAlias = binding.resolveArtifactWriteProtection(h.root, { ...seam, searchPath: aliasShimDir });
            expectRepaired(viaAlias.enforced === false && viaAlias.label.includes('interpreted script') && viaAlias.label.includes(interpreterAlias), `a shim whose interpreter is an alias was trusted (${viaAlias.label})`);
            writeFileSync(join(aliasShimDir, 'fake-sh'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
            const boundInterpreter = { declared: interpreterAlias, links: aliasChain[0].links, canonical: aliasChain[0].canonical };
            check(binding.interpreterResolutionDrift(boundInterpreter) === undefined, 'control: an unchanged alias resolution shows no drift');
            rmSync(interpreterAlias); symlinkSync(join(aliasShimDir, 'fake-sh'), interpreterAlias);
            expectRepaired(typeof binding.interpreterResolutionDrift(boundInterpreter) === 'string' && binding.interpreterResolutionDrift(boundInterpreter).includes('now resolves to'), 're-pointing an interpreter alias is not reported as resolution drift');
          } else {
            expectRepaired(false, 'core/build-artifacts-protection exports no resolvePathRecordingLinks / interpreterResolutionDrift');
          }
          // Audit #37 (2): a declared interpreter path is resolved in FILESYSTEM
          // order, so `..` after a symbolic link steps out of the link's TARGET
          // as the kernel does. Node's own realpath normalises `..` first and
          // reports the wrong executable, so the kernel itself is the control
          // here: executing the shim runs the `sh` under `user`, not `trusted`.
          {
            mkdirSync(join(sandbox, 'dotdot-interpreter'));
            const dotDir = realpathSync(join(sandbox, 'dotdot-interpreter')); mkdirSync(join(dotDir, 'trusted'), { recursive: true }); mkdirSync(join(dotDir, 'user', 'tree'), { recursive: true });
            symlinkSync('/bin/sh', join(dotDir, 'user', 'sh')); writeFileSync(join(dotDir, 'trusted', 'sh'), '#!/bin/sh\nexit 9\n', { mode: 0o755 });
            symlinkSync(join(dotDir, 'user', 'tree'), join(dotDir, 'trusted', 'alias'));
            const declaredInterpreter = `${dotDir}/trusted/alias/../sh`;
            writeFileSync(join(dotDir, 'shim'), `#!${declaredInterpreter}\nexit 3\n`, { mode: 0o755 });
            const kernel = spawnSync(join(dotDir, 'shim'), [], { encoding: 'utf8', timeout: 10_000 });
            check(kernel.status === 3, `control: the kernel resolves the declared interpreter through the link's target (exit ${kernel.status}, signal ${kernel.signal}, ${kernel.error ? kernel.error.message : (kernel.stderr || '').slice(0, 80)})`);
            const walked = binding.resolvePathRecordingLinks(declaredInterpreter);
            expectRepaired(typeof walked === 'object' && walked.canonical === realpathSync('/bin/sh')
              && walked.links.some((link) => link.path === join(dotDir, 'trusted', 'alias')) && walked.links.some((link) => link.path === join(dotDir, 'user', 'sh')),
              `the interpreter resolution normalised \`..\` before following the link (${JSON.stringify(walked)})`);
            const dotChain = binding.wrapperInterpreterChain(join(dotDir, 'shim'));
            expectRepaired(Array.isArray(dotChain) && dotChain[0]?.canonical === realpathSync('/bin/sh') && dotChain[0]?.links.some((link) => link.path === join(dotDir, 'user', 'sh')),
              `the interpreter chain audits an executable the kernel would not run (${JSON.stringify(dotChain)})`);
            mkdirSync(join(dotDir, 'wrapper'));
            writeFileSync(join(dotDir, 'wrapper', 'bwrap'), `#!${declaredInterpreter}\nexit 3\n`, { mode: 0o755 });
            const dotResolved = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: join(dotDir, 'wrapper'), cwd: sandbox });
            expectRepaired(dotResolved.enforced === false && dotResolved.label.includes('could be replaced by a validation command'), `a shim whose kernel-resolved interpreter is user-replaceable was not refused (${dotResolved.label})`);
          }
          // Audit #37 (3): enforcement is never reported without a witnessed,
          // denied probe. A project with no artifact root and no root parent
          // is probed through the first missing protected ancestor.
          if (typeof binding.firstMissingProtectedAncestor === 'function') {
            const bare = join(sandbox, 'bare-project'); mkdirSync(join(bare, 'packages'), { recursive: true });
            expectRepaired(binding.firstMissingProtectedAncestor(join(bare, 'packages/main/dist')) === join(bare, 'packages', 'main'), 'the first missing protected ancestor of a bare project is not packages/main');
            const bareResolved = binding.resolveArtifactWriteProtection(bare);
            check(bareResolved.enforced === true && bareResolved.label === 'enforced:sandbox-exec' && !existsSync(join(bare, 'packages', 'main')), `control: on macOS a bare project is enforced through a denied ancestor probe that leaves nothing behind (${bareResolved.label})`);
            const protectionSource7 = readFileSync(join(repoRoot, 'packages/main/src/core/build-artifacts-protection.ts'), 'utf8');
            expectRepaired(protectionSource7.includes('if (probed === 0) {') && protectionSource7.includes('firstMissingProtectedAncestor(allRoots[0])') && protectionSource7.includes('the topology cannot be tested'),
              'the self-test reports enforcement without any probe when no root parent exists (source-text guard)');
          } else {
            expectRepaired(false, 'core/build-artifacts-protection exports no firstMissingProtectedAncestor');
          }
        }
        // Audit #25 (1): the partition itself, pure: every LD_* / DYLD_* name
        // and glibc's unsecure list is withheld from the wrapper and re-applied
        // inside; everything else reaches the wrapper unchanged.
        if (typeof binding.partitionLaunchEnvironment === 'function') {
          // Audit #33 (1): the wrapper sees ONLY a fixed allowlist; the loader's
          // variables, every interpreter's startup hooks and PATH itself are
          // withheld and re-applied inside.
          const split = binding.partitionLaunchEnvironment({ PATH: '/usr/bin', HOME: '/h', LD_PRELOAD: '/x.so', LD_AUDIT: '/a.so', LD_LIBRARY_PATH: '/l', DYLD_INSERT_LIBRARIES: '/d.dylib', GLIBC_TUNABLES: 'g', TMPDIR: '/t', NODE_OPTIONS: '--require /hook.js', PYTHONPATH: '/p', BASH_ENV: '/b', TERM: 'xterm' });
          expectRepaired(JSON.stringify(split.wrapperEnv) === JSON.stringify({ HOME: '/h', TERM: 'xterm' })
            && JSON.stringify(split.reapplied) === JSON.stringify([['BASH_ENV', '/b'], ['DYLD_INSERT_LIBRARIES', '/d.dylib'], ['GLIBC_TUNABLES', 'g'], ['LD_AUDIT', '/a.so'], ['LD_LIBRARY_PATH', '/l'], ['LD_PRELOAD', '/x.so'], ['NODE_OPTIONS', '--require /hook.js'], ['PATH', '/usr/bin'], ['PYTHONPATH', '/p'], ['TMPDIR', '/t']]),
            `the launch environment partition lets loader variables, interpreter startup hooks or PATH reach the wrapper (${JSON.stringify(split)})`);
          check(binding.isLoaderEnvironmentVariable('LD_AUDIT') && binding.isLoaderEnvironmentVariable('DYLD_FORCE_FLAT_NAMESPACE') && !binding.isLoaderEnvironmentVariable('NODE_OPTIONS'), 'loader-variable classification');
          expectRepaired(typeof binding.isWrapperEnvironmentVariable === 'function' && binding.isWrapperEnvironmentVariable('HOME') && !binding.isWrapperEnvironmentVariable('NODE_OPTIONS') && !binding.isWrapperEnvironmentVariable('PATH'),
            'NODE_OPTIONS or PATH is allowed into the wrapper process');
        } else {
          expectRepaired(false, 'core/build-artifacts-protection exports no partitionLaunchEnvironment');
        }
        // Audit #25 (1), on the real macOS mechanism: sandbox-exec is launched
        // without the loader variables and re-applies them INSIDE the sandbox
        // through /usr/bin/env, so the command still sees its declared
        // environment. (DYLD_INSERT_LIBRARIES is checked in the arguments only:
        // dyld refuses to start a process whose inserted library is missing.)
        if (process.platform === 'darwin' && hostEnforced) {
          const hostProtection = binding.resolveArtifactWriteProtection(h.root);
          // Audit #45 (1) supersedes the env re-application: SIP keeps the
          // platform binary restricted, so the loader ignores DYLD_* for it and
          // the launch environment is handed to sandbox-exec directly; no
          // variable, loader or credential, is ever placed in argv.
          // Audit #46 (2): a restricted wrapper strips DYLD_* from an environment
          // handed to it directly, so the withheld variables are restored INSIDE
          // the sandbox by the /bin/sh trampoline, from a private descriptor.
          const dyldLaunch = hostProtection.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { ...process.env, DYLD_INSERT_LIBRARIES: '/fixture/insert.dylib', LD_PRELOAD: '/fixture/preload.so' }, confidentialFd: 3 });
          const hex = (value) => Buffer.from(value, 'utf8').toString('hex');
          expectRepaired(dyldLaunch.command === '/usr/bin/sandbox-exec' && dyldLaunch.args[0] === '-p' && dyldLaunch.args[2] === '/usr/bin/perl' && dyldLaunch.args[3] === '/dev/fd/3' && dyldLaunch.args[4] === process.execPath && !dyldLaunch.args.includes('/usr/bin/env')
            && !dyldLaunch.args.some((argument) => argument.includes('/fixture/insert.dylib') || argument.includes('/fixture/preload.so'))
            && Object.keys(dyldLaunch.env).every((key) => binding.isWrapperEnvironmentVariable(key))
            && dyldLaunch.confidential?.fd === 3 && dyldLaunch.confidential.payload.toString('utf8').includes(`$ENV{'DYLD_INSERT_LIBRARIES'} = pack('H*', '${hex('/fixture/insert.dylib')}');\n`) && dyldLaunch.confidential.payload.toString('utf8').includes(`$ENV{'LD_PRELOAD'} = pack('H*', '${hex('/fixture/preload.so')}');\n`) && dyldLaunch.confidential.payload.toString('utf8').endsWith('exec { $ARGV[0] } @ARGV or exit 127;\n'),
            `sandbox-exec was launched with loader variables in its own environment, or without the trampoline that restores them inside (${JSON.stringify(dyldLaunch.args.slice(0, 5))}, env keys ${Object.keys(dyldLaunch.env).filter((key) => /^(LD_|DYLD_)/.test(key)).join(',')})`);
          const plainLaunch = hostProtection.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { HOME: process.env.HOME ?? '/', USER: process.env.USER ?? 'user' } });
          check(!plainLaunch.args.includes('/usr/bin/env') && plainLaunch.args[2] === process.execPath, 'control: a launch with nothing to withhold is not routed through /usr/bin/env');
        }
        const executorSource6 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
        expectRepaired(executorSource6.includes('.wrap({ command: command.command, args: command.args, shell: declaredShell, env: childEnv, confidentialFd })') && executorSource6.includes('      env: launch.env,'),
          'the executor spawns the wrapper with the command environment instead of the environment the wrapper returns (source-text guard)');
        const protectionSource6 = readFileSync(join(repoRoot, 'packages/main/src/core/build-artifacts-protection.ts'), 'utf8');
        expectRepaired(protectionSource6.includes("stdio: ['ignore', 'pipe', 'pipe'], env: launch.env });"), 'the self-test launches the wrapper with the auditor process environment instead of the partitioned one (source-text guard)');
        const missing = binding.resolveArtifactWriteProtection(h.root, { platform: 'linux', searchPath: join(sandbox, 'nowhere'), cwd: sandbox });
        check(missing.enforced === false && missing.label.startsWith('unenforced:bwrap (bubblewrap) is not on PATH'), `control: no wrapper on PATH is reported as such (${missing.label})`);
        const unsupported = binding.resolveArtifactWriteProtection(h.root, { platform: 'win32' });
        check(unsupported.enforced === false && unsupported.label.startsWith('unenforced:no artifact write-protection mechanism is implemented for platform win32'), `control: an unsupported platform is reported as such (${unsupported.label})`);
      }
      // Audit #21 (2): the macOS profile denies every ancestor of each tree as
      // a LITERAL (rename, unlink, re-mode of the ancestor itself) up to but
      // excluding the filesystem root, while entries beside them stay writable.
      if (typeof binding.sandboxExecProfile === 'function') {
        const profile = binding.sandboxExecProfile(['/tmp/p/repo/packages/main/dist', '/tmp/p/repo/packages/utils/dist']);
        const literals = ['/tmp', '/tmp/p', '/tmp/p/repo', '/tmp/p/repo/packages', '/tmp/p/repo/packages/main', '/tmp/p/repo/packages/utils'];
        expectRepaired(literals.every((path) => profile.includes(`(literal "${path}")`)) && !profile.includes('(literal "/")') && profile.includes('(subpath "/tmp/p/repo/packages/main/dist")'),
          `the macOS profile must deny each ancestor as a literal, the trees as subpaths, and never the filesystem root (${profile})`);
      } else {
        expectRepaired(false, 'core/build-artifacts-protection exports no sandboxExecProfile');
      }
      // Audit #19 (1): the wrapper discovered on a RELATIVE PATH entry is
      // resolved to an absolute canonical executable, so the self-tested
      // wrapper and every launch are the same file whatever cwd a command
      // declares.
      if (typeof binding.resolveExecutableOnPath === 'function') {
        const toolsDir = join(sandbox, 'tools'); mkdirSync(toolsDir, { recursive: true });
        const fakeWrapper = join(toolsDir, 'fake-wrapper'); writeFileSync(fakeWrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const found = binding.resolveExecutableOnPath('fake-wrapper', ['tools', '/usr/bin'].join(':'), sandbox);
        expectRepaired(typeof found === 'string' && isAbsolute(found) && found === realpathSync(fakeWrapper),
          `a wrapper found on a relative PATH entry was not resolved to its absolute canonical path (${found})`);
        check(binding.resolveExecutableOnPath('fake-wrapper', '/usr/bin', sandbox) === undefined, 'control: a wrapper absent from PATH is not found');
      } else {
        expectRepaired(false, 'core/build-artifacts-protection exports no resolveExecutableOnPath');
      }
      // Audit #17 (3): a sharded entry's oracle joins the binding sequence.
      const shardedHandlerSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      expectRepaired(shardedHandlerSource.includes('const withOracle = combineSequencedBuildArtifactsBindings([oracle, ...results]);'),
        'the sharded entry binds only its shards, leaving the oracle\'s artifacts and protection out of the sequence (source-text guard)');
      check(doneRequiredProtectionRefusal('enforced:sandbox-exec', REGISTERED_REBUILD_COMMANDS, h.root) === undefined, 'control: an enforced host is not refused');
      expectRepaired(typeof doneRequiredProtectionRefusal('not-applicable:no-artifact-trees', [...REGISTERED_REBUILD_COMMANDS].reverse(), h.root) === 'string', 'the retired not-applicable label was not refused up front');
      // Audit #33 (2): the refusal's recovery advice must be followable. A
      // tree-less project without the layout marker is told to declare the
      // contract inapplicable at its configuration root, and doing so clears
      // the refusal; an applicable project is told to keep or rebuild its
      // roots and provide a mechanism, never to remove the trees.
      {
        const treelessAdvice = join(sandbox, 'treeless-advice'); mkdirSync(treelessAdvice);
        writeFileSync(join(treelessAdvice, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.' }));
        const unenforcedTreeless = binding.resolveArtifactWriteProtection(treelessAdvice, { platform: 'win32' });
        check(unenforcedTreeless.enforced === false, 'control: the win32 seam yields an unenforced label');
        const advice = doneRequiredProtectionRefusal(unenforcedTreeless.label, [{ label: 'unit', command: 'node', args: ['unit.js'] }], treelessAdvice, treelessAdvice) ?? '';
        expectRepaired(advice.includes('"artifactContract": "none"') && advice.includes(join(treelessAdvice, 'proof-or-stop.config.json')) && !/remov(e|ing) the (compiled )?artifact trees/i.test(advice.replace('Removing the artifact trees does not lift the contract', '')),
          `the refusal for a tree-less project does not advise the declaration at its configuration root (${advice.slice(-260)})`);
        writeFileSync(join(treelessAdvice, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', artifactContract: 'none' }));
        const declaredTreeless = binding.resolveArtifactWriteProtection(treelessAdvice, { platform: 'win32' });
        expectRepaired(declaredTreeless.label === 'not-applicable:no-artifact-contract' && doneRequiredProtectionRefusal(declaredTreeless.label, [{ label: 'unit', command: 'node', args: ['unit.js'] }], treelessAdvice, treelessAdvice) === undefined,
          `following the advertised recovery did not clear the refusal (${declaredTreeless.label})`);
        const applicableAdvice = doneRequiredProtectionRefusal('unenforced:no artifact write-protection mechanism is implemented for platform win32', [{ label: 'unit', command: 'node', args: ['unit.js'] }], h.root, h.root) ?? '';
        expectRepaired(applicableAdvice.includes('Removing the artifact trees does not lift the contract') && !applicableAdvice.includes('"artifactContract": "none"') && /keep or rebuild/.test(applicableAdvice),
          `the refusal for an applicable project advises the wrong recovery (${applicableAdvice.slice(-260)})`);
      }
      const doneRequiredWriterSource = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
      const loopStart = doneRequiredWriterSource.indexOf('for (let i = 0; !protectionRefusal && i < policy.commands.length; i++) {');
      const refusalCall = doneRequiredWriterSource.indexOf('doneRequiredProtectionRefusal(artifactWriteProtection.label, policy.commands, args.projectRoot, args.gitCwd, canonicalLaunchCwds)');
      expectRepaired(refusalCall >= 0 && loopStart > refusalCall, 'the DONE-required writer does not consult the protection refusal before its command loop (source-text guard)');
    } else {
      expectRepaired(false, 'core/done-required-validation exports no doneRequiredProtectionRefusal');
    }
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
} else {
  // Audit #14 (4): a host without demonstrated enforcement. The PASS and
  // prevention cases above would be meaningless here; what must hold instead
  // is the fail-closed outcome: the writer refuses BEFORE launching anything
  // and the refusal is not admissible.
  try {
    const f = doneRequiredFixture('done-required-unenforced', [{ label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'] }]);
    const evidence = await runDoneRequiredValidation({ projectRoot: f.root, storyId: f.storyId, store: f.store, gitCwd: f.root });
    expectRepaired(evidence.status === 'FAIL' && evidence.receipts.length === 0 && evidence.reasons.some((reason) => reason.startsWith('build-artifacts-protection-unavailable:')),
      `on a host without enforcement the DONE-required writer launched or passed (status=${evidence.status}, receipts=${evidence.receipts.length}, reasons=${evidence.reasons.join(', ')})`);
    expectRepaired(evaluateDoneRequiredEvidence({ projectRoot: f.root, storyId: f.storyId, store: f.store, gitCwd: f.root }).ok === false, 'the refused DONE-required evidence was admitted');
    console.log('skip: DONE-required PASS and prevention cases need demonstrated artifact write protection on this host (refusal asserted instead)');
  } finally {
    rmTree(sandbox);
  }
}

// ---------------------------------------------------------------------------
// Audit #16 (3): the shared-execution cache (exact-inputs) through the REAL
// causal key builder and receipt store. The compiled-artifact identity and the
// protection label are key material, a cached result carries the binding of
// the run that executed, and a run that changed the artifacts publishes
// nothing reusable. (The source-text guard that preceded this case had been
// guarding a binding placed beside the key's hashed fields, i.e. a no-op.)
// ---------------------------------------------------------------------------
{
  const sharedSandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-shared-'));
  try {
    const root = join(sharedSandbox, 'repo'); mkdirSync(root);
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'light' } }, null, 2));
    resetConfigCache();
    writeFileSync(join(root, '.gitignore'), 'dist\n.proof-or-stop/\n');
    writeFileSync(join(root, 'README.md'), '# shared execution fixture\n');
    writeFileSync(join(root, 'input.txt'), 'input v1\n');
    git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['config', 'user.name', 'Build Binding Fixture']); git(root, ['config', 'commit.gpgsign', 'false']);
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'shared execution fixture']);
    const store = new StoryStore(root); const storyId = 'B-bab-shared'; const now = '2026-06-20T00:00:00.000Z';
    store.writeStory(storyId, { storyId, name: 'build-binding-shared', title: 'shared execution build binding', description: 'Disposable shared-execution build binding fixture.', type: 'chore', phase: 'TEST', priority: 'medium', createdAt: now, startedAt: now, endedAt: null });
    store.writeChecklist(storyId, { items: [] });
    const causalInputHashes = deriveCertificationDomainInputHashes(root, 'HEAD', root);
    check(Boolean(causalInputHashes), 'shared-execution fixture must derive causal input hashes');
    persistSyntheticAdmittedWindowForTest({ store, storyId, projectRoot: root, causalInputHashes });
    acquireOwnerLease(store.storyDirPath(storyId), { command: 'fixture-owner', cwd: root });
    const sharedMainDist = join(root, 'packages/main/dist/tasks'); mkdirSync(sharedMainDist, { recursive: true });
    writeFileSync(join(sharedMainDist, 'x.js'), BUILD_A);
    mkdirSync(join(root, 'packages/utils/dist'), { recursive: true }); writeFileSync(join(root, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
    const ctx = { root, store, scanRoot: root };
    const sharedExecution = { storyId, receiptStore: store, probe: (input) => probeValidationCausalPreflightFacts(ctx, storyId, input) };
    const protection = binding ? binding.resolveArtifactWriteProtection(root) : { label: 'unresolved', wrap: (launch) => launch };
    const identity = () => (binding ? binding.currentBuildArtifactsHash(root) : undefined);
    const hashA = identity();
    const cmd = { label: 'unit', command: 'node', args: ['-e', "process.stdout.write('unit ' + require('node:fs').readFileSync('input.txt', 'utf8')); process.exit(0)"], executionReuse: 'exact-inputs', executionInputs: ['input.txt'], timeoutMs: 20_000 };
    const runShared = (opts = {}) => runValidationCommand(cmd, root, 20_000, { sharedExecution, artifactWriteProtection: protection, artifactBinding: { root, protection: protection.label }, ...opts });
    const first = await runShared();
    check(first.code === 0, `control: the shared-execution command must pass (code=${first.code}, ${first.output.slice(0, 200)})`);
    expectRepaired(first.executionDecision?.disposition === 'executed' && first.buildArtifactsBefore === hashA && first.buildArtifactsAfter === hashA && first.buildArtifactsProtection === protection.label,
      `the first shared-execution run must execute and carry the binding it observed (decision=${JSON.stringify(first.executionDecision)}, before=${first.buildArtifactsBefore}, label=${first.buildArtifactsProtection})`);
    const second = await runShared();
    expectRepaired(second.executionDecision?.disposition === 'reused' && second.buildArtifactsBefore === hashA && second.buildArtifactsAfter === hashA && second.buildArtifactsProtection === protection.label,
      `an unchanged rerun was not served from the cache with the executed run's binding (decision=${JSON.stringify(second.executionDecision)}, before=${second.buildArtifactsBefore}, label=${second.buildArtifactsProtection})`);
    writeFileSync(join(sharedMainDist, 'x.js'), BUILD_B);
    const hashB = identity();
    check(Boolean(hashB) && hashB !== hashA, 'control: rewriting dist changes the identity');
    const changed = await runShared();
    expectRepaired(changed.executionDecision?.disposition === 'executed' && changed.buildArtifactsBefore === hashB,
      `a changed dist was served from the cache: the artifact identity is not in the causal execution key (decision=${JSON.stringify(changed.executionDecision)}, before=${changed.buildArtifactsBefore})`);
    const changedAgain = await runShared();
    expectRepaired(changedAgain.executionDecision?.disposition === 'reused' && changedAgain.buildArtifactsBefore === hashB,
      `the rerun on the new dist was not reused with the new binding (decision=${JSON.stringify(changedAgain.executionDecision)}, before=${changedAgain.buildArtifactsBefore})`);
    const otherLabel = await runShared({ artifactBinding: { root, protection: 'unenforced:probe' } });
    expectRepaired(otherLabel.executionDecision?.disposition === 'executed' && otherLabel.buildArtifactsProtection === 'unenforced:probe',
      `a different protection label was served from the cache: the label is not in the causal execution key (decision=${JSON.stringify(otherLabel.executionDecision)}, label=${otherLabel.buildArtifactsProtection})`);
    // A command that rewrites the artifacts under the cache: its inputs changed
    // during execution, so publication is refused and nothing reusable exists
    // for it, run after run.
    const rewriting = { ...cmd, label: 'rewriter', args: ['-e', "require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // build C\\n'); process.exit(0)"] };
    let refused = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const published = await runValidationCommand(rewriting, root, 20_000, { sharedExecution, artifactBinding: { root, protection: protection.label } });
        expectRepaired(published.executionDecision?.disposition !== 'reused', 'a command that rewrote dist was served from the cache');
      } catch (error) {
        if (/inputs changed before publication/.test(String(error && error.message))) refused++; else throw error;
      }
      writeFileSync(join(sharedMainDist, 'x.js'), BUILD_B);
    }
    expectRepaired(refused === 2, `a command that rewrote dist under the shared cache was published (${refused} of 2 attempts refused)`);
    // Audit #29 (1): the cache keys, snapshots and probes the PINNED canonical
    // directory the command executes in, never the declared cwd. The project
    // is reached through an alias (`linkRepo` -> checkout A); a second
    // checkout B carries a different committed input, its own lease and
    // window, and shares the receipt store. A run declared through the alias
    // is pinned to A before its first launch (as the executor pins every
    // command); an earlier command of that run re-points the alias at B; the
    // exact-inputs command still executes in A and its receipt must describe
    // A's inputs. A later run pinned to B must execute and fail — never reuse
    // A's PASS on the strength of a receipt that described B.
    if (binding && typeof binding.canonicalizeExistingPath === 'function') {
      writeFileSync(join(sharedMainDist, 'x.js'), BUILD_A);
      const checkoutA = root;
      const checkoutB = join(sharedSandbox, 'repo-b'); cpSync(checkoutA, checkoutB, { recursive: true });
      writeFileSync(join(checkoutB, 'input.txt'), 'input v2\n');
      git(checkoutB, ['add', '.']); git(checkoutB, ['commit', '-qm', 'second checkout: different input']);
      const storeB = new StoryStore(checkoutB);
      persistSyntheticAdmittedWindowForTest({ store: storeB, storyId, projectRoot: checkoutB, causalInputHashes: deriveCertificationDomainInputHashes(checkoutB, 'HEAD', checkoutB) });
      acquireOwnerLease(storeB.storyDirPath(storyId), { command: 'fixture-owner', cwd: checkoutB });
      const linkRepo = join(sharedSandbox, 'linkRepo'); symlinkSync(checkoutA, linkRepo, 'dir');
      const aliasCmd = { label: 'alias unit', command: 'node', args: ['-e', "const v = require('node:fs').readFileSync('input.txt', 'utf8').trim(); process.stdout.write('alias ' + v); process.exit(v === 'input v1' ? 0 : 1)"], executionReuse: 'exact-inputs', executionInputs: ['input.txt'], timeoutMs: 20_000 };
      const sharedAtA = sharedExecution;
      const sharedAtB = { storyId, receiptStore: store, probe: (input) => probeValidationCausalPreflightFacts({ root: checkoutB, store: storeB, scanRoot: checkoutB }, storyId, input) };
      const runAliased = async (shared, launchCwd) => {
        try { return await runValidationCommand(aliasCmd, linkRepo, 20_000, { sharedExecution: shared, artifactWriteProtection: protection, artifactBinding: { root: launchCwd, protection: protection.label }, launchCwd }); }
        catch (error) { return { refused: String(error && error.message).slice(0, 200) }; }
      };
      const pinnedToA = binding.canonicalizeExistingPath(linkRepo);
      check(pinnedToA === realpathSync(checkoutA), 'control: the alias is pinned to checkout A before the first launch');
      rmSync(linkRepo); symlinkSync(checkoutB, linkRepo, 'dir');
      check(realpathSync(linkRepo) === realpathSync(checkoutB), 'control: an earlier command re-pointed the alias at checkout B');
      const pinnedRun = await runAliased(sharedAtA, pinnedToA);
      expectRepaired(!pinnedRun.refused && pinnedRun.executionDecision?.disposition === 'executed' && pinnedRun.code === 0 && (pinnedRun.output ?? '').includes('alias input v1'),
        `the pinned command did not execute in checkout A (${pinnedRun.refused ?? `decision=${JSON.stringify(pinnedRun.executionDecision)}, code=${pinnedRun.code}, ${(pinnedRun.output ?? '').slice(0, 80)}`})`);
      const pinnedToB = binding.canonicalizeExistingPath(linkRepo);
      const laterRun = await runAliased(sharedAtB, pinnedToB);
      expectRepaired(!laterRun.refused && laterRun.executionDecision?.disposition === 'executed' && laterRun.code === 1 && (laterRun.output ?? '').includes('alias input v2'),
        `a later run pinned to checkout B reused the PASS earned in A (${laterRun.refused ?? `decision=${JSON.stringify(laterRun.executionDecision)}, code=${laterRun.code}, ${(laterRun.output ?? '').slice(0, 80)}`})`);
      rmSync(linkRepo); symlinkSync(checkoutA, linkRepo, 'dir');
      const backToA = await runAliased(sharedAtA, binding.canonicalizeExistingPath(linkRepo));
      check(!backToA.refused && backToA.executionDecision?.disposition === 'reused' && backToA.code === 0, `control: pinned back to A the PASS earned there is reused (${backToA.refused ?? `decision=${JSON.stringify(backToA.executionDecision)}, code=${backToA.code}`})`);
      // Audit #32 (1): the child environment is built from the pinned
      // canonical directory exactly as the cache identity is, so an
      // invocation through the alias and one through the real path see ONE
      // PWD. A verdict that depends on PWD naming the alias can therefore
      // never earn a PASS that the real-path invocation inherits.
      const canonicalA = realpathSync(checkoutA);
      const runPwd = async (commandSpec, projectRootForLaunch) => {
        try { return await runValidationCommand(commandSpec, projectRootForLaunch, 20_000, { sharedExecution: sharedAtA, artifactWriteProtection: protection, artifactBinding: { root: canonicalA, protection: protection.label }, launchCwd: binding.canonicalizeExistingPath(projectRootForLaunch) }); }
        catch (error) { return { refused: String(error && error.message).slice(0, 200) }; }
      };
      const pwdNamesAlias = { label: 'pwd names alias', command: 'node', args: ['-e', "process.stdout.write('pwd=' + process.env.PWD); process.exit(String(process.env.PWD).endsWith('/linkRepo') ? 0 : 1)"], executionReuse: 'exact-inputs', executionInputs: ['input.txt'], timeoutMs: 20_000 };
      const aliasPwd = await runPwd(pwdNamesAlias, linkRepo);
      expectRepaired(!aliasPwd.refused && aliasPwd.code === 1 && (aliasPwd.output ?? '').includes(`pwd=${canonicalA}`),
        `a command launched through the alias saw a PWD other than the canonical directory (${aliasPwd.refused ?? `code=${aliasPwd.code}, ${(aliasPwd.output ?? '').slice(0, 160)}`})`);
      const realPwd = await runPwd(pwdNamesAlias, checkoutA);
      expectRepaired(!realPwd.refused && realPwd.executionDecision?.disposition === 'executed' && realPwd.code === 1,
        `the real-path invocation inherited a verdict earned through the alias (${realPwd.refused ?? `decision=${JSON.stringify(realPwd.executionDecision)}, code=${realPwd.code}`})`);
      const pwdNamesCanonical = { ...pwdNamesAlias, label: 'pwd names canonical', args: ['-e', `process.exit(process.env.PWD === ${JSON.stringify(canonicalA)} ? 0 : 1)`] };
      const canonicalFirst = await runPwd(pwdNamesCanonical, linkRepo);
      const canonicalSecond = await runPwd(pwdNamesCanonical, checkoutA);
      // Audit #36 (2): the public runValidationCommand boundary pins the
      // canonical launch directory itself when the caller omits it, so a
      // direct exact-inputs invocation through the alias and one through the
      // real path see one PWD and one identity even with no launchCwd given.
      const runPwdUnpinned = async (commandSpec, projectRootForLaunch) => {
        try { return await runValidationCommand(commandSpec, projectRootForLaunch, 20_000, { sharedExecution: sharedAtA, artifactWriteProtection: protection, artifactBinding: { root: canonicalA, protection: protection.label } }); }
        catch (error) { return { refused: String(error && error.message).slice(0, 200) }; }
      };
      const pwdNamesAliasUnpinned = { ...pwdNamesAlias, label: 'pwd names alias (unpinned)' };
      const aliasUnpinned = await runPwdUnpinned(pwdNamesAliasUnpinned, linkRepo);
      expectRepaired(!aliasUnpinned.refused && aliasUnpinned.code === 1 && (aliasUnpinned.output ?? '').includes(`pwd=${canonicalA}`),
        `without a caller-supplied launchCwd, a command launched through the alias saw a PWD other than the canonical directory (${aliasUnpinned.refused ?? `code=${aliasUnpinned.code}, ${(aliasUnpinned.output ?? '').slice(0, 160)}`})`);
      const realUnpinned = await runPwdUnpinned(pwdNamesAliasUnpinned, checkoutA);
      expectRepaired(!realUnpinned.refused && realUnpinned.executionDecision?.disposition === 'executed' && realUnpinned.code === 1,
        `without a caller-supplied launchCwd, the real-path invocation inherited a verdict earned through the alias (${realUnpinned.refused ?? `decision=${JSON.stringify(realUnpinned.executionDecision)}, code=${realUnpinned.code}`})`);
      const pwdNamesCanonicalUnpinned = { ...pwdNamesCanonical, label: 'pwd names canonical (unpinned)' };
      const canonicalUnpinnedFirst = await runPwdUnpinned(pwdNamesCanonicalUnpinned, linkRepo);
      const canonicalUnpinnedSecond = await runPwdUnpinned(pwdNamesCanonicalUnpinned, checkoutA);
      check(!canonicalUnpinnedFirst.refused && canonicalUnpinnedFirst.code === 0 && !canonicalUnpinnedSecond.refused && canonicalUnpinnedSecond.code === 0 && canonicalUnpinnedSecond.executionDecision?.disposition === 'reused',
        `control: without a caller-supplied launchCwd a canonical-PWD verdict passes through the alias and is reused through the real path (${canonicalUnpinnedFirst.refused ?? canonicalUnpinnedSecond.refused ?? JSON.stringify(canonicalUnpinnedSecond.executionDecision)})`);
      check(!canonicalFirst.refused && canonicalFirst.code === 0 && canonicalFirst.executionDecision?.disposition === 'executed'
        && !canonicalSecond.refused && canonicalSecond.code === 0 && canonicalSecond.executionDecision?.disposition === 'reused',
        `control: a verdict that depends on the canonical PWD passes through the alias and is reused through the real path (${canonicalFirst.refused ?? canonicalSecond.refused ?? `${JSON.stringify(canonicalFirst.executionDecision)} / ${JSON.stringify(canonicalSecond.executionDecision)}`})`);
    } else {
      expectRepaired(false, 'core/build-artifacts-identity exports no canonicalizeExistingPath');
    }
  } finally {
    rmTree(sharedSandbox);
  }
}

// ---------------------------------------------------------------------------
// Routine plans: the executor observes every command and stamps the binding.
// The validate-file path feeds this same executor with a single command, so a
// validate-file-shaped plan is exercised here directly (the `npx tsx` wrapper
// itself is not run: tsx is not installed in this checkout).
// ---------------------------------------------------------------------------
if (hostEnforced) {
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

    // Audit #7: one artifact root. On a wrapper-root layout (metadata root with
    // a configured gitRoot subdirectory) the compiled artifacts live under the
    // git root, which is what publication, reuse and admission digest. The
    // executor must observe that same root, not the wrapper, or an unchanged
    // run is rejected as drift before publication and no rerun can repair it.
    const wrapper = join(planSandbox, 'wrapper'); mkdirSync(wrapper);
    const nested = join(wrapper, 'repo'); mkdirSync(nested);
    git(nested, ['init', '-q', '-b', 'main']);
    git(nested, ['config', 'user.email', 'fixture@example.invalid']);
    git(nested, ['config', 'user.name', 'Build Binding Fixture']);
    git(nested, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(nested, '.gitignore'), 'dist\n');
    writeFileSync(join(nested, 'validate-clean.js'), 'process.exit(0);\n');
    git(nested, ['add', '.']); git(nested, ['commit', '-qm', 'nested repository']);
    writeFileSync(join(wrapper, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', gitRoot: 'repo', storyDir: '.proof-or-stop/story/actives' }));
    const nestedMainDist = join(nested, 'packages/main/dist/tasks'); mkdirSync(nestedMainDist, { recursive: true });
    writeFileSync(join(nestedMainDist, 'x.js'), BUILD_A);
    mkdirSync(join(nested, 'packages/utils/dist'), { recursive: true });
    writeFileSync(join(nested, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
    const wrapperCommands = [{ label: 'validate file', command: 'node', args: ['validate-clean.js'], cwd: 'repo', timeoutMs: 20_000 }];
    const runWrapped = (options) => executeValidationPlan({ provider: 'build-binding-fixture', commands: wrapperCommands, warnings: [] }, wrapper, undefined, undefined, options);
    const wrapped = await runWrapped({});
    check(wrapped.allPass === true, `control: the wrapper-root plan must pass (${wrapped.details.join(' | ')})`);
    if (binding) {
      const nestedIdentity = binding.currentBuildArtifactsHash(nested);
      const wrapperIdentity = binding.currentBuildArtifactsHash(wrapper);
      check(Boolean(nestedIdentity) && Boolean(wrapperIdentity) && nestedIdentity !== wrapperIdentity, 'trap: the wrapper has no artifact trees, so its digest differs from the nested repository digest');
      expectRepaired(wrapped.buildArtifactsHash === nestedIdentity,
        `the executor digested the wrapper root instead of the configured git root (bound ${wrapped.buildArtifactsHash}, git root ${nestedIdentity}, wrapper ${wrapperIdentity})`);
      // The resolver canonicalizes (realpath), so compare canonical forms: the macOS tmpdir is a symlink.
      expectRepaired(Boolean(wrapped.buildArtifacts?.root) && realpathSync(wrapped.buildArtifacts.root) === realpathSync(nested), `the executor did not report the git root as its artifact root (${wrapped.buildArtifacts?.root})`);
      const explicit = await runWrapped({ gitCwd: nested });
      expectRepaired(explicit.allPass === true && explicit.buildArtifactsHash === nestedIdentity, 'the executor must honour the caller-resolved git cwd as its artifact root');
      // Audit #12 (4): a registered build declared under the wrapper (cwd
      // `repo/packages/main`) is `packages/main` relative to the artifact
      // root, so it is recognised, launched unprotected, scheduled first, and
      // the test that follows executes and binds what it produced.
      mkdirSync(join(nested, 'packages/main'), { recursive: true });
      writeFileSync(join(nested, 'packages/main/package.json'), JSON.stringify({ name: 'fixture-nested-main', private: true, scripts: {
        build: "node -e \"require('node:fs').writeFileSync('dist/tasks/x.js', 'process.exit(0); // rebuilt under the wrapper\\n')\"",
      } }, null, 2) + '\n');
      git(nested, ['add', 'packages/main/package.json']); git(nested, ['commit', '-qm', 'fixture: nested build script']);
      const preWrapperBuild = binding.currentBuildArtifactsHash(nested);
      const wrappedBuild = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
        { label: 'validate file', command: 'node', args: ['validate-clean.js'], cwd: 'repo', timeoutMs: 20_000 },
        { label: 'nested build', command: 'npm', args: ['run', 'build'], cwd: 'repo/packages/main', timeoutMs: 60_000 },
      ], warnings: [] }, wrapper, undefined, undefined, {});
      check(readFileSync(join(nestedMainDist, 'x.js'), 'utf8').includes('rebuilt under the wrapper'), `control: the nested build must have rewritten dist (${wrappedBuild.details.join(' | ')})`);
      const nestedBuild = wrappedBuild.commands.find((command) => command.label === 'nested build');
      const nestedTest = wrappedBuild.commands.find((command) => command.label === 'validate file');
      expectRepaired(nestedBuild?.buildArtifactsRole === 'build', `a registered build under a wrapper-root layout was classified as a test (${nestedBuild?.buildArtifactsRole})`);
      expectRepaired(wrappedBuild.allPass === true && Boolean(nestedTest?.buildArtifactsBefore) && nestedTest?.buildArtifactsBefore === nestedBuild?.buildArtifactsAfter,
        `under a wrapper-root layout the build was denied its writes or did not run first (allPass=${wrappedBuild.allPass}; ${wrappedBuild.details.join(' | ')})`);
      expectRepaired(wrappedBuild.buildArtifactsHash === binding.currentBuildArtifactsHash(nested) && wrappedBuild.buildArtifactsHash !== preWrapperBuild, 'the wrapper-root plan must bind the artifacts the nested build produced');
      writeFileSync(join(nestedMainDist, 'x.js'), BUILD_A);
      // The DONE-required recogniser judges the same logical location.
      const doneRequiredSource4 = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
      expectRepaired(doneRequiredSource4.includes('}, projectRoot, artifactsRoot);') && doneRequiredSource4.includes('validateReceiptBuildBinding({ receipts, buildArtifactsHash: executionBuildArtifactsHash }, args.projectRoot, policy.commands, args.gitCwd)'),
        'the DONE-required receipt recogniser does not judge the build against the artifact root (source-text guard)');
      // Publication-side consumers digest under the git root: the executor's
      // binding is admitted unchanged and refused after the artifacts drift.
      const wrapperHead = currentGitHead(nested);
      const wrapperMaterial = currentMaterialHash(nested, 'HEAD', wrapper);
      const wrapperStoryFiles = currentStoryFilesHash(nested, 'HEAD', wrapper);
      check(wrapperHead && wrapperMaterial && wrapperStoryFiles, `wrapper fixture identity must resolve (got ${wrapperHead}/${wrapperMaterial}/${wrapperStoryFiles})`);
      const wrapperIdentityRecord = buildRoutineValidationIdentity({
        projectRoot: wrapper, sourceKind: 'configured', sourceInputs: { fixture: 'build-binding-wrapper' },
        commands: wrapperCommands, profile: 'balanced', verificationPolicyInputs: { fixture: 'build-binding-wrapper' },
      });
      const wrapperEvidence = {
        command: 'proof-or-stop validate --story=B-bab --json', output: JSON.stringify({ allPass: true }), result: 'PASS', timestamp: new Date().toISOString(),
        headHash: wrapperHead, materialHash: wrapperMaterial, storyFilesHash: wrapperStoryFiles, buildArtifactsHash: wrapped.buildArtifactsHash, buildArtifactsProtection: wrapped.buildArtifactsProtection,
        verificationCoverage: { missingRequired: 0 },
        commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
        disposition: 'executed', routineValidationIdentity: wrapperIdentityRecord,
      };
      const wrapperReuse = () => evaluateRoutineValidationReuse({
        root: wrapper, gitCwd: nested, evidence: wrapperEvidence, currentIdentity: wrapperIdentityRecord, currentCoverage: { missingRequired: 0 },
        currentMaterialHash: wrapperMaterial, currentStoryFilesHash: wrapperStoryFiles, clean: true, headBefore: wrapperHead, headAfter: wrapperHead,
        currentBuildArtifactsHash: binding.currentBuildArtifactsHash(nested),
      });
      const wrapperAdmission = () => evaluateValidationEvidenceAdmissibility({
        evidence: wrapperEvidence, expectedCommand: wrapperEvidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage',
        blockingDirtyReason: '', gitCwd: nested, metadataRoot: wrapper,
      });
      const unchangedReuse = wrapperReuse();
      expectRepaired(unchangedReuse.reusable === true, `an unchanged wrapper-root PASS bound by the executor is not reusable under the git root (reasons=${unchangedReuse.refusalReasons.join(',')})`);
      const unchangedAdmission = wrapperAdmission();
      expectRepaired(unchangedAdmission.ok === true, `an unchanged wrapper-root PASS bound by the executor is not admissible under the git root (codes=${unchangedAdmission.reasonCodes.join(',')})`);
      writeFileSync(join(nestedMainDist, 'x.js'), BUILD_B);
      const driftedReuse = wrapperReuse();
      check(driftedReuse.reusable === false && driftedReuse.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse must refuse the wrapper-root PASS after the git-root artifacts drift (reasons=${driftedReuse.refusalReasons.join(',')})`);
      const driftedAdmission = wrapperAdmission();
      check(driftedAdmission.ok === false && driftedAdmission.reasonCodes.includes('build_artifacts_mismatch'), `admissibility must refuse the wrapper-root PASS after the git-root artifacts drift (codes=${driftedAdmission.reasonCodes.join(',')})`);
      writeFileSync(join(nestedMainDist, 'x.js'), BUILD_A);

      // Audit #24 (2): the contract declaration is read from the CONFIGURATION
      // root, which on a wrapper-root layout is the wrapper, not the git root
      // holding the (absent) artifacts. A wrapper declaring
      // `artifactContract: "none"` over a repository with no artifact trees
      // is exempt for hashing, protection, reuse and admission alike; the
      // same repository judged on its own (no declaration in sight) is not.
      const wrapperNone = join(planSandbox, 'wrapper-none'); mkdirSync(wrapperNone);
      const nestedNone = join(wrapperNone, 'repo'); mkdirSync(nestedNone);
      git(nestedNone, ['init', '-q', '-b', 'main']);
      git(nestedNone, ['config', 'user.email', 'fixture@example.invalid']);
      git(nestedNone, ['config', 'user.name', 'Build Binding Fixture']);
      git(nestedNone, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(nestedNone, 'validate-clean.js'), 'process.exit(0);\n');
      git(nestedNone, ['add', '.']); git(nestedNone, ['commit', '-qm', 'nested repository without compiled trees']);
      writeFileSync(join(wrapperNone, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', gitRoot: 'repo', storyDir: '.proof-or-stop/story/actives', artifactContract: 'none' }));
      const noneIdentity = binding.currentBuildArtifactsHash(nestedNone, wrapperNone);
      check(binding.projectHasArtifactContract(nestedNone) === true, 'control: the git root judged alone (absence, no declaration in sight) carries the contract');
      expectRepaired(binding.projectHasArtifactContract(nestedNone, wrapperNone) === false, 'a wrapper-root declaration of artifactContract: none was ignored because it was read from the git root');
      expectRepaired(binding.resolveArtifactWriteProtection(nestedNone, { configRoot: wrapperNone }).label === 'not-applicable:no-artifact-contract',
        `protection resolved for a declared-none wrapper-root layout did not record the exemption (${binding.resolveArtifactWriteProtection(nestedNone, { configRoot: wrapperNone }).label})`);
      expectRepaired(binding.hasAnyArtifactRoot(nestedNone, wrapperNone) === false && binding.hasAnyArtifactRoot(nestedNone) === true, 'hasAnyArtifactRoot does not judge the declaration at the configuration root');
      expectRepaired(/^[a-f0-9]{64}$/.test(noneIdentity ?? '') && noneIdentity === binding.currentBuildArtifactsHash(wrapperNone) && noneIdentity !== binding.currentBuildArtifactsHash(nestedNone),
        'the identity of a declared-none wrapper-root layout is not the no-contract identity');
      const noneCommands = [{ label: 'validate file', command: 'node', args: ['validate-clean.js'], cwd: 'repo', timeoutMs: 20_000 }];
      const noneRun = await executeValidationPlan({ provider: 'build-binding-fixture', commands: noneCommands, warnings: [] }, wrapperNone, undefined, undefined, {});
      expectRepaired(noneRun.allPass === true && noneRun.buildArtifactsProtection === 'not-applicable:no-artifact-contract' && noneRun.buildArtifactsHash === noneIdentity,
        `a non-build command on a declared-none wrapper-root layout did not run under the exemption (allPass=${noneRun.allPass}, protection=${noneRun.buildArtifactsProtection}, ${noneRun.details.join(' | ')})`);
      expectRepaired(noneRun.commands.every((command) => command.buildArtifactsProtection === 'not-applicable:no-artifact-contract'), 'a command on a declared-none wrapper-root layout carried a label other than the exemption');
      const noneHead = currentGitHead(nestedNone);
      const noneMaterial = currentMaterialHash(nestedNone, 'HEAD', wrapperNone);
      const noneStoryFiles = currentStoryFilesHash(nestedNone, 'HEAD', wrapperNone);
      check(noneHead && noneMaterial && noneStoryFiles, 'declared-none wrapper fixture identity must resolve');
      const noneIdentityRecord = buildRoutineValidationIdentity({
        projectRoot: wrapperNone, sourceKind: 'configured', sourceInputs: { fixture: 'build-binding-wrapper-none' },
        commands: noneCommands, profile: 'balanced', verificationPolicyInputs: { fixture: 'build-binding-wrapper-none' },
      });
      const noneEvidence = {
        command: 'proof-or-stop validate --story=B-bab --json', output: JSON.stringify({ allPass: true }), result: 'PASS', timestamp: new Date().toISOString(),
        headHash: noneHead, materialHash: noneMaterial, storyFilesHash: noneStoryFiles, buildArtifactsHash: noneRun.buildArtifactsHash, buildArtifactsProtection: noneRun.buildArtifactsProtection,
        verificationCoverage: { missingRequired: 0 },
        commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
        disposition: 'executed', routineValidationIdentity: noneIdentityRecord,
      };
      const noneReuse = evaluateRoutineValidationReuse({
        root: wrapperNone, gitCwd: nestedNone, evidence: noneEvidence, currentIdentity: noneIdentityRecord, currentCoverage: { missingRequired: 0 },
        currentMaterialHash: noneMaterial, currentStoryFilesHash: noneStoryFiles, clean: true, headBefore: noneHead, headAfter: noneHead,
        currentBuildArtifactsHash: binding.currentBuildArtifactsHash(nestedNone, wrapperNone),
      });
      expectRepaired(noneReuse.reusable === true, `a declared-none wrapper-root PASS is not reusable (reasons=${noneReuse.refusalReasons.join(',')})`);
      const noneAdmission = evaluateValidationEvidenceAdmissibility({
        evidence: noneEvidence, expectedCommand: noneEvidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage',
        blockingDirtyReason: '', gitCwd: nestedNone, metadataRoot: wrapperNone,
      });
      expectRepaired(noneAdmission.ok === true, `a declared-none wrapper-root PASS is not admissible (codes=${noneAdmission.reasonCodes.join(',')})`);
      expectRepaired(doneRequiredProtectionRefusal('not-applicable:no-artifact-contract', [{ label: 'unit', command: 'node', args: ['validate-clean.js'], cwd: 'repo' }], wrapperNone, nestedNone) === undefined,
        'the DONE-required writer refuses a declared-none wrapper-root layout up front');
      const doneRequiredSource5 = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
      expectRepaired(doneRequiredSource5.includes('resolveArtifactWriteProtection(args.gitCwd, { configRoot: args.projectRoot })') && doneRequiredSource5.includes('currentBuildArtifactsHash(args.gitCwd, args.projectRoot)')
        && doneRequiredSource5.includes('artifactBinding: { root: args.gitCwd, configRoot: args.projectRoot, protection:'),
        'the DONE-required writer resolves the contract declaration from the git root instead of the configuration root (source-text guard)');
      const verifierSource5 = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
      const admissibilitySource5 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-evidence-admissibility.ts'), 'utf8');
      expectRepaired(!/currentBuildArtifactsHash\((args\.)?gitCwd\)/.test(verifierSource5) && admissibilitySource5.includes('currentBuildArtifactsHash(input.gitCwd, input.metadataRoot)'),
        'the verifier or admissibility digests the git root without the configuration root (source-text guard)');
      // A tree appearing under the exempt git root ends the exemption: the
      // resolution is stale and the ordinary contract applies again.
      mkdirSync(join(nestedNone, 'packages/main/dist'), { recursive: true });
      expectRepaired(binding.hasAnyArtifactRoot(nestedNone, wrapperNone) === true && binding.artifactProtectionStale({ label: 'not-applicable:no-artifact-contract' }, { buildRanSinceResolve: false, anyRootExists: binding.hasAnyArtifactRoot(nestedNone, wrapperNone) }) === true
        && binding.projectHasArtifactContract(nestedNone, wrapperNone) === true,
        'a tree created under a declared-none wrapper-root layout did not bring the contract back');
    }

    // With write protection enforced, a non-build command can no longer perform
    // any of these rewrites at all: the write is denied for the command and for
    // every process it spawns. These cases therefore assert PREVENTION — the
    // command fails and the artifacts are untouched — and the plan-level rules
    // that used to catch the rewrite after the fact are exercised directly as a
    // pure function further below, because they remain the second line of
    // defence on a host where no protection mechanism exists.
    const protection = clean.buildArtifactsProtection ?? '';
    expectRepaired(protection.startsWith('enforced:'),
      `the plan did not establish artifact write protection (${protection || 'not recorded'})`);
    expectRepaired(clean.commands.every((command) => (command.buildArtifactsProtection ?? '').startsWith('enforced:')),
      'a non-build command ran without recorded write protection');

    // Audit #25 (1), through the executor: a command that declares a loader
    // variable still sees it (re-applied inside the sandbox) and still runs
    // enforced; the wrapper itself was launched without it (the partition and
    // the source-text guards above cover the wrapper side).
    const declaredPreload = await run([{ label: 'declared preload', command: 'node', args: ['-e', "process.stdout.write('preload=' + process.env.LD_PRELOAD)"], env: { LD_PRELOAD: '/fixture/preload.so' }, timeoutMs: 20_000 }]);
    expectRepaired(declaredPreload.allPass === true && (declaredPreload.buildArtifactsProtection ?? '').startsWith('enforced:') && (declaredPreload.commands[0]?.output ?? '').includes('preload=/fixture/preload.so'),
      `a command declaring LD_PRELOAD did not run enforced with its declared environment (allPass=${declaredPreload.allPass}, ${declaredPreload.buildArtifactsProtection}, ${JSON.stringify((declaredPreload.commands[0]?.output ?? '').slice(0, 80))})`);
    // Audit #27 (1), through the executor: a build invocation declared in the
    // POSIX directory `packages\\main` runs THERE, classified as a test,
    // launched protected, and cannot rewrite the real packages/main/dist.
    if (process.platform !== 'win32') {
      const otherDir = join(root, 'packages\\main'); mkdirSync(otherDir, { recursive: true });
      writeFileSync(join(otherDir, 'package.json'), JSON.stringify({ name: 'other-directory', private: true, scripts: { build: 'node rewrite.js' } }));
      writeFileSync(join(otherDir, 'rewrite.js'), "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'main', 'dist', 'tasks', 'x.js'), 'process.exit(1); // rewritten from the other directory\\n');\n");
      const otherBuild = await run([{ label: 'other-directory build', command: 'npm', args: ['run', 'build'], cwd: 'packages\\main', timeoutMs: 60_000 }]);
      const otherCommand = otherBuild.commands[0];
      expectRepaired(otherCommand?.buildArtifactsRole === 'test' && typeof otherCommand?.cwd === 'string' && otherCommand.cwd.endsWith('packages\\main'),
        `a build declared in the POSIX directory packages\\main was classified as the registered build or launched elsewhere (role=${otherCommand?.buildArtifactsRole}, cwd=${otherCommand?.cwd})`);
      if (hostEnforced) {
        expectRepaired(readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A && otherBuild.allPass === false && (otherCommand?.buildArtifactsProtection ?? '').startsWith('enforced:'),
          `a build declared in the POSIX directory packages\\main rewrote the real dist or ran unprotected (allPass=${otherBuild.allPass}, ${otherCommand?.buildArtifactsProtection}, dist ${readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A ? 'intact' : 'REWRITTEN'})`);
      }
      writeFileSync(join(mainDist, 'x.js'), BUILD_A);
      rmSync(otherDir, { recursive: true, force: true });
    }
    // Audit #28 (2): the artifact root is canonicalised once per plan and
    // every launch under protection runs in the canonical directory. A
    // checkout reached through an alias that a command re-points at an
    // identical second checkout mid-plan does not move where later commands
    // run, what is observed, or what is protected.
    {
      const aliasSandbox = join(planSandbox, 'alias'); mkdirSync(aliasSandbox);
      const realCheckout = join(aliasSandbox, 'real'); mkdirSync(realCheckout);
      git(realCheckout, ['init', '-q', '-b', 'main']);
      git(realCheckout, ['config', 'user.email', 'fixture@example.invalid']);
      git(realCheckout, ['config', 'user.name', 'Build Binding Fixture']);
      git(realCheckout, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(realCheckout, '.gitignore'), 'dist\n');
      writeFileSync(join(realCheckout, 'where.js'), "process.stdout.write('cwd=' + require('node:fs').realpathSync(process.cwd()));\n");
      writeFileSync(join(realCheckout, 'retarget.js'), "const fs = require('node:fs'); const link = process.env.FIXTURE_ALIAS; fs.unlinkSync(link); fs.symlinkSync(process.env.FIXTURE_SECOND, link, 'dir'); process.stdout.write('retargeted');\n");
      git(realCheckout, ['add', '.']); git(realCheckout, ['commit', '-qm', 'aliased checkout']);
      mkdirSync(join(realCheckout, 'packages/main/dist/tasks'), { recursive: true }); writeFileSync(join(realCheckout, 'packages/main/dist/tasks/x.js'), BUILD_A);
      mkdirSync(join(realCheckout, 'packages/utils/dist'), { recursive: true }); writeFileSync(join(realCheckout, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
      const secondCheckout = join(aliasSandbox, 'second'); cpSync(realCheckout, secondCheckout, { recursive: true });
      const alias = join(aliasSandbox, 'link'); symlinkSync(realCheckout, alias, 'dir');
      const aliased = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
        { label: 'retarget alias', command: 'node', args: ['retarget.js'], env: { FIXTURE_ALIAS: alias, FIXTURE_SECOND: secondCheckout }, timeoutMs: 20_000 },
        { label: 'where am I', command: 'node', args: ['where.js'], timeoutMs: 20_000 },
      ], warnings: [] }, alias, undefined, undefined, {});
      const retargeted = realpathSync(alias) === realpathSync(secondCheckout);
      check(retargeted && (aliased.commands[0]?.output ?? '').includes('retargeted'), `control: the first command must re-point the alias at the second checkout (${aliased.commands[0]?.output})`);
      expectRepaired((aliased.commands[1]?.output ?? '').includes(`cwd=${realpathSync(realCheckout)}`),
        `a command launched after the alias was re-pointed ran in the second checkout (${(aliased.commands[1]?.output ?? '').slice(0, 160)})`);
      expectRepaired(Boolean(aliased.buildArtifacts?.root) && realpathSync(aliased.buildArtifacts.root) === realpathSync(realCheckout) && aliased.buildArtifacts.root === realpathSync(aliased.buildArtifacts.root),
        `the plan did not bind the canonical artifact root (${aliased.buildArtifacts?.root})`);
      if (hostEnforced) {
        expectRepaired(aliased.allPass === true && (aliased.buildArtifactsProtection ?? '').startsWith('enforced:'), `the aliased plan did not run enforced (allPass=${aliased.allPass}, ${aliased.buildArtifactsProtection}, ${aliased.details.join(' | ')})`);
        const viaAlias = binding.resolveArtifactWriteProtection(alias);
        expectRepaired(viaAlias.enforced === true && typeof viaAlias.verify === 'function' && viaAlias.verify() === undefined, `a resolution through the alias is not bound to the canonical root (${viaAlias.label})`);
      }
    }
    // Audit #30 (1): the build role is derived from the pinned launch
    // directory, never re-resolved at launch. An IGNORED alias `build-link`
    // first points at `other` (a package whose build script rewrites the real
    // packages/main/dist); `npm run build` declared in `build-link` is pinned
    // to `other` and classified as a test; an earlier command re-points the
    // alias at packages/main; at launch the command must STILL be a test,
    // launched protected in `other`, and unable to rewrite dist.
    if (process.platform !== 'win32') {
      const otherPkg = join(root, 'other'); mkdirSync(otherPkg, { recursive: true });
      writeFileSync(join(otherPkg, 'package.json'), JSON.stringify({ name: 'other-package', private: true, scripts: { build: 'node rewrite.js' } }));
      writeFileSync(join(otherPkg, 'rewrite.js'), "require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'packages', 'main', 'dist', 'tasks', 'x.js'), 'process.exit(1); // rewritten by the aliased package\\n');\n");
      const buildLink = join(root, 'build-link'); symlinkSync(otherPkg, buildLink, 'dir');
      writeFileSync(join(root, 'retarget-build-link.js'), "const fs = require('node:fs'); fs.unlinkSync('build-link'); fs.symlinkSync(require('node:path').join(__dirname, 'packages', 'main'), 'build-link', 'dir'); process.stdout.write('retargeted');\n");
      const flipped = await run([
        { label: 'retarget build alias', command: 'node', args: ['retarget-build-link.js'], timeoutMs: 20_000 },
        { label: 'aliased build', command: 'npm', args: ['run', 'build'], cwd: 'build-link', timeoutMs: 60_000 },
      ]);
      const aliasedBuild = flipped.commands[1];
      check((flipped.commands[0]?.output ?? '').includes('retargeted') && realpathSync(buildLink) === realpathSync(join(root, 'packages/main')), 'control: the first command re-pointed the build alias at packages/main');
      expectRepaired(aliasedBuild?.buildArtifactsRole === 'test',
        `a command pinned to another directory was reclassified as the registered build after its alias was re-pointed (role=${aliasedBuild?.buildArtifactsRole})`);
      if (hostEnforced) {
        expectRepaired(readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A && flipped.allPass === false && (aliasedBuild?.buildArtifactsProtection ?? '').startsWith('enforced:'),
          `the re-aliased command rewrote dist or ran unprotected (allPass=${flipped.allPass}, ${aliasedBuild?.buildArtifactsProtection}, dist ${readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A ? 'intact' : 'REWRITTEN'})`);
      }
      writeFileSync(join(mainDist, 'x.js'), BUILD_A);
      rmSync(buildLink, { force: true }); rmSync(join(root, 'retarget-build-link.js'), { force: true }); rmSync(otherPkg, { recursive: true, force: true });
    }
    // Audit #34 (1): the whole-routine identity binds the CANONICAL directory
    // a command runs in, like the executor's launch and its PWD. A PASS
    // earned through an ignored cwd symlink pointing at pwdA is not reusable
    // once the link points at pwdB — nothing tracked and no artifact changed,
    // but the command now runs, and fails, elsewhere.
    if (hostEnforced) {
      const pwdA = join(root, 'pwd-a'); mkdirSync(pwdA); const pwdB = join(root, 'pwd-b'); mkdirSync(pwdB);
      const pwdLink = join(root, 'pwd-link'); symlinkSync(pwdA, pwdLink, 'dir');
      const pwdCommands = [{ label: 'pwd names a', command: 'node', args: ['-e', "process.exit(String(process.env.PWD).endsWith('/pwd-a') ? 0 : 1)"], cwd: 'pwd-link', timeoutMs: 20_000 }];
      const earned = await run(pwdCommands);
      check(earned.allPass === true, `control: through the link at pwd-a the command passes (${earned.details.join(' | ')})`);
      const identityInputs = { projectRoot: root, sourceKind: 'configured', sourceInputs: { fixture: 'build-binding-pwd-link' }, commands: pwdCommands, profile: 'balanced', verificationPolicyInputs: { fixture: 'build-binding-pwd-link' } };
      const identityAtA = buildRoutineValidationIdentity(identityInputs);
      const pwdHead = currentGitHead(root); const pwdMaterial = currentMaterialHash(root, 'HEAD', root); const pwdStoryFiles = currentStoryFilesHash(root, 'HEAD', root);
      const pwdEvidence = {
        command: 'proof-or-stop validate --story=B-bab --json', output: JSON.stringify({ allPass: true }), result: 'PASS', timestamp: new Date().toISOString(),
        headHash: pwdHead, materialHash: pwdMaterial, storyFilesHash: pwdStoryFiles, buildArtifactsHash: earned.buildArtifactsHash, buildArtifactsProtection: earned.buildArtifactsProtection,
        verificationCoverage: { missingRequired: 0 },
        commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
        disposition: 'executed', routineValidationIdentity: identityAtA,
      };
      const pwdReuse = (currentIdentity) => evaluateRoutineValidationReuse({
        root, gitCwd: root, evidence: pwdEvidence, currentIdentity, currentCoverage: { missingRequired: 0 },
        currentMaterialHash: pwdMaterial, currentStoryFilesHash: pwdStoryFiles, clean: true, headBefore: pwdHead, headAfter: pwdHead,
        currentBuildArtifactsHash: binding.currentBuildArtifactsHash(root),
      });
      check(pwdReuse(buildRoutineValidationIdentity(identityInputs)).reusable === true, 'control: with the link unchanged the PASS is reusable');
      rmSync(pwdLink); symlinkSync(pwdB, pwdLink, 'dir');
      const identityAtB = buildRoutineValidationIdentity(identityInputs);
      expectRepaired(identityAtB.digest !== identityAtA.digest, 'the routine identity did not change when the ignored cwd symlink was re-pointed');
      const retargetedReuse = pwdReuse(identityAtB);
      expectRepaired(retargetedReuse.reusable === false, `a PASS earned through the link at pwd-a stayed reusable after the link moved to pwd-b (reasons=${retargetedReuse.refusalReasons.join(',')})`);
      const rerun = await run(pwdCommands);
      expectRepaired(rerun.allPass === false, 're-executing through the re-pointed link must fail the command (it did not)');
      rmSync(pwdLink); rmSync(pwdA, { recursive: true, force: true }); rmSync(pwdB, { recursive: true, force: true });
    }
    // Audit #36 (1): dynamic selection and its receipts are bound to the same
    // canonical directory the executor pins: the command identity carries
    // the resolved directory and the declared-environment digest is taken
    // there. A receipt earned while an ignored cwd symlink pointed at dyn-a
    // is reused while the link is unchanged and refused — the command is
    // selected for execution under a new input digest — once the link points
    // at dyn-b, with tracked inputs and artifacts untouched.
    if (typeof binding.canonicalizeExistingPath === 'function') {
      const dynamic = await import('../packages/main/src/core/story-aware-validation.ts');
      const dynA = join(root, 'dyn-a'); mkdirSync(dynA); const dynB = join(root, 'dyn-b'); mkdirSync(dynB);
      const dynLink = join(root, 'dyn-link'); symlinkSync(dynA, dynLink, 'dir');
      const dynInventory = dynamic.discoverValidationInventory(root, [
        // story-selectable, with a changed file inside its input root: an
        // `always` command is executed on every run and never reused.
        // Audit #48: PWD is declared, so the environment digest binds the
        // launch directory too and must follow the FROZEN one after Wave-0.
        { id: 'aliased', label: 'aliased', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'dyn-link', inputRoots: ['dyn-input.ts'], inputsComplete: true, declaredEnvironmentKeys: ['PWD'], assurance: 'story-selectable', riskTier: 'local', originalIndex: 0 },
      ]);
      const dynCatalog = dynamic.compileValidationCatalog(dynInventory);
      // No changed files (nothing to map, no graph escalation), no gitCwd (the
      // fixture receipt carries no real head), and the context names the build
      // the receipt executed — the shape the story-aware smoke reuses under.
      const dynChanges = dynamic.buildStoryChangeManifest({ storyId: 'B-bab-dyn', gitCwd: '.', baseHead: 'base', head: 'head', changedFiles: [] });
      const dynClosures = new Map(dynCatalog.map((entry) => [entry.id, dynamic.createValidationClosureCertificate({ commandId: entry.id, baseHead: 'base', inventoryDigest: dynInventory.digest, catalogDigest: 'catalog', staticPaths: entry.inputRoots })]));
      const dynPlan = (receipts) => dynamic.buildDynamicValidationPlan({ storyId: 'B-bab-dyn', baseHead: 'base', head: 'head', inventory: dynInventory, catalog: dynCatalog, changes: dynChanges, closures: dynClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: root, buildArtifactsHash: 'fixture-build-artifacts', receipts });
      const dynFirst = dynPlan([]);
      const dynFirstRow = dynFirst.rows.find((row) => row.commandId === 'aliased');
      check(dynFirstRow && dynFirstRow.disposition === 'execute', `control: with no receipt the aliased command is selected for execution (${JSON.stringify(dynFirstRow)})`);
      const dynReceipt = dynamic.createValidationCommandReceipt({
        buildArtifactsDigest: 'fixture-build-artifacts', buildArtifactsProtection: 'enforced:fixture', id: 'receipt-aliased', commandId: 'aliased', commandIdentityDigest: 'command',
        inputDigest: dynFirstRow.inputDigest, closureCertificateDigest: dynClosures.get('aliased').signature, catalogDigest: dynamic.stableDigest(dynCatalog), inventoryDigest: dynInventory.digest,
        runnerDigest: 'runner', toolchainDigest: 'toolchain', buildProofDigest: 'build', sourceHead: 'head', sourceBaseHead: 'base', canonicalBaselineEpochId: 'epoch', producedBy: 'story-execution',
        cleanTreeDigest: 'clean', executionEnvironmentDigest: 'environment', result: 'PASS', exitCode: 0, outputDigest: 'output', durationMs: 1, createdAt: new Date().toISOString(), revocationLedgerDigest: dynamic.stableDigest({}),
      });
      const dynSecondRow = dynPlan([dynReceipt]).rows.find((row) => row.commandId === 'aliased');
      check(dynSecondRow?.disposition === 'reuse' && dynSecondRow.receiptId === 'receipt-aliased', `control: with the link unchanged the receipt is reused (${JSON.stringify(dynSecondRow)})`);
      rmSync(dynLink); symlinkSync(dynB, dynLink, 'dir');
      const dynThirdRow = dynPlan([dynReceipt]).rows.find((row) => row.commandId === 'aliased');
      expectRepaired(dynThirdRow?.disposition === 'execute' && dynThirdRow.inputDigest !== dynFirstRow.inputDigest,
        `after the ignored cwd symlink moved, dynamic selection kept the old identity or reused its receipt (${JSON.stringify(dynThirdRow)})`);
      rmSync(dynLink); symlinkSync(dynA, dynLink, 'dir');
      check(dynPlan([dynReceipt]).rows.find((row) => row.commandId === 'aliased')?.disposition === 'reuse', 'control: pointing the link back restores reuse');
      // Audit #41 (2): a receipt binds the canonical directory its command
      // ran in, so the identity a selection computes in ANOTHER workspace of
      // the same tree is a different identity: the receipt is not reused
      // there, and a replay must therefore plan its selection in the
      // workspace whose baseline earned the receipts.
      const dynOther = join(sandbox, 'dyn-other-workspace'); mkdirSync(dynOther, { recursive: true }); mkdirSync(join(dynOther, 'dyn-a')); symlinkSync(join(dynOther, 'dyn-a'), join(dynOther, 'dyn-link'), 'dir');
      const dynElsewhere = dynamic.buildDynamicValidationPlan({ storyId: 'B-bab-dyn', baseHead: 'base', head: 'head', inventory: dynInventory, catalog: dynCatalog, changes: dynChanges, closures: dynClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: dynOther, buildArtifactsHash: 'fixture-build-artifacts', receipts: [dynReceipt] }).rows.find((row) => row.commandId === 'aliased');
      expectRepaired(dynElsewhere?.disposition === 'execute' && dynElsewhere.inputDigest !== dynFirstRow.inputDigest && dynElsewhere.resolvedCwd === realpathSync(join(dynOther, 'dyn-a')),
        `a receipt earned in one workspace was reused by a selection planned in another (${JSON.stringify(dynElsewhere)})`);
      const dynSame = dynamic.buildDynamicValidationPlan({ storyId: 'B-bab-dyn', baseHead: 'base', head: 'head', inventory: dynInventory, catalog: dynCatalog, changes: dynChanges, closures: dynClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: root, buildArtifactsHash: 'fixture-build-artifacts', receipts: [dynReceipt] });
      check(dynSame.rows.find((row) => row.commandId === 'aliased')?.disposition === 'reuse' && dynSame.totals.reused === 1, 'control: planned in the workspace that earned it, the receipt is reused and counted');
      rmSync(dynOther, { recursive: true, force: true });
      const replaySource = readFileSync(join(repoRoot, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'), 'utf8');
      expectRepaired((replaySource.match(/mode: 'shadow', gitCwd: historicalRoot,/g) ?? []).length === 2
        && replaySource.includes("executeValidationPlan({ provider: 'historical-replay-dynamic', commands: selectedCommands, warnings: [] }, historicalRoot,")
        && !replaySource.includes('freshHead')
        && replaySource.includes("buildProofDigest: 'paired-performance', graph: currentGraph, mode: 'shadow', gitCwd: pairedRoot,")
        && replaySource.includes('does not name the selection\'s input identity (launch directory disagreement)')
        && replaySource.includes('const mandatoryExecution = (entry: ValidationCatalogEntry): boolean => entry.assurance === \'always\' || entry.closurePolicy === \'never-reuse\' || (entry.assurance === \'full-only\' && entry.fullBaselineReusePolicy === \'forbidden\');')
        && replaySource.includes("assert.ok(reusable.length > 0, 'paired: no reusable command with a baseline receipt; the campaign has no positive reuse control');")
        && replaySource.includes('assert.equal(pairedSelection.totals.reused, reusable.length,'),
        'the historical replay prepares baseline identities or plans the selection outside the workspace the baseline ran in, or asserts no positive reuse (source-text guard)');
      // Audit #43 (1): the run's launch directories are FROZEN by the planning
      // before Wave-0 and kept by the post-build planning: a Wave-0 command
      // that re-points the alias cannot move where the selected command runs
      // or what identity its receipt is signed for, and a pinned directory
      // replaced during Wave-0 is reported as drift before anything launches.
      const frozenDirs = dynamic.frozenLaunchDirectoriesOf(dynFirst);
      check(frozenDirs.get('aliased')?.path === realpathSync(dynA) && Number.isInteger(frozenDirs.get('aliased')?.identity?.ino), `control: the first planning froze the canonical directory with its identity (${JSON.stringify([...frozenDirs])})`);
      rmSync(dynLink); symlinkSync(dynB, dynLink, 'dir');
      const replanned = dynamic.buildDynamicValidationPlan({ storyId: 'B-bab-dyn', baseHead: 'base', head: 'head', inventory: dynInventory, catalog: dynCatalog, changes: dynChanges, closures: dynClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: root, buildArtifactsHash: 'fixture-build-artifacts', receipts: [dynReceipt], launchDirectories: frozenDirs }).rows.find((row) => row.commandId === 'aliased');
      expectRepaired(replanned?.resolvedCwd === realpathSync(dynA) && replanned.resolvedCwdIdentity?.ino === frozenDirs.get('aliased').identity.ino && replanned.inputDigest === dynFirstRow.inputDigest && replanned.disposition === 'reuse',
        `the post-build planning re-resolved the alias instead of keeping the frozen directory, or digested PWD from the re-pointed one (${JSON.stringify(replanned)})`);
      const coreSource48 = readFileSync(join(repoRoot, 'packages/main/src/core/story-aware-validation.ts'), 'utf8');
      expectRepaired(coreSource48.includes('function declaredEnvironmentDigest(entry: ValidationCatalogEntry, ctx: DynamicValidationContext): string {\n  const cwd = entryLaunchDirectory(entry, ctx).path;'),
        'the environment digest resolves the cwd again instead of using the bound launch directory (source-text guard)');
      check(dynamic.frozenLaunchDirectoryDrift(frozenDirs).length === 0, 'control: re-pointing the alias does not move the pinned directory itself');
      rmSync(dynLink); symlinkSync(dynA, dynLink, 'dir');
      renameSync(dynA, `${dynA}-moved`); mkdirSync(dynA);
      const frozenDrift = dynamic.frozenLaunchDirectoryDrift(frozenDirs);
      expectRepaired(frozenDrift.some((reason) => reason.startsWith('aliased: ') && reason.includes('was replaced by another directory')), `a pinned directory replaced during Wave-0 was not reported as drift (${JSON.stringify(frozenDrift)})`);
      rmSync(dynA, { recursive: true, force: true }); renameSync(`${dynA}-moved`, dynA);
      // Audit #45 (2): a baseline receipt is reusable only under the production
      // provenance contract (tree clean at start AND end, provenance schema),
      // proven in a real clean worktree: the production digest is reused, the
      // replay's old digest is not, and a dirty tree refuses reuse.
      const gitFix = join(sandbox, 'receipt-git'); mkdirSync(gitFix, { recursive: true });
      git(gitFix, ['init', '-q', '-b', 'main']); git(gitFix, ['config', 'user.email', 'fixture@example.invalid']); git(gitFix, ['config', 'user.name', 'Build Binding Fixture']); git(gitFix, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(gitFix, 'input.ts'), 'export const input = 1;\n'); git(gitFix, ['add', '.']); git(gitFix, ['commit', '-qm', 'receipt fixture']);
      const gitHead = git(gitFix, ['rev-parse', 'HEAD']);
      const gitInventory = dynamic.discoverValidationInventory(gitFix, [{ id: 'tracked', label: 'tracked', command: 'node', args: ['-e', 'process.exit(0)'], inputRoots: ['input.ts'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local', originalIndex: 0 }]);
      const gitCatalog = dynamic.compileValidationCatalog(gitInventory);
      const gitChanges = dynamic.buildStoryChangeManifest({ storyId: 'B-git-receipt', gitCwd: gitFix, baseHead: gitHead, head: gitHead, changedFiles: [] });
      const gitClosures = new Map(gitCatalog.map((entry) => [entry.id, dynamic.createValidationClosureCertificate({ commandId: entry.id, baseHead: gitHead, inventoryDigest: gitInventory.digest, catalogDigest: 'catalog', staticPaths: entry.inputRoots })]));
      const gitPlan = (receipts) => dynamic.buildDynamicValidationPlan({ storyId: 'B-git-receipt', baseHead: gitHead, head: gitHead, inventory: gitInventory, catalog: gitCatalog, changes: gitChanges, closures: gitClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: gitFix, gitCwd: gitFix, buildArtifactsHash: 'fixture-build-artifacts', receipts });
      const gitFirst = gitPlan([]).rows.find((row) => row.commandId === 'tracked');
      check(gitFirst?.disposition === 'execute', `control: with no receipt the tracked command executes (${JSON.stringify(gitFirst)})`);
      const gitReceipt = (cleanTreeDigest) => dynamic.createValidationCommandReceipt({
        buildArtifactsDigest: 'fixture-build-artifacts', buildArtifactsProtection: 'enforced:fixture', id: 'receipt-tracked', commandId: 'tracked', commandIdentityDigest: 'command',
        inputDigest: gitFirst.inputDigest, closureCertificateDigest: gitClosures.get('tracked').signature, catalogDigest: dynamic.stableDigest(gitCatalog), inventoryDigest: gitInventory.digest,
        runnerDigest: 'runner', toolchainDigest: 'toolchain', buildProofDigest: 'build', sourceHead: gitHead, sourceBaseHead: gitHead, canonicalBaselineEpochId: 'epoch', producedBy: 'canonical-full-baseline',
        cleanTreeDigest, executionEnvironmentDigest: dynamic.stableDigest({ node: process.version, platform: process.platform, arch: process.arch }), result: 'PASS', exitCode: 0, outputDigest: 'output', durationMs: 1, createdAt: new Date().toISOString(), revocationLedgerDigest: dynamic.stableDigest({}),
      });
      const productionDigestRow = gitPlan([gitReceipt(dynamic.receiptCleanTreeDigest(gitHead, 'B-git-receipt'))]).rows.find((row) => row.commandId === 'tracked');
      expectRepaired(productionDigestRow?.disposition === 'reuse' && productionDigestRow.receiptId === 'receipt-tracked', `a baseline receipt carrying the production clean-tree digest is not reused in a clean worktree (${JSON.stringify(productionDigestRow)})`);
      const replayDigestRow = gitPlan([gitReceipt(dynamic.stableDigest({ head: gitHead, storyId: 'B-git-receipt', status: 'clean-at-command-start' }))]).rows.find((row) => row.commandId === 'tracked');
      check(replayDigestRow?.disposition === 'execute', `control: the replay's former start-only digest is refused (${JSON.stringify(replayDigestRow)})`);
      writeFileSync(join(gitFix, 'dirty.txt'), 'untracked\n');
      const dirtyRow = gitPlan([gitReceipt(dynamic.receiptCleanTreeDigest(gitHead, 'B-git-receipt'))]).rows.find((row) => row.commandId === 'tracked');
      check(dirtyRow?.disposition === 'execute', `control: a dirty worktree refuses reuse (${JSON.stringify(dirtyRow)})`);
      rmSync(join(gitFix, 'dirty.txt'), { force: true });
      const replaySource2 = readFileSync(join(repoRoot, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'), 'utf8');
      const handlerSourceReceipt = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      expectRepaired(replaySource2.includes('cleanTreeDigest: receiptCleanTreeDigest(args.head, args.storyId),') && replaySource2.includes('provenance.schemaVersion !== VALIDATION_SOURCE_PROVENANCE_SCHEMA || !provenance.cleanBefore || !provenance.cleanAfter')
        && handlerSourceReceipt.includes('const cleanTreeDigest = receiptCleanTreeDigest(args.head, args.prepared.manifest.storyId);') && !replaySource2.includes("status: 'clean-at-command-start' }"),
        'the replay baseline receipt does not follow the production provenance contract (source-text guard)');
      rmSync(gitFix, { recursive: true, force: true });
      const handlerSource10 = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      const freezeAt = handlerSource10.indexOf('const frozenLaunchDirectories = frozenLaunchDirectoriesOf(first.manifest);');
      const waveAt = handlerSource10.indexOf("provider: 'story-aware-dynamic-wave-0'");
      const driftAt = handlerSource10.indexOf('const launchDirectoryDriftReasons = frozenLaunchDirectoryDrift(frozenLaunchDirectories);');
      const finalAt = handlerSource10.indexOf('launchDirectories: frozenLaunchDirectories,');
      expectRepaired(freezeAt > 0 && waveAt > freezeAt && driftAt > waveAt && finalAt > driftAt && handlerSource10.includes("throw new Error(`[launch_directory_drift] a launch directory frozen before Wave-0"),
        'the dynamic run does not freeze launch directories before Wave-0, verify them after it, and keep them for the post-build planning (source-text guard)');
      rmSync(dynLink); rmSync(dynA, { recursive: true, force: true }); rmSync(dynB, { recursive: true, force: true });
      // Audit #37 (1): one FROZEN canonical directory per command for planning
      // and every execution wave. The manifest row binds it; a later wave is
      // launched with it (executeValidationPlan's launchCwds) instead of
      // re-resolving an alias an earlier wave re-pointed; the result records
      // where it ran, and a receipt is issued only for a result that ran there.
      const waveA = join(root, 'wave-a'); mkdirSync(waveA); const waveB = join(root, 'wave-b'); mkdirSync(waveB);
      const waveLink = join(root, 'wave-link'); symlinkSync(waveA, waveLink, 'dir');
      writeFileSync(join(root, 'retarget-wave-link.js'), "const fs = require('node:fs'); fs.unlinkSync('wave-link'); fs.symlinkSync(require('node:path').join(__dirname, 'wave-b'), 'wave-link', 'dir'); process.stdout.write('retargeted');\n");
      writeFileSync(join(root, 'wave-where.js'), "process.stdout.write('cwd=' + require('node:fs').realpathSync(process.cwd()));\n");
      const frozenInventory = dynamic.discoverValidationInventory(root, [
        { id: 'wave-aliased', label: 'wave aliased', command: 'node', args: [join(root, 'wave-where.js')], cwd: 'wave-link', inputRoots: ['dyn-input.ts'], inputsComplete: true, assurance: 'story-selectable', riskTier: 'local', originalIndex: 0 },
      ]);
      const frozenCatalog = dynamic.compileValidationCatalog(frozenInventory);
      const frozenClosures = new Map(frozenCatalog.map((entry) => [entry.id, dynamic.createValidationClosureCertificate({ commandId: entry.id, baseHead: 'base', inventoryDigest: frozenInventory.digest, catalogDigest: 'catalog', staticPaths: entry.inputRoots })]));
      const frozenManifest = dynamic.buildDynamicValidationPlan({ storyId: 'B-bab-dyn', baseHead: 'base', head: 'head', inventory: frozenInventory, catalog: frozenCatalog, changes: dynChanges, closures: frozenClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: root, buildArtifactsHash: 'fixture-build-artifacts', receipts: [] });
      const frozenRow = frozenManifest.rows.find((row) => row.commandId === 'wave-aliased');
      expectRepaired(frozenRow?.resolvedCwd === realpathSync(waveA), `the manifest row does not bind the canonical directory resolved at planning (${JSON.stringify(frozenRow)})`);
      const earlierWave = await run([{ label: 'retarget wave link', command: 'node', args: ['retarget-wave-link.js'], timeoutMs: 20_000 }]);
      check(earlierWave.allPass === true && realpathSync(waveLink) === realpathSync(waveB), 'control: an earlier wave re-pointed the alias at wave-b');
      const laterWave = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [{ label: 'wave aliased', command: 'node', args: [join(root, 'wave-where.js')], cwd: 'wave-link', timeoutMs: 20_000 }], warnings: [] }, root, undefined, undefined, { launchCwds: [frozenRow?.resolvedCwd] });
      const laterCommand = laterWave.commands[0];
      expectRepaired(laterWave.allPass === true && laterCommand?.launchCwd === realpathSync(waveA) && (laterCommand?.output ?? '').includes(`cwd=${realpathSync(waveA)}`),
        `a later wave launched with the frozen directory did not run there or did not record it (launchCwd=${laterCommand?.launchCwd}, ${(laterCommand?.output ?? '').slice(0, 120)})`);
      const unfrozenWave = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [{ label: 'wave aliased', command: 'node', args: [join(root, 'wave-where.js')], cwd: 'wave-link', timeoutMs: 20_000 }], warnings: [] }, root, undefined, undefined, {});
      check(unfrozenWave.commands[0]?.launchCwd === realpathSync(waveB), 'control: without the frozen directory a fresh plan pins wherever the alias points now, which is exactly why every wave must receive the planning binding');
      const handlerSource7 = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      expectRepaired((handlerSource7.match(/launchCwds: \[args\.launchCwd\]/g) ?? []).length === 2
        && handlerSource7.includes('launchCwds: ordinaryEntries.map((entry) => final.manifest.rows.find((row) => row.commandId === entry.id)?.resolvedCwd)')
        && handlerSource7.includes('launchCwds: [first.manifest.rows.find((row) => row.commandId === waveId)?.resolvedCwd]')
        && handlerSource7.includes('launchCwd: final.manifest.rows.find((row) => row.commandId === entry.id)?.resolvedCwd,')
        && handlerSource7.includes('if (!args.row.resolvedCwd || args.result.launchCwd !== args.row.resolvedCwd) return undefined;'),
        'the dynamic handler does not launch every wave, shard and oracle in the planning-bound directory or issues receipts without checking it (source-text guard)');
      const sharedSource7 = readFileSync(join(repoRoot, 'packages/main/src/core/shared-validation-execution.ts'), 'utf8');
      expectRepaired(sharedSource7.includes('launchCwd:normalized.cwd,'), 'a cache-served result carries no launch directory, so no receipt could ever be issued for it (source-text guard)');
      rmSync(waveLink); rmSync(waveA, { recursive: true, force: true }); rmSync(waveB, { recursive: true, force: true }); rmSync(join(root, 'retarget-wave-link.js'), { force: true }); rmSync(join(root, 'wave-where.js'), { force: true });
    }
    // Audit #38 (2): an absolute cwd is resolved as the KERNEL resolves it —
    // `..` after a symbolic link steps out of the link's target — so the
    // command runs, and is recorded, where a launch with that cwd actually
    // lands. Distinct validators sit at the lexical and the kernel-resolved
    // destinations: the kernel-resolved one must be the one that runs.
    if (hostEnforced) {
      const canonicalRoot = realpathSync(root);
      mkdirSync(join(canonicalRoot, 'checks')); writeFileSync(join(canonicalRoot, 'checks', 'validate.js'), 'process.stdout.write("lexical destination"); process.exit(1);\n');
      mkdirSync(join(canonicalRoot, 'elsewhere', 'tree'), { recursive: true }); mkdirSync(join(canonicalRoot, 'elsewhere', 'checks'));
      writeFileSync(join(canonicalRoot, 'elsewhere', 'checks', 'validate.js'), 'process.stdout.write("kernel destination"); process.exit(0);\n');
      symlinkSync(join(canonicalRoot, 'elsewhere', 'tree'), join(canonicalRoot, 'alias'));
      const dotDotCwd = `${canonicalRoot}/alias/../checks`;
      check(binding.canonicalizeExistingPath(dotDotCwd) === join(canonicalRoot, 'elsewhere', 'checks'), `control: the canonical walker reaches the kernel destination (${binding.canonicalizeExistingPath(dotDotCwd)})`);
      const dotDotRun = await run([{ label: 'dotdot cwd', command: 'node', args: ['validate.js'], cwd: dotDotCwd, timeoutMs: 20_000 }]);
      expectRepaired(dotDotRun.allPass === true && (dotDotRun.commands[0]?.output ?? '').includes('kernel destination') && dotDotRun.commands[0]?.launchCwd === join(canonicalRoot, 'elsewhere', 'checks'),
        `a cwd with \`..\` after a symbolic link was launched or recorded at the lexical destination (allPass=${dotDotRun.allPass}, launchCwd=${dotDotRun.commands[0]?.launchCwd}, ${(dotDotRun.commands[0]?.output ?? '').slice(0, 60)})`);
      rmSync(join(canonicalRoot, 'alias')); rmSync(join(canonicalRoot, 'checks'), { recursive: true, force: true }); rmSync(join(canonicalRoot, 'elsewhere'), { recursive: true, force: true });
    }
    // Audit #39 (1): the directory a command is pinned to is bound by
    // filesystem identity and re-verified before the cache is consulted and
    // immediately before the spawn. A directory renamed away and replaced —
    // by a link to another directory, or by another real directory — refuses
    // the launch: nothing runs, no launch directory is recorded, so no
    // receipt can be attributed to the pinned directory.
    if (hostEnforced) {
      const canonicalRoot = realpathSync(root);
      const pinnedDir = join(canonicalRoot, 'pinned-checks'); mkdirSync(pinnedDir); writeFileSync(join(pinnedDir, 'validate.js'), 'process.stdout.write("pinned directory"); process.exit(0);\n');
      const otherDir = join(canonicalRoot, 'other-checks'); mkdirSync(otherDir); writeFileSync(join(otherDir, 'validate.js'), 'process.stdout.write("OTHER directory"); process.exit(0);\n');
      const pinnedIdentity = binding.bindLaunchDirectoryIdentity(pinnedDir);
      expectRepaired(pinnedIdentity && Number.isInteger(pinnedIdentity.ino) && Number.isInteger(pinnedIdentity.dev), `no filesystem identity is bound for a pinned directory (${JSON.stringify(pinnedIdentity)})`);
      check(binding.launchDirectoryDrift(pinnedDir, pinnedIdentity) === undefined, 'control: an untouched pinned directory shows no drift');
      const pinnedCommand = { label: 'pinned', command: 'node', args: ['validate.js'], cwd: pinnedDir, timeoutMs: 20_000 };
      const pinnedRun = await runValidationCommand(pinnedCommand, root, 20_000, { launchCwd: pinnedDir, launchIdentity: pinnedIdentity });
      check(pinnedRun.code === 0 && pinnedRun.launchCwd === pinnedDir && pinnedRun.output.includes('pinned directory'), `control: the pinned directory runs and is recorded while untouched (${pinnedRun.code}, ${pinnedRun.launchCwd})`);
      // (a) replaced by a link to another directory
      renameSync(pinnedDir, join(canonicalRoot, 'pinned-checks-moved')); symlinkSync(otherDir, pinnedDir);
      const linkDrift = binding.launchDirectoryDrift(pinnedDir, pinnedIdentity);
      expectRepaired(typeof linkDrift === 'string' && linkDrift.includes('now resolves to'), `a pinned directory replaced by a link is not reported as drift (${linkDrift})`);
      const viaLink = await runValidationCommand(pinnedCommand, root, 20_000, { launchCwd: pinnedDir, launchIdentity: pinnedIdentity });
      expectRepaired(viaLink.code !== 0 && viaLink.launchCwd === undefined && viaLink.output.includes('[launch_directory_drift]') && !viaLink.output.includes('OTHER directory'),
        `a launch pinned to a directory that became a link ran through the link or recorded the pinned directory (code=${viaLink.code}, launchCwd=${viaLink.launchCwd}, ${viaLink.output.slice(0, 120)})`);
      rmSync(pinnedDir); renameSync(join(canonicalRoot, 'pinned-checks-moved'), pinnedDir);
      // (b) replaced by another real directory (rename swap): same path, other object
      renameSync(pinnedDir, join(canonicalRoot, 'pinned-checks-moved')); renameSync(otherDir, pinnedDir);
      const swapDrift = binding.launchDirectoryDrift(pinnedDir, pinnedIdentity);
      expectRepaired(typeof swapDrift === 'string' && swapDrift.includes('was replaced by another directory'), `a pinned directory swapped for another real directory is not reported as drift (${swapDrift})`);
      const viaSwap = await runValidationCommand(pinnedCommand, root, 20_000, { launchCwd: pinnedDir, launchIdentity: pinnedIdentity });
      expectRepaired(viaSwap.code !== 0 && viaSwap.launchCwd === undefined && viaSwap.output.includes('[launch_directory_drift]'),
        `a launch pinned to a directory swapped for another ran in the replacement (code=${viaSwap.code}, launchCwd=${viaSwap.launchCwd}, ${viaSwap.output.slice(0, 120)})`);
      // (c) within one plan: the first command replaces the second's pinned
      // directory (identity bound at plan start, before the first launch).
      renameSync(pinnedDir, otherDir); renameSync(join(canonicalRoot, 'pinned-checks-moved'), pinnedDir);
      const swapScript = join(canonicalRoot, 'swap.js');
      writeFileSync(swapScript, `const fs = require('node:fs'); fs.renameSync(${JSON.stringify(pinnedDir)}, ${JSON.stringify(join(canonicalRoot, 'pinned-checks-moved'))}); fs.symlinkSync(${JSON.stringify(otherDir)}, ${JSON.stringify(pinnedDir)}); process.exit(0);\n`);
      const planRun = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
        { label: 'swap', command: 'node', args: [swapScript], timeoutMs: 20_000 },
        { label: 'pinned in plan', command: 'node', args: ['validate.js'], cwd: 'pinned-checks', timeoutMs: 20_000 },
      ], warnings: [] }, root, undefined, undefined, { jobs: 1 });
      const swapped = planRun.commands.find((command) => command.label === 'pinned in plan');
      expectRepaired(planRun.allPass === false && swapped && swapped.code !== 0 && swapped.launchCwd === undefined && swapped.output.includes('[launch_directory_drift]'),
        `a plan command whose pinned directory an earlier command replaced ran anyway or was attributed to the pinned directory (allPass=${planRun.allPass}, code=${swapped?.code}, launchCwd=${swapped?.launchCwd}, ${(swapped?.output ?? '').slice(0, 120)})`);
      // (e) Audit #40: the directory is replaced INSIDE the asynchronous
      // window between the launch's reservation handshakes and the spawn (a
      // concurrent process, not an earlier command); the final verification
      // runs after every await, so nothing launches in the replacement.
      // After (c) the pinned path is the link the swap script left; restore the real directory.
      rmSync(pinnedDir); renameSync(join(canonicalRoot, 'pinned-checks-moved'), pinnedDir);
      const lateIdentity = binding.bindLaunchDirectoryIdentity(pinnedDir);
      const lateLink = await runValidationCommand(pinnedCommand, root, 20_000, { launchCwd: pinnedDir, launchIdentity: lateIdentity,
        unsafeAfterReservationForFixture: () => { renameSync(pinnedDir, join(canonicalRoot, 'pinned-checks-moved')); symlinkSync(otherDir, pinnedDir); } });
      expectRepaired(lateLink.code !== 0 && lateLink.launchCwd === undefined && lateLink.output.includes('[launch_directory_drift]') && !lateLink.output.includes('OTHER directory'),
        `a directory replaced by a link while the reservation was pending was launched through or attributed (code=${lateLink.code}, launchCwd=${lateLink.launchCwd}, ${lateLink.output.slice(0, 120)})`);
      rmSync(pinnedDir); renameSync(join(canonicalRoot, 'pinned-checks-moved'), pinnedDir);
      const lateSwap = await runValidationCommand(pinnedCommand, root, 20_000, { launchCwd: pinnedDir, launchIdentity: lateIdentity,
        unsafeAfterReservationForFixture: () => { renameSync(pinnedDir, join(canonicalRoot, 'pinned-checks-moved')); renameSync(otherDir, pinnedDir); } });
      expectRepaired(lateSwap.code !== 0 && lateSwap.launchCwd === undefined && lateSwap.output.includes('was replaced by another directory') && !lateSwap.output.includes('OTHER directory'),
        `a directory swapped while the reservation was pending was launched in the replacement (code=${lateSwap.code}, launchCwd=${lateSwap.launchCwd}, ${lateSwap.output.slice(0, 120)})`);
      renameSync(pinnedDir, otherDir); renameSync(join(canonicalRoot, 'pinned-checks-moved'), pinnedDir);
      const untouchedLate = await runValidationCommand(pinnedCommand, root, 20_000, { launchCwd: pinnedDir, launchIdentity: lateIdentity, unsafeAfterReservationForFixture: () => {} });
      check(untouchedLate.code === 0 && untouchedLate.launchCwd === pinnedDir, `control: the same launch with the directory untouched in that window runs and is recorded (${untouchedLate.code}, ${untouchedLate.launchCwd})`);
      // (d) the receipt path and the reuse path both read the verified launch
      // directory: the handler passes the planning-time identity through and
      // the executor records launchCwd only for a launch it verified.
      const handlerSource9 = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      const executorSource9 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
      const storyAwareSource9 = readFileSync(join(repoRoot, 'packages/main/src/core/story-aware-validation.ts'), 'utf8');
      expectRepaired((handlerSource9.match(/launchIdentities: \[args\.launchIdentity\]/g) ?? []).length === 2
        && handlerSource9.includes('launchIdentities: ordinaryEntries.map((entry) => final.manifest.rows.find((row) => row.commandId === entry.id)?.resolvedCwdIdentity)')
        && handlerSource9.includes('launchIdentities: [first.manifest.rows.find((row) => row.commandId === waveId)?.resolvedCwdIdentity]')
        && handlerSource9.includes('launchIdentity: final.manifest.rows.find((row) => row.commandId === entry.id)?.resolvedCwdIdentity,')
        && storyAwareSource9.includes('row.resolvedCwdIdentity = identity'),
        'the dynamic handler does not pass the planning-time directory identity to every wave, shard and oracle (source-text guard)');
      const finalCheckAt = executorSource9.indexOf('const drift = launchDirectoryDrift(options.launchCwd, options.launchIdentity);');
      const lastAwaitAt = executorSource9.lastIndexOf('await attemptValidationReservationSpawn(');
      const spawnAt = executorSource9.indexOf('child = spawn(launch.command, launch.args, {');
      expectRepaired(executorSource9.includes('const drift = launchDirectoryDrift(options.launchCwd!, options.launchIdentity); if (drift) return Promise.resolve(refusedLaunchResult(')
        && finalCheckAt > lastAwaitAt && lastAwaitAt > 0 && spawnAt > finalCheckAt && !/\bawait\b/.test(executorSource9.slice(finalCheckAt, spawnAt)),
        'the executor does not verify the pinned directory before the cache and again after every reservation await, synchronously before the spawn (source-text guard)');
      rmSync(pinnedDir, { recursive: true, force: true }); rmSync(join(canonicalRoot, 'pinned-checks-moved'), { recursive: true, force: true }); rmSync(otherDir, { recursive: true, force: true }); rmSync(swapScript, { force: true });
    }
    // Audit #41 (1): under sandbox-exec the withheld environment is re-applied
    // through /usr/bin/env, which parses every leading argument containing
    // '=' as an assignment (`--` does not stop it). An executable whose name
    // contains '=' would become one more assignment, and env, left with no
    // command, prints the environment and exits 0: an enforced PASS without
    // the validator running, with the environment copied into the output.
    // Such a launch is refused outright; nothing is launched unprotected.
    if (process.platform === 'darwin' && hostEnforced) {
      const eqDir = join(sandbox, 'eq-executable'); mkdirSync(eqDir, { recursive: true });
      const eqValidator = join(eqDir, 'validator=must-run');
      writeFileSync(eqValidator, '#!/bin/sh\necho RAN_VALIDATOR\nexit 5\n', { mode: 0o755 });
      const direct = spawnSync(eqValidator, [], { encoding: 'utf8' });
      check(direct.status === 5 && direct.stdout.includes('RAN_VALIDATOR'), `control: the '='-named validator runs and fails when executed directly (${direct.status})`);
      const viaEnv = spawnSync('/usr/bin/env', ['POS_ENV_DUMP_WITNESS=dumped-secret', eqValidator], { encoding: 'utf8' });
      check(viaEnv.status === 0 && viaEnv.stdout.includes('POS_ENV_DUMP_WITNESS=dumped-secret') && !viaEnv.stdout.includes('RAN_VALIDATOR'), `control: /usr/bin/env treats the '='-named validator as an assignment and dumps the environment (${viaEnv.status})`);
      const eqProtection = binding.resolveArtifactWriteProtection(root);
      check(eqProtection.enforced === true && eqProtection.label === 'enforced:sandbox-exec', `control: this host enforces through sandbox-exec (${eqProtection.label})`);
      // Audit #45 (1): the environment no longer passes through /usr/bin/env
      // at all (sandbox-exec, SIP-restricted, receives it directly), so an
      // executable is argv data whatever its name: it runs and fails.
      const eqLaunch = eqProtection.wrap({ command: eqValidator, args: [], shell: false, env: { ...process.env, POS_ENV_DUMP_WITNESS: 'dumped-secret' }, confidentialFd: 3 });
      expectRepaired(!eqLaunch.args.includes(realpathSync('/usr/bin/env')) && eqLaunch.args[eqLaunch.args.length - 1] === eqValidator && !eqLaunch.args.some((argument) => argument.includes('dumped-secret')),
        `the environment is still re-applied through env, or a value of it is in argv (${JSON.stringify(eqLaunch.args.slice(-3))})`);
      const eqRun = await runValidationCommand({ label: 'eq validator', command: eqValidator, args: [], env: { POS_ENV_DUMP_WITNESS: 'dumped-secret' }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
      expectRepaired(eqRun.code === 5 && eqRun.output.includes('RAN_VALIDATOR') && !eqRun.output.includes('POS_ENV_DUMP_WITNESS=') && eqRun.launchCwd === realpathSync(root),
        `a '='-named validator under sandbox-exec did not run and fail as itself (code=${eqRun.code}, launchCwd=${eqRun.launchCwd}, ${eqRun.output.slice(0, 160)})`);
      rmSync(eqDir, { recursive: true, force: true });
      // Audit #42 (1): env parses OPTIONS before assignments, so a variable
      // whose NAME begins with '-' (`-SFOO= /usr/bin/true`) is read as env's
      // -S option and runs a command of the launch's choosing instead of the
      // declared validator, exit 0 and all. `--` must end option parsing
      // before the first assignment.
      const dashDir = join(sandbox, 'dash-env-key'); mkdirSync(dashDir, { recursive: true });
      const dashValidator = join(dashDir, 'validator');
      writeFileSync(dashValidator, '#!/bin/sh\necho RAN_VALIDATOR\nexit 1\n', { mode: 0o755 });
      const hijack = spawnSync('/usr/bin/env', ['-SFOO= /usr/bin/true', 'PATH=/usr/bin', dashValidator], { encoding: 'utf8' });
      check(hijack.status === 0 && !hijack.stdout.includes('RAN_VALIDATOR'), `control: without a separator env reads a dash-named assignment as its -S option and never runs the validator (${hijack.status})`);
      const separated = spawnSync('/usr/bin/env', ['--', '-SFOO= /usr/bin/true', 'PATH=/usr/bin', dashValidator], { encoding: 'utf8' });
      check(separated.status === 1 && separated.stdout.includes('RAN_VALIDATOR'), `control: with -- the validator runs and fails (${separated.status})`);
      // A name that is not a portable identifier cannot be restored as data by
      // any launcher; it is refused up front, and nothing runs in its place.
      let dashRefusal = null;
      try { eqProtection.wrap({ command: dashValidator, args: [], shell: false, env: { ...process.env, '-SFOO': ' /usr/bin/true' }, confidentialFd: 3 }); } catch (error) { dashRefusal = error; }
      expectRepaired(dashRefusal && String(dashRefusal.message).includes('[artifact_protection_launch_unsupported]') && String(dashRefusal.message).includes('-SFOO'),
        `a dash-named variable was accepted for transfer into the sandbox (${dashRefusal ? dashRefusal.message : 'no refusal'})`);
      const dashRun = await runValidationCommand({ label: 'dash env key', command: dashValidator, args: [], env: { '-SFOO': ' /usr/bin/true' }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
      expectRepaired(dashRun.code !== 0 && dashRun.output.includes('[artifact_protection_launch_refused]') && !dashRun.output.includes('RAN_VALIDATOR') && dashRun.launchCwd === undefined,
        `a dash-named environment variable was launched anyway (code=${dashRun.code}, ${dashRun.output.slice(0, 120)})`);
      rmSync(dashDir, { recursive: true, force: true });
      // Audit #45 (1): no credential from the launch environment appears in
      // the wrapper's argv, and every variable still reaches the command.
      // Safe because SIP keeps /usr/bin/sandbox-exec restricted: the loader
      // ignores DYLD_* for it (control below), so handing it the environment
      // directly lets nothing run ahead of the mechanism.
      check(binding.systemIntegrityProtectionRefusal({}) === undefined, 'control: System Integrity Protection is fully enabled on this host');
      const dyldDir = join(sandbox, 'dyld-control'); mkdirSync(dyldDir, { recursive: true });
      writeFileSync(join(dyldDir, 'plain.c'), 'int main(void) { return 0; }\n');
      check(spawnSync('cc', ['-std=c11', '-o', join(dyldDir, 'plain'), join(dyldDir, 'plain.c')], { encoding: 'utf8' }).status === 0, 'control: the plain fixture binary compiles');
      const dyldEnv = { ...process.env, DYLD_INSERT_LIBRARIES: join(dyldDir, 'absent.dylib') };
      const restricted = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', env: dyldEnv, timeout: 20_000 });
      check(restricted.status === 0, `control: the restricted platform binary ignores DYLD_INSERT_LIBRARIES (${restricted.status}, ${(restricted.stderr || '').slice(0, 80)})`);
      const unrestricted = spawnSync(join(dyldDir, 'plain'), [], { encoding: 'utf8', env: dyldEnv, timeout: 20_000 });
      check(unrestricted.status !== 0, `control: an unrestricted binary honours DYLD_INSERT_LIBRARIES and fails on the absent library (${unrestricted.status})`);
      const secretValue = 'synthetic-credential-7c1d';
      const secretLaunch = eqProtection.wrap({ command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.POS_SYNTHETIC_SECRET))'], shell: false, env: { ...process.env, POS_SYNTHETIC_SECRET: secretValue }, confidentialFd: 3 });
      expectRepaired(!secretLaunch.args.some((argument) => argument.includes(secretValue)) && !('POS_SYNTHETIC_SECRET' in secretLaunch.env) && secretLaunch.confidential?.payload.toString('utf8').includes(`$ENV{'POS_SYNTHETIC_SECRET'} = pack('H*', '${Buffer.from(secretValue, 'utf8').toString('hex')}');\n`) && !secretLaunch.confidential.payload.toString('utf8').includes(secretValue),
        `a launch-environment credential is in the wrapper's argv or environment, or missing from the confidential payload (${JSON.stringify(secretLaunch.args.slice(-4))})`);
      const secretDirect = spawnWrapped(secretLaunch);
      expectRepaired(secretDirect.status === 0 && secretDirect.stdout === secretValue, `the command under sandbox-exec did not receive the credential (${secretDirect.status}, ${secretDirect.stdout} ${(secretDirect.stderr || '').slice(0, 80)})`);
      // Audit #46 (2): SIP strips DYLD_* from a restricted wrapper's own
      // environment (control), so a directly handed environment would lose
      // them; through the trampoline the command still sees them.
      const dyldProbe = ['-e', 'process.stdout.write(String(process.env.DYLD_LIBRARY_PATH))'];
      const stripped = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', process.execPath, ...dyldProbe], { encoding: 'utf8', env: { ...process.env, DYLD_LIBRARY_PATH: '/fixture/lib' }, timeout: 20_000 });
      check(stripped.status === 0 && stripped.stdout === 'undefined', `control: a restricted wrapper handed DYLD_LIBRARY_PATH directly strips it before the command runs (${stripped.stdout})`);
      const dyldRun = await runValidationCommand({ label: 'dyld delivery', command: process.execPath, args: dyldProbe, env: { DYLD_LIBRARY_PATH: '/fixture/lib' }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
      expectRepaired(dyldRun.code === 0 && dyldRun.output.includes('/fixture/lib'), `the protected launch lost DYLD_LIBRARY_PATH, so the command ran with inputs other than the ones its environment digest records (${dyldRun.code}, ${dyldRun.output.slice(0, 80)})`);
      const dyldDirect = spawnWrapped(eqProtection.wrap({ command: process.execPath, args: dyldProbe, shell: false, env: { ...process.env, DYLD_LIBRARY_PATH: '/fixture/lib' }, confidentialFd: 3 }));
      check(dyldDirect.status === 0 && dyldDirect.stdout === '/fixture/lib', `control: the trampoline restores DYLD_LIBRARY_PATH for the command (${dyldDirect.stdout})`);
      // Audit #47 (2): the restored environment is EXACTLY the declared one:
      // shell-special names (SHLVL, SHELLOPTS, read-only identifiers) and
      // values with quotes, newlines and non-ASCII arrive as declared, because
      // the trampoline places bytes, not shell variables.
      const exactEnv = { ...process.env, SHELLOPTS: 'nounset', SHLVL: '7', UID: '1', EUID: '2', PPID: '3', BASH_VERSINFO: 'x', PS1: '$ ', IFS: 'x', POS_QUOTED: "it's \"quoted\"\nsecond line \u00e9\u4e2d", DYLD_LIBRARY_PATH: '/fixture/lib', POS_SYNTHETIC_SECRET: secretValue };
      const envProbe = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];
      const directEnv = spawnSync(process.execPath, envProbe, { encoding: 'utf8', env: exactEnv, timeout: 20_000 });
      const wrappedEnv = spawnWrapped(eqProtection.wrap({ command: process.execPath, args: envProbe, shell: false, env: exactEnv, confidentialFd: 3 }));
      // Compared as sets of entries: the order in which a process lists its
      // environment is not part of the environment.
      const sortedEntries = (text) => { try { return JSON.stringify(Object.entries(JSON.parse(text)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); } catch { return text; } };
      expectRepaired(directEnv.status === 0 && wrappedEnv.status === 0 && sortedEntries(directEnv.stdout) === sortedEntries(wrappedEnv.stdout),
        `the protected command's environment differs from the declared one (${wrappedEnv.status}; ${(wrappedEnv.stderr || '').slice(0, 120)}; ${(() => { try { const a = JSON.parse(directEnv.stdout), b = JSON.parse(wrappedEnv.stdout); return Object.keys({ ...a, ...b }).filter((key) => a[key] !== b[key]).map((key) => `${key}: ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`).join(', ').slice(0, 300); } catch { return 'unparseable'; } })()})`);
      // Audit #47 (1): an executable named `--` (or `-x`) is a program, never
      // an option of the trampoline: absent, it fails as it does directly.
      for (const dashCommand of ['--', '-x']) {
        const directDash = spawnSync(dashCommand, [], { encoding: 'utf8', cwd: root, timeout: 20_000 });
        check(directDash.error?.code === 'ENOENT', `control: a missing executable named ${dashCommand} fails directly (${directDash.error?.code})`);
        const wrappedDash = spawnWrapped(eqProtection.wrap({ command: dashCommand, args: [], shell: false, env: exactEnv, confidentialFd: 3 }), { cwd: root });
        expectRepaired(wrappedDash.status !== 0, `a missing executable named ${dashCommand} produced a clean exit through the trampoline (${wrappedDash.status})`);
        const dashCommandRun = await runValidationCommand({ label: `dash command ${dashCommand}`, command: dashCommand, args: [], env: { POS_SYNTHETIC_SECRET: secretValue }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
        expectRepaired(dashCommandRun.code !== 0, `a missing executable named ${dashCommand} passed under protection without running (${dashCommandRun.code}, ${dashCommandRun.output.slice(0, 80)})`);
      }
      // Audit #46 (1): a NUL byte in a value is refused before any payload
      // exists (it would end one token and begin another).
      let nulRefusal = null;
      try { eqProtection.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { ...process.env, POS_NUL: 'ok\0--bind\0/x\0/x' }, confidentialFd: 3 }); } catch (error) { nulRefusal = error; }
      expectRepaired(nulRefusal && String(nulRefusal.message).includes('[artifact_protection_launch_unsupported]') && String(nulRefusal.message).includes('NUL'), `a value containing NUL was serialised for transfer (${nulRefusal ? nulRefusal.message : 'no refusal'})`);
      const nulRun = await runValidationCommand({ label: 'nul env', command: process.execPath, args: ['-e', 'process.stdout.write("RAN")'], env: { POS_NUL: 'ok\0--bind\0/x\0/x' }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
      expectRepaired(nulRun.code !== 0 && !nulRun.output.includes('RAN') && nulRun.launchCwd === undefined, `a launch whose environment carries a NUL byte ran anyway (code=${nulRun.code}, ${nulRun.output.slice(0, 120)})`);
      const secretRun = await runValidationCommand({ label: 'secret delivery', command: process.execPath, args: ['-e', 'process.stdout.write(String(process.env.POS_SYNTHETIC_SECRET))'], env: { POS_SYNTHETIC_SECRET: secretValue }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
      expectRepaired(secretRun.code === 0 && secretRun.output.includes(secretValue), `the executor's protected launch lost the credential (${secretRun.code}, ${secretRun.output.slice(0, 80)})`);
      const protectionSource12 = readFileSync(join(repoRoot, 'packages/main/src/core/build-artifacts-protection.ts'), 'utf8');
      expectRepaired(!/const ENV_BIN|envBin/.test(protectionSource12) && protectionSource12.includes("'--args', String(launch.confidentialFd), '--'") && protectionSource12.includes('const sip = systemIntegrityProtectionRefusal(trust);')
        && protectionSource12.includes('trampoline, `/dev/fd/${launch.confidentialFd}`, ...inner]') && protectionSource12.includes('checkTransferableEnvironment(reapplied);\n      const payload = Buffer.from(reapplied.flatMap(')
        && protectionSource12.includes("const TRAMPOLINE = '/usr/bin/perl';") && protectionSource12.includes('exec { $ARGV[0] } @ARGV or exit 127;') && !protectionSource12.includes('exec "$@"'),
        'the protection still re-applies the environment through /usr/bin/env or bwrap argv (source-text guard)');
      rmSync(dyldDir, { recursive: true, force: true });
    }
    // Audit #43 (4): an OPTIONAL command that never launched (its pinned
    // directory was replaced before its turn) fails optionally, as it always
    // did: the plan still passes on its required commands and reports no
    // missing observation for a command that executed nothing.
    if (hostEnforced) {
      const canonicalRoot = realpathSync(root);
      const optDir = join(canonicalRoot, 'opt-dir'); mkdirSync(optDir); writeFileSync(join(optDir, 'validate.js'), 'process.stdout.write("OPTIONAL RAN"); process.exit(0);\n');
      const optOther = join(canonicalRoot, 'opt-other'); mkdirSync(optOther);
      let launches = 0;
      const optionalPlan = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
        { label: 'required', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 },
        { label: 'optional never launched', command: 'node', args: ['validate.js'], cwd: 'opt-dir', optional: true, timeoutMs: 20_000 },
      ], warnings: [] }, root, undefined, undefined, { jobs: 1, beforeLaunch: () => { launches += 1; if (launches === 2) { renameSync(optDir, `${optDir}-moved`); symlinkSync(optOther, optDir); } } });
      const optionalResult = optionalPlan.commands.find((command) => command.label === 'optional never launched');
      expectRepaired(optionalPlan.allPass === true && optionalResult?.launchOutcome === 'not-launched' && optionalResult.code !== 0 && optionalResult.output.includes('[launch_directory_drift]')
        && !optionalPlan.details.some((line) => line.includes('build_artifacts_observation_missing')) && !(optionalResult.output ?? '').includes('OPTIONAL RAN'),
        `an optional command that never launched failed the whole plan as unobserved (allPass=${optionalPlan.allPass}, outcome=${optionalResult?.launchOutcome}, code=${optionalResult?.code}, ${optionalPlan.details.join(' | ').slice(0, 200)})`);
      rmSync(optDir, { force: true }); rmSync(`${optDir}-moved`, { recursive: true, force: true }); rmSync(optOther, { recursive: true, force: true });
      // Audit #44 (1): a plan whose only commands were optional and never
      // launched executed nothing; its label is the host's resolution (as for
      // a plan with nothing to run), so the persisted PASS stays admissible
      // instead of being refused as unenforced.
      const onlyDir = join(canonicalRoot, 'only-dir'); mkdirSync(onlyDir); writeFileSync(join(onlyDir, 'validate.js'), 'process.exit(0);\n');
      const onlyOther = join(canonicalRoot, 'only-other'); mkdirSync(onlyOther);
      const onlyOptional = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
        { label: 'only optional never launched', command: 'node', args: ['validate.js'], cwd: 'only-dir', optional: true, timeoutMs: 20_000 },
      ], warnings: [] }, root, undefined, undefined, { jobs: 1, beforeLaunch: () => { if (existsSync(onlyDir) && !lstatSync(onlyDir).isSymbolicLink()) { renameSync(onlyDir, `${onlyDir}-moved`); symlinkSync(onlyOther, onlyDir); } } });
      const hostLabel = binding.resolveArtifactWriteProtection(root).label;
      expectRepaired(onlyOptional.allPass === true && onlyOptional.commands[0]?.launchOutcome === 'not-launched' && onlyOptional.buildArtifactsProtection === hostLabel && typeof onlyOptional.buildArtifactsHash === 'string' && binding.artifactProtectionSatisfied(onlyOptional.buildArtifactsProtection),
        `a plan whose only optional command never launched recorded no admissible protection label (allPass=${onlyOptional.allPass}, label=${onlyOptional.buildArtifactsProtection}, hash=${onlyOptional.buildArtifactsHash}, ${onlyOptional.details.join(' | ').slice(0, 160)})`);
      const executorSource11 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
      expectRepaired(executorSource11.includes("const executed = commands.filter((result) => result.launchOutcome !== 'not-launched');") && executorSource11.includes("const tests = executed.filter((result) => result.buildArtifactsRole !== 'build');"),
        'the plan label aggregates commands that never launched (source-text guard)');
      rmSync(onlyDir, { force: true }); rmSync(`${onlyDir}-moved`, { recursive: true, force: true }); rmSync(onlyOther, { recursive: true, force: true });
    }
    // Audit #39 (3): the walker stops where the kernel's resolution would
    // fail and keeps the rest spelled as written, so `existing-file/..`,
    // `missing/..` and `unsearchable/..` remain the invalid names a launch
    // refuses instead of collapsing into their valid parent and running there.
    if (hostEnforced) {
      const canonicalRoot = realpathSync(root);
      const negRoot = join(canonicalRoot, 'negative-cwd'); mkdirSync(negRoot); writeFileSync(join(negRoot, 'validate.js'), 'process.stdout.write("parent ran"); process.exit(0);\n');
      writeFileSync(join(negRoot, 'a-file'), 'not a directory\n');
      const cases = [
        { name: 'file/..', cwd: `${negRoot}/a-file/..`, expectedError: /ENOTDIR|ENOENT|not a directory/ },
        { name: 'missing/..', cwd: `${negRoot}/missing/..`, expectedError: /ENOENT|no such file/ },
      ];
      if (process.getuid?.() !== 0) { mkdirSync(join(negRoot, 'locked')); chmodSync(join(negRoot, 'locked'), 0o000); cases.push({ name: 'unsearchable/..', cwd: `${negRoot}/locked/..`, expectedError: /EACCES|ENOENT|permission denied/ }); }
      try {
        for (const testCase of cases) {
          const canonical = binding.canonicalizeExistingPath(testCase.cwd);
          expectRepaired(canonical === testCase.cwd, `the walker collapsed ${testCase.name} into a launchable parent (${canonical})`);
          // Control: the kernel refuses that cwd.
          const kernel = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: testCase.cwd, encoding: 'utf8' });
          check(kernel.error !== undefined && testCase.expectedError.test(String(kernel.error.code ?? kernel.error.message)), `control: the kernel refuses ${testCase.name} as a cwd (${kernel.error?.code ?? kernel.status})`);
          const launched = await run([{ label: testCase.name, command: 'node', args: ['validate.js'], cwd: testCase.cwd, timeoutMs: 20_000 }]);
          expectRepaired(launched.allPass === false && !(launched.commands[0]?.output ?? '').includes('parent ran') && launched.commands[0]?.launchCwd !== negRoot,
            `a declared cwd of ${testCase.name} was executed in its parent directory (allPass=${launched.allPass}, launchCwd=${launched.commands[0]?.launchCwd}, ${(launched.commands[0]?.output ?? '').slice(0, 100)})`);
        }
      } finally { if (existsSync(join(negRoot, 'locked'))) chmodSync(join(negRoot, 'locked'), 0o755); }
      // The tail a build has not created yet still keeps its spelling in the
      // same path space (no `..` involved): dist under an existing package.
      check(binding.canonicalizeExistingPath(`${negRoot}/packages/main/dist`) === join(negRoot, 'packages', 'main', 'dist'), 'control: a missing tail without `..` is appended as written');
      rmSync(negRoot, { recursive: true, force: true });
    }
    // Audit #39 (2): the walker preserves the root of the path as parsed for
    // the platform it walks — `/`, a Windows drive, a UNC share — and joins
    // with that platform's separator; Windows semantics are exercised through
    // the walker's seam with an in-memory tree (no Windows host here).
    {
      const tree = new Map([
        ['C:\\repo', 'dir'], ['C:\\repo\\alias', 'link:C:\\elsewhere\\tree'], ['C:\\elsewhere', 'dir'], ['C:\\elsewhere\\tree', 'dir'], ['C:\\elsewhere\\checks', 'dir'],
        ['C:\\repo\\checks', 'dir'], ['C:\\work', 'dir'], ['C:\\repo\\a-file', 'file'],
        ['\\\\server\\share\\dir', 'dir'], ['\\\\server\\share\\other', 'dir'],
        ['D:\\workspace', 'dir'], ['D:\\workspace\\checks', 'dir'],
      ]);
      const winSeam = {
        platform: 'win32', cwd: 'C:\\work',
        lstat: (path) => { const kind = tree.get(path); if (!kind) { const error = new Error('ENOENT'); throw error; } return { isSymbolicLink: () => kind.startsWith('link:'), isDirectory: () => kind === 'dir' }; },
        readlink: (path) => tree.get(path).slice(5),
        searchable: () => true,
        // Audit #44 (2): Windows keeps a current directory per drive.
        driveCurrentDirectory: (drive) => (drive.toUpperCase() === 'D' ? 'D:\\workspace' : undefined),
      };
      const winCases = [
        ['C:\\repo', 'C:\\repo', 'a drive-rooted directory keeps its drive'],
        ['C:\\repo\\alias\\..\\checks', 'C:\\elsewhere\\checks', '`..` after a drive-rooted link steps out of the link target'],
        ['\\\\server\\share\\dir\\..\\other', '\\\\server\\share\\other', 'a UNC path keeps its share root'],
        ['sub', 'C:\\work\\sub', 'a relative cwd joins the base with the platform separator'],
        ['C:\\repo\\a-file\\..', 'C:\\repo\\a-file\\..', '`..` after a file stays as written on Windows too'],
        ['C:\\repo\\missing\\dist', 'C:\\repo\\missing\\dist', 'a missing tail is appended as written under a drive root'],
        // Audit #43 (2): drive-relative and rooted-without-drive names.
        ['C:checks', 'C:\\work\\checks', 'a same-drive drive-relative cwd is relative to the base'],
        ['c:checks', 'C:\\work\\checks', 'drive letters compare case-insensitively'],
        ['D:checks', 'D:\\workspace\\checks', 'a different-drive drive-relative cwd is anchored at that drive\'s current directory'],
        ['D:alias\\..\\checks', 'D:\\workspace\\alias\\..\\checks', 'the remaining components after a drive anchor stay as written'],
        ['E:checks', 'E:\\checks', 'a drive with no known current directory falls back to its root'],
        ['\\repo', 'C:\\repo', 'a rooted cwd without a drive takes the base drive'],
      ];
      for (const [input, expected, why] of winCases) {
        const got = binding.canonicalizeExistingPath(input, winSeam);
        expectRepaired(got === expected, `Windows path semantics: ${why} (${input} -> ${got}, expected ${expected})`);
      }
      expectRepaired(binding.launchDirectoryOf('C:\\repo', 'alias\\..\\checks', { platform: 'win32' }) === 'C:\\repo\\alias\\..\\checks' && binding.launchDirectoryOf('C:\\repo', 'D:\\other', { platform: 'win32' }) === 'D:\\other',
        'launchDirectoryOf does not honour Windows absolute paths and separators');
      expectRepaired(binding.launchDirectoryOf('C:\\repo', 'C:checks', { platform: 'win32' }) === 'C:\\repo\\checks'
        && binding.launchDirectoryOf('C:\\repo', 'C:alias\\..\\checks', { platform: 'win32' }) === 'C:\\repo\\alias\\..\\checks'
        && binding.launchDirectoryOf('C:\\repo', 'D:checks', { platform: 'win32' }) === 'D:\\checks'
        && binding.launchDirectoryOf('C:\\repo', 'D:checks', winSeam) === 'D:\\workspace\\checks'
        && binding.launchDirectoryOf('C:\\repo', 'd:', winSeam) === 'D:\\workspace'
        && binding.launchDirectoryOf('C:\\repo', '\\checks', { platform: 'win32' }) === 'C:\\checks'
        && binding.launchDirectoryOf('\\\\server\\share\\dir', '\\other', { platform: 'win32' }) === '\\\\server\\share\\other',
        'launchDirectoryOf corrupts Windows drive-relative or rooted-without-drive cwds');
      check(binding.canonicalizeExistingPath('/', { platform: 'posix' }) === '/', 'control: the POSIX root canonicalises to itself');
    }
    // Linux only, where LD_PRELOAD is honoured: a preload library whose
    // constructor rewrites dist and exits 0 before the declared command runs.
    // Applied inside the sandbox its write is denied (it exits 7 instead);
    // applied to the wrapper it would run before bwrap mounts anything and
    // rewrite dist under an enforced PASS. Skipped where a C compiler, bwrap
    // enforcement or Linux itself is unavailable, and said so.
    if (process.platform === 'linux' && hostEnforced) {
      const cc = spawnSync('cc', ['--version'], { encoding: 'utf8' });
      if (cc.status === 0) {
        const preloadDir = join(planSandbox, 'preload'); mkdirSync(preloadDir, { recursive: true });
        // The constructor rewrites the file named by FIXTURE_ARTIFACT and
        // exits 0 before the declared command runs; where the write is denied
        // it exits with the DENIAL code (3), and with 7 on any other failure,
        // so the protected run must report the denial and nothing else.
        const preloadSource = [
          '#include <errno.h>',
          '#include <fcntl.h>',
          '#include <stdlib.h>',
          '#include <unistd.h>',
          'static const char rewritten[] = "process.exit(1); // rewritten by the preload constructor\\n";',
          '__attribute__((constructor)) static void swap(void) {',
          '  const char *path = getenv("FIXTURE_ARTIFACT");',
          '  if (path == NULL) _exit(9);',
          '  int fd = open(path, O_WRONLY | O_TRUNC);',
          '  if (fd >= 0) { ssize_t n = write(fd, rewritten, sizeof(rewritten) - 1); close(fd); _exit(n == (ssize_t)(sizeof(rewritten) - 1) ? 0 : 7); }',
          '  _exit(errno == EACCES || errno == EROFS || errno == EPERM ? 3 : 7);',
          '}',
          '',
        ].join('\n');
        writeFileSync(join(preloadDir, 'preload.c'), preloadSource);
        const built = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wimplicit-function-declaration', '-Wint-conversion', '-shared', '-fPIC', '-o', join(preloadDir, 'preload.so'), join(preloadDir, 'preload.c')], { encoding: 'utf8' });
        check(built.status === 0, `control: the preload fixture must compile cleanly under -Werror (${built.stderr})`);
        // Unprotected control: outside any wrapper the constructor really does
        // rewrite a disposable artifact and exit 0 before node runs anything.
        const disposable = join(preloadDir, 'disposable.js'); writeFileSync(disposable, BUILD_A);
        const unprotected = spawnSync('node', ['validate-clean.js'], { cwd: root, encoding: 'utf8', env: { ...process.env, LD_PRELOAD: join(preloadDir, 'preload.so'), FIXTURE_ARTIFACT: disposable }, timeout: 20_000 });
        check(unprotected.status === 0 && readFileSync(disposable, 'utf8').includes('rewritten by the preload constructor'),
          `control: the preload constructor must rewrite an unprotected file and exit 0 (exit ${unprotected.status}, ${JSON.stringify(readFileSync(disposable, 'utf8').slice(0, 60))})`);
        // Protected run: the same library declared on a validation command is
        // applied inside the sandbox, its write is denied, and the plan fails
        // with the denial code — never a pass, never a rewritten dist, never
        // some other failure standing in for the denial.
        const hijacked = await run([{ label: 'preload constructor', command: 'node', args: ['validate-clean.js'], env: { LD_PRELOAD: join(preloadDir, 'preload.so'), FIXTURE_ARTIFACT: join(mainDist, 'x.js') }, timeoutMs: 20_000 }]);
        const hijackedCommand = hijacked.commands[0];
        expectRepaired(readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A && hijacked.allPass === false && hijackedCommand?.code === 3 && (hijackedCommand?.buildArtifactsProtection ?? '').startsWith('enforced:'),
          `a preload constructor did not meet the intended denial inside the sandbox (allPass=${hijacked.allPass}, exit ${hijackedCommand?.code}, ${hijackedCommand?.buildArtifactsProtection}, dist ${readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A ? 'intact' : 'REWRITTEN'})`);
        writeFileSync(join(mainDist, 'x.js'), BUILD_A);
      } else {
        console.log('preload-constructor case skipped: no C compiler on this Linux host');
      }
    } else {
      console.log(`preload-constructor case skipped: LD_PRELOAD is a Linux loader variable (platform=${process.platform}, enforced=${hostEnforced})`);
    }

    // Target: a validate-file-shaped command that tries to rewrite the artifacts it tested.
    const rewritten = await run([{ label: 'validate file', command: 'node', args: ['validate.js'], timeoutMs: 20_000 }]);
    expectRepaired(readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A,
      'a validate file rewrote the compiled artifacts it was testing; the write was not prevented');
    expectRepaired(rewritten.allPass === false, `a validate file that tried to rewrite dist still produced a passing plan (${rewritten.details.join(' | ')})`);
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // A non-build command among several tries to rewrite dist: refused at the write.
    const mixed = await run([
      { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 },
      { label: 'rewrites dist', command: 'node', args: ['-e', REWRITE], timeoutMs: 20_000 },
    ]);
    expectRepaired(readFileSync(join(mainDist, 'x.js'), 'utf8') === BUILD_A, 'a non-build command inside a plan rewrote dist; the write was not prevented');
    expectRepaired(mixed.allPass === false, `a non-build command that tried to rewrite dist still produced a passing plan (${mixed.details.join(' | ')})`);
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

    // Audit #11 (5): a build declared by shape with an ABSOLUTE cwd (no
    // providesBuildProof) must be prioritised exactly as it is recognised at
    // launch, so a test listed before it still executes the rebuilt artifacts.
    mkdirSync(join(root, 'packages/main'), { recursive: true });
    writeFileSync(join(root, 'packages/main/package.json'), JSON.stringify({ name: 'fixture-main', private: true, scripts: {
      build: "node -e \"require('node:fs').writeFileSync('dist/tasks/x.js', 'process.exit(0); // rebuilt by npm build\\n')\"",
    } }, null, 2) + '\n');
    git(root, ['add', 'packages/main/package.json']); git(root, ['commit', '-qm', 'fixture: npm build script']);
    const preNpm = binding ? binding.currentBuildArtifactsHash(root) : undefined;
    const ordered = await run([
      { label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 },
      { label: 'npm build', command: 'npm', args: ['run', 'build'], cwd: join(root, 'packages/main'), timeoutMs: 60_000 },
    ]);
    check(readFileSync(join(mainDist, 'x.js'), 'utf8').includes('rebuilt by npm build'), `control: the npm build must have rewritten dist (${ordered.details.join(' | ')})`);
    const npmBuild = ordered.commands.find((command) => command.label === 'npm build');
    const testBeforeNpm = ordered.commands.find((command) => command.label === 'pass');
    expectRepaired(npmBuild?.buildArtifactsRole === 'build', 'an absolute-cwd npm build was not recognised as the registered build at launch');
    expectRepaired(ordered.allPass === true && Boolean(testBeforeNpm?.buildArtifactsBefore) && testBeforeNpm?.buildArtifactsBefore === npmBuild?.buildArtifactsAfter,
      `a test listed before an absolute-cwd npm build did not execute the rebuilt artifacts (allPass=${ordered.allPass}; ${ordered.details.join(' | ')})`);
    if (binding) expectRepaired(ordered.buildArtifactsHash === binding.currentBuildArtifactsHash(root) && ordered.buildArtifactsHash !== preNpm, 'the plan must bind the artifacts the npm build produced');
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // Audit #16 (1): with jobs > 1 a registered build must still run FIRST and
    // ALONE, whatever resources the caller declared, so no protected test can
    // overlap the one command that writes the trees. The build rewrites dist
    // late in its own life; the test passes only if it sees the rewritten
    // bytes, which it can only do if it was not launched until the build
    // returned.
    const LATE_BUILD = "setTimeout(() => { require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rebuilt late\\n'); process.exit(0); }, 1500)";
    const SEES_LATE_BUILD = "process.exit(require('node:fs').readFileSync('packages/main/dist/tasks/x.js', 'utf8').includes('rebuilt late') ? 0 : 1)";
    const barrier = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
      { label: 'test that needs the build', command: 'node', args: ['-e', SEES_LATE_BUILD], timeoutMs: 20_000, resources: [{ class: 'fixed-path', key: 'tests', access: 'shared' }] },
      { label: 'late build', command: 'node', args: ['-e', LATE_BUILD], timeoutMs: 20_000, providesBuildProof: 'packages-main-build', resources: [{ class: 'fixed-path', key: 'packages/main/dist', access: 'exclusive' }] },
    ], warnings: [] }, root, undefined, undefined, { jobs: 2 });
    const barrierBuild = barrier.commands.find((command) => command.label === 'late build');
    const barrierTest = barrier.commands.find((command) => command.label === 'test that needs the build');
    check(readFileSync(join(mainDist, 'x.js'), 'utf8').includes('rebuilt late'), 'control: the late build must have rewritten dist');
    expectRepaired(barrierTest?.code === 0 && barrier.allPass === true && Boolean(barrierTest?.buildArtifactsBefore) && barrierTest?.buildArtifactsBefore === barrierBuild?.buildArtifactsAfter,
      `with jobs=2 a test overlapped the registered build instead of waiting for it (test code=${barrierTest?.code}, allPass=${barrier.allPass}; ${barrier.details.join(' | ')})`);
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // Audit #18 (2): a plan of ONLY registered builds records the build-only
    // label and binds what it produced; routine evidence carrying that label is
    // admissible and reusable while the artifacts stay, refused once they drift.
    const buildOnlyPlan = await run([{ label: 'build', command: 'node', args: ['-e', REWRITE], timeoutMs: 20_000, providesBuildProof: 'packages-main-build' }]);
    expectRepaired(buildOnlyPlan.allPass === true && buildOnlyPlan.buildArtifactsProtection === 'build-only:registered-builds-only' && /^[a-f0-9]{64}$/.test(buildOnlyPlan.buildArtifactsHash ?? ''),
      `a build-only plan must record the build-only label and its binding (label=${buildOnlyPlan.buildArtifactsProtection}, hash=${buildOnlyPlan.buildArtifactsHash})`);
    if (binding) {
      const rootHead = currentGitHead(root); const rootMaterial = currentMaterialHash(root, 'HEAD', root); const rootStoryFiles = currentStoryFilesHash(root, 'HEAD', root);
      const buildOnlyIdentity = buildRoutineValidationIdentity({ projectRoot: root, sourceKind: 'configured', sourceInputs: { fixture: 'build-only' }, commands: [{ label: 'build', command: 'node', args: ['-e', REWRITE], providesBuildProof: 'packages-main-build' }], profile: 'balanced', verificationPolicyInputs: { fixture: 'build-only' } });
      const buildOnlyEvidence = {
        command: 'proof-or-stop validate --story=B-bab --json', output: JSON.stringify({ allPass: true }), result: 'PASS', timestamp: new Date().toISOString(),
        headHash: rootHead, materialHash: rootMaterial, storyFilesHash: rootStoryFiles, buildArtifactsHash: buildOnlyPlan.buildArtifactsHash, buildArtifactsProtection: buildOnlyPlan.buildArtifactsProtection,
        verificationCoverage: { missingRequired: 0 },
        commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
        disposition: 'executed', routineValidationIdentity: buildOnlyIdentity,
      };
      const buildOnlyReuse = () => evaluateRoutineValidationReuse({ root, gitCwd: root, evidence: buildOnlyEvidence, currentIdentity: buildOnlyIdentity, currentCoverage: { missingRequired: 0 }, currentMaterialHash: rootMaterial, currentStoryFilesHash: rootStoryFiles, clean: true, headBefore: rootHead, headAfter: rootHead, currentBuildArtifactsHash: binding.currentBuildArtifactsHash(root) });
      const buildOnlyAdmission = () => evaluateValidationEvidenceAdmissibility({ evidence: buildOnlyEvidence, expectedCommand: buildOnlyEvidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage', blockingDirtyReason: '', gitCwd: root, metadataRoot: root });
      expectRepaired(buildOnlyReuse().reusable === true && buildOnlyAdmission().ok === true,
        `build-only evidence was refused while its artifacts were unchanged (reuse=${buildOnlyReuse().refusalReasons.join(',')}; admission=${buildOnlyAdmission().reasonCodes.join(',')})`);
      writeFileSync(join(mainDist, 'x.js'), BUILD_B);
      expectRepaired(buildOnlyReuse().reusable === false && buildOnlyAdmission().ok === false, 'build-only evidence was accepted after its artifacts drifted');
    }
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);
    expectRepaired(buildCommand?.buildArtifactsProtection === 'registered-build:writes-permitted',
      `the registered build must be launched unprotected so it can write (${buildCommand?.buildArtifactsProtection})`);
    expectRepaired(Boolean(testCommand?.buildArtifactsBefore) && testCommand?.buildArtifactsBefore === buildCommand?.buildArtifactsAfter,
      'the registered build must run before the test so the test starts against the rebuilt artifacts');

    // Audit #6 / #9: the swap-test-restore that no boundary observation can see.
    // ONE command saves the registered build, installs a different one, tests
    // against it, and restores the original bytes and timestamps before it
    // returns. Both boundary observations agree and the plan ends on the
    // registered build's own output, so only preventing the write closes it.
    const STAMP = '2026-01-02T03:04:05.678Z';
    const stamped = (body) => `const fs = require('node:fs'); const p = 'packages/main/dist/tasks/x.js'; fs.writeFileSync(p, ${JSON.stringify(body)}); const d = new Date('${STAMP}'); fs.utimesSync(p, d, d);`;
    const FAILING_BUILD_A = stamped('process.exit(1); // build A\n');
    const IN_COMMAND_SWAP = [
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      "const p = 'packages/main/dist/tasks/x.js';",
      'const a = fs.readFileSync(p);',
      'const st = fs.statSync(p);',
      `fs.writeFileSync(p, ${JSON.stringify('process.exit(0); // build B\n')});`,
      'const inner = cp.spawnSync(process.execPath, [p]);',
      'fs.writeFileSync(p, a);',
      'fs.utimesSync(p, st.atime, st.mtime);',
      'process.exit(inner.status === 0 ? 0 : 1);',
    ].join(' ');
    const SWAP_LABEL = 'swap, test and restore inside one command';
    const inCommand = await run([
      { label: 'build', command: 'node', args: ['-e', FAILING_BUILD_A], timeoutMs: 20_000, providesBuildProof: 'packages-main-build' },
      { label: SWAP_LABEL, command: 'node', args: ['-e', IN_COMMAND_SWAP], timeoutMs: 20_000 },
    ]);
    const swapStep = inCommand.commands.find((command) => command.label === SWAP_LABEL);
    check(readFileSync(join(mainDist, 'x.js'), 'utf8').includes('build A'), 'control: the registered build produced build A');
    check(spawnSync(process.execPath, [join(mainDist, 'x.js')]).status === 1,
      'trap: the installed build A must fail, so a passing inner test could only have executed build B');
    expectRepaired(swapStep?.code !== 0,
      `a command swapped a different build in, tested against it and restored the original; the write was not prevented (code=${swapStep?.code})`);
    expectRepaired(inCommand.allPass === false,
      `an in-command swap-test-restore still produced a passing plan (${inCommand.details.join(' | ')})`);
    if (binding) check(inCommand.buildArtifactsHash === undefined || inCommand.buildArtifactsHash === binding.currentBuildArtifactsHash(root),
      'any binding carried by the refused plan must be the untouched artifacts');
    writeFileSync(join(mainDist, 'x.js'), BUILD_A);

    // Protection must not block anything else: a command may still write
    // everywhere else, and may still READ the artifacts it is testing.
    // Outside the fixture repository: a new file inside it would trip the
    // unrelated worktree-pollution gate and prove nothing about protection.
    const permittedWrite = join(planSandbox, 'permitted-write.txt');
    const allowed = await run([{
      label: 'reads artifacts and writes elsewhere', command: 'node',
      args: ['-e', `const fs=require('node:fs'); fs.readFileSync('packages/main/dist/tasks/x.js'); fs.writeFileSync(${JSON.stringify(permittedWrite)},'ok'); process.exit(0);`],
      timeoutMs: 20_000,
    }]);
    expectRepaired(allowed.allPass === true, `write protection blocked a command that only read the artifacts and wrote elsewhere (${allowed.details.join(' | ')})`);
    check(readFileSync(permittedWrite, 'utf8') === 'ok', 'control: the permitted write actually happened');
    // Audit #22 (2): a project that has NOT declared the contract inapplicable
    // and has no trees is still protected against creating one inside a
    // command's window; the command exits 3 when denied, 0 if it succeeded.
    if (process.platform === 'darwin') {
      const bare = join(planSandbox, 'bare'); mkdirSync(bare);
      git(bare, ['init', '-q', '-b', 'main']); git(bare, ['config', 'user.email', 'fixture@example.invalid']); git(bare, ['config', 'user.name', 'Build Binding Fixture']); git(bare, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(bare, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
      writeFileSync(join(bare, '.gitignore'), 'dist\n'); git(bare, ['add', '.']); git(bare, ['commit', '-qm', 'bare fixture']);
      const CREATE_TREE = "const fs = require('node:fs'); try { fs.mkdirSync('packages/main/dist/tasks', { recursive: true }); fs.writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0);'); process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS'].includes(error && error.code) ? 3 : 4); }";
      const creation = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [{ label: 'create the tree', command: 'node', args: ['-e', CREATE_TREE], timeoutMs: 20_000 }], warnings: [] }, bare, undefined, undefined, {});
      const creator = creation.commands.find((command) => command.label === 'create the tree');
      expectRepaired(creator?.code === 3 && !existsSync(join(bare, 'packages/main/dist')),
        `a command in an undeclared tree-less project was allowed to create an artifact tree (code=${creator?.code}; ${creation.details.join(' | ')})`);
    }
    // Audit #21 (2): under the real protection a command may not move the
    // tree's ancestor aside (the rename that takes the tree out from under a
    // path rule or carries a mount away); it exits 3 when denied, 0 if it
    // succeeded (and put the directory back).
    const RENAME_ANCESTOR = "const fs = require('node:fs'); try { fs.renameSync('packages/main', 'packages/main.saved'); try { fs.renameSync('packages/main.saved', 'packages/main'); } catch {} process.exit(0); } catch (error) { process.exit(['EPERM','EACCES','EROFS','EBUSY'].includes(error && error.code) ? 3 : 4); }";
    const ancestorMove = await run([{ label: 'move the ancestor aside', command: 'node', args: ['-e', RENAME_ANCESTOR], timeoutMs: 20_000 }]);
    const moved = ancestorMove.commands.find((command) => command.label === 'move the ancestor aside');
    expectRepaired(moved?.code === 3 && existsSync(join(root, 'packages/main/dist/tasks/x.js')),
      `a protected command was allowed to move packages/main aside (code=${moved?.code}; ${ancestorMove.details.join(' | ')})`);

    // The plan-level rules stay the second line of defence for a host with no
    // protection mechanism, so they are exercised directly rather than through
    // writes that can no longer happen.
    if (executorRules) {
      const A = 'a'.repeat(64), B = 'b'.repeat(64);
      const cmd = (label, before, after, role) => ({ label, buildArtifactsBefore: before, buildArtifactsAfter: after, buildArtifactsRole: role });
      const rules = (commands, start, end) => executorRules({ commands, start, end });
      check(rules([cmd('t', A, A, 'test')], A, A).length === 0, 'control: an untouched plan has no binding failures');
      expectRepaired(rules([cmd('t', A, B, 'test')], A, B).some((line) => line.includes('build_artifacts_changed_by_non_build_command')),
        'the rules no longer catch a non-build command that changed the artifacts');
      expectRepaired(rules([cmd('t', A, A, 'test'), cmd('b', A, B, 'build')], A, B).some((line) => line.includes('receipt_not_bound_to_final_build')),
        'the rules no longer catch a test that executed a build replaced before the plan ended');
      expectRepaired(rules([cmd('b', A, B, 'build'), cmd('t', B, B, 'test')], A, A).some((line) => line.includes('build_artifacts_changed_after_build')),
        'the rules no longer catch a plan that ended on bytes the registered build did not produce');
      expectRepaired(rules([{ label: 'unobserved' }], A, A).some((line) => line.includes('build_artifacts_observation_missing')),
        'the rules no longer catch a command with no observations');
      // Audit #43 (4): a command the executor never launched executed nothing
      // and is not "unobserved": its own status decides, the binding holds.
      expectRepaired(rules([cmd('t', A, A, 'test'), { label: 'never launched', launchOutcome: 'not-launched' }], A, A).length === 0,
        'a tool-owned no-launch result is treated as an executed command with missing observations');
      expectRepaired(rules([cmd('t', A, A, 'test')], undefined, A).some((line) => line.includes('build_artifacts_identity_unavailable')),
        'the rules no longer refuse a plan whose artifact identity is unavailable');
    } else {
      expectRepaired(false, 'core/validation-executor exports no evaluatePlanBuildArtifactsBinding');
    }


    // Audit #8: dynamic runs aggregate several plans (build wave, selected
    // plans, shards). The aggregate must carry the validated binding of the
    // sequence, or publication of every authoritative dynamic run fails as
    // unbound and no rerun can repair it.
    if (binding?.combineSequencedBuildArtifactsBindings) {
      const combine = binding.combineSequencedBuildArtifactsBindings;
      const A = '1'.repeat(64), B = '2'.repeat(64), C = '3'.repeat(64);
      const plan = (provider, start, end, hash, commands = 1) => ({ provider, commands: Array.from({ length: commands }, () => ({})), ...(hash ? { buildArtifactsHash: hash } : {}), buildArtifacts: { root: '/r', start, end } });
      const wave = plan('wave-0', A, B, B);
      const bound = combine([wave, plan('selected', B, B, B)]);
      expectRepaired(bound.buildArtifactsHash === B && bound.failures.length === 0 && bound.buildArtifacts?.start === A && bound.buildArtifacts?.end === B,
        `a build wave followed by a selected plan that executed its output does not bind (${bound.failures.join(' | ')})`);
      const emptySelected = combine([wave, { provider: 'selected', commands: [], details: [] }]);
      expectRepaired(emptySelected.buildArtifactsHash === B && emptySelected.failures.length === 0,
        `an empty selected plan does not leave the validated build-wave binding in force (${emptySelected.failures.join(' | ')})`);
      expectRepaired(combine([]).buildArtifactsHash === undefined && combine([]).failures.length === 0, 'an empty sequence must have no binding and no failure');
      const betweenWaves = combine([wave, plan('selected', C, C, C)]);
      expectRepaired(!betweenWaves.buildArtifactsHash && betweenWaves.failures.some((f) => f.includes('build_artifacts_changed_between_plans')),
        `artifacts replaced between the build wave and the selected plan still bound (${betweenWaves.failures.join(' | ')})`);
      const shardDrift = combine([plan('shard-1', B, B, B), plan('shard-2', B, C, C)]);
      expectRepaired(!shardDrift.buildArtifactsHash && shardDrift.failures.some((f) => f.includes('build_artifacts_member_not_bound_to_final_build')),
        `a shard that ended on different bytes than its sibling executed still bound (${shardDrift.failures.join(' | ')})`);
      const unboundMember = combine([wave, plan('selected', B, B, undefined)]);
      expectRepaired(!unboundMember.buildArtifactsHash && unboundMember.failures.some((f) => f.includes('build_artifacts_member_unbound')),
        `a selected plan whose own rules failed (no binding) still let the sequence bind (${unboundMember.failures.join(' | ')})`);
      const rootMismatch = combine([wave, { ...plan('selected', B, B, B), buildArtifacts: { root: '/other', start: B, end: B } }]);
      expectRepaired(!rootMismatch.buildArtifactsHash && rootMismatch.failures.some((f) => f.includes('build_artifacts_root_mismatch')),
        `plans that digested different artifact roots still bound as one sequence (${rootMismatch.failures.join(' | ')})`);
      const nested = combine([wave, combine([plan('shard-1', B, B, B), plan('shard-2', B, B, B)])]);
      expectRepaired(nested.buildArtifactsHash === B && nested.failures.length === 0, `a nested aggregate (wave, then combined shards) does not bind (${nested.failures.join(' | ')})`);
    } else {
      expectRepaired(false, 'core/build-artifacts-identity exports no combineSequencedBuildArtifactsBindings');
    }
    const storyAwareSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
    const combineStart = storyAwareSource.indexOf('export function combineResults(');
    expectRepaired(combineStart >= 0 && storyAwareSource.slice(combineStart, combineStart + 1600).includes('combineSequencedBuildArtifactsBindings(results)'),
      'the dynamic result aggregation does not carry the validated sequence binding (source-text guard)');
    expectRepaired(storyAwareSource.includes('buildArtifactsDiagnostics: dynamicExecution.details.filter('), 'the dynamic run does not expose its binding diagnostics (source-text guard)');

    // The validate-file handler path cannot bypass the executor.
    const verifierSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
    const validateFileStart = verifierSource.indexOf('const runValidateFile = ');
    check(validateFileStart >= 0, 'runValidateFile must be defined');
    expectRepaired(verifierSource.slice(validateFileStart, validateFileStart + 1200).includes('executeValidationPlan('), 'the validate-file path does not execute through the observing executor (source-text guard)');
    expectRepaired(verifierSource.slice(validateFileStart, validateFileStart + 1200).includes('gitCwd: handlerGitCwd'), 'the validate-file executor call does not receive the handler-resolved git cwd as its artifact root (source-text guard)');
    const routinePlanStart = verifierSource.indexOf('const base = await executeValidationPlan(');
    check(routinePlanStart >= 0, 'the routine plan executor call must be defined');
    expectRepaired(verifierSource.slice(routinePlanStart, routinePlanStart + 600).includes('gitCwd: handlerGitCwd'), 'the routine plan executor call does not receive the handler-resolved git cwd as its artifact root (source-text guard)');
    const executorSource = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
    expectRepaired(executorSource.includes('receipt_not_bound_to_final_build') && executorSource.includes('build_artifacts_changed_by_non_build_command'),
      'the executor does not enforce the per-command build binding rules (source-text guard)');
    // The validate-file result is rebuilt from the child's output; it must carry
    // the executor binding and discard any binding the child printed itself.
    // Audit #10 (1): provenance is captured where the child is spawned and
    // travels through the reuse key; nothing relabels a result afterwards.
    expectRepaired(executorSource.includes("const buildArtifactsBefore = options.artifactBinding ? currentBuildArtifactsHash(options.artifactBinding.root, options.artifactBinding.configRoot) : undefined;")
      && executorSource.includes("buildArtifactsProtection: options.artifactBinding.protection"),
      'the executor capture does not record the build observations and protection at the spawn boundary (source-text guard)');
    expectRepaired(!/result\.buildArtifactsBefore = |result\.buildArtifactsAfter = |result\.buildArtifactsProtection = /.test(executorSource),
      'the executor still stamps observations or protection onto results after they return (source-text guard)');
    const sharedSource = readFileSync(join(repoRoot, 'packages/main/src/core/shared-validation-execution.ts'), 'utf8');
    expectRepaired(sharedSource.includes("resources:command.resources ?? null},\n      // Inside `inputs`: the key builder hashes its declared fields only, so\n      // a binding placed beside them would be silently ignored (it was, once).\n      artifactBinding:artifactBinding ? {hash:artifactBindingHash,protection:artifactBinding.protection} : null},"),
      'the shared-execution reuse key does not include the artifact identity and protection INSIDE the hashed inputs (source-text guard)');
    expectRepaired(sharedSource.includes('fresh.buildArtifactsBefore !== fresh.buildArtifactsAfter'),
      'a run that changed the artifacts can still be cached as reusable (source-text guard)');
    expectRepaired(sharedSource.includes('buildArtifactsBefore:artifactBindingHash,buildArtifactsAfter:artifactBindingHash,buildArtifactsProtection:artifactBinding.protection'),
      'a reused result does not inherit the binding of the run that was executed (source-text guard)');
    const doneRequiredSource2 = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
    expectRepaired(doneRequiredSource2.includes('buildArtifactsProtection: result.buildArtifactsProtection') && !doneRequiredSource2.includes('const buildArtifactsAfter = currentBuildArtifactsHash(args.gitCwd);'),
      'the DONE-required writer still observes and stamps its own protection instead of recording what the execution carried (source-text guard)');
    // Audit #10 (2): signed dynamic receipts bind the executed artifacts and
    // lapse with the compiled bytes, not only with the build's output.
    const coreDynamicSource = readFileSync(join(repoRoot, 'packages/main/src/core/story-aware-validation.ts'), 'utf8');
    expectRepaired(coreDynamicSource.includes("'proof-or-stop.validation-command-receipt.v3'") && coreDynamicSource.includes("reasons.push('missing-executed-build-binding')")
      && coreDynamicSource.includes('receipt.buildArtifactsDigest !== ctx.buildArtifactsHash'),
      'dynamic receipts do not bind the executed artifacts, or reuse does not require the current build (source-text guard)');
    expectRepaired(storyAwareSource.includes('buildArtifactsHash: wave.buildArtifactsHash ?? null, commands: wave.commands.map(')
      && storyAwareSource.includes('buildArtifactsDigest: executedBuild,')
      && storyAwareSource.includes("version: 10, executor: 'validation-executor'"),
      'the build proof ignores compiled bytes, receipts omit the executed build, or the runner policy version was not bumped (source-text guard)');
    const dynamicBindingStart = verifierSource.indexOf('function dynamicBuildArtifactsBinding(');
    check(dynamicBindingStart >= 0, 'dynamicBuildArtifactsBinding must be defined');
    expectRepaired(verifierSource.slice(dynamicBindingStart, dynamicBindingStart + 900).includes('executedDynamic.buildArtifactsHash'),
      'the authoritative dynamic binding does not consume the run-level sequence binding (source-text guard)');
    expectRepaired((verifierSource.match(/details: \[executedDynamic\.runtimeReport, \.\.\.executedDynamic\.buildArtifactsDiagnostics\]/g) ?? []).length === 2,
      'the authoritative dynamic assemblies do not surface the binding diagnostics (source-text guard)');
    const bindingHelperStart = verifierSource.indexOf('const withExecutorBinding = ');
    expectRepaired(bindingHelperStart >= 0 && verifierSource.slice(bindingHelperStart, bindingHelperStart + 900).includes('validation.buildArtifactsHash')
      && verifierSource.includes('const bound = withExecutorBinding(value);'),
      'the validate-file result assemblies do not carry the executor build binding (source-text guard)');
  } finally {
    rmTree(planSandbox);
  }
} else {
  // Audit #14 (4): without enforcement a routine plan still runs and records
  // its observation, labelled unenforced, which no consumer treats as
  // authoritative; the prevention cases cannot hold and are not pretended.
  const planSandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-plan-unenforced-'));
  try {
    const root = join(planSandbox, 'plan'); mkdirSync(root);
    git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['config', 'user.name', 'Build Binding Fixture']); git(root, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(root, '.gitignore'), 'dist\n');
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
    git(root, ['add', '.']); git(root, ['commit', '-qm', 'plan fixture']);
    mkdirSync(join(root, 'packages/main/dist/tasks'), { recursive: true }); writeFileSync(join(root, 'packages/main/dist/tasks/x.js'), BUILD_A);
    mkdirSync(join(root, 'packages/utils/dist'), { recursive: true }); writeFileSync(join(root, 'packages/utils/dist/index.js'), 'export const utils = 1;\n');
    const observed = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [{ label: 'pass', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 20_000 }], warnings: [] }, root, undefined, undefined, {});
    expectRepaired(observed.allPass === true && typeof observed.buildArtifactsProtection === 'string' && observed.buildArtifactsProtection.startsWith('unenforced:'),
      `on a host without enforcement a routine plan must run observation-only under an unenforced label (allPass=${observed.allPass}, label=${observed.buildArtifactsProtection})`);
    if (binding) expectRepaired(!binding.artifactProtectionSatisfied(observed.buildArtifactsProtection), 'an unenforced routine plan label satisfied the contract');
    console.log('skip: executor prevention cases need demonstrated artifact write protection on this host (observation-only outcome asserted instead)');
  } finally {
    rmTree(planSandbox);
  }
}

// ---------------------------------------------------------------------------
// Validate-file handler path, end to end through the built CLI, with and
// without --json. `npx tsx` resolves a local node_modules/.bin/tsx shim that
// runs the file with Node's native TypeScript stripping, so no network is used.
// ---------------------------------------------------------------------------
if (hostEnforced) {
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
      // null: a project with no validator at all (no validate.ts, no configured
      // validate.commands, no discoverable fallback).
      if (validateTs !== null) writeFileSync(join(root, 'validate.ts'), validateTs);
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

    // Audit #8 follow-up, found by running main's reuse and terminal verifiers
    // against the merged tree: a Story in a project with NO configured validator never
    // reaches the executor, so its evidence carried no binding and this Lab's
    // publication guard refused it as build_artifacts_unavailable — a project
    // without validate.commands could not persist validation evidence at all.
    // The path now observes the identity through an empty executor plan.
    const noValidator = seed('no-validator', null);
    const noValidatorRun = noValidator.runCli(['--json']);
    expectRepaired(noValidatorRun.status === 0,
      `a Story in a project with no configured validator cannot persist validation evidence (${noValidatorRun.text.slice(0, 400)})`);
    expectRepaired(/^[a-f0-9]{64}$/.test(noValidator.evidence()?.buildArtifactsHash ?? ''),
      'no-validator evidence does not record the build identity the executor observed');
    check(noValidator.evidence()?.result === 'PASS' || noValidator.evidence()?.result === 'WARN',
      `control: the no-validator run must persist a non-failing result (got ${JSON.stringify(noValidator.evidence()?.result)})`);
    // Audit #11 (4): evidence a successful run persists must carry the
    // protection label its consumers require, on every path (validate file,
    // no validator, dynamic), or the run can never be reused or admitted.
    if (binding?.artifactProtectionSatisfied) {
      expectRepaired(binding.artifactProtectionSatisfied(clean.evidence()?.buildArtifactsProtection),
        `validate-file PASS evidence carries no satisfied protection label (${clean.evidence()?.buildArtifactsProtection})`);
      expectRepaired(binding.artifactProtectionSatisfied(noValidator.evidence()?.buildArtifactsProtection),
        `no-validator evidence carries no satisfied protection label (${noValidator.evidence()?.buildArtifactsProtection})`);
      const verifierSource2 = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
      expectRepaired((verifierSource2.match(/buildArtifactsProtection: executedDynamic\.buildArtifactsProtection/g) ?? []).length >= 2
        && verifierSource2.includes('buildArtifactsProtection: noCommandPlan.buildArtifactsProtection'),
        'the verifier drops the protection label when assembling the dynamic authoritative result or the no-validator result (source-text guard)');
      const dynamicHandlerSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      expectRepaired(dynamicHandlerSource.includes('...(runProtection ? { buildArtifactsProtection: runProtection } : {}),') && dynamicHandlerSource.includes("row.disposition === 'reuse' && row.receiptId"),
        'the dynamic run drops the aggregate protection label, or ignores the receipts it reused when only the build executed (source-text guard)');
      // Audit #11 (3): the shared-execution cache revalidates the artifact
      // identity and publishes a reusable receipt only for a run that observed
      // exactly the key's identity and label.
      const sharedSource2 = readFileSync(join(repoRoot, 'packages/main/src/core/shared-validation-execution.ts'), 'utf8');
      expectRepaired(sharedSource2.includes('&& (!artifactBinding || currentBuildArtifactsHash(artifactBinding.root, artifactBinding.configRoot) === artifactBindingHash);'),
        'the shared-execution unchanged() check ignores the artifact identity in the reuse key (source-text guard)');
      expectRepaired(sharedSource2.includes('fresh.buildArtifactsBefore !== artifactBindingHash || fresh.buildArtifactsAfter !== artifactBindingHash || fresh.buildArtifactsProtection !== artifactBinding.protection'),
        'a run whose observations differ from the reuse key can still be cached as reusable (source-text guard)');
      // Audit #12 (2): the registered build earns a receipt bound to its
      // output (stored integrity needs one for the Wave-0 row), that receipt
      // verifies, and it never authorises reuse.
      const coreDynamicSource2 = readFileSync(join(repoRoot, 'packages/main/src/core/story-aware-validation.ts'), 'utf8');
      expectRepaired(coreDynamicSource2.includes('export function receiptProtectionAcceptable(') && coreDynamicSource2.includes('|| label === REGISTERED_BUILD_PROTECTION_LABEL')
        && coreDynamicSource2.includes("if (receipt.buildArtifactsProtection === REGISTERED_BUILD_PROTECTION_LABEL) return false;"),
        'registered-build receipts are refused by verification or accepted for reuse (source-text guard)');
      expectRepaired(dynamicHandlerSource.includes('const registeredBuild = args.result.buildArtifactsProtection === REGISTERED_BUILD_PROTECTION_LABEL;')
        && dynamicHandlerSource.includes('const executedBuild = registeredBuild ? args.result.buildArtifactsAfter : args.result.buildArtifactsBefore;'),
        'receiptForResult issues no receipt for the registered build (source-text guard)');
      // Audit #12 (5): superseded-schema receipts are history, dropped on read
      // so they can never block the current predicate.
      expectRepaired((dynamicHandlerSource.match(/receipt\.schema === VALIDATION_RECEIPT_SCHEMA\)/g) ?? []).length >= 2,
        'superseded-schema receipts are retained where every receipt must verify (source-text guard)');
      // Audit #12 (3): the probe removes only what it demonstrably created,
      // never recursively.
      const protectionSource2 = readFileSync(join(repoRoot, 'packages/main/src/core/build-artifacts-protection.ts'), 'utf8');
      expectRepaired(protectionSource2.includes('const written = existing ? existsSync(target) : run.status === 0 && isDirectory(target);')
        && protectionSource2.includes('if (existing) rmSync(target, { force: true }); else rmdirSync(target);') && !/rmSync\(target, \{ recursive: true/.test(protectionSource2),
        'the protection self-test can recursively remove an artifact root it did not create (source-text guard)');
    }

    // Target: a validate file that tries to rewrite the artifacts it tested and
    // prints a forged binding of its own. Through the real CLI the write is now
    // denied to it and to anything it spawns, so it cannot rewrite them at all,
    // and its forged binding still never reaches the evidence.
    const REWRITING = `require('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rewritten by validate.ts\\n');\nconsole.log(JSON.stringify({ provider: 'validate-file-fixture', status: 'pass', allPass: true, summary: 'semantic PASS', details: [], warnings: [], buildArtifactsHash: 'f'.repeat(64) }));\n`;
    const rewriting = seed('rewriting', REWRITING);
    const withJson = rewriting.runCli(['--json']);
    expectRepaired(readFileSync(join(rewriting.mainDist, 'x.js'), 'utf8') === BUILD_A,
      'a validate file rewrote the compiled artifacts through the real CLI; the write was not prevented');
    expectRepaired(withJson.status !== 0, 'a validate file that tried to rewrite dist was reported successful with --json');
    expectRepaired(rewriting.evidence()?.result !== 'PASS', 'a PASS was persisted for a validate file that tried to rewrite the artifacts it tested');
    expectRepaired(rewriting.evidence()?.buildArtifactsHash !== 'f'.repeat(64), 'the binding printed by the validate file reached the evidence');
    // Audit #34 (2): a validate file that prints valid PASS JSON FIRST and
    // then attempts the denied write exits nonzero with the artifacts
    // unchanged and no binding diagnostic. The printed PASS must not be
    // believed: the executor verdict and the child's completion decide.
    const PASS_THEN_WRITE = `${PASS_JSON}\nrequire('node:fs').writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // rewritten after printing PASS\\n');\n`;
    const passThenWrite = seed('pass-then-write', PASS_THEN_WRITE);
    const passThenWriteJson = passThenWrite.runCli(['--json']);
    check(readFileSync(join(passThenWrite.mainDist, 'x.js'), 'utf8') === BUILD_A, 'control: the write after the printed PASS is denied');
    expectRepaired(passThenWriteJson.status !== 0, `a validate file that printed PASS JSON and then failed on a denied write was reported successful with --json (${passThenWriteJson.text.slice(0, 300)})`);
    expectRepaired(passThenWrite.evidence()?.result !== 'PASS', `a PASS was persisted for a validate file that printed PASS JSON and then exited nonzero (result=${passThenWrite.evidence()?.result})`);
    // The synthetic certification window authorizes exactly one heavy execution
    // per fixture (a second run is refused as pre_cert_window_already_consumed
    // before it renders anything), so the plain-text scenario gets its own.
    const rewritingPlain = seed('rewriting-plain', REWRITING);
    const plain = rewritingPlain.runCli([]);
    expectRepaired(readFileSync(join(rewritingPlain.mainDist, 'x.js'), 'utf8') === BUILD_A,
      'a validate file rewrote the compiled artifacts on the plain-text path; the write was not prevented');
    expectRepaired(plain.status !== 0, 'a validate file that tried to rewrite dist was reported successful without --json');
  } finally {
    rmTree(handlerSandbox);
  }
} else {
  console.log('skip: handler-level validate-file cases need demonstrated artifact write protection on this host');
}

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-build-artifact-binding: ${checks} checks passed`);
