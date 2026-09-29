


import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';



import ts from 'typescript';



import { state, repoRoot, fixtureRoots, mainRoot, StoryStore, NOW, createPlaybookRuntimeMemoryHandlers, currentMaterialHash, signDeliveryCheck, distRoot, runArtifactReleaseLedgerAfterDoneMergeDetailed, artifactReleaseLedgerPath, createStoryAdvanceHandlers, runCapabilityReleaseLedgerAfterDoneMerge, capabilityReleaseLedgerPath } from "./data.mjs";
import { check } from "./runner.mjs";
import { git, initRepo } from "./fixture-support.mjs";
import { createPublicOperationClone } from "./public-fixtures.mjs";
import { identityCutoverSourceMap } from "./identity-inventory.mjs";

export function runIdentityVerifier() {
  state.identityVerifierResult ??= spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return state.identityVerifierResult;
}

export function identityVerifierFixtureEntrypoint(root) {
  // ESM canonicalizes import.meta.url, including macOS /var -> /private/var.
  // Match that identity so the actual scanner's main-entry guard executes.
  return realpathSync(join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'));
}

export function materializeIdentityVerifierCheckout(root) {
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot && root !== mainRoot,
    'full verifier checkout is restricted to a generated disposable clone');
  const head = git(root, ['rev-parse', 'HEAD']);
  const index = git(root, ['ls-files', '--stage', '-z']);
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  // The complete tracked-text scanner needs every file, unlike the public
  // operation matrix whose snapshots observe omitted paths as absent.
  git(root, ['sparse-checkout', 'disable']);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'full verifier checkout changed HEAD');
  assert.equal(git(root, ['ls-files', '--stage', '-z']), index, 'full verifier checkout changed indexed paths, modes or blobs');
  assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), refs, 'full verifier checkout changed refs');
}

export function createIdentityVerifierClone(prefix = 'proof-or-stop-b49df-real-verifier-') {
  const root = createPublicOperationClone(prefix);
  materializeIdentityVerifierCheckout(root);
  cpSync(
    join(repoRoot, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'),
    join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'),
  );
  // The scanner and every current identity source must share the same candidate
  // bytes; immutable Story/history remains the clone's original Git content.
  const overlay = new Set([...identityCutoverSourceMap().keys(),
    'packages/main/tests/canonical-new-story-artifacts.test.mjs',
    ...readdirSync(join(repoRoot, 'packages/main/tests/canonical-new-story-artifacts'))
      .filter(name => name.endsWith('.mjs'))
      .map(name => 'packages/main/tests/canonical-new-story-artifacts/' + name),
    'packages/main/tests/brand-role-migration.test.mjs',
    ...['source', 'json', 'fixture'].flatMap(kind => [
      `scripts/identity-reviewed-${kind}-data.json`, `scripts/identity-reviewed-${kind}-contexts.mjs`,
    ]),
  ]);
  for (const path of overlay) {
    assert.ok(!path.startsWith('.proof-or-stop/') && !path.startsWith('.lattice/'), 'identity source overlay must not rewrite Story/history');
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(root, path));
  }
  const verifierPath = identityVerifierFixtureEntrypoint(root);
  const verifier = spawnSync(process.execPath, [verifierPath, '--boundary-only'], { cwd: root, encoding: 'utf8' });
  assert.equal(verifier.status, 0, `${verifier.stdout}${verifier.stderr}`);
  assert.match(verifier.stdout, /^PASS identity-boundary-scan$/m);
  assert.doesNotMatch(verifier.stdout, /^PASS identity-cutover(?:$| policy:)/m, 'partial boundary scan cannot certify full runtime or pack');
  return { root, verifierPath };
}

