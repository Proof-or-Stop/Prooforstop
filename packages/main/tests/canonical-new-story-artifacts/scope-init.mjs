


import assert from 'node:assert/strict';


import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';



import ts from 'typescript';

import { deliverInitReviewerVerdict, deliverInitReviewerVerdicts } from ".././support/managed-init-reviewer-delivery.mjs";

import { cleanupFixtureFindingKeys } from "./finding-artifacts.mjs";
import { check } from "./runner.mjs";
import { canonicalBoundary, scopeBoundaryHashIsFresh, fixtureRoots, state, StoryStore, getGuardFailureReason, digestScopeBoundary, normalizeScopeBoundary, evaluateScopeFreeze, NOW, getScopeAntiExpansionGuardFailureReason, buildScopeBoundary, executionBoundaryHashIsFresh, digestScopeFreezeCheck, digestExecutionBoundary, normalizeExecutionBoundary, buildScopeFreezeCheckArtifact, REQUIRED_INIT_CHECK_AGENTS, initCheckAgentMatches, retiredInitActor, resolveAgentMutationAuthority, initCheckSignatureIsValid, recomputeInitCheckHash, repoRoot } from "./data.mjs";
import { initRepo, runCli, validBackground, git } from "./fixture-support.mjs";

export function initArtifactAndRefs(root, storyDir) {
  return {
    init: readFileSync(join(storyDir, 'init-check.json')),
    refs: git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
  };
}

