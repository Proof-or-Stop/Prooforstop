


import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';



import ts from 'typescript';



import { git, initRepo, runCli } from "./fixture-support.mjs";
import { runtimeArtifactRegistry, INERT_PUBLIC_FIXTURE_LOG_SUBTREE, repoRoot, fixtureRoots, mainRoot, packageRoot, ACTIVE_IDENTITY_OPERATION_BOUNDARIES, journalFixtureBase, journalFixtureDelta, state, artifactReleaseLedgerPath, capabilityReleaseLedgerPath, StoryStore, NOW } from "./data.mjs";
import { installFixtureFindingLedgerPrivateKey } from "./finding-artifacts.mjs";

export function snapshotTree(root) {
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

export function snapshotGitMaterial(root) {
  // Preserve literal Git paths, including quotes, newlines and edge spaces.
  // The general text helper trims output and must not parse a path protocol.
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
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

export function snapshotPublicOperationState(root, storyIds = []) {
  const runtimePath = (name) => snapshotTree(join(root, '.proof-or-stop', name));
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    gitIndex: git(root, ['ls-files', '--stage', '-z']),
    status: git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
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

export function publicFixtureProjection() {
  const retired = runtimeArtifactRegistry.find(entry => entry.id === 'retired-generated-cache-deny-only');
  assert.ok(retired && retired.materialHash === 'exclude' && retired.repairableTrackedArtifact === false,
    'private fixture exclusions require the explicit retired generated-cache policy');
  const omitted = [{ kind: 'prefix', value: INERT_PUBLIC_FIXTURE_LOG_SUBTREE }, ...retired.matchers];
  const literal = value => {
    assert.ok(typeof value === 'string' && value && !/[\r\n]/u.test(value), 'sparse patterns require a literal single-line path');
    return value.replace(/[\\*?\[\]]/gu, '\\$&');
  };
  for (const entry of omitted) assert.ok(['prefix', 'exact'].includes(entry.kind), 'unknown cache matcher must not broaden the fixture projection');
  const storyRoot = '.proof-or-stop/story/actives/';
  // Public operations explicitly target B-49df. Keep the existing B-022e
  // compatibility sample too; full verifier clones restore every Story below.
  const keptStories = ['B-49df', 'B-022e'];
  return {
    patterns: ['/*', ...omitted.map(entry => `!/${literal(entry.value)}`),
      `!/${storyRoot}*/`, ...keptStories.map(id => `/${storyRoot}${id}/`)].join('\n') + '\n',
    materialized(path) {
      if (omitted.some(entry => entry.kind === 'prefix' ? path.startsWith(entry.value) : path === entry.value)) return false;
      if (!path.startsWith(storyRoot)) return true;
      const tail = path.slice(storyRoot.length);
      return !tail.includes('/') || keptStories.includes(tail.slice(0, tail.indexOf('/')));
    },
  };
}

export function createPublicOperationClone(prefix, copyFindingTrust = true, sourceRoot = repoRoot) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  assert.ok(root !== repoRoot && root !== mainRoot && fixtureRoots.includes(root), 'sparse setup is restricted to a new disposable clone');
  assert.ok(sourceRoot === repoRoot || fixtureRoots.includes(sourceRoot), 'clone source must be the repository or a registered private producer');
  const cloned = spawnSync('git', ['clone', '--shared', '--quiet', '--no-checkout', sourceRoot, root], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, `${cloned.stdout}${cloned.stderr}`);
  // A disposable self-host clone needs a checked-out integration branch even
  // when its producer is a Lab branch. A mere un-checked-out main ref cannot
  // satisfy authoritative-runtime admission after a mode-delegate refusal.
  // Keep the candidate commit unchanged and establish refs before the oracle.
  if (git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') {
    git(root, ['branch', '--force', 'main', 'HEAD']);
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const expectedIndex = git(root, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const match = row.match(/^(\d+) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/u);
    assert.ok(match, 'committed fixture tree must have an exact index representation');
    return `${match[1]} ${match[2]} 0\t${match[3]}`;
  });
  // Scope the private working tree, never the real history or snapshot oracle.
  // Keep all index entries: creation at any absent path remains observable.
  const projection = publicFixtureProjection();
  git(root, ['sparse-checkout', 'init', '--no-cone']);
  const sparse = spawnSync('git', ['sparse-checkout', 'set', '--no-cone', '--stdin'], {
    cwd: root, encoding: 'utf8', input: projection.patterns,
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
    assert.equal(present, projection.materialized(path), `unexpected fixture materialization: ${path}`);
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
  // Copied main/dist still imports package-local dependencies (including smol-toml).
  // Both public-operation and finding-trust clones use this same constructor.
  symlinkSync(join(packageRoot, 'node_modules'), join(root, 'packages', 'main', 'node_modules'), 'dir');
  if (copyFindingTrust) installFixtureFindingLedgerPrivateKey(root); return root;
}

export function activeIdentityBoundaryOperation(boundaryId, storyId) {
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
    'canonical-journal-authority': ['acceptance_amendment_propose', { storyId: journalFixtureBase.storyId, amendmentId: 'AM-identity', delta: journalFixtureDelta }],
    // This public consumer performs the registered acceptance identity preflight.
    // Existing matrix runs it both normally and with the CLI preflight ablated.
    'acceptance-amendment-review': ['agent_prompt', { role: 'proof-or-stop-review-quality' }],
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
    'maintenance-command-mode': ['quorum_prune', { storyId, dryRun: true, json: true }],
    'process-fact-registry': ['session_brief', {}],
    'prompt-runtime': ['agent_prompt', { role: 'proof-or-stop-review-quality' }],
    'claim-admissibility-pack': ['pinn_claim_check', { fixture: 'complete', json: true }],
    'release-ledgers': ['artifact_release_list', { format: 'json' }],
  };
  const operation = operations[boundaryId];
  assert.ok(operation, `missing public operation for active identity boundary ${boundaryId}`);
  return operation;
}

export function ensurePublicIdentityOperationFixture() {
  if (state.publicIdentityOperationFixture) return state.publicIdentityOperationFixture;
  const root = createPublicOperationClone('proof-or-stop-b49df-every-active-boundary-');
  assert.ok(fixtureRoots.includes(root) && root !== repoRoot, 'canonical ledger setup is restricted to the generated clone');
  // Historical release rows remain rejected. Canonical list controls use valid
  // empty ledgers in this disposable clone, never reinterpret old audit data.
  for (const path of [artifactReleaseLedgerPath(root), capabilityReleaseLedgerPath(root)]) writeFileSync(path, '');
  const externalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-process-fact-reader-'));
  fixtureRoots.push(externalRoot);
  initRepo(externalRoot, false);
  const journalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-current-journal-identity-'));
  fixtureRoots.push(journalRoot);
  initRepo(journalRoot, false);
  const journalStore = new StoryStore(journalRoot);
  journalStore.writeStory(journalFixtureBase.storyId, { storyId: journalFixtureBase.storyId, name: 'current-journal-identity', title: 'Current journal authority', phase: 'DEV', priority: 'medium', createdAt: NOW, events: [] });
  journalStore.writeChecklist(journalFixtureBase.storyId, journalFixtureBase.checklist);
  journalStore.writeScopeContract(journalFixtureBase.storyId, journalFixtureBase.scope);
  journalStore.writeProofStoryContract(journalFixtureBase.storyId, journalFixtureBase.proofStory);
  git(journalRoot, ['add', '.']); git(journalRoot, ['commit', '-m', 'test: current public proposal prerequisites']);
  state.publicIdentityOperationFixture = { root, externalRoot, journalRoot, entrypoint: join(root, 'packages', 'main', 'dist', 'cli.js') };
  return state.publicIdentityOperationFixture;
}

export function assertCanonicalPublicIdentityOperations(fixture, label) {
  const startedAt = Date.now();
  const operations = new Map();
  for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
    const [defaultCommand, payload] = activeIdentityBoundaryOperation(boundary.id, 'B-49df');
    const root = boundary.id === 'canonical-journal-authority' ? fixture.journalRoot : boundary.id === 'process-fact-registry' ? fixture.externalRoot : fixture.root;
    for (const site of boundary.retiredIdentityCases.length ? boundary.retiredIdentityCases : [{ command: defaultCommand }]) {
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

export function assertCanonicalOperationResponse(command, payload, root, stdout) {
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
    case 'quorum_prune':
      assert.equal(value.schemaVersion, 'proof-or-stop.quorum_prune.v1');
      assert.equal(value.storyId, payload.storyId);
      assert.equal(value.dryRun, true);
      assert.equal(value.applied, false);
      assert.equal(value.removedVerdictCount, 0);
      assert.equal(value.metadataCommitSha, null);
      assert.ok(Array.isArray(value.duplicateGroups) && Array.isArray(value.refusedGroups));
      break;
    case 'acceptance_amendment_propose':
      assert.equal(value.schemaVersion, 'proof-or-stop.acceptance_amendment.v1');
      assert.equal(value.storyId, payload.storyId);
      assert.equal(value.amendmentId, payload.amendmentId);
      assert.equal(value.state, 'PROPOSED');
      assert.deepEqual(value.delta, payload.delta);
      assert.match(value.signature, /^ed25519:/);
      // Existing proposal idempotency calls the real controller's verified read.
      assert.match(value.requestDigest, /^[a-f0-9]{64}$/);
      break;
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

export function createRuntimeFixture() {
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

export function ensureRuntimeFixture() {
  state.runtimeFixture ??= createRuntimeFixture();
  return state.runtimeFixture;
}

export function snapshotRuntimeState(fixture) {
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

export function assertRuntimeFixtureUnchanged(fixture, before) {
  assert.deepEqual(snapshotRuntimeState(fixture), before, 'foreign runtime changed Story/repository/Git state');
}

export function assertRuntimeAuthoritativeStateUnchanged(fixture, before) {
  const after = snapshotRuntimeState(fixture);
  for (const key of ['story', 'events', 'storyIndex', 'worktrees', 'refs', 'head', 'gitIndex']) {
    assert.deepEqual(after[key], before[key], `read-only diagnostic changed authoritative state: ${key}`);
  }
}

export function snapshotIdentityAuthorityState(fixture) {
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

export function assertIdentityAuthorityStateUnchanged(fixture, before) {
  assert.deepEqual(
    snapshotIdentityAuthorityState(fixture),
    before,
    'rejected identity operation changed authoritative Story identity evidence or Git state',
  );
}