export function createIdentityRedVerifierClone() {
  const { root, verifierPath } = createIdentityVerifierClone('proof-or-stop-b49df-real-verifier-red-');
  const target = join(root, '.proof-or-stop', 'artifact-releases.jsonl');
  const ledger = readFileSync(target, 'utf8');
  const pinnedRetiredLine = ledger.split('\n').find((line) => line.includes('AR-2659cf69b0912f0b2e2c2f67'));
  assert.ok(pinnedRetiredLine, 'real verifier fixture requires the pinned pre-cutover artifact release row');
  writeFileSync(target, `${ledger}${pinnedRetiredLine}\n`);
  const verifier = spawnSync(process.execPath, [verifierPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(verifier.status, 0, 'real identity verifier must be red after the retired identity mutation');
  assert.match(`${verifier.stdout}${verifier.stderr}`, /pinned suffix provenance record.*appears 2 times.*exactly once/is);
  return { root, verifierPath };
}

export function createDoneTransitionFixture(identityVerifierPath) {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-done-transition-'));
  fixtureRoots.push(root);
  initRepo(root, false);
  writeFileSync(join(root, 'proof-or-stop.config.json'), `${JSON.stringify({
    scanRoot: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
    workflow: { profile: 'light' },
    proofStory: { doneGateMode: 'observe', reviewGateMode: 'observe' },
    flows: { defaults: {}, patterns: [] },
  }, null, 2)}\n`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'),
    [
      "import { spawnSync } from 'node:child_process';",
      `const result = spawnSync(process.execPath, [${JSON.stringify(identityVerifierPath)}], { encoding: 'utf8' });`,
      "process.stdout.write(result.stdout ?? '');",
      "process.stderr.write(result.stderr ?? '');",
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n'),
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'configure DONE identity transition fixture']);

  const storyId = 'B-identity-red-done';
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'identity-red-done', title: 'Identity red DONE',
    description: 'Actual lifecycle transition must remain TEST while the real identity verifier is red.',
    type: 'chore', phase: 'TEST', priority: 'low', createdAt: NOW, startedAt: NOW, endedAt: null,
    currentReviewRound: NOW, events: [{ phase: 'TEST', action: 'seed', timestamp: NOW }],
  });
  createPlaybookRuntimeMemoryHandlers({ store, root, scanRoot: root }).dev_memory_finish_decision({
    storyId,
    decision: 'no-reusable-lesson',
    reason: 'B-49df identity-red DONE lifecycle fixture has no reusable lesson to capture.',
  });
  if (git(root, ['status', '--porcelain', '--', '.proof-or-stop/dev-memory'])) {
    git(root, ['add', '.proof-or-stop/dev-memory']);
    git(root, ['commit', '-m', 'record fixture dev-memory decision']);
  }
  const evidenceHead = git(root, ['rev-parse', 'HEAD']);
  const evidenceMaterialHash = currentMaterialHash(root, 'HEAD', root);
  assert.ok(evidenceMaterialHash);
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-DONE-IDENTITY', title: 'Identity verifier gates DONE', status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ id: 'CHK-DONE-IDENTITY:happy:0', desc: 'DONE is mechanically checked', type: 'logic' }], edge: [], adversarial: [] },
      verificationEvidence: [{
        intentRef: 'CHK-DONE-IDENTITY:happy:0', kind: 'logic_test', result: 'pass',
        note: 'The fixture reaches the real DONE transition identity gate.', command: 'node identity-red-done.test.mjs',
        timestamp: NOW, headHash: evidenceHead, materialHash: evidenceMaterialHash,
      }],
    }],
  });
  store.writeTestEvidence(storyId, {
    command: `proof-or-stop validate --story=${storyId} --json`, output: JSON.stringify({ allPass: true }),
    result: 'PASS', timestamp: NOW, headHash: evidenceHead, materialHash: evidenceMaterialHash,
  });
  const docsPromises = [];
  const realMachineTests = [{ featureId: 'identity-red-done-transition', transcript: 'The public story_advance DONE transition reaches the real identity verifier.' }];
  const closingSelfCheck = {
    hasRealMachineTest: true, hasEdgeCaseCoverage: true, hasUnresolvedTodos: false,
    summary: 'The lifecycle fixture carries signed delivery evidence for the DONE transition.',
  };
  store.writeDeliveryCheck(storyId, {
    storyId, checkedAt: NOW, headHash: evidenceHead, materialHash: evidenceMaterialHash,
    reviewRound: NOW, agentId: 'proof-or-stop-review-delivery', docsPromises, realMachineTests, closingSelfCheck,
    _hash: signDeliveryCheck(storyId, docsPromises, realMachineTests, closingSelfCheck, NOW, evidenceMaterialHash),
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed TEST story ready for DONE preflight']);
  assert.equal(currentMaterialHash(root, 'HEAD', root), evidenceMaterialHash);
  return { root, storyId, store };
}

export async function runCases() {
await check(['identity-cutover'], 'complete identity certification includes real runtime and package witnesses once', () => {
  const result = runIdentityVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^PASS identity-cutover$/m);
  assert.match(result.stdout, /PASS proof-or-stop packed clean-install boundary/);
  assert.doesNotMatch(result.stdout, /^PASS identity-boundary-scan$/m);
  process.stdout.write(result.stdout);
});

await check(['release', 'identity-entrypoint'], 'disposable verifier entrypoint executes the actual scanner through an aliased directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-verifier-entrypoint-'));
  fixtureRoots.push(root);
  symlinkSync(join(repoRoot, 'scripts'), join(root, 'scripts'), 'dir');
  const args = ['--print-schema-baseline'];
  const control = spawnSync(process.execPath, [identityVerifierFixtureEntrypoint(repoRoot), ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(control.status, 0, `${control.stdout}${control.stderr}`);
  const baseline = JSON.parse(control.stdout);
  assert.ok(Number.isInteger(baseline.count) && baseline.count > 0);
  assert.match(baseline.sha256, /^[a-f0-9]{64}$/u);
  const aliased = spawnSync(process.execPath, [identityVerifierFixtureEntrypoint(root), ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(aliased.status, 0, `${aliased.stdout}${aliased.stderr}`);
  assert.equal(aliased.stdout, control.stdout, 'aliased fixture must execute the scanner, not silently skip its main entrypoint');
});

await check(['release'], 'CHK-004:happy:0 DONE release-effects simulation and identity verifier are green', () => {
  const releaseSmoke = spawnSync(process.execPath, [join(distRoot, 'tasks/product-capability-release-smoke.js')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(releaseSmoke.status, 0, `${releaseSmoke.stdout}${releaseSmoke.stderr}`);
  assert.match(releaseSmoke.stdout, /ok product-capability-release \(25 checks\)/);
});

await check(['release'], 'CHK-004 repository identity verifier is green after existing DONE release rows', () => {
  const result = runIdentityVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /PASS identity-cutover/);
  assert.match(result.stdout, /frozen evidence allowlist is exact and current/);
});

await check(['release'], 'CHK-004:edge:0 exact historical release provenance remains narrowly accepted', () => {
  const result = runIdentityVerifier();
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /35 named historical\/provenance byte baselines/);
  assert.match(result.stdout, /frozen evidence allowlist is exact and current/);
});

await check(['release'], 'CHK-004:edge:1 identical release writing is idempotent with one semantic row', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-idempotent-ledger-'));
  fixtureRoots.push(root);
  initRepo(root, false);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'same.md'), 'same release identity\n');
  const mainCommit = git(root, ['rev-parse', 'HEAD']);
  const runGit = (args) => args[0] === 'diff' ? '.proof-or-stop/artifact-releases.jsonl' : '';
  const first = runArtifactReleaseLedgerAfterDoneMergeDetailed(root, 'B-ledger-idempotent', mainCommit, mainCommit, {
    changedPaths: ['docs/same.md'], runGit,
  });
  const bytesAfterFirst = readFileSync(artifactReleaseLedgerPath(root));
  const second = runArtifactReleaseLedgerAfterDoneMergeDetailed(root, 'B-ledger-idempotent', mainCommit, mainCommit, {
    changedPaths: ['docs/same.md'], runGit,
  });
  assert.deepEqual(readFileSync(artifactReleaseLedgerPath(root)), bytesAfterFirst);
  assert.equal(readFileSync(artifactReleaseLedgerPath(root), 'utf8').trim().split('\n').length, 1);
  assert.equal(second.record.id, first.record.id);
  assert.match(second.line, /already recorded/);
});

