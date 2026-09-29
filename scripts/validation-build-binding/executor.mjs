import ".././lab-source-loader.mjs";


import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostEnforced, git, BUILD_A, executeValidationPlan, check, expectRepaired, binding, repoRoot, currentGitHead, currentMaterialHash, currentStoryFilesHash, buildRoutineValidationIdentity, evaluateRoutineValidationReuse, evaluateValidationEvidenceAdmissibility, BUILD_B, doneRequiredProtectionRefusal, sandbox, runValidationCommand, spawnWrapped, executorRules, rmTree } from './support.mjs';

export async function runExecutorBinding() {

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
      // Audit #66: on a wrapper-root layout with gitCwd omitted, the dynamic
      // run refreshes its frozen directories against the artifact root the
      // EXECUTOR resolved for the wave (repo/), not the project root: a
      // directory inside repo/packages/main/dist recreated by Wave-0 is
      // re-bound; judged against the wrapper root it would be "outside" and
      // its stale identity would refuse the following command.
      {
        const dynamicCoreW = await import("../../packages/main/src/core/story-aware-validation.ts");
        const insideDist = join(realpathSync(nestedMainDist));
        const frozenW = new Map([['inside', { path: insideDist, identity: binding.bindLaunchDirectoryIdentity(insideDist) }]]);
        const RECREATE_NESTED = "const fs = require('node:fs'); fs.rmSync('packages/main/dist', { recursive: true, force: true }); fs.mkdirSync('packages/main/dist/tasks', { recursive: true }); fs.writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // recreated under the wrapper\\n');";
        const waveW = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
          { label: 'nested recreate build', command: 'node', args: ['-e', RECREATE_NESTED], cwd: 'repo', providesBuildProof: 'packages-main-build', timeoutMs: 20_000 },
        ], warnings: [] }, wrapper, undefined, undefined, {});
        check(waveW.allPass === true && realpathSync(waveW.buildArtifacts.root) === realpathSync(nested) && lstatSync(insideDist).ino !== frozenW.get('inside').identity.ino, `control: the wave recreated the nested dist and reports the git root as its artifact root (${waveW.details.join(' | ').slice(0, 120)})`);
        const refreshedRight = dynamicCoreW.refreshFrozenLaunchDirectoriesAfterBuild(frozenW, waveW.buildArtifacts.root);
        const refreshedWrong = dynamicCoreW.refreshFrozenLaunchDirectoriesAfterBuild(frozenW, wrapper);
        expectRepaired(refreshedRight.get('inside')?.identity?.ino === lstatSync(insideDist).ino && dynamicCoreW.frozenLaunchDirectoryDrift(refreshedRight).length === 0,
          `a recreated directory inside the configured git root's artifact tree was not re-bound against the executor's artifact root (${JSON.stringify([...refreshedRight])})`);
        check(dynamicCoreW.frozenLaunchDirectoryDrift(refreshedWrong).length === 1, 'trap: judged against the wrapper root the same directory is outside the trees and keeps its stale identity');
        const handlerSourceW = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
        const verifierSourceW = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
        expectRepaired(handlerSourceW.includes('refreshFrozenLaunchDirectoriesAfterBuild(frozenLaunchDirectories, wave.buildArtifacts?.root ?? args.gitCwd ?? args.projectRoot)')
          && (verifierSourceW.match(/runStoryAwareDynamicValidation\(\{\n\s*beforeLaunch: launchGate\.beforeLaunch,\n\s*projectRoot,\n\s*gitCwd: handlerGitCwd,/g) ?? []).length === 2,
          'the dynamic run refreshes against a re-derived root, or the verifier omits its resolved git cwd from the dynamic execution (source-text guard)');
      }
      // Restore the artifacts the following cases expect.
      mkdirSync(nestedMainDist, { recursive: true }); writeFileSync(join(nestedMainDist, 'x.js'), BUILD_A);
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
      const dynamic = await import("../../packages/main/src/core/story-aware-validation.ts");
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
      // Audit #50: replay predicates. A registered build's receipt (the
      // writes-permitted label) is mandatory execution whatever the entry's
      // policy, and reused rows are bound to the artifacts their receipts
      // executed: a selected plan that left other bytes invalidates them.
      const selectable = { assurance: 'story-selectable', closurePolicy: 'static-and-traced', fullBaselineReusePolicy: 'not-applicable' };
      expectRepaired(dynamic.replayMandatoryExecution(selectable, { buildArtifactsProtection: 'registered-build:writes-permitted' }) === true
        && dynamic.replayMandatoryExecution(selectable, { buildArtifactsProtection: 'enforced:sandbox-exec' }) === false
        && dynamic.replayMandatoryExecution({ ...selectable, assurance: 'always' }, { buildArtifactsProtection: 'enforced:sandbox-exec' }) === true
        && dynamic.replayMandatoryExecution({ ...selectable, closurePolicy: 'never-reuse' }) === true
        && dynamic.replayMandatoryExecution({ assurance: 'full-only', closurePolicy: 'whole-repository', fullBaselineReusePolicy: 'forbidden' }) === true,
        'the replay classifies a registered-build receipt (or a mandatory-execution policy) as reusable');
      const A = 'a'.repeat(64), B = 'b'.repeat(64);
      expectRepaired(dynamic.reusedReceiptsStillBound({ reused: 0, receiptBuild: A, executedBuild: B }) === undefined
        && dynamic.reusedReceiptsStillBound({ reused: 2, receiptBuild: A, executedBuild: A }) === undefined
        && typeof dynamic.reusedReceiptsStillBound({ reused: 2, receiptBuild: A, executedBuild: B }) === 'string'
        && typeof dynamic.reusedReceiptsStillBound({ reused: 1, receiptBuild: A, executedBuild: undefined }) === 'string',
        'a replay whose selected plan left different artifacts still trusts its reused rows');
      const dynSame = dynamic.buildDynamicValidationPlan({ storyId: 'B-bab-dyn', baseHead: 'base', head: 'head', inventory: dynInventory, catalog: dynCatalog, changes: dynChanges, closures: dynClosures, baselineEpochId: 'epoch', buildProofDigest: 'build', mode: 'observe', projectRoot: root, buildArtifactsHash: 'fixture-build-artifacts', receipts: [dynReceipt] });
      check(dynSame.rows.find((row) => row.commandId === 'aliased')?.disposition === 'reuse' && dynSame.totals.reused === 1, 'control: planned in the workspace that earned it, the receipt is reused and counted');
      rmSync(dynOther, { recursive: true, force: true });
      const replaySource = readFileSync(join(repoRoot, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'), 'utf8');
      expectRepaired((replaySource.match(/mode: 'shadow', gitCwd: historicalRoot,/g) ?? []).length === 2
        && replaySource.includes("executeValidationPlan({ provider: 'historical-replay-dynamic', commands: selectedCommands, warnings: [] }, historicalRoot,")
        && !replaySource.includes('freshHead')
        && replaySource.includes("buildProofDigest: 'paired-performance', graph: currentGraph, mode: 'shadow', gitCwd: pairedRoot,")
        && replaySource.includes('does not name the selection\'s input identity (launch directory disagreement)')
        && replaySource.includes('if (replayMandatoryExecution(entry, receipt)) assert.equal(row?.disposition, \'execute\'')
        && replaySource.includes('const reusable = receiptedEntries.filter(({ entry, receipt }) => !replayMandatoryExecution(entry, receipt));')
        && replaySource.includes('const reuseBinding = reusedReceiptsStillBound({ reused: dynamicManifest.totals.reused, receiptBuild: full.buildArtifactsHash, executedBuild: dynamic.buildArtifactsHash });')
        && replaySource.includes('const iterationBinding = reusedReceiptsStillBound({ reused: pairedSelection.totals.reused, receiptBuild: baseline.buildArtifactsHash, executedBuild: result.buildArtifactsHash });')
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
      // Audit #55: a baseline receipt is signed only for a result that ran in
      // the directory its row is bound to. The alias is re-pointed from A to
      // B by an earlier command of the same plan: the aliased command still
      // runs in A (frozen), and a manifest planned afterwards (bound to B)
      // cannot receive A's PASS as B's receipt.
      const retarget = join(root, 'dyn-retarget.js');
      writeFileSync(retarget, `const fs = require('node:fs'); fs.rmSync(${JSON.stringify(dynLink)}); fs.symlinkSync(${JSON.stringify(dynB)}, ${JSON.stringify(dynLink)}, 'dir'); process.exit(0);\n`);
      const frozenA = dynamic.frozenLaunchOptionsOf(dynFirst, [{ id: 'retarget' }, { id: 'aliased' }]);
      const duringRun = await executeValidationPlan({ provider: 'build-binding-fixture', commands: [
        { label: 'retarget', command: 'node', args: [retarget], timeoutMs: 20_000 },
        { label: 'aliased', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'dyn-link', timeoutMs: 20_000 },
      ], warnings: [] }, root, undefined, undefined, { jobs: 1, launchCwds: frozenA.launchCwds, launchIdentities: frozenA.launchIdentities });
      const aliasedResult = duringRun.commands.find((command) => command.label === 'aliased');
      check(aliasedResult?.code === 0 && aliasedResult.launchCwd === realpathSync(dynA), `control: the aliased command ran in the frozen directory A although the alias now points at B (${aliasedResult?.launchCwd})`);
      const plannedAfter = dynPlan([]).rows.find((row) => row.commandId === 'aliased');
      check(plannedAfter?.resolvedCwd === realpathSync(dynB), 'control: a manifest planned after the re-point binds the aliased command to B');
      expectRepaired(dynamic.resultRanInBoundDirectory(plannedAfter, aliasedResult) === false && dynamic.resultRanInBoundDirectory(dynFirstRow, aliasedResult) === true && dynamic.resultRanInBoundDirectory({ resolvedCwd: undefined }, aliasedResult) === false,
        'a PASS earned in directory A can be signed as the receipt of a row bound to directory B');
      const replaySource3 = readFileSync(join(repoRoot, 'packages/main/src/tasks/story-aware-validation-historical-replay.ts'), 'utf8');
      expectRepaired(replaySource3.indexOf('const baselineManifest = buildDynamicValidationPlan({') < replaySource3.indexOf("const full = await executeValidationPlan({ provider: 'historical-replay-full'")
        && replaySource3.includes("candidate.storyId, { ...frozenLaunchOptionsOf(baselineManifest, catalog) });")
        && replaySource3.includes("'B-current-paired', { ...frozenLaunchOptionsOf(pairedBaseline, catalog) });")
        && replaySource3.includes('if (!resultRanInBoundDirectory(args.row, args.result)) return undefined;'),
        'the replay executes its baseline before freezing the launch bindings, or signs a baseline receipt for a result that did not run in the bound directory (source-text guard)');
      rmSync(retarget, { force: true }); rmSync(dynLink); symlinkSync(dynA, dynLink, 'dir');
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
        && handlerSource7.includes('if (!resultRanInBoundDirectory(args.row, args.result)) return undefined;'),
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
      // Audit #51: any name a process environment can carry is data to the
      // trampoline (names and values are both hex-packed), so a dash-named
      // variable is delivered as declared and the declared validator runs.
      const dashLaunch = eqProtection.wrap({ command: dashValidator, args: [], shell: false, env: { ...process.env, '-SFOO': ' /usr/bin/true' }, confidentialFd: 3 });
      expectRepaired(!dashLaunch.args.some((argument) => argument.startsWith('-SFOO') || argument.includes('/usr/bin/env')) && dashLaunch.confidential?.payload.toString('utf8').includes(`$ENV{pack('H*', '${Buffer.from('-SFOO', 'utf8').toString('hex')}')}`),
        `a dash-named variable reached argv or was not transferred as bytes (${JSON.stringify(dashLaunch.args.slice(-3))})`);
      const dashRun = await runValidationCommand({ label: 'dash env key', command: dashValidator, args: [], env: { '-SFOO': ' /usr/bin/true' }, timeoutMs: 20_000 }, root, 20_000, { artifactWriteProtection: eqProtection, artifactBinding: { root: realpathSync(root), protection: eqProtection.label } });
      expectRepaired(dashRun.code === 1 && dashRun.output.includes('RAN_VALIDATOR'),
        `a dash-named environment variable let something other than the declared validator run (code=${dashRun.code}, ${dashRun.output.slice(0, 120)})`);
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
      expectRepaired(!secretLaunch.args.some((argument) => argument.includes(secretValue)) && !('POS_SYNTHETIC_SECRET' in secretLaunch.env) && secretLaunch.confidential?.payload.toString('utf8').includes(`$ENV{pack('H*', '${Buffer.from('POS_SYNTHETIC_SECRET', 'utf8').toString('hex')}')} = pack('H*', '${Buffer.from(secretValue, 'utf8').toString('hex')}');\n`) && !secretLaunch.confidential.payload.toString('utf8').includes(secretValue),
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
      const exactEnv = { ...process.env, SHELLOPTS: 'nounset', SHLVL: '7', UID: '1', EUID: '2', PPID: '3', BASH_VERSINFO: 'x', PS1: '$ ', IFS: 'x', POS_QUOTED: "it's \"quoted\"\nsecond line \u00e9\u4e2d", DYLD_LIBRARY_PATH: '/fixture/lib', POS_SYNTHETIC_SECRET: secretValue,
        // Audit #51: valid non-identifier names (an exported bash function, a dotted dashed name, a dash-leading name) are environment entries too.
        'BASH_FUNC_pos_probe%%': '() { :; }', 'pos-dash.key': 'dashed', '-SFOO': ' /usr/bin/true' };
      const envProbe = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];
      const directEnv = spawnSync(process.execPath, envProbe, { encoding: 'utf8', env: exactEnv, timeout: 20_000 });
      const wrappedEnv = spawnWrapped(eqProtection.wrap({ command: process.execPath, args: envProbe, shell: false, env: exactEnv, confidentialFd: 3 }));
      // Compared as sets of entries: the order in which a process lists its
      // environment is not part of the environment.
      const sortedEntries = (text) => { try { return JSON.stringify(Object.entries(JSON.parse(text)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); } catch { return text; } };
      expectRepaired(directEnv.status === 0 && wrappedEnv.status === 0 && sortedEntries(directEnv.stdout) === sortedEntries(wrappedEnv.stdout),
        `the protected command's environment differs from the declared one (${wrappedEnv.status}; ${(wrappedEnv.stderr || '').slice(0, 120)}; ${(() => { try { const a = JSON.parse(directEnv.stdout), b = JSON.parse(wrappedEnv.stdout); return Object.keys({ ...a, ...b }).filter((key) => a[key] !== b[key]).map((key) => `${key}: ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`).join(', ').slice(0, 300); } catch { return 'unparseable'; } })()})`);
      // Audit #49: on the DIRECT branch (nothing withheld) the wrapper's own
      // `--` ends sandbox-exec's option parsing, so a command named `--` is
      // a missing program, never the terminator that would let its first
      // argument run in its place.
      for (const directEnv of [{}, { HOME: process.env.HOME ?? '/', USER: process.env.USER ?? 'user' }]) {
        for (const dashCommand of ['--', '-x']) {
          const directLaunch = eqProtection.wrap({ command: dashCommand, args: ['/usr/bin/true'], shell: false, env: directEnv });
          expectRepaired(!directLaunch.confidential && directLaunch.args[2] === '--' && directLaunch.args[3] === dashCommand && directLaunch.args[4] === '/usr/bin/true',
            `the direct branch hands sandbox-exec the declared command without an option terminator (${JSON.stringify(directLaunch.args.slice(0, 5))})`);
          const directRun = spawnWrapped(directLaunch, { cwd: root });
          expectRepaired(directRun.status !== 0, `a missing executable named ${dashCommand} let its argument /usr/bin/true run in its place on the direct branch (status ${directRun.status})`);
        }
      }
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
      // Only what no environment entry can hold is refused: '=' in a name.
      let eqNameRefusal = null;
      try { eqProtection.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { ...process.env, 'BAD=NAME': 'x' }, confidentialFd: 3 }); } catch (error) { eqNameRefusal = error; }
      expectRepaired(eqNameRefusal && String(eqNameRefusal.message).includes('[artifact_protection_launch_unsupported]'), `a name containing '=' was serialised for transfer (${eqNameRefusal ? eqNameRefusal.message : 'no refusal'})`);
      // Finish-gate audit (#61, 1): sandbox-exec is a plain exec, so a
      // descriptor above stderr the launcher hands the child (the reservation
      // delegation transport) reaches the command through the trampoline.
      const transportFile = join(sandbox, 'transport-witness'); writeFileSync(transportFile, 'delegation-transport');
      const transportFd = openSync(transportFile, 'r');
      try {
        const transportLaunch = eqProtection.wrap({ command: process.execPath, args: ['-e', "process.stdout.write(require('node:fs').readFileSync('/dev/fd/4', 'utf8'))"], shell: false, env: { ...process.env, POS_SYNTHETIC_SECRET: secretValue }, confidentialFd: 3, inheritedDescriptors: [4] });
        const payloadFile2 = join(sandbox, 'transport-payload'); writeFileSync(payloadFile2, transportLaunch.confidential.payload, { mode: 0o600, flag: 'wx' }); const payloadFd2 = openSync(payloadFile2, 'r');
        const transportRun = spawnSync(transportLaunch.command, transportLaunch.args, { encoding: 'utf8', env: transportLaunch.env, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe', payloadFd2, transportFd] });
        closeSync(payloadFd2); rmSync(payloadFile2, { force: true });
        expectRepaired(transportRun.status === 0 && transportRun.stdout === 'delegation-transport', `an inherited descriptor did not reach the command under sandbox-exec (${transportRun.status}, ${transportRun.stdout}, ${(transportRun.stderr || '').slice(0, 80)})`);
      } finally { closeSync(transportFd); rmSync(transportFile, { force: true }); }
      const executorSource15 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
      expectRepaired(executorSource15.includes("const inheritedDescriptors = stdio.map((entry, index) => (index > 2 && typeof entry === 'number' ? index : -1)).filter((index) => index >= 0);")
        && executorSource15.includes('confidentialFd, inheritedDescriptors })')
        && executorSource15.includes("const registeredBuild = options.artifactBinding?.protection === REGISTERED_BUILD_PROTECTION_LABEL || isRegisteredPackagesMainBuildCommand(command, projectRoot, options.artifactBinding?.root, options.launchCwd);")
        && executorSource15.includes('registeredBuild ? undefined : options.sharedExecution'),
        'the executor does not hand the inherited descriptors to the mechanism, or lets a registered build consult the shared cache (source-text guard)');
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
        && protectionSource12.includes("'--', trampoline, `/dev/fd/${launch.confidentialFd}`, ...inner]") && protectionSource12.includes("args: ['-p', profile, '--', ...inner]") && protectionSource12.includes('checkTransferableEnvironment(reapplied);\n      const payload = Buffer.from(reapplied.flatMap(')
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
    // Finish-gate audit (#54): a registered build may RECREATE the artifact
    // tree a later test uses as its cwd. The pinned identity of a directory
    // inside the trees is re-bound after the successful build (same canonical
    // path, recreated inode); a directory outside the trees replaced during
    // the build is still refused as drift.
    if (hostEnforced) {
      const canonicalRoot = realpathSync(root);
      const distDir = join(canonicalRoot, 'packages', 'main', 'dist');
      const unrelated = join(canonicalRoot, 'unrelated-cwd'); mkdirSync(unrelated); const unrelatedOther = join(canonicalRoot, 'unrelated-other'); mkdirSync(unrelatedOther);
      const beforeIno = lstatSync(distDir).ino;
      const RECREATE = `const fs = require('node:fs'); fs.rmSync('packages/main/dist', { recursive: true, force: true }); fs.mkdirSync('packages/main/dist/tasks', { recursive: true }); fs.writeFileSync('packages/main/dist/tasks/x.js', ${JSON.stringify(BUILD_A)}); fs.renameSync('unrelated-cwd', 'unrelated-cwd-moved'); fs.symlinkSync('unrelated-other', 'unrelated-cwd');`;
      const rebuilt = await run([
        { label: 'build', command: 'node', args: ['-e', RECREATE], providesBuildProof: 'packages-main-build', timeoutMs: 20_000 },
        { label: 'test in recreated dist', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'packages/main/dist', timeoutMs: 20_000 },
        // Audit #56: a NESTED directory of the recreated tree is inside it too.
        { label: 'test in recreated nested dist', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'packages/main/dist/tasks', timeoutMs: 20_000 },
        { label: 'test in replaced unrelated dir', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'unrelated-cwd', timeoutMs: 20_000 },
      ]);
      const inNested = rebuilt.commands.find((command) => command.label === 'test in recreated nested dist');
      expectRepaired(inNested?.code === 0 && inNested.launchCwd === join(distDir, 'tasks') && !(inNested.output ?? '').includes('[launch_directory_drift]'),
        `a test whose cwd is a nested directory of the recreated artifact tree was refused as drift (code=${inNested?.code}, launchCwd=${inNested?.launchCwd}, ${(inNested?.output ?? '').slice(0, 120)})`);
      const inDist = rebuilt.commands.find((command) => command.label === 'test in recreated dist');
      const inUnrelated = rebuilt.commands.find((command) => command.label === 'test in replaced unrelated dir');
      check(lstatSync(distDir).ino !== beforeIno, 'control: the registered build recreated the artifact tree with a new inode');
      expectRepaired(inDist?.code === 0 && inDist.launchCwd === distDir && inDist.buildArtifactsRole === 'test' && !(inDist.output ?? '').includes('[launch_directory_drift]'),
        `a test whose cwd is the artifact tree the registered build recreated was refused as drift (code=${inDist?.code}, launchCwd=${inDist?.launchCwd}, ${(inDist?.output ?? '').slice(0, 120)})`);
      expectRepaired(inUnrelated?.code !== 0 && (inUnrelated?.output ?? '').includes('[launch_directory_drift]') && inUnrelated?.launchCwd === undefined,
        `a directory outside the artifact trees replaced during the build was launched anyway (code=${inUnrelated?.code}, launchCwd=${inUnrelated?.launchCwd})`);
      rmSync(join(canonicalRoot, 'unrelated-cwd'), { force: true }); rmSync(join(canonicalRoot, 'unrelated-cwd-moved'), { recursive: true, force: true }); rmSync(unrelatedOther, { recursive: true, force: true });
      // Dynamic: the frozen map is refreshed the same way after Wave-0.
      const artRoot = join(sandbox, 'frozen-refresh'); mkdirSync(join(artRoot, 'packages', 'main', 'dist'), { recursive: true }); mkdirSync(join(artRoot, 'elsewhere'));
      const frozenBefore = new Map([
        ['inside', { path: join(realpathSync(artRoot), 'packages', 'main', 'dist'), identity: binding.bindLaunchDirectoryIdentity(join(realpathSync(artRoot), 'packages', 'main', 'dist')) }],
        ['outside', { path: join(realpathSync(artRoot), 'elsewhere'), identity: binding.bindLaunchDirectoryIdentity(join(realpathSync(artRoot), 'elsewhere')) }],
      ]);
      rmSync(join(artRoot, 'packages', 'main', 'dist'), { recursive: true }); mkdirSync(join(artRoot, 'packages', 'main', 'dist'));
      rmSync(join(artRoot, 'elsewhere'), { recursive: true }); mkdirSync(join(artRoot, 'elsewhere'));
      const dynamicCore = await import("../../packages/main/src/core/story-aware-validation.ts");
      const refreshedFrozen = dynamicCore.refreshFrozenLaunchDirectoriesAfterBuild(frozenBefore, artRoot);
      expectRepaired(refreshedFrozen.get('inside')?.identity?.ino !== frozenBefore.get('inside').identity.ino && refreshedFrozen.get('inside')?.identity?.ino === lstatSync(join(artRoot, 'packages', 'main', 'dist')).ino
        && refreshedFrozen.get('outside')?.identity?.ino === frozenBefore.get('outside').identity.ino,
        `the frozen directories were not re-bound inside the artifact trees only (${JSON.stringify([...refreshedFrozen])})`);
      const refreshedDrift = dynamicCore.frozenLaunchDirectoryDrift(refreshedFrozen);
      expectRepaired(refreshedDrift.length === 1 && refreshedDrift[0].startsWith('outside: '), `after the refresh, drift is reported for the wrong directories (${JSON.stringify(refreshedDrift)})`);
      rmSync(artRoot, { recursive: true, force: true });
      // Audit #56: containment is judged with the platform's path semantics:
      // descendants of both artifact roots are inside, siblings are not, on
      // POSIX (real directories) and on Windows (through the walker seam).
      const containRoot = join(sandbox, 'contain'); for (const tree of ['packages/main/dist/tasks', 'packages/utils/dist/lib', 'packages/main/dist-other', 'packages/main/src']) mkdirSync(join(containRoot, tree), { recursive: true });
      const cr = realpathSync(containRoot);
      expectRepaired(binding.insideBuildArtifactTrees(join(cr, 'packages/main/dist'), cr) && binding.insideBuildArtifactTrees(join(cr, 'packages/main/dist/tasks'), cr) && binding.insideBuildArtifactTrees(join(cr, 'packages/utils/dist/lib'), cr)
        && !binding.insideBuildArtifactTrees(join(cr, 'packages/main/dist-other'), cr) && !binding.insideBuildArtifactTrees(join(cr, 'packages/main/src'), cr) && !binding.insideBuildArtifactTrees(cr, cr),
        'artifact-tree containment misjudges a descendant or a sibling on POSIX');
      const winTree = new Map([['C:\\repo', 'dir'], ['C:\\repo\\packages', 'dir'], ['C:\\repo\\packages\\main', 'dir'], ['C:\\repo\\packages\\main\\dist', 'dir'], ['C:\\repo\\packages\\main\\dist\\tasks', 'dir'], ['C:\\repo\\packages\\main\\dist-other', 'dir'], ['C:\\repo\\packages\\utils', 'dir'], ['C:\\repo\\packages\\utils\\dist', 'dir'], ['C:\\repo\\packages\\utils\\dist\\lib', 'dir']]);
      const containSeam = { platform: 'win32', cwd: 'C:\\repo', lstat: (path) => { const kind = winTree.get(path); if (!kind) throw new Error('ENOENT'); return { isSymbolicLink: () => false, isDirectory: () => kind === 'dir' }; }, readlink: () => { throw new Error('not a link'); }, searchable: () => true };
      expectRepaired(binding.insideBuildArtifactTrees('C:\\repo\\packages\\main\\dist\\tasks', 'C:\\repo', containSeam) && binding.insideBuildArtifactTrees('C:\\repo\\packages\\main\\dist', 'C:\\repo', containSeam) && binding.insideBuildArtifactTrees('C:\\repo\\packages\\utils\\dist\\lib', 'C:\\repo', containSeam)
        && !binding.insideBuildArtifactTrees('C:\\repo\\packages\\main\\dist-other', 'C:\\repo', containSeam) && !binding.insideBuildArtifactTrees('D:\\repo\\packages\\main\\dist\\tasks', 'C:\\repo', containSeam),
        'artifact-tree containment misjudges a Windows descendant, sibling or other-drive path');
      rmSync(containRoot, { recursive: true, force: true });
      const executorSource13 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
      const doneRequiredSource13 = readFileSync(join(repoRoot, 'packages/main/src/core/done-required-validation.ts'), 'utf8');
      const handlerSource13 = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-aware-validation.ts'), 'utf8');
      expectRepaired(executorSource13.includes('const refreshed = refreshLaunchIdentityAfterBuild(path, launchIdentities.get(index), artifactsRoot);')
        && doneRequiredSource13.includes('const refreshed = refreshLaunchIdentityAfterBuild(canonicalLaunchCwds[j]!, launchIdentities[j], args.gitCwd);')
        && handlerSource13.includes('refreshFrozenLaunchDirectoriesAfterBuild(frozenLaunchDirectories, wave.buildArtifacts?.root ?? args.gitCwd ?? args.projectRoot)'),
        'a consumer does not re-bind pinned identities inside the artifact trees after the registered build (source-text guard)');
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
}
