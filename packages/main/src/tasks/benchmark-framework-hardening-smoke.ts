#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAUSAL_AUTHORITY_KEY_FILE,
  CAUSAL_MAX_OUTPUT_CHARS,
  CAUSAL_OUTPUT_TAIL_CHARS,
  DEFAULT_CAUSAL_SELECTOR_POLICY,
  causalDigest,
  computeCausalReceiptHash,
  executeCausalEvidence,
  importCausalEvidenceReceipt,
  preflightCausalEvidence,
  redactCausalOutput,
  redactCausalSelectorOutput,
  redactEnvironment,
  verifyCausalEvidenceReceipt,
} from '../core/causal-evidence.js';
import { acceptanceDiscoveryProfile, runAcceptanceDiscoveryAdapters } from '../core/acceptance-discovery-adapters.js';
import { resolveRepositoryBaseline } from '../core/git-baseline.js';
import { isManagedGlobalThinRoot, resetConfigCache } from '../core/config.js';
import { renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { StoryStore } from '../core/store.js';
import { evaluatePreReviewCheckForContext } from '../handlers/proofstory.js';
import { assertMainWorktreeReadyForMerge } from '../handlers/done-effects.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import { createStoryAdvanceHandlers } from '../handlers/story-advance.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';
import type { HandlerContext } from '../handlers/context.js';
import { projectControllerAssetsIntoStoryWorktree } from '../cli/runtime-root.js';
import { captureStoryIntegrationTarget, resolveStoryIntegrationTarget } from '../core/story-integration-target.js';
import { createReleaseHandlers } from '../handlers/release.js';
import { detectPartialDoneStories, renderPartialDoneSummary } from '../core/partial-done-recovery.js';
import { evaluateRegisteredCommandEvidence } from '../core/pre-review-check.js';
import { writeReleasePushApproval } from '../core/release-push-approval.js';
import { CONTROLLER_RUNTIME_ASSET_PATHS } from '../core/controller-runtime-projection.js';
import { classifyScopePath, SCOPE_PATH_CANONICALIZER_VERSION } from '../core/scope-path-classifier.js';
import { checkScopeContract } from '../core/scope-contract.js';
import { classifyLifecycleArtifact } from '../core/lifecycle-registry.js';
import { PROCESS_FACT_REGISTRY } from '../core/process-fact-registry.js';
import { createAcceptanceAmendmentController } from '../core/acceptance-amendment-journal.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';
import { signCanonical } from '../core/authority-signing.js';
import { runScopeTransitionGate } from '../handlers/phase-gates.js';
import { readManagedInventoryCriticMaterialDirtyFiles } from '../handlers/review-inventory.js';
import { shellQuote } from '../core/shell-quote.js';
import { readMaterialDirtyFiles } from '../core/evidence-freshness.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../../..');
const failures: string[] = [];

function check(name: string, run: () => void): void {
  try { run(); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

async function checkAsync(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function initRepo(root: string, branch: string): void {
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['config', 'user.email', 'lab@example.invalid']);
  git(root, ['config', 'user.name', 'Lab']);
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
}

function runCurrentCliShellCommand(command: string, cwd: string): ReturnType<typeof spawnSync> {
  const recoveryBin = mkdtempSync(join(tmpdir(), 'proof-or-stop-recovery-bin-'));
  try {
    const cliPath = join(repositoryRoot, 'packages/main/dist/cli.js');
    const shim = join(recoveryBin, 'proof-or-stop');
    writeFileSync(shim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`);
    chmodSync(shim, 0o755);
    return spawnSync('/bin/sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${recoveryBin}:${process.env.PATH ?? ''}` },
    });
  } finally {
    rmSync(recoveryBin, { recursive: true, force: true });
  }
}

function causalIdentity(storyId: string) {
  return {
    storyId,
    cwd: repositoryRoot,
    command: { executable: process.execPath, args: ['-e', "console.log('CAUSAL_PARENT_SECRET_OK')"] },
    bootstrap: { executable: 'proof-or-stop', args: ['verification-evidence'] },
    inputs: { materialHash: 'material-parent-secret' },
    storyFilesHash: 'story-parent-secret',
    effectiveEnvironment: { NODE_ENV: 'test' },
    runtimeVersion: process.version,
    toolVersion: 'benchmark-framework-hardening@1',
    selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
  };
}

function causalPreflight(identity: ReturnType<typeof causalIdentity>) {
  return preflightCausalEvidence({
    cli: { available: true, path: '/usr/bin/proof-or-stop' },
    worktree: { expected: identity.cwd, actual: identity.cwd },
    gitIndex: { readable: true, path: join(identity.cwd, '.git/index'), expected: 'head-parent-secret', actual: 'head-parent-secret', contentDigest: 'sha256:parent-secret-index' },
    gitMaterial: { available: true, headHash: 'head-parent-secret', materialHash: 'material-parent-secret', storyFilesHash: 'story-parent-secret' },
    writerLease: { available: true, valid: true },
    providerCapability: { required: ['allowlisted-command', 'bounded-output'], available: ['allowlisted-command', 'bounded-output'] },
    resources: { required: { timeoutMs: 1_000 }, available: { timeoutMs: 1_000 } },
    evidenceTarget: { writable: true, path: `${identity.storyId}/causal-evidence/` },
    sideChannel: { available: true, maxOutputChars: CAUSAL_MAX_OUTPUT_CHARS, maxProgressEvents: 10 },
  }, undefined, identity);
}

