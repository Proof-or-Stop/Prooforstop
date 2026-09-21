


import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';


import { join } from 'node:path';

import { identityCutoverReviewedContexts } from "../../../../scripts/verify-proof-or-stop-identity-cutover.mjs";

import ts from 'typescript';



import { check } from "./runner.mjs";
import { state, retiredProtocolPrefix, promptEnvelope, currentDigestPrefix, StoryStore, currentReviewRunSalt, retiredReviewRunSalt, identityTextFactsCache, retiredIdentityPattern, HISTORICAL_SCOPE_READER_IDENTITIES, IDENTITY_CUTOVER_REQUIRED_PATHS, retiredProtocolStem, repoRoot, STORY_WRITE_CAPABILITY_COMMANDS, cliPath } from "./data.mjs";
import { assertReviewPassRejectsEnvelopeMutation, identityLookalikes, digestWithIdentityPrefix, reviewRunHashWithSalt, assertReviewPassRejectsRunMutation, identityCutoverSourceMap, assertIdentityCutoverInventoryTotal } from "./identity-inventory.mjs";
import { ensureRuntimeFixture, snapshotRuntimeState, assertRuntimeFixtureUnchanged } from "./public-fixtures.mjs";
import { runCli } from "./fixture-support.mjs";

export async function runCases() {
await check(['identity-cutover'], 'CHK-007:adversarial:1 mixed and lookalike identity families are rejected exactly', () => {
  assert.ok(state.identityCutoverFixture?.envelope, 'fresh canonical Prompt Envelope must exist');
  assert.ok(state.identityCutoverFixture?.boundaryRun, 'public ReviewRun boundary fixture must exist');
  const fixture = {
    root: state.freshFixture.root,
    storyId: state.freshFixture.storyId,
    storyDir: state.freshFixture.storyDir,
    eventsPath: join(state.freshFixture.storyDir, 'process-events.jsonl'),
    indexPath: join(state.freshFixture.storyDir, 'index.json'),
  };
  const canonicalEnvelopeBytes = readFileSync(join(state.freshFixture.storyDir, 'prompt-envelopes.json'));
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
      boundaryRun: state.identityCutoverFixture.boundaryRun,
      canonicalBytes: canonicalEnvelopeBytes,
      label: `persisted PromptEnvelope schema lookalike ${JSON.stringify(value)}`,
      mutate: (envelope) => {
        envelope.schemaVersion = value;
        envelope.envelopeId = promptEnvelope.computePromptEnvelopeId(envelope);
      },
    });
  }

  const reviewRunsPath = join(state.freshFixture.storyDir, 'review-runs.json');
  const canonicalRunsBytes = readFileSync(reviewRunsPath);
  const persistedLookalikeBoundaries = [
    ...identityLookalikes(currentDigestPrefix).map(({ kind, value }) => [
      `ReviewRun digest domain ${kind}`,
      (run) => {
        run.promptHash = digestWithIdentityPrefix(value, 'assembled-prompt.raw-utf8.v1', new StoryStore(fixture.root).readReviewPrompt(run));
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
      boundaryRun: state.identityCutoverFixture.boundaryRun,
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
}
