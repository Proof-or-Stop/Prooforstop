import ".././lab-source-loader.mjs";


import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostEnforced, repoRoot, check, git, StoryStore, deriveCertificationDomainInputHashes, persistSyntheticAdmittedWindowForTest, BUILD_A, freezeLaunchBindings, expectRepaired, launchDirectoryMismatch, isLaunchDirectoryDriftError, binding, rmTree, sandbox } from './support.mjs';

export async function runHandlerBinding() {

if (hostEnforced) {
  const cli = join(repoRoot, 'packages/main/dist/cli.js');
  check(existsSync(cli), `handler-level validate-file regression requires a built CLI at ${cli}`);
  const handlerSandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-handler-'));
  try {
    const seed = (name, validateTs, extraConfig = {}, prepare = () => {}) => {
      const root = join(handlerSandbox, name); mkdirSync(root);
      const storyId = 'B-bab-handler';
      writeFileSync(join(root, '.gitignore'), '.proof-or-stop/activity.jsonl\n.proof-or-stop/locks/\n.proof-or-stop/runtime/\nnode_modules\ndist\n');
      writeFileSync(join(root, 'source.ts'), 'export const handlerBinding = true;\n');
      writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', workflow: { profile: 'light' }, ...extraConfig }, null, 2));
      prepare(root);
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
    // Finish-gate audit (#58): the routine identity's launch bindings are
    // frozen with the identity and carried into the plan that earns the
    // evidence, and a PASS is signed for the identity only when every executed
    // command ran where it binds it. Through the public verifier: an ignored
    // alias re-pointed by an earlier configured command does not move the
    // later one, and a pinned directory replaced by an earlier command refuses
    // the later one instead of publishing another directory's PASS.
    {
      const bindingsUnit = freezeLaunchBindings(realpathSync(handlerSandbox), [{ label: 'a', command: 'node', args: [] }]);
      check(bindingsUnit[0].path === realpathSync(handlerSandbox) && Number.isInteger(bindingsUnit[0].identity?.ino), 'control: the frozen binding carries the canonical path and its identity');
      expectRepaired(typeof launchDirectoryMismatch(bindingsUnit, [{ label: 'a', launchCwd: join(realpathSync(handlerSandbox), 'other'), code: 0 }]) === 'string'
        && launchDirectoryMismatch(bindingsUnit, [{ label: 'a', launchCwd: realpathSync(handlerSandbox), code: 0 }]) === undefined
        && launchDirectoryMismatch(bindingsUnit, [{ label: 'a', launchOutcome: 'not-launched', code: 1 }]) === undefined
        && launchDirectoryMismatch(bindingsUnit, [{ label: 'a', executionReceipt: { disposition: 'reused' }, code: 0 }]) === undefined
        && typeof launchDirectoryMismatch(bindingsUnit, [{ label: 'a', code: 0 }]) === 'string'
        && isLaunchDirectoryDriftError(new Error('[launch_directory_drift] x')) === true && isLaunchDirectoryDriftError(new Error('other')) === false,
        'a result that executed in a directory other than the one the routine identity binds can be signed for the identity');
      const configured = (retargetScript) => ({
        validate: { commands: [
          { label: 'retarget', command: 'node', args: ['retarget.js'] },
          // The probe lives at the project root; from the alias target (a
          // root-level directory, whichever one) it is one level up.
          { label: 'aliased', command: 'node', args: ['../probe.js'], cwd: 'alias' },
        ] },
      });
      const prepareAlias = (root) => {
        // The alias and the directories it can point at are IGNORED (like a
        // build output): re-pointing or replacing them dirties nothing tracked.
        writeFileSync(join(root, '.gitignore'), readFileSync(join(root, '.gitignore'), 'utf8') + 'alias\ndir-a\ndir-b\ndir-a-moved\n');
        mkdirSync(join(root, 'dir-a')); mkdirSync(join(root, 'dir-b'));
        writeFileSync(join(root, 'probe.js'), "const fs = require('node:fs'); const here = fs.realpathSync(process.cwd()); process.stdout.write('cwd=' + here); process.exit(here.endsWith('/dir-a') ? 0 : 1);\n");
        symlinkSync(join(root, 'dir-a'), join(root, 'alias'), 'dir');
      };
      const repointed = seed('fallback-repointed', null, configured(), (root) => { prepareAlias(root); writeFileSync(join(root, 'retarget.js'), "const fs = require('node:fs'); fs.rmSync('alias'); fs.symlinkSync(require('node:path').join(process.cwd(), 'dir-b'), 'alias', 'dir'); process.exit(0);\n"); });
      const repointedJson = repointed.runCli(['--json']);
      const repointedAliased = (repointed.evidence()?.commands ?? []).find((command) => command.label === 'aliased');
      // The probe prints the directory it really ran in and exits 0 only in
      // dir-a; the persisted evidence keeps the command output.
      const repointedWhere = `cwd=${join(realpathSync(repointed.root), 'dir-a')}`;
      expectRepaired(repointedJson.status === 0 && repointed.evidence()?.result === 'PASS' && (repointedAliased?.output ?? repointedJson.text).includes(repointedWhere) && !(repointedAliased?.output ?? '').includes('/dir-b'),
        `the configured plan let an alias re-pointed by an earlier command move a later command, or its evidence records another directory (status=${repointedJson.status}, result=${repointed.evidence()?.result}, ${(repointedAliased?.output ?? repointedJson.text).slice(0, 300)})`);
      const replaced = seed('fallback-replaced', null, configured(), (root) => { prepareAlias(root); writeFileSync(join(root, 'retarget.js'), "const fs = require('node:fs'); fs.renameSync('dir-a', 'dir-a-moved'); fs.symlinkSync(require('node:path').join(process.cwd(), 'dir-b'), 'dir-a', 'dir'); process.exit(0);\n"); });
      const replacedJson = replaced.runCli(['--json']);
      const replacedAliased = (replaced.evidence()?.commands ?? []).find((command) => command.label === 'aliased');
      expectRepaired(replacedJson.status !== 0 && replaced.evidence()?.result !== 'PASS' && (!replacedAliased || (replacedAliased.code !== 0 && replacedAliased.launchCwd === undefined)),
        `a pinned directory replaced by an earlier configured command still produced a PASS, or the later command was attributed to it (status=${replacedJson.status}, result=${replaced.evidence()?.result}, launchCwd=${replacedAliased?.launchCwd}, ${replacedJson.text.slice(0, 300)})`);
      const verifierSource14 = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
      expectRepaired((verifierSource14.match(/if \(isLaunchDirectoryDriftError\(error\)\) throw error;/g) ?? []).length === 2
        && verifierSource14.includes('launchBindings: freezeLaunchBindings(args.ctx.root, args.commands),')
        && (verifierSource14.match(/launchCwds: (?:built|launchBindings)\.?(?:launchBindings)?\.map\(\(binding\) => binding\.path\)/g) ?? []).length === 2
        && verifierSource14.includes('const mismatch = launchDirectoryMismatch(launchBindings, commandResults);')
        && (verifierSource14.match(/built\?\.launchBindings/g) ?? []).length >= 6,
        'the verifier absorbs a launch-directory drift into its fallback, runs the fallback where the alias points now, or signs evidence without checking where the commands ran (source-text guard)');
    }

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
    // Audit #67: the private sandbox was never removed and recreated mid-run,
    // so it still carries its mkdtemp permissions at its final use.
    check(existsSync(sandbox) && (lstatSync(sandbox).mode & 0o777) === 0o700, `the private sandbox lost its owner-only permissions (${existsSync(sandbox) ? (lstatSync(sandbox).mode & 0o777).toString(8) : 'absent'})`);
  }
} else {
  console.log('skip: handler-level validate-file cases need demonstrated artifact write protection on this host');
}
}
