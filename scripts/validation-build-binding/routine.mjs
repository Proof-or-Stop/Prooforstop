import ".././lab-source-loader.mjs";


import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';

import { join } from 'node:path';
import { routineFixture, BUILD_A, currentGitHead, currentMaterialHash, currentStoryFilesHash, check, buildRoutineValidationIdentity, binding, evaluateRoutineValidationReuse, evaluateValidationEvidenceAdmissibility, expectRepaired, BUILD_B, sandbox, repoRoot, validateReceiptBuildBinding, rmTree } from './support.mjs';
import { setHostEnforced } from './support.mjs';

export async function runRoutineBinding() {

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
    setHostEnforced(resolved.enforced === true);
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
        && executorSource2.includes("if (buildArtifactsRole === 'build') {\n      buildRanSinceResolve = true;"),
        'the executor does not re-resolve protection before a test that follows a registered build or a newly created tree (source-text guard)');
      const doneRequiredSource3 = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
      expectRepaired(doneRequiredSource3.includes('if (!commandIsRegisteredBuild && artifactProtectionStale(artifactWriteProtection, { buildRanSinceResolve, anyRootExists: hasAnyArtifactRoot(args.gitCwd, args.projectRoot) })) {')
        && doneRequiredSource3.includes('protectionRefusal = doneRequiredProtectionRefusal(artifactWriteProtection.label, policy.commands.slice(i), args.projectRoot, args.gitCwd, canonicalLaunchCwds.slice(i));')
        && doneRequiredSource3.includes('if (commandIsRegisteredBuild) {\n        buildRanSinceResolve = true;'),
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

  // Finish-gate audit (#60): the build-binding manifest the build writes inside
  // dist is an artifact a command may read or assert, so its presence and
  // bytes are part of the identity: a manifest corrupted or deleted after a
  // PASS is a different tree and the PASS is not reused for it.
  {
    const beforeManifest = evidence.buildArtifactsHash;
    const manifestPath = join(root, 'packages/main/dist', 'full-suite-build-binding.json');
    const validManifest = `${JSON.stringify({ schema: 'proof-or-stop.main-build-binding.v1', sourceDigest: 'a'.repeat(64), distDigest: 'b'.repeat(64) }, null, 2)}\n`;
    writeFileSync(manifestPath, validManifest);
    const withManifest = currentBuild();
    expectRepaired(withManifest !== beforeManifest, 'writing the build-binding manifest inside dist did not change the artifact identity');
    evidence.buildArtifactsHash = withManifest;
    check(reuse().reusable === true && admissibility().ok === true, 'control: a PASS recorded with the manifest present is reusable while it is unchanged');
    writeFileSync(manifestPath, '{ not json');
    expectRefusedByBuild('PASS was accepted after the build-binding manifest was corrupted');
    writeFileSync(manifestPath, validManifest);
    check(reuse().reusable === true, 'control: restoring the manifest bytes restores the recorded identity');
    rmSync(manifestPath);
    expectRefusedByBuild('PASS was accepted after the build-binding manifest was deleted');
    check(currentBuild() === beforeManifest, 'control: without the manifest the identity is the one recorded before it was written');
    evidence.buildArtifactsHash = beforeManifest;
    check(reuse().reusable === true, 'control: the recorded identity is restored');
  }

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
}
