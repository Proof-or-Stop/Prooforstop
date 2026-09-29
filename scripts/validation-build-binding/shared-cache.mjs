import ".././lab-source-loader.mjs";


import assert from 'node:assert/strict';

import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, git, StoryStore, deriveCertificationDomainInputHashes, check, persistSyntheticAdmittedWindowForTest, acquireOwnerLease, BUILD_A, probeValidationCausalPreflightFacts, binding, expectRepaired, runValidationCommand, repoRoot, sandbox, validateSelfHostBuildProof, BUILD_B, rmTree } from './support.mjs';

export async function runSharedCacheBinding() {

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
    // Finish-gate audit (#61, 2): a registered build recognised by its SHAPE
    // is never served from the shared cache, whatever reuse it opted into:
    // its execution is the proof. Run twice, it builds twice.
    {
      const sharedPolicy = await import("../../packages/main/src/core/shared-validation-execution.ts");
      const shapeBuild = { label: 'shape build', command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'], executionReuse: 'exact-inputs', executionInputs: ['packages/main/package.json'], timeoutMs: 120_000 };
      const shapePolicy = sharedPolicy.sharedValidationReusePolicy(shapeBuild);
      expectRepaired(shapePolicy.eligible === false && shapePolicy.reason === 'registered_build', `a shape-recognised registered build is eligible for shared-cache reuse (${JSON.stringify(shapePolicy)})`);
      const witness = join(sharedMainDist, '..', 'build-witness.txt');
      writeFileSync(join(root, 'packages/main/package.json'), JSON.stringify({ name: 'fixture-main', version: '0.0.0', private: true, scripts: { build: 'node build-witness.js' } }));
      writeFileSync(join(root, 'packages/main/build-witness.js'), `require('node:fs').appendFileSync(${JSON.stringify(witness)}, 'built\\n');`);
      const buildOnce = () => runValidationCommand(shapeBuild, root, 120_000, { sharedExecution, artifactBinding: { root: realpathSync(root), protection: protection.label } });
      const firstBuild = await buildOnce(); const secondBuild = await buildOnce();
      const builds = existsSync(witness) ? readFileSync(witness, 'utf8').split('\n').filter(Boolean).length : 0;
      expectRepaired(firstBuild.code === 0 && secondBuild.code === 0 && builds === 2 && secondBuild.executionDecision?.disposition !== 'reused',
        `a shape-recognised registered build with executionReuse was served from the cache instead of executing again (codes ${firstBuild.code}/${secondBuild.code}, builds=${builds}, decision=${JSON.stringify(secondBuild.executionDecision)}; ${(secondBuild.output ?? '').slice(0, 120)})`);
      // Audit #62: through the AMBIENT context too (no explicit context handed
      // to the executor), and in every cwd form the recogniser accepts —
      // absolute, symlink alias, wrapper-root — the build executes every time.
      const countBuilds = () => (existsSync(witness) ? readFileSync(witness, 'utf8').split('\n').filter(Boolean).length : 0);
      const mainAbs = join(realpathSync(root), 'packages', 'main');
      symlinkSync(mainAbs, join(root, 'main-alias'), 'dir'); mkdirSync(join(root, 'wrapper-project'), { recursive: true });
      const buildForms = [
        ['absolute cwd', { label: 'abs build', command: 'npm', args: ['run', 'build'], cwd: mainAbs, executionReuse: 'exact-inputs', executionInputs: ['packages/main/package.json'], timeoutMs: 120_000 }, root],
        ['symlink alias cwd', { label: 'alias build', command: 'npm', args: ['run', 'build'], cwd: 'main-alias', executionReuse: 'exact-inputs', executionInputs: ['packages/main/package.json'], timeoutMs: 120_000 }, root],
        ['wrapper-root cwd', { label: 'wrapper build', command: 'npm', args: ['run', 'build'], cwd: mainAbs, executionReuse: 'exact-inputs', executionInputs: ['packages/main/package.json'], timeoutMs: 120_000 }, join(root, 'wrapper-project')],
      ];
      for (const [form, buildCommand, projectRootForm] of buildForms) {
        const before = countBuilds();
        const [firstAmbient, secondAmbient] = await sharedPolicy.withSharedValidationExecutions(sharedExecution, async () => [
          await runValidationCommand(buildCommand, projectRootForm, 120_000, { artifactBinding: { root: realpathSync(root), protection: protection.label } }),
          await runValidationCommand(buildCommand, projectRootForm, 120_000, { artifactBinding: { root: realpathSync(root), protection: protection.label } }),
        ]);
        expectRepaired(firstAmbient.code === 0 && secondAmbient.code === 0 && countBuilds() === before + 2 && secondAmbient.executionDecision?.disposition !== 'reused' && secondAmbient.executionDecision?.reason === 'registered_build',
          `a registered build (${form}) was served from the ambient shared cache or not classified as a build (codes ${firstAmbient.code}/${secondAmbient.code}, builds ${countBuilds() - before}, decision=${JSON.stringify(secondAmbient.executionDecision)}; ${(secondAmbient.output ?? '').slice(0, 120)})`);
        const formPolicy = sharedPolicy.sharedValidationReusePolicy(buildCommand, { projectRoot: projectRootForm, artifactsRoot: realpathSync(root), launchCwd: binding.canonicalizeExistingPath(binding.launchDirectoryOf(projectRootForm, buildCommand.cwd)) });
        expectRepaired(formPolicy.eligible === false && formPolicy.reason === 'registered_build', `the reuse policy considers a registered build (${form}) eligible when judged with the executor's roots (${JSON.stringify(formPolicy)})`);
      }
      rmSync(join(root, 'main-alias')); rmSync(join(root, 'wrapper-project'), { recursive: true, force: true });
      const sharedSource3 = readFileSync(join(repoRoot, 'packages/main/src/core/shared-validation-execution.ts'), 'utf8');
      const executorSource16 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
      expectRepaired(sharedSource3.indexOf("if (registeredBuild) return executeWithoutReuse('registered_build');") > 0 && sharedSource3.indexOf("if (registeredBuild) return executeWithoutReuse('registered_build');") < sharedSource3.indexOf('const context = explicitContext ?? contexts.getStore();')
        && sharedSource3.includes('sharedValidationReusePolicy(command, { projectRoot, artifactsRoot: artifactBinding?.root, launchCwd })') && executorSource16.includes('options.artifactBinding, options.launchCwd, registeredBuild, options.launchIdentity), options);'),
        'the registered-build exclusion is not enforced before the ambient context lookup, or the policy is judged without the executor roots (source-text guard)');
      rmSync(join(root, 'packages/main/package.json'), { force: true }); rmSync(join(root, 'packages/main/build-witness.js'), { force: true }); rmSync(witness, { force: true });
      // Finish-gate audit (#65): the pinned launch directory is a reuse-key
      // input inside the shared cache too. Warm the real cache, then replace
      // the launch directory (the project root itself: the shared preflight
      // accepts no other launch directory) with a byte-identical copy at the
      // same path WHILE the cache lookup is pending, changing nothing Git or
      // the input bytes can see: no cached PASS may be served for the new
      // directory.
      {
        const checkoutC = join(sandbox, 'repo-c'); cpSync(root, checkoutC, { recursive: true });
        mkdirSync(join(checkoutC, 'sub')); writeFileSync(join(checkoutC, 'sub', 'input.txt'), 'sub input\n');
        git(checkoutC, ['add', '.']); git(checkoutC, ['commit', '-qm', 'third checkout: committed sub directory']);
        const storeC = new StoryStore(checkoutC);
        persistSyntheticAdmittedWindowForTest({ store: storeC, storyId, projectRoot: checkoutC, causalInputHashes: deriveCertificationDomainInputHashes(checkoutC, 'HEAD', checkoutC) });
        acquireOwnerLease(storeC.storyDirPath(storyId), { command: 'fixture-owner', cwd: checkoutC });
        const sharedC = { storyId, receiptStore: storeC, probe: (input) => probeValidationCausalPreflightFacts({ root: checkoutC, store: storeC, scanRoot: checkoutC }, storyId, input) };
        const subCmd = { label: 'root reuse', command: 'node', args: ['-e', 'process.exit(0)'], executionReuse: 'exact-inputs', executionInputs: ['input.txt'], timeoutMs: 20_000 };
        const pinnedSub = realpathSync(checkoutC);
        const pinnedSubIdentity = binding.bindLaunchDirectoryIdentity(pinnedSub);
        const runSub = (shared) => runValidationCommand(subCmd, checkoutC, 20_000, { sharedExecution: shared, launchCwd: pinnedSub, launchIdentity: pinnedSubIdentity });
        const warm = await runSub(sharedC); const served = await runSub(sharedC);
        check(warm.code === 0 && served.code === 0 && served.executionDecision?.disposition === 'reused', `control: the second run of an unchanged command is served from the shared cache (${JSON.stringify(served.executionDecision)}; ${(warm.output ?? '').slice(0, 120)})`);
        let swapped = false;
        const outsideOld = join(sandbox, 'sub-old'); const outsideCopy = join(sandbox, 'sub-copy');
        const swappingStore = new Proxy(storeC, { get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property === 'readCausalEvidenceReceipt') return (...args) => { if (!swapped) { swapped = true; cpSync(pinnedSub, outsideCopy, { recursive: true }); renameSync(pinnedSub, outsideOld); renameSync(outsideCopy, pinnedSub); } return value.apply(target, args); };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        let duringLookup = null; let lookupError = null;
        try { duringLookup = await runSub({ ...sharedC, receiptStore: swappingStore }); } catch (error) { lookupError = error; }
        check(swapped && lstatSync(pinnedSub).ino !== pinnedSubIdentity.ino, 'control: the launch directory was replaced at the same path during the lookup');
        expectRepaired(duringLookup?.executionDecision?.disposition !== 'reused' && (lookupError !== null || (duringLookup && duringLookup.code !== 0 && duringLookup.output.includes('[launch_directory_drift]'))),
          `a cached PASS was served for a launch directory replaced during the lookup (${lookupError ? lookupError.message.slice(0, 120) : JSON.stringify({ code: duringLookup?.code, decision: duringLookup?.executionDecision, output: (duringLookup?.output ?? '').slice(0, 120) })})`);
        rmSync(outsideOld, { recursive: true, force: true });
        const sharedSource4 = readFileSync(join(repoRoot, 'packages/main/src/core/shared-validation-execution.ts'), 'utf8');
        const executorSource17 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
        expectRepaired(sharedSource4.includes('return launchDrift() === undefined && causalCanonical(probe()) === initialCanonical')
          && sharedSource4.indexOf('{ const drift = launchDrift(); if (drift && !fresh) return refusedForDrift(drift); }') < sharedSource4.indexOf("if (!unchanged()) throw new Error('shared validation inputs changed before publication');")
          && executorSource17.includes('options.artifactBinding, options.launchCwd, registeredBuild, options.launchIdentity), options);'),
          'the shared cache does not re-verify the pinned launch directory inside its key check and after the awaited lookup (source-text guard)');
      }
      // DONE-required: a build receipt served from a cache is no build proof.
      const buildReceipt = (disposition) => ({ label: 'build', command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'], cwd: realpathSync(root), status: 'PASS', materialHash: 'material', ...(disposition ? { executionReceipt: { disposition, executionKey: 'key', receiptHash: 'hash', executedAt: new Date().toISOString() } } : {}) });
      const proofCommands = [{ label: 'build', command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'] }, { label: 'test', command: 'node', args: ['-e', '0'], requiresBuildProof: 'packages-main-build' }];
      const testReceipt = { label: 'test', command: 'node', args: ['-e', '0'], cwd: realpathSync(root), status: 'PASS', materialHash: 'material' };
      expectRepaired(validateSelfHostBuildProof({ receipts: [buildReceipt('reused'), testReceipt] }, root, proofCommands).some((reason) => reason.startsWith('missing-build-proof'))
        && validateSelfHostBuildProof({ receipts: [buildReceipt('executed'), testReceipt] }, root, proofCommands).length === 0
        && validateSelfHostBuildProof({ receipts: [buildReceipt(undefined), testReceipt] }, root, proofCommands).length === 0,
        'a build receipt served from a cache was accepted as fresh build proof');
    }
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
}
