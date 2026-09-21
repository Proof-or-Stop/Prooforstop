


import assert from 'node:assert/strict';


import { closeSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';



import ts from 'typescript';



import { fixtureRoots, buildArtifactReleaseRecord, artifactReleaseRecordValidationErrors, artifactReleaseLedgerPath, appendArtifactReleaseRecord, readArtifactReleaseLedger, artifactAppendMutations, ArtifactReleaseLedgerError, repoRoot, mainRoot, fixtureFindingKeyTargets, commonGitDir, StoryStore, distRoot } from "./data.mjs";
import { check } from "./runner.mjs";
import { git, runCli } from "./fixture-support.mjs";
import { createPublicOperationClone, assertCanonicalOperationResponse } from "./public-fixtures.mjs";

export function artifactAppendFixture() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-artifact-append-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs/release-note.md'), 'Canonical append input validation regression.\n');
  const record = buildArtifactReleaseRecord({
    root, storyId: 'B-append-canonical', changedPaths: ['docs/release-note.md'], runtimeSemverChanged: false,
  });
  assert.ok(record);
  assert.deepEqual(artifactReleaseRecordValidationErrors(record), []);
  return { root, record, file: artifactReleaseLedgerPath(root) };
}

export function fixtureFindingKeyPath(root) {
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot && root !== mainRoot, 'Finding key target must be a registered disposable fixture');
  const rootStat = lstatSync(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink() && (rootStat.mode & 0o777) === 0o700, 'Finding key fixture root must be a real mode-0700 directory');
  assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir()), 'Finding key fixture must be a direct mkdtemp child');
  const gitDir = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  assert.equal(gitDir, join(root, '.git'), 'Finding key target must have its own Git common directory');
  assert.ok(!lstatSync(gitDir).isSymbolicLink(), 'Finding key Git directory must not be a symlink');
  assert.equal(realpathSync(gitDir), join(realpathSync(root), '.git'), 'Finding key Git directory must stay inside the fixture');
  return join(gitDir, 'proof-or-stop-finding-ledger-v1.key');
}

export function writeFixtureFindingPrivateKey(root, bytes) {
  const target = fixtureFindingKeyPath(root);
  const fd = openSync(target, 'wx', 0o600); // Never replace an existing trust root.
  fixtureFindingKeyTargets.set(root, target);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  assert.equal(statSync(target).mode & 0o777, 0o600, 'Fixture private key must remain mode 0600');
  assert.ok(readFileSync(target).equals(Buffer.from(bytes)), 'Fixture private-key copy must be exact');
  return target;
}

export function installFixtureFindingLedgerPrivateKey(root) {
  const source = join(commonGitDir, 'proof-or-stop-finding-ledger-v1.key');
  assert.ok(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'The current repository non-authority private key must be a regular file');
  const sourceBytes = readFileSync(source);
  const target = writeFixtureFindingPrivateKey(root, sourceBytes);
  assert.ok(readFileSync(source).equals(sourceBytes), 'Installing fixture trust must not change the source private key');
  return target;
}

export function cleanupFixtureFindingKeys() {
  for (const [root, target] of fixtureFindingKeyTargets) {
    // Unlink only the exact registered fixture file, never follow a key symlink
    // or remove the source key. Do not recurse through a replaced parent path.
    if (!existsSync(root)) continue;
    try {
      if (fixtureFindingKeyPath(root) === target) rmSync(target, { force: true });
    } catch { process.exitCode = 1; }
  }
  fixtureFindingKeyTargets.clear();
}