await check(['release'], 'CHK-004 post-DONE identity failure restores exact ledger bytes before any commit [CHK-004:adversarial:0] (real verifier and DONE post-merge stage)', async () => {
  const verifierMutationCampaign = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs'), '--self-test'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(verifierMutationCampaign.status, 0, `${verifierMutationCampaign.stdout}${verifierMutationCampaign.stderr}`);
  assert.match(verifierMutationCampaign.stdout, /canonical-only release-schema appends/);

  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-ledger-'));
  fixtureRoots.push(root);
  initRepo(root, false);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'first.md'), 'first release\n');
  const mainCommit = git(root, ['rev-parse', 'HEAD']);
  const admittedGitCalls = [];
  runArtifactReleaseLedgerAfterDoneMergeDetailed(root, 'B-ledger-first', mainCommit, mainCommit, {
    changedPaths: ['docs/first.md'],
    runGit: (args) => {
      admittedGitCalls.push(args);
      return args[0] === 'diff' ? '.proof-or-stop/artifact-releases.jsonl' : '';
    },
  });
  assert.ok(admittedGitCalls.some((args) => args.includes('commit')), 'green verifier path must reach commit');
  const ledgerPath = artifactReleaseLedgerPath(root);
  const ledgerBefore = readFileSync(ledgerPath);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'), "process.stderr.write('fixture identity rejection\\n'); process.exit(1);\n");
  writeFileSync(join(root, 'docs', 'second.md'), 'second release\n');
  const blockedGitCalls = [];
  assert.throws(
    () => runArtifactReleaseLedgerAfterDoneMergeDetailed(root, 'B-ledger-blocked', mainCommit, mainCommit, {
      changedPaths: ['docs/second.md'],
      runGit: (args) => { blockedGitCalls.push(args); return ''; },
    }),
    /identity verification failed before commit; ledger bytes restored.*fixture identity rejection/is,
  );
  assert.deepEqual(readFileSync(ledgerPath), ledgerBefore, 'identity-red release must restore exact prior ledger bytes');
  assert.deepEqual(blockedGitCalls, [], 'identity verifier must run before git add or commit');

  const redVerifier = createIdentityRedVerifierClone();
  const lifecycle = createDoneTransitionFixture(redVerifier.verifierPath);
  const cwdBefore = process.cwd();
  try {
    process.chdir(lifecycle.root);
    const storyBytesBefore = readFileSync(lifecycle.store.storyFilePath(lifecycle.storyId, 'index.json'));
    const handlers = createStoryAdvanceHandlers({
      root: lifecycle.root,
      scanRoot: lifecycle.root,
      store: lifecycle.store,
      log: () => {},
    });
    await assert.rejects(
      () => handlers.story_advance({ storyId: lifecycle.storyId, phase: 'DONE' }),
      /DONE identity verification failed before phase mutation; story remains in TEST.*pinned suffix provenance record.*appears 2 times.*exactly once/is,
    );
    assert.equal(lifecycle.store.readStory(lifecycle.storyId).phase, 'TEST');
    assert.deepEqual(
      readFileSync(lifecycle.store.storyFilePath(lifecycle.storyId, 'index.json')),
      storyBytesBefore,
      'identity-red public DONE transition must not persist phase or Story bytes',
    );
  } finally {
    process.chdir(cwdBefore);
  }
});

