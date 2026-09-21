


import assert from 'node:assert/strict';


import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';



import ts from 'typescript';



import { check } from "./runner.mjs";
import { ensureRuntimeFixture, snapshotRuntimeState, assertRuntimeFixtureUnchanged, assertRuntimeAuthoritativeStateUnchanged, snapshotGitMaterial } from "./public-fixtures.mjs";
import { runCli, git, initRepo } from "./fixture-support.mjs";
import { resolveEffectiveOwnershipClass, repoRoot, fixtureRoots, StoryStore, NOW } from "./data.mjs";

export async function runCases() {
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

await check(['runtime', 'reviewer-read'], 'F-018 active-worktree reviewer read paths remain available', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-reviewer-read-worktree-'));
  fixtureRoots.push(root);
  initRepo(root, false);
  const storyId = 'B-f018', worktree = join(root, 'worktree');
  const store = new StoryStore(root);
  store.writeStory(storyId, {
    storyId, name: 'reviewer-read-fixture', title: 'Reviewer reads remain available',
    description: 'Private active-worktree read boundary fixture.', type: 'chore',
    phase: 'DEV', priority: 'medium', createdAt: NOW, startedAt: NOW, endedAt: null,
    worktree: { path: worktree, branch: `story/${storyId}`, createdAt: NOW },
  });
  store.writeChecklist(storyId, { items: [] });
  git(root, ['add', '-f', '.proof-or-stop']);
  git(root, ['commit', '-m', 'seed private reviewer read fixture']);
  git(root, ['worktree', 'add', '-b', `story/${storyId}`, worktree]);
  const before = snapshotGitMaterial(worktree);
  for (const command of ['finding_list', 'certification_window_status']) {
    const env = { PROOF_OR_STOP_REVIEWER_READONLY: '1', PROOF_OR_STOP_AGENT: 'proof-or-stop-review-quality' };
    const result = runCli(worktree, command, { storyId }, env, { cwd: worktree });
    assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /not allowed in read-only reviewer mode/i, command);
    const misplaced = runCli(root, command, { storyId }, env, { cwd: root });
    if (command === 'finding_list') {
      assert.notEqual(misplaced.status, 0, `${command}: foreign cwd must still refuse`);
      assert.match(`${misplaced.stdout}${misplaced.stderr}`, /must execute.*inside the worktree/i);
    } else {
      assert.equal(misplaced.status, 0, 'read-only certification diagnostics remain available from the repository root');
    }
  }
  assert.deepEqual(snapshotGitMaterial(worktree), before, 'reviewer reads must preserve material bytes');
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
}
