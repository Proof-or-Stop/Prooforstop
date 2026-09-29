import ".././lab-source-loader.mjs";


import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';

import { isAbsolute, join } from 'node:path';
import { sandbox, resetConfigCache, git, StoryStore, deriveCertificationDomainInputHashes, check, persistSyntheticAdmittedWindowForTest, BUILD_A, hostEnforced, runDoneRequiredValidation, expectRepaired, evaluateDoneRequiredEvidence, binding, currentGitHead, currentMaterialHash, currentStoryFilesHash, BUILD_B, validateReceiptBuildBinding, doneRequiredProtectionRefusal, repoRoot } from './support.mjs';

export async function runDoneRequiredBinding() {

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

if (hostEnforced) {
  const RECREATE_DONE = "const fs = require('node:fs'); fs.rmSync('packages/main/dist', { recursive: true, force: true }); fs.mkdirSync('packages/main/dist/tasks', { recursive: true }); fs.writeFileSync('packages/main/dist/tasks/x.js', 'process.exit(0); // recreated\\n'); fs.writeFileSync('packages/main/dist/full-suite-build-binding.json', JSON.stringify({ schema: 'proof-or-stop.main-build-binding.v1', sourceDigest: 'a'.repeat(64), distDigest: 'b'.repeat(64) }) + '\\n');";
  const recreated = doneRequiredFixture('done-required-recreated-tree-cwd', [
    { label: 'build', command: 'node', args: ['-e', RECREATE_DONE], providesBuildProof: 'packages-main-build' },
    { label: 'test in recreated dist', command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'packages/main/dist' },
  ]);
  const recreatedRun = await runDoneRequiredValidation({ projectRoot: recreated.root, storyId: recreated.storyId, store: recreated.store, gitCwd: recreated.root });
  expectRepaired(recreatedRun.status === 'PASS' && recreatedRun.receipts?.[1]?.status === 'PASS' && recreatedRun.receipts?.[1]?.cwd === join(realpathSync(recreated.root), 'packages', 'main', 'dist'),
    `the DONE-required writer refused a test whose cwd is the tree its registered build recreated (status=${recreatedRun.status}, reasons=${recreatedRun.reasons.join(', ').slice(0, 200)})`);
  // Finish-gate audit (#60): the receipts bind the manifest the build wrote;
  // corrupting or deleting it afterwards refuses the DONE evidence.
  const recreatedEvaluate = () => evaluateDoneRequiredEvidence({ projectRoot: recreated.root, storyId: recreated.storyId, store: recreated.store, gitCwd: recreated.root });
  check(recreatedEvaluate().ok === true, `control: the DONE-required evaluation accepts its own receipts (${recreatedEvaluate().reasons.join(', ').slice(0, 160)})`);
  const recreatedManifest = join(recreated.root, 'packages/main/dist/full-suite-build-binding.json');
  const recreatedManifestBytes = readFileSync(recreatedManifest);
  writeFileSync(recreatedManifest, '{ not json');
  const corruptedEvaluation = recreatedEvaluate();
  expectRepaired(corruptedEvaluation.ok === false && corruptedEvaluation.reasons.some((reason) => /build.artifacts|artifact/i.test(reason)),
    `DONE evidence stayed valid after the build-binding manifest was corrupted (reasons=${corruptedEvaluation.reasons.join(', ').slice(0, 200)})`);
  writeFileSync(recreatedManifest, recreatedManifestBytes);
  check(recreatedEvaluate().ok === true, 'control: restoring the manifest bytes restores the receipted tree');
  rmSync(recreatedManifest);
  const deletedEvaluation = recreatedEvaluate();
  expectRepaired(deletedEvaluation.ok === false && deletedEvaluation.reasons.some((reason) => /build.artifacts|artifact/i.test(reason)),
    `DONE evidence stayed valid after the build-binding manifest was deleted (reasons=${deletedEvaluation.reasons.join(', ').slice(0, 200)})`);
}

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
          // Finish-gate audit (#61, 1): bwrap closes every descriptor above
          // stderr it was not told to consume and offers no pass-through, so
          // a child that must inherit the reservation delegation transport is
          // refused rather than launched without it.
          let inheritedRefusal = null;
          try { bound.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { ...process.env, LD_PRELOAD: '/fixture/preload.so' }, confidentialFd: 3, inheritedDescriptors: [4] }); } catch (error) { inheritedRefusal = error; }
          expectRepaired(inheritedRefusal && String(inheritedRefusal.message).includes('[artifact_protection_launch_unsupported]') && String(inheritedRefusal.message).includes('descriptor(s) 4'),
            `bwrap was handed a child that must inherit descriptor 4 (${inheritedRefusal ? inheritedRefusal.message : 'no refusal'})`);
          const preloadLaunch = bound.wrap({ command: process.execPath, args: ['-e', "process.stdout.write('inner=' + process.env.LD_PRELOAD)"], shell: false, env: { ...process.env, LD_PRELOAD: '/fixture/preload.so', POS_SYNTHETIC_SECRET: 'synthetic-credential-0f3a' }, confidentialFd: 3 });
          const argsAt = preloadLaunch.args.indexOf('--args');
          expectRepaired(argsAt >= 0 && preloadLaunch.args[argsAt + 1] === '3' && preloadLaunch.args.indexOf('--') > argsAt && !preloadLaunch.args.some((argument) => argument.includes('/fixture/preload.so') || argument.includes('synthetic-credential-0f3a') || argument === '--setenv')
            && preloadLaunch.confidential?.fd === 3 && preloadLaunch.confidential.payload.toString('utf8').includes('--setenv\0LD_PRELOAD\0/fixture/preload.so\0') && preloadLaunch.confidential.payload.toString('utf8').includes('--setenv\0POS_SYNTHETIC_SECRET\0synthetic-credential-0f3a\0'),
            `the re-applied environment is in bwrap's argv or missing from the confidential payload (${JSON.stringify(preloadLaunch.args.slice(-6))})`);
          expectRepaired(preloadLaunch.env && !('LD_PRELOAD' in preloadLaunch.env) && Object.keys(preloadLaunch.env).every((key) => binding.isWrapperEnvironmentVariable(key)),
            `the bwrap wrapper process was launched with LD_PRELOAD or another withheld variable in its own environment (${Object.keys(preloadLaunch.env).join(',')})`);
          const payloadFile = join(delegatingDir, 'confidential-payload'); writeFileSync(payloadFile, preloadLaunch.confidential.payload, { mode: 0o600, flag: 'wx' });
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
          expectRepaired(dyldLaunch.command === '/usr/bin/sandbox-exec' && dyldLaunch.args[0] === '-p' && dyldLaunch.args[2] === '--' && dyldLaunch.args[3] === '/usr/bin/perl' && dyldLaunch.args[4] === '/dev/fd/3' && dyldLaunch.args[5] === process.execPath && !dyldLaunch.args.includes('/usr/bin/env')
            && !dyldLaunch.args.some((argument) => argument.includes('/fixture/insert.dylib') || argument.includes('/fixture/preload.so'))
            && Object.keys(dyldLaunch.env).every((key) => binding.isWrapperEnvironmentVariable(key))
            && dyldLaunch.confidential?.fd === 3 && dyldLaunch.confidential.payload.toString('utf8').includes(`$ENV{pack('H*', '${hex('DYLD_INSERT_LIBRARIES')}')} = pack('H*', '${hex('/fixture/insert.dylib')}');\n`) && dyldLaunch.confidential.payload.toString('utf8').includes(`$ENV{pack('H*', '${hex('LD_PRELOAD')}')} = pack('H*', '${hex('/fixture/preload.so')}');\n`) && dyldLaunch.confidential.payload.toString('utf8').endsWith('exec { $ARGV[0] } @ARGV or exit 127;\n'),
            `sandbox-exec was launched with loader variables in its own environment, or without the trampoline that restores them inside (${JSON.stringify(dyldLaunch.args.slice(0, 6))}, env keys ${Object.keys(dyldLaunch.env).filter((key) => /^(LD_|DYLD_)/.test(key)).join(',')})`);
          const plainLaunch = hostProtection.wrap({ command: process.execPath, args: ['-e', '0'], shell: false, env: { HOME: process.env.HOME ?? '/', USER: process.env.USER ?? 'user' } });
          check(!plainLaunch.args.includes('/usr/bin/env') && plainLaunch.args[2] === '--' && plainLaunch.args[3] === process.execPath, 'control: a launch with nothing to withhold runs directly, behind the wrapper-owned option terminator');
        }
        const executorSource6 = readFileSync(join(repoRoot, 'packages/main/src/core/validation-executor.ts'), 'utf8');
        expectRepaired(executorSource6.includes('.wrap({ command: command.command, args: command.args, shell: declaredShell, env: childEnv, confidentialFd, inheritedDescriptors })') && executorSource6.includes('      env: launch.env,'),
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
  // The sandbox is removed once, at process exit (see its creation).
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
    // The sandbox is removed once, at process exit (see its creation).
  }
}
}