await check(['release'], 'F-007 capability ledger identity failure restores exact bytes with zero git calls', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-capability-ledger-'));
  fixtureRoots.push(root);
  initRepo(root, false);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'capability-first.md'), 'first capability release\n');
  const mainCommit = git(root, ['rev-parse', 'HEAD']);
  const admittedGitCalls = [];
  runCapabilityReleaseLedgerAfterDoneMerge(root, 'B-capability-first', mainCommit, mainCommit, {
    changedPaths: ['docs/capability-first.md'],
    runGit: (args) => {
      admittedGitCalls.push(args);
      return args[0] === 'diff' ? '.proof-or-stop/capability-releases.jsonl' : '';
    },
  });
  assert.ok(admittedGitCalls.some((args) => args.includes('commit')), 'green capability path must reach commit');
  const ledgerPath = capabilityReleaseLedgerPath(root);
  const ledgerBefore = readFileSync(ledgerPath);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'), "process.stderr.write('fixture capability identity rejection\\n'); process.exit(1);\n");
  writeFileSync(join(root, 'docs', 'capability-second.md'), 'second capability release\n');
  const blockedGitCalls = [];
  assert.throws(
    () => runCapabilityReleaseLedgerAfterDoneMerge(root, 'B-capability-blocked', mainCommit, mainCommit, {
      changedPaths: ['docs/capability-second.md'],
      runGit: (args) => { blockedGitCalls.push(args); return ''; },
    }),
    /identity verification failed before commit; ledger bytes restored.*fixture capability identity rejection/is,
  );
  assert.deepEqual(readFileSync(ledgerPath), ledgerBefore, 'identity-red capability release must restore exact prior bytes');
  assert.deepEqual(blockedGitCalls, [], 'capability identity verifier must run before git add or commit');
});

await check(['release'], 'CHK-004:adversarial:1 exact pin mutations and broad exemptions fail closed', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs'), '--self-test'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /broad-directory exemptions/);
  assert.match(result.stdout, /missing\/stale\/broadened\/token\/path\/context\/digest\/byte allowlist mutations all fail closed/);
});
}