export function assertInitArtifactAndRefsUnchanged(root, storyDir, before) {
  assert.deepEqual(readFileSync(join(storyDir, 'init-check.json')), before.init, 'rejected reviewer changed init-check bytes');
  assert.equal(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']), before.refs, 'rejected reviewer changed refs');
}

export async function runCases() {
process.once('exit', cleanupFixtureFindingKeys);

process.once('SIGTERM', () => { cleanupFixtureFindingKeys(); process.exit(143); });

process.once('SIGINT', () => { cleanupFixtureFindingKeys(); process.exit(130); });

await check(['scope'], 'CHK-001 fresh writer emits exact proof-or-stop scope schema', () => {
  assert.equal(canonicalBoundary.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.equal(scopeBoundaryHashIsFresh(canonicalBoundary), true);
});

await check(['scope', 'init', 'runtime', 'inventory', 'identity-cutover'], 'CHK-001/002 public CLI creates fresh canonical scope and INIT evidence', async () => {
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
  // INIT evidence is only admissible from inside a live managed dispatch, so the
  // reviewer verdicts are delivered through the real acknowledged path (one
  // single-use dispatch per verdict) instead of a bare public-CLI init_check_set.
  const deliveries = await deliverInitReviewerVerdicts({
    root,
    storyId,
    reviewers: ['proof-or-stop-product-reviewer', 'proof-or-stop-review-story-init', 'proof-or-stop-review-story-init'],
  });
  assert.equal(new Set(deliveries.map((delivery) => delivery.runId)).size, 3,
    'each delivered reviewer verdict must come from its own managed dispatch run');
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
  // Every persisted reviewer row must name the managed dispatch that produced it,
  // and a re-delivered lane must rebind to its latest run rather than keep a spent one.
  const latestRunIdByAgent = new Map(deliveries.map((delivery) => [delivery.agentType, delivery.runId]));
  assert.deepEqual(
    Object.fromEntries(init.agentResults.map((row) => [row.agentId, row.deliveryRunId])),
    Object.fromEntries(latestRunIdByAgent),
  );
  state.freshFixture = { root, storyId, storyDir, artifacts: generatedJsonArtifacts, deliveries };
});

await check(['scope'], 'CHK-001:happy:0 public CLI artifact has exact canonical schema and valid hash', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const scope = new StoryStore(state.freshFixture.root).readScopeBoundary(state.freshFixture.storyId);
  assert.equal(scope.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.equal(scopeBoundaryHashIsFresh(scope), true);
});

await check(['scope'], 'CHK-001:happy:1 canonical scope round-trips through reader and INIT_CHECK gate', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const scope = store.readScopeBoundary(state.freshFixture.storyId);
  assert.deepEqual(scope.allowed, ['fresh canonical Story identity']);
  assert.deepEqual(scope.excluded, ['historical rewrite']);
  assert.equal(scopeBoundaryHashIsFresh(scope), true);
  assert.equal(getGuardFailureReason(state.freshFixture.storyId, store, 'INIT_CHECK', state.freshFixture.root), null);
});

await check(['scope'], 'CHK-001:edge:1 canonical writer preserves Unicode with an empty optional excluded list', () => {
  assert.equal(canonicalBoundary.schemaVersion, 'proof-or-stop.scope_boundary.v1.1');
  assert.deepEqual(canonicalBoundary.allowed, ['Unicode scope 范围']);
  assert.deepEqual(canonicalBoundary.excluded, []);
  assert.equal(scopeBoundaryHashIsFresh(canonicalBoundary), true);
});

await check(['scope'], 'CHK-001:edge:0 historical v1 remains readable, gate-valid, and byte-stable', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const historical = {
    ...store.readScopeBoundary(state.freshFixture.storyId),
    schemaVersion: 'lattice.scope_boundary.v1',
    _hash: '',
  };
  historical._hash = digestScopeBoundary(historical);
  const bytesBefore = JSON.stringify(historical);
  const normalized = normalizeScopeBoundary(historical);
  assert.equal(normalized.schemaVersion, 'lattice.scope_boundary.v1');
  assert.equal(scopeBoundaryHashIsFresh(normalized), true);
  assert.equal(JSON.stringify(historical), bytesBefore, 'compatibility read must not rewrite historical input bytes');

  const scopePath = join(state.freshFixture.storyDir, 'scope-boundary.json');
  const freezePath = join(state.freshFixture.storyDir, 'scope-freeze-check.json');
  const originalScope = readFileSync(scopePath);
  const originalFreeze = readFileSync(freezePath);
  try {
    store.writeScopeBoundary(state.freshFixture.storyId, historical);
    const story = store.readStory(state.freshFixture.storyId);
    const freeze = evaluateScopeFreeze({
      storyId: state.freshFixture.storyId,
      scopeBoundary: historical,
      executionBoundary: store.readExecutionBoundary(state.freshFixture.storyId),
      story: {
        title: story.title,
        description: story.description,
        background: store.readStoryBackground(state.freshFixture.storyId) ?? undefined,
      },
      checklist: store.readChecklist(state.freshFixture.storyId).items.map((item) => ({
        id: item.id, title: item.title, context: item.context, excludes: item.excludes,
      })),
      discardDigest: store.readScopeDiscardDigestForFreeze(state.freshFixture.storyId),
      now: NOW,
    });
    store.writeScopeBoundary(state.freshFixture.storyId, freeze.normalizedScopeBoundary);
    store.writeScopeFreezeCheck(state.freshFixture.storyId, freeze.check);
    const persistedBefore = readFileSync(scopePath);
    assert.equal(getScopeAntiExpansionGuardFailureReason(state.freshFixture.storyId, store, state.freshFixture.root), null);
    store.readScopeBoundary(state.freshFixture.storyId);
    assert.deepEqual(readFileSync(scopePath), persistedBefore, 'reader/gate must not rewrite historical boundary bytes');
  } finally {
    writeFileSync(scopePath, originalScope);
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['scope'], 'CHK-001:adversarial:0 schema-only tampering fails hash and scope gate without rewrite', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const scopePath = join(state.freshFixture.storyDir, 'scope-boundary.json');
  const original = readFileSync(scopePath);
  const historical = { ...store.readScopeBoundary(state.freshFixture.storyId), schemaVersion: 'lattice.scope_boundary.v1', _hash: '' };
  historical._hash = digestScopeBoundary(historical);
  const tampered = { ...historical, schemaVersion: 'proof-or-stop.scope_boundary.v1.1' };
  assert.equal(scopeBoundaryHashIsFresh(tampered), false, 'schema-only tampering must invalidate the historical hash');
  try {
    store.writeScopeBoundary(state.freshFixture.storyId, tampered);
    const persistedBefore = readFileSync(scopePath);
    assert.match(getScopeAntiExpansionGuardFailureReason(state.freshFixture.storyId, store, state.freshFixture.root), /scope_boundary_tampered|scope-boundary.*hash|stale/i);
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
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const execution = state.freshFixture.artifacts['execution-boundary.json'];
  const freeze = state.freshFixture.artifacts['scope-freeze-check.json'];
  assert.equal(execution.schemaVersion, 'proof-or-stop.execution_boundary.v1.1');
  assert.equal(executionBoundaryHashIsFresh(execution), true);
  assert.equal(freeze.schemaVersion, 'proof-or-stop.scope_freeze_check.v1.1');
  assert.equal(freeze._hash, digestScopeFreezeCheck(freeze));
});

await check(['scope'], 'F-001 historical execution/freeze schemas remain readable and byte-stable', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const legacyExecutionSchema = ['lat', 'tice.execution_boundary.v1'].join('');
  const historicalExecution = {
    ...store.readExecutionBoundary(state.freshFixture.storyId),
    schemaVersion: legacyExecutionSchema,
    _hash: '',
  };
  historicalExecution._hash = digestExecutionBoundary(historicalExecution);
  const executionBytes = JSON.stringify(historicalExecution);
  const normalizedExecution = normalizeExecutionBoundary(historicalExecution);
  assert.equal(normalizedExecution.schemaVersion, legacyExecutionSchema);
  assert.equal(executionBoundaryHashIsFresh(normalizedExecution), true);
  assert.equal(JSON.stringify(historicalExecution), executionBytes);

  const freezePath = join(state.freshFixture.storyDir, 'scope-freeze-check.json');
  const originalFreeze = readFileSync(freezePath);
  try {
    const historicalFreeze = {
      ...store.readScopeFreezeCheck(state.freshFixture.storyId),
      schemaVersion: ['lat', 'tice.scope_freeze_check.v1'].join(''),
      _hash: '',
    };
    historicalFreeze._hash = digestScopeFreezeCheck(historicalFreeze);
    store.writeScopeFreezeCheck(state.freshFixture.storyId, historicalFreeze);
    const persisted = readFileSync(freezePath);
    assert.equal(getScopeAntiExpansionGuardFailureReason(state.freshFixture.storyId, store, state.freshFixture.root), null);
    assert.deepEqual(readFileSync(freezePath), persisted);
  } finally {
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['scope'], 'F-012 legacy execution through scope_freeze_check preserves stored hash and remains INIT_CHECK-admissible', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const executionPath = join(state.freshFixture.storyDir, 'execution-boundary.json');
  const freezePath = join(state.freshFixture.storyDir, 'scope-freeze-check.json');
  const originalExecution = readFileSync(executionPath);
  const originalFreeze = readFileSync(freezePath);
  try {
    const historicalExecution = {
      ...store.readExecutionBoundary(state.freshFixture.storyId),
      schemaVersion: ['lat', 'tice.execution_boundary.v1'].join(''),
      _hash: '',
    };
    historicalExecution._hash = digestExecutionBoundary(historicalExecution);
    const adaptedFreeze = buildScopeFreezeCheckArtifact({
      args: { storyId: state.freshFixture.storyId, status: 'pass', checks: [] },
      scopeBoundary: store.readScopeBoundary(state.freshFixture.storyId),
      executionBoundary: historicalExecution,
      extensionDecisions: store.readScopeExtensionDecisions(state.freshFixture.storyId),
      now: NOW,
      actor: 'proof-or-stop-implementer',
    });
    assert.equal(adaptedFreeze.executionBoundaryHash, historicalExecution._hash, 'artifact adapter must bind the validated stored legacy hash');
    store.writeExecutionBoundary(state.freshFixture.storyId, historicalExecution);
    const persistedLegacyBytes = readFileSync(executionPath);
    const result = runCli(state.freshFixture.root, 'scope_freeze_check', { storyId: state.freshFixture.storyId });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const freeze = store.readScopeFreezeCheck(state.freshFixture.storyId);
    assert.equal(freeze.executionBoundaryHash, historicalExecution._hash, 'freeze writer must bind the validated stored legacy hash');
    assert.deepEqual(readFileSync(executionPath), persistedLegacyBytes, 'combined freeze path must not rewrite legacy execution evidence');
    assert.equal(getScopeAntiExpansionGuardFailureReason(state.freshFixture.storyId, store, state.freshFixture.root), null);
  } finally {
    writeFileSync(executionPath, originalExecution);
    writeFileSync(freezePath, originalFreeze);
  }
});

await check(['scope'], 'F-001 unsupported execution/freeze schema lookalikes fail closed', () => {
  assert.throws(
    () => normalizeExecutionBoundary({
      ...state.freshFixture.artifacts['execution-boundary.json'],
      schemaVersion: 'proof-or-stop.execution_boundary.v1',
    }),
    /unsupported execution-boundary schemaVersion/,
  );
  const store = new StoryStore(state.freshFixture.root);
  const freezePath = join(state.freshFixture.storyDir, 'scope-freeze-check.json');
  const originalFreeze = readFileSync(freezePath);
  try {
    const lookalike = {
      ...store.readScopeFreezeCheck(state.freshFixture.storyId),
      schemaVersion: 'proof-or-stop.scope_freeze_check.v1',
      _hash: '',
    };
    lookalike._hash = digestScopeFreezeCheck(lookalike);
    store.writeScopeFreezeCheck(state.freshFixture.storyId, lookalike);
    assert.match(getScopeAntiExpansionGuardFailureReason(state.freshFixture.storyId, store, state.freshFixture.root), /unsupported|unreadable|schema/i);
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
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const init = store.readInitCheck(state.freshFixture.storyId);
  assert.deepEqual(init.agentResults.map((row) => row.agentId).sort(), [...REQUIRED_INIT_CHECK_AGENTS].sort());
  assert.equal(initCheckSignatureIsValid(state.freshFixture.storyId, store, state.freshFixture.root, init), true);
  assert.equal(getGuardFailureReason(state.freshFixture.storyId, store, 'INIT_CHECK', state.freshFixture.root), null);
});

await check(['init'], 'CHK-002:edge:0 signed historical INIT evidence stays inspectable and byte-stable', async () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const initPath = join(state.freshFixture.storyDir, 'init-check.json');
  const canonicalBytes = readFileSync(initPath);
  try {
    const historical = structuredClone(store.readInitCheck(state.freshFixture.storyId));
    historical.agentId = retiredInitActor;
    historical.agentResults = historical.agentResults.map((row) => row.agentId === 'proof-or-stop-review-story-init'
      ? { ...row, agentId: retiredInitActor }
      : row);
    historical._hash = recomputeInitCheckHash(state.freshFixture.storyId, store, state.freshFixture.root, historical);
    store.writeInitCheck(state.freshFixture.storyId, historical);
    const persistedBefore = readFileSync(initPath);
    const inspected = store.readInitCheck(state.freshFixture.storyId);
    assert.equal(initCheckSignatureIsValid(state.freshFixture.storyId, store, state.freshFixture.root, inspected), true);
    assert.ok(inspected.agentResults.some((row) => row.agentId === retiredInitActor));
    assert.deepEqual(readFileSync(initPath), persistedBefore, 'historical inspection must not rewrite signed bytes');
  } finally {
    writeFileSync(initPath, canonicalBytes);
  }
  const refreshed = await deliverInitReviewerVerdict({
    root: state.freshFixture.root,
    storyId: state.freshFixture.storyId,
    agentType: 'proof-or-stop-review-story-init',
  });
  const refreshedInit = store.readInitCheck(state.freshFixture.storyId);
  assert.equal(
    refreshedInit.agentResults.find((row) => row.agentId === 'proof-or-stop-review-story-init')?.deliveryRunId,
    refreshed.runId,
    'a re-delivered reviewer row must carry the fresh managed delivery run id',
  );
  assert.doesNotMatch(readFileSync(initPath, 'utf8'), new RegExp(retiredInitActor, 'i'));
});

await check(['init'], 'CHK-002:edge:1 reverse-order and repeated canonical reviews stay idempotent and signed', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const store = new StoryStore(state.freshFixture.root);
  const init = store.readInitCheck(state.freshFixture.storyId);
  assert.deepEqual(init.agentResults.map((row) => row.agentId), ['proof-or-stop-product-reviewer', 'proof-or-stop-review-story-init']);
  assert.equal(new Set(init.agentResults.map((row) => row.agentId)).size, 2);
  assert.equal(initCheckSignatureIsValid(state.freshFixture.storyId, store, state.freshFixture.root, init), true);
});

await check(['init'], 'CHK-002:adversarial:0 retired reviewer CLI is non-zero with zero artifact/ref change', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const before = initArtifactAndRefs(state.freshFixture.root, state.freshFixture.storyDir);
  const attempted = runCli(
    state.freshFixture.root,
    'init_check_set',
    { storyId: state.freshFixture.storyId, issues: [], agentId: retiredInitActor },
    { PROOF_OR_STOP_AGENT: retiredInitActor },
  );
  assert.notEqual(attempted.status, 0);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /unknown|retired|not permitted|mutation_denied/i);
  assertInitArtifactAndRefsUnchanged(state.freshFixture.root, state.freshFixture.storyDir, before);
});

