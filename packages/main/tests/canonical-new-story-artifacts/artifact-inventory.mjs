


import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';



import ts from 'typescript';



import { ACTIVE_IDENTITY_KEYS, ACTIVE_STORY_IDENTITY_PATHS, retiredProtocolStem, retiredBrandStem, state, cliPath, repoRoot, retiredInitActor, scopeBoundaryHashIsFresh, canonicalBoundary, StoryStore, NOW, retiredReviewRunSalt, fixtureRoots, artifactReleaseLedgerPath, retiredProtocolPrefix, readArtifactReleaseLedger } from "./data.mjs";
import { check } from "./runner.mjs";
import { git, runCli, establishCurrentImplementationPrerequisite } from "./fixture-support.mjs";
import { runIdentityVerifier } from "./release.mjs";
import { initArtifactAndRefs, assertInitArtifactAndRefsUnchanged } from "./scope-init.mjs";
import { createRuntimeFixture, snapshotRuntimeState, assertRuntimeFixtureUnchanged } from "./public-fixtures.mjs";
import { reviewRunHashWithSalt } from "./identity-inventory.mjs";

export function valuesAtPath(value, path) {
  const [head, ...tail] = path.split('.');
  if (head === '*') return Array.isArray(value) ? value.flatMap((item) => valuesAtPath(item, tail.join('.'))) : [];
  if (value === null || typeof value !== 'object' || !(head in value)) return [];
  return tail.length === 0 ? [value[head]] : valuesAtPath(value[head], tail.join('.'));
}

