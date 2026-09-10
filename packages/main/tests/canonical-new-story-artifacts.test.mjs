#!/usr/bin/env node
/**
 * B-49df focused RED/GREEN contract.
 *
 * This file intentionally uses public production registries/builders. Before the
 * B-49df production change it reports the concrete legacy writer, main-root
 * foreign-runtime, and post-release verifier failures in one run.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityCutoverReviewedContexts } from '../../../scripts/verify-proof-or-stop-identity-cutover.mjs';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const commonGitDir = resolve(repoRoot, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim());
const mainRoot = dirname(commonGitDir);
const distRoot = join(packageRoot, 'dist');
const GROUPS = Object.freeze(['scope', 'init', 'runtime', 'runtime-topology', 'release', 'inventory', 'identity-cutover', 'identity-inventory', 'identity-cache', 'identity-sites', 'identity-canonical', 'identity-config-boundary', 'identity-policy', 'identity-policy-boundary', 'identity-snapshot', 'identity-entrypoint', 'f050', 'round23', 'round24', 'memory-identity', 'artifact-append', 'finding-trust']);
const groupArgs = process.argv.slice(2);
if (groupArgs.length > 1 || (groupArgs[0] && !groupArgs[0].startsWith('--group='))) {
  throw new Error(`usage: ${process.argv[1]} [--group=${GROUPS.join('|')}]`);
}
const selectedGroup = groupArgs[0]?.slice('--group='.length) ?? null;
if (selectedGroup !== null && !GROUPS.includes(selectedGroup)) {
  throw new Error(`unknown B-49df test group ${JSON.stringify(selectedGroup)}; expected one of ${GROUPS.join(', ')}`);
}

const {
  buildScopeBoundary,
  buildScopeFreezeCheckArtifact,
  digestExecutionBoundary,
  digestScopeBoundary,
  digestScopeFreezeCheck,
  evaluateScopeFreeze,
  executionBoundaryHashIsFresh,
  normalizeExecutionBoundary,
  normalizeScopeBoundary,
  scopeBoundaryHashIsFresh,
} = await import(join(distRoot, 'core/scope-anti-expansion.js'));
const {
  initCheckAgentMatches,
  initCheckSignatureIsValid,
  recomputeInitCheckHash,
  REQUIRED_INIT_CHECK_AGENTS,
} = await import(join(distRoot, 'core/init-check-gate.js'));
const { resolveAgentMutationAuthority } = await import(join(distRoot, 'core/agent-dispatch-registry.js'));
const {
  COMMAND_POLICIES,
  STORY_WRITE_CAPABILITY_COMMANDS,
  commandRequiresAuthoritativeRuntime,
} = await import(join(distRoot, 'core/command-policy.js'));
const {
  ACTIVE_IDENTITY_OPERATION_BOUNDARIES,
  assertCanonicalActiveIdentityRuntime,
  assertCanonicalActiveIdentityBoundary,
  classifyRuntimeEntrypointAuthority,
} = await import(join(distRoot, 'core/runtime-environment-checks.js'));
const { enforceStoryRuntimeAdmission } = await import(join(distRoot, 'cli/story-runtime-admission.js'));
const { resolveEffectiveOwnershipClass } = await import(join(distRoot, 'cli/ownership-gate.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const { currentMaterialHash } = await import(join(distRoot, 'core/evidence-freshness.js'));
const { signDeliveryCheck } = await import(join(distRoot, 'core/delivery-check-hash.js'));
const { getGuardFailureReason, getScopeAntiExpansionGuardFailureReason } = await import(join(distRoot, 'core/machine.js'));
const promptContracts = await import(join(distRoot, 'core/prompt-contracts.js'));
const promptEnvelope = await import(join(distRoot, 'core/prompt-envelope.js'));
const promptMeasurement = await import(join(distRoot, 'core/prompt-measurement.js'));
const promptRegistry = await import(join(distRoot, 'core/prompt-registry.js'));
const promptRoleContracts = await import(join(distRoot, 'core/prompt-role-contract-registry.js'));
const processFacts = await import(join(distRoot, 'core/process-fact-registry.js'));
const reviewRunContracts = await import(join(distRoot, 'core/review-run.js'));
const { artifactReleaseLedgerPath, readArtifactReleaseLedger, appendArtifactReleaseRecord, buildArtifactReleaseRecord, artifactReleaseRecordValidationErrors, ArtifactReleaseLedgerError, ARTIFACT_RELEASE_SCHEMA_VERSION } = await import(join(distRoot, 'core/artifact-release.js'));
const { capabilityReleaseLedgerPath, readCapabilityReleaseLedger } = await import(join(distRoot, 'core/capability-release.js'));
const {
  runArtifactReleaseLedgerAfterDoneMergeDetailed,
  runCapabilityReleaseLedgerAfterDoneMerge,
} = await import(join(distRoot, 'handlers/done-effects.js'));
const { createStoryAdvanceHandlers } = await import(join(distRoot, 'handlers/story-advance.js'));
const { createPlaybookRuntimeMemoryHandlers } = await import(join(distRoot, 'handlers/playbook-runtime-memory.js'));

const failures = [];
async function check(groups, name, fn) {
  if (selectedGroup !== null && !groups.includes(selectedGroup)) return;
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stderr.write(`FAIL ${name}: ${error?.message ?? error}\n`);
  }
}

const NOW = '2026-09-02T00:00:00.000Z';
const cliPath = join(distRoot, 'cli.js');
const retiredInitActor = ['lat', 'tice-review-story-init'].join('');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function runCli(root, command, payload, env = {}, options = {}) {
  return spawnSync(process.execPath, [options.entrypoint ?? cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    // A real source-lineage audit can emit several thousand structured records;
    // bound capture explicitly instead of killing a valid CLI at Node's 1 MiB default.
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'sess-b49df-fixture', PROOF_OR_STOP_ACTIVITY_SOURCE: 'test', ...env },
  });
}

function initRepo(root, selfProject = false) {
  mkdirSync(join(root, 'packages', 'main'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: selfProject ? 'proof-or-stop' : 'b49df-external-consumer', version: '1.0.0', type: 'module' }) + '\n');
  writeFileSync(join(root, 'packages', 'main', 'package.json'), JSON.stringify({ name: selfProject ? '@proof-or-stop/core' : '@fixture/core', version: '1.0.0', type: 'module' }) + '\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', outDir: 'packages/main/dist', testsDir: 'packages/main/tests',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }) + '\n');
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'Harmonynet']);
  git(root, ['config', 'user.email', '26995688+Harmonynet@users.noreply.github.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture baseline']);
}

function retainHistoricalImplementationPrerequisite(root) {
  assert.ok(fixtureRoots.includes(root), 'historical prerequisite may only be imported into a generated test repository');
  const historical = '0cb738d3f6c7a0aa3cf98faf271ade437e281d13';
  git(repoRoot, ['merge-base', '--is-ancestor', historical, 'HEAD']);
  assert.equal(git(repoRoot, ['show', '-s', '--format=%an <%ae>', historical]), 'Harmonynet <26995688+Harmonynet@users.noreply.github.com>');
  if (spawnSync('git', ['merge-base', '--is-ancestor', historical, 'HEAD'], { cwd: root, stdio: 'ignore' }).status === 0) return;
  git(root, ['fetch', '--no-tags', '--depth=1', repoRoot, historical]);
  // Preserve a real, reachable object unchanged. The new merge and all fixture
  // commits keep the real configured author; no synthetic role-author commit.
  git(root, ['merge', '--allow-unrelated-histories', '-s', 'ours', historical, '-m', 'retain unchanged historical implementation prerequisite']);
}

function validBackground() {
  return [
    '## Trigger Event', 'B-49df requires a fresh Story to expose canonical identity fields through the public CLI.',
    'The fixture captures the generated files rather than synthesizing expected output.', '',
    '## Key Insights', 'Identity fields are checked by an explicit bounded path inventory.',
    'Historical narrative is not treated as an active identity field.', '',
    '## Solution Tradeoffs', 'A temporary git repository gives realistic persistence without touching developer Story data.',
    'The focused fixture stays independent from the active checkout lifecycle.', '',
    '## Conversational Texture', 'Operators should see one current product name in every newly generated identity field.',
    'Failures name the exact artifact and JSON path that carried the retired value.',
  ].join('\n');
}

let freshFixture = null;
const fixtureRoots = []; const fixtureFindingKeyTargets = new Map(); process.once('exit', cleanupFixtureFindingKeys); process.once('SIGTERM', () => { cleanupFixtureFindingKeys(); process.exit(143); }); process.once('SIGINT', () => { cleanupFixtureFindingKeys(); process.exit(130); });
const canonicalBoundary = buildScopeBoundary({
  storyId: 'B-fresh',
  mode: 'custom',
  allowed: ['Unicode scope 范围'],
  excluded: [],
  confirmedBy: 'human',
  confirmationNote: 'fresh B-49df contract',
  now: NOW,
});

await check(['scope'], 'CHK-001 fresh writer emits exact proof-or-stop scope schema', () => {
  assert.equal(canonicalBoundary.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.equal(scopeBoundaryHashIsFresh(canonicalBoundary), true);
});

await check(['scope', 'init', 'runtime', 'inventory', 'identity-cutover'], 'CHK-001/002 public CLI creates fresh canonical scope and INIT evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-fresh-'));
  fixtureRoots.push(root);
  initRepo(root, false);
  const created = runCli(root, 'story_create', {
    name: 'fresh-canonical-artifacts',
    title: 'Fresh canonical artifacts',
    description: 'Generate current scope and INIT identity evidence for a focused contract.',
    type: 'chore', priority: 'high', background: validBackground(), forceNew: true,
    checklist: [{ title: 'Inspect generated identities', context: 'The public CLI must write only canonical active identity fields.' }],
    scopeBoundary: {
      mode: 'custom', allowed: ['fresh canonical Story identity'], excluded: ['historical rewrite'],
      userConfirmed: true, actor: 'human', confirmation: 'User approved the exact B-49df identity boundary.',
    },
    executionBoundary: {
      allowedCommands: ['node packages/main/tests/canonical-new-story-artifacts.test.mjs'],
      allowedTools: ['shell'],
      allowedPaths: ['packages/main/tests/canonical-new-story-artifacts.test.mjs'],
      excludedCommands: ['git push'],
      blockedPaths: ['.proof-or-stop/story'],
    },
  });
  assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
  const storyId = created.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
  assert.ok(storyId, `story_create did not return a Story id: ${created.stdout}`);
  const frozen = runCli(root, 'scope_freeze_check', { storyId });
  assert.equal(frozen.status, 0, `${frozen.stdout}${frozen.stderr}`);
  for (const actor of ['proof-or-stop-product-reviewer', 'proof-or-stop-review-story-init', 'proof-or-stop-review-story-init']) {
    const reviewed = runCli(root, 'init_check_set', { storyId, issues: [], agentId: actor }, { PROOF_OR_STOP_AGENT: actor });
    assert.equal(reviewed.status, 0, `${reviewed.stdout}${reviewed.stderr}`);
  }
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  const generatedJsonArtifacts = Object.fromEntries(
    readdirSync(storyDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => [name, JSON.parse(readFileSync(join(storyDir, name), 'utf8'))]),
  );
  const scope = generatedJsonArtifacts['scope-boundary.json'];
  const init = generatedJsonArtifacts['init-check.json'];
  assert.equal(scope.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.deepEqual(init.agentResults.map((row) => row.agentId).sort(), ['proof-or-stop-product-reviewer', 'proof-or-stop-review-story-init']);
  freshFixture = { root, storyId, storyDir, artifacts: generatedJsonArtifacts };
});

await check(['scope'], 'CHK-001:happy:0 public CLI artifact has exact canonical schema and valid hash', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const scope = new StoryStore(freshFixture.root).readScopeBoundary(freshFixture.storyId);
  assert.equal(scope.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.equal(scopeBoundaryHashIsFresh(scope), true);
});

await check(['scope'], 'CHK-001:happy:1 canonical scope round-trips through reader and INIT_CHECK gate', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const scope = store.readScopeBoundary(freshFixture.storyId);
  assert.deepEqual(scope.allowed, ['fresh canonical Story identity']);
  assert.deepEqual(scope.excluded, ['historical rewrite']);
  assert.equal(scopeBoundaryHashIsFresh(scope), true);
  assert.equal(getGuardFailureReason(freshFixture.storyId, store, 'INIT_CHECK', freshFixture.root), null);
});

await check(['scope'], 'CHK-001:edge:1 canonical writer preserves Unicode with an empty optional excluded list', () => {
  assert.equal(canonicalBoundary.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.deepEqual(canonicalBoundary.allowed, ['Unicode scope 范围']);
  assert.deepEqual(canonicalBoundary.excluded, []);
  assert.equal(scopeBoundaryHashIsFresh(canonicalBoundary), true);
});

await check(['scope'], 'CHK-001:edge:0 historical v1 remains readable, gate-valid, and byte-stable', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const historical = {
    ...store.readScopeBoundary(freshFixture.storyId),
    schemaVersion: 'lattice.scope_boundary.v1',
    _hash: '',
  };
  historical._hash = digestScopeBoundary(historical);
  const bytesBefore = JSON.stringify(historical);
  const normalized = normalizeScopeBoundary(historical);
  assert.equal(normalized.schemaVersion, 'lattice.scope_boundary.v1');
  assert.equal(scopeBoundaryHashIsFresh(normalized), true);
  assert.equal(JSON.stringify(historical), bytesBefore, 'compatibility read must not rewrite historical input bytes');

  const scopePath = join(freshFixture.storyDir, 'scope-boundary.json');
  const freezePath = join(freshFixture.storyDir, 'scope-freeze-check.json');
  const originalScope = readFileSync(scopePath);
  const originalFreeze = readFileSync(freezePath);
  try {
    store.writeScopeBoundary(freshFixture.storyId, historical);
    const story = store.readStory(freshFixture.storyId);
    const freeze = evaluateScopeFreeze({
      storyId: freshFixture.storyId,
      scopeBoundary: historical,
      executionBoundary: store.readExecutionBoundary(freshFixture.storyId),
      story: {
        title: story.title,
        description: story.description,
        background: store.readStoryBackground(freshFixture.storyId) ?? undefined,
      },
      checklist: store.readChecklist(freshFixture.storyId).items.map((item) => ({
        id: item.id, title: item.title, context: item.context, excludes: item.excludes,
      })),
      discardDigest: store.readScopeDiscardDigestForFreeze(freshFixture.storyId),
      now: NOW,
    });
    store.writeScopeBoundary(freshFixture.storyId, freeze.normalizedScopeBoundary);
    store.writeScopeFreezeCheck(freshFixture.storyId, freeze.check);
    const persistedBefore = readFileSync(scopePath);
    assert.equal(getScopeAntiExpansionGuardFailureReason(freshFixture.storyId, store, freshFixture.root), null);
    store.readScopeBoundary(freshFixture.storyId);
    assert.deepEqual(readFileSync(scopePath), persistedBefore, 'reader/gate must not rewrite historical boundary bytes');
  } finally {
    writeFileSync(scopePath, originalScope);
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['scope'], 'CHK-001:adversarial:0 schema-only tampering fails hash and scope gate without rewrite', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const scopePath = join(freshFixture.storyDir, 'scope-boundary.json');
  const original = readFileSync(scopePath);
  const historical = { ...store.readScopeBoundary(freshFixture.storyId), schemaVersion: 'lattice.scope_boundary.v1', _hash: '' };
  historical._hash = digestScopeBoundary(historical);
  const tampered = { ...historical, schemaVersion: 'proof-or-stop.scope_boundary.v1.1' };
  assert.equal(scopeBoundaryHashIsFresh(tampered), false, 'schema-only tampering must invalidate the historical hash');
  try {
    store.writeScopeBoundary(freshFixture.storyId, tampered);
    const persistedBefore = readFileSync(scopePath);
    assert.match(getScopeAntiExpansionGuardFailureReason(freshFixture.storyId, store, freshFixture.root), /scope_boundary_tampered|scope-boundary.*hash|stale/i);
    assert.deepEqual(readFileSync(scopePath), persistedBefore, 'rejected gate must not rewrite tampered bytes');
  } finally {
    writeFileSync(scopePath, original);
  }
});

await check(['scope'], 'CHK-001:adversarial:1 unsupported scope schema lookalikes are rejected', () => {
  for (const schemaVersion of [
    'proof-or-stop.scope_boundary.v1',
    'proof-or-stop.scope_boundary.v1.1 ',
    ['lat', 'tice.scope_boundary.v1.1'].join(''),
  ]) {
    assert.throws(
      () => normalizeScopeBoundary({ ...canonicalBoundary, schemaVersion }),
      /unsupported scope-boundary schemaVersion/,
      schemaVersion,
    );
  }
  assert.equal(buildScopeBoundary({
    storyId: 'B-lookalike', mode: 'custom', allowed: ['x'], excluded: [], now: NOW,
  }).schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
});

await check(['scope', 'inventory'], 'F-001/F-002 fresh execution and freeze schemas are canonical and hash-valid', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const execution = freshFixture.artifacts['execution-boundary.json'];
  const freeze = freshFixture.artifacts['scope-freeze-check.json'];
  assert.equal(execution.schemaVersion, 'proof-or-stop.execution_boundary.v1.1');
  assert.equal(executionBoundaryHashIsFresh(execution), true);
  assert.equal(freeze.schemaVersion, 'proof-or-stop.scope_freeze_check.v1.1');
  assert.equal(freeze._hash, digestScopeFreezeCheck(freeze));
});

await check(['scope'], 'F-001 historical execution/freeze schemas remain readable and byte-stable', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const legacyExecutionSchema = ['lat', 'tice.execution_boundary.v1'].join('');
  const historicalExecution = {
    ...store.readExecutionBoundary(freshFixture.storyId),
    schemaVersion: legacyExecutionSchema,
    _hash: '',
  };
  historicalExecution._hash = digestExecutionBoundary(historicalExecution);
  const executionBytes = JSON.stringify(historicalExecution);
  const normalizedExecution = normalizeExecutionBoundary(historicalExecution);
  assert.equal(normalizedExecution.schemaVersion, legacyExecutionSchema);
  assert.equal(executionBoundaryHashIsFresh(normalizedExecution), true);
  assert.equal(JSON.stringify(historicalExecution), executionBytes);

  const freezePath = join(freshFixture.storyDir, 'scope-freeze-check.json');
  const originalFreeze = readFileSync(freezePath);
  try {
    const historicalFreeze = {
      ...store.readScopeFreezeCheck(freshFixture.storyId),
      schemaVersion: ['lat', 'tice.scope_freeze_check.v1'].join(''),
      _hash: '',
    };
    historicalFreeze._hash = digestScopeFreezeCheck(historicalFreeze);
    store.writeScopeFreezeCheck(freshFixture.storyId, historicalFreeze);
    const persisted = readFileSync(freezePath);
    assert.equal(getScopeAntiExpansionGuardFailureReason(freshFixture.storyId, store, freshFixture.root), null);
    assert.deepEqual(readFileSync(freezePath), persisted);
  } finally {
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['scope'], 'F-012 legacy execution through scope_freeze_check preserves stored hash and remains INIT_CHECK-admissible', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const executionPath = join(freshFixture.storyDir, 'execution-boundary.json');
  const freezePath = join(freshFixture.storyDir, 'scope-freeze-check.json');
  const originalExecution = readFileSync(executionPath);
  const originalFreeze = readFileSync(freezePath);
  try {
    const historicalExecution = {
      ...store.readExecutionBoundary(freshFixture.storyId),
      schemaVersion: ['lat', 'tice.execution_boundary.v1'].join(''),
      _hash: '',
    };
    historicalExecution._hash = digestExecutionBoundary(historicalExecution);
    const adaptedFreeze = buildScopeFreezeCheckArtifact({
      args: { storyId: freshFixture.storyId, status: 'pass', checks: [] },
      scopeBoundary: store.readScopeBoundary(freshFixture.storyId),
      executionBoundary: historicalExecution,
      extensionDecisions: store.readScopeExtensionDecisions(freshFixture.storyId),
      now: NOW,
      actor: 'proof-or-stop-implementer',
    });
    assert.equal(adaptedFreeze.executionBoundaryHash, historicalExecution._hash, 'artifact adapter must bind the validated stored legacy hash');
    store.writeExecutionBoundary(freshFixture.storyId, historicalExecution);
    const persistedLegacyBytes = readFileSync(executionPath);
    const result = runCli(freshFixture.root, 'scope_freeze_check', { storyId: freshFixture.storyId });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const freeze = store.readScopeFreezeCheck(freshFixture.storyId);
    assert.equal(freeze.executionBoundaryHash, historicalExecution._hash, 'freeze writer must bind the validated stored legacy hash');
    assert.deepEqual(readFileSync(executionPath), persistedLegacyBytes, 'combined freeze path must not rewrite legacy execution evidence');
    assert.equal(getScopeAntiExpansionGuardFailureReason(freshFixture.storyId, store, freshFixture.root), null);
  } finally {
    writeFileSync(executionPath, originalExecution);
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['scope'], 'F-001 unsupported execution/freeze schema lookalikes fail closed', () => {
  assert.throws(
    () => normalizeExecutionBoundary({
      ...freshFixture.artifacts['execution-boundary.json'],
      schemaVersion: 'proof-or-stop.execution_boundary.v1',
    }),
    /unsupported execution-boundary schemaVersion/,
  );
  const store = new StoryStore(freshFixture.root);
  const freezePath = join(freshFixture.storyDir, 'scope-freeze-check.json');
  const originalFreeze = readFileSync(freezePath);
  try {
    const lookalike = {
      ...store.readScopeFreezeCheck(freshFixture.storyId),
      schemaVersion: 'proof-or-stop.scope_freeze_check.v1',
      _hash: '',
    };
    lookalike._hash = digestScopeFreezeCheck(lookalike);
    store.writeScopeFreezeCheck(freshFixture.storyId, lookalike);
    assert.match(getScopeAntiExpansionGuardFailureReason(freshFixture.storyId, store, freshFixture.root), /unsupported|unreadable|schema/i);
  } finally {
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['init'], 'CHK-002 only exact canonical INIT reviewer identities are admitted', () => {
  assert.deepEqual([...REQUIRED_INIT_CHECK_AGENTS], ['proof-or-stop-review-story-init', 'proof-or-stop-product-reviewer']);
  assert.equal(initCheckAgentMatches('proof-or-stop-review-story-init', 'proof-or-stop-review-story-init'), true);
  for (const actor of [
    retiredInitActor,
    ' proof-or-stop-review-story-init',
    'proof-or-stop-review-story-init ',
    'Proof-or-stop-review-story-init',
    'proof-or-stop-review-story-init-extra',
  ]) {
    assert.equal(initCheckAgentMatches(actor, 'proof-or-stop-review-story-init'), false, `${JSON.stringify(actor)} must not match`);
    assert.throws(
      () => resolveAgentMutationAuthority({ command: 'init_check_set', payloadActors: [actor], envActor: null }),
      /unknown|retired|not permitted|noncanonical|byte-exact/i,
      `${JSON.stringify(actor)} must fail actor authority`,
    );
  }
  assert.equal(
    resolveAgentMutationAuthority({
      command: 'init_check_set',
      payloadActors: ['proof-or-stop-review-story-init'],
      envActor: null,
    }).actor,
    'proof-or-stop-review-story-init',
  );
});

await check(['init'], 'CHK-002:happy:0 canonical reviewer set is signed and INIT_CHECK-admissible', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const init = store.readInitCheck(freshFixture.storyId);
  assert.deepEqual(init.agentResults.map((row) => row.agentId).sort(), [...REQUIRED_INIT_CHECK_AGENTS].sort());
  assert.equal(initCheckSignatureIsValid(freshFixture.storyId, store, freshFixture.root, init), true);
  assert.equal(getGuardFailureReason(freshFixture.storyId, store, 'INIT_CHECK', freshFixture.root), null);
});

await check(['init'], 'CHK-002:edge:0 signed historical INIT evidence stays inspectable and byte-stable', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const initPath = join(freshFixture.storyDir, 'init-check.json');
  const canonicalBytes = readFileSync(initPath);
  try {
    const historical = structuredClone(store.readInitCheck(freshFixture.storyId));
    historical.agentId = retiredInitActor;
    historical.agentResults = historical.agentResults.map((row) => row.agentId === 'proof-or-stop-review-story-init'
      ? { ...row, agentId: retiredInitActor }
      : row);
    historical._hash = recomputeInitCheckHash(freshFixture.storyId, store, freshFixture.root, historical);
    store.writeInitCheck(freshFixture.storyId, historical);
    const persistedBefore = readFileSync(initPath);
    const inspected = store.readInitCheck(freshFixture.storyId);
    assert.equal(initCheckSignatureIsValid(freshFixture.storyId, store, freshFixture.root, inspected), true);
    assert.ok(inspected.agentResults.some((row) => row.agentId === retiredInitActor));
    assert.deepEqual(readFileSync(initPath), persistedBefore, 'historical inspection must not rewrite signed bytes');
  } finally {
    writeFileSync(initPath, canonicalBytes);
  }
  const refreshed = runCli(
    freshFixture.root,
    'init_check_set',
    { storyId: freshFixture.storyId, issues: [], agentId: 'proof-or-stop-review-story-init' },
    { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-story-init' },
  );
  assert.equal(refreshed.status, 0, `${refreshed.stdout}${refreshed.stderr}`);
  assert.doesNotMatch(readFileSync(initPath, 'utf8'), new RegExp(retiredInitActor, 'i'));
});

await check(['init'], 'CHK-002:edge:1 reverse-order and repeated canonical reviews stay idempotent and signed', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(freshFixture.root);
  const init = store.readInitCheck(freshFixture.storyId);
  assert.deepEqual(init.agentResults.map((row) => row.agentId), ['proof-or-stop-product-reviewer', 'proof-or-stop-review-story-init']);
  assert.equal(new Set(init.agentResults.map((row) => row.agentId)).size, 2);
  assert.equal(initCheckSignatureIsValid(freshFixture.storyId, store, freshFixture.root, init), true);
});

function initArtifactAndRefs(root, storyDir) {
  return {
    init: readFileSync(join(storyDir, 'init-check.json')),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
  };
}

function assertInitArtifactAndRefsUnchanged(root, storyDir, before) {
  assert.deepEqual(readFileSync(join(storyDir, 'init-check.json')), before.init, 'rejected reviewer changed init-check bytes');
  assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), before.refs, 'rejected reviewer changed refs');
}

await check(['init'], 'CHK-002:adversarial:0 retired reviewer CLI is non-zero with zero artifact/ref change', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const before = initArtifactAndRefs(freshFixture.root, freshFixture.storyDir);
  const attempted = runCli(
    freshFixture.root,
    'init_check_set',
    { storyId: freshFixture.storyId, issues: [], agentId: retiredInitActor },
    { PROOF_OR_STOP_AGENT: retiredInitActor },
  );
  assert.notEqual(attempted.status, 0);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /unknown|retired|not permitted|mutation_denied/i);
  assertInitArtifactAndRefsUnchanged(freshFixture.root, freshFixture.storyDir, before);
});

await check(['init'], 'CHK-002:adversarial:1 case whitespace prefix and alias lookalikes never map to canonical', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const rejectedActors = [
    ' proof-or-stop-review-story-init',
    'proof-or-stop-review-story-init ',
    'Proof-or-stop-review-story-init',
    'proof-or-stop-review-story',
    'proof-or-stop-review-story-init@alias',
    `${retiredInitActor}@fallback`,
  ];
  const before = initArtifactAndRefs(freshFixture.root, freshFixture.storyDir);
  for (const actor of rejectedActors) {
    assert.equal(initCheckAgentMatches(actor, 'proof-or-stop-review-story-init'), false, actor);
    const attempted = runCli(
      freshFixture.root,
      'init_check_set',
      { storyId: freshFixture.storyId, issues: [], agentId: actor },
      { PROOF_OR_STOP_AGENT: actor },
    );
    assert.notEqual(attempted.status, 0, actor);
    assert.match(`${attempted.stdout}${attempted.stderr}`, /unknown|retired|not permitted|noncanonical|byte-exact|mutation_denied/i, actor);
    assertInitArtifactAndRefsUnchanged(freshFixture.root, freshFixture.storyDir, before);
  }
});

await check(['init'], 'F-003 current contract prose names canonical INIT reviewers and exact fallback matching', () => {
  const doc = readFileSync(join(repoRoot, 'docs/requirements/decisions/proof-or-stop-agent-prompt-consolidation-execution-plan.md'), 'utf8');
  const initGateSource = readFileSync(join(repoRoot, 'packages/main/src/core/init-check-gate.ts'), 'utf8');
  assert.equal(doc.includes(`currently requires \`${retiredInitActor}\` and \`proof-or-stop-product-reviewer\``), false);
  assert.equal(doc.includes(`required agent set currently includes \`${retiredInitActor}\` and \`proof-or-stop-product-reviewer\``), false);
  assert.match(doc, /required agent set currently includes `proof-or-stop-review-story-init` and `proof-or-stop-product-reviewer`/);
  assert.doesNotMatch(initGateSource, /initCheckAgentMatches matches the `<required>@` prefix/);
  assert.match(initGateSource, /exact `@fallback`|byte-exact.*fallback/i);
});

await check(['init'], 'RI-003 CLAUDE INIT examples execute as canonical signed reviewer evidence', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const guide = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  const examples = [...guide.matchAll(/^proof-or-stop init_check_set '(\{[^\n]+\})'$/gm)]
    .map((match) => JSON.parse(match[1]));
  assert.equal(examples.length, 2, 'CLAUDE.md must provide both executable INIT reviewer templates');
  const store = new StoryStore(freshFixture.root);
  for (const example of examples) {
    assert.equal(example.storyId, 'B-xxx', 'only the documented Story placeholder may be substituted');
    const reviewed = runCli(
      freshFixture.root,
      'init_check_set',
      { ...example, storyId: freshFixture.storyId },
      { PROOF_OR_STOP_AGENT: example.agentId },
    );
    assert.equal(reviewed.status, 0, `CLAUDE.md ${example.agentId} example failed: ${reviewed.stdout}${reviewed.stderr}`);
    const init = store.readInitCheck(freshFixture.storyId);
    const recorded = init.agentResults.find((row) => row.agentId === example.agentId);
    assert.ok(recorded, 'the CLI must persist the exact documented reviewer identity');
    assert.deepEqual(recorded.issues.map(({ severity, desc }) => ({ severity, desc })), example.issues);
    assert.equal(initCheckSignatureIsValid(freshFixture.storyId, store, freshFixture.root, init), true);
  }
  assert.deepEqual(examples.map((example) => example.agentId).sort(), [...REQUIRED_INIT_CHECK_AGENTS].sort());
  assert.equal(getGuardFailureReason(freshFixture.storyId, store, 'INIT_CHECK', freshFixture.root), null);
  const admission = guide.split('\n').find((line) => line.includes('byte-exact canonical admission'));
  assert.ok(admission, 'CLAUDE.md must describe exact INIT reviewer admission');
  for (const actor of REQUIRED_INIT_CHECK_AGENTS) assert.ok(admission.includes(`\`${actor}\``), actor);
  assert.equal(admission.includes('`product-reviewer`'), false, 'the admission statement must not advertise the obsolete role');
});

await check(['init'], 'RI-003 obsolete product-reviewer is rejected without INIT artifact or ref changes', () => {
  assert.ok(freshFixture, 'public CLI fixture must exist');
  const before = initArtifactAndRefs(freshFixture.root, freshFixture.storyDir);
  const attempted = runCli(
    freshFixture.root,
    'init_check_set',
    { storyId: freshFixture.storyId, issues: [], agentId: 'product-reviewer' },
    { PROOF_OR_STOP_AGENT: 'product-reviewer' },
  );
  assert.notEqual(attempted.status, 0);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /unknown|retired|not permitted|mutation_denied/i);
  assertInitArtifactAndRefsUnchanged(freshFixture.root, freshFixture.storyDir, before);
});

await check(['init'], 'RI-004 CLAUDE fallback admission statement agrees with exact runtime matching', () => {
  const guide = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  const statements = guide.split('\n').filter((line) => line.includes('`initCheckAgentMatches`'));
  assert.equal(statements.length, 1, 'CLAUDE.md must provide one unambiguous fallback matching statement');
  const statement = statements[0];
  const accepted = statement.match(/accepts only byte-exact (`[^`]+` or `[^`]+`), rejects /);
  const rejected = statement.match(/, rejects (`[^`]+` and `[^`]+`);/);
  assert.ok(accepted, 'CLAUDE.md must state exact bare and @fallback admission, not general prefix matching');
  assert.ok(rejected, 'CLAUDE.md must explicitly reject the operator and extra-fallback suffix examples');
  const templates = (match) => [...match[1].matchAll(/`([^`]+)`/g)].map((entry) => entry[1]);
  assert.deepEqual(templates(accepted), ['<required>', '<required>@fallback']);
  assert.deepEqual(templates(rejected), ['<required>@operator', '<required>@fallback-extra']);
  for (const required of REQUIRED_INIT_CHECK_AGENTS) {
    for (const template of templates(accepted)) {
      const actor = template.replace('<required>', required);
      assert.equal(initCheckAgentMatches(actor, required), true, `documented accepted actor: ${actor}`);
    }
    for (const template of templates(rejected)) {
      const actor = template.replace('<required>', required);
      assert.equal(initCheckAgentMatches(actor, required), false, `documented rejected actor: ${actor}`);
    }
  }
});

await check(['init'], 'F-121 active lifecycle guide matches canonical INIT actor and exact fallback admission', () => {
  const guide = readFileSync(join(repoRoot, 'docs/requirements/decisions/story-lifecycle.md'), 'utf8');
  const currentFallbackSection = guide.match(
    /### INIT_CHECK Controlled Fallback Without Subagent \(B-95d8\)([\s\S]*?)### init-check signature domain widened/,
  )?.[1];
  assert.ok(currentFallbackSection, 'story-lifecycle.md must retain the bounded current fallback section');
  assert.match(
    currentFallbackSection,
    /`proof-or-stop-review-story-init` and `proof-or-stop-product-reviewer`/,
    'the current guide must name both byte-exact canonical INIT actors',
  );
  assert.doesNotMatch(
    currentFallbackSection,
    /(?<!proof-or-stop-)`product-reviewer`/,
    'the current guide must not advertise the retired unprefixed actor',
  );
  assert.match(
    currentFallbackSection,
    /accepts only the exact bare required identity or exact `<required>@fallback`/,
    'fallback matching must be documented as two exact values, not a prefix rule',
  );
  assert.match(currentFallbackSection, /rejects `<required>@operator` and `<required>@fallback-extra`/);
  assert.match(
    currentFallbackSection,
    /`init_check_set` mechanically validates `agentId` as a byte-exact registered actor/,
    'the guide must describe the handler-enforced actor admission boundary',
  );
});

let runtimeTopologyFixture;
function ensureRuntimeTopologyFixture() {
  if (runtimeTopologyFixture) return runtimeTopologyFixture;
  const container = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-classifier-topology-'));
  fixtureRoots.push(container);
  const main = join(container, 'main');
  mkdirSync(main);
  initRepo(main, true);
  const linked = join(container, 'story-worktree');
  git(main, ['worktree', 'add', '-b', 'story/B-fixture', linked]);
  runtimeTopologyFixture = { main: realpathSync(main), linked: realpathSync(linked) };
  return runtimeTopologyFixture;
}

function runtimeTopologyInput(command, projectRoot, runtimeRoot) {
  return {
    command,
    commandArgs: ['{"storyId":"B-fixture"}'],
    projectRoot,
    invokedEntrypoint: join(runtimeRoot, 'bin', 'proof-or-stop.js'),
    loadedCorePackageRoot: join(runtimeRoot, 'packages', 'main'),
    env: {},
  };
}

function assertForeignRuntimeTopology(command, topology) {
  const decision = classifyRuntimeEntrypointAuthority(runtimeTopologyInput(command, topology.main, topology.linked));
  assert.equal(decision.status, 'blocked', command);
  assert.equal(decision.reasonCode, 'foreign_self_project_runtime_for_story_write', command);
  assert.equal(decision.projectRoot, topology.main, command);
  assert.equal(decision.worktreeRoot, topology.main, command);
  assert.equal(decision.mainRoot, topology.main, command);
  assert.equal(decision.runtimeRoot, topology.linked, command);
  assert.equal(decision.gitCommonDir, realpathSync(join(topology.main, '.git')), command);
  assert.equal(decision.selfHostWorktree, false, command);
}

await check(['runtime', 'runtime-topology'], 'CHK-003 matching main and linked Story runtimes resolve complete explicit topology', () => {
  const topology = ensureRuntimeTopologyFixture();
  for (const projectRoot of [topology.main, topology.linked]) {
    const decision = classifyRuntimeEntrypointAuthority(runtimeTopologyInput('story_update', projectRoot, projectRoot));
    assert.equal(decision.status, 'pass');
    assert.equal(decision.reasonCode, undefined);
    assert.equal(decision.projectRoot, projectRoot);
    assert.equal(decision.worktreeRoot, projectRoot);
    assert.equal(decision.runtimeRoot, projectRoot);
    assert.equal(decision.mainRoot, topology.main);
    assert.equal(decision.gitCommonDir, realpathSync(join(topology.main, '.git')));
    assert.equal(decision.selfHostWorktree, projectRoot === topology.linked);
  }
});

await check(['runtime'], 'CHK-003:happy:0 matching project-local runtime admits Story writers', () => {
  const fixture = createRuntimeFixture();
  cpSync(packageRoot, join(fixture.root, 'packages', 'main'), { recursive: true });
  cpSync(join(repoRoot, 'proof-or-stop.config.json'), join(fixture.root, 'proof-or-stop.config.json'));
  symlinkSync(join(repoRoot, 'node_modules'), join(fixture.root, 'node_modules'), 'dir');
  git(fixture.root, ['add', 'proof-or-stop.config.json']);
  git(fixture.root, ['commit', '-m', 'configure matching self-project runtime']);
  const result = runCli(
    fixture.root,
    'story_update',
    { storyId: fixture.storyId, title: 'Matching local handler admitted' },
    {},
    { entrypoint: join(fixture.root, 'packages', 'main', 'dist', 'cli.js') },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(new StoryStore(fixture.root).readStory(fixture.storyId).title, 'Matching local handler admitted');
});

await check(['runtime', 'runtime-topology'], 'F-004 reviewerWrite Story evidence commands share foreign-runtime admission', () => {
  const topology = ensureRuntimeTopologyFixture();
  const reviewerWriters = Object.entries(COMMAND_POLICIES)
    .filter(([, policy]) => policy.ownershipClass === 'reviewerWrite')
    .map(([command]) => command);
  assert.ok(reviewerWriters.length >= 5, 'expected the registered reviewer evidence writers');
  for (const command of reviewerWriters) {
    assertForeignRuntimeTopology(command, topology);
    assert.throws(
      () => enforceStoryRuntimeAdmission({
        ...runtimeTopologyInput(command, topology.main, topology.linked),
        effectiveOwnership: 'reviewerWrite',
      }),
      /Blocked \[foreign_self_project_runtime_for_story_write\] before dispatch\./,
      command,
    );
  }
  const ownerDelivery = resolveEffectiveOwnershipClass(
    'delivery_check_set',
    { storyId: 'B-fixture', agentId: 'proof-or-stop-implementer' },
    'B-fixture',
  );
  const reviewerDelivery = resolveEffectiveOwnershipClass(
    'delivery_check_set',
    { storyId: 'B-fixture', agentId: 'proof-or-stop-review-delivery' },
    'B-fixture',
  );
  assert.equal(ownerDelivery, 'storyScopedMutating');
  assert.equal(reviewerDelivery, 'reviewerWrite');
});

await check(['runtime'], 'F-010/F-011 registry-derived Story-write capability crosses ownership classes and preserves dynamic reads', () => {
  const requiredWriters = [
    'story_update',
    'init_check_set',
    'story_discard',
    'story_draft_discard',
    'done_recover',
    'story_create',
    'story_create_from_repro',
    'planner_create_story',
    'story_reconcile',
    'gap_log',
    'signature_backfill',
    'planner_run',
    'identity_state_migrate',
    'reviewer_list',
    'agent_prompt',
    'evaluate',
    'dispatch',
    'certification_window_status',
    'doctor',
  ];
  const mutatingArgs = {
    signature_backfill: { apply: true },
    identity_state_migrate: { confirm: true },
    reviewer_list: { storyId: 'B-fixture', forceReviewer: 'quality' },
    agent_prompt: { storyId: 'B-fixture', role: 'proof-or-stop-review-quality', auditExperiment: true, format: 'json' },
    evaluate: { storyId: 'B-fixture' },
    dispatch: { storyId: 'B-fixture', agentType: 'proof-or-stop-review-story-init' },
    certification_window_status: { storyId: 'B-fixture', refresh: true },
    doctor: { repair: true },
  };
  const ownershipContexts = {
    evaluate: { config: { cli: { command: 'echo evaluator' }, promptEnvelope: { version: 'proof-or-stop.prompt-envelope-rollout.v1', roles: { 'proof-or-stop-evaluator': 'full-envelope' } } } },
  };
  for (const command of requiredWriters) {
    const args = mutatingArgs[command] ?? {};
    const effective = resolveEffectiveOwnershipClass(command, args, 'B-fixture', undefined, ownershipContexts[command]);
    assert.equal(commandRequiresAuthoritativeRuntime(command, effective), true, command);
  }
  for (const variant of [
    ['validate', {}],
    ['done_prepare', { storyId: 'B-fixture', dryRun: true }],
    ['plan_skeleton', { storyId: 'B-fixture' }],
    ['evidence_refresh', { storyId: 'B-fixture' }],
    ['live_smoke_transcript', { storyId: 'B-fixture' }],
    ['delivery_context_pack', { storyId: 'B-fixture' }],
    ['usage_sweep', {}],
    ['signature_backfill', {}],
    ['identity_state_migrate', { id: 'B-fixture' }],
    ['reviewer_list', { storyId: 'B-fixture' }],
    ['agent_prompt', { role: 'proof-or-stop-review-quality' }],
    ['certification_window_status', { storyId: 'B-fixture' }],
    ['finding_list', { storyId: 'B-fixture' }],
    ['doctor', {}],
  ]) {
    const storyId = variant[1].storyId ?? null;
    const effective = resolveEffectiveOwnershipClass(variant[0], variant[1], storyId);
    assert.equal(commandRequiresAuthoritativeRuntime(variant[0], effective), false, variant[0]);
  }
});

await check(['runtime'], 'F-010 dangerous Story writers reject a real foreign runtime with zero mutation', () => {
  for (const [command, payload] of [
    ['story_discard', { storyId: 'B-fixture' }],
    ['story_draft_discard', { name: 'missing-draft' }],
    ['done_recover', { storyId: 'B-fixture' }],
  ]) {
    const fixture = createRuntimeFixture();
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, command, payload);
    assert.notEqual(result.status, 0, command);
    assert.match(`${result.stdout}${result.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i, command);
    assertRuntimeFixtureUnchanged(fixture, before);
  }
});

await check(['runtime'], 'F-011 main-shared Story creators reject a real foreign runtime with zero mutation', () => {
  const variants = [
    {
      command: 'story_create',
      payload: {
        name: 'foreign-create-must-stop',
        title: 'Foreign create must stop',
        description: 'A mismatched self-project runtime cannot create a Story envelope.',
        type: 'chore',
        priority: 'high',
        background: validBackground(),
        forceNew: true,
        checklist: [{ title: 'Never persisted', context: 'Runtime authority must reject before Story creation.' }],
      },
    },
    { command: 'story_create_from_repro', payload: {} },
    { command: 'planner_create_story', payload: {} },
    { command: 'planner_run', payload: { request: 'Create one bounded test Story' } },
    { command: 'signature_backfill', payload: { map: 'does-not-exist.json', apply: true } },
    { command: 'identity_state_migrate', payload: { id: 'B-fixture', confirm: true } },
    { command: 'reviewer_list', payload: { storyId: 'B-fixture', forceReviewer: 'quality' } },
    { command: 'agent_prompt', payload: { storyId: 'B-fixture', role: 'proof-or-stop-review-quality', auditExperiment: true, format: 'json' } },
    { command: 'dispatch', payload: { storyId: 'B-fixture', agentType: 'proof-or-stop-review-story-init' } },
    { command: 'certification_window_status', payload: { storyId: 'B-fixture', refresh: true } },
    { command: 'doctor', payload: { repair: true, format: 'json' } },
    {
      command: 'evaluate',
      payload: { storyId: 'B-fixture' },
      prepare(fixture) {
        const configPath = join(fixture.root, 'proof-or-stop.config.json');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        config.cli = { command: 'echo evaluator' };
        config.promptEnvelope = {
          version: 'proof-or-stop.prompt-envelope-rollout.v1',
          roles: { 'proof-or-stop-evaluator': 'full-envelope' },
        };
        writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      },
    },
  ];
  for (const variant of variants) {
    const fixture = createRuntimeFixture();
    variant.prepare?.(fixture);
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, variant.command, variant.payload);
    assert.notEqual(result.status, 0, variant.command);
    assert.match(`${result.stdout}${result.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i, variant.command);
    assertRuntimeFixtureUnchanged(fixture, before);
  }
});

await check(['runtime', 'runtime-topology'], 'CHK-003 every registry-derived story writer rejects a foreign linked-worktree runtime at main root', () => {
  const topology = ensureRuntimeTopologyFixture();
  const storyWriters = Object.entries(COMMAND_POLICIES)
    .filter(([, policy]) => policy.ownershipClass === 'storyScopedMutating')
    .map(([command]) => command);
  assert.ok(storyWriters.length > 0, 'canonical command policy must enumerate Story writers');
  for (const command of storyWriters) assertForeignRuntimeTopology(command, topology);
});

await check(['runtime'], 'CHK-003:happy:1 process/runtime verifiers pin the registry-derived pre-hook choke point', () => {
  for (const script of ['scripts/verify-process-fact-contract.mjs', 'scripts/verify-runtime-fact-contract.mjs']) {
    const result = spawnSync(process.execPath, [join(repoRoot, script), ...(script.includes('process') ? ['--quiet'] : [])], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${script}\n${result.stdout}${result.stderr}`);
  }
});

await check(['runtime'], 'CHK-003 external installed-package consumers remain outside the self-host rejection', () => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-consumer-'));
  try {
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(join(externalRoot, 'package.json'), '{"name":"external-consumer"}\n');
    const decision = classifyRuntimeEntrypointAuthority({
      command: 'checklist_update',
      commandArgs: ['{"storyId":"X","itemId":"CHK-001","status":"done"}'],
      projectRoot: externalRoot,
      invokedEntrypoint: join(packageRoot, 'dist', 'cli.js'),
      loadedCorePackageRoot: packageRoot,
      env: {},
    });
    assert.equal(decision.status, 'pass');
    assert.equal(decision.selfHostWorktree, false);
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

await check(['runtime'], 'CHK-003:edge:0 external consumer public CLI permits normal Story mutation (packed installed canonical package)', () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-packed-consumer-'));
  fixtureRoots.push(consumerRoot);
  initRepo(consumerRoot, false);
  const tarballs = [];
  for (const productRoot of [packageRoot, join(repoRoot, 'packages', 'lab'), join(repoRoot, 'packages', 'utils')]) {
    const pack = spawnSync('npm', ['pack', '--silent', productRoot, '--pack-destination', consumerRoot], {
      cwd: consumerRoot, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    assert.equal(pack.status, 0, `${productRoot}: ${pack.stdout}${pack.stderr}`);
    tarballs.push(join(consumerRoot, pack.stdout.trim().split(/\r?\n/u).at(-1)));
  }
  const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', ...tarballs], {
    cwd: consumerRoot, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  const installedCli = join(consumerRoot, 'node_modules', '@proof-or-stop', 'core', 'dist', 'cli.js');
  const created = runCli(consumerRoot, 'story_create', {
    name: 'packed-consumer-story', title: 'Packed consumer Story',
    description: 'The packed canonical CLI is allowed to write in an unrelated external project.',
    type: 'chore', priority: 'medium', background: validBackground(), forceNew: true,
    checklist: [{ title: 'Observe installed mutation', context: 'The external package must remain usable.' }],
  }, {}, { entrypoint: installedCli });
  assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
  assert.match(created.stdout, /Story B-/);
});

function snapshotTree(root) {
  if (!existsSync(root)) return null;
  const rows = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = path.slice(root.length + 1);
      if (statSync(path).isDirectory()) visit(path);
      else rows.push(`${rel}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  };
  visit(root);
  return rows.join('\n');
}

function snapshotGitMaterial(root) {
  const paths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .sort();
  return paths.map((path) => {
    const absolute = join(root, path);
    try {
      const stat = lstatSync(absolute, { throwIfNoEntry: false });
      if (!stat) return `${path}\0deleted`;
      const bytes = stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute);
      return `${path}\0${stat.isSymbolicLink() ? 'symlink:' : ''}${createHash('sha256').update(bytes).digest('hex')}`;
    } catch (error) {
      if (error.code === 'ENOENT') return `${path}\0deleted`;
      throw error;
    }
  }).join('\n');
}

function snapshotPublicOperationState(root, storyIds = []) {
  const runtimePath = (name) => snapshotTree(join(root, '.proof-or-stop', name));
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    gitIndex: git(root, ['ls-files', '--stage']),
    status: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    gitMaterial: snapshotGitMaterial(root),
    locks: runtimePath('locks'),
    runtime: runtimePath('runtime'),
    storyBytes: Object.fromEntries(storyIds.map((storyId) => [
      storyId,
      snapshotTree(join(root, '.proof-or-stop', 'story', 'actives', storyId)),
    ])),
  };
}

const INERT_PUBLIC_FIXTURE_LOG_SUBTREE = '.remember/logs/autonomous/';

function createPublicOperationClone(prefix, copyFindingTrust = true) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  assert.ok(root !== repoRoot && root !== mainRoot && fixtureRoots.includes(root), 'sparse setup is restricted to a new disposable clone');
  const cloned = spawnSync('git', ['clone', '--shared', '--quiet', '--no-checkout', repoRoot, root], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, `${cloned.stdout}${cloned.stderr}`);
  if (spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: root }).status !== 0) {
    git(root, ['branch', 'main', git(repoRoot, ['rev-parse', 'refs/heads/main'])]);
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const expectedIndex = git(root, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const match = row.match(/^(\d+) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/u);
    assert.ok(match, 'committed fixture tree must have an exact index representation');
    return `${match[1]} ${match[2]} 0\t${match[3]}`;
  });
  // Only inert third-party autonomous logs are not materialized. Keep their
  // complete index entries: every snapshot still checks each absent path, so a
  // later empty file, nonempty file or symlink creation cannot disappear.
  git(root, ['sparse-checkout', 'init', '--no-cone']);
  const sparse = spawnSync('git', ['sparse-checkout', 'set', '--no-cone', '--stdin'], {
    cwd: root, encoding: 'utf8', input: `/*\n!/${INERT_PUBLIC_FIXTURE_LOG_SUBTREE}\n`,
  });
  assert.equal(sparse.status, 0, `${sparse.stdout}${sparse.stderr}`);
  git(root, ['checkout', '--quiet', 'HEAD']);
  assert.deepEqual(git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean), expectedIndex,
    'sparse fixture must retain every indexed path, mode and blob');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'sparse setup changed fixture HEAD');
  assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), refs, 'sparse setup changed fixture refs');
  for (const row of expectedIndex) {
    const path = row.slice(row.indexOf('\t') + 1);
    const present = lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined;
    assert.equal(present, !path.startsWith(INERT_PUBLIC_FIXTURE_LOG_SUBTREE), `unexpected fixture materialization: ${path}`);
  }
  cpSync(join(packageRoot, 'dist'), join(root, 'packages', 'main', 'dist'), { recursive: true });
  for (const path of ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.paths).filter(path => path.scope === 'project')) {
    cpSync(join(repoRoot, path.path), join(root, path.path));
  }
  // The registry loads template files at runtime: exercise the same candidate
  // as the copied build, including uncommitted merge-resolution templates.
  const fixtureTemplates = join(root, 'packages', 'main', 'templates');
  rmSync(fixtureTemplates, { recursive: true, force: true });
  cpSync(join(packageRoot, 'templates'), fixtureTemplates, { recursive: true });
  for (const packageName of ['utils', 'lab']) {
    const built = join(repoRoot, 'packages', packageName, 'dist');
    if (existsSync(built)) cpSync(built, join(root, 'packages', packageName, 'dist'), { recursive: true });
  }
  symlinkSync(join(mainRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  if (copyFindingTrust) installFixtureFindingLedgerPrivateKey(root); return root;
}

function activeIdentityBoundaryOperation(boundaryId, storyId) {
  const healthyWindow = (id) => ({
    id,
    criticalHighRecall: 1,
    overallRecall: 1,
    findingEquivalent: true,
    promptByteReduction: 0.95,
    p95LatencyMs: 10,
    readMismatchCount: 0,
    unjustifiedFullScanCount: 0,
  });
  const operations = {
    'candidate-spec-routing': ['candidate_spec_rollout_check', {
      from: 'shadow', to: 'warn', windows: [healthyWindow('f050-a'), healthyWindow('f050-b')], json: true,
    }],
    'certification-window': ['certification_window_status', { storyId }],
    'review-incremental-context': ['review_incremental_context', {
      storyId, role: 'proof-or-stop-review-quality', json: true,
    }],
    'review-inventory-epoch': ['certification_window_status', { storyId }],
    'learning-source-lineage': ['source_lineage_audit', { domain: 'learning', json: true }],
    'playbook-runtime-memory': ['playbook_runtime_health', { json: true }],
    'lifecycle-control': ['global_control_status', { storyIds: [storyId], json: true }],
    'milestone-status': ['milestone_status', { storyId, json: true }],
    'process-fact-registry': ['session_brief', {}],
    'prompt-runtime': ['agent_prompt', { role: 'proof-or-stop-review-quality' }],
    'claim-admissibility-pack': ['pinn_claim_check', { fixture: 'complete', json: true }],
    'release-ledgers': ['artifact_release_list', { format: 'json' }],
  };
  const operation = operations[boundaryId];
  assert.ok(operation, `missing public operation for active identity boundary ${boundaryId}`);
  return operation;
}

let publicIdentityOperationFixture;
function ensurePublicIdentityOperationFixture() {
  if (publicIdentityOperationFixture) return publicIdentityOperationFixture;
  const root = createPublicOperationClone('proof-or-stop-b49df-every-active-boundary-');
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot, 'canonical ledger setup is restricted to the generated clone');
  // Historical release rows remain rejected. Canonical list controls use valid
  // empty ledgers in this disposable clone, never reinterpret old audit data.
  for (const path of [artifactReleaseLedgerPath(root), capabilityReleaseLedgerPath(root)]) writeFileSync(path, '');
  const externalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-process-fact-reader-'));
  fixtureRoots.push(externalRoot);
  initRepo(externalRoot, false);
  publicIdentityOperationFixture = { root, externalRoot, entrypoint: join(root, 'packages', 'main', 'dist', 'cli.js') };
  return publicIdentityOperationFixture;
}

function assertCanonicalPublicIdentityOperations(fixture, label) {
  const startedAt = Date.now();
  const operations = new Map();
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    const [defaultCommand, payload] = activeIdentityBoundaryOperation(boundary.id, 'B-49df');
    const root = boundary.id === 'process-fact-registry' ? fixture.externalRoot : fixture.root;
    for (const site of boundary.retiredIdentityCases) {
      const command = site.command ?? defaultCommand;
      operations.set(JSON.stringify([root, command, payload]), { root, command, payload });
    }
  }
  const failed = [];
  for (const { root, command, payload } of operations.values()) {
    const commandStartedAt = Date.now();
    const result = runCli(root, command, payload, {}, { entrypoint: fixture.entrypoint });
    try {
      assert.equal(result.status, 0, `${command}: status=${result.status} error=${result.error?.code ?? 'none'}\n${result.stdout.slice(-4000)}${result.stderr.slice(-4000)}`);
      assertCanonicalOperationResponse(command, payload, root, result.stdout);
      assert.throws(() => assertCanonicalOperationResponse(command, payload, root, '{"error":"structured failure","ok":false}'), undefined, `${command}: structured failure must not satisfy a canonical control`);
      process.stdout.write(`PASS canonical public operation ${label}: ${command} elapsedMs=${Date.now() - commandStartedAt}\n`);
    } catch (error) { failed.push(`${command}: ${error.message}`); }
  }
  assert.deepEqual(failed, [], `canonical public operations must succeed before identity mutations (${label})`);
  process.stdout.write(`PASS canonical public operation timing ${label}: count=${operations.size} elapsedMs=${Date.now() - startedAt}\n`);
  return operations.size;
}

function assertCanonicalOperationResponse(command, payload, root, stdout) {
  if (command === 'certification_window_status') {
    // This is a status query, not a claim of certification admission. A missing
    // window is a normal, typed absence projection for the DEV fixture.
    assert.match(stdout, /^Certification window: (?:none|\S+)$/m);
    assert.equal((stdout.match(/^State: /gm) ?? []).length, 1);
    assert.match(stdout, /^State: (?:ADMITTED|RUNNING|FINALIZED|BLOCKED|INVALIDATED|CANCELLED)$/m);
    assert.match(stdout, new RegExp(`^Next: .*${payload.storyId}`, 'm'));
    assert.doesNotMatch(stdout, /(?:Error:|failed:|TAMPERED)/i);
    return;
  }
  if (command === 'session_brief') {
    assert.match(stdout, /^# proof-or-stop session brief$/m);
    assert.match(stdout, /\*\*No active story\*\* — no stories yet\./);
    assert.doesNotMatch(stdout, /(?:Error:|session_brief failed:)/);
    return;
  }
  if (command === 'agent_prompt') {
    assert.ok(stdout.includes(payload.role), 'canonical role bootstrap must identify the requested role');
    assert.match(stdout, /proof-or-stop review_run_start/);
    assert.doesNotMatch(stdout, /(?:Error:|unknown role|agent_prompt failed:)/);
    return;
  }
  const value = JSON.parse(stdout);
  assert.ok(value && typeof value === 'object', `${command}: expected a structured handler response`);
  assert.equal(Object.hasOwn(value, 'error'), false, `${command}: structured error is not success`);
  assert.notEqual(value.ok, false, `${command}: failed envelope is not success`);
  switch (command) {
    case 'candidate_spec_rollout_check':
      assert.equal(value.allowed, true);
      assert.deepEqual(value.blockers, []);
      assert.deepEqual(value.evaluatedWindowIds, payload.windows.map(window => window.id));
      break;
    case 'review_incremental_context':
      assert.equal(value.role, payload.role);
      assert.equal(typeof value.isFirstPass, 'boolean');
      assert.equal(typeof value.scopeChanged, 'boolean');
      assert.ok(Array.isArray(value.changedFiles));
      assert.ok(value.priorHeadHash === null || /^[a-f0-9]{40}$/u.test(value.priorHeadHash));
      break;
    case 'source_lineage_audit':
      assert.equal(value.schemaVersion, 'proof-or-stop.source-lineage-audit.v1');
      assert.equal(value.domain, 'learning');
      assert.equal(value.canonicalSourceKeyVersion, 'proof-or-stop.learning-source-key.v1');
      assert.ok(Array.isArray(value.records));
      assert.equal(value.sourceRecordCount, value.records.length);
      break;
    case 'playbook_runtime_health':
      assert.equal(value.schemaVersion, 'proof-or-stop.playbook-runtime-health.v1');
      assert.equal(value.status, 'pass');
      assert.ok(Array.isArray(value.checks) && value.checks.length > 0);
      assert.ok(value.checks.every(check => check.status === 'pass'));
      assert.equal(value.authority, 'non_authoritative');
      assert.equal(value.gateEvidence, false);
      break;
    case 'global_control_status':
      assert.equal(value.schemaVersion, 'proof-or-stop.global_control_status.v1');
      assert.equal(value.readOnly, true);
      assert.equal(value.projectRoot, root);
      assert.ok(Array.isArray(value.stories));
      assert.ok(value.stories.some(story => story.storyId === 'B-49df'));
      assert.ok(value.project && value.runtimeClosure && value.queueGovernance);
      break;
    case 'milestone_status':
      assert.equal(value.schemaVersion, 'proof-or-stop.milestone_status.v1');
      assert.equal(value.storyId, payload.storyId);
      assert.ok(Array.isArray(value.milestones) && Array.isArray(value.risks) && Array.isArray(value.nextActions));
      assert.ok(value.ledger && value.mode && value.groups);
      break;
    case 'pinn_claim_check':
      assert.equal(value.schemaVersion, 'proof-or-stop.pinn_claim_admissibility.v1');
      assert.equal(value.allowed, true);
      assert.equal(value.nextAction, 'advance');
      assert.deepEqual(value.reasons, []);
      assert.deepEqual(value.missingAdapters, []);
      assert.equal(value.externalCompletionClaim, false);
      assert.equal(value.terminalCompletionClaim, false);
      break;
    case 'artifact_release_list':
    case 'capability_release_list':
      assert.deepEqual(value, [], `${command}: the canonical fresh ledger must produce an empty list`);
      break;
    default: throw new Error(`missing canonical handler response contract: ${command}`);
  }
}

let runtimeFixture = null;

function createRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-self-'));
  fixtureRoots.push(root);
  initRepo(root, true);
  const store = new StoryStore(root);
  const storyId = 'B-fixture';
  store.writeStory(storyId, {
    storyId, name: 'foreign-runtime-fixture', title: 'Before', description: 'Before foreign runtime attempt.',
    type: 'chore', phase: 'INIT', priority: 'high', createdAt: NOW, startedAt: NOW, endedAt: null,
    events: [{ phase: 'INIT', action: 'seed', timestamp: NOW }],
  });
  git(root, ['add', '-f', '.proof-or-stop']);
  git(root, ['commit', '-m', 'seed Story']);
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  const eventsPath = join(storyDir, 'process-events.jsonl');
  const indexPath = join(storyDir, 'index.json');
  return { root, storyId, storyDir, eventsPath, indexPath };
}

function ensureRuntimeFixture() {
  runtimeFixture ??= createRuntimeFixture();
  return runtimeFixture;
}

function snapshotRuntimeState(fixture) {
  return {
    story: snapshotTree(fixture.storyDir),
    events: existsSync(fixture.eventsPath) ? readFileSync(fixture.eventsPath) : null,
    storyIndex: readFileSync(fixture.indexPath),
    worktrees: git(fixture.root, ['worktree', 'list', '--porcelain']),
    refs: git(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    head: git(fixture.root, ['rev-parse', 'HEAD']),
    gitIndex: git(fixture.root, ['ls-files', '--stage']),
    status: git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
    repoMaterial: snapshotGitMaterial(fixture.root),
  };
}

function assertRuntimeFixtureUnchanged(fixture, before) {
  assert.deepEqual(snapshotRuntimeState(fixture), before, 'foreign runtime changed Story/repository/Git state');
}

function assertRuntimeAuthoritativeStateUnchanged(fixture, before) {
  const after = snapshotRuntimeState(fixture);
  for (const key of ['story', 'events', 'storyIndex', 'worktrees', 'refs', 'head', 'gitIndex']) {
    assert.deepEqual(after[key], before[key], `read-only diagnostic changed authoritative state: ${key}`);
  }
}

function snapshotIdentityAuthorityState(fixture) {
  const readOptional = (name) => {
    const path = join(fixture.storyDir, name);
    return existsSync(path) ? readFileSync(path) : null;
  };
  return {
    storyIndex: readFileSync(fixture.indexPath),
    initCheck: readOptional('init-check.json'),
    promptEnvelopes: readOptional('prompt-envelopes.json'),
    reviewRuns: readOptional('review-runs.json'),
    reviewPasses: readOptional('review-passes.json'),
    refs: git(fixture.root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    head: git(fixture.root, ['rev-parse', 'HEAD']),
    gitIndex: git(fixture.root, ['ls-files', '--stage']),
  };
}

function assertIdentityAuthorityStateUnchanged(fixture, before) {
  assert.deepEqual(
    snapshotIdentityAuthorityState(fixture),
    before,
    'rejected identity operation changed authoritative Story identity evidence or Git state',
  );
}

await check(['runtime'], 'CHK-003:edge:1 mismatched runtime keeps read-only diagnostics available', () => {
  const fixture = ensureRuntimeFixture();
  const before = snapshotRuntimeState(fixture);
  const result = runCli(fixture.root, 'story_get', { storyId: fixture.storyId, slim: true });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /foreign-runtime-fixture|"storyId"\s*:\s*"B-fixture"/);
  assertRuntimeFixtureUnchanged(fixture, before);
});

await check(['runtime'], 'F-009 argument-aware dynamic read-only variants bypass only runtime write admission', () => {
  const fixture = ensureRuntimeFixture();
  const signatureMapPath = join(fixture.root, 'signature-map.json');
  writeFileSync(signatureMapPath, '{}\n');
  const variants = [
    { command: 'validate', payload: {} },
    { command: 'done_prepare', payload: { storyId: fixture.storyId, dryRun: true } },
    { command: 'plan_skeleton', payload: { storyId: fixture.storyId } },
    { command: 'evidence_refresh', payload: { storyId: fixture.storyId } },
    { command: 'live_smoke_transcript', payload: { storyId: fixture.storyId } },
    { command: 'delivery_context_pack', payload: { storyId: fixture.storyId } },
    { command: 'usage_sweep', payload: {} },
    { command: 'signature_backfill', payload: { map: signatureMapPath } },
    { command: 'identity_state_migrate', payload: { id: fixture.storyId } },
    { command: 'reviewer_list', payload: { storyId: fixture.storyId } },
    { command: 'agent_prompt', payload: { role: 'proof-or-stop-review-quality' } },
    { command: 'evaluate', payload: { storyId: fixture.storyId }, ownershipContext: { config: {} } },
    { command: 'doctor', payload: {}, mayDiagnoseForeignRuntime: true },
  ];
  for (const variant of variants) {
    const storyId = variant.payload.storyId ?? null;
    assert.equal(resolveEffectiveOwnershipClass(variant.command, variant.payload, storyId, undefined, variant.ownershipContext), 'readOnly', variant.command);
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, variant.command, variant.payload);
    if (variant.mayDiagnoseForeignRuntime) {
      assert.equal(result.status, 0, `${variant.command}: ${result.stdout}${result.stderr}`);
    } else {
      assert.doesNotMatch(
        `${result.stdout}${result.stderr}`,
        /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i,
        variant.command,
      );
    }
    assertRuntimeAuthoritativeStateUnchanged(fixture, before);
  }
});

await check(['runtime'], 'F-016 active-worktree reviewer role-only agent_prompt remains read-only', () => {
  const statusBefore = git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const result = runCli(
    repoRoot,
    'agent_prompt',
    { role: 'proof-or-stop-review-quality' },
    { PROOF_OR_STOP_REVIEWER_READONLY: '1', PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality' },
    { cwd: repoRoot },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not allowed in read-only reviewer mode/i);
  assert.equal(git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']), statusBefore);
});

await check(['runtime'], 'F-018 active-worktree reviewer read paths remain available', () => {
  for (const [command, payload] of [
    ['finding_list', { storyId: 'B-49df' }],
    ['certification_window_status', { storyId: 'B-49df' }],
  ]) {
    const result = runCli(
      repoRoot,
      command,
      payload,
      { PROOF_OR_STOP_REVIEWER_READONLY: '1', PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality' },
      { cwd: repoRoot },
    );
    assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not allowed in read-only reviewer mode/i, command);
  }
});

await check(['inventory'], 'F-018 standard guidance assigns dispatch persistence to the Story owner', () => {
  const storyCreateSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/story-create.ts'), 'utf8');
  const transitionSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/transition-effects.ts'), 'utf8');
  const reviewRunSource = readFileSync(join(repoRoot, 'packages/main/src/handlers/review-run.ts'), 'utf8');
  const machineSource = readFileSync(join(repoRoot, 'packages/main/src/core/machine.ts'), 'utf8');
  assert.doesNotMatch(storyCreateSource, /Agent\(\{[^\n]*run proof-or-stop dispatch/i);
  assert.doesNotMatch(transitionSource, /Agent\(\{[^\n]*Run proof-or-stop dispatch/i);
  assert.doesNotMatch(machineSource, /Agent\(\{[^\n]*prompt:[^\n]*proof-or-stop dispatch/i);
  assert.match(storyCreateSource, /Story owner[^\n]*proof-or-stop dispatch/i);
  assert.match(transitionSource, /Story owner[^\n]*proof-or-stop dispatch/i);
  assert.match(reviewRunSource, /ask the Story owner to rerun proof-or-stop dispatch/i);
  assert.ok(
    (machineSource.match(/Story owner[^\n]*proof-or-stop dispatch/gi) ?? []).length >= 3,
    'both machine INIT guidance paths must assign every reviewer dispatch to the Story owner',
  );
  assert.ok(
    (machineSource.match(/independent[^\n]*review_run_start/gi) ?? []).length >= 2,
    'both machine INIT guidance paths must keep reviewer startup independent from owner dispatch',
  );
});

const retiredProtocolPrefix = ['proof', 'bound.'].join('');
const retiredProtocolStem = ['proof', 'bound'].join('');
const retiredBrandStem = ['lat', 'tice'].join('');
const retiredIdentityPattern = new RegExp(
  `${retiredProtocolStem}[.:\\-][a-z0-9._:-]+|${retiredBrandStem}[.:\\-][a-z0-9._:-]+`,
  'gi',
);
const retiredReviewRunSalt = ['lat', 'tice-review-run-integrity-v1'].join('');
const currentDigestPrefix = 'proof-or-stop.digest.v1';
const currentReviewRunSalt = 'proof-or-stop-review-run-integrity-v1';
const IDENTITY_CUTOVER_REQUIRED_PATHS = Object.freeze([
  'docs/requirements/baselines/role-prompt-measurement-baseline.json',
  'packages/main/src/core/artifact-release.ts',
  'packages/main/src/core/candidate-spec-routing.ts',
  'packages/main/src/core/capability-release.ts',
  'packages/main/src/core/certification-window.ts',
  'packages/main/src/core/config.ts',
  'packages/main/src/core/evidence-freshness.ts',
  'packages/main/src/core/experience-layer-types.ts',
  'packages/main/src/core/impact-classification-policy.ts',
  'packages/main/src/core/learning-store.ts',
  'packages/main/src/core/lifecycle-control/control-status.ts',
  'packages/main/src/core/lifecycle-control/queue/index.ts',
  'packages/main/src/core/milestone-status.ts',
  'packages/main/src/core/playbook-runtime-baseline.ts',
  'packages/main/src/core/playbook-runtime-memory-cache.ts',
  'packages/main/src/core/playbook-runtime-memory-index.ts',
  'packages/main/src/core/playbook-runtime-memory.ts',
  'packages/main/src/core/playbook-seed.ts',
  'packages/main/src/core/process-fact-registry.ts',
  'packages/main/src/core/prompt-budget.ts',
  'packages/main/src/core/prompt-contracts.ts',
  'packages/main/src/core/prompt-envelope.ts',
  'packages/main/src/core/prompt-measurement.ts',
  'packages/main/src/core/prompt-registry.ts',
  'packages/main/src/core/prompt-role-contract-registry.ts',
  'packages/main/src/core/review-incremental-context.ts',
  'packages/main/src/core/review-inventory-epoch.ts',
  'packages/main/src/core/review-run.ts',
  'packages/main/src/core/source-lineage-audit.ts',
  'packages/main/src/handlers/agent-prompt.ts',
  'packages/main/src/handlers/candidate-spec-routing.ts',
  'packages/main/src/handlers/done-effects.ts',
  'packages/main/src/handlers/playbook-runtime-memory.ts',
  'packages/main/src/handlers/playbook.ts',
  'packages/main/src/handlers/review-run.ts',
  'packages/main/src/handlers/story-dispatch.ts',
  'packages/main/src/core/claim-admissibility/pack-framework.ts',
  'packages/main/src/cli-init.ts',
  'packages/main/templates/agents/proof-or-stop-evaluator.md',
  'packages/main/templates/agents/proof-or-stop-implementer.md',
  'packages/main/templates/agents/proof-or-stop-review-behavior.md',
  'packages/main/templates/agents/proof-or-stop-review-concept.md',
  'packages/main/templates/agents/proof-or-stop-review-delivery.md',
  'packages/main/templates/agents/proof-or-stop-review-docs.md',
  'packages/main/templates/agents/proof-or-stop-review-quality.md',
  'packages/main/templates/agents/proof-or-stop-review-scope-plan.md',
  'packages/main/templates/agents/proof-or-stop-review-story-init.md',
  'packages/main/templates/agents/proof-or-stop-review-test-coverage.md',
  'scripts/verify-proof-or-stop-identity-cutover.mjs',
  'proof-or-stop.config.json',
]);

// These exact source rows preserve
// hash-verified, byte-stable reads of the three signed pre-cutover scope
// artifacts. They are not writer values or general protocol aliases.
const HISTORICAL_SCOPE_READER_IDENTITIES = Object.freeze([
  ['packages/main/src/core/process-fact-registry.ts', 'lattice.execution_boundary.v1', 1],
  ['packages/main/src/core/process-fact-registry.ts', 'lattice.scope_freeze_check.v1', 1],
  ['packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_boundary.v1', 1],
  ['packages/main/src/core/scope-anti-expansion.ts', 'lattice.execution_boundary.v1', 1],
  ['packages/main/src/core/scope-anti-expansion.ts', 'lattice.scope_freeze_check.v1', 1],
  ['packages/main/src/core/types.ts', 'lattice.scope_boundary.v1', 1],
  ['packages/main/src/core/types.ts', 'lattice.execution_boundary.v1', 1],
  ['packages/main/src/core/types.ts', 'lattice.scope_freeze_check.v1', 1],
]);

function collectIdentityCutoverProductionPaths() {
  const paths = new Set(IDENTITY_CUTOVER_REQUIRED_PATHS);
  const visit = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const absolute = join(root, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|md|json)$/.test(entry.name)) paths.add(relative(repoRoot, absolute));
    }
  };
  for (const root of [
    'packages/main/src',
    'packages/main/templates/agents',
  ]) visit(join(repoRoot, root));
  return [...paths].sort();
}

function digestWithIdentityPrefix(prefix, domain, value) {
  return createHash('sha256')
    .update(`${prefix}\0${domain}\0${promptContracts.canonicalJsonStringify(value)}`)
    .digest('hex');
}

function reviewRunHashWithSalt(run, salt) {
  const parts = [
    run.storyId, run.reviewRunId, run.agent, run.lane, run.reviewRound, run.startedAt,
    run.headHash, run.materialHash, run.promptHash,
  ];
  if (run.storyFilesHash) parts.push(run.storyFilesHash);
  if (run.scopeBinding?.bindingHash) parts.push(run.scopeBinding.bindingHash);
  if (run.workspaceBinding?.bindingHash) parts.push(run.workspaceBinding.bindingHash);
  if (run.envelopeId) parts.push(run.envelopeId);
  if (run.reviewerEscalationReason) parts.push(run.reviewerEscalationReason);
  parts.push(salt);
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

const PROMPT_ENVELOPE_IDENTITY_VALUE_BY_PATH = Object.freeze({
  schemaVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.promptEnvelope,
  runtimeContractVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.runtimeContract,
  roleContractVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.roleContract,
  assemblerVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.assembler,
  dispatchProtocolVersion: promptContracts.CURRENT_PROMPT_IDENTITIES.dispatchProtocol,
});

const RETIRED_PROMPT_ENVELOPE_IDENTITY_BOUNDARIES = Object.freeze(
  promptContracts.PROMPT_ENVELOPE_ACTIVE_IDENTITY_PATHS.map((path) => Object.freeze({
    id: `prompt-envelope.${path}`,
    class: 'persisted-reader-verifier',
    path,
    canonical: PROMPT_ENVELOPE_IDENTITY_VALUE_BY_PATH[path],
    retired: PROMPT_ENVELOPE_IDENTITY_VALUE_BY_PATH[path].replace(/^proof-or-stop\./, retiredProtocolPrefix),
    publicOperation: 'review_pass_set',
  })),
);

function identityLookalikes(canonical) {
  const versionMatch = canonical.match(/^(.*?)(v\d+)$/);
  assert.ok(versionMatch, `identity requires terminal version: ${canonical}`);
  return Object.freeze([
    Object.freeze({ kind: 'trailing-space', value: `${canonical} ` }),
    Object.freeze({ kind: 'case', value: canonical.replace('proof-or-stop', 'Proof-or-stop') }),
    Object.freeze({ kind: 'version', value: `${versionMatch[1]}v0` }),
    Object.freeze({ kind: 'suffix', value: `${canonical}.1` }),
    Object.freeze({ kind: 'unicode-confusable', value: canonical.replace(/v\d+$/, 'v１') }),
  ]);
}

function assertReviewPassRejectsEnvelopeMutation({ fixture, boundaryRun, canonicalBytes, label, mutate }) {
  const envelopePath = join(fixture.storyDir, 'prompt-envelopes.json');
  const persisted = JSON.parse(canonicalBytes.toString('utf8'));
  const envelopes = persisted.envelopes.filter((candidate) => candidate.roleId === 'proof-or-stop-review-quality');
  assert.ok(envelopes.length > 0, `${label}: expected at least one persisted quality envelope`);
  for (const envelope of envelopes) mutate(envelope);
  writeFileSync(envelopePath, `${JSON.stringify(persisted, null, 2)}\n`);
  const before = snapshotIdentityAuthorityState(fixture);
  const rejected = runCli(fixture.root, 'review_pass_set', {
    storyId: fixture.storyId,
    agent: 'proof-or-stop-review-quality',
    reviewRunId: boundaryRun.reviewRunId,
    note: `Reject ${label} without persisting reviewer evidence.`,
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(rejected.status, 0, `${label}: ${rejected.stdout}${rejected.stderr}`);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /invalid|unsupported|tampered|trusted|envelope|identity|binding/i, label);
  assertIdentityAuthorityStateUnchanged(fixture, before);
  writeFileSync(envelopePath, canonicalBytes);
}

function assertReviewPassRejectsRunMutation({ fixture, boundaryRun, canonicalBytes, label, mutate }) {
  const reviewRunsPath = join(fixture.storyDir, 'review-runs.json');
  const persisted = JSON.parse(canonicalBytes.toString('utf8'));
  const run = persisted.runs.find((candidate) => candidate.reviewRunId === boundaryRun.reviewRunId);
  assert.ok(run, `${label}: current public ReviewRun missing`);
  mutate(run);
  writeFileSync(reviewRunsPath, `${JSON.stringify(persisted, null, 2)}\n`);
  const before = snapshotIdentityAuthorityState(fixture);
  const rejected = runCli(fixture.root, 'review_pass_set', {
    storyId: fixture.storyId,
    agent: 'proof-or-stop-review-quality',
    reviewRunId: run.reviewRunId,
    note: `Reject ${label} without persisting reviewer evidence.`,
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(rejected.status, 0, `${label}: ${rejected.stdout}${rejected.stderr}`);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /invalid|signature|tampered|review run|identity|binding|prompt/i, label);
  assertIdentityAuthorityStateUnchanged(fixture, before);
  writeFileSync(reviewRunsPath, canonicalBytes);
}

function identityCutoverSourceMap(paths = collectIdentityCutoverProductionPaths()) {
  return new Map(paths.map((path) => [path, readFileSync(join(repoRoot, path), 'utf8')]));
}

// Cache only facts derived from an exact primitive source string. Each path has
// at most its current bytes; removed paths and no-longer-requested token facts
// are evicted. No allowlist membership, witness comparison or verdict is cached.
function createIdentityTextFactsCache() {
  const entries = new Map();
  let analyses = 0;
  let tokenAnalyses = 0;
  let requestedTokens = new Map();
  return {
    prepare(sourceMap, rows = []) {
      for (const path of entries.keys()) if (!sourceMap.has(path)) entries.delete(path);
      requestedTokens = new Map();
      for (const row of rows) {
        const tokens = requestedTokens.get(row.path) ?? new Set();
        tokens.add(row.token);
        requestedTokens.set(row.path, tokens);
      }
      for (const [path, entry] of entries) {
        for (const token of entry.tokens.keys()) {
          if (!requestedTokens.get(path)?.has(token)) entry.tokens.delete(token);
        }
      }
    },
    get(path, source) {
      assert.equal(typeof source, 'string', 'identity facts require exact primitive source text');
      let entry = entries.get(path);
      if (!entry || entry.source !== source) {
        analyses++;
        const lines = Object.freeze(source.split(/\r?\n/));
        const hits = [];
        let line = 1;
        let cursor = 0;
        for (const match of source.matchAll(new RegExp(retiredIdentityPattern.source, retiredIdentityPattern.flags))) {
          let newline;
          while ((newline = source.indexOf('\n', cursor)) !== -1 && newline < match.index) {
            line++;
            cursor = newline + 1;
          }
          hits.push(Object.freeze({ path, line, token: match[0] }));
        }
        entry = { source, tokens: new Map(), facts: Object.freeze({
          lines,
          hits: Object.freeze(hits),
          sha256: createHash('sha256').update(source).digest('hex'),
        }) };
        entries.set(path, entry);
      }
      return entry.facts;
    },
    token(path, source, token) {
      const facts = this.get(path, source);
      const entry = entries.get(path);
      if (entry.tokens.has(token)) return entry.tokens.get(token);
      tokenAnalyses++;
      const result = Object.freeze({
        count: source.split(token).length - 1,
        contextSha256: createHash('sha256').update(facts.lines.filter(line => line.includes(token)).join('\n')).digest('hex'),
      });
      if (requestedTokens.get(path)?.has(token)) entry.tokens.set(token, result);
      return result;
    },
    stats() {
      return { analyses, tokenAnalyses, entries: entries.size,
        tokens: [...entries.values()].reduce((sum, entry) => sum + entry.tokens.size, 0) };
    },
  };
}

const identityTextFactsCache = createIdentityTextFactsCache();

function retiredProtocolHits(sourceMap, cache = identityTextFactsCache) {
  return [...sourceMap].flatMap(([path, source]) => cache.get(path, source).hits);
}

await check(['identity-cutover'], 'runtime tracer preserves exact observations without linear membership scans', () => {
  const result = spawnSync(process.execPath, [join(distRoot, 'tasks', 'validation-runtime-tracer-transparency-smoke.js')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /validation runtime tracer promisify transparency smoke PASS/);
});

function assertIdentityCutoverInventoryTotal(sourceMap, { reviewed = identityCutoverReviewedContexts(), cache = identityTextFactsCache } = {}) {
  const rows = reviewed.rows.filter(row => sourceMap.has(row.path));
  cache.prepare(sourceMap, rows);
  for (const requiredPath of IDENTITY_CUTOVER_REQUIRED_PATHS) {
    assert.equal(sourceMap.has(requiredPath), true, `identity inventory missing required path ${requiredPath}`);
  }
  assert.ok(sourceMap.size > IDENTITY_CUTOVER_REQUIRED_PATHS.length, 'identity inventory must recursively discover active source');
  const retiredHits = retiredProtocolHits(sourceMap, cache);
  for (const [path, token, expectedOccurrences] of HISTORICAL_SCOPE_READER_IDENTITIES) {
    assert.equal(
      retiredHits.filter((hit) => hit.path === path && hit.token === token).length,
      expectedOccurrences,
      `historical scope reader identity row drifted: ${path}:${token}`,
    );
  }
  const allowed = new Set(HISTORICAL_SCOPE_READER_IDENTITIES.map(([path, token]) => `${path}\0${token}`));
  // Share the scanner's independently reviewed denial/migration inventory, but
  // check it against THIS map, including synthetic mutations, not disk alone.
  // Exact full-witness hashes bind downstream rejection assertions separately
  // from the token lines. Neither kind of pin exempts the containing file.
  for (const row of rows) {
    const source = sourceMap.get(row.path);
    const facts = cache.token(row.path, source, row.token);
    assert.equal(facts.count, row.expectedOccurrences, `retired protocol identity exact count drift: ${row.path}:${row.id ?? row.token}`);
    assert.equal(facts.contextSha256, row.contextSha256, `retired protocol identity exact context drift: ${row.path}:${row.id ?? row.token}`);
  }
  for (const witness of reviewed.witnesses.filter(row => sourceMap.has(row.path))) {
    assert.equal(cache.get(witness.path, sourceMap.get(witness.path)).sha256, witness.sha256, `retired protocol identity witness integrity drift: ${witness.path}`);
  }
  // The verifier's retired-protocol role/mutation literals occur only in reviewed
  // data rows. Pin those complete lines; an added acceptance branch, duplicate,
  // altered row or relocated literal must fail, even in the verifier itself.
  const verifierPath = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
  const verifierLines = cache.get(verifierPath, sourceMap.get(verifierPath)).lines.filter(line => new RegExp(`${retiredProtocolStem}[.:\\-][a-z0-9._:-]+`, 'i').test(line));
  assert.equal(verifierLines.length, 118, 'retired protocol identity verifier data row count drift');
  assert.equal(createHash('sha256').update(verifierLines.join('\n')).digest('hex'), '148250673b2dfdb04602ec125ba4c94bf5da5e78ba609219a05a590a294a1fea', 'retired protocol identity verifier data context drift');
  assert.deepEqual(
    retiredHits.filter((hit) => {
      if (allowed.has(`${hit.path}\0${hit.token}`)) return false;
      const line = cache.get(hit.path, sourceMap.get(hit.path)).lines[hit.line - 1];
      // One sentence-ending period is prose punctuation only after this exact
      // row's count/context and source witness have passed above. Keep raw hits
      // intact; this does not normalize a runtime schema or any other suffix.
      if (rows.some(row => row.path === hit.path
        && (row.token.includes(hit.token) || hit.token === `${row.token}.`)
        && line.includes(row.token))) return false;
      if (hit.path === verifierPath && verifierLines.includes(line)) return false;
      // The verifier owns exact frozen retired-brand provenance tables. It is part of
      // this inventory specifically so active proofbound protocol literals or
      // acceptance branches cannot hide behind that historical responsibility.
      if (hit.path === 'scripts/verify-proof-or-stop-identity-cutover.mjs'
        && !hit.token.toLowerCase().startsWith(retiredProtocolStem)) return false;
      return true;
    }),
    [],
    'active production/config/current-baseline source contains retired protocol identity',
  );
  assert.match(sourceMap.get('packages/main/src/core/prompt-contracts.ts'), /proof-or-stop\.digest\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/review-run.ts'), /proof-or-stop-review-run-integrity-v1/);
  assert.match(sourceMap.get('proof-or-stop.config.json'), /proof-or-stop\.prompt-envelope-rollout\.v1/);
  assert.match(sourceMap.get('docs/requirements/baselines/role-prompt-measurement-baseline.json'), /proof-or-stop\.prompt-measurement\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/prompt-registry.ts'), /proof-or-stop\.prompt-registry\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/claim-admissibility/pack-framework.ts'), /proof-or-stop\.claim_admissibility_pack\.v1/);
  assert.match(sourceMap.get('packages/main/src/core/claim-admissibility/pack-framework.ts'), /domain: 'proof-or-stop-code-runtime'/);
  assert.match(sourceMap.get('scripts/verify-proof-or-stop-identity-cutover.mjs'), /proof-or-stop\.artifact-release\.v1/);
  assert.match(sourceMap.get('scripts/verify-proof-or-stop-identity-cutover.mjs'), /proof-or-stop\.product-capability-release\.v1/);
  assert.match(
    sourceMap.get('packages/main/src/core/process-fact-registry.ts'),
    /Fresh rows carry exact proof-or-stop\.\* Prompt identities; retired-family rows are inert and rejected by active readers/,
  );
}

let identityCutoverFixture = null;

await check(['identity-cutover', 'identity-inventory', 'identity-cache'], 'identity text-fact cache is byte-exact bounded and equivalent to uncached text analysis', () => {
  const cache = createIdentityTextFactsCache();
  const token = `${retiredProtocolPrefix}cache-control.v1`;
  const original = `Unicode Ω\r\n${token} ${token}\nlast ${token}\r\n`;
  const sources = new Map([['a.ts', original], ['b.ts', 'canonical only\n']]);
  const rows = [{ path: 'a.ts', token }];
  const uncachedHits = (path, source) => [...source.matchAll(new RegExp(retiredIdentityPattern.source, retiredIdentityPattern.flags))]
    .map(match => ({ path, line: source.slice(0, match.index).split('\n').length, token: match[0] }));
  const assertReference = () => {
    cache.prepare(sources, rows);
    for (const [path, source] of sources) {
      assert.deepEqual(cache.get(path, source), {
        lines: source.split(/\r?\n/), hits: uncachedHits(path, source),
        sha256: createHash('sha256').update(source).digest('hex'),
      });
    }
    if (sources.has('a.ts')) {
      const source = sources.get('a.ts');
      assert.deepEqual(cache.token('a.ts', source, token), {
        count: source.split(token).length - 1,
        contextSha256: createHash('sha256').update(source.split(/\r?\n/).filter(line => line.includes(token)).join('\n')).digest('hex'),
      });
    }
  };
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 2, tokenAnalyses: 1, entries: 2, tokens: 1 });
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 2, tokenAnalyses: 1, entries: 2, tokens: 1 }, 'unchanged primitive bytes must not be reanalyzed');
  sources.set('a.ts', original.replace(token, 'removed-context'));
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 3, tokenAnalyses: 2, entries: 2, tokens: 1 }, 'only the changed path must be reanalyzed');
  sources.set('a.ts', original);
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 4, tokenAnalyses: 3, entries: 2, tokens: 1 }, 'restoration must replace the latest bytes, not retain every mutant');
  sources.delete('b.ts');
  sources.set('c.ts', original);
  assertReference();
  assert.deepEqual(cache.stats(), { analyses: 5, tokenAnalyses: 3, entries: 2, tokens: 1 }, 'replacement paths must evict removed entries');
  cache.prepare(sources, []);
  assert.equal(cache.stats().tokens, 0, 'token facts must be bounded to current policy requests');
  cache.prepare(new Map());
  assert.equal(cache.stats().entries, 0, 'removed source paths must not accumulate');
});

await check(['identity-cutover', 'identity-inventory'], 'CHK-007:happy:0 active producer registry config and current baselines are proof-or-stop only', () => {
  const sources = identityCutoverSourceMap();
  assertIdentityCutoverInventoryTotal(sources);
  assert.doesNotMatch(sources.get('packages/main/src/core/review-run.ts'), new RegExp(retiredReviewRunSalt));
});

await check(['identity-cutover'], 'CHK-007:happy:1 fresh public lifecycle emits and consumes only proof-or-stop identities', () => {
  assert.ok(freshFixture, 'fresh public CLI fixture must exist');
  const configPath = join(freshFixture.root, 'proof-or-stop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.promptEnvelope = {
    version: 'proof-or-stop.prompt-envelope-rollout.v1',
    roles: {
      'proof-or-stop-review-story-init': 'full-envelope',
      'proof-or-stop-review-quality': 'full-envelope',
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  git(freshFixture.root, ['add', 'proof-or-stop.config.json']);
  git(freshFixture.root, ['commit', '-m', 'enable canonical prompt envelope fixture']);
  const dispatched = runCli(freshFixture.root, 'dispatch', {
    storyId: freshFixture.storyId,
    agentType: 'proof-or-stop-review-story-init',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(dispatched.status, 0, `${dispatched.stdout}${dispatched.stderr}`);
  const envelopePath = join(freshFixture.storyDir, 'prompt-envelopes.json');
  const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')).envelopes.at(-1);
  const { envelopeId: _id, createdAt: _createdAt, ...semantic } = envelope;
  identityCutoverFixture = { envelopePath, envelope };
  assert.equal(envelope.envelopeId, digestWithIdentityPrefix(currentDigestPrefix, 'prompt-envelope.semantic.v1', semantic));

  const store = new StoryStore(freshFixture.root);
  const story = store.readStory(freshFixture.storyId);
  story.phase = 'REVIEW';
  story.currentReviewRound = NOW;
  store.writeStory(freshFixture.storyId, story);
  git(freshFixture.root, ['commit', '--allow-empty', '-m', 'fixture implementation provenance']);
  retainHistoricalImplementationPrerequisite(freshFixture.root);
  let run;
  for (const lane of promptRegistry.MODULAR_REVIEWER_ROLE_IDS) {
    const reviewDispatch = runCli(freshFixture.root, 'dispatch', {
      storyId: freshFixture.storyId,
      agentType: lane,
    }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
    assert.equal(reviewDispatch.status, 0, `${lane}: ${reviewDispatch.stdout}${reviewDispatch.stderr}`);
    const started = runCli(freshFixture.root, 'review_run_start', {
      storyId: freshFixture.storyId,
      agent: lane,
    }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', PROOF_OR_STOP_AGENT: lane });
    assert.equal(started.status, 0, `${lane}: ${started.stdout}${started.stderr}`);
    run = JSON.parse(readFileSync(join(freshFixture.storyDir, 'review-runs.json'), 'utf8')).runs.at(-1);
    assert.equal(run.agent, lane);
    assert.equal(run._hash, reviewRunHashWithSalt(run, currentReviewRunSalt));
    assert.equal(reviewRunContracts.verifyReviewRun(run), true);
    assert.equal(reviewRunContracts.verifyReviewRunPromptEnvelope(store, run).ok, true);
  }
  identityCutoverFixture = { ...identityCutoverFixture, run };
  const activeBytes = `${readFileSync(envelopePath, 'utf8')}\n${JSON.stringify(run)}`;
  assert.doesNotMatch(activeBytes, retiredIdentityPattern);
});

await check(['identity-cutover'], 'CHK-007:edge:0 frozen proofbound history stays byte-identical and is rejected by active readers', () => {
  const envelopePath = join(repoRoot, '.proof-or-stop/story/actives/B-022e/prompt-envelopes.json');
  const reviewRunsPath = join(repoRoot, '.proof-or-stop/story/actives/B-022e/review-runs.json');
  const envelopeBytes = readFileSync(envelopePath);
  const reviewRunBytes = readFileSync(reviewRunsPath);
  const envelopeDigest = createHash('sha256').update(envelopeBytes).digest('hex');
  const runDigest = createHash('sha256').update(reviewRunBytes).digest('hex');
  const historicalEnvelope = JSON.parse(envelopeBytes).envelopes.find((row) => row.schemaVersion?.startsWith(retiredProtocolPrefix));
  const historicalRun = JSON.parse(reviewRunBytes).runs.find((row) => row.assembledPrompt?.includes(retiredProtocolPrefix));
  assert.ok(historicalEnvelope && historicalRun, 'representative historical prompt/review records must remain present');
  assert.equal(promptEnvelope.verifyPromptEnvelopeIntegrity(historicalEnvelope), false);
  assert.equal(reviewRunContracts.verifyReviewRun(historicalRun), false);
  assert.equal(createHash('sha256').update(readFileSync(envelopePath)).digest('hex'), envelopeDigest);
  assert.equal(createHash('sha256').update(readFileSync(reviewRunsPath)).digest('hex'), runDigest);

  const retiredLedgerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-retired-ledger-'));
  fixtureRoots.push(retiredLedgerRoot);
  mkdirSync(join(retiredLedgerRoot, '.proof-or-stop'), { recursive: true });
  writeFileSync(
    artifactReleaseLedgerPath(retiredLedgerRoot),
    `${JSON.stringify({ schemaVersion: `${retiredProtocolPrefix}artifact-release.v1` })}\n`,
  );
  writeFileSync(
    capabilityReleaseLedgerPath(retiredLedgerRoot),
    `${JSON.stringify({ schemaVersion: `${retiredProtocolPrefix}product-capability-release.v1` })}\n`,
  );
  assert.throws(() => readArtifactReleaseLedger(retiredLedgerRoot), /unsupported identity schema.*proof-or-stop\.artifact-release\.v1/i);
  assert.throws(() => readCapabilityReleaseLedger(retiredLedgerRoot), /unsupported identity schema.*proof-or-stop\.product-capability-release\.v1/i);
});

await check(['identity-cutover'], 'CHK-007:edge:1 clean defaults expose no legacy reader verifier config alias or fallback', () => {
  for (const [name, module] of [['prompt-contracts', promptContracts], ['prompt-envelope', promptEnvelope], ['prompt-registry', promptRegistry], ['review-run', reviewRunContracts], ['prompt-role-contracts', promptRoleContracts]]) {
    assert.deepEqual(Object.keys(module).filter((key) => /legacy/i.test(key)), [], `${name} exports legacy acceptance API`);
  }
  const activePromptModePaths = [
    'packages/main/src/core/config.ts',
    'packages/main/src/core/prompt-contracts.ts',
    'packages/main/src/core/prompt-envelope.ts',
    'packages/main/src/core/prompt-registry.ts',
    'packages/main/src/core/prompt-role-contract-registry.ts',
    'packages/main/src/core/review-run.ts',
    'packages/main/src/handlers/agent-prompt.ts',
    'packages/main/src/handlers/review-run.ts',
    'packages/main/src/cli-init.ts',
    'packages/main/src/core/managed-assets.ts',
  ];
  for (const path of activePromptModePaths) {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    if (path !== 'packages/main/src/core/prompt-registry.ts') {
      assert.doesNotMatch(source, /LEGACY_(?:PROMPT|REVIEW)|verifyLegacy|validateLegacy/);
    }
    assert.doesNotMatch(source, /legacy-full-context/, `${path} retains the retired active prompt mode`);
  }
  for (const roleId of promptRegistry.MODULAR_COMPLEX_ROLE_IDS) {
    const entry = promptRegistry.readPromptRegistry().agents.find((candidate) => candidate.agentId === roleId);
    assert.ok(entry, `${roleId} remains registered`);
    const source = promptRegistry.readPromptTemplate(entry);
    assert.equal(promptRegistry.renderPromptEntryForHost(entry, 'claude'), source, `${roleId} defaults to canonical package bytes`);
    assert.equal(promptRoleContracts.resolvePromptEnvelopeRolloutMode(roleId, undefined), 'full-envelope');
    assert.throws(() => promptRoleContracts.resolvePromptEnvelopeRolloutMode(roleId, {
      version: promptRoleContracts.PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: { [roleId]: 'legacy-full-context' },
    }), /unsupported mode/);
  }
});

await check(['identity-cutover'], 'CHK-007:adversarial:0 proofbound injection at every active boundary fails closed with zero mutation', () => {
  assert.ok(freshFixture, 'fresh public CLI fixture must exist');
  const configPath = join(freshFixture.root, 'proof-or-stop.config.json');
  const canonicalConfigBytes = readFileSync(configPath);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.promptEnvelope = {
    version: `${retiredProtocolPrefix}prompt-envelope-rollout.v1`,
    roles: { 'proof-or-stop-review-story-init': 'full-envelope' },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  git(freshFixture.root, ['add', 'proof-or-stop.config.json']);
  git(freshFixture.root, ['commit', '-m', 'inject retired prompt config']);
  const fixture = {
    root: freshFixture.root,
    storyId: freshFixture.storyId,
    storyDir: freshFixture.storyDir,
    eventsPath: join(freshFixture.storyDir, 'process-events.jsonl'),
    indexPath: join(freshFixture.storyDir, 'index.json'),
  };
  const before = snapshotRuntimeState(fixture);
  const result = runCli(freshFixture.root, 'dispatch', {
    storyId: freshFixture.storyId,
    agentType: 'proof-or-stop-review-story-init',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(result.status, 0, 'retired explicit config must be rejected');
  assert.match(`${result.stdout}${result.stderr}`, /unsupported|promptEnvelope\.version|proof-or-stop/i);
  assertRuntimeFixtureUnchanged(fixture, before);

  writeFileSync(configPath, canonicalConfigBytes);
  git(freshFixture.root, ['add', 'proof-or-stop.config.json']);
  git(freshFixture.root, ['commit', '-m', 'restore canonical prompt config']);

  const canonicalDispatch = runCli(freshFixture.root, 'dispatch', {
    storyId: freshFixture.storyId,
    agentType: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(canonicalDispatch.status, 0, `${canonicalDispatch.stdout}${canonicalDispatch.stderr}`);
  const started = runCli(freshFixture.root, 'review_run_start', {
    storyId: freshFixture.storyId,
    agent: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
  const boundaryRun = JSON.parse(readFileSync(join(freshFixture.storyDir, 'review-runs.json'), 'utf8')).runs.at(-1);
  identityCutoverFixture = { ...identityCutoverFixture, boundaryRun };
  const envelopePath = join(freshFixture.storyDir, 'prompt-envelopes.json');
  const canonicalEnvelopeBytes = readFileSync(envelopePath);
  const envelopeBoundaries = [
    ...RETIRED_PROMPT_ENVELOPE_IDENTITY_BOUNDARIES.map((boundary) => [
      boundary.id,
      (envelope) => { envelope[boundary.path] = boundary.retired; },
    ]),
    ['prompt-envelope.digest-prefix', (envelope) => {
      const { envelopeId: _id, createdAt: _createdAt, ...semantic } = envelope;
      envelope.envelopeId = digestWithIdentityPrefix(`${retiredProtocolPrefix}digest.v1`, 'prompt-envelope.semantic.v1', semantic);
    }],
    ['prompt-envelope.role-lane', (envelope) => {
      envelope.roleId = `${retiredProtocolStem}-review-quality`;
      envelope.lane = `${retiredProtocolStem}-review-quality`;
    }],
  ];
  for (const [label, mutate] of envelopeBoundaries) {
    assertReviewPassRejectsEnvelopeMutation({ fixture, boundaryRun, canonicalBytes: canonicalEnvelopeBytes, label, mutate });
  }

  const reviewRunsPath = join(freshFixture.storyDir, 'review-runs.json');
  const canonicalRunsBytes = readFileSync(reviewRunsPath);
  const retiredRunBoundaries = [
    ['review-run.signing-salt', (run) => { run._hash = reviewRunHashWithSalt(run, retiredReviewRunSalt); }],
    ['review-run.prompt-digest-prefix', (run) => {
      run.promptHash = digestWithIdentityPrefix(`${retiredProtocolPrefix}digest.v1`, 'assembled-prompt.raw-utf8.v1', run.assembledPrompt);
      run._hash = reviewRunHashWithSalt(run, currentReviewRunSalt);
    }],
    ['review-run.agent', (run) => { run.agent = `${retiredProtocolStem}-review-quality`; }],
    ['review-run.lane', (run) => { run.lane = `${retiredProtocolStem}-review-quality`; }],
    ['review-run.workspace-binding', (run) => {
      run.workspaceBinding = { ...(run.workspaceBinding ?? {}), schemaVersion: `${retiredProtocolPrefix}review_run_workspace_binding.v1` };
    }],
    ['review-run.scope-binding', (run) => {
      run.scopeBinding = { ...(run.scopeBinding ?? {}), schemaVersion: `${retiredProtocolPrefix}review_run_scope_binding.v1` };
    }],
    ['review-run.assembled-prompt', (run) => { run.assembledPrompt += `\n${retiredProtocolPrefix}nested.v1`; }],
  ];
  for (const [label, mutate] of retiredRunBoundaries) {
    assertReviewPassRejectsRunMutation({ fixture, boundaryRun, canonicalBytes: canonicalRunsBytes, label, mutate });
  }

  const retiredDispatchBefore = snapshotIdentityAuthorityState(fixture);
  for (const [command, args, env] of [
    ['dispatch', { storyId: freshFixture.storyId, agentType: `${retiredProtocolStem}-review-quality` }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' }],
    ['review_run_start', { storyId: freshFixture.storyId, agent: `${retiredProtocolStem}-review-quality` }, { PROOF_OR_STOP_AGENT: `${retiredProtocolStem}-review-quality`, PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' }],
  ]) {
    const rejected = runCli(freshFixture.root, command, args, env);
    assert.notEqual(rejected.status, 0, `${command} must reject the retired reviewer identity`);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /unknown|retired|not permitted|invalid/i, command);
    assertIdentityAuthorityStateUnchanged(fixture, retiredDispatchBefore);
  }

  const initRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-retired-init-writer-'));
  fixtureRoots.push(initRoot);
  initRepo(initRoot, false);
  const initCreated = runCli(initRoot, 'story_create', {
    name: 'retired-init-writer-boundary',
    title: 'Retired INIT writer boundary',
    description: 'Exercise exact INIT reviewer identity admission through the public writer.',
    type: 'chore', priority: 'high', background: validBackground(), forceNew: true,
    checklist: [{ title: 'Reject retired INIT writer', context: 'Only canonical INIT reviewer identities may persist.' }],
    scopeBoundary: {
      mode: 'custom', allowed: ['retired INIT identity rejection'], excluded: ['historical rewrite'],
      userConfirmed: true, actor: 'human', confirmation: 'Bounded Round 18 public-operation fixture.',
    },
    executionBoundary: {
      allowedCommands: ['node packages/main/tests/canonical-new-story-artifacts.test.mjs'],
      allowedTools: ['shell'], allowedPaths: ['packages/main/tests/canonical-new-story-artifacts.test.mjs'],
      excludedCommands: ['git push'], blockedPaths: ['.proof-or-stop/story'],
    },
  });
  assert.equal(initCreated.status, 0, `${initCreated.stdout}${initCreated.stderr}`);
  const initStoryId = initCreated.stdout.match(/Story (B-[a-f0-9]+) created/)?.[1];
  assert.ok(initStoryId, initCreated.stdout);
  const initStoryDir = join(initRoot, '.proof-or-stop', 'story', 'actives', initStoryId);
  const initFixture = {
    root: initRoot,
    storyId: initStoryId,
    storyDir: initStoryDir,
    eventsPath: join(initStoryDir, 'process-events.jsonl'),
    indexPath: join(initStoryDir, 'index.json'),
  };
  const initBefore = snapshotIdentityAuthorityState(initFixture);
  const retiredInit = runCli(initRoot, 'init_check_set', {
    storyId: initStoryId,
    issues: [],
    agentId: `${retiredProtocolStem}-review-story-init`,
  }, { PROOF_OR_STOP_AGENT: `${retiredProtocolStem}-review-story-init` });
  assert.notEqual(retiredInit.status, 0, `${retiredInit.stdout}${retiredInit.stderr}`);
  assert.match(`${retiredInit.stdout}${retiredInit.stderr}`, /unknown|retired|not permitted|invalid/i);
  assertIdentityAuthorityStateUnchanged(initFixture, initBefore);

  const releaseRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-retired-release-writers-'));
  fixtureRoots.push(releaseRoot);
  initRepo(releaseRoot, false);
  mkdirSync(join(releaseRoot, 'docs'), { recursive: true });
  writeFileSync(join(releaseRoot, 'docs', 'identity-boundary.md'), 'retired release identity boundary\n');
  git(releaseRoot, ['add', 'docs/identity-boundary.md']);
  git(releaseRoot, ['commit', '-m', 'seed release identity boundary']);
  mkdirSync(join(releaseRoot, '.proof-or-stop'), { recursive: true });
  const retiredReleaseCases = [
    {
      label: 'artifact release',
      path: artifactReleaseLedgerPath(releaseRoot),
      row: { schemaVersion: `${retiredProtocolPrefix}artifact-release.v1` },
      command: 'artifact_release_list',
    },
    {
      label: 'capability release',
      path: capabilityReleaseLedgerPath(releaseRoot),
      row: { schemaVersion: `${retiredProtocolPrefix}product-capability-release.v1` },
      command: 'capability_release_list',
    },
  ];
  for (const releaseCase of retiredReleaseCases) {
    writeFileSync(releaseCase.path, `${JSON.stringify(releaseCase.row)}\n`);
    const beforeRead = snapshotPublicOperationState(releaseRoot);
    const rejected = runCli(releaseRoot, releaseCase.command, { format: 'json' });
    assert.notEqual(rejected.status, 0, `${releaseCase.label} public reader accepted retired identity`);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /unsupported identity schema/i, `${releaseCase.label} public reader`);
    assert.deepEqual(
      snapshotPublicOperationState(releaseRoot),
      beforeRead,
      `${releaseCase.label} public reader changed repository, lock, ledger, or generated-output state`,
    );
  }

  const measurementPolicy = COMMAND_POLICIES.prompt_measurement_report;
  const measurementFact = processFacts.PROCESS_FACT_REGISTRY_BY_NAME.prompt_measurement_report;
  assert.equal(measurementPolicy.ownershipClass, 'readOnly');
  assert.deepEqual(
    { level: measurementFact.level, gateEvidence: measurementFact.gateEvidence, destructiveRisk: measurementFact.destructiveRisk },
    { level: 'L0', gateEvidence: false, destructiveRisk: 'none' },
  );
  const measurementBefore = snapshotRuntimeState(fixture);
  const measured = runCli(freshFixture.root, 'prompt_measurement_report', { json: true });
  assert.equal(measured.status, 0, `${measured.stdout}${measured.stderr}`);
  assertRuntimeAuthoritativeStateUnchanged(fixture, measurementBefore);
  const measurementRoot = createPublicOperationClone('proof-or-stop-b49df-measurement-public-');
  execFileSync('npm', ['--prefix', 'packages/utils', 'run', 'build'], {
    cwd: measurementRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const measurementConfigPath = join(measurementRoot, 'proof-or-stop.config.json');
  const measurementConfig = JSON.parse(readFileSync(measurementConfigPath, 'utf8'));
  measurementConfig.storyDir = '.proof-or-stop-test/story/actives';
  writeFileSync(measurementConfigPath, `${JSON.stringify(measurementConfig, null, 2)}\n`);
  const measurementBaselinePath = join(measurementRoot, promptMeasurement.PROMPT_MEASUREMENT_BASELINE_PATH);
  const canonicalMeasurementBytes = readFileSync(measurementBaselinePath);
  const checkedInMeasurement = JSON.parse(canonicalMeasurementBytes.toString('utf8'));
  for (const [label, mutate] of [
    ['prompt-measurement report schema', (report) => { report.schemaVersion = `${retiredProtocolPrefix}prompt-measurement-report.v1`; }],
    ['prompt-measurement record schema', (report) => { report.records[0].schemaVersion = `${retiredProtocolPrefix}prompt-measurement.v1`; }],
    ['prompt role-contract registry version', (report) => { report.roleContractRegistryVersion = `${retiredProtocolPrefix}prompt-role-contract-registry.v1`; }],
  ]) {
    const mutant = structuredClone(checkedInMeasurement);
    mutate(mutant);
    writeFileSync(measurementBaselinePath, `${JSON.stringify(mutant, null, 2)}\n`);
    const beforeVerify = snapshotPublicOperationState(measurementRoot, ['B-49df']);
    const rejected = spawnSync('npm', ['run', 'test:proof-or-stop-prompt-baseline'], {
      cwd: measurementRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'sess-b49df-measurement-public' },
    });
    assert.notEqual(rejected.status, 0, `${label}: public prompt-baseline verifier accepted retired identity`);
    assert.match(
      `${rejected.stdout}${rejected.stderr}`,
      /(?:role-prompt measurement sidecar validation failed:.*(?:unsupported|does not match|schema)|retired active protocol identity at docs\/requirements\/baselines\/role-prompt-measurement-baseline\.json.*not admitted)/is,
      `${label}: public prompt-baseline verifier did not report the identity failure: ${rejected.error?.message ?? ''}\n${rejected.stdout}${rejected.stderr}`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(measurementRoot, ['B-49df']),
      beforeVerify,
      `${label}: public prompt-baseline verifier changed Story, Git, lock, or generated-output state`,
    );
    writeFileSync(measurementBaselinePath, canonicalMeasurementBytes);
  }

  const registryRoot = createPublicOperationClone('proof-or-stop-b49df-prompt-registry-public-');
  const registryConsumerRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-prompt-registry-consumer-'));
  fixtureRoots.push(registryConsumerRoot);
  initRepo(registryConsumerRoot, false);
  const registryDistPath = join(registryRoot, 'packages', 'main', 'dist', 'core', 'prompt-registry.js');
  const canonicalRegistryBytes = readFileSync(registryDistPath);
  const canonicalRegistrySource = canonicalRegistryBytes.toString('utf8');
  const registrySnapshotBlock = [
    '        schemaVersion: PROMPT_REGISTRY_VERSION,',
    '        source: PROMPT_REGISTRY_SOURCE,',
    '        root: templateDir,',
  ].join('\n');
  assert.equal(canonicalRegistrySource.split(registrySnapshotBlock).length - 1, 1, 'prompt registry snapshot producer block drifted');
  for (const [label, injectedBlock] of [
    ['schema', [
      `        schemaVersion: '${retiredProtocolPrefix}prompt-registry.v1',`,
      '        source: PROMPT_REGISTRY_SOURCE,',
      '        root: templateDir,',
    ].join('\n')],
    ['source', [
      '        schemaVersion: PROMPT_REGISTRY_VERSION,',
      `        source: '@${retiredProtocolStem}/core/templates/agents',`,
      '        root: templateDir,',
    ].join('\n')],
  ]) {
    writeFileSync(registryDistPath, canonicalRegistrySource.replace(registrySnapshotBlock, injectedBlock));
    const beforeRuntime = snapshotPublicOperationState(registryRoot, ['B-49df']);
    const beforePrompt = snapshotPublicOperationState(registryConsumerRoot);
    const rejected = runCli(
      registryConsumerRoot,
      'agent_prompt',
      { role: 'proof-or-stop-review-quality' },
      { PROOF_OR_STOP_ACTIVITY_SOURCE: 'test' },
      { entrypoint: join(registryRoot, 'packages', 'main', 'dist', 'cli.js') },
    );
    assert.notEqual(rejected.status, 0, `public agent_prompt accepted retired prompt-registry ${label}`);
    assert.match(
      `${rejected.stdout}${rejected.stderr}`,
      /prompt registry.*unsupported|unsupported.*prompt registry|retired active protocol identity at packages\/main\/src\/core\/prompt-registry\.ts.*not admitted/i,
      `public agent_prompt did not report retired prompt-registry ${label}`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(registryConsumerRoot),
      beforePrompt,
      `retired prompt-registry ${label} changed consumer Story, Git, lock, or generated-output state`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(registryRoot, ['B-49df']),
      beforeRuntime,
      `retired prompt-registry ${label} changed injected runtime state`,
    );
    writeFileSync(registryDistPath, canonicalRegistryBytes);
  }

  for (const releaseWriter of [
    {
      label: 'artifact release writer',
      ledgerPath: artifactReleaseLedgerPath,
      retiredSchema: `${retiredProtocolPrefix}artifact-release.v1`,
      write: (root, mainCommit, runGit) => runArtifactReleaseLedgerAfterDoneMergeDetailed(
        root, 'B-retired-artifact', mainCommit, mainCommit,
        { changedPaths: ['docs/requirements/decisions/proof-or-stop-identity-cutover.md'], runGit },
      ),
    },
    {
      label: 'capability release writer',
      ledgerPath: capabilityReleaseLedgerPath,
      retiredSchema: `${retiredProtocolPrefix}product-capability-release.v1`,
      write: (root, mainCommit, runGit) => runCapabilityReleaseLedgerAfterDoneMerge(
        root, 'B-retired-capability', mainCommit, mainCommit,
        { changedPaths: ['docs/requirements/decisions/proof-or-stop-identity-cutover.md'], runGit },
      ),
    },
  ]) {
    const verifier = createIdentityVerifierClone(`proof-or-stop-b49df-${releaseWriter.label.replaceAll(' ', '-')}-`);
    const verifierMainCommit = git(verifier.root, ['rev-parse', 'HEAD']);
    const ledgerPath = releaseWriter.ledgerPath(verifier.root);
    const canonicalLedgerBytes = existsSync(ledgerPath) ? readFileSync(ledgerPath) : Buffer.from('');
    writeFileSync(ledgerPath, `${canonicalLedgerBytes.toString('utf8')}${JSON.stringify({ schemaVersion: releaseWriter.retiredSchema })}\n`);
    const injectedVerifier = spawnSync(process.execPath, [verifier.verifierPath], { cwd: verifier.root, encoding: 'utf8' });
    assert.notEqual(injectedVerifier.status, 0, `${releaseWriter.label}: injected retired boundary left the verifier green`);
    assert.match(
      `${injectedVerifier.stdout}${injectedVerifier.stderr}`,
      /retired|proofbound|unsupported|unexpected|pinned|provenance|allowlist/i,
      `${releaseWriter.label}: verifier did not identify the injected retired boundary: ${injectedVerifier.stdout}${injectedVerifier.stderr}`,
    );
    const beforeWrite = snapshotPublicOperationState(verifier.root, ['B-49df']);
    const gitCalls = [];
    let writerFailure = null;
    try {
      releaseWriter.write(verifier.root, verifierMainCommit, (args) => { gitCalls.push(args); return ''; });
    } catch (error) {
      writerFailure = error;
    }
    assert.ok(writerFailure, `${releaseWriter.label}: public writer accepted the injected retired identity`);
    assert.match(
      String(writerFailure?.message ?? writerFailure),
      /identity verification failed before commit/is,
      `${releaseWriter.label}: public writer returned the wrong failure: ${String(writerFailure?.message ?? writerFailure)}`,
    );
    assert.match(
      String(writerFailure?.message ?? writerFailure),
      /retired|proofbound|unsupported|unexpected|allowlist|schema/is,
      `${releaseWriter.label}: public writer did not expose the retired-identity diagnostic: ${String(writerFailure?.message ?? writerFailure)}`,
    );
    assert.deepEqual(
      snapshotPublicOperationState(verifier.root, ['B-49df']),
      beforeWrite,
      `${releaseWriter.label} changed Story, Git, lock, ledger, or generated-output state`,
    );
    assert.deepEqual(gitCalls, [], `${releaseWriter.label} reached Git`);
  }

});

// Discover executable identity literals independently of the site/case registry.
// Transpilation removes type-only declarations, but includes a newly introduced
// typed producer immediately; stale dist cannot hide it. The same AST projection
// also runs over actual emitted JS. JSON keys/values and template role declarations
// are included, rather than assuming that one schema covers an entire file.
// Five independently audited imported authorities have no literal in the owned
// consumer. Bind their exact origin declaration and import/use syntax, without
// recursively promoting every dependency module into the owned-source universe.
const OWNED_IMPORTED_IDENTITY_ORIGINS = [
  ['packages/main/src/core/evidence-freshness.ts', 'packages/main/src/core/artifact-schema.ts', 'EVIDENCE_HASH_SNAPSHOT_SCHEMA'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/proof-admissibility.ts', 'PROOF_ADMISSIBILITY_CONTRACT_VERSION'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/proof-admissibility.ts', 'PROOF_ADMISSIBILITY_VERIFIER_VERSION'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/claim-admissibility/quantum.ts', 'QUANTUM_CLAIM_ADMISSIBILITY_SCHEMA_VERSION'],
  ['packages/main/src/core/claim-admissibility/pack-framework.ts', 'packages/main/src/core/claim-admissibility/quantum.ts', 'QUANTUM_CLAIM_ADMISSIBILITY_VERIFIER_VERSION'],
];

function deriveOwnedIdentityLiterals(sourceMap, { emitted = false } = {}) {
  const result = [];
  const exactIdentity = /^proof-or-stop[.\-][a-zA-Z0-9._-]+(?:\0)?$/u;
  for (const path of IDENTITY_CUTOVER_REQUIRED_PATHS) {
    assert.ok(sourceMap.has(path), `owned identity source missing: ${path}`);
    let source = sourceMap.get(path);
    const occurrences = [];
    const add = (value, context) => {
      if (typeof value === 'string' && exactIdentity.test(value)) occurrences.push({ canonical: value.replace(/\0$/u, ''), context });
    };
    if (/\.(?:ts|mjs)$/u.test(path)) {
      if (path.endsWith('.ts') && !emitted) source = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
      }).outputText;
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const unknown = Symbol('unresolved-constant');
      const declarations = new Map();
      const collect = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (node.parent.flags & ts.NodeFlags.Const)) {
          const named = declarations.get(node.name.text) ?? [];
          named.push(node); declarations.set(node.name.text, named);
        }
        ts.forEachChild(node, collect);
      };
      collect(ast);
      const importedValues = new Map();
      for (const [consumerPath, originPath, exportName] of OWNED_IMPORTED_IDENTITY_ORIGINS.filter(row => row[0] === path)) {
        const origin = ts.createSourceFile(originPath, sourceMap.get(originPath) ?? readFileSync(join(repoRoot, originPath), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const declarations = origin.statements.flatMap(node => ts.isVariableStatement(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? [...node.declarationList.declarations] : [])
          .filter(node => ts.isIdentifier(node.name) && node.name.text === exportName);
        assert.equal(declarations.length, 1, `imported identity origin missing/duplicate: ${originPath}#${exportName}`);
        let initializer = declarations[0].initializer;
        while (initializer && (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
        assert.ok(initializer && ts.isStringLiteralLike(initializer) && exactIdentity.test(initializer.text), `imported identity origin is not an exact canonical literal: ${originPath}#${exportName}`);
        const imports = ast.statements.filter(ts.isImportDeclaration).flatMap(node => {
          const bindings = node.importClause?.namedBindings;
          if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteralLike(node.moduleSpecifier)) return [];
          const resolved = relative(repoRoot, resolve(repoRoot, dirname(consumerPath), node.moduleSpecifier.text)).replace(/\.js$/u, '.ts');
          return resolved === originPath ? bindings.elements.filter(binding => (binding.propertyName ?? binding.name).text === exportName) : [];
        });
        assert.equal(imports.length, 1, `imported identity binding missing/duplicate: ${consumerPath}#${exportName}`);
        importedValues.set(imports[0].name.text, initializer.text);
      }
      const resolving = new Set();
      const evaluate = node => {
        if (!node || resolving.has(node)) return unknown;
        resolving.add(node);
        let value = unknown;
        if (ts.isStringLiteralLike(node)) value = node.text;
        else if (ts.isNumericLiteral(node)) value = Number(node.text);
        else if (ts.isParenthesizedExpression(node)) value = evaluate(node.expression);
        else if (ts.isIdentifier(node)) {
          if (importedValues.has(node.text)) value = importedValues.get(node.text);
          const named = declarations.get(node.text) ?? [];
          // Resolve only the nearest lexically enclosing const declaration.
          // Calls, mutation and arbitrary TS execution are never evaluated.
          for (let owner = node.parent; owner && value === unknown; owner = owner.parent) {
            const candidates = named.filter(declaration => declaration.parent.parent.parent === owner);
            if (candidates.length === 1) value = evaluate(candidates[0].initializer);
            else if (candidates.length > 1) break;
          }
        } else if (ts.isArrayLiteralExpression(node)) {
          const values = node.elements.map(evaluate);
          if (!values.includes(unknown)) value = values;
        } else if (ts.isObjectLiteralExpression(node)) {
          const result = Object.create(null);
          let complete = true;
          for (const property of node.properties) {
            if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) { complete = false; break; }
            result[property.name.text] = evaluate(property.initializer);
          }
          if (complete) value = result;
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          const left = evaluate(node.left), right = evaluate(node.right);
          if (['string', 'number'].includes(typeof left) && ['string', 'number'].includes(typeof right)) value = left + right;
        } else if (ts.isTemplateExpression(node)) {
          let result = node.head.text;
          for (const span of node.templateSpans) {
            const part = evaluate(span.expression);
            if (!['string', 'number'].includes(typeof part)) { result = unknown; break; }
            result += String(part) + span.literal.text;
          }
          value = result;
        } else if (ts.isPropertyAccessExpression(node)) {
          const receiver = evaluate(node.expression);
          if (receiver && typeof receiver === 'object' && Object.hasOwn(receiver, node.name.text)) value = receiver[node.name.text];
        } else if (ts.isElementAccessExpression(node)) {
          const receiver = evaluate(node.expression), key = evaluate(node.argumentExpression);
          if (receiver && typeof receiver === 'object' && ['string', 'number'].includes(typeof key) && Object.hasOwn(receiver, key)) value = receiver[key];
        } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.getText(ast) === 'Object.freeze' && node.arguments.length === 1) value = evaluate(node.arguments[0]);
          else if (node.expression.name.text === 'join' && node.arguments.length <= 1) {
            const receiver = evaluate(node.expression.expression), separator = node.arguments.length ? evaluate(node.arguments[0]) : ',';
            if (Array.isArray(receiver) && receiver.every(part => ['string', 'number'].includes(typeof part)) && typeof separator === 'string') value = receiver.join(separator);
          }
        }
        resolving.delete(node);
        return value;
      };
      const walk = node => {
        if (ts.isStringLiteralLike(node)) add(node.text, node.parent.getText(ast));
        else if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node) || ts.isCallExpression(node)
          || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
          || (ts.isIdentifier(node) && (node.parent.name !== node || ts.isShorthandPropertyAssignment(node.parent)))) {
          const value = evaluate(node);
          if (typeof value === 'string') add(value, node.parent.getText(ast));
        }
        ts.forEachChild(node, walk);
      };
      walk(ast);
    } else if (path.endsWith('.json')) {
      const walk = (value, location) => {
        add(value, location);
        if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
          add(key, `${location}.${key}:key`);
          walk(child, `${location}.${key}`);
        }
      };
      walk(JSON.parse(source), '$');
    } else if (path.endsWith('.md')) {
      const name = source.match(/^name:\s*(proof-or-stop[.\-][a-zA-Z0-9._-]+)\s*$/mu);
      if (name) add(name[1], name[0]);
    }
    for (const canonical of [...new Set(occurrences.map(row => row.canonical))].sort()) {
      const contexts = occurrences.filter(row => row.canonical === canonical).map(row => row.context);
      result.push({ sourcePath: path, canonical, occurrences: contexts.length,
        contextSha256: createHash('sha256').update(contexts.join('\n')).digest('hex') });
    }
  }
  return result;
}

// Exact non-protocol classifications are obligations, never file exemptions.
// Active role/path references are not relabeled as inert protocol history.
const OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS = [
  {
    sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs',
    canonical: 'proof-or-stop-finish-decision-boundary-',
    occurrences: 1,
    contextSha256: '6ee1f02d86f754e263fb70ea412c9a1e287a542026c509add7810fa5a37333dd',
    kind: 'scanner-self-test-fixture',
    reason: 'Exact temporary fixture directory prefix for the unlisted finish-decision neighbor control; not a product identity reader.',
    proof: 'node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test',
  },
  {
    sourcePath: 'scripts/verify-proof-or-stop-identity-cutover.mjs',
    canonical: 'proof-or-stop.dev-memory-finish-decision.v1',
    occurrences: 1,
    contextSha256: 'b1a24599294674d975c6c461516d3ecb6d9b2a8f5352025513042daeb7834cdb',
    kind: 'scanner-self-test-fixture',
    reason: 'Exact fresh canonical same-directory neighbor positive control paired with the retired-schema scanner negative; not runtime admission.',
    proof: 'node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test',
  },
  {
    "sourcePath": "packages/main/src/core/prompt-contracts.ts",
    "canonical": "proof-or-stop-observational-baseline",
    "occurrences": 1,
    "contextSha256": "9beff0b18570e6bfa770e29f85443d0a90ad78619c0259b0421005cb7cba57d0",
    "kind": "ignored-estimator-label",
    "reason": "Estimator first argument is ignored; estimatePromptTokens returns only a number, not an emitted or accepted identity.",
    "proof": "identity-sites: real bytesCharsEstimator is model-label-independent"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-f051-identity-subtree-",
    "occurrences": 1,
    "contextSha256": "6d4466164ff151da41860f41dfcc68f2160974f72c03bf0251e601515cb020d4",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-implementer",
    "occurrences": 1,
    "contextSha256": "8e67e4fa1a4f2799b80205a8c9b705a10b71fc7a223e6258afa80a4d7e065783",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-ordering-self-test-",
    "occurrences": 1,
    "contextSha256": "77d40517e529992c6536c529970ea70b4e01086cce0c04b10cfc5e423cc326a6",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-integrity-v1",
    "occurrences": 1,
    "contextSha256": "74a4b66994582f80451a52ec32f1ca42fef19d1a7c87b80b580695cddd142373",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-quality",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-story-init",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-review-topology-critic",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "canonical": "proof-or-stop-verifier-pass",
    "occurrences": 1,
    "contextSha256": "040d88b1da27abad29983a0ad14e7e03fd59cd49a3c77694828e0a354f4b64a5",
    "kind": "scanner-self-test-fixture",
    "reason": "Exact self-test positive, negative or temporary-fixture literal, not a live product reader/writer identity; AST parent context and count bind its location.",
    "proof": "node scripts/verify-proof-or-stop-identity-cutover.mjs --self-test"
  }
];

// Each observed use is bound as well as its value: an existing role/path value
// cannot silently authorize a new schema producer or a moved acceptance branch.
const OWNED_IDENTITY_SITE_CONTEXTS = [
  ['packages/main/src/core/playbook-runtime-memory.ts', 'proof-or-stop.dev-memory-finish-decision.v1', 1, '5cd694d61af425589349b4cdcf96b38c2f9c975fb5208d5a9e40cf00c3ff523a'],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-evaluator",1,"3ae040c8146a54c17e0d8374e9a03657bc5423ae0ab0cdc58c62785b623f93cc"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-evaluator-cli",1,"ef41eb8e08326223b08cfaf3106c314378a1ae95355134fae0ac849378eb8a41"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-implementation-reviewer",1,"58c48aa88d5f50870fc18900ddf14da6b73f6a5c8f3ed1db02b864907a95def5"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-implementer",1,"6bdfabfbd966953748eda9a970f71a677e02a71bcb268448eec0089ff69767bd"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-product-reviewer",1,"84a56da4948bb33ece220d03eadee881d563d13b9b075fb2d6e49298ab563da7"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-behavior",1,"424ff1358e8717984428e6e175c93e5afbe0ec177d1509aa3fe05fefd09c717e"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-channel",1,"2bd9d24621eebdb0422bfbc0f992b30d03f6407612762fac71dcb2af23b5c923"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-concept",1,"86306218222cc6488e3e9a63c435005c5d29c4c1d25852d66a19c8e8846f51b9"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-delivery",1,"9627a2f5600be85ca767ac6444fd8babdaaf0f243b48cfa01c066f7e4d60d7a9"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-docs",1,"5a2cb4f47ac32f9d88b351c905fdf77e0c8f10580ab963422391891facfe7d03"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-quality",1,"53fde766430b4eab25a886a69ca05e2356e3ff795828df2b75393c9730d401da"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-scope-plan",1,"7fa2c718a3c1ae97099a7492ff0a74dc5c8d44b0fe6c833b87aa40c1035a6179"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-story-init",1,"830ca09fd551c1393c958e9d7b6ea71d242b6ace5367fe1f9c9a7f8b67a29642"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-test-coverage",1,"916c2e1e94c54e5691e1979088878e1803264901e2af5449bd8e2eac827f15a7"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-review-topology-critic",1,"944616b8e132d2eb339e1ff5ed58b25861e6ad6d521e0a2aa7162b8fbd8dad5e"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-test-case-reviewer",1,"222477172413cbf8c544a62b025888962cd00d843c39a3659854e4d5d2fd823c"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-test-intent",1,"a07d99089b2d87aa0d78e848c5cb832a4f6ac81c406c2568f5a329687e2e81a2"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop-verification-intent",1,"9f7ec8a70a149f31841316b0541af18f2dd8c3a6a9be9de8f3734d571f6df799"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.agent-runtime.v1",19,"0c2d9c4932cd923d5e8750e75bfd6ab9904c74132b70b2be91209dfe5ba0eae9"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.canonical-json.code-point-keys.v1",1,"26eb0e7187ddeee6c2c2104875a32dc740827efb1cc5db59e8e9b12a772715cb"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.lifecycle.init-to-done.v2",1,"90cd0e1049cc86a38e0b81985f1b9b9275b8a4bc8b2ebcd174d83abfedd17626"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.prompt-measurement-report.v1",1,"b900b5f655dc43ddf2249de4f60f95b7b2b946eabc0c43f9f815a8283234dd5b"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.prompt-measurement.v1",18,"a5321c30d242bd7b0bf4f590b4d008d9f9303b78f22c6d93e9f89dd76b14b27b"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.prompt-role-contract-registry.v1",1,"946ad789b48af1945d82d2bb92aa36172755f557b939d54b86031bbdf4bc9522"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.role-contract.v1",18,"eb7a698e9dc3431cf02d912fe9d24d35f7f35209e34539cc7558bf024e947e0b"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.signed-process-facts.v1",1,"5e728c453cb903f696b07054fdf7cae1e270392d78dc4a3806c2728f8f7ee590"],
  ["docs/requirements/baselines/role-prompt-measurement-baseline.json","proof-or-stop.story-owner-boundaries.v1",1,"118528694699fb569bd59f2038ea9c2a338ee7c3ed2f5410a056a3227aafa143"],
  ["packages/main/src/core/artifact-release.ts","proof-or-stop.artifact-release.v1",7,"468e13e6f92a21719ec97f4ec21903db5c64cba78ffe2fe5484f70e694fb4dd5"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.candidate-spec-set.v1",3,"8814401c9858f74d298e5456767c163561e89fc1526a04fbd07b2f2a92345daa"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.corpus-index.v1",2,"21e37d460e54d039b597286597ce0aef6d2787328803afee26d8be8cccab04bd"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.keyword-proposal.v1",2,"1d1017acab5e99b67de74ca61454e960527ee9f797ba74b559e79fda73cb10c3"],
  ["packages/main/src/core/candidate-spec-routing.ts","proof-or-stop.keyword-seeds.v1",2,"ae3f7e7a58d68ea822dc7f30c90dacc27b926236b1c7fe56d8612c9347292cae"],
  ["packages/main/src/core/capability-release.ts","proof-or-stop.capability-release-backfill.v1",4,"1b41811713727dfb2af98e6739a994f11cb5e9aa0005b2529f5caa983dae708a"],
  ["packages/main/src/core/capability-release.ts","proof-or-stop.product-capability-release.v1",7,"4a7ed917cdf9b57c1101e776f9a3228650297e7a878954cfe18ade07d50800c8"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.certification-window.v1",2,"55390816fce64f457e03a28e01a3b0a9a7ae6020fc5d16f28f08bb0cb7ab51e5"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.certification_window.v1",4,"952857f21de6b8db9e341382558cac92ca91cb025ab92a7164a03193d3c55342"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.certification_windows.v1",2,"beb677cf7c33738e8a7ede5846d9d874231e96d04f1a9304380096ec6ceb50d7"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.precert-receipt.v1",2,"5894229aca4940c6bf82bb9a623db9b3e3cce063b13743f4f1d82fb1140d3c14"],
  ["packages/main/src/core/certification-window.ts","proof-or-stop.precert_receipt.v1",3,"0d426b51c4a197ac6064e991de7fb7fa07d8b36ad9ee1e6e0dfd255aae2e5d42"],
  ["packages/main/src/core/config.ts","proof-or-stop.prompt-envelope-rollout.v1",1,"dc2889324578f66914eba65d50ebc1839180e25e7ea22367b584b18df28a32c0"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.evidence-freshness-classifier.v1",1,"f1d951fdc4ce3c3d1fcb8ffb355d4ecb69695755185adb135729d922de162fc9"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.evidence_hash_snapshot.v1",1,"8ce5a7590a66f586e072d6739063d445915757c2241c7db3fe2dcee938632c9c"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.verifier-dependency-manifest.v1",3,"423fc8479e6108678ade451817d7b1d72fe6365fbfe9ade221c8978f6a72965d"],
  ["packages/main/src/core/evidence-freshness.ts","proof-or-stop.verifier-dependency-manifest-binding.v1",2,"594d7d8d86c1ee7608582e7da9cdaebb3a74646fccdff5abcb919f8ee763883b"],
  ["packages/main/src/core/impact-classification-policy.ts","proof-or-stop.impact-classification.v1",2,"44d3864291a1830fdacdbb4f3c8b8e374d1cb5975a9abe08d0476a09beec5e28"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.non-deducible-source.v1",5,"a8f299dd9d289b9a54fde559113c32ef18da859e61ef6ee1328ada76a2c00210"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.non-deducible-sources.v1",5,"5f3a719e2f47e5ceb92d14e11cf3171b29e1a01b53f3c5a436a1bebf986e35f1"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-auto-activation.v1",3,"67ff459fa6d7b6d23d43d0a98cb88c43e047b072657e8c1c6725b3529870530e"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-outcome.v1",4,"907f449eaf19d6e71f1ddcb0c3cd8a28fb754a67680d25fa4c4cbaa7bb4a3525"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-promotion-decision.v1",4,"d004ae6902f8a2956ea7592f6e8540d71d15834bf4f5dafda2e36ea886567363"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-promotion-health.v1",4,"dc5728112910b60da1afe798417f2a6a4c6ae9d9b9a5408101c55012723b8c6a"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-promotion-observe.v1",2,"b5c13c0ad441656a7b4008af2c024a1cbf93174af37fd21d769fa0c6a168e00a"],
  ["packages/main/src/core/learning-store.ts","proof-or-stop.playbook-trial-control.v1",4,"0ec0eb62f9535ea05deb68ccfcf0b559c6a49d6c43ed214622326e316f0bb6a9"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_exception.v1",6,"b60ea5e327758857c2a6ca8068516fe16d30e7f25f66a7d9af8cc24772d6f15e"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_exception_registry.v1",2,"c7d41d9c671927c014fffafeea3227a9b23ff31d34a05c206a4abe0ec9bd7673"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_exception_set.v1",1,"0fddf6cef9738e9b16c45fbb2f4d843870019e413d9cd60814004c35ad045184"],
  ["packages/main/src/core/lifecycle-control/queue/index.ts","proof-or-stop.queue_governance_status.v1",2,"8e544e5bf321c2b9012ba116ad70e881f7a04dca730259edca1780fa9cc2da0f"],
  ["packages/main/src/core/milestone-status.ts","proof-or-stop.milestone_closeout.v1",2,"7553c0c9f41ccb1edb02aacdc15dbc045483c288c70f3ceae90157913a3eb5c0"],
  ["packages/main/src/core/milestone-status.ts","proof-or-stop.milestone_closeout_missing.v1",2,"3339134b27e4027e6dd8ddf48c6deb63ca1418ef19701bd03364e0ce34e089cf"],
  ["packages/main/src/core/milestone-status.ts","proof-or-stop.milestone_status.v1",4,"353eb282894e74a9b7e686098f5391d4426d78bb5e1fea85910d4085b1820110"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-global-",1,"2b964b208939240b26aa8aed7a3489171b69feba7b80b7959ad4cc02e67665dd"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-matrix-",1,"d7a0a36b044f6a6f9be5a947791d67a64e9d71b97908e0c4a30cd724601d4208"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-runtime-",1,"3743a6d2dc6d66683dd5f570239987acfe10e97f04fb6c78b9ae04a4f6c2f8f9"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop-memory-baseline-runtime-corpus-",1,"ddde57000ff721e4a1db2ab6d9e3ef906de809cf5f40910abb11332bda0599ef"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop.memory-playbook-baseline.gold.v1",1,"0a1c020a16091416b828ecdb8a8ab5af26aa00f15442602d3ff978744dbbcbb0"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop.memory-playbook-baseline.v1",1,"f89f69813c32cfb09b1e040a7cb9db191df371e42319aa94151d9302dc532d8f"],
  ["packages/main/src/core/playbook-runtime-baseline.ts","proof-or-stop.memory-playbook-optimized-parity.v1",1,"2fa656065a5488110f8e971d8c339849a9930d38816959ad1dea9cd1daf08f58"],
  ["packages/main/src/core/playbook-runtime-memory-cache.ts","proof-or-stop.runtime-memory-pack-cache.v1",2,"ff0ecc73d1c840a0d10aebe48179c36563c3bebb92174530de7e30d910a6b488"],
  ["packages/main/src/core/playbook-runtime-memory-index.ts","proof-or-stop.runtime-memory-index.v3",4,"b76d39882c63ff78d942b606c28030c8cc1d7ecf06216787b790bb00318c6e86"],
  ["packages/main/src/core/playbook-runtime-memory.ts","proof-or-stop.memory-pack.v1",4,"6d13678d4c4bbc208e2c68230ef0c26f2d0d465139e18c2d2a5a04575e576507"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.evidence-activated-advisory-playbook.v1",1,"9f8c22db1e652c8d05fc5c974f6bc220335f9c6b87c68ac9466ea4fe8fa1a807"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-auto-activation.v1",1,"31cf22ff33884fcd903ba3a039bdbb00bbbb5d1c3530dea2b1b11c14d6280d70"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-auto-promotion-apply.v1",2,"783943db80856a71a799643b55c813a131f51819d50b31e5af383f29e28f138a"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-candidate-batch-manifest.v1",4,"6c6984286f527a0a8a6c0ab7bb4960f601ea233271b63c290ec4ea468d4df5b7"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-candidate-ingest.v1",2,"329c50b46658e412a589659c5608b10246148fdc0211f96fc5db32081fa9433b"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-outcome.v1",1,"f683764715ab871d8991af93e96ec516fdf6989bd9048797d68c7169a59b4c05"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-promotion-decision.v1",2,"9b07b262dd06315d705530507bf27726be748700c71e4a83e54633603444dbc5"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-promotion-timer.v1",2,"24e40fca62bb319d90aff63c0d00b03dd21a5a75f77777af3e7f0dea9757a0b9"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-runtime-consumption-verify.v1",2,"5cba148e861efb3061fcd329b236290892612aaebee59e40a9aec39827e9bdab"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-seed-backfill.v1",2,"ebcb135d167cf101c7fcfaf2f5fd7bad3476b44c961de29bf269eb207dc6f99d"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-seed-observe.v1",2,"c93c68552304d39caec83c57bc84f3faefc1fe64f349afa02adfb34e6cbcc951"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-seed-propose-batch.v1",2,"1a2028f9f971baace3735f158c5ed654bebf80dcbecbb9b48b83cb3d7c316fe8"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-trial-control.v1",1,"4d615307511a4257e433ead896c279d2ac75079791d77abdb7236645edbd98ef"],
  ["packages/main/src/core/playbook-seed.ts","proof-or-stop.playbook-trial-run.v1",2,"a66d9a196e56b5c697990523a7563ed8b99a7205dbc2ab3a10177a8d72a8b281"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-product-reviewer",3,"65d7305a890d9c64cf4f4c1a3ee6b14a19d7afc7eaa628fc1292c1d9d6d4669f"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-behavior",3,"be17b15404bee444cf91897023aedd8d7691eae2c83a83132babf40c8582c550"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-channel",1,"547c368fabc1d69d4d45a1b1f8fbeaae264857a674c7a0c17262d1d881182cee"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-concept",3,"401b6c29b547d29028942eef2eab0898e0643ca76dc98922ff2f3dcbafb68786"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-delivery",4,"b0764d6f5e401673abda7e491b43827ade9f7e30fe7ac63e2c9c07900b643015"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-docs",3,"ab9e3a2706e26f97d2b7fcfd76acd480d01c0479946c93f868fe1eb865269e1a"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-quality",3,"8886e2a23af6c5c830099d6a6cad6c3b93f074e5e564654ec1e0136cd7dcd496"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-scope-plan",4,"3b42b3e417e35afd01c21acbf0857ee02ccc1d0ef3defd7fd92e10309d6c8a6f"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-story-init",4,"774702674324b1f7879c6fefdcef8663d8bd42d05f7e9b63597aef23335af764"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-test-coverage",3,"b53fc9789e3d6813548afe00f084ede23158acc45875675bbcb113a43b161f75"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop-review-topology-critic",5,"d9555a2fdbdcaa1eef15412c2fe4f81e41a3828af42d3612df8062ad9e49ece6"],
  ["packages/main/src/core/process-fact-registry.ts","proof-or-stop.candidate-spec-set.v1",2,"9b6b2f24e3a72b282badaf7c58e3984d03e73387acf4da4aeb31d060a5bc5119"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-implementer",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-review-delivery",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-review-scope-plan",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop-review-story-init",1,"9fd81a61216e661339bceb520341d5bd0c47b1a3de0902479a17f605b6c60bf5"],
  ["packages/main/src/core/prompt-budget.ts","proof-or-stop.prompt-budget-observation.v1",1,"bc70b43954aace4be6d0be4926f55b86fa2a1728118b41d018b73817b9719b50"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.agent-runtime.v1",4,"fb68ef493859dd206307c141027f753fe4f4f88e54c6a35a08025beed609c46c"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.canonical-json.code-point-keys.v1",1,"cef1933b7b6c5b0340b121c5fbf9b24c42d3120e15d23405030d28c1127acf35"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.full-context-assembler.v1",2,"b119e67c6f52a72da678f420137e58628dbf75c8a97f1bdf16c590972330a2ef"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.full-task-context.v1",3,"c2ccd3bdd0a00dfab3c589183d22d77af2f4ebaceea1e71b84fcfc840db0300a"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.incremental-review-basis.v1",3,"8b404edf9782c116f8b9d094f5626afc899dc7674e1c712867831163b94e5890"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.known-execution-environment.v1",3,"7f298863b69dd99176c0b7fba767cdc42511a790c761ed66512964a70ccc6d67"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.prompt-dispatch.v1",2,"e10d43b58b455cb5d0dcdfdb9d37b37ed5cd039666646407e0469379c4a00b36"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.prompt-envelope.v1",3,"2aa929c1efa88afab325c307acb08e2cb843b4d4d2d0525d6d3b5370c43a390b"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.prompt-measurement.v1",3,"eb79b832eb82f99f2ec92dbc9f0d9aee38d663a7cf64f01185a7e6f68df0cb6c"],
  ["packages/main/src/core/prompt-contracts.ts","proof-or-stop.role-contract.v1",4,"6bf02ef9f2dae5b643c05f4b487c3fb8b624d4704de2764801c5f694782cef4d"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.lifecycle.init-to-done.v2",1,"9ce277910bcc869b99aedc1c6183af1188b5be7274d3e00721ba6cc682d3508e"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.prompt-measurement-report.v1",3,"aeb788cc13ab6f93f3c6c8e640a227795595dac33a547ac8f600086cde13276c"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.signed-process-facts.v1",1,"2a142b850892073f293b39f20d7eb58620b1fccfe9ae81684a0ab391392edba7"],
  ["packages/main/src/core/prompt-measurement.ts","proof-or-stop.story-owner-boundaries.v1",1,"2ef12a91c586105fd0d95d49479ca6684bd75451489abea9aa578539fb637c8a"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-evaluator",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-implementer",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-behavior",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-concept",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-delivery",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-docs",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-quality",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-scope-plan",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-story-init",1,"68fcfa5c7dc0912d3e6e65dceacea49603214c7ff22b92c725104c756ffe3bc0"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-test-coverage",1,"0abb45f1366cd13f605513947231fdb071a041f759ebc24ff811fb62c430e17f"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop-review-topology-critic",2,"f58ae7a9703571d0eb2b3c1214b45db87e22d2c40af47456f619850c7f97d00a"],
  ["packages/main/src/core/prompt-registry.ts","proof-or-stop.prompt-registry.v1",9,"e91e32c7fbb2184b1d539a3712ed5c469961068c9559b123383fe8f7c4a8d285"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-evaluator",1,"c92be961323f140446966838401a73e735528f31ef87a0344a27ccfa4f35b91b"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-evaluator-cli",1,"3e8a068a52fdacb6250be32ecaac9b886966d875c0ab3b879d97da05e65ffe51"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-implementation-reviewer",2,"0183fee39fae706c82ba4819cca03396c1052ecd5ab32b7c842987f5aca76a05"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-implementer",1,"dc2c9f5dd02bd758f687d97f87de31e2f268440e2886fa4970683550782de892"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-product-reviewer",2,"de6b6440cfbc99e1aadc90c6d781047f17979f5a68338e2f1106ddc93efd0ba4"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-behavior",1,"74f6c5d302b5fa9801fabc3135125550c4a3215e17393b6069f9b5bd1bb71488"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-channel",3,"67848bdb68a7b98374d94b5a54e9382c20fe2e3428d32739191404f111b15015"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-concept",1,"e2eed6690fc25a332ad3c36a5e2b2cc15850bda46b0cf6650d225f4fc645d157"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-delivery",1,"b3b7e4cad7ca0533ac761164ec30243dbfd4eaabd3d604492440d08038c91b92"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-docs",1,"86e2bfd1e70f9629448e1410e3d28e046fec89966f78d74201a46f6cdfa7b34d"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-quality",2,"b9b78c9796975587e4a4b3413595939790a3d2447ea59776aecc5d48c006f6f9"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-scope-plan",1,"14e230e149e56ca51298f1113a17a95af8baacc17487c0e150dbb74f6a3f2a45"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-story-init",1,"cc36f9efa02f75e8d11de339a925b98b3728c0151c3b30c5b4d24929f3687e97"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-test-coverage",2,"e836453271a10e1e6f56506b66e0491b57288ee6e5d7537ec57352f6ddd5a9ae"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-review-topology-critic",2,"0f9fa11ae4a65c11f91ed5dd7fb04b010ae1f051fc3a3692cca83c0f875cb1a7"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-test-case-reviewer",2,"e92653935944999c34f9d6f7cd6907a815603b4607d36c87a8cba459683ed9c7"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-test-intent",2,"e3399c860195403757ef129066411cf080fd27a6cd810cfaff14b63e102168c2"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop-verification-intent",2,"48e182ae65f8b5fb796025190a0c6253c57ad03be63f2e84c0fcad2c89e99de2"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop.prompt-envelope-rollout.v1",3,"6cf43f22aaedbfb2abee51ad2a7b9a9ca13fc3fe2bf947f91c9e56ec5cc051d3"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop.prompt-role-contract-registry.v1",2,"f15b450075b0315c6b7d3ab37920115bbb99793f63ddfac8e740d7bb90d1f3ea"],
  ["packages/main/src/core/prompt-role-contract-registry.ts","proof-or-stop.reviewer-host-render-identity.v1",1,"365d4642ea43355f189ba8d6ad8351fc88449ff1c8a23e489e8117adf7ac85f2"],
  ["packages/main/src/core/review-incremental-context.ts","proof-or-stop.post-remediation-review-selection.v1",9,"d4a117682b7753ad40e75c53d75689f1106521d404f9e4b4f9fc40f78136a712"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop-review-topology-critic",2,"978e340270cb78b6ad3c053ce6663fb5ce37e520df769d157fb7739205844d15"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review-inventory-critic-receipt.v1",2,"57f069c4d6c987e29e5b037c5cb08cb38390bc3bf2086bb9e14e772c222cb061"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review-inventory-epoch.v1",2,"8370fb367e9815835f99d509213ead0da671604308300f5be150d4710f4b6dd2"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review-inventory-receipt.v1",2,"faa983d2230868758c7bda51f93b01958aa5ec9a23fd611491b9d2be060cbe63"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.verification-receipt-bundle.v5",1,"51aa57007901d8f5efb5f5afa2ae61410409a92432c562c6229916dc3c2aa72a"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.inventory-verification-observation.v1",1,"22fe5b4a457d314f5fd429adbcb557fef1905cbf99649f531c3bed5d5321152b"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_critic_receipt.v1",1,"dbf7750a5ea4399754c9c621a6378c798ee42112d88331595f454b91f5f7166c"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_epoch.v1",3,"1575de0d7ab62c9893ef8dc572430fd7aa3f034fc6d65c1f1632534cb7e6bda2"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_epochs.v1",2,"5f3a059ce11b6cf1b599115d22fc96a87433d4b4a0d68dba49c04a25e6c1edcd"],
  ["packages/main/src/core/review-inventory-epoch.ts","proof-or-stop.review_inventory_receipt.v1",3,"1e9380a5370e76403c71c426a3620861b53a3790e84ff43829dd36f1b3536ead"],
  ["packages/main/src/core/review-run.ts","proof-or-stop-review-run-integrity-v1",2,"2e34c2f6b44bbd293a9d0181454a84b8d2b96b2727e2f32344b5ba058d57881a"],
  ["packages/main/src/core/review-run.ts","proof-or-stop-review-run-workspace-binding-v1",2,"ef4b314082ba5d7e8209712a7703cb6fba4670412685d0cc844f950c2d55337d"],
  ["packages/main/src/core/review-run.ts","proof-or-stop-review-topology-critic",2,"8665236ef7e20780970268a87325d743a06c594a1dc8245df43697d0d5b679e1"],
  ["packages/main/src/core/review-run.ts","proof-or-stop.review_run_workspace_binding.v1",3,"ebd2c315aa8aef07cbe695f9515b96d5bb2c4c1179eb5831a0d7246dbacef573"],
  ["packages/main/src/core/source-lineage-audit.ts","proof-or-stop.learning-source-key.v1",4,"b4ce85902d753eae474e91f522b6b3a45df7bbc96dc662b2ce728739cae9b1a8"],
  ["packages/main/src/core/source-lineage-audit.ts","proof-or-stop.source-lineage-audit.v1",2,"753b71eb955ac2773da2bf4eee59ddfdcd062af12756f090a7f14ec81a746107"],
  ["packages/main/src/handlers/agent-prompt.ts","proof-or-stop.agent-prompt-response.v1",2,"24c5be99c5118d833d6c1d482b97b7b12ea1e6e0797f8eac07fdde2433e220a7"],
  ["packages/main/src/handlers/done-effects.ts","proof-or-stop.playbook-promotion-health.v1",2,"60dadb837f637fed6222eacda478b3ec11ad17ed8e67952c6cd7760f3ae901ca"],
  ["packages/main/src/handlers/playbook-runtime-memory.ts","proof-or-stop.dev-memory-finish-decision.v1",1,"b1a24599294674d975c6c461516d3ecb6d9b2a8f5352025513042daeb7834cdb"],
  ["packages/main/src/handlers/playbook-runtime-memory.ts","proof-or-stop.final-response-check.v1",1,"223cf92d48f4da6e18ae4e8cf3710385ec93d57046fd6f74c997b9631954a510"],
  ["packages/main/src/handlers/playbook-runtime-memory.ts","proof-or-stop.playbook-runtime-health.v1",1,"b2c7d4835166f7eda37f51ec06e456a4dd71f4a4f03e9b0dea0fa366b5641cb4"],
  ["packages/main/src/handlers/playbook.ts","proof-or-stop.playbook-outcome.v1",1,"f683764715ab871d8991af93e96ec516fdf6989bd9048797d68c7169a59b4c05"],
  ["packages/main/src/handlers/playbook.ts","proof-or-stop.playbook-promotion-decision.v1",1,"bcd4385e0b76f66f1ba68dac9ac474ef4a95703d7f4e6a7b473b46cc97f668d3"],
  ["packages/main/src/handlers/review-run.ts","proof-or-stop.review_run_list.v1",1,"e07c61407d782cf03b20793f1210d9764c05fe975495bce22ef6b21fc80c4d0c"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-implementer",3,"8db8864574a6ac41052364d1c1b47c53e804adeb859a80edbbae70cad72bd007"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-behavior",1,"455048f4336614857ebce1afe420d6a07dd06d91ad9b65bf28da561588e24137"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-channel",1,"c1c7397b28f000a0dbc575cbf87e4bcb25261d5f75b7022a84b7eaf4a5c2845f"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-concept",1,"0ba1287e59591305f6cb4659ac1deb23762845b6810deac473e6f50c39af7ccf"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-docs",1,"4ddb377e6c2a995fe0c5fd719bb71c99f6b086fb66e8e436ea9afb6ff132884d"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-quality",1,"a2cd9b9ae2556bb3c6e5315fde6421dc73e1567ca28fe31f5d25f8881ba9d412"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-scope-plan",1,"a42de68f06508c39f65881465453d06bba83d27af1662c882a942e5fc513ce10"],
  ["packages/main/src/handlers/story-dispatch.ts","proof-or-stop-review-topology-critic",1,"832a75497c422470aaf849da115ea117272279c86905458b2ca5619e7af80714"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop-code-runtime",1,"79c3dbf024b89f303a8738369f67d5cc113ed5fc7bea65c4fdcbe065f90ac4e7"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.claim_admissibility_pack.v1",3,"b51a97ae59980c2083f627befb6c62b8c389be361d03c100b7d2724c804d36c2"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.proof_admissibility.v1",3,"3c028112f0b1f93da3fbecf1e2dfa6952488b0a2e7dbb489439991e734b643b3"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.proof_admissibility_verifier.v1",4,"645a2ea7c013c9e24ce0dece50325583c187b1e38b925a7796d154280a343fa7"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.quantum_claim_admissibility.v1",3,"a218ad2338fb22a22043547206ca7faddb084d69249f8ffb0a81448ebdbb45e4"],
  ["packages/main/src/core/claim-admissibility/pack-framework.ts","proof-or-stop.quantum_claim_admissibility_verifier.v1",1,"b3acf615693cdaeab156adc531616752117d84a2b3c92a46fa29ea38002e3ca8"],
  ["packages/main/templates/agents/proof-or-stop-evaluator.md","proof-or-stop-evaluator",1,"7435623083b065bf19ec13c0651e4581df85bb2ac781e21b62d359287184269a"],
  ["packages/main/templates/agents/proof-or-stop-implementer.md","proof-or-stop-implementer",1,"c3cd3a9a9d1a95cc12289bdb1cc6927b1868da4c77ce6c087e01d0db796b3527"],
  ["packages/main/templates/agents/proof-or-stop-review-behavior.md","proof-or-stop-review-behavior",1,"a16d2dcf3f64457cbdd038a2533ffe8a488ed09076ebc138d68f0746c910ed5c"],
  ["packages/main/templates/agents/proof-or-stop-review-concept.md","proof-or-stop-review-concept",1,"2f97091366bf2edf9abe200fea67047d97b57a94827400b69f1201e0b2ef54ab"],
  ["packages/main/templates/agents/proof-or-stop-review-delivery.md","proof-or-stop-review-delivery",1,"f23fd7c161a331f7fd3aba838dc6dc5007b594db24750664918d88277b70a824"],
  ["packages/main/templates/agents/proof-or-stop-review-docs.md","proof-or-stop-review-docs",1,"085a2a1cf2ac37eebe59f8df7bc098bf02326efb72706a92ba5a1150088563f8"],
  ["packages/main/templates/agents/proof-or-stop-review-quality.md","proof-or-stop-review-quality",1,"8573bcea18a7525c70d421aa88e1556510f4956c58235dca8e83508aa8456365"],
  ["packages/main/templates/agents/proof-or-stop-review-scope-plan.md","proof-or-stop-review-scope-plan",1,"6005b05edecbbdbb7b14ccb9df99036fc246f039f46672798b8c7ed8b325a3f5"],
  ["packages/main/templates/agents/proof-or-stop-review-story-init.md","proof-or-stop-review-story-init",1,"cd42b34427b3104d10e703309695406a3fb9297cf88373b30be785fa67306ea7"],
  ["packages/main/templates/agents/proof-or-stop-review-test-coverage.md","proof-or-stop-review-test-coverage",1,"4c2b3ce82a5b971ca8d39f58f911223defc33bfc169c2a336576059ce02ff03d"],
  ["scripts/verify-proof-or-stop-identity-cutover.mjs","proof-or-stop.artifact-release.v1",6,"15d2f56ce3c3a824ea064a5e2b20482e79f0e6d31ca9a0f95cc1f9e6a28329b1"],
  ["scripts/verify-proof-or-stop-identity-cutover.mjs","proof-or-stop.product-capability-release.v1",5,"9e175785e3d485403957e9a11018036a99b6290810a877528f32dae433c457a8"],
  ["proof-or-stop.config.json","proof-or-stop-evaluator",1,"036870d52dfd2c953ec925b07b219c25937a93d1d04bc122e90bf08a807ba4c8"],
  ["proof-or-stop.config.json","proof-or-stop-implementer",1,"81dea2ea56a89958ab282359de6536e29230f718fda3678d6641d348938b0e22"],
  ["proof-or-stop.config.json","proof-or-stop-review-behavior",1,"b83a4ca2754542e22437f5d108480d57aee56b85a0fef6c51bfda8fc42bf3ca7"],
  ["proof-or-stop.config.json","proof-or-stop-review-concept",1,"bb11664d29351645373c30772ae0c694283ac92a079a11f694866b237ac60c4c"],
  ["proof-or-stop.config.json","proof-or-stop-review-delivery",1,"f9bf368693043d8c8f36fef896cf0cf0b0eaa10c002547a31892826fa366f144"],
  ["proof-or-stop.config.json","proof-or-stop-review-docs",1,"e1e4ccec3d025eb6a35ef6f0a000bd5280d66e034f6081b12296d9ff8705d46d"],
  ["proof-or-stop.config.json","proof-or-stop-review-quality",1,"45163111e6a00b95e95edf5d02f8e4a64e8650f8ec0b20c5fa72ba4dc3725397"],
  ["proof-or-stop.config.json","proof-or-stop-review-scope-plan",1,"a3f0d25abebfddad9ab3c0ae008174aca96bb4eda6edf47f5d01d49593cfc5a7"],
  ["proof-or-stop.config.json","proof-or-stop-review-story-init",1,"5ea47c68b9182e7ab115b79cb802b35ec1afd5ceba48f34d83f71e7fcf6524a3"],
  ["proof-or-stop.config.json","proof-or-stop-review-test-coverage",1,"32564b076fb47134fc47aee191af578c83a565f5fc5e9c77047302b669d7889c"],
  ["proof-or-stop.config.json","proof-or-stop-review-topology-critic",1,"6d9565bbb95a41a02dff2e93bbcc7f493ff87ce5958d656f1c534e0fc8529099"],
  ["proof-or-stop.config.json","proof-or-stop.config.json",8,"e674d94ed28573e78222a5e63cc757a62d6e1e32a7150e3aa2978acdaa37a9f4"],
  ["proof-or-stop.config.json","proof-or-stop.prompt-envelope-rollout.v1",1,"3dd20408fa21226f6db5e926c57851e63443785775af0f734591ee2c6384f503"],
].map(([sourcePath, canonical, occurrences, contextSha256]) => ({ sourcePath, canonical, occurrences, contextSha256 }));

// Import values are not guessed or executed. Bind every executable import and
// its actual reference contexts separately; a new named/namespace/aliased use
// fails closed until reviewed, even when its value is already registered in the
// producer module. This is an import-use integrity obligation, not a claim of
// per-reference historical mutation coverage or a whole-file exemption.
function deriveOwnedImportUseContexts(sourceMap) {
  const rows = [];
  for (const path of IDENTITY_CUTOVER_REQUIRED_PATHS.filter(path => /\.(?:ts|mjs)$/u.test(path))) {
    assert.ok(sourceMap.has(path), `owned import source missing: ${path}`);
    const source = path.endsWith('.ts') ? ts.transpileModule(sourceMap.get(path), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
    }).outputText : sourceMap.get(path);
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const contexts = [];
    const declarations = new Map();
    const imported = new Set();
    const scopeOf = node => {
      for (let scope = node.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isFunctionLike(scope)) return scope;
      }
      return ast;
    };
    const register = (node, scope = scopeOf(node)) => {
      if (!ts.isIdentifier(node.name)) return;
      const names = declarations.get(scope) ?? new Map();
      const values = names.get(node.name.text) ?? [];
      values.push(node); names.set(node.name.text, values); declarations.set(scope, names);
    };
    const collect = node => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node) || (ts.isFunctionDeclaration(node) && node.name)) register(node);
      ts.forEachChild(node, collect);
    };
    collect(ast);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) {
      contexts.push(node.getText(ast));
      if (node.importClause?.name) { register(node.importClause, ast); imported.add(node.importClause); }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) { register(bindings, ast); imported.add(bindings); }
      else if (bindings) for (const binding of bindings.elements) { register(binding, ast); imported.add(binding); }
    }
    const bindingOf = node => {
      if (!ts.isIdentifier(node) || (node.parent.name === node && !ts.isShorthandPropertyAssignment(node.parent))) return null;
      for (let scope = node.parent; scope; scope = scope.parent) {
        const found = declarations.get(scope)?.get(node.text);
        if (found) return found.length === 1 ? found[0] : null;
      }
      return null;
    };
    // Propagate actual lexical bindings, never global name matches. A same-name
    // local parameter cannot taint unrelated data/hash declarations elsewhere.
    let grew = true;
    while (grew) {
      grew = false;
      for (const names of declarations.values()) for (const entries of names.values()) for (const declaration of entries) {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || imported.has(declaration)) continue;
        let usesImport = false;
        const inspect = node => { if (imported.has(bindingOf(node))) usesImport = true; ts.forEachChild(node, inspect); };
        inspect(declaration.initializer);
        if (usesImport) { imported.add(declaration); grew = true; }
      }
    }
    const walk = node => {
      if (imported.has(bindingOf(node))) {
        let use = node.parent;
        while (use.parent && (ts.isPropertyAccessExpression(use) || ts.isElementAccessExpression(use))) use = use.parent;
        contexts.push(use.getText(ast));
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) contexts.push(node.getText(ast));
      ts.forEachChild(node, walk);
    };
    walk(ast);
    rows.push({ sourcePath: path, occurrences: contexts.length, contextSha256: createHash('sha256').update(contexts.join('\n')).digest('hex') });
  }
  return rows;
}

const OWNED_IMPORT_USE_CONTEXTS = [
  {
    "sourcePath": "packages/main/src/core/artifact-release.ts",
    "occurrences": 39,
    "contextSha256": "b95e9b29eb348caf5e4f06a088ff48c7bbda588ee1ed885994d036eee0a0e0a6"
  },
  {
    "sourcePath": "packages/main/src/core/candidate-spec-routing.ts",
    "occurrences": 127,
    "contextSha256": "112f0f04fb82fd718d7da0a02e3cc1b0d15215655aebe60fbe9c18f107323190"
  },
  {
    "sourcePath": "packages/main/src/core/capability-release.ts",
    "occurrences": 77,
    "contextSha256": "da05592fe9ce8137db1b38e50343b62c3b6ebfc5ebf4bf20ccc56bafcf0e5ca7"
  },
  {
    "sourcePath": "packages/main/src/core/certification-window.ts",
    "occurrences": 44,
    "contextSha256": "eb7c8fc8103fdf69b8b2fceaf17f756817fe3920c5be183b55e21b6a498ff026"
  },
  {
    "sourcePath": "packages/main/src/core/config.ts",
    "occurrences": 67,
    "contextSha256": "cb73ec333d6f047b5dbf022a20641177a05de86bf2c5d691a372f0e820361581"
  },
  {
    "sourcePath": "packages/main/src/core/evidence-freshness.ts",
    "occurrences": 144,
    "contextSha256": "04e24fb31a52eab5950edeb871d4b356cd579028bc8466c92fb60c2a90bd303f"
  },
  {
    "sourcePath": "packages/main/src/core/experience-layer-types.ts",
    "occurrences": 0,
    "contextSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    "sourcePath": "packages/main/src/core/impact-classification-policy.ts",
    "occurrences": 2,
    "contextSha256": "22cd0c48dccc24a06725b104fc987d3fe81f8737bd2a73f6b6831976b0ad82a3"
  },
  {
    "sourcePath": "packages/main/src/core/learning-store.ts",
    "occurrences": 110,
    "contextSha256": "cb4347a34f2b75df8af681d08ae104c8270bd258d82d9131d544dbf74f833c92"
  },
  {
    "sourcePath": "packages/main/src/core/lifecycle-control/control-status.ts",
    "occurrences": 0,
    "contextSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  {
    "sourcePath": "packages/main/src/core/lifecycle-control/queue/index.ts",
    "occurrences": 70,
    "contextSha256": "316bdc446bd34ad1a82298235f31156095a826b0aab86adb11c66ef3bd6de4b0"
  },
  {
    "sourcePath": "packages/main/src/core/milestone-status.ts",
    "occurrences": 33,
    "contextSha256": "69605cbc54ae31743693b2577300c078fbca243daf24fa1bac24689d5d0c81c0"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-baseline.ts",
    "occurrences": 419,
    "contextSha256": "a488f68315641e65b4270e5c7adb95b9116629e60a43ecb25ba4b031dc364c5d"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-memory-cache.ts",
    "occurrences": 59,
    "contextSha256": "5e94ef91c82fd5073256f45e605348d0dc21d7beceec8b67b4433caeff08c03a"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-memory-index.ts",
    "occurrences": 71,
    "contextSha256": "d6597e739588940729eb711e2854ad34a97ccb199879332dfe3695c5c69cd667"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-runtime-memory.ts",
    "occurrences": 89,
    "contextSha256": "c5cb43c536b7a061dfb8baf8fc3496881ad66e27572f61c2c8331d653b1b39f6"
  },
  {
    "sourcePath": "packages/main/src/core/playbook-seed.ts",
    "occurrences": 377,
    "contextSha256": "3f79c6ccaf1d5bbca3bbbe8a19b48db43926794b35a6b852e5748c94e04945cf"
  },
  {
    "sourcePath": "packages/main/src/core/process-fact-registry.ts",
    "occurrences": 11,
    "contextSha256": "939ba7d06193520531783df317f665785af27378207731f56fe8d55b326d9f80"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-budget.ts",
    "occurrences": 4,
    "contextSha256": "b1bc3fea6f42db25be7b71baf9b4a8d4a685fa3127c16e1e9179215e0c77ea22"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-contracts.ts",
    "occurrences": 17,
    "contextSha256": "528ba74400e06c1dd9654a13ee964fed61bb13ca5137e73fa27d901aa5227f35"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-envelope.ts",
    "occurrences": 130,
    "contextSha256": "fd645991675f7f75b089b6387878be8f1876eb16ef317d4244bb0099ca332f68"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-measurement.ts",
    "occurrences": 77,
    "contextSha256": "a36196e3591cb29c3559138ad39ed2c631871c56c0d97bfc1a49e8b92ffe251a"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-registry.ts",
    "occurrences": 49,
    "contextSha256": "32402687f0053a359380524673823338d30a7594bd282f086b32a3dca3fc5251"
  },
  {
    "sourcePath": "packages/main/src/core/prompt-role-contract-registry.ts",
    "occurrences": 129,
    "contextSha256": "f3afa3e820781b5da208f6148c12b0bb7b79476c050184a8e6abff727badf6dc"
  },
  {
    "sourcePath": "packages/main/src/core/review-incremental-context.ts",
    "occurrences": 301,
    "contextSha256": "46fbe98cf92c3878520e1ebedb75308f3214e632a89f0b282926d98af4ef5194"
  },
  {
    "sourcePath": "packages/main/src/core/review-inventory-epoch.ts",
    "occurrences": 56,
    "contextSha256": "8eb9f73605d06fd23d4f24aaa3d45d2bc7d663fa3d5c30204a7768e326468610"
  },
  {
    "sourcePath": "packages/main/src/core/review-run.ts",
    "occurrences": 251,
    "contextSha256": "ffff4780c9210bc6e07e82e81ac83a9c2132def3598e2cb46fb5b28ee727c1a8"
  },
  {
    "sourcePath": "packages/main/src/core/source-lineage-audit.ts",
    "occurrences": 131,
    "contextSha256": "ee2d591e1f0fad9b2de7d1cde798eb873dd6e1fc743e6190109d8b6255debade"
  },
  {
    "sourcePath": "packages/main/src/handlers/agent-prompt.ts",
    "occurrences": 114,
    "contextSha256": "14192ecc1400d34d2270633da2d887036b956df85fccf9046bac95a011e08ee7"
  },
  {
    "sourcePath": "packages/main/src/handlers/candidate-spec-routing.ts",
    "occurrences": 88,
    "contextSha256": "6b97ed40a3168a4dbdcc1ff9ea84cc841d0c94cd6a34df55bab300a0f1940cf6"
  },
  {
    "sourcePath": "packages/main/src/handlers/done-effects.ts",
    "occurrences": 257,
    "contextSha256": "cbf92bf0551e2c7c0b31dbc5da03304b27c31ee0c8389c13da4c54447a6ef805"
  },
  {
    "sourcePath": "packages/main/src/handlers/playbook-runtime-memory.ts",
    "occurrences": 66,
    "contextSha256": "9c7acfd9ea18acb7500db7e70ac6d6ba984db239b75834160042ba4a13897883"
  },
  {
    "sourcePath": "packages/main/src/handlers/playbook.ts",
    "occurrences": 297,
    "contextSha256": "40a0d7eb4476cc7d20ed1b91a0e1be4e6c5cb70d0422b70dcacd5ccca7c17477"
  },
  {
    "sourcePath": "packages/main/src/handlers/review-run.ts",
    "occurrences": 191,
    "contextSha256": "8e87a07e632b094c6cc1b46b6ffe4a3e638584f1ec1fc409d1c5adc523e543bc"
  },
  {
    "sourcePath": "packages/main/src/handlers/story-dispatch.ts",
    "occurrences": 287,
    "contextSha256": "4ccd2b0cde6f04badfbcfb311d22ffad9a77de1a24a2ae42c13e3f1cee93dd9d"
  },
  {
    "sourcePath": "packages/main/src/core/claim-admissibility/pack-framework.ts",
    "occurrences": 49,
    "contextSha256": "ccd4fe3e8ae44b0b260c36ee4ed2c71d095e98d904df2d200655aa1360d91fea"
  },
  {
    "sourcePath": "packages/main/src/cli-init.ts",
    "occurrences": 514,
    "contextSha256": "4518f3f1d4954341a816bbb3ee6bd0dcfba54ce178852fc8e2caba53f8a01c18"
  },
  {
    "sourcePath": "scripts/verify-proof-or-stop-identity-cutover.mjs",
    "occurrences": 408,
    "contextSha256": "8222b748248262e67f91c2344ba79d292998d6f8c84f54f4c4d49c5ab104aea9"
  }
];

function assertOwnedImportUseIntegrity(sourceMap, pins = OWNED_IMPORT_USE_CONTEXTS) {
  assert.deepEqual(deriveOwnedImportUseContexts(sourceMap), pins, 'owned import use changed or unresolved imported identity use was added');
}

function assertOwnedIdentitySiteTotality(sourceMap, boundaries = ACTIVE_IDENTITY_OPERATION_BOUNDARIES, classifications = OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, options = {}) {
  const derived = deriveOwnedIdentityLiterals(sourceMap, options);
  assertDerivedIdentitySiteTotality(derived, boundaries, classifications, options);
  return derived;
}

function assertDerivedIdentitySiteTotality(derived, boundaries, classifications, options = {}) {
  const sites = boundaries.flatMap(boundary => boundary.identitySites);
  const cases = boundaries.flatMap(boundary => boundary.retiredIdentityCases);
  const missing = [];
  for (const row of derived) {
    const owners = sites.filter(site => site.sourcePath === row.sourcePath && site.canonical === row.canonical);
    const classes = classifications.filter(entry => entry.sourcePath === row.sourcePath && entry.canonical === row.canonical);
    if (owners.length === 0 && classes.length === 0) { missing.push(`${row.sourcePath}#${row.canonical}`); continue; }
    assert.equal(owners.length + classes.length, 1, `owned identity has duplicate/competing classification: ${row.sourcePath}#${row.canonical}`);
    if (owners.length) {
      assert.equal(cases.filter(entry => entry.siteId === owners[0].siteId).length, 1, `owned identity case missing/duplicate: ${owners[0].siteId}`);
      const pins = (options.contextPins ?? OWNED_IDENTITY_SITE_CONTEXTS).filter(pin => pin.sourcePath === row.sourcePath && pin.canonical === row.canonical);
      assert.equal(pins.length, 1, `owned identity occurrence context missing/duplicate: ${owners[0].siteId}`);
      assert.equal(row.occurrences, pins[0].occurrences, `owned identity use count changed: ${owners[0].siteId}`);
      if (!options.emitted) assert.equal(row.contextSha256, pins[0].contextSha256, `owned identity use context changed: ${owners[0].siteId}`);
    } else {
      const classification = classes[0];
      assert.equal(row.occurrences, classification.occurrences, `owned identity classification count drift: ${row.sourcePath}#${row.canonical}`);
      if (!options.emitted) assert.equal(row.contextSha256, classification.contextSha256, `owned identity classification context drift: ${row.sourcePath}#${row.canonical}`);
      assert.ok(classification.kind && classification.reason && classification.proof, `owned identity classification has no bounded proof: ${row.canonical}`);
    }
  }
  for (const classification of classifications) assert.ok(derived.some(row => row.sourcePath === classification.sourcePath && row.canonical === classification.canonical), `stale owned identity classification: ${classification.sourcePath}#${classification.canonical}`);
  assert.deepEqual(missing, [], 'unclassified owned executable identity sites');
}

await check(['identity-cutover', 'identity-sites', 'identity-config-boundary', 'identity-policy-boundary', 'round24'], 'F-060 all owned source and emitted identity sites have independent totality and public-operation cases', () => {
  const sources = identityCutoverSourceMap();
  assertOwnedIdentitySiteTotality(sources);
  assertOwnedImportUseIntegrity(sources);
  const emitted = new Map(sources);
  for (const path of IDENTITY_CUTOVER_REQUIRED_PATHS.filter(path => path.endsWith('.ts'))) {
    emitted.set(path, readFileSync(join(repoRoot, path.replace('/src/', '/dist/').replace(/\.ts$/u, '.js')), 'utf8'));
  }
  assertOwnedIdentitySiteTotality(emitted, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, { emitted: true });
});

await check(['identity-cutover', 'identity-sites', 'round24'], 'F-060 discovered-site omissions and new typed producers fail independently of registry agreement', async () => {
  const sources = identityCutoverSourceMap();
  const derived = assertOwnedIdentitySiteTotality(sources);
  for (const usage of [
    'import { CANDIDATE_SET_SCHEMA as ImportedIdentity } from "./candidate-spec-routing.js"; export const addedImportedProducer = { schemaVersion: ImportedIdentity };',
    'import * as ImportedIdentities from "./candidate-spec-routing.js"; export const addedNamespaceProducer = { schemaVersion: ImportedIdentities.CANDIDATE_SET_SCHEMA };',
    'import { CANDIDATE_SET_SCHEMA as ImportedIdentity } from "./candidate-spec-routing.js"; export function addedImportedReader(value) { return value === ImportedIdentity; }',
    'import { constructIdentity } from "./unresolved-identity.js"; export const addedUnresolvedProducer = { schemaVersion: constructIdentity() };',
  ]) {
    const changed = new Map(sources);
    const path = 'packages/main/src/core/candidate-spec-routing.ts';
    changed.set(path, `${sources.get(path)}\n${usage}\n`);
    assert.throws(() => assertOwnedImportUseIntegrity(changed), /owned import use changed/, usage);
  }
  assert.throws(() => assertOwnedImportUseIntegrity(sources, OWNED_IMPORT_USE_CONTEXTS.slice(1)), /owned import use changed/);
  const aliasSources = new Map(sources);
  const aliasPath = 'packages/main/src/core/candidate-spec-routing.ts';
  aliasSources.set(aliasPath, `${sources.get(aliasPath)}\nimport { OTHER_SCHEMA } from './other.js'; const importedAlias = OTHER_SCHEMA;\n`);
  const aliasPins = deriveOwnedImportUseContexts(aliasSources);
  aliasSources.set(aliasPath, `${aliasSources.get(aliasPath)}\nexport const aliasedProducer = { schemaVersion: importedAlias };\n`);
  assert.throws(() => assertOwnedImportUseIntegrity(aliasSources, aliasPins), /owned import use changed/);
  for (const [consumerPath, originPath, exportName] of OWNED_IMPORTED_IDENTITY_ORIGINS) {
    const originSites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.identitySites).filter(site => site.sourcePath === consumerPath && site.identityOrigin?.sourcePath === originPath && site.identityOrigin.exportName === exportName);
    assert.equal(originSites.length, 1, `imported identity origin has no exact consumer operation site: ${originPath}#${exportName}`);
    const changedOrigin = new Map(sources);
    changedOrigin.set(originPath, readFileSync(join(repoRoot, originPath), 'utf8').replace(exportName, `${exportName}_REMOVED`));
    assert.throws(() => deriveOwnedIdentityLiterals(changedOrigin), /imported identity origin missing/, exportName);
  }
  const allSites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.identitySites);
  for (const row of derived) {
    const site = allSites.find(site => site.sourcePath === row.sourcePath && site.canonical === row.canonical);
    if (site) {
      // Remove BOTH declarations: site-to-case equality remains true, but the
      // independently observed source still requires this identity's coverage.
      const omitted = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.map(boundary => ({ ...boundary,
        identitySites: boundary.identitySites.filter(entry => entry.siteId !== site.siteId),
        retiredIdentityCases: boundary.retiredIdentityCases.filter(entry => entry.siteId !== site.siteId),
      }));
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, omitted, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /unclassified owned executable identity sites/, site.siteId);
      const missingCase = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.map(boundary => ({ ...boundary,
        retiredIdentityCases: boundary.retiredIdentityCases.filter(entry => entry.siteId !== site.siteId),
      }));
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, missingCase, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /owned identity case missing\/duplicate/, site.siteId);
      const missingContext = OWNED_IDENTITY_SITE_CONTEXTS.filter(entry => entry.sourcePath !== row.sourcePath || entry.canonical !== row.canonical);
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS, { contextPins: missingContext }), /owned identity occurrence context missing\/duplicate/, site.siteId);
    } else {
      const omitted = OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS.filter(entry => entry.sourcePath !== row.sourcePath || entry.canonical !== row.canonical);
      assert.throws(() => assertDerivedIdentitySiteTotality(derived, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, omitted), /unclassified owned executable identity sites/, row.canonical);
      const drifted = derived.map(entry => entry === row ? { ...entry, occurrences: entry.occurrences + 1 } : entry);
      assert.throws(() => assertDerivedIdentitySiteTotality(drifted, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /classification count drift/, row.canonical);
    }
  }
  const path = 'packages/main/src/core/candidate-spec-routing.ts';
  for (const producer of [
    "export const typedProducer: { schemaVersion: string } = { schemaVersion: 'proof-or-stop.synthetic-owned-producer.v1' };",
    "export function typedReader(value: string): boolean { return value === 'proof-or-stop.synthetic-owned-reader.v1'; }",
    "export const unversionedDomain: string = 'proof-or-stop-synthetic-domain';",
    "export const joinedSchema: string = ['proof-or-stop', '.synthetic-joined.v1'].join('');",
    "export const concatenatedSchema: string = 'proof-or-stop' + '.synthetic-concatenated.v1';",
    "const syntheticBrand: string = 'proof-or-stop'; export const templateSchema = `${syntheticBrand}.synthetic-template.v1`;",
  ]) {
    const mutant = new Map(sources);
    mutant.set(path, `${sources.get(path)}\n${producer}\n`);
    assert.throws(() => assertOwnedIdentitySiteTotality(mutant), /unclassified owned executable identity sites/, producer);
  }
  const empty = new Map(sources);
  empty.delete(path);
  assert.throws(() => assertOwnedIdentitySiteTotality(empty), /owned identity source missing/);
  const reusedRole = new Map(sources);
  const rolePath = 'packages/main/src/handlers/story-dispatch.ts';
  reusedRole.set(rolePath, `${sources.get(rolePath)}\nexport const extraRoleSchema = { schemaVersion: 'proof-or-stop-implementer' };\n`);
  assert.throws(() => assertOwnedIdentitySiteTotality(reusedRole), /owned identity use count changed/, 'an already registered role value must not authorize a new schema use');
  for (const usage of [
    'export const newlyAddedProducer = { schemaVersion: CANDIDATE_SET_SCHEMA };',
    'export function newlyAddedReader(value: string) { return value === CANDIDATE_SET_SCHEMA; }',
    'const alias = CANDIDATE_SET_SCHEMA; export const aliasProducer = { schemaVersion: alias };',
  ]) {
    const aliasMutation = new Map(sources);
    aliasMutation.set(path, `${sources.get(path)}\n${usage}\n`);
    assert.throws(() => assertOwnedIdentitySiteTotality(aliasMutation), /owned identity use count changed/, usage);
  }
  const moved = derived.map(row => row.sourcePath === rolePath && row.canonical === 'proof-or-stop-implementer' ? { ...row, contextSha256: '0'.repeat(64) } : row);
  assert.throws(() => assertDerivedIdentitySiteTotality(moved, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, OWNED_NON_PROTOCOL_IDENTITY_CONTEXTS), /owned identity use context changed/, 'same value/count cannot move into a different active context');
  const estimatorSource = readFileSync(join(repoRoot, 'packages/main/src/core/usage-ledger/estimate.ts'), 'utf8');
  const assertIgnoredLabel = source => {
    const ast = ts.createSourceFile('estimate.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bytesCharsEstimator');
    assert.equal(functions.length, 1, 'ignored estimator witness must resolve exactly one function');
    const fn = functions[0];
    assert.ok(fn.body && ts.isIdentifier(fn.parameters[0]?.name), 'ignored estimator witness requires a named first parameter and body');
    const references = [];
    const visit = node => {
      if (ts.isIdentifier(node) && [fn.parameters[0].name.text, 'arguments', 'eval', 'Function'].includes(node.text)) references.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    assert.deepEqual(references, [], 'ignored estimator label became consumed');
  };
  assertIgnoredLabel(estimatorSource);
  assert.throws(() => assertIgnoredLabel(estimatorSource.replace('const text =', 'void _model; const text =')), /ignored estimator label became consumed/);
  const { bytesCharsEstimator } = await import(join(distRoot, 'core/usage-ledger/estimate.js'));
  assert.deepEqual(bytesCharsEstimator('proof-or-stop-observational-baseline', 'label-independent content'), bytesCharsEstimator('arbitrary-ignored-label', 'label-independent content'), 'the classified estimator argument must remain non-authoritative and absent from output');
});

await check(['identity-cutover', 'identity-sites', 'round24'], 'F-060 exact verifier mutation-data fragment never admits changed data or surrounding active code', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-fragment-control-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'scripts'));
  const path = join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs');
  const canonical = readFileSync(join(repoRoot, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'), 'utf8');
  const checks = [
    () => assertCanonicalActiveIdentityRuntime({ command: 'artifact_release_list', projectRoot: root, runtimePackageRoot: packageRoot }),
    () => assertCanonicalActiveIdentityBoundary({ boundaryId: 'release-ledgers', projectRoot: root, runtimePackageRoot: packageRoot }),
  ];
  writeFileSync(path, canonical);
  for (const check of checks) assert.doesNotThrow(check, 'exact data fragment must not reject canonical reader code');
  for (const marker of ['const OWNED_IDENTITY_MUTATION_CONTEXT_ROWS = [', 'const BOTH_FAMILY_CONTEXT_ROWS = [']) {
    const start = canonical.indexOf(marker);
    const end = canonical.indexOf('\n].map(', start) + 2;
    assert.ok(start >= 0 && end > start);
    const fragment = canonical.slice(start, end);
    for (const [label, mutated] of [
      ['missing', canonical.replace(fragment, '')],
      ['duplicated', `${canonical}\n${fragment}`],
      ['altered', canonical.replace(fragment, `${fragment.slice(0, -1)} ]`)],
    ]) {
      writeFileSync(path, mutated);
      for (const check of checks) assert.throws(check, /identity|mutation-data/, `${marker}: ${label}`);
    }
  }
  writeFileSync(path, `${canonical}\nif (schema === '${retiredProtocolPrefix}product-capability-release.v1') return schema;`);
  for (const check of checks) assert.throws(check, /identity|mutation-data/, 'unchanged data fragments do not admit an outside active reader');
});

await check(['identity-cutover', 'identity-sites', 'round24'], 'F-060 historical counterparts bind actual source while constructed controls claim no historical admission', () => {
  const importedCommit = '69403365ae9a19422564babf93f6c10de869c81d';
  const historicalSources = new Map();
  const assertProvenance = site => {
    assert.ok(['historical-retired', 'unsupported-family-control'].includes(site.mutationKind));
    if (site.mutationKind === 'unsupported-family-control') {
      assert.equal(site.retiredProvenance, undefined, 'constructed control must not claim historical authority');
      return;
    }
    const proof = site.retiredProvenance;
    assert.equal(proof?.commit, importedCommit, 'historical counterpart source commit changed');
    assert.equal(proof?.sourcePath, site.identityOrigin?.sourcePath ?? site.sourcePath, 'historical counterpart source path changed');
    assert.equal(proof?.value, site.retired, 'historical counterpart value changed');
    assert.ok(['producer-or-domain', 'reader-or-type-alternative'].includes(proof.use));
    if (!historicalSources.has(proof.sourcePath)) {
      const text = git(repoRoot, ['show', `${importedCommit}:${proof.sourcePath}`]);
      const ast = ts.createSourceFile(proof.sourcePath, text, ts.ScriptTarget.Latest, true,
        proof.sourcePath.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS);
      const values = new Set();
      const visit = node => { if (ts.isStringLiteralLike(node)) values.add(node.text); ts.forEachChild(node, visit); };
      visit(ast); historicalSources.set(proof.sourcePath, values);
    }
    assert.ok(historicalSources.get(proof.sourcePath).has(proof.value), `historical counterpart not found as an actual source literal: ${site.siteId}`);
  };
  const sites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary => boundary.identitySites);
  sites.forEach(assertProvenance);
  const historical = sites.find(site => site.mutationKind === 'historical-retired');
  assert.ok(historical, 'historical source checks must not be vacuous');
  for (const change of [{ commit: '0'.repeat(40) }, { sourcePath: 'package.json' }, { value: 'unlisted-counterpart' }]) {
    assert.throws(() => assertProvenance({ ...historical, retiredProvenance: { ...historical.retiredProvenance, ...change } }), /historical counterpart/);
  }
});

await check(['round24'], 'F-060 every exported prompt identity has an independently declared site and public-operation case', () => {
  const path = 'packages/main/src/core/prompt-contracts.ts';
  const sites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.identitySites);
  const cases = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.retiredIdentityCases);
  for (const canonical of Object.values(promptContracts.CURRENT_PROMPT_IDENTITIES)) {
    const owned = sites.filter((site) => site.sourcePath === path && site.canonical === canonical);
    assert.equal(owned.length, 1, `missing or duplicate exported prompt identity site: ${canonical}`);
    assert.equal(cases.filter((entry) => entry.siteId === owned[0].siteId).length, 1, `missing or duplicate operation case: ${canonical}`);
  }
});

await check(['round24'], 'F-062 ReviewRun mutation uses the historical salt actually retired by the cutover', () => {
  const site = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.identitySites)
    .find((entry) => entry.canonical === 'proof-or-stop-review-run-integrity-v1');
  assert.equal(site?.retired, ['lat', 'tice-review-run-integrity-v1'].join(''));
  assert.equal(site?.retiredNeedle, site?.retired);
});

for (const path of [
  'packages/main/src/handlers/dev-memory.ts',
  'packages/main/src/handlers/quorum-prune.ts',
  'packages/main/src/core/usage-ledger/ids.ts',
  'packages/main/src/handlers/validate-docs-drift.ts',
  'experiments/experience-ablation/snapshot-builder.mjs',
]) {
  await check(['round24'], `F-061 active producer or diagnostic uses canonical product prose: ${path}`, () => {
    assert.equal(/proofbound/iu.test(readFileSync(join(repoRoot, path), 'utf8')), false, `${path}: active retired product prose remains`);
  });
}

await check(['round24'], 'F-061 freshly built memory snapshot emits only canonical product prose', async () => {
  const { buildSnapshotFiles } = await import(join(repoRoot, 'experiments/experience-ablation/snapshot-builder.mjs'));
  const files = buildSnapshotFiles();
  assert.ok(Object.keys(files).length > 0);
  for (const [path, bytes] of Object.entries(files)) {
    assert.equal(/proofbound/iu.test(bytes), false, `${path}: freshly generated retired product prose`);
  }
});

await check(['round23'], 'F-058 shared Story6 provenance consumer is in the exact active-runtime verifier inventory', () => {
  const verifierSource = readFileSync(join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs'), 'utf8');
  assert.match(
    verifierSource,
    /'experiments\/role-prompt-ab-replay\/lib\/story6-provenance\.mjs'/,
    'ACTIVE_IDENTITY_EXACT_RUNTIME_PATHS must include the shared Story6 provenance consumer',
  );
});

await check(['round23'], 'F-059 identity sites and public-operation mutation cases have independent declarations', () => {
  const registrySource = readFileSync(join(repoRoot, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8');
  assert.doesNotMatch(registrySource, /const identitySites = seed\.retiredIdentityCases/);
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    assert.notStrictEqual(boundary.identitySites, boundary.retiredIdentityCases, `${boundary.id}: sites and cases alias the same array`);
  }
});

await check(['round23'], 'F-059 every registered path has an explicit owned-site or identity-free classification', () => {
  const registrySource = readFileSync(join(repoRoot, 'packages/main/src/core/runtime-environment-checks.ts'), 'utf8');
  assert.doesNotMatch(registrySource, /identitySites\[0\]/, 'unmatched paths must not silently map to the first identity site');
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    assert.deepEqual(
      boundary.pathBindings.map((binding) => binding.sourcePath).sort(),
      boundary.paths.map((entry) => entry.sourcePath).sort(),
      `${boundary.id}: path classification must be total`,
    );
    for (const binding of boundary.pathBindings) {
      assert.ok(
        binding.classification === 'owned-site' || binding.classification === 'identity-free',
        `${boundary.id}/${binding.sourcePath}: missing explicit classification`,
      );
      assert.equal(Object.hasOwn(binding, 'sharedConsumerReason'), false, `${boundary.id}/${binding.sourcePath}: generic shared-consumer prose is forbidden`);
      if (binding.classification === 'owned-site') {
        assert.ok(binding.siteIds.length > 0, `${boundary.id}/${binding.sourcePath}: owned-site path has no sites`);
      } else {
        assert.match(binding.evidence ?? '', /type-only|no emitted identity|generated consumer/i, `${boundary.id}/${binding.sourcePath}: identity-free classification lacks evidence`);
        const registeredPath = boundary.paths.find((entry) => entry.sourcePath === binding.sourcePath);
        const absolute = registeredPath.scope === 'runtime-package'
          ? join(packageRoot, registeredPath.path)
          : join(repoRoot, registeredPath.path);
        assert.doesNotMatch(
          readFileSync(absolute, 'utf8'),
          /proof-or-stop[.-]/,
          `${boundary.id}/${binding.sourcePath}: identity-free emitted bytes contain an active identity site`,
        );
      }
    }
  }
});

for (const [sourcePath, canonical] of [
  ['packages/main/src/core/review-incremental-context.ts', 'proof-or-stop.incremental-review-basis.v1'],
  ['packages/main/src/handlers/review-run.ts', 'proof-or-stop.prompt-envelope.v1'],
  ['packages/main/src/core/prompt-envelope.ts', 'proof-or-stop.prompt-envelope.v1'],
  ['packages/main/src/cli-init.ts', 'proof-or-stop.js'],
]) {
  await check(['round23'], `F-059 registered real identity site ${sourcePath}`, () => {
    const sites = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.identitySites);
    const site = sites.find((candidate) => candidate.sourcePath === sourcePath && candidate.canonical === canonical);
    assert.ok(site, `${sourcePath}: missing exact identity site ${canonical}`);
    const cases = ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap((boundary) => boundary.retiredIdentityCases);
    assert.equal(cases.filter((candidate) => candidate.siteId === site.siteId).length, 1, `${site.siteId}: requires exactly one public-operation mutation case`);
  });
}

await check(['identity-cutover', 'identity-snapshot'], 'sparse public fixture retains complete indexed-path creation detection and outside material', () => {
  const { root } = ensurePublicIdentityOperationFixture();
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot && root !== mainRoot);
  const index = git(root, ['ls-files', '--stage', '-z']);
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const omitted = paths.find(path => path.startsWith(INERT_PUBLIC_FIXTURE_LOG_SUBTREE));
  assert.ok(omitted, 'the exact inert log subtree must have a tracked creation control');
  const absolute = join(root, omitted);
  assert.equal(lstatSync(absolute, { throwIfNoEntry: false }), undefined);
  const baseline = snapshotGitMaterial(root);
  assert.ok(baseline.split('\n').includes(`${omitted}\0deleted`), 'absent indexed log must remain in the material snapshot');
  const outside = snapshot => snapshot.split('\n').filter(row => !row.startsWith(INERT_PUBLIC_FIXTURE_LOG_SUBTREE)).join('\n');
  mkdirSync(dirname(absolute), { recursive: true });
  for (const kind of ['empty', 'nonempty', 'symlink']) {
    try {
      if (kind === 'symlink') symlinkSync('../../../proof-or-stop.config.json', absolute);
      else writeFileSync(absolute, kind === 'empty' ? '' : 'a newly created tracked log must remain observable\n');
      const changed = snapshotGitMaterial(root);
      assert.notEqual(changed, baseline, `${kind} creation at an omitted tracked path escaped the snapshot`);
      assert.equal(outside(changed), outside(baseline), `${kind} control changed nonexcluded material`);
      assert.equal(git(root, ['ls-files', '--stage', '-z']), index, `${kind} control changed the complete index`);
      assert.deepEqual(git(root, ['ls-files', '-z']).split('\0').filter(Boolean), paths, `${kind} control dropped an indexed path`);
    } finally {
      rmSync(absolute, { force: true });
    }
    assert.equal(snapshotGitMaterial(root), baseline, `${kind} restoration did not recover the complete baseline`);
  }
});

await check(['identity-cutover', 'identity-canonical', 'identity-config-boundary', 'identity-policy-boundary', 'f050', 'round24'], 'CHK-007 canonical controls: every distinct registered public operation succeeds before mutation', () => {
  const startedAt = Date.now();
  const fixture = ensurePublicIdentityOperationFixture();
  assertCanonicalPublicIdentityOperations(fixture, 'normal preflight');
  process.stdout.write(`PASS canonical fixture and operation elapsedMs=${Date.now() - startedAt}\n`);
});

await check(['identity-cutover', 'identity-config-boundary', 'round24'], 'prompt config rejects unsupported user versions without fallback or mutation', () => {
  const fixture = ensurePublicIdentityOperationFixture();
  const configPath = join(fixture.root, 'proof-or-stop.config.json');
  const canonicalBytes = readFileSync(configPath);
  const config = JSON.parse(canonicalBytes.toString('utf8'));
  try {
    config.promptEnvelope.version = 'unsupported-config-version';
    writeFileSync(configPath, JSON.stringify(config));
    const before = snapshotPublicOperationState(fixture.root, ['B-49df']);
    const rejected = runCli(fixture.root, 'agent_prompt', { role: 'proof-or-stop-review-quality' }, {}, { entrypoint: fixture.entrypoint });
    assert.notEqual(rejected.status, 0, 'invalid prompt version must never fall back to default config');
    assert.match(`${rejected.stdout}${rejected.stderr}`, /unsupported promptEnvelope\.version: unsupported-config-version/u);
    assert.deepEqual(snapshotPublicOperationState(fixture.root, ['B-49df']), before, 'invalid prompt config changed runtime state');
  } finally {
    writeFileSync(configPath, canonicalBytes);
  }
});

await check(['identity-cutover', 'identity-policy', 'identity-policy-boundary', 'round24'], 'eager role policy rejection derives missing canonical sites without invented counterparts', () => {
  const expected = promptRegistry.readPromptRegistry().agents.map(entry => entry.agentId);
  assert.ok(expected.length > 2, 'role policy controls require independent package roles');
  const valid = Object.fromEntries(expected.map(id => [id, {}]));
  const validate = promptRoleContracts.validatePromptRolePolicyDefinition;
  assert.doesNotThrow(() => validate(valid, expected));
  const unknown = 'unregistered-policy-one';
  const sourceSite = id => `packages/main/src/core/prompt-role-contract-registry.ts#${id}`;
  const rejection = (policies, ids = expected) => {
    const before = JSON.stringify([policies, ids]);
    let message;
    assert.throws(() => validate(policies, ids), error => {
      assert.ok(error instanceof promptRoleContracts.PromptRoleContractRegistryError);
      message = error.message;
      return true;
    });
    assert.equal(JSON.stringify([policies, ids]), before, 'policy rejection mutated its inputs');
    return message;
  };
  const singleton = { ...valid, [unknown]: {} };
  delete singleton[expected[0]];
  assert.equal(rejection(singleton), `unknown prompt role policy "${unknown}"; missing canonical policy source sites: ${JSON.stringify([sourceSite(expected[0])])}`);
  assert.equal(rejection({ ...valid, [unknown]: {} }), `unknown prompt role policy "${unknown}"`, 'extra unknown keys must not invent a missing canonical counterpart');
  const multiple = { ...singleton, 'unregistered-policy-two': {} };
  delete multiple[expected[1]];
  assert.equal(rejection(multiple), `unknown prompt role policy "${unknown}"; missing canonical policy source sites: ${JSON.stringify(expected.slice(0, 2).map(sourceSite))}`, 'multiple missing policies must be labeled as a set, not paired with an unknown key');
  const missingOnly = { ...valid };
  delete missingOnly[expected[0]];
  assert.equal(rejection(missingOnly), `missing prompt role policy "${expected[0]}"`);
  assert.equal(rejection({ ...valid, [unknown]: {} }, [...expected, expected[0]]), `prompt registry contains duplicate role "${expected[0]}"`, 'duplicate expected roles must still reject before unknown policies');
});

await check(['identity-cutover', 'identity-config-boundary', 'identity-policy-boundary', 'f050', 'round24'], 'CHK-007:adversarial:0 every registered identity boundary rejects through its public operation with zero mutation', () => {
  const registeredOperationPaths = ACTIVE_IDENTITY_OPERATION_BOUNDARIES
    .flatMap((boundary) => boundary.paths.map((registeredPath) => registeredPath.sourcePath));
  assert.equal(
    new Set(registeredOperationPaths).size,
    registeredOperationPaths.length,
    'each active identity source path must have exactly one public-operation owner',
  );
  assert.deepEqual(
    [...IDENTITY_CUTOVER_REQUIRED_PATHS].filter((path) => !registeredOperationPaths.includes(path)),
    [],
    'every required identity path must be exercised through a registered public operation',
  );
  assert.deepEqual(
    registeredOperationPaths.filter((path) => !IDENTITY_CUTOVER_REQUIRED_PATHS.includes(path)),
    [],
    'the public-operation matrix must not hide unreviewed source paths outside the required inventory',
  );

  const operationFixture = ensurePublicIdentityOperationFixture();
  const operationRuntimeRoot = operationFixture.root;
  const operationCliEnginePath = join(operationRuntimeRoot, 'packages', 'main', 'dist', 'cli-engine.js');
  const operationCliEngine = readFileSync(operationCliEnginePath, 'utf8');
  const rawIdentityPreflight = "        assertCanonicalActiveIdentityRuntime({ command: cmd || 'help', projectRoot: root0 });";
  assert.equal(
    operationCliEngine.split(rawIdentityPreflight).length - 1,
    1,
    'raw active-identity preflight ablation target drifted',
  );
  writeFileSync(
    operationCliEnginePath,
    operationCliEngine.replace(rawIdentityPreflight, '        // F-053 test ablation: prove the real command consumer rejects the injected identity.'),
  );
  const externalReadRoot = operationFixture.externalRoot;
  const operationEntrypoint = operationFixture.entrypoint;
  assertCanonicalPublicIdentityOperations(operationFixture, 'consumer preflight ablated');
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    assert.ok(
      Array.isArray(boundary.identitySites) && boundary.identitySites.length > 0,
      `${boundary.id}: identity-site registry is required`,
    );
    assert.ok(
      Array.isArray(boundary.pathBindings) && boundary.pathBindings.length > 0,
      `${boundary.id}: path-to-identity-site bindings are required`,
    );
    const ownedPaths = boundary.paths.map((entry) => entry.sourcePath).sort();
    const boundPaths = boundary.pathBindings.map((entry) => entry.sourcePath).sort();
    assert.deepEqual(boundPaths, ownedPaths, `${boundary.id}: every registered path must have exactly one named identity-site binding`);
    assert.equal(new Set(boundPaths).size, boundPaths.length, `${boundary.id}: duplicate path binding`);
    const siteIds = boundary.identitySites.map((site) => site.siteId);
    assert.equal(new Set(siteIds).size, siteIds.length, `${boundary.id}: duplicate identity site id`);
    for (const binding of boundary.pathBindings) {
      if (binding.classification === 'owned-site') {
        assert.ok(binding.siteIds.length > 0, `${boundary.id}/${binding.sourcePath}: owned-site path has no sites`);
        for (const siteId of binding.siteIds) {
          assert.ok(siteIds.includes(siteId), `${boundary.id}/${binding.sourcePath}: unknown identity site ${siteId}`);
          assert.equal(
            boundary.identitySites.find((site) => site.siteId === siteId)?.sourcePath,
            binding.sourcePath,
            `${boundary.id}/${binding.sourcePath}: owned identity site points at another path`,
          );
        }
      } else {
        assert.equal(binding.classification, 'identity-free', `${boundary.id}/${binding.sourcePath}: unknown path classification`);
        assert.match(
          binding.evidence ?? '',
          /type-only|no emitted identity|generated consumer/i,
          `${boundary.id}/${binding.sourcePath}: identity-free path needs mechanical evidence`,
        );
      }
    }
    assert.deepEqual(
      [...new Set(boundary.retiredIdentityCases.map((entry) => entry.siteId))].sort(),
      [...siteIds].sort(),
      `${boundary.id}: every identity site must have a canonical-to-retired public-operation mutation case`,
    );
    assert.ok(
      Array.isArray(boundary.retiredIdentityCases) && boundary.retiredIdentityCases.length > 0,
      `${boundary.id}: public-operation coverage must declare the boundary's actual canonical and retired identity values`,
    );
    const [defaultCommand, payload] = activeIdentityBoundaryOperation(boundary.id, 'B-49df');
    // Imported authorities require BOTH a consumer-expression mutation and an
    // origin-only mutation with the consuming expression left byte-identical.
    // The latter reproduced an actual accepted retired pinn_claim_check schema.
    for (const identityCase of boundary.retiredIdentityCases.flatMap(site => site.identityOrigin
      ? [site, { ...site, originMutation: true, sourceNeedle: site.canonical, retiredNeedle: site.retired }]
      : [site])) {
      // The focused selector retains registry validation and all canonical
      // controls; normal/full groups still execute every mutation unchanged.
      if (selectedGroup === 'identity-config-boundary' && identityCase.sourcePath !== 'packages/main/src/core/config.ts') continue;
      if (selectedGroup === 'identity-policy-boundary' && identityCase.sourcePath !== 'packages/main/src/core/prompt-role-contract-registry.ts') continue;
      const caseStartedAt = Date.now();
      assert.ok(siteIds.includes(identityCase.siteId), `${boundary.id}: mutation case has unknown siteId ${identityCase.siteId}`);
      assert.equal(
        boundary.identitySites.find((site) => site.siteId === identityCase.siteId)?.sourcePath,
        identityCase.sourcePath,
        `${boundary.id}/${identityCase.siteId}: mutation case must alter the registered identity-site owner`,
      );
      const command = identityCase.command ?? defaultCommand;
      assert.ok(boundary.commands.includes(command), `${boundary.id}: identity case command is not owned by the boundary: ${command}`);
      const registeredPath = boundary.paths.find((candidate) => candidate.sourcePath === identityCase.sourcePath);
      assert.ok(registeredPath, `${boundary.id}: identity case source is not owned by the boundary: ${identityCase.sourcePath}`);
      const base = registeredPath.scope === 'runtime-package'
        ? join(operationRuntimeRoot, 'packages', 'main')
        : operationRuntimeRoot;
      const injectedPath = identityCase.originMutation
        ? join(base, identityCase.identityOrigin.sourcePath.replace(/^packages\/main\/src\//u, 'dist/').replace(/\.ts$/u, '.js'))
        : join(base, registeredPath.path);
      const consumerBytes = readFileSync(join(base, registeredPath.path));
      assert.ok(existsSync(injectedPath), `${boundary.id}: registered runtime path missing: ${registeredPath.path}`);
      const canonicalBytes = readFileSync(injectedPath);
      const canonicalSource = canonicalBytes.toString('utf8');
      assert.ok(
        canonicalSource.includes(identityCase.sourceNeedle),
        `${boundary.id}/${registeredPath.sourcePath}: canonical identity source needle is not present: ${identityCase.sourceNeedle}`,
      );
      assert.notEqual(identityCase.retired, identityCase.canonical, `${boundary.id}: retired identity must differ`);
      assert.ok(['historical-retired', 'unsupported-family-control'].includes(identityCase.mutationKind), `${boundary.id}: identity mutation must disclose its provenance kind`);
      if (identityCase.mutationKind === 'historical-retired') {
        assert.equal(identityCase.retiredProvenance?.sourcePath, identityCase.identityOrigin?.sourcePath ?? identityCase.sourcePath, 'historical counterpart must belong to this exact source or bound imported origin');
        assert.equal(identityCase.retiredProvenance?.value, identityCase.retired, 'historical counterpart must match the injected value');
      } else {
        assert.equal(identityCase.retiredProvenance, undefined, 'constructed invalid-family control must not claim historical admission');
        assert.ok(identityCase.retired.startsWith('proofbound.') || identityCase.retired.startsWith('proofbound-'), `${boundary.id}: constructed control must name the unsupported family`);
      }
      assert.ok(
        canonicalSource.split(identityCase.sourceNeedle).length - 1 >= 1,
        `${boundary.id}/${identityCase.siteId}: identity source needle must occur`,
      );
      const exactNeedle = identityCase.sourceNeedle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const mutationPattern = identityCase.sourceNeedle === identityCase.canonical
        ? new RegExp(`(?<![a-zA-Z0-9._-])${exactNeedle}(?![a-zA-Z0-9._-])`, 'gu')
        : new RegExp(exactNeedle, 'gu');
      const injectedSource = canonicalSource.replace(mutationPattern, () => identityCase.retiredNeedle);
      assert.notEqual(injectedSource, canonicalSource, `${identityCase.siteId}: exact identity mutation must change bytes`);
      writeFileSync(injectedPath, injectedSource);
      if (identityCase.originMutation) assert.deepEqual(readFileSync(join(base, registeredPath.path)), consumerBytes, `${identityCase.siteId}: origin-only control changed the consumer expression`);
      const operationRoot = boundary.id === 'process-fact-registry' ? externalReadRoot : operationRuntimeRoot;
      const beforeOperation = snapshotPublicOperationState(operationRoot, operationRoot === operationRuntimeRoot ? ['B-49df'] : []);
      const rejected = runCli(operationRoot, command, payload, {}, { entrypoint: operationEntrypoint });
      assert.notEqual(
        rejected.status,
        0,
        `${boundary.id}/${registeredPath.sourcePath}: ${command} accepted ${identityCase.retired}`,
      );
      const diagnostic = `${rejected.stdout}${rejected.stderr}`;
      assert.ok(diagnostic.includes(identityCase.siteId) && diagnostic.includes(identityCase.retired) && diagnostic.includes(identityCase.canonical),
        `${boundary.id}/${identityCase.siteId}: ${command} did not identify the exact injected site, retired and canonical values:\n${diagnostic}`);
      assert.deepEqual(
        snapshotPublicOperationState(operationRoot, operationRoot === operationRuntimeRoot ? ['B-49df'] : []),
        beforeOperation,
        `${boundary.id}/${registeredPath.sourcePath}: ${command} changed Git, Story, lock, or runtime state`,
      );
      writeFileSync(injectedPath, canonicalBytes);
      process.stdout.write(`PASS exact public identity mutation ${identityCase.siteId} (${identityCase.originMutation ? 'origin-only' : 'consumer-source'}) elapsedMs=${Date.now() - caseStartedAt}\n`);
    }
  }
});

await check(['identity-cutover'], 'CHK-007:adversarial:1 mixed and lookalike identity families are rejected exactly', () => {
  assert.ok(identityCutoverFixture?.envelope, 'fresh canonical Prompt Envelope must exist');
  assert.ok(identityCutoverFixture?.boundaryRun, 'public ReviewRun boundary fixture must exist');
  const fixture = {
    root: freshFixture.root,
    storyId: freshFixture.storyId,
    storyDir: freshFixture.storyDir,
    eventsPath: join(freshFixture.storyDir, 'process-events.jsonl'),
    indexPath: join(freshFixture.storyDir, 'index.json'),
  };
  const canonicalEnvelopeBytes = readFileSync(join(freshFixture.storyDir, 'prompt-envelopes.json'));
  for (const value of [
    'proof-or-stop.prompt-envelope.v1 ',
    'Proof-or-stop.prompt-envelope.v1',
    'proof-or-stop.prompt-envelope.v0',
    'proof-or-stop.prompt-envelope.v1.1',
    'proof-or-stop。prompt-envelope.v1',
    `${retiredProtocolPrefix}prompt-envelope.v1`,
  ]) {
    assertReviewPassRejectsEnvelopeMutation({
      fixture,
      boundaryRun: identityCutoverFixture.boundaryRun,
      canonicalBytes: canonicalEnvelopeBytes,
      label: `persisted PromptEnvelope schema lookalike ${JSON.stringify(value)}`,
      mutate: (envelope) => {
        envelope.schemaVersion = value;
        envelope.envelopeId = promptEnvelope.computePromptEnvelopeId(envelope);
      },
    });
  }

  const reviewRunsPath = join(freshFixture.storyDir, 'review-runs.json');
  const canonicalRunsBytes = readFileSync(reviewRunsPath);
  const persistedLookalikeBoundaries = [
    ...identityLookalikes(currentDigestPrefix).map(({ kind, value }) => [
      `ReviewRun digest domain ${kind}`,
      (run) => {
        run.promptHash = digestWithIdentityPrefix(value, 'assembled-prompt.raw-utf8.v1', run.assembledPrompt);
        run._hash = reviewRunHashWithSalt(run, currentReviewRunSalt);
      },
    ]),
    ...identityLookalikes(currentReviewRunSalt).map(({ kind, value }) => [
      `ReviewRun signing salt ${kind}`,
      (run) => { run._hash = reviewRunHashWithSalt(run, value); },
    ]),
  ];
  assert.equal(persistedLookalikeBoundaries.length, 10, 'digest and salt matrices each cover five lookalike classes');
  for (const [label, mutate] of persistedLookalikeBoundaries) {
    assertReviewPassRejectsRunMutation({
      fixture,
      boundaryRun: identityCutoverFixture.boundaryRun,
      canonicalBytes: canonicalRunsBytes,
      label,
      mutate,
    });
  }

  const sources = identityCutoverSourceMap();
  assert.match(sources.get('packages/main/src/core/prompt-contracts.ts'), new RegExp(`${currentDigestPrefix.replaceAll('.', '\\.')}\\\\0`));
  assert.match(sources.get('packages/main/src/core/review-run.ts'), new RegExp(currentReviewRunSalt));
  assert.doesNotMatch(sources.get('packages/main/src/core/prompt-contracts.ts'), new RegExp(`${retiredProtocolPrefix}digest\\.v1`));
  assert.doesNotMatch(sources.get('packages/main/src/core/review-run.ts'), new RegExp(retiredReviewRunSalt));
});

await check(['identity-cutover', 'identity-inventory'], 'CHK-007:adversarial:2 producer consumer config and baseline inventory omissions are mutation-detected', () => {
  const sources = identityCutoverSourceMap();
  assertIdentityCutoverInventoryTotal(sources);
  const warmed = identityTextFactsCache.stats();
  assertIdentityCutoverInventoryTotal(sources);
  assert.deepEqual(identityTextFactsCache.stats(), warmed, 'unchanged full inventory must reuse only its pure text facts');
  const currentReviewed = identityCutoverReviewedContexts();
  const targetRow = currentReviewed.rows.find(row => sources.has(row.path));
  const targetWitness = currentReviewed.witnesses.find(row => sources.has(row.path));
  assert.ok(targetRow && targetWitness, 'live row and witness controls are required');
  for (const changed of [
    { ...targetRow, expectedOccurrences: targetRow.expectedOccurrences + 1 },
    { ...targetRow, contextSha256: '0'.repeat(64) },
  ]) {
    const reviewed = { ...currentReviewed, rows: currentReviewed.rows.map(row => row === targetRow ? changed : row) };
    assert.throws(() => assertIdentityCutoverInventoryTotal(sources, { reviewed }), /retired protocol identity exact (count|context) drift/, 'warmed byte facts must not cache row admission');
  }
  const changedWitnesses = { ...currentReviewed,
    witnesses: currentReviewed.witnesses.map(row => row === targetWitness ? { ...row, sha256: '0'.repeat(64) } : row) };
  assert.throws(() => assertIdentityCutoverInventoryTotal(sources, { reviewed: changedWitnesses }), /retired protocol identity witness integrity drift/, 'warmed byte facts must not cache witness admission');
  // Use an actual uniquely classified retired protocol row for the omitted-policy
  // control; removing a redundant row need not alter the admitted occurrence set.
  const protocolRow = currentReviewed.rows.find(row => sources.has(row.path)
    && new RegExp(retiredIdentityPattern.source, retiredIdentityPattern.flags).test(row.token)
    && !currentReviewed.rows.some(other => other !== row && other.path === row.path && other.token.includes(row.token))
    && !HISTORICAL_SCOPE_READER_IDENTITIES.some(([path, token]) => row.path === path && row.token === token)
    && row.path !== 'scripts/verify-proof-or-stop-identity-cutover.mjs');
  assert.ok(protocolRow, 'unique current classification control is required');
  const missingPolicyRow = { ...currentReviewed, rows: currentReviewed.rows.filter(row => row !== protocolRow) };
  assert.throws(() => assertIdentityCutoverInventoryTotal(sources, { reviewed: missingPolicyRow }), /retired protocol identity/, 'warmed facts must not cache classification membership');
  const diagnosticPath = 'packages/main/src/core/runtime-environment-checks.ts';
  const diagnosticToken = `${retiredProtocolPrefix}keyword-proposal.v1`;
  const diagnosticSource = sources.get(diagnosticPath);
  assert.ok(diagnosticSource.includes(`${diagnosticToken}.`), 'exact historical diagnostic sentence is required');
  for (const suffix of ['..', '.v99', ' .']) {
    const changedDiagnostic = new Map(sources);
    changedDiagnostic.set(diagnosticPath, diagnosticSource.replace(`${diagnosticToken}.`, `${diagnosticToken}${suffix}`));
    assert.throws(() => assertIdentityCutoverInventoryTotal(changedDiagnostic), /retired protocol identity exact context drift/,
      'sentence punctuation classification must not admit an altered diagnostic suffix or context');
  }
  for (const omitted of IDENTITY_CUTOVER_REQUIRED_PATHS) {
    const mutant = new Map(sources);
    mutant.delete(omitted);
    assert.throws(() => assertIdentityCutoverInventoryTotal(mutant), /identity inventory missing required path/, omitted);
  }
  assert.throws(() => assertIdentityCutoverInventoryTotal(new Map()), /identity inventory missing required path/);
  const synthetic = new Map(sources);
  synthetic.set('packages/main/src/core/synthetic-identity-producer.ts', `export const schemaVersion = '${retiredProtocolPrefix}synthetic.v1';`);
  assert.throws(() => assertIdentityCutoverInventoryTotal(synthetic), /retired protocol identity/);
  const fallback = new Map(sources);
  fallback.set('packages/main/src/core/prompt-contracts.ts', `${fallback.get('packages/main/src/core/prompt-contracts.ts')}\nif (value === '${retiredProtocolPrefix}fallback.v1') return value;`);
  assert.throws(() => assertIdentityCutoverInventoryTotal(fallback), /retired protocol identity/);
  const verifierFallback = new Map(sources);
  verifierFallback.set(
    'scripts/verify-proof-or-stop-identity-cutover.mjs',
    `${verifierFallback.get('scripts/verify-proof-or-stop-identity-cutover.mjs')}\nif (value === '${retiredProtocolPrefix}artifact-release.v1') return value;`,
  );
  assert.throws(() => assertIdentityCutoverInventoryTotal(verifierFallback), /retired protocol identity/);
  const [historicalPath, historicalToken] = HISTORICAL_SCOPE_READER_IDENTITIES[0];
  const missingHistoricalRow = new Map(sources);
  missingHistoricalRow.set(historicalPath, missingHistoricalRow.get(historicalPath).replace(historicalToken, 'proof-or-stop.removed-historical-row.v1'));
  assert.throws(() => assertIdentityCutoverInventoryTotal(missingHistoricalRow), /historical scope reader identity row drifted/);
  const duplicatedHistoricalRow = new Map(sources);
  duplicatedHistoricalRow.set(historicalPath, `${duplicatedHistoricalRow.get(historicalPath)}\n// ${historicalToken}`);
  assert.throws(() => assertIdentityCutoverInventoryTotal(duplicatedHistoricalRow), /historical scope reader identity row drifted/);
  const reviewed = identityCutoverReviewedContexts();
  const reviewedRows = reviewed.rows.filter(row => sources.has(row.path)
    && new RegExp(retiredIdentityPattern.source, retiredIdentityPattern.flags).test(row.token)
    && !HISTORICAL_SCOPE_READER_IDENTITIES.some(([path, token]) => row.path === path && row.token === token));
  assert.ok(reviewedRows.length > 0, 'reviewed negative/migration inventory must not be empty');
  for (const row of reviewedRows) {
    const original = sources.get(row.path);
    const line = original.split(/\r?\n/).find(value => value.includes(row.token));
    for (const [label, mutated] of [
      ['duplicate', `${original}\n${line}`],
      ['missing', original.replace(row.token, 'removed-reviewed-context')],
      ['context', original.replace(line, `${line} // changed reviewed context`)],
    ]) {
      const mutant = new Map(sources);
      mutant.set(row.path, mutated);
      assert.throws(() => assertIdentityCutoverInventoryTotal(mutant), /retired protocol identity|historical scope reader identity row drifted/, `${label}: ${row.path}:${row.token}`);
    }
    const moved = new Map(sources);
    moved.set('packages/main/src/core/synthetic-denial-context.ts', line);
    assert.throws(() => assertIdentityCutoverInventoryTotal(moved), /retired protocol identity/, `moved: ${row.path}:${row.token}`);
  }
  const verifierDataMutation = new Map(sources);
  const verifierPath = 'scripts/verify-proof-or-stop-identity-cutover.mjs';
  const dataLine = sources.get(verifierPath).split(/\r?\n/).find(line => new RegExp(`${retiredProtocolStem}[.:\\-][a-z0-9._:-]+`, 'i').test(line));
  verifierDataMutation.set(verifierPath, sources.get(verifierPath).replace(dataLine, `${dataLine} // changed data row`));
  assert.throws(() => assertIdentityCutoverInventoryTotal(verifierDataMutation), /retired protocol identity verifier data context drift/);
});

await check(['runtime'], 'F-004 real foreign reviewerWrite commands refuse before Story evidence', () => {
  const fixture = ensureRuntimeFixture();
  for (const command of ['init_check_set', 'review_run_start']) {
    const before = snapshotRuntimeState(fixture);
    const actor = command === 'init_check_set' ? 'proof-or-stop-review-story-init' : 'proof-or-stop-review-quality';
    const payload = command === 'init_check_set'
      ? { storyId: fixture.storyId, agentId: actor, issues: [] }
      : { storyId: fixture.storyId, agent: actor };
    const result = runCli(fixture.root, command, payload, { PROOF_OR_STOP_AGENT: actor });
    assert.notEqual(result.status, 0, command);
    assert.match(`${result.stdout}${result.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i, command);
    assertRuntimeFixtureUnchanged(fixture, before);
  }
});

await check(['runtime'], 'CHK-003 real foreign CLI refusal changes zero Story bytes/events/index/worktrees/refs [CHK-003:adversarial:0]', () => {
  const fixture = ensureRuntimeFixture();
  const { root, storyId } = fixture;
  const before = snapshotRuntimeState(fixture);
  const attempted = runCli(root, 'story_update', { storyId, title: 'MUTATED' });
  assert.notEqual(attempted.status, 0, 'foreign runtime Story writer must be refused');
  assert.match(`${attempted.stdout}${attempted.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i);
  assertRuntimeFixtureUnchanged(fixture, before);
});

await check(['runtime'], 'CHK-003:adversarial:1 synthetic writer omitted by partial admission makes contract verifier fail', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-process-fact-contract.mjs'), '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: 'synthetic-story-writer-partial-runtime-admission' },
  });
  assert.notEqual(result.status, 0, 'mutated partial admission contract must fail');
  assert.match(`${result.stdout}${result.stderr}`, /actual Story-write capability|Story runtime admission|coverage must derive from the effective ownership registry/i);
});

await check(['runtime'], 'F-013/F-014 omitting any current Story writer makes the contract verifier fail', () => {
  assert.ok(STORY_WRITE_CAPABILITY_COMMANDS.length > 0, 'current Story writer inventory must not be empty');
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-process-fact-contract.mjs'), '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_OMIT_STORY_WRITER: '*' },
  });
  assert.notEqual(result.status, 0, 'omitting the current Story-write capability inventory must fail');
  const output = `${result.stdout}${result.stderr}`;
  for (const command of STORY_WRITE_CAPABILITY_COMMANDS) {
    assert.match(output, new RegExp(`Story-write capability registry missing ${command}`, 'i'));
  }
});

await check(['runtime'], 'F-015 direct handler Story writes cannot escape the policy-derived inventory', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-process-fact-contract.mjs'), '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION: 'omit-direct-story-writer-effects' },
  });
  assert.notEqual(result.status, 0, 'removing direct handler Story-write effects must fail');
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /direct Story-writing handler agent_prompt is absent from the capability inventory/i);
  assert.match(output, /direct Story-writing handler evaluate is absent from the capability inventory/i);
});

await check(['runtime'], 'F-017 transitive helper Story writes cannot escape the policy-derived inventory', () => {
  const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-process-fact-contract.mjs'), '--quiet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_PROCESS_FACT_CONTRACT_OMIT_STORY_WRITER: 'dispatch' },
  });
  assert.notEqual(result.status, 0, 'omitting a transitive helper Story writer must fail');
  assert.match(`${result.stdout}${result.stderr}`, /transitive Story-writing handler dispatch is absent from the capability inventory/i);
});

await check(['runtime'], 'CHK-003:adversarial:2 explicit-root symlink nested-cwd and env bypasses all refuse unchanged', () => {
  const fixture = ensureRuntimeFixture();
  const nestedCwd = join(fixture.root, 'nested', 'cwd');
  mkdirSync(nestedCwd, { recursive: true });
  const symlinkedEntrypoint = join(fixture.root, 'linked-proof-or-stop.mjs');
  symlinkSync(cliPath, symlinkedEntrypoint);
  const variants = [
    { label: 'explicit --root', options: {} },
    { label: 'symlinked entrypoint', options: { entrypoint: symlinkedEntrypoint } },
    { label: 'nested cwd', options: { cwd: nestedCwd } },
    { label: 'global-fallback env', env: { PROOF_OR_STOP_CODEX_ENTRYPOINT: 'global-fallback' }, options: {} },
  ];
  for (const variant of variants) {
    // Bypass scaffolding is intentionally outside the baseline. The assertion
    // therefore isolates only the attempted Story mutation.
    const before = snapshotRuntimeState(fixture);
    const result = runCli(
      fixture.root,
      'story_update',
      { storyId: fixture.storyId, title: `BYPASS ${variant.label}` },
      variant.env,
      variant.options,
    );
    assert.notEqual(result.status, 0, variant.label);
    assert.match(`${result.stdout}${result.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i, variant.label);
    assertRuntimeFixtureUnchanged(fixture, before);
  }
});

let identityVerifierResult = null;
function runIdentityVerifier() {
  identityVerifierResult ??= spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return identityVerifierResult;
}

function identityVerifierFixtureEntrypoint(root) {
  // ESM canonicalizes import.meta.url, including macOS /var -> /private/var.
  // Match that identity so the actual scanner's main-entry guard executes.
  return realpathSync(join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'));
}

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

function materializeIdentityVerifierCheckout(root) {
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot && root !== mainRoot,
    'full verifier checkout is restricted to a generated disposable clone');
  const head = git(root, ['rev-parse', 'HEAD']);
  const index = git(root, ['ls-files', '--stage', '-z']);
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  // The complete tracked-text scanner needs every file, unlike the public
  // operation matrix whose snapshots deliberately observe absent inert logs.
  git(root, ['sparse-checkout', 'disable']);
  assert.equal(git(root, ['rev-parse', 'HEAD']), head, 'full verifier checkout changed HEAD');
  assert.equal(git(root, ['ls-files', '--stage', '-z']), index, 'full verifier checkout changed indexed paths, modes or blobs');
  assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), refs, 'full verifier checkout changed refs');
}

function createIdentityVerifierClone(prefix = 'proof-or-stop-b49df-real-verifier-') {
  const root = createPublicOperationClone(prefix);
  materializeIdentityVerifierCheckout(root);
  cpSync(
    join(repoRoot, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'),
    join(root, 'scripts', 'verify-proof-or-stop-identity-cutover.mjs'),
  );
  writeFileSync(
    join(root, 'scripts', 'verify-proof-or-stop-pack-boundary.mjs'),
    "process.exit(0);\n",
  );
  const verifierPath = identityVerifierFixtureEntrypoint(root);
  const verifier = spawnSync(process.execPath, [verifierPath], { cwd: root, encoding: 'utf8' });
  assert.equal(verifier.status, 0, `${verifier.stdout}${verifier.stderr}`);
  assert.match(verifier.stdout, /PASS identity-cutover/);
  return { root, verifierPath };
}

function createIdentityRedVerifierClone() {
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

function createDoneTransitionFixture(identityVerifierPath) {
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

const ACTIVE_STORY_IDENTITY_PATHS = Object.freeze([
  Object.freeze({ artifact: 'scope-boundary.json', path: 'schemaVersion', kind: 'schema' }),
  Object.freeze({ artifact: 'scope-boundary.json', path: 'confirmedBy', kind: 'command' }),
  Object.freeze({ artifact: 'execution-boundary.json', path: 'schemaVersion', kind: 'schema' }),
  Object.freeze({ artifact: 'execution-boundary.json', path: 'confirmedBy', kind: 'command' }),
  Object.freeze({ artifact: 'scope-freeze-check.json', path: 'schemaVersion', kind: 'schema' }),
  Object.freeze({ artifact: 'init-check.json', path: 'agentId', kind: 'agent' }),
  Object.freeze({ artifact: 'init-check.json', path: 'agentResults.*.agentId', kind: 'agent' }),
  Object.freeze({ artifact: 'index.json', path: 'events.*.agent', kind: 'agent' }),
  Object.freeze({ artifact: 'owner-lease.json', path: 'command', kind: 'command' }),
]);

function valuesAtPath(value, path) {
  const [head, ...tail] = path.split('.');
  if (head === '*') return Array.isArray(value) ? value.flatMap((item) => valuesAtPath(item, tail.join('.'))) : [];
  if (value === null || typeof value !== 'object' || !(head in value)) return [];
  return tail.length === 0 ? [value[head]] : valuesAtPath(value[head], tail.join('.'));
}

const ACTIVE_IDENTITY_KEYS = new Set(['schemaVersion', 'agentId', 'agent', 'role', 'command', 'environment', 'config', 'product', 'runtime', 'confirmedBy']);

function discoverActiveIdentityPaths(value, prefix = '') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((entry) => found.push(...discoverActiveIdentityPaths(entry, prefix ? `${prefix}.*` : '*')));
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (ACTIVE_IDENTITY_KEYS.has(key)) found.push(path);
    found.push(...discoverActiveIdentityPaths(entry, path));
  }
  return [...new Set(found)];
}

function assertIdentityInventoryComplete(artifacts) {
  const registered = new Set(ACTIVE_STORY_IDENTITY_PATHS.map((entry) => `${entry.artifact}:${entry.path}`));
  const discovered = [];
  for (const [artifact, value] of Object.entries(artifacts)) {
    for (const path of discoverActiveIdentityPaths(value)) discovered.push(`${artifact}:${path}`);
  }
  assert.deepEqual([...new Set(discovered)].sort(), [...registered].sort(), 'active identity field appeared outside the bounded registry');
}

function assertActiveArtifactIdentitiesCanonical(artifacts) {
  assertIdentityInventoryComplete(artifacts);
  for (const entry of ACTIVE_STORY_IDENTITY_PATHS) {
    for (const value of valuesAtPath(artifacts[entry.artifact], entry.path)) {
      assert.doesNotMatch(
        String(value),
        new RegExp(`${retiredProtocolStem}|${retiredBrandStem}`, 'i'),
        `${entry.artifact}:${entry.path}=${JSON.stringify(value)}`,
      );
    }
  }
}

await check(['inventory'], 'CHK-005:happy:0 fresh Story registered identity values are all canonical', () => {
  assert.ok(freshFixture, 'public CLI fresh Story fixture must be available');
  assertActiveArtifactIdentitiesCanonical(freshFixture.artifacts);
});

await check(['inventory'], 'CHK-005:happy:1 committed RED test predates GREEN production implementation', () => {
  const exactCommand = 'node packages/main/tests/canonical-new-story-artifacts.test.mjs';
  const result = spawnSync(process.execPath, [cliPath, '--root', repoRoot, 'red_evidence_get', JSON.stringify({ storyId: 'B-49df', json: true })], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_OR_STOP_SESSION_ID: 'sess-b49df-focused-red-reader',
      PROOF_OR_STOP_ACTIVITY_SOURCE: 'test',
      PROOF_OR_STOP_AGENT: 'proof-or-stop-implementer',
    },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const jsonStart = result.stdout.indexOf('{');
  assert.notEqual(jsonStart, -1, 'red_evidence_get did not return JSON');
  const redEvidence = JSON.parse(result.stdout.slice(jsonStart));
  const record = redEvidence.records.find((entry) =>
    entry.failingCommand === exactCommand
    && entry.expectedGreenCommand === exactCommand
    && entry.greenRelation?.command === exactCommand,
  );
  assert.ok(record, `missing committed RED evidence for exact focused command: ${exactCommand}`);
  assert.match(record.observedFailure, /F-001|F-002|F-004|F-005|F-006|F-007|F-008|F-009/);
  assert.doesNotThrow(() => git(repoRoot, ['cat-file', '-e', `${record.baselineHeadHash}^{commit}`]));
  assert.equal(git(repoRoot, ['merge-base', '--is-ancestor', record.baselineHeadHash, 'HEAD']), '');
});

await check(['inventory'], 'CHK-005:edge:0 registry is bounded and traversal covers nested repeated identity kinds', () => {
  assert.ok(Object.isFrozen(ACTIVE_STORY_IDENTITY_PATHS));
  assert.ok(ACTIVE_STORY_IDENTITY_PATHS.length > 0);
  assert.deepEqual([...ACTIVE_IDENTITY_KEYS].sort(), [
    'agent', 'agentId', 'command', 'config', 'confirmedBy', 'environment', 'product', 'role', 'runtime', 'schemaVersion',
  ]);
  const nested = {
    envelopes: [0, 1].map(() => ({
      schemaVersion: 'proof-or-stop.synthetic.v1',
      agent: 'proof-or-stop-implementer',
      agentId: 'proof-or-stop-review-story-init',
      role: 'proof-or-stop-review-quality',
      command: 'proof-or-stop validate',
      environment: 'local',
      config: 'proof-or-stop.config.json',
      product: 'Proof-or-Stop',
      runtime: 'proof-or-stop',
    })),
  };
  const discovered = discoverActiveIdentityPaths(nested);
  for (const key of ['schemaVersion', 'agent', 'agentId', 'role', 'command', 'environment', 'config', 'product', 'runtime']) {
    assert.ok(discovered.includes(`envelopes.*.${key}`), key);
    assert.equal(valuesAtPath(nested, `envelopes.*.${key}`).length, 2, `${key} must traverse repeated entries`);
  }
});

await check(['inventory'], 'CHK-005:edge:1 historical prose stays visible unchanged but outside active paths', () => {
  assert.ok(freshFixture, 'public CLI fresh Story fixture must be available');
  const artifact = structuredClone(freshFixture.artifacts['init-check.json']);
  artifact.historicalProvenance = ['Historical ', 'lat', 'tice wording remains visible.'].join('');
  const bytes = JSON.stringify(artifact);
  assert.equal(discoverActiveIdentityPaths(artifact).includes('historicalProvenance'), false);
  assert.match(artifact.historicalProvenance, new RegExp(['lat', 'tice'].join('')));
  assert.equal(JSON.stringify(artifact), bytes);
});

await check(['inventory'], 'CHK-005 bounded active identity paths reject retired values while ignoring historical prose [CHK-005:adversarial:0]', () => {
  assert.ok(Object.isFrozen(ACTIVE_STORY_IDENTITY_PATHS));
  assert.ok(freshFixture, 'public CLI fresh Story fixture must be available');
  const artifacts = structuredClone(freshFixture.artifacts);
  artifacts['init-check.json'].historicalProvenance = ['Historical ', 'lat', 'tice wording remains visible outside active identity paths.'].join('');
  assertActiveArtifactIdentitiesCanonical(artifacts);

  for (const entry of ACTIVE_STORY_IDENTITY_PATHS) {
    const mutantArtifacts = structuredClone(freshFixture.artifacts);
    const parts = entry.path.split('.');
    const mutate = (value, remaining) => {
      const [head, ...tail] = remaining;
      if (head === '*') { for (const item of value) mutate(item, tail); return; }
      if (tail.length === 0) { value[head] = ['lat', 'tice-injected'].join(''); return; }
      mutate(value[head], tail);
    };
    mutate(mutantArtifacts[entry.artifact], parts);
    assert.throws(
      () => assertActiveArtifactIdentitiesCanonical(mutantArtifacts),
      new RegExp(entry.path.replaceAll('*', '\\*').replaceAll('.', '\\.')),
    );
  }
});

await check(['inventory'], 'CHK-005 generated-artifact identity inventory is complete and mutation-sensitive', () => {
  assert.ok(freshFixture, 'public CLI fresh Story fixture must be available');
  assertIdentityInventoryComplete(freshFixture.artifacts);
  for (const entry of ACTIVE_STORY_IDENTITY_PATHS) {
    const mutantArtifacts = structuredClone(freshFixture.artifacts);
    const mutant = mutantArtifacts[entry.artifact];
    const path = entry.path.split('.');
    const mutate = (value, parts) => {
      const [head, ...tail] = parts;
      if (head === '*') { for (const item of value) mutate(item, tail); return; }
      if (tail.length === 0) { value[head] = ['lat', 'tice-injected'].join(''); return; }
      mutate(value[head], tail);
    };
    mutate(mutant, path);
    assert.throws(
      () => assertActiveArtifactIdentitiesCanonical(mutantArtifacts),
      new RegExp(entry.path.replaceAll('*', '\\*').replaceAll('.', '\\.')),
      `${entry.artifact}:${entry.path} mutation must be rejected by the production-shaped scanner`,
    );
  }
});

await check(['inventory'], 'CHK-005:adversarial:1 synthetic unregistered identity field fails completeness comparison', () => {
  assert.ok(freshFixture, 'public CLI fresh Story fixture must be available');
  const artifacts = structuredClone(freshFixture.artifacts);
  artifacts['scope-boundary.json'].runtime = ['lat', 'tice-runtime'].join('');
  assert.throws(
    () => assertIdentityInventoryComplete(artifacts),
    /active identity field appeared outside the bounded registry.*scope-boundary\.json:runtime/is,
  );
  const omittedArtifact = structuredClone(freshFixture.artifacts);
  omittedArtifact['synthetic-runtime.json'] = { runtime: ['lat', 'tice-runtime'].join('') };
  assert.throws(
    () => assertIdentityInventoryComplete(omittedArtifact),
    /active identity field appeared outside the bounded registry.*synthetic-runtime\.json:runtime/is,
  );
});

await check(['inventory'], 'CHK-005:adversarial:2 independent boundary failures and final identity verification coexist', () => {
  assert.ok(freshFixture, 'public CLI fresh Story fixture must be available');
  assert.equal(runIdentityVerifier().status, 0);

  const initBefore = initArtifactAndRefs(freshFixture.root, freshFixture.storyDir);
  const retiredReviewerAttempt = runCli(
    freshFixture.root,
    'init_check_set',
    { storyId: freshFixture.storyId, issues: [], agentId: retiredInitActor },
    { PROOF_OR_STOP_AGENT: retiredInitActor },
  );
  assert.notEqual(retiredReviewerAttempt.status, 0);
  assert.match(`${retiredReviewerAttempt.stdout}${retiredReviewerAttempt.stderr}`, /unknown|retired|not permitted|mutation_denied/i);
  assertInitArtifactAndRefsUnchanged(freshFixture.root, freshFixture.storyDir, initBefore);

  const foreignFixture = createRuntimeFixture();
  const foreignBefore = snapshotRuntimeState(foreignFixture);
  const foreignMutation = runCli(foreignFixture.root, 'story_update', {
    storyId: foreignFixture.storyId,
    title: 'Retired foreign runtime must not mutate',
  });
  assert.notEqual(foreignMutation.status, 0);
  assert.match(`${foreignMutation.stdout}${foreignMutation.stderr}`, /foreign_self_project_runtime_for_story_write|runtime mismatch|different self-project checkout/i);
  assertRuntimeFixtureUnchanged(foreignFixture, foreignBefore);

  assert.equal(scopeBoundaryHashIsFresh({ ...canonicalBoundary, _hash: 'tampered' }), false);

  const store = new StoryStore(freshFixture.root);
  const story = store.readStory(freshFixture.storyId);
  story.phase = 'REVIEW';
  story.currentReviewRound = NOW;
  store.writeStory(freshFixture.storyId, story);
  git(freshFixture.root, ['add', '-f', '.proof-or-stop']);
  git(freshFixture.root, ['commit', '-m', 'seed persisted review signature boundary']);
  retainHistoricalImplementationPrerequisite(freshFixture.root);
  const dispatched = runCli(freshFixture.root, 'dispatch', {
    storyId: freshFixture.storyId,
    agentType: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(dispatched.status, 0, `${dispatched.stdout}${dispatched.stderr}`);
  const started = runCli(freshFixture.root, 'review_run_start', {
    storyId: freshFixture.storyId,
    agent: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
  const reviewRunsPath = join(freshFixture.storyDir, 'review-runs.json');
  const persistedRuns = JSON.parse(readFileSync(reviewRunsPath, 'utf8'));
  const tamperedRun = persistedRuns.runs.at(-1);
  tamperedRun._hash = reviewRunHashWithSalt(tamperedRun, retiredReviewRunSalt);
  writeFileSync(reviewRunsPath, `${JSON.stringify(persistedRuns, null, 2)}\n`);
  const passPath = join(freshFixture.storyDir, 'review-passes.json');
  const passBytesBefore = existsSync(passPath) ? readFileSync(passPath) : null;
  const tamperedRunBytesBefore = readFileSync(reviewRunsPath);
  const tamperedSubmission = runCli(freshFixture.root, 'review_pass_set', {
    storyId: freshFixture.storyId,
    agent: 'proof-or-stop-review-quality',
    reviewRunId: tamperedRun.reviewRunId,
    note: 'A retired-salt persisted ReviewRun must never authorize a reviewer pass.',
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(tamperedSubmission.status, 0);
  assert.match(`${tamperedSubmission.stdout}${tamperedSubmission.stderr}`, /invalid|signature|tampered|review run/i);
  assert.deepEqual(readFileSync(reviewRunsPath), tamperedRunBytesBefore);
  assert.deepEqual(existsSync(passPath) ? readFileSync(passPath) : null, passBytesBefore);

  const synthetic = structuredClone(freshFixture.artifacts['scope-boundary.json']);
  synthetic.runtime = ['lat', 'tice-runtime'].join('');
  assert.ok(discoverActiveIdentityPaths(synthetic).includes('runtime'));
  assert.match(freshFixture.artifacts['init-check.json'].agentResults[0].agentId, /^(?:proof-or-stop-product-reviewer|proof-or-stop-review-story-init)$/);
  const releaseRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-release-boundary-'));
  fixtureRoots.push(releaseRoot);
  mkdirSync(join(releaseRoot, '.proof-or-stop'), { recursive: true });
  writeFileSync(artifactReleaseLedgerPath(releaseRoot), `${JSON.stringify({ schemaVersion: `${retiredProtocolPrefix}artifact-release.v1` })}\n`);
  assert.throws(() => readArtifactReleaseLedger(releaseRoot), /unsupported identity schema/i);
});

await check(['identity-cutover', 'memory-identity'], 'CHK-007 finish-decision unsupported identity diagnostics reach the real DONE guard and oracle [CHK-007:adversarial:0] [CHK-007:edge:0]', () => {
  const result = spawnSync(process.execPath, [join(distRoot, 'tasks/dev-memory-lifecycle-gates-smoke.js'), '--finish-schema-only'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /finish-decision identity diagnostic smoke passed:/);
});

await check(['memory-identity'], 'normal memory selection excludes retired identities while audit bytes stay immutable', async () => {
  const memory = await import('../dist/core/dev-memory.js');
  const runtime = await import('../dist/core/playbook-runtime-memory.js');
  const cache = await import('../dist/core/playbook-runtime-memory-cache.js');
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-identity-'));
  fixtureRoots.push(root);
  const path = memory.resolveProjectMemoryPath(root);
  const input = { category: 'pattern', scope: 'project', sourceAgent: 'proof-or-stop-implementer',
    summary: 'Canonical memory identity example', trigger: 'memory fixture',
    lesson: 'Use proof-or-stop.config.json for memory configuration.', reusePrompt: 'Read the canonical memory example.' };
  const canonical = memory.createEntry(input);
  const retired = { ...canonical, id: 'retired1', lesson: `${['Proof', 'bound'].join('')} memory instruction` };
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(canonical)}\n${JSON.stringify(retired)}\n`;
  writeFileSync(path, bytes);
  assert.equal(memory.readEntries(path).length, 2, 'audit-only reader preserves both historical records');
  assert.deepEqual(memory.readProjectMemoryEntries(root).map(entry => entry.id), [canonical.id]);
  const pack = runtime.buildMemoryFreshnessPack({ projectRoot: root, query: 'memory', useIndex: false, useCache: false, maxPlaybooks: 0 });
  assert.equal(pack.items.devMemory.some(entry => entry.id === retired.id), false);
  assert.doesNotMatch(runtime.renderMemoryFreshnessPack(pack), /proofbound|lattice/iu);
  const tampered = structuredClone(pack);
  tampered.items.devMemory[0].lesson = retired.lesson;
  assert.doesNotMatch(runtime.renderMemoryFreshnessPack(tampered), /proofbound|lattice/iu,
    'a stale or tampered cached pack cannot bypass the final rendering boundary');
  const context = { projectRoot: root, schemaVersion: pack.schemaVersion, query: 'memory',
    consumer: 'session-brief', touchedPaths: [], maxEntries: 5, maxPlaybooks: 0, maxLines: 30 };
  cache.clearRuntimeMemoryPackCache();
  cache.rememberRuntimeMemoryPackCache(context, tampered);
  assert.equal(cache.getRuntimeMemoryPackCacheStats().entries, 0, 'retired pack is never cached');
  assert.equal(cache.getRuntimeMemoryPackCacheStats().durableWrites, 0, 'retired pack is never persisted');
  const key = cache.rememberRuntimeMemoryPackCache(context, pack);
  assert.equal(cache.getRuntimeMemoryPackCacheHit(context).hit, true, 'canonical pack cache still works');
  const { resolveLearningDir } = await import('../dist/core/learning-store.js');
  const cachePath = join(resolveLearningDir(root), 'runtime-memory-pack-cache', `${key.lookupDigest}.json`);
  const stored = JSON.parse(readFileSync(cachePath, 'utf8'));
  stored.pack = tampered;
  const corruptBytes = `${JSON.stringify(stored)}\n`;
  writeFileSync(cachePath, corruptBytes);
  cache.clearRuntimeMemoryPackCache();
  assert.deepEqual(cache.getRuntimeMemoryPackCacheHit(context), { hit: false, reason: 'noncanonical-identity' },
    'a persisted retired pack never becomes a fresh cache hit');
  assert.equal(readFileSync(cachePath, 'utf8'), corruptBytes, 'rejecting a historical cache does not rewrite it');
  assert.equal(readFileSync(path, 'utf8'), bytes, 'selection/rendering never rewrites historical memory');
});

await check(['memory-identity'], 'new memory writers reject retired product tokens before filesystem mutation', async () => {
  const memory = await import('../dist/core/dev-memory.js');
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-writer-'));
  fixtureRoots.push(root);
  const path = join(root, 'absent', 'experience.jsonl');
  const input = { category: 'pattern', scope: 'project', sourceAgent: 'proof-or-stop-implementer',
    summary: 'Canonical memory identity example', trigger: 'memory fixture',
    lesson: 'A superlattice and proofboundless token is not the product identity.', reusePrompt: 'Read the canonical memory example.' };
  const canonical = memory.createEntry(input);
  for (const token of [['lat', 'tice.config.json'].join(''), ['PROOF', 'BOUND'].join('')]) {
    assert.throws(() => memory.createEntry({ ...input, lesson: `Use ${token} for memory.` }), /canonical.*identity|canonical.*identities/i);
    assert.throws(() => memory.appendEntry(path, { ...canonical, sourceAgent: token }), /canonical.*identity|canonical.*identities/i);
    assert.equal(existsSync(dirname(path)), false, 'rejected append must not create even a parent directory');
  }
  memory.appendEntry(path, canonical);
  assert.equal(memory.readEntries(path).length, 1, 'canonical identity and unrelated substrings remain writable');
});

await check(['runtime'], 'retired generated cache inventory is deny-only and never hides historical Story evidence', async () => {
  const registry = await import('../dist/core/runtime-artifact-registry.js');
  const entry = registry.RUNTIME_ARTIFACT_REGISTRY.find(item => item.id === 'retired-generated-cache-deny-only');
  assert.ok(entry);
  const retiredRoot = '.' + ['lat', 'tice'].join('');
  const paths = [
    `${retiredRoot}/runtime/host-runs/probe.json`,
    `${retiredRoot}/learning/runtime-memory-pack-cache/probe.json`,
    `${retiredRoot}/runtime/framework-audit/state.json`,
    ...['finding-signals.json', 'playbook-promotion-health.jsonl', 'playbooks.json', 'signature-registry.json']
      .map(file => `${retiredRoot}/learning/${file}`),
  ];
  assert.equal(entry.ignorePatterns.length, 7);
  assert.equal(entry.repairableTrackedArtifact, false, 'deny-only is not a runtime repair/read alias');
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-cache-ignore-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), entry.ignorePatterns.join('\n') + '\n');
  for (const path of paths) {
    assert.equal(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 0, path);
  }
  for (const path of [`${retiredRoot}/story/actives/B-1234/index.json`, `${retiredRoot}/dev-memory/experience.jsonl`,
    `${retiredRoot}/learning/unclassified.json`, `${retiredRoot}/runtime/framework-audit/other.json`]) {
    assert.notEqual(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 1, path);
  }
});

await check(['runtime'], 'causal receipt runtime classification does not admit a retired Story subtree', async () => {
  const registry = await import('../dist/core/runtime-artifact-registry.js');
  const suffix = '/story/actives/B-1234/causal-evidence/receipt.json';
  const retiredPath = '.' + ['lat', 'tice'].join('') + suffix;
  assert.equal(registry.findRuntimeArtifactEntry(retiredPath), undefined);
  assert.equal(registry.isMaterialExcludedRuntimeArtifactPath(retiredPath), false);
  assert.equal(registry.isRepairableTrackedRuntimeArtifactPath(retiredPath), false);
  assert.equal(registry.findRuntimeArtifactEntry('.proof-or-stop' + suffix)?.id, 'runtime-causal-evidence-receipts');
});

await check(['runtime'], 'exact retired root imports are deny-only and cannot widen into current config or scratch authority', async () => {
  const registry = await import('../dist/core/runtime-artifact-registry.js');
  const entry = registry.RUNTIME_ARTIFACT_REGISTRY.find(item => item.id === 'retired-root-import-residue-deny-only');
  assert.ok(entry);
  const retiredConfig = ['lat', 'tice.config.json'].join('');
  const scratchReadManifest = '.remember-scratch-readmanifest.json';
  assert.deepEqual(entry.ignorePatterns, [`/${retiredConfig}`, `/${scratchReadManifest}`]);
  assert.equal(entry.matchers.length, 2, 'root residue inventory stays exact rather than prefix-based');
  assert.equal(entry.materialHash, 'exclude');
  assert.equal(entry.repairableTrackedArtifact, false, 'deny-only roots are not runtime repair/read aliases');

  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-root-residue-ignore-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), entry.ignorePatterns.join('\n') + '\n');
  for (const path of [retiredConfig, scratchReadManifest]) {
    assert.equal(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 0, path);
  }
  for (const path of ['proof-or-stop.config.json', '.remember-scratch-other.json', `nested/${retiredConfig}`]) {
    assert.notEqual(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 1, path);
  }
});

await check(['runtime'], 'canonical config changes force full validation while retired config drift remains conservative', async () => {
  const { classifyFullValidationReasons } = await import('../dist/core/story-aware-validation.js');
  const reasonsFor = path => classifyFullValidationReasons({ scopeViolations: [], changedFiles: [{ path }] });
  assert.deepEqual(
    reasonsFor('proof-or-stop.config.json'),
    ['validation-runtime-changed:proof-or-stop.config.json'],
    'the active project config must never miss explicit full-validation escalation',
  );
  const retiredConfig = ['lat', 'tice.config.json'].join('');
  assert.deepEqual(
    reasonsFor(retiredConfig),
    [`validation-runtime-changed:${retiredConfig}`],
    'a retired config path remains a conservative invalidation input, not an accepted config reader',
  );
  assert.deepEqual(reasonsFor('docs/requirements/example.md'), []);
});

await check(['runtime'], 'audit scanners reject retired executable identity before canonical help, ignored commands, or deduplication', async () => {
  const auditUrl = new URL('../dist/core/audit-scan.js', import.meta.url);
  const audit = await import(auditUrl.href);
  const retiredBin = 'lattice'; // Explicit negative input; never an executable alias.
  const assertRejected = scanner => {
    for (const method of ['scanCommandDrift', 'scanFlagDrift']) {
      for (const cmd of ['validate', 'help', 'init', 'audit_config_set']) {
        let calls = 0;
        const report = scanner[method](`${retiredBin} ${cmd} --json`, 'README.md', {
          runHelp: () => { calls += 1; return { ok: true, output: '--json' }; },
        });
        assert.equal(report.drifts.length, 1, `${method} must reject the retired bin even when the canonical command exists`);
        assert.equal(report.drifts[0].symbol, `${retiredBin} ${cmd}`);
        assert.match(report.drifts[0].evidence, /retired-bin/);
        assert.equal(calls, 0, 'retired identity is rejected before probing canonical help');
      }
      let calls = 0;
      const mixed = scanner[method](`proof-or-stop validate --json\n${retiredBin} validate --json`, 'README.md', {
        runHelp: () => { calls += 1; return { ok: true, output: '--json' }; },
      });
      assert.equal(mixed.drifts.length, 1, 'a prior canonical success cannot de-duplicate away retired identity');
      assert.equal(calls, 1);
      assert.equal(scanner[method]('proof-or-stop validate --json', 'README.md', {
        runHelp: () => ({ ok: true, output: '--json' }),
      }).drifts.length, 0, 'canonical positive remains accepted');
    }
  };
  assertRejected(audit);
  const source = readFileSync(auditUrl, 'utf8');
  const guard = 'bin === RETIRED_AUDIT_BIN_TOKEN';
  assert.equal(source.split(guard).length - 1, 2, 'both public scanners must guard retired identity');
  const mutantCode = source.replaceAll(guard, 'false')
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, before, path, after) => `${before}${new URL(path, auditUrl).href}${after}`);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantCode).toString('base64')}`);
  assert.throws(() => assertRejected(mutant), /must reject the retired bin/,
    'removing the production identity guards must make the same rejection contract fail');
});

function artifactAppendFixture() {
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

await check(['artifact-append', 'release', 'identity-cutover'], 'artifact append accepts canonical records and preserves canonical idempotency', () => {
  const { root, record, file } = artifactAppendFixture();
  assert.deepEqual(appendArtifactReleaseRecord(root, record), { status: 'recorded', record });
  assert.deepEqual(readArtifactReleaseLedger(root), [record]);
  const bytes = readFileSync(file);
  assert.deepEqual(appendArtifactReleaseRecord(root, record), { status: 'already_recorded', record });
  assert.deepEqual(readFileSync(file), bytes);
});

const artifactAppendMutations = [
  ['retired schema', record => ({ ...record, schemaVersion: record.schemaVersion.replace(/^proof-or-stop\./, retiredProtocolPrefix) })],
  ...identityLookalikes(ARTIFACT_RELEASE_SCHEMA_VERSION).map(({ kind, value }) => [
    `${kind} schema`, record => ({ ...record, schemaVersion: value }),
  ]),
  ['missing schema', ({ schemaVersion: _schemaVersion, ...record }) => record],
  ['invalid shape', record => ({ ...record, paths: null })],
];
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

// A Git clone shares objects, not the repository-local non-authority signing
// key. Keep the real committed receipts: copy the actual PRIVATE key only into
// this process's disposable, private fixture; never re-sign or weaken readers.
function fixtureFindingKeyPath(root) {
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

function writeFixtureFindingPrivateKey(root, bytes) {
  const target = fixtureFindingKeyPath(root);
  const fd = openSync(target, 'wx', 0o600); // Never replace an existing trust root.
  fixtureFindingKeyTargets.set(root, target);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  assert.equal(statSync(target).mode & 0o777, 0o600, 'Fixture private key must remain mode 0600');
  assert.ok(readFileSync(target).equals(Buffer.from(bytes)), 'Fixture private-key copy must be exact');
  return target;
}

function installFixtureFindingLedgerPrivateKey(root) {
  const source = join(commonGitDir, 'proof-or-stop-finding-ledger-v1.key');
  assert.ok(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'The current repository non-authority private key must be a regular file');
  const sourceBytes = readFileSync(source);
  const target = writeFixtureFindingPrivateKey(root, sourceBytes);
  assert.ok(readFileSync(source).equals(sourceBytes), 'Installing fixture trust must not change the source private key');
  return target;
}

function cleanupFixtureFindingKeys() {
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

await check(['finding-trust', 'identity-cutover'], 'committed Finding receipts require the actual fixture trust and reject missing or different keys', () => {
  const trustStoryId = 'B-29bc';
  const sourceKey = join(commonGitDir, 'proof-or-stop-finding-ledger-v1.key');
  const sourceKeyBytes = readFileSync(sourceKey);
  const sourceStore = new StoryStore(repoRoot);
  const sourceLedger = sourceStore.findingLedgerPath(trustStoryId);
  const sourceLedgerBytes = readFileSync(sourceLedger);
  const sourceHead = git(repoRoot, ['rev-parse', 'HEAD']);
  const root = createPublicOperationClone('proof-or-stop-finding-trust-', false);
  const fixtureRefs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const assertFixtureRefsUnchanged = () => assert.equal(
    git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), fixtureRefs,
    'Private fixture refs must remain unchanged',
  );
  const store = new StoryStore(root);
  const ledger = store.findingLedgerPath(trustStoryId);
  const ledgerBytes = readFileSync(ledger);
  const payload = { storyId: trustStoryId, role: 'proof-or-stop-review-quality', json: true };
  const readContext = () => runCli(root, 'review_incremental_context', payload, {}, { entrypoint: join(root, 'packages/main/dist/cli.js') });
  const assertRefused = label => {
    assert.throws(() => store.readFindings(trustStoryId), /FINDING_LEDGER_AUTHORITY_INVALID/, `${label}: production reader must authenticate the original receipt`);
    const result = readContext();
    assert.notEqual(result.status, 0, `${label}: public CLI must reject unauthenticated receipts`);
    assert.match(`${result.stdout}${result.stderr}`, /FINDING_LEDGER_AUTHORITY_INVALID/);
    process.stdout.write(`PASS Finding fixture trust rejection: ${label}\n`);
  };
  assertRefused('missing key before repair');
  const target = installFixtureFindingLedgerPrivateKey(root);
  assert.throws(() => installFixtureFindingLedgerPrivateKey(root), { code: 'EEXIST' }, 'Never overwrite an existing fixture key');
  assert.ok(store.readFindings(trustStoryId).findings.length > 0, 'Real authenticated Finding projection must be nonempty');
  const admitted = readContext();
  assert.equal(admitted.status, 0, `${admitted.stdout}${admitted.stderr}`);
  assertCanonicalOperationResponse('review_incremental_context', payload, root, admitted.stdout);
  process.stdout.write('PASS Finding fixture trust: original receipts authenticate with the real repository key\n');
  rmSync(target);
  assertRefused('removed copied key');
  writeFixtureFindingPrivateKey(root, `${randomBytes(32).toString('base64')}\n`);
  assertRefused('different fixture key');
  assert.ok(readFileSync(ledger).equals(ledgerBytes), 'Fixture original receipt bytes must remain untouched');
  assert.ok(readFileSync(sourceLedger).equals(sourceLedgerBytes), 'Source Finding ledger bytes must remain untouched');
  assert.ok(readFileSync(sourceKey).equals(sourceKeyBytes), 'Source private-key bytes must remain untouched');
  // Other active worktrees and the host may change unrelated shared refs. The
  // helper only reads the source key; only the disposable clone receives writes.
  assert.equal(git(repoRoot, ['rev-parse', 'HEAD']), sourceHead, 'Fixture trust must not alter the current Story HEAD');
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

// F-105: real extension declarations must share both runtime-admission stages;
// an intrinsic write class cannot depend on membership in the built-in names.
function prepareExternalRuntimeProbe(fixture, ownership, enginePath = join(distRoot, 'cli-engine.js')) {
  const command = `b49df_extension_${ownership.toLowerCase()}_probe`;
  const entrypoint = join(fixture.root, 'extension-runtime-probe.mjs');
  const markers = Object.fromEntries(['registration', 'hook', 'handler'].map(stage => [stage, join(fixture.root, `extension-${stage}.txt`)]));
  const hookPath = join(fixture.root, 'extension-hook.mjs');
  writeFileSync(hookPath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markers.hook)}, 'hook reached');\n`);
  const configPath = join(fixture.root, 'proof-or-stop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.hooks = { preCommand: { [command]: [`${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`] } };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  writeFileSync(entrypoint, `
import { runCli } from ${JSON.stringify(enginePath)};
import { writeFileSync } from 'node:fs';
const name = ${JSON.stringify(command)};
const ownership = ${JSON.stringify(ownership)};
await runCli({
  extraTools: [{ name, description: 'Fresh F-105 runtime-admission extension witness', schema: {} }],
  extraOwnershipClasses: { [name]: ownership },
  extraAllowedPhases: { [name]: 'all' },
  extraRegister(registry) {
    if (ownership !== 'readOnly') writeFileSync(${JSON.stringify(markers.registration)}, ownership);
    registry.register(name, () => {
      if (ownership !== 'readOnly') writeFileSync(${JSON.stringify(markers.handler)}, ownership);
      return 'F105_EXTENSION_HANDLER_REACHED';
    });
  },
});
`);
  return { command, entrypoint, markers };
}

for (const ownership of ['reviewerWrite', 'storyScopedMutating']) {
  await check(['runtime'], `F-105 foreign runtime rejects declared extension ${ownership} before all writes`, () => {
    const fixture = createRuntimeFixture();
    const probe = prepareExternalRuntimeProbe(fixture, ownership);
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, probe.command, {}, {}, { entrypoint: probe.entrypoint });
    const output = `${result.stdout}${result.stderr}`;
    // Report the genuine handler observation even when the broken admission
    // predicate makes the first assertion fail; do not replace it with a mock.
    assert.equal(result.status, 1, `${ownership} must refuse a foreign runtime before registration/hooks/handler: ${output}`);
    assert.match(output, /foreign_self_project_runtime_for_story_write/);
    assert.match(output, /node .*proof-or-stop|repair|local.*runtime/i);
    for (const [stage, path] of Object.entries(probe.markers)) assert.equal(existsSync(path), false, `${stage} ran before runtime refusal`);
    assertRuntimeFixtureUnchanged(fixture, before);
  });
}

await check(['runtime'], 'F-105 raw and final effective extension ownership share the authoritative predicate', async () => {
  const { resolveRawRuntimeAdmissionOwnership } = await import(join(distRoot, 'cli/ownership-gate.js'));
  const topology = ensureRuntimeTopologyFixture();
  for (const ownership of ['reviewerWrite', 'storyScopedMutating', 'readOnly']) {
    const command = `b49df_extension_${ownership.toLowerCase()}_probe`;
    const declarations = { [command]: ownership };
    assert.equal(Object.hasOwn(COMMAND_POLICIES, command), false, 'witness must not be a built-in command');
    const raw = resolveRawRuntimeAdmissionOwnership(command, ['{}'], declarations);
    const effective = resolveEffectiveOwnershipClass(command, {}, 'B-fixture', declarations);
    assert.equal(raw, ownership);
    assert.equal(effective, ownership);
    assert.equal(commandRequiresAuthoritativeRuntime(command, raw), ownership !== 'readOnly');
    const finalAdmission = () => enforceStoryRuntimeAdmission({
      ...runtimeTopologyInput(command, topology.main, topology.linked), effectiveOwnership: effective,
    });
    if (ownership === 'readOnly') assert.doesNotThrow(finalAdmission);
    else assert.throws(finalAdmission, /foreign_self_project_runtime_for_story_write/);
  }
});

await check(['runtime'], 'F-105 real extension writers remain usable in matching runtimes and external consumers', () => {
  for (const topology of ['matching', 'consumer']) {
    const fixture = createRuntimeFixture();
    let enginePath = join(distRoot, 'cli-engine.js');
    if (topology === 'matching') {
      cpSync(packageRoot, join(fixture.root, 'packages', 'main'), { recursive: true });
      cpSync(join(repoRoot, 'proof-or-stop.config.json'), join(fixture.root, 'proof-or-stop.config.json'));
      symlinkSync(join(repoRoot, 'node_modules'), join(fixture.root, 'node_modules'), 'dir');
      enginePath = join(fixture.root, 'packages', 'main', 'dist', 'cli-engine.js');
    } else {
      writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ name: 'f105-external-consumer', type: 'module' }));
      writeFileSync(join(fixture.root, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@fixture/core', type: 'module' }));
    }
    for (const ownership of ['reviewerWrite', 'storyScopedMutating']) {
      const probe = prepareExternalRuntimeProbe(fixture, ownership, enginePath);
      for (const path of Object.values(probe.markers)) if (existsSync(path)) rmSync(path);
      const result = runCli(fixture.root, probe.command, {}, {}, { entrypoint: probe.entrypoint });
      assert.equal(result.status, 0, `${topology}/${ownership}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /F105_EXTENSION_HANDLER_REACHED/);
      for (const [stage, path] of Object.entries(probe.markers)) assert.ok(existsSync(path), `${topology}/${ownership}: ${stage} must be genuinely reached`);
    }
  }
});

await check(['runtime'], 'F-105 read-only extension remains available through a foreign runtime without writes', () => {
  const fixture = createRuntimeFixture();
  const probe = prepareExternalRuntimeProbe(fixture, 'readOnly');
  const before = snapshotRuntimeState(fixture);
  const result = runCli(fixture.root, probe.command, {}, {}, { entrypoint: probe.entrypoint });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /F105_EXTENSION_HANDLER_REACHED/);
  for (const path of Object.values(probe.markers)) assert.equal(existsSync(path), false, 'read-only extension must not run writing hooks or marker writes');
  assertRuntimeAuthoritativeStateUnchanged(fixture, before);
});

if (failures.length > 0) {
  process.stderr.write(`\nRED B-49df: ${failures.length} focused contract(s) failing.\n`);
  process.exitCode = 1;
} else {
  const selection = selectedGroup === null ? 'all focused contracts' : `${selectedGroup} group`;
  process.stdout.write(`\nGREEN B-49df: ${selection} pass.\n`);
}

for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