await check(['init'], 'CHK-002:adversarial:1 case whitespace prefix and alias lookalikes never map to canonical', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const rejectedActors = [
    ' proof-or-stop-review-story-init',
    'proof-or-stop-review-story-init ',
    'Proof-or-stop-review-story-init',
    'proof-or-stop-review-story',
    'proof-or-stop-review-story-init@alias',
    `${retiredInitActor}@fallback`,
  ];
  const before = initArtifactAndRefs(state.freshFixture.root, state.freshFixture.storyDir);
  for (const actor of rejectedActors) {
    assert.equal(initCheckAgentMatches(actor, 'proof-or-stop-review-story-init'), false, actor);
    const attempted = runCli(
      state.freshFixture.root,
      'init_check_set',
      { storyId: state.freshFixture.storyId, issues: [], agentId: actor },
      { PROOF_OR_STOP_AGENT: actor },
    );
    assert.notEqual(attempted.status, 0, actor);
    assert.match(`${attempted.stdout}${attempted.stderr}`, /unknown|retired|not permitted|noncanonical|byte-exact|mutation_denied/i, actor);
    assertInitArtifactAndRefsUnchanged(state.freshFixture.root, state.freshFixture.storyDir, before);
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

await check(['init'], 'RI-003 CLAUDE INIT examples execute as canonical signed reviewer evidence', async () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const guide = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  // The executable INIT templates are managed dispatch launches: a bare
  // init_check_set is refused with [delivery_not_acknowledged], so the guide
  // documents `host_run ... managedDispatch:true` instead. Execute those
  // templates verbatim with only the documented Story placeholder substituted.
  const examples = [...guide.matchAll(/^proof-or-stop host_run '(\{[^\n]+\})'$/gm)]
    .map((match) => JSON.parse(match[1]))
    .filter((example) => example.managedDispatch === true);
  assert.equal(examples.length, 2, 'CLAUDE.md must provide both executable INIT reviewer templates');
  const store = new StoryStore(state.freshFixture.root);
  // The operator template carries no verdict (the reviewer authors it inside the
  // dispatch), so the round-trip is proven on a reported verdict. medium stays
  // advisory, which keeps INIT_CHECK admissibility provable below.
  const reportedIssues = [{ severity: 'medium', desc: 'documented INIT reviewer verdict round-trip' }];
  for (const example of examples) {
    assert.equal(example.storyId, 'B-xxx', 'only the documented Story placeholder may be substituted');
    assert.equal(example.host, 'codex', 'the documented INIT template names its provider host');
    assert.equal(example.detach, true, 'the documented INIT template launches detached');
    const delivered = await deliverInitReviewerVerdict({
      root: state.freshFixture.root,
      storyId: state.freshFixture.storyId,
      issues: reportedIssues,
      hostRun: example,
    });
    const init = store.readInitCheck(state.freshFixture.storyId);
    const recorded = init.agentResults.find((row) => row.agentId === example.agentType);
    assert.ok(recorded, 'the CLI must persist the exact documented reviewer identity');
    assert.deepEqual(recorded.issues.map(({ severity, desc }) => ({ severity, desc })), reportedIssues);
    assert.equal(recorded.deliveryRunId, delivered.runId,
      'the persisted row must name the managed delivery run that produced it');
    assert.equal(initCheckSignatureIsValid(state.freshFixture.storyId, store, state.freshFixture.root, init), true);
  }
  assert.deepEqual(examples.map((example) => example.agentType).sort(), [...REQUIRED_INIT_CHECK_AGENTS].sort());
  assert.equal(getGuardFailureReason(state.freshFixture.storyId, store, 'INIT_CHECK', state.freshFixture.root), null);
  const admission = guide.split('\n').filter((line) => line.includes('live `managed_dispatch` provider group'));
  assert.equal(admission.length, 1, 'CLAUDE.md must describe exact INIT reviewer admission exactly once');
  assert.match(admission[0], /`init_check_set`/, 'the admission statement must name the gated writer');
  assert.equal(guide.includes('`product-reviewer`'), false, 'the guide must not advertise the obsolete role');
});

await check(['init'], 'RI-003 obsolete product-reviewer is rejected without INIT artifact or ref changes', () => {
  assert.ok(state.freshFixture, 'public CLI fixture must exist');
  const before = initArtifactAndRefs(state.freshFixture.root, state.freshFixture.storyDir);
  const attempted = runCli(
    state.freshFixture.root,
    'init_check_set',
    { storyId: state.freshFixture.storyId, issues: [], agentId: 'product-reviewer' },
    { PROOF_OR_STOP_AGENT: 'product-reviewer' },
  );
  assert.notEqual(attempted.status, 0);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /unknown|retired|not permitted|mutation_denied/i);
  assertInitArtifactAndRefsUnchanged(state.freshFixture.root, state.freshFixture.storyDir, before);
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
}