export function discoverActiveIdentityPaths(value, prefix = '') {
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

export function assertIdentityInventoryComplete(artifacts) {
  const registered = new Set(ACTIVE_STORY_IDENTITY_PATHS.map((entry) => `${entry.artifact}:${entry.path}`));
  const discovered = [];
  for (const [artifact, value] of Object.entries(artifacts)) {
    for (const path of discoverActiveIdentityPaths(value)) discovered.push(`${artifact}:${path}`);
  }
  assert.deepEqual([...new Set(discovered)].sort(), [...registered].sort(), 'active identity field appeared outside the bounded registry');
}

export function assertActiveArtifactIdentitiesCanonical(artifacts) {
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

export async function runCases() {
await check(['inventory'], 'CHK-005:happy:0 fresh Story registered identity values are all canonical', () => {
  assert.ok(state.freshFixture, 'public CLI fresh Story fixture must be available');
  assertActiveArtifactIdentitiesCanonical(state.freshFixture.artifacts);
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
  assert.ok(state.freshFixture, 'public CLI fresh Story fixture must be available');
  const artifact = structuredClone(state.freshFixture.artifacts['init-check.json']);
  artifact.historicalProvenance = ['Historical ', 'lat', 'tice wording remains visible.'].join('');
  const bytes = JSON.stringify(artifact);
  assert.equal(discoverActiveIdentityPaths(artifact).includes('historicalProvenance'), false);
  assert.match(artifact.historicalProvenance, new RegExp(['lat', 'tice'].join('')));
  assert.equal(JSON.stringify(artifact), bytes);
});

await check(['inventory'], 'CHK-005 bounded active identity paths reject retired values while ignoring historical prose [CHK-005:adversarial:0]', () => {
  assert.ok(Object.isFrozen(ACTIVE_STORY_IDENTITY_PATHS));
  assert.ok(state.freshFixture, 'public CLI fresh Story fixture must be available');
  const artifacts = structuredClone(state.freshFixture.artifacts);
  artifacts['init-check.json'].historicalProvenance = ['Historical ', 'lat', 'tice wording remains visible outside active identity paths.'].join('');
  assertActiveArtifactIdentitiesCanonical(artifacts);

  for (const entry of ACTIVE_STORY_IDENTITY_PATHS) {
    const mutantArtifacts = structuredClone(state.freshFixture.artifacts);
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
  assert.ok(state.freshFixture, 'public CLI fresh Story fixture must be available');
  assertIdentityInventoryComplete(state.freshFixture.artifacts);
  for (const entry of ACTIVE_STORY_IDENTITY_PATHS) {
    const mutantArtifacts = structuredClone(state.freshFixture.artifacts);
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
  assert.ok(state.freshFixture, 'public CLI fresh Story fixture must be available');
  const artifacts = structuredClone(state.freshFixture.artifacts);
  artifacts['scope-boundary.json'].runtime = ['lat', 'tice-runtime'].join('');
  assert.throws(
    () => assertIdentityInventoryComplete(artifacts),
    /active identity field appeared outside the bounded registry.*scope-boundary\.json:runtime/is,
  );
  const omittedArtifact = structuredClone(state.freshFixture.artifacts);
  omittedArtifact['synthetic-runtime.json'] = { runtime: ['lat', 'tice-runtime'].join('') };
  assert.throws(
    () => assertIdentityInventoryComplete(omittedArtifact),
    /active identity field appeared outside the bounded registry.*synthetic-runtime\.json:runtime/is,
  );
});

await check(['inventory'], 'CHK-005:adversarial:2 independent boundary failures and final identity verification coexist', () => {
  assert.ok(state.freshFixture, 'public CLI fresh Story fixture must be available');
  assert.equal(runIdentityVerifier().status, 0);

  const initBefore = initArtifactAndRefs(state.freshFixture.root, state.freshFixture.storyDir);
  const retiredReviewerAttempt = runCli(
    state.freshFixture.root,
    'init_check_set',
    { storyId: state.freshFixture.storyId, issues: [], agentId: retiredInitActor },
    { PROOF_OR_STOP_AGENT: retiredInitActor },
  );
  assert.notEqual(retiredReviewerAttempt.status, 0);
  assert.match(`${retiredReviewerAttempt.stdout}${retiredReviewerAttempt.stderr}`, /unknown|retired|not permitted|mutation_denied/i);
  assertInitArtifactAndRefsUnchanged(state.freshFixture.root, state.freshFixture.storyDir, initBefore);

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

  const store = new StoryStore(state.freshFixture.root);
  const story = store.readStory(state.freshFixture.storyId);
  story.phase = 'REVIEW';
  story.currentReviewRound = NOW;
  store.writeStory(state.freshFixture.storyId, story);
  git(state.freshFixture.root, ['add', '-f', '.proof-or-stop']);
  git(state.freshFixture.root, ['commit', '-m', 'seed persisted review signature boundary']);
  establishCurrentImplementationPrerequisite(state.freshFixture.root);
  const dispatched = runCli(state.freshFixture.root, 'dispatch', {
    storyId: state.freshFixture.storyId,
    agentType: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(dispatched.status, 0, `${dispatched.stdout}${dispatched.stderr}`);
  const started = runCli(state.freshFixture.root, 'review_run_start', {
    storyId: state.freshFixture.storyId,
    agent: 'proof-or-stop-review-quality',
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.equal(started.status, 0, `${started.stdout}${started.stderr}`);
  const reviewRunsPath = join(state.freshFixture.storyDir, 'review-runs.json');
  const persistedRuns = JSON.parse(readFileSync(reviewRunsPath, 'utf8'));
  const tamperedRun = persistedRuns.runs.at(-1);
  tamperedRun._hash = reviewRunHashWithSalt(tamperedRun, retiredReviewRunSalt);
  writeFileSync(reviewRunsPath, `${JSON.stringify(persistedRuns, null, 2)}\n`);
  const passPath = join(state.freshFixture.storyDir, 'review-passes.json');
  const passBytesBefore = existsSync(passPath) ? readFileSync(passPath) : null;
  const tamperedRunBytesBefore = readFileSync(reviewRunsPath);
  const tamperedSubmission = runCli(state.freshFixture.root, 'review_pass_set', {
    storyId: state.freshFixture.storyId,
    agent: 'proof-or-stop-review-quality',
    reviewRunId: tamperedRun.reviewRunId,
    note: 'A retired-salt persisted ReviewRun must never authorize a reviewer pass.',
    readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
  }, { PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality', PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex' });
  assert.notEqual(tamperedSubmission.status, 0);
  assert.match(`${tamperedSubmission.stdout}${tamperedSubmission.stderr}`, /invalid|signature|tampered|review run/i);
  assert.deepEqual(readFileSync(reviewRunsPath), tamperedRunBytesBefore);
  assert.deepEqual(existsSync(passPath) ? readFileSync(passPath) : null, passBytesBefore);

  const synthetic = structuredClone(state.freshFixture.artifacts['scope-boundary.json']);
  synthetic.runtime = ['lat', 'tice-runtime'].join('');
  assert.ok(discoverActiveIdentityPaths(synthetic).includes('runtime'));
  assert.match(state.freshFixture.artifacts['init-check.json'].agentResults[0].agentId, /^(?:proof-or-stop-product-reviewer|proof-or-stop-review-story-init)$/);
  const releaseRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-b49df-release-boundary-'));
  fixtureRoots.push(releaseRoot);
  mkdirSync(join(releaseRoot, '.proof-or-stop'), { recursive: true });
  writeFileSync(artifactReleaseLedgerPath(releaseRoot), `${JSON.stringify({ schemaVersion: `${retiredProtocolPrefix}artifact-release.v1` })}\n`);
  assert.throws(() => readArtifactReleaseLedger(releaseRoot), /unsupported identity schema/i);
});
}