function runPushHook(root: string, branch: string, sha: string): { status: number; output: string } {
  const result = spawnSync('bash', [join(repositoryRoot, '.githooks/pre-push'), 'origin', 'unused-url'], {
    cwd: root,
    input: `refs/heads/${branch} ${sha} refs/heads/${branch} ${'0'.repeat(40)}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: result.status ?? 1, output: `${result.stdout || ''}${result.stderr || ''}` };
}

check('proxy credentials are absent from causal identity and output-redaction inputs', () => {
  const sentinel = 'http://user:PROXY_SENTINEL@proxy.invalid:8080';
  const environment = redactEnvironment({ HTTPS_PROXY: sentinel, API_TOKEN: 'TOKEN_SENTINEL', LANG: 'en_US.UTF-8' });
  assert.equal(JSON.stringify(environment).includes('PROXY_SENTINEL'), false);
  assert.match(environment.HTTPS_PROXY ?? '', /^<redacted>:sha256:[a-f0-9]{64}$/);
  assert.equal(environment.LANG, 'en_US.UTF-8');
  assert.equal(redactCausalOutput(`connected through ${sentinel}`, { HTTPS_PROXY: sentinel }).includes('PROXY_SENTINEL'), false);
  assert.equal(redactCausalSelectorOutput(`connected through ${sentinel}`, { HTTPS_PROXY: sentinel }).includes('PROXY_SENTINEL'), false);
});

check('selector redaction preserves ordinary environment words', () => {
  const output = 'status: pass; mode: test; command: validate; owner: benchmark-user';
  const redacted = redactCausalSelectorOutput(output, {
    USER: 'benchmark-user',
    NODE_ENV: 'test',
    npm_lifecycle_event: 'validate',
    API_TOKEN: 'pass-secret',
  });
  assert.equal(redacted, output);
  assert.equal(redactCausalSelectorOutput('token=pass-secret', { API_TOKEN: 'pass-secret' }).includes('pass-secret'), false);
});

await checkAsync('benign vendor and session environment values remain selector-visible', async () => {
  const identity = {
    ...causalIdentity('B-benign-selector-environment'),
    effectiveEnvironment: {
      NODE_ENV: 'test',
      AWS_PROFILE: 'default',
      AWS_REGION: 'us-east-1',
      SSH_TTY: '/dev/pts/0',
      XDG_SESSION_CLASS: 'user',
      NO_PROXY: 'localhost',
      GOOGLE_CLOUD_PROJECT: 'demo',
      APP_SESSION: 'interactive',
    },
  };
  const result = await executeCausalEvidence({
    identity,
    selector: 'mode: default',
    run: async () => ({ code: 0, output: 'mode: default; status: user; listening on localhost; project: demo; session: interactive' }),
    preflight: causalPreflight(identity),
    revalidateBeforeRun: () => true,
  });
  assert.equal(result.verdict.result, 'pass');
  assert.match(result.receipt.selectorProbe ?? '', /mode: default/);
  assert.match(result.receipt.selectorProbe ?? '', /listening on localhost/);
  assert.equal(result.receipt.outputTail, result.receipt.selectorProbe);
  assert.equal(result.receipt.outputProbe, result.receipt.selectorProbe);
});

await checkAsync('parent-process secrets never enter short or durable selector evidence', async () => {
  const secret = 'parent-only-secret-89d5817f';
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = secret;
  try {
    const shortIdentity = causalIdentity('B-parent-secret-short');
    const short = await executeCausalEvidence({
      identity: shortIdentity,
      selector: 'CAUSAL_PARENT_SECRET_OK',
      run: async () => ({ code: 0, output: `CAUSAL_PARENT_SECRET_OK ${secret}` }),
      preflight: causalPreflight(shortIdentity),
      revalidateBeforeRun: () => true,
    });
    assert.equal(short.verdict.result, 'pass');
    assert.equal(short.receipt.selectorProbe?.includes(secret), false);
    assert.equal(short.receipt.outputTail, short.receipt.selectorProbe?.replace(/\0/g, '<redacted>'));

    let persistedSelectorOutput = '';
    const longIdentity = causalIdentity('B-parent-secret-long');
    const long = await executeCausalEvidence({
      identity: longIdentity,
      selector: 'CAUSAL_PARENT_SECRET_OK',
      run: async () => ({ code: 0, output: `${'x'.repeat(CAUSAL_MAX_OUTPUT_CHARS + 1)} CAUSAL_PARENT_SECRET_OK ${secret}` }),
      receiptStore: {
        readCausalEvidenceReceipt: () => null,
        writeCausalEvidenceReceipt: () => undefined,
        readCausalSelectorOutput: () => '',
        writeCausalSelectorOutput: (_storyId, _digest, output) => { persistedSelectorOutput = output; },
      },
      preflight: causalPreflight(longIdentity),
      revalidateBeforeRun: () => true,
    });
    assert.equal(long.verdict.result, 'pass');
    assert.equal(persistedSelectorOutput.includes(secret), false);
    assert.equal(long.receipt.outputTail, persistedSelectorOutput.replace(/\0/g, '<redacted>').slice(-CAUSAL_OUTPUT_TAIL_CHARS));
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

await checkAsync('story-lifecycle causal identity v2 migration rejects a signed coherent v1 receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-causal-v1-'));
  try {
    initRepo(root, 'main');
    const identity = { ...causalIdentity('B-causal-v1'), cwd: root };
    const current = await executeCausalEvidence({
      identity,
      selector: 'CAUSAL_PARENT_SECRET_OK',
      run: async () => ({ code: 0, output: 'CAUSAL_PARENT_SECRET_OK' }),
      preflight: causalPreflight(identity),
      revalidateBeforeRun: () => true,
    });
    const legacyIdentity = { ...current.receipt.identity, schemaVersion: 'proof-or-stop.causal-execution-key.v1' };
    const identityDigest = causalDigest(legacyIdentity);
    const executionKey = `ce:v1:${identityDigest}`;
    const { receiptHash: _hash, signerPublicKey, signature: _signature, ...currentPayload } = current.receipt;
    const authorityPayload = { ...currentPayload, identity: legacyIdentity, identityDigest, executionKey };
    const privateKey = readFileSync(join(root, '.proof-or-stop/runtime', CAUSAL_AUTHORITY_KEY_FILE), 'utf8').trim();
    const signed = { ...authorityPayload, signerPublicKey, signature: signCanonical(authorityPayload, privateKey) };
    const legacyReceipt = { ...signed, receiptHash: computeCausalReceiptHash(signed as any) };
    assert.equal(verifyCausalEvidenceReceipt(legacyReceipt as any, executionKey), false);
    assert.throws(
      () => importCausalEvidenceReceipt({
        receipt: legacyReceipt as any,
        expectedStoryId: identity.storyId,
        expectedExecutionKey: executionKey,
        revalidate: () => true,
        commit: () => undefined,
      }),
      /causal_receipt_invalid/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('INIT reviewer uses a host-neutral instruction source', () => {
  const prompt = readFileSync(join(repositoryRoot, 'packages/main/templates/agents/proof-or-stop-review-story-init.md'), 'utf8');
  assert.equal(prompt.includes('`CLAUDE.md` (root directory)'), false);
  assert.match(prompt, /AGENTS\.md|host-neutral project instructions/i);
});

check('master-only repository is a valid integration worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-master-integration-'));
  try {
    initRepo(root, 'master');
    assert.deepEqual(captureStoryIntegrationTarget(root), {
      parentBranch: 'master', parentCommitAtCreation: git(root, ['rev-parse', 'HEAD']), source: 'creation_branch', deliveryMode: 'merge_to_parent',
    });
    assert.equal(assertMainWorktreeReadyForMerge('B-master', root, 'master'), realpathSync(root));
    const store = new StoryStore(root);
    const approval = createReleaseHandlers({ root, scanRoot: root, store }).release_approve_push({ confirm: true, json: true });
    if (typeof approval === 'string') throw new Error('JSON release approval unexpectedly returned text');
    assert.equal(approval.approval.branch, 'refs/heads/master');
    assert.match(approval.nextAction, /git push origin master/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await checkAsync('done_prepare plans the resolved master integration branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-prepare-master-'));
  const worktree = join(root, '.worktrees', 'B-done-prepare-master');
  const previousCwd = process.cwd();
  try {
    initRepo(root, 'master');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    const parentCommitAtCreation = git(root, ['rev-parse', 'HEAD']);
    store.writeStory('B-done-prepare-master', {
      storyId: 'B-done-prepare-master', name: 'done-prepare-master', title: 'Prepare DONE on master', description: 'Use the captured master integration branch',
      type: 'bug', phase: 'TEST', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
      integrationTarget: { parentBranch: 'master', parentCommitAtCreation, source: 'creation_branch', deliveryMode: 'merge_to_parent' },
      worktree: { branch: 'story/B-done-prepare-master', path: worktree, createdAt: new Date().toISOString() },
    });
    store.writeChecklist('B-done-prepare-master', { items: [] });
    git(root, ['add', '-f', 'proof-or-stop.config.json', '.proof-or-stop/story/actives/B-done-prepare-master']);
    git(root, ['commit', '-qm', 'fixture story']);
    git(root, ['branch', 'story/B-done-prepare-master']);
    write(root, 'integration-advance.txt', 'master advanced after Story branch creation\n');
    git(root, ['add', 'integration-advance.txt']);
    git(root, ['commit', '-qm', 'advance master']);
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-done-prepare-master']);
    process.chdir(worktree);
    resetConfigCache();
    const worktreeStore = new StoryStore(worktree);
    const transcript = await createDonePrepareHandlers({ root: worktree, scanRoot: worktree, store: worktreeStore }).done_prepare({
      storyId: 'B-done-prepare-master', mergeMain: true, refreshStale: false, validate: false, build: false, dryRun: true, json: false,
    });
    assert.doesNotMatch(transcript, /local main cannot be found/);
    assert.match(transcript, /dryRun would run git merge master/);
    assert.doesNotMatch(transcript, /git merge main/);
  } finally {
    process.chdir(previousCwd);
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  }
});

check('pre-push accepts only the resolved local integration branch', () => {
  const masterRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-hook-master-'));
  const developRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-hook-develop-'));
  const missingRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-hook-missing-local-'));
  try {
    initRepo(masterRoot, 'master');
    const masterSha = git(masterRoot, ['rev-parse', 'HEAD']);
    writeReleasePushApproval({ root: masterRoot, sha: masterSha, branch: 'master', remote: 'origin', ttlSeconds: 60 });
    const master = runPushHook(masterRoot, 'master', masterSha);
    assert.equal(master.status, 0, master.output);
    assert.equal(resolveRepositoryBaseline(masterRoot)?.ref, 'refs/heads/master');

    initRepo(developRoot, 'develop');
    const developSha = git(developRoot, ['rev-parse', 'HEAD']);
    git(developRoot, ['update-ref', 'refs/remotes/origin/develop', developSha]);
    git(developRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
    writeReleasePushApproval({ root: developRoot, sha: developSha, branch: 'develop', remote: 'origin', ttlSeconds: 60 });
    const develop = runPushHook(developRoot, 'develop', developSha);
    assert.equal(develop.status, 0, develop.output);
    assert.equal(resolveRepositoryBaseline(developRoot)?.ref, 'refs/remotes/origin/develop');

    initRepo(missingRoot, 'main');
    const missingSha = git(missingRoot, ['rev-parse', 'HEAD']);
    git(missingRoot, ['update-ref', 'refs/remotes/origin/develop', missingSha]);
    git(missingRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);
    writeReleasePushApproval({ root: missingRoot, sha: missingSha, branch: 'main', remote: 'origin', ttlSeconds: 60 });
    const missing = runPushHook(missingRoot, 'main', missingSha);
    assert.notEqual(missing.status, 0);
    assert.match(missing.output, /remote default branch lacks a local integration ref/);
    const store = new StoryStore(missingRoot);
    assert.throws(
      () => createReleaseHandlers({ root: missingRoot, scanRoot: missingRoot, store }).release_approve_push({ confirm: true, json: true }),
      /integration branch develop.*current branch is main/,
    );
  } finally {
    rmSync(masterRoot, { recursive: true, force: true });
    rmSync(developRoot, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

check('legacy Story integration target ignores the current task checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-legacy-target-'));
  try {
    initRepo(root, 'main');
    git(root, ['switch', '-qc', 'codex/unrelated']);
    write(root, 'unrelated.txt', 'unrelated\n');
    git(root, ['add', 'unrelated.txt']);
    git(root, ['commit', '-qm', 'unrelated']);
    const target = resolveStoryIntegrationTarget(root, {
      integrationTarget: {
        parentBranch: 'codex/unrelated',
        parentCommitAtCreation: git(root, ['rev-parse', 'HEAD']),
        source: 'creation_branch',
        deliveryMode: 'merge_to_parent',
      },
    });
    assert.equal(target?.parentBranch, 'main');
    assert.equal(target?.source, 'repository_baseline');
    assert.throws(() => assertMainWorktreeReadyForMerge('B-legacy', root, target?.parentBranch), /invalid branch|integration worktree/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('linked worktree inherits global-thin identity from the common repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-thin-'));
  const worktree = join(root, '.worktrees', 'B-global-thin');
  try {
    initRepo(root, 'main');
    write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    write(root, '.proof-or-stop/story/actives/B-global-thin/index.json', JSON.stringify({ storyId: 'B-global-thin', phase: 'INIT_CHECK' }));
    write(root, '.codex/hooks.json', '{"hooks":[]}\n');
    write(root, '.codex/hooks/proof-or-stop-evidence-pretool.cjs', 'module.exports = {};\n');
    write(root, '.codex/hooks/proof-or-stop-scope-pretool.cjs', 'module.exports = {};\n');
    git(root, ['branch', 'story/B-global-thin']);
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-global-thin']);
    assert.equal(isManagedGlobalThinRoot(worktree), true);
    projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId: 'B-global-thin' });
    const contract = {
      storyId: 'B-global-thin', mode: 'enforce' as const, allowedModify: [], allowedCreate: [], allowedTest: [], protectedFiles: [], explicitExcludes: [], acknowledgements: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const assertControllerExemptionRefused = (classification: ReturnType<typeof classifyScopePath>) => {
      assert.equal(classification.allowed, false);
      assert.notEqual(classification.registryId, 'external-controller-runtime');
    };
    for (const path of CONTROLLER_RUNTIME_ASSET_PATHS) {
      assert.equal(readFileSync(join(worktree, path), 'utf8'), readFileSync(join(root, path), 'utf8'));
      const classification = classifyScopePath(contract, path, { projectRoot: worktree, gitCwd: worktree });
      assert.equal(classification.allowed, true);
      assert.equal(classification.category, 'runtime_artifact');
      assert.equal(classification.registryId, 'external-controller-runtime');
    }
    const runtimeReceiptPath = '.proof-or-stop/story/actives/B-global-thin/evidence/controller-runtime-projection.json';
    const runtimeReceiptAbsolute = join(worktree, runtimeReceiptPath);
    assert.equal(existsSync(runtimeReceiptAbsolute), true);
    const runtimeReceiptBytes = readFileSync(runtimeReceiptAbsolute);
    const receiptClassification = classifyScopePath(contract, runtimeReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(receiptClassification.allowed, true);
    assert.equal(receiptClassification.category, 'lifecycle_artifact');
    assert.equal(receiptClassification.registryId, 'controller-runtime-projection-receipt');
    assert.equal((receiptClassification as any).owner, 'proof-or-stop');

    const completeProjectionScope = checkScopeContract({
      ...contract,
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION,
    }, [
      ...CONTROLLER_RUNTIME_ASSET_PATHS,
      runtimeReceiptPath,
      '.proof-or-stop/story/actives/B-global-thin/evidence/controller-config-projection.json',
      'proof-or-stop.config.json',
    ], { projectRoot: worktree, gitCwd: worktree });
    assert.equal(completeProjectionScope.status, 'pass', completeProjectionScope.summary);
    assert.equal(completeProjectionScope.violations.length, 0);
    const configReceiptPath = '.proof-or-stop/story/actives/B-global-thin/evidence/controller-config-projection.json';
    const configReceiptAbsolute = join(worktree, configReceiptPath);
    const configReceiptBytes = readFileSync(configReceiptAbsolute);
    const configReceiptClassification = classifyScopePath(contract, configReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(configReceiptClassification.allowed, true);
    assert.equal(configReceiptClassification.registryId, 'controller-config-projection-receipt');

    const managedCriticDirty = readManagedInventoryCriticMaterialDirtyFiles(
      worktree,
      worktree,
      'B-global-thin',
    );
    assert.equal(managedCriticDirty.error, undefined);
    assert.deepEqual(
      managedCriticDirty.files,
      [],
      'MANAGED_REVIEW_CONTROLLER_PROJECTION_DIRTY: exact signed controller projections must not count as candidate material drift',
    );
    assert.ok(
      readMaterialDirtyFiles(worktree, worktree, { trustedControllerProjectionStoryId: 'B-wrong-story' }).files.includes('proof-or-stop.config.json'),
      'a projection receipt cannot authorize another Story',
    );

    write(worktree, 'unrelated.ts', 'export const unrelated = true;\n');
    assert.ok(
      readMaterialDirtyFiles(worktree, worktree, { trustedControllerProjectionStoryId: 'B-global-thin' }).files.includes('unrelated.ts'),
      'ordinary untracked material remains dirty beside valid controller projections',
    );
    rmSync(join(worktree, 'unrelated.ts'));

    const projectedConfigBytes = readFileSync(join(worktree, 'proof-or-stop.config.json'));
    writeFileSync(join(worktree, 'proof-or-stop.config.json'), Buffer.concat([projectedConfigBytes, Buffer.from('\n')]));
    assert.ok(
      readMaterialDirtyFiles(worktree, worktree, { trustedControllerProjectionStoryId: 'B-global-thin' }).files.includes('proof-or-stop.config.json'),
      'a byte-different projected config remains material dirt',
    );
    writeFileSync(join(worktree, 'proof-or-stop.config.json'), projectedConfigBytes);

    const configReceiptBytesForDirty = readFileSync(configReceiptAbsolute);
    rmSync(configReceiptAbsolute);
    assert.ok(
      readMaterialDirtyFiles(worktree, worktree, { trustedControllerProjectionStoryId: 'B-global-thin' }).files.includes('proof-or-stop.config.json'),
      'a projected config without its Story receipt remains material dirt',
    );
    writeFileSync(configReceiptAbsolute, configReceiptBytesForDirty);

    const projectedAsset = CONTROLLER_RUNTIME_ASSET_PATHS[0];
    const projectedAssetBytes = readFileSync(join(worktree, projectedAsset));
    writeFileSync(join(worktree, projectedAsset), Buffer.concat([projectedAssetBytes, Buffer.from('tampered projection\n')]));
    const tamperedManagedCriticDirty = readMaterialDirtyFiles(
      worktree,
      worktree,
      { trustedControllerProjectionStoryId: 'B-global-thin' },
    );
    assert.ok(
      tamperedManagedCriticDirty.files.includes(projectedAsset),
      'MANAGED_REVIEW_CONTROLLER_PROJECTION_TAMPER: modified controller projections must remain material drift',
    );
    writeFileSync(join(worktree, projectedAsset), projectedAssetBytes);

    git(worktree, ['add', '-f', 'proof-or-stop.config.json']);
    assert.ok(
      readMaterialDirtyFiles(worktree, worktree, { trustedControllerProjectionStoryId: 'B-global-thin' }).files.includes('proof-or-stop.config.json'),
      'an index-tracked projected config remains material dirt even when its bytes and receipts are valid',
    );
    git(worktree, ['reset', '-q', 'HEAD', '--', 'proof-or-stop.config.json']);

    git(worktree, ['add', '-f', projectedAsset]);
    assert.ok(
      readMaterialDirtyFiles(worktree, worktree, { trustedControllerProjectionStoryId: 'B-global-thin' }).files.includes(projectedAsset),
      'an index-tracked projected runtime asset remains material dirt even when its bytes and receipts are valid',
    );
    git(worktree, ['reset', '-q', 'HEAD', '--', projectedAsset]);

    const worktreeStore = new StoryStore(worktree);
    worktreeStore.writeScopeContract('B-global-thin', {
      ...contract,
      allowedModify: ['src/feature.ts'],
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION,
    });
    const scopeContext: HandlerContext = { root: worktree, scanRoot: worktree, store: worktreeStore };
    assert.doesNotThrow(() => runScopeTransitionGate(scopeContext, 'B-global-thin', 'REVIEW'));

    writeFileSync(runtimeReceiptAbsolute, `${runtimeReceiptBytes.toString('utf8').trim()}tampered\n`);
    const tamperedReceipt = classifyScopePath(contract, runtimeReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(tamperedReceipt.allowed, false);
    assert.equal((tamperedReceipt as any).blockerCode, 'UNTRUSTED_CONTROLLER_RUNTIME_PROJECTION_RECEIPT');
    assert.equal((tamperedReceipt as any).owner, 'proof-or-stop');
    assert.doesNotMatch((tamperedReceipt as any).nextAction ?? '', /acceptance_amendment_propose/);
    assert.equal((tamperedReceipt as any).safeToAutoRun, true);
    assert.match((tamperedReceipt as any).nextCommand ?? '', /rm -f -- .*controller-runtime-projection\.json.*proof-or-stop session_brief/);
    assertControllerExemptionRefused(classifyScopePath(contract, CONTROLLER_RUNTIME_ASSET_PATHS[0], { projectRoot: worktree, gitCwd: worktree }));
    const emptyAllowedTamper = checkScopeContract({
      ...contract,
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION,
    }, [runtimeReceiptPath], { projectRoot: worktree, gitCwd: worktree });
    assert.equal(emptyAllowedTamper.status, 'fail');
    assert.equal(emptyAllowedTamper.rows?.[0]?.blockerCode, 'UNTRUSTED_CONTROLLER_RUNTIME_PROJECTION_RECEIPT');
    assert.throws(
      () => runScopeTransitionGate(scopeContext, 'B-global-thin', 'REVIEW'),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /UNTRUSTED_CONTROLLER_RUNTIME_PROJECTION_RECEIPT/);
        assert.match(message, /Do not expand product Story scope/);
        assert.doesNotMatch(message, /用 acceptance_amendment_propose/);
        return true;
      },
    );
    const recovery = runCurrentCliShellCommand((tamperedReceipt as any).nextCommand, worktree);
    assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
    assert.equal(classifyScopePath(contract, runtimeReceiptPath, { projectRoot: worktree, gitCwd: worktree }).allowed, true);
    assert.doesNotThrow(() => runScopeTransitionGate(scopeContext, 'B-global-thin', 'REVIEW'));

    const commonReceiptAbsolute = join(root, '.git', 'proof-or-stop-controller-runtime-projections', 'B-global-thin.json');
    const commonReceiptBytes = readFileSync(commonReceiptAbsolute);
    writeFileSync(commonReceiptAbsolute, `${commonReceiptBytes.toString('utf8').trim()}tampered\n`);
    const tamperedCommonReceipt = classifyScopePath(contract, runtimeReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(tamperedCommonReceipt.allowed, false);
    assert.equal((tamperedCommonReceipt as any).safeToAutoRun, false);
    assert.match((tamperedCommonReceipt as any).nextCommand ?? '', /proof-or-stop check/);
    writeFileSync(commonReceiptAbsolute, commonReceiptBytes);

    rmSync(runtimeReceiptAbsolute);
    assertControllerExemptionRefused(classifyScopePath(contract, CONTROLLER_RUNTIME_ASSET_PATHS[0], { projectRoot: worktree, gitCwd: worktree }));
    writeFileSync(runtimeReceiptAbsolute, runtimeReceiptBytes);

    git(worktree, ['add', '-f', runtimeReceiptPath]);
    const trackedReceipt = classifyScopePath(contract, runtimeReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(trackedReceipt.allowed, false);
    assert.equal((trackedReceipt as any).blockerCode, 'UNTRUSTED_CONTROLLER_RUNTIME_PROJECTION_RECEIPT');
    const runtimeUntrack = runCurrentCliShellCommand((trackedReceipt as any).nextCommand, worktree);
    assert.equal(runtimeUntrack.status, 0, `${runtimeUntrack.stdout}\n${runtimeUntrack.stderr}`);
    assert.equal(classifyScopePath(contract, runtimeReceiptPath, { projectRoot: worktree, gitCwd: worktree }).allowed, true);

    writeFileSync(configReceiptAbsolute, `${configReceiptBytes.toString('utf8').trim()}tampered\n`);
    const tamperedConfigReceipt = classifyScopePath(contract, configReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(tamperedConfigReceipt.allowed, false);
    assert.equal((tamperedConfigReceipt as any).blockerCode, 'UNTRUSTED_CONTROLLER_CONFIG_PROJECTION_RECEIPT');
    const configRecovery = runCurrentCliShellCommand((tamperedConfigReceipt as any).nextCommand, worktree);
    assert.equal(configRecovery.status, 0, `${configRecovery.stdout}\n${configRecovery.stderr}`);
    assert.equal(classifyScopePath(contract, configReceiptPath, { projectRoot: worktree, gitCwd: worktree }).allowed, true);
    git(worktree, ['add', '-f', configReceiptPath]);
    const trackedConfigReceipt = classifyScopePath(contract, configReceiptPath, { projectRoot: worktree, gitCwd: worktree });
    assert.equal(trackedConfigReceipt.allowed, false);
    assert.equal((trackedConfigReceipt as any).blockerCode, 'UNTRUSTED_CONTROLLER_CONFIG_PROJECTION_RECEIPT');
    const configUntrack = runCurrentCliShellCommand((trackedConfigReceipt as any).nextCommand, worktree);
    assert.equal(configUntrack.status, 0, `${configUntrack.stdout}\n${configUntrack.stderr}`);
    assert.equal(classifyScopePath(contract, configReceiptPath, { projectRoot: worktree, gitCwd: worktree }).allowed, true);

    const asset = CONTROLLER_RUNTIME_ASSET_PATHS[0];
    const controllerBytes = readFileSync(join(root, asset));
    const worktreeBytes = readFileSync(join(worktree, asset));
    writeFileSync(join(root, asset), Buffer.concat([controllerBytes, Buffer.from('controller drift\n')]));
    assertControllerExemptionRefused(classifyScopePath(contract, asset, { projectRoot: worktree, gitCwd: worktree }));
    writeFileSync(join(root, asset), controllerBytes);

    writeFileSync(join(worktree, asset), Buffer.concat([worktreeBytes, Buffer.from('worktree drift\n')]));
    assertControllerExemptionRefused(classifyScopePath(contract, asset, { projectRoot: worktree, gitCwd: worktree }));
    writeFileSync(join(worktree, asset), worktreeBytes);

    git(root, ['add', '-f', asset]);
    assertControllerExemptionRefused(classifyScopePath(contract, asset, { projectRoot: worktree, gitCwd: worktree }));
    git(root, ['reset', '-q', 'HEAD', '--', asset]);

    git(worktree, ['add', '-f', asset]);
    assertControllerExemptionRefused(classifyScopePath(contract, asset, { projectRoot: worktree, gitCwd: worktree }));
    git(worktree, ['reset', '-q', 'HEAD', '--', asset]);

    assertControllerExemptionRefused(classifyScopePath({ ...contract, storyId: 'B-wrong-story' }, asset, { projectRoot: worktree, gitCwd: worktree }));
    assertControllerExemptionRefused(classifyScopePath(contract, '.codex/not-projected.cjs', { projectRoot: worktree, gitCwd: worktree }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('controller runtime projection receipt is registered as one managed process artifact', () => {
  const lifecycle = classifyLifecycleArtifact(
    '.proof-or-stop/story/actives/B-registry/evidence/controller-runtime-projection.json',
    { storyId: 'B-registry' },
  );
  assert.equal(lifecycle?.kind, 'lifecycle');
  assert.equal(
    PROCESS_FACT_REGISTRY.filter(entry => entry.name === 'artifact:evidence/controller-runtime-projection.json').length,
    1,
  );
  const withoutVerificationContext = classifyScopePath({
    storyId: 'B-registry', allowedModify: ['src/feature.ts'], allowedCreate: [], allowedTest: [], protectedFiles: [], explicitExcludes: [],
  }, '.proof-or-stop/story/actives/B-registry/evidence/controller-runtime-projection.json');
  assert.equal(withoutVerificationContext.allowed, false);
  assert.equal((withoutVerificationContext as any).blockerCode, 'UNTRUSTED_CONTROLLER_RUNTIME_PROJECTION_RECEIPT');
  const configWithoutVerificationContext = classifyScopePath({
    storyId: 'B-registry', allowedModify: ['src/feature.ts'], allowedCreate: [], allowedTest: [], protectedFiles: [], explicitExcludes: [],
  }, '.proof-or-stop/story/actives/B-registry/evidence/controller-config-projection.json');
  assert.equal(configWithoutVerificationContext.allowed, false);
  assert.equal((configWithoutVerificationContext as any).blockerCode, 'UNTRUSTED_CONTROLLER_CONFIG_PROJECTION_RECEIPT');
});

check('global-thin DEV to REVIEW scope gate admits a complete projection on main and master', () => {
  for (const integrationBranch of ['main', 'master']) {
    const root = mkdtempSync(join(tmpdir(), `proof-or-stop-${integrationBranch}-projection-gate-`));
    const storyId = `B-${integrationBranch}-projection`;
    const worktree = join(root, '.worktrees', storyId);
    try {
      initRepo(root, integrationBranch);
      const storyDir = integrationBranch === 'master' ? '.custom-pos/stories' : '.proof-or-stop/story/actives';
      write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
      write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir, scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
      write(root, `${storyDir}/${storyId}/index.json`, JSON.stringify({ storyId, phase: 'DEV' }));
      write(root, '.codex/hooks.json', '{"hooks":[]}\n');
      write(root, '.codex/hooks/proof-or-stop-evidence-pretool.cjs', 'module.exports = {};\n');
      write(root, '.codex/hooks/proof-or-stop-scope-pretool.cjs', 'module.exports = {};\n');
      git(root, ['branch', `story/${storyId}`]);
      mkdirSync(dirname(worktree), { recursive: true });
      git(root, ['worktree', 'add', '-q', worktree, `story/${storyId}`]);
      projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId });
      const store = new StoryStore(worktree);
      store.writeScopeContract(storyId, {
        storyId,
        mode: 'enforce',
        allowedModify: ['src/feature.ts'],
        allowedCreate: [],
        allowedTest: [],
        protectedFiles: [],
        explicitExcludes: [],
        acknowledgements: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION,
      });
      const ctx: HandlerContext = { root: worktree, scanRoot: worktree, store };
      assert.doesNotThrow(() => runScopeTransitionGate(ctx, storyId, 'REVIEW'), `${integrationBranch} projection should pass the real transition scope gate`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

check('global-thin Story worktree check inspects the controller and refuses local apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-thin-check-'));
  const worktree = join(root, '.worktrees', 'B-check');
  try {
    initRepo(root, 'main');
    write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    write(root, '.proof-or-stop/story/actives/B-check/index.json', JSON.stringify({ storyId: 'B-check', phase: 'DEV' }));
    git(root, ['branch', 'story/B-check']);
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-check']);
    projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId: 'B-check' });

    const cliPath = join(repositoryRoot, 'packages/main/dist/cli.js');
    const readOnly = spawnSync(process.execPath, [cliPath, 'check', '--json'], { cwd: worktree, encoding: 'utf8' });
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.equal(JSON.parse(readOnly.stdout).assetRoot, realpathSync(root));

    const before = ['AGENTS.md', '.gitignore'].map(path => existsSync(join(worktree, path)));
    const apply = spawnSync(process.execPath, [cliPath, 'check', '--apply', '--json'], { cwd: worktree, encoding: 'utf8' });
    assert.notEqual(apply.status, 0);
    const applyOutput = `${apply.stdout}\n${apply.stderr}`;
    assert.ok(applyOutput.includes(`cd -- ${shellQuote(realpathSync(root))}`));
    assert.match(applyOutput, /proof-or-stop check --apply/);
    assert.deepEqual(['AGENTS.md', '.gitignore'].map(path => existsSync(join(worktree, path))), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('controller runtime receipt writes refuse Story and Git-common symlink ancestors', () => {
  for (const targetKind of ['story', 'common'] as const) {
    const root = mkdtempSync(join(tmpdir(), `proof-or-stop-runtime-receipt-${targetKind}-`));
    const outside = mkdtempSync(join(tmpdir(), `proof-or-stop-runtime-receipt-outside-${targetKind}-`));
    const storyId = `B-receipt-${targetKind}`;
    const worktree = join(root, '.worktrees', storyId);
    try {
      initRepo(root, 'main');
      write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
      write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
      git(root, ['add', 'proof-or-stop.config.json']);
      git(root, ['commit', '-qm', 'track fixture config']);
      write(root, `.proof-or-stop/story/actives/${storyId}/index.json`, JSON.stringify({ storyId, phase: 'DEV' }));
      write(root, '.codex/hooks.json', '{"hooks":[]}\n');
      write(root, '.codex/hooks/proof-or-stop-evidence-pretool.cjs', 'module.exports = {};\n');
      write(root, '.codex/hooks/proof-or-stop-scope-pretool.cjs', 'module.exports = {};\n');
      git(root, ['branch', `story/${storyId}`]);
      mkdirSync(dirname(worktree), { recursive: true });
      git(root, ['worktree', 'add', '-q', worktree, `story/${storyId}`]);
      if (targetKind === 'common') {
        symlinkSync(outside, join(root, '.git', 'proof-or-stop-controller-runtime-projections'));
      } else {
        projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId });
        const evidenceDir = join(worktree, '.proof-or-stop/story/actives', storyId, 'evidence');
        rmSync(evidenceDir, { recursive: true, force: true });
        symlinkSync(outside, evidenceDir);
      }
      assert.throws(
        () => projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId }),
        /symlink receipt path|symlink path/i,
      );
      assert.equal(existsSync(join(outside, 'controller-runtime-projection.json')), false);
      assert.equal(existsSync(join(outside, `${storyId}.json`)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

check('emitted recovery paths are POSIX quoted against command substitution', () => {
  const parent = mkdtempSync(join(tmpdir(), 'proof-or-stop-shell-quote-'));
  const literalName = 'repo $(touch PWNED) `touch ALSO_PWNED`';
  const target = join(parent, literalName);
  try {
    mkdirSync(target);
    const probe = spawnSync('/bin/sh', ['-c', `cd -- ${shellQuote(target)} && pwd`], { cwd: parent, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(realpathSync(probe.stdout.trim()), realpathSync(target));
    assert.equal(existsSync(join(parent, 'PWNED')), false);
    assert.equal(existsSync(join(parent, 'ALSO_PWNED')), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

check('acceptance amendment reports each missing prerequisite and exact repair command', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-amendment-prerequisites-'));
  try {
    initRepo(root, 'main');
    const store = new StoryStore(root);
    store.writeStory('B-amend', {
      storyId: 'B-amend', name: 'amend', title: 'Amendment prerequisite error', description: 'Exercise exact recovery guidance',
      type: 'bug', phase: 'DEV', priority: 'low', createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
    });
    const controller = createAcceptanceAmendmentController(store, root);
    assert.throws(() => controller.propose({
      storyId: 'B-amend', amendmentId: 'A-1', submitterSessionId: 'session-test',
      delta: { addItems: [], appendIntents: [], scopeDelta: { modify: [], create: [], test: [] }, topologyDelta: [] },
    }), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /scope-contract\.json/);
      assert.match(message, /scope_contract_init_from_plan --storyId=B-amend/);
      assert.match(message, /proofstory-contract\.json/);
      assert.match(message, /proofstory_contract_set --storyId=B-amend/);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('Claude-only global-thin worktree does not require Codex runtime assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-thin-no-codex-'));
  const worktree = join(root, '.worktrees', 'B-claude-only');
  try {
    initRepo(root, 'main');
    write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    write(root, '.proof-or-stop/story/actives/B-claude-only/index.json', JSON.stringify({ storyId: 'B-claude-only', phase: 'INIT_CHECK' }));
    git(root, ['branch', 'story/B-claude-only']);
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-claude-only']);
    const projected = projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId: 'B-claude-only' });
    assert.equal(existsSync(join(projected.storyRoot, 'index.json')), true);
    assert.equal(existsSync(join(projected.storyRoot, 'evidence/controller-runtime-projection.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('global-thin projection refuses a controller runtime symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-thin-symlink-'));
  const worktree = join(root, '.worktrees', 'B-runtime-symlink');
  try {
    initRepo(root, 'main');
    write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    write(root, '.proof-or-stop/story/actives/B-runtime-symlink/index.json', JSON.stringify({ storyId: 'B-runtime-symlink', phase: 'INIT_CHECK' }));
    write(root, 'runtime-target.json', '{"hooks":[]}\n');
    mkdirSync(join(root, '.codex'), { recursive: true });
    symlinkSync('../runtime-target.json', join(root, '.codex/hooks.json'));
    git(root, ['branch', 'story/B-runtime-symlink']);
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-runtime-symlink']);
    assert.throws(
      () => projectControllerAssetsIntoStoryWorktree({ controllerRoot: root, worktreeRoot: worktree, storyId: 'B-runtime-symlink' }),
      /refused unsafe symlink|refused symlink/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('partial-DONE detection reports an unresolved legacy integration target', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-partial-done-unresolved-'));
  try {
    initRepo(root, 'story/B-orphan');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    store.writeStory('B-orphan', {
      storyId: 'B-orphan', name: 'orphan', title: 'Orphan', description: 'Legacy partial DONE without an integration target',
      type: 'bug', phase: 'DONE', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      worktree: { branch: 'story/B-orphan', path: root, createdAt: new Date().toISOString() },
    });
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'partial done']);
    const partial = detectPartialDoneStories(root, store);
    assert.equal(partial.length, 1);
    assert.match(partial[0]?.reason ?? '', /integration target cannot be resolved/);
    assert.match(renderPartialDoneSummary(partial).join('\n'), /integration target cannot be resolved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('DONE projections fail closed when no integration target exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-unresolved-'));
  try {
    initRepo(root, 'story/B-unresolved');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    store.writeStory('B-unresolved', {
      storyId: 'B-unresolved', name: 'unresolved', title: 'Unresolved', description: 'No integration branch can be resolved',
      type: 'bug', phase: 'TEST', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
      worktree: { branch: 'story/B-unresolved', path: root, createdAt: new Date().toISOString() },
    });
    assert.throws(
      () => assertMainWorktreeReadyForMerge('B-unresolved', root),
      /no integration branch can be resolved/i,
    );
    const rows = buildDoneChecklist('B-unresolved', store, root, { gitCwd: root, auditWriter: null });
    const target = rows.find(row => row.id === 'integration-target');
    assert.equal(target?.status, 'fail');
    assert.equal(target?.blocking, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

await checkAsync('DONE refuses an unresolved target before fetch or merge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-done-no-mutation-'));
  const tracePath = join(root, 'git-trace.jsonl');
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    initRepo(root, 'main');
    git(root, ['switch', '--orphan', 'story/B-no-target']);
    write(root, 'story.txt', 'unrelated story history\n');
    git(root, ['add', 'story.txt']);
    git(root, ['commit', '-qm', 'orphan story']);
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    store.writeStory('B-no-target', {
      storyId: 'B-no-target', name: 'no-target', title: 'No target', description: 'Unrelated main and Story histories have no integration basis',
      type: 'bug', phase: 'TEST', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
      worktree: { branch: 'story/B-no-target', path: root, createdAt: new Date().toISOString() },
    });
    const before = git(root, ['rev-parse', 'HEAD']);
    process.env.GIT_TRACE2_EVENT = tracePath;
    await assert.rejects(
      () => createStoryAdvanceHandlers({ root, scanRoot: root, store }).story_advance({ storyId: 'B-no-target', phase: 'DONE', json: true }),
      /no integration branch can be resolved.*No fetch, merge, phase mutation, or DONE effect was attempted/i,
    );
    const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : '';
    assert.equal(/"argv":\["git","fetch"/.test(trace), false, trace);
    assert.equal(/"argv":\["git","merge"/.test(trace), false, trace);
    assert.equal(store.readStory('B-no-target').phase, 'TEST');
    assert.equal(git(root, ['rev-parse', 'HEAD']), before);
    assert.equal(existsSync(join(root, '.git', 'MERGE_HEAD')), false);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    rmSync(root, { recursive: true, force: true });
  }
});

check('Go profile describes command evidence instead of unsupported topology adapters', () => {
  const profile = acceptanceDiscoveryProfile('go-command') as { methods: readonly string[] };
  assert.deepEqual(profile.methods, ['registered_command_receipts']);
  const results = runAcceptanceDiscoveryAdapters({
    supported: true,
    verificationProfile: 'go-command',
    workspaceRoot: join(tmpdir(), 'missing-go-discovery-root'),
    storyId: 'B-go-command',
    plannedPathRecords: [],
    scopeRefs: [],
  });
  assert.deepEqual(results.map(result => result.method), ['registered_command_receipts']);
  assert.equal(results[0]?.coverageClaim, 'unsupported');
  assert.ok((results[0]?.blindSpots.length ?? 0) > 0);
  const commandGate = evaluateRegisteredCommandEvidence({
    gitCwd: repositoryRoot,
    metadataRoot: repositoryRoot,
    storyId: 'B-go-command',
    checklist: {
      items: [{
        id: 'CHK-001', title: 'Run Go checks', status: 'in_progress',
        verificationIntent: {
          happy: [{ id: 'GO-TEST', desc: 'go test passes', type: 'cli', priority: 'must', verification: { command: 'go test ./...', selector: 'PASS' } }],
          edge: [], adversarial: [],
        },
        verificationEvidence: [],
      }],
    } as any,
    cutoffAt: new Date().toISOString(),
    freshness: { headHash: 'head-go', materialHash: 'material-go', storyFilesHash: 'story-go' },
  });
  assert.equal(commandGate.ok, false);
  assert.ok(commandGate.codes.includes('PR_POSITIVE_EVIDENCE_MISSING'));
});

check('stale evidence hint names every stale intent', () => {
  const hint = renderEvidenceStaleHint('B-stale', [
    { intentRef: 'CHK-001:happy:0', itemId: 'CHK-001', reason: 'material drift' },
    { intentRef: 'CHK-002:edge:0', itemId: 'CHK-002', reason: 'story drift' },
  ], { currentHead: 'abcdef012345' });
  assert.match(hint, /CHK-001:happy:0/);
  assert.match(hint, /CHK-002:edge:0/);
  assert.match(hint, /verification_evidence_refresh_stale --storyId=B-stale/);
});

check('observe pre-review reports a missing PLAN basis without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-missing-basis-'));
  try {
    initRepo(root, 'main');
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
      proofStory: { acceptanceTopologyGateMode: 'observe' },
    }));
    const store = new StoryStore(root);
    store.writeStory('B-missing-basis', {
      storyId: 'B-missing-basis', name: 'missing-basis', title: 'Missing basis', description: 'Missing basis observe regression',
      type: 'bug', phase: 'DEV', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
    });
    store.writeChecklist('B-missing-basis', { items: [] });
    const ctx: HandlerContext = { root, scanRoot: root, store };
    const report = evaluatePreReviewCheckForContext(ctx, 'B-missing-basis');
    assert.equal(report.blocking, false);
    assert.ok((report.codes as readonly string[]).includes('PR_COVERAGE_BASIS_MISSING'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('final response check exposes nonterminal lifecycle state to adapters', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-finalizer-'));
  try {
    initRepo(root, 'main');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    store.writeStory('B-finalizer', {
      storyId: 'B-finalizer', name: 'finalizer', title: 'Finalizer', description: 'Finalizer regression', type: 'bug', phase: 'DEV', priority: 'high',
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
    });
    const ctx: HandlerContext = { root, scanRoot: root, store };
    const result = createPlaybookRuntimeMemoryHandlers(ctx).final_response_check({ storyId: 'B-finalizer', json: true });
    assert.equal(result.storyPhase, 'DEV');
    assert.equal(result.lifecycleComplete, false);
    assert.equal(result.completionStatus, 'continuation_required');
    const missing = createPlaybookRuntimeMemoryHandlers(ctx).final_response_check({ storyId: 'B-missing', json: true });
    assert.equal(missing.lifecycleComplete, false);
    assert.equal(missing.completionStatus, 'unknown');
    assert.match(missing.nextAction ?? '', /not found/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('story_advance exposes a structured JSON result option', () => {
  const definition = MAIN_TOOLS.find(tool => tool.name === 'story_advance');
  assert.ok(definition);
  assert.ok(definition && 'json' in definition.schema);
});

check('public lifecycle contracts describe the resolved integration branch', () => {
  const catalog = readFileSync(join(repositoryRoot, 'packages/main/src/cli/command-catalog.ts'), 'utf8');
  const help = readFileSync(join(repositoryRoot, 'packages/main/src/cli/help-renderer.ts'), 'utf8');
  const policy = readFileSync(join(repositoryRoot, 'packages/main/src/core/command-policy.ts'), 'utf8');
  const levels = readFileSync(join(repositoryRoot, 'packages/main/src/core/process-fact-levels.ts'), 'utf8');
  const agents = readFileSync(join(repositoryRoot, 'AGENTS.md'), 'utf8');
  assert.match(catalog, /resolved integration branch/);
  assert.match(help, /local integration branch/);
  assert.match(policy, /resolved integration branch/);
  assert.match(levels, /resolved integration branch/);
  assert.doesNotMatch(catalog, /merged into main|one remote main push/);
  assert.doesNotMatch(help, /Merge back to local main|git push origin main/);
  assert.doesNotMatch(policy, /merge local main|refs\/heads\/main remote publish/);
  assert.doesNotMatch(levels, /main-safety checks|remote main publish/);
  assert.doesNotMatch(agents, /merge to local main, run post-merge|exact-main|Story branch must contain current local main/);
});

await checkAsync('story_advance JSON mode returns the actual structured transition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-advance-json-'));
  try {
    initRepo(root, 'main');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    store.writeStory('B-json', {
      storyId: 'B-json', name: 'json', title: 'JSON transition', description: 'Exercise the public JSON transition result',
      type: 'bug', phase: 'IDEA', priority: 'low', createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
    });
    const output = await createStoryAdvanceHandlers({ root, scanRoot: root, store }).story_advance({
      storyId: 'B-json', phase: 'PLAN', checklist: [{ id: 'CHK-001', title: 'Verify JSON output' }], json: true,
    });
    const parsed = JSON.parse(output) as { storyId?: string; newState?: string };
    assert.equal(parsed.storyId, 'B-json');
    assert.equal(parsed.newState, 'PLAN');
    assert.equal(store.readStory('B-json').phase, 'PLAN');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`BENCHMARK_FRAMEWORK_HARDENING_RED ${failure}`);
  process.exit(1);
}

console.log('benchmark-framework-hardening-smoke: PASS');