export async function runCases() {
await check(['artifact-append', 'release', 'identity-cutover'], 'artifact append accepts canonical records and preserves canonical idempotency', () => {
  const { root, record, file } = artifactAppendFixture();
  assert.deepEqual(appendArtifactReleaseRecord(root, record), { status: 'recorded', record });
  assert.deepEqual(readArtifactReleaseLedger(root), [record]);
  const bytes = readFileSync(file);
  assert.deepEqual(appendArtifactReleaseRecord(root, record), { status: 'already_recorded', record });
  assert.deepEqual(readFileSync(file), bytes);
});

for (const [label, mutate] of artifactAppendMutations) {
  for (const existingLedger of [false, true]) {
    await check(['artifact-append', 'release', 'identity-cutover'], `artifact append rejects ${label} before ${existingLedger ? 'same-key idempotency' : 'creating a ledger'}`, () => {
      const { root, record, file } = artifactAppendFixture();
      if (existingLedger) appendArtifactReleaseRecord(root, record);
      const before = existingLedger ? readFileSync(file) : null;
      const invalid = mutate(record);
      assert.equal(invalid.idempotencyKey, record.idempotencyKey, 'negative input retains the canonical idempotency key');
      assert.ok(artifactReleaseRecordValidationErrors(invalid).length > 0, `${label} must be an invalid input`);
      assert.throws(() => appendArtifactReleaseRecord(root, invalid), error =>
        error instanceof ArtifactReleaseLedgerError && /^artifact release append:/.test(error.message),
      'the writer must reject its input before consulting idempotency or changing the ledger');
      if (existingLedger) {
        assert.deepEqual(readFileSync(file), before, 'rejected input must preserve every existing ledger byte');
        assert.deepEqual(readArtifactReleaseLedger(root), [record]);
      } else {
        assert.equal(existsSync(file), false, 'rejected input must not create a ledger');
        assert.equal(existsSync(dirname(file)), false, 'rejected input must not create the ledger directory');
      }
    });
  }
}

await check(['finding-trust', 'identity-cutover'], 'committed Finding receipts require the private producer trust and reject missing or different keys', async () => {
  // The test owns its producer, signed ledger and Git commit. An unrelated
  // active Story need not have a committed ledger in main or a Lab checkout.
  const producerRoot = createPublicOperationClone('proof-or-stop-finding-producer-', false);
  const sourceStore = new StoryStore(producerRoot);
  const { createAuthoritativeFindingMutation } = await import(join(distRoot, 'handlers/finding-ledger.js'));
  createAuthoritativeFindingMutation({root: producerRoot, scanRoot: producerRoot, store: sourceStore})(
    'B-49df', 'isolated-finding-trust-fixture', data => {
      data.findings.push({id:'B-49df:F-lab-trust',desc:'Private fixture receipt authentication',status:'open',severity:'low',category:'missing'});
      return {result: undefined};
    });
  const sourceKey = fixtureFindingKeyPath(producerRoot);
  fixtureFindingKeyTargets.set(producerRoot, sourceKey);
  const sourceKeyBytes = readFileSync(sourceKey);
  const sourceLedger = sourceStore.findingLedgerPath('B-49df');
  const sourceLedgerBytes = readFileSync(sourceLedger);
  git(producerRoot, ['add', '.proof-or-stop/story/actives/B-49df']);
  git(producerRoot, ['-c','user.name=Lab fixture','-c','user.email=lab@example.test','commit','-qm','Record private signed Finding fixture']);
  const sourceHead = git(producerRoot, ['rev-parse', 'HEAD']);
  const realHead = git(repoRoot, ['rev-parse', 'HEAD']);
  const root = createPublicOperationClone('proof-or-stop-finding-trust-', false, producerRoot);
  const fixtureRefs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const assertFixtureRefsUnchanged = () => assert.equal(
    git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), fixtureRefs,
    'Private fixture refs must remain unchanged',
  );
  const store = new StoryStore(root);
  const ledger = store.findingLedgerPath('B-49df');
  const ledgerBytes = readFileSync(ledger);
  const payload = { storyId: 'B-49df', role: 'proof-or-stop-review-quality', json: true };
  const readContext = () => runCli(root, 'review_incremental_context', payload, {}, { entrypoint: join(root, 'packages/main/dist/cli.js') });
  const assertRefused = label => {
    assert.throws(() => store.readFindings('B-49df'), /FINDING_LEDGER_AUTHORITY_INVALID/, `${label}: production reader must authenticate the original receipt`);
    const result = readContext();
    assert.notEqual(result.status, 0, `${label}: public CLI must reject unauthenticated receipts`);
    assert.match(`${result.stdout}${result.stderr}`, /FINDING_LEDGER_AUTHORITY_INVALID/);
    process.stdout.write(`PASS Finding fixture trust rejection: ${label}\n`);
  };
  assertRefused('missing key before repair');
  const target = writeFixtureFindingPrivateKey(root, sourceKeyBytes);
  assert.throws(() => writeFixtureFindingPrivateKey(root, sourceKeyBytes), { code: 'EEXIST' }, 'Never overwrite an existing fixture key');
  assert.ok(store.readFindings('B-49df').findings.length > 0, 'Production-authenticated private Finding projection must be nonempty');
  const admitted = readContext();
  assert.equal(admitted.status, 0, `${admitted.stdout}${admitted.stderr}`);
  assertCanonicalOperationResponse('review_incremental_context', payload, root, admitted.stdout);
  process.stdout.write('PASS Finding fixture trust: original committed receipts authenticate with the private producer key\n');
  rmSync(target);
  assertRefused('removed copied key');
  writeFixtureFindingPrivateKey(root, `${randomBytes(32).toString('base64')}\n`);
  assertRefused('different fixture key');
  assert.ok(ledgerBytes.equals(sourceLedgerBytes), 'Clone must preserve the original committed signed ledger bytes');
  assert.ok(readFileSync(ledger).equals(ledgerBytes), 'Fixture original receipt bytes must remain untouched');
  assert.ok(readFileSync(sourceLedger).equals(sourceLedgerBytes), 'Source Finding ledger bytes must remain untouched');
  assert.ok(readFileSync(sourceKey).equals(sourceKeyBytes), 'Source private-key bytes must remain untouched');
  // Other active worktrees and the host may change unrelated shared refs. The
  // helper only reads the source key; only the disposable clone receives writes.
  assert.equal(git(producerRoot, ['rev-parse', 'HEAD']), sourceHead, 'Fixture trust must not alter the signed producer commit');
  assert.equal(git(repoRoot, ['rev-parse', 'HEAD']), realHead, 'Fixture trust must not alter the repository HEAD');
  assertFixtureRefsUnchanged();
  fixtureFindingKeyPath(root); // Revalidate the private repository before its controlled ref mutation.
  const mutationRef = 'refs/proof-or-stop-fixture/finding-trust-negative';
  const fixtureHead = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', mutationRef, fixtureHead, '0'.repeat(40)]);
  try {
    assert.throws(assertFixtureRefsUnchanged, /Private fixture refs must remain unchanged/, 'Complete private-ref comparison must detect a controlled mutation');
  } finally {
    git(root, ['update-ref', '-d', mutationRef, fixtureHead]);
  }
  assertFixtureRefsUnchanged();
  process.stdout.write('PASS Finding fixture refs: all private refs unchanged; controlled ref mutation detected\n');
  assert.ok(process.listeners('exit').includes(cleanupFixtureFindingKeys), 'Abnormal JavaScript exit must retain exact-key cleanup');
  cleanupFixtureFindingKeys();
  assert.equal(existsSync(target), false, 'Fixture key cleanup must remove the copied or generated private key');
});
}
