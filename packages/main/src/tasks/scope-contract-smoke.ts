#!/usr/bin/env node
/**
 * @task B-be27
 * @checklist CHK-001,CHK-002,CHK-003,CHK-004,CHK-005
 * @title scope contract smoke coverage
 * @type feature
 * @priority high
 * @description
 *   Focused smoke coverage for story scope contracts and the changed-file gate:
 *   no-contract compatibility, set/show/check CLI output, enforce failures,
 *   shadow warnings, invalid contract rejection, and explicit acknowledgement.
 * @changes
 *   - [CHK-001] Verify ScopeContract persistence and validation
 *   - [CHK-002] Verify CLI set/show/check/acknowledge commands
 *   - [CHK-003] Verify enforce/shadow/no-contract gate behavior
 *   - [CHK-004] Verify acknowledgement remains reviewer-visible
 *   - [CHK-005] Package the regression as a smoke test
 *   - [B-6bfd F-003] Verify single-digest ack persists only hunkDigest and
 *     multi-digest ack persists only hunkDigests (no redundant field)
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { checkScopeContract, validatePaths } from '../core/scope-contract.js';
import { createScopeContractHandlers } from '../handlers/scope-contract.js';
import { runScopeTransitionGate } from '../handlers/phase-gates.js';
import type { HandlerContext } from '../handlers/context.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const sessionEnv = { ...process.env, LATTICE_SESSION_ID: 'scope-contract-smoke', LATTICE_AGENT: 'scope-contract-smoke' };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: sessionEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

function requireScopeRows(result: unknown, label: string): Array<Record<string, unknown>> {
  const rows = (result as { rows?: unknown }).rows;
  assert.ok(Array.isArray(rows), `${label}: scope check must expose stable rows`);
  for (const row of rows) {
    assert.equal(typeof row, 'object', `${label}: each scope row must be an object`);
    assert.ok(row !== null, `${label}: each scope row must be non-null`);
    const typed = row as Record<string, unknown>;
    assert.equal(typeof typed.id, 'string', `${label}: row must include id`);
    assert.equal(typeof typed.status, 'string', `${label}: row ${String(typed.id)} must include status`);
    assert.equal(typeof typed.blocking, 'boolean', `${label}: row ${String(typed.id)} must include blocking`);
    assert.equal(typeof typed.source, 'string', `${label}: row ${String(typed.id)} must include source`);
    assert.ok(
      typeof typed.nextAction === 'string' || typeof typed.hint === 'string',
      `${label}: row ${String(typed.id)} must include nextAction or hint`,
    );
  }
  return rows as Array<Record<string, unknown>>;
}

function findScopeRow(
  result: unknown,
  label: string,
  predicate: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  const rows = requireScopeRows(result, label);
  const row = rows.find(predicate);
  assert.ok(row, `${label}: expected scope row not found in ${JSON.stringify(rows)}`);
  return row!;
}

function assertScopeRow(
  result: unknown,
  label: string,
  expected: { id?: string; source: string; status: string; blocking: boolean; action?: RegExp },
): void {
  const row = findScopeRow(result, label, (candidate) => {
    if (expected.id && candidate.id !== expected.id) return false;
    return candidate.source === expected.source;
  });
  if (expected.id) assert.equal(row.id, expected.id, `${label}: stable row id`);
  assert.equal(row.source, expected.source, `${label}: row source`);
  assert.equal(row.status, expected.status, `${label}: row status`);
  assert.equal(row.blocking, expected.blocking, `${label}: row blocking`);
  if (expected.action) {
    const action = String(row.nextAction ?? row.hint ?? '');
    assert.match(action, expected.action, `${label}: row recovery action`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'lattice-scope-contract-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'scope@example.test']);
  git(root, ['config', 'user.name', 'Scope Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'src/allowed.ts', 'export const allowed = 1;\n');
  write(root, 'src/protected.ts', 'export const protectedValue = 1;\n');
  write(root, 'README.md', 'scope contract smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const store = new StoryStore(root);
  const storyId = 'B-scope';
  const story: StoryInfo = {
    storyId,
    name: 'scope-smoke',
    title: 'Scope smoke',
    description: 'Verify scope contract behavior.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    events: [],
  };
  const checklist: ChecklistData = {
    items: [{ id: 'CHK-001', title: 'Scope contract', status: 'in_progress', startTime: null, endTime: null }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  git(root, ['add', '.lattice']);
  git(root, ['commit', '-m', 'story metadata']);
  git(root, ['checkout', '-b', `story/${storyId}`]);

  const noContract = run(root, 'scope_contract_check', { storyId, json: true });
  assert.equal(JSON.parse(noContract).status, 'skip', 'no contract should be backward-compatible skip');
  assert.match(run(root, 'scope_contract_show', { storyId }), /Scope contract: not configured/, 'show should degrade without contract');

  const invalid = run(root, 'scope_contract_set', { storyId, mode: 'strict' }, true);
  assert.match(invalid, /Invalid option|mode|strict/, 'invalid mode should be rejected');
  assert.throws(() => validatePaths(['../secret'], 'allowedModify'), /unsafe relative path/, 'unsafe paths are rejected by core validation');

  const set = run(root, 'scope_contract_set', {
    storyId,
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: ['src/new.ts'],
    allowedTest: ['tests'],
    protectedFiles: ['src/protected.ts'],
    explicitExcludes: ['src/excluded.ts'],
  });
  assert.match(set, /Scope contract: configured/, 'set should render configured transcript');
  assert.match(run(root, 'scope_contract_show', { storyId }), /allowedModify: \[src\/allowed.ts\]/, 'show should list allowedModify');
  run(root, 'scope_contract_set', {
    storyId,
    mode: 'enforce',
    allowedTest: ['tests', 'specs'],
  });
  const partialUpdate = run(root, 'scope_contract_show', { storyId });
  assert.match(partialUpdate, /allowedModify: \[src\/allowed.ts\]/, 'partial update should preserve omitted allowedModify');
  assert.match(partialUpdate, /allowedCreate: \[src\/new.ts\]/, 'partial update should preserve omitted allowedCreate');
  assert.match(partialUpdate, /allowedTest: \[tests, specs\]/, 'partial update should replace provided allowedTest');

  write(root, 'src/allowed.ts', 'export const allowed = 2;\n');
  let checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'pass', 'allowed changed file should pass enforce mode');

  write(root, 'src/other.ts', 'export const other = 1;\n');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'fail', 'unacknowledged out-of-scope file should fail enforce mode');
  assert.ok(checked.violations.some((v: any) => v.path === 'src/other.ts' && v.rule === 'out_of_scope'), 'violation should identify out-of-scope file');
  assertScopeRow(checked, 'B-997b CHK-004 out-of-scope row', {
    id: 'scope.out_of_scope:src/other.ts',
    source: 'src/other.ts',
    status: 'fail',
    blocking: true,
    action: /scope_contract_acknowledge|Declare the path/i,
  });

  const ack = run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Required for smoke coverage of explicit scope expansion.',
  });
  assert.match(ack, /Scope change acknowledged/, 'acknowledgement should render user-visible transcript');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'warn', 'acknowledged out-of-scope file should warn, not pass silently');
  assert.ok(checked.acknowledgedPaths.includes('src/other.ts'), 'acknowledged path remains visible');
  assertScopeRow(checked, 'B-997b CHK-004 acknowledged row', {
    id: 'scope.out_of_scope:src/other.ts',
    source: 'src/other.ts',
    status: 'warn',
    blocking: false,
    action: /review|acknowledged|visible/i,
  });

  const waveContract = {
    storyId,
    mode: 'enforce' as const,
    allowedModify: ['src/allowed.ts'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const lifecycleRuntimePositive = checkScopeContract(waveContract, [
    '.lattice/story/actives/B-scope/summary.json',
    '.lattice/story/actives/B-scope/evidence/live-smoke-transcript.json',
    '.lattice/activity.jsonl',
  ]);
  assert.equal(lifecycleRuntimePositive.status, 'pass', 'registered lifecycle/runtime artifacts should pass scope');
  assertScopeRow(lifecycleRuntimePositive, 'B-997b CHK-004 lifecycle row', {
    id: 'scope.lifecycle_artifact:B-scope:summary.json',
    source: '.lattice/story/actives/B-scope/summary.json',
    status: 'pass',
    blocking: false,
    action: /provenance|artifact|not.*gate/i,
  });
  assertScopeRow(lifecycleRuntimePositive, 'B-d669 live-smoke transcript lifecycle row', {
    id: 'scope.lifecycle_artifact:B-scope:live-smoke-transcript.json',
    source: '.lattice/story/actives/B-scope/evidence/live-smoke-transcript.json',
    status: 'pass',
    blocking: false,
    action: /provenance|artifact|not.*gate/i,
  });
  const runtimeRow = findScopeRow(
    lifecycleRuntimePositive,
    'B-997b CHK-004 runtime row',
    row => typeof row.id === 'string'
      && row.id.startsWith('scope.runtime_artifact:')
      && row.source === '.lattice/activity.jsonl'
      && row.status === 'pass'
      && row.blocking === false,
  );
  assert.match(String(runtimeRow.nextAction ?? runtimeRow.hint ?? ''), /runtime|not.*scope|registry/i, 'runtime row should name registry/runtime treatment');

  // B-12a1: ProofStory intent-hardening artifacts (store.ts B-7287 block) are
  // command-generated story metadata and must classify lifecycle_artifact pass
  // under an enforce contract that does not list story-metadata paths.
  const proofStoryArtifacts = [
    'original-intent-snapshot.json',
    'milestone-ledger.json',
    'milestone-closeout.json',
    'slice-plan.json',
    'parent-ledger-rollup.json',
    'proofstory.json',
    'intent-collision.json',
    'scope-shrinkage-decision.json',
    'red-evidence.json',
    'spike.json',
  ];
  const proofStoryPositive = checkScopeContract(
    waveContract,
    proofStoryArtifacts.map(name => `.lattice/story/actives/B-scope/${name}`),
  );
  // Per-row assertions run first so a regression names the exact artifact
  // (B-12a1:F-001); the overall-status check still guards warn-masking.
  for (const name of proofStoryArtifacts) {
    assertScopeRow(proofStoryPositive, `B-12a1 ProofStory lifecycle row ${name}`, {
      id: `scope.lifecycle_artifact:B-scope:${name}`,
      source: `.lattice/story/actives/B-scope/${name}`,
      status: 'pass',
      blocking: false,
      action: /provenance|artifact|not.*gate/i,
    });
  }
  assert.equal(proofStoryPositive.status, 'pass', 'ProofStory intent artifacts should pass scope as lifecycle artifacts');

  // B-3ed9: command-family story metadata written by store.ts (grill /
  // finding clusters / scope-extension decisions) must classify
  // lifecycle_artifact pass under an enforce contract that does not list
  // story-metadata paths.
  const commandFamilyArtifacts = [
    'grill.json',
    'clusters.json',
    'scope-extension-decisions.json',
  ];
  const commandFamilyPositive = checkScopeContract(
    waveContract,
    commandFamilyArtifacts.map(name => `.lattice/story/actives/B-scope/${name}`),
  );
  for (const name of commandFamilyArtifacts) {
    assertScopeRow(commandFamilyPositive, `B-3ed9 command-family lifecycle row ${name}`, {
      id: `scope.lifecycle_artifact:B-scope:${name}`,
      source: `.lattice/story/actives/B-scope/${name}`,
      status: 'pass',
      blocking: false,
      action: /provenance|artifact|not.*gate/i,
    });
  }
  assert.equal(commandFamilyPositive.status, 'pass', 'command-family story metadata should pass scope as lifecycle artifacts');

  // B-3ed9: the singular cluster.json registry entry was stale — no command
  // ever wrote that filename. Now unregistered, it fails closed.
  const staleClusterNegative = checkScopeContract(waveContract, [
    '.lattice/story/actives/B-scope/cluster.json',
  ]);
  assert.equal(staleClusterNegative.status, 'fail', 'unregistered singular cluster.json must fail closed as out_of_scope');
  assertScopeRow(staleClusterNegative, 'B-3ed9 stale cluster.json fail-closed row', {
    id: 'scope.out_of_scope:.lattice/story/actives/B-scope/cluster.json',
    source: '.lattice/story/actives/B-scope/cluster.json',
    status: 'fail',
    blocking: true,
    action: /scope_contract_acknowledge|Declare the path/i,
  });

  const failClosedNegative = checkScopeContract(waveContract, [
    '.lattice/story/actives/B-scope/evidence/notes.md',
    '.lattice/story/actives/B-scope/unknown-metadata.json',
    'packages/main/src/handlers/unowned-source.ts',
    'packages/main/tests/fixtures/direct-edit.json',
  ]);
  assert.equal(failClosedNegative.status, 'fail', 'unknown metadata/source/fixture paths should fail closed');
  for (const source of [
    '.lattice/story/actives/B-scope/evidence/notes.md',
    '.lattice/story/actives/B-scope/unknown-metadata.json',
    'packages/main/src/handlers/unowned-source.ts',
    'packages/main/tests/fixtures/direct-edit.json',
  ]) {
    assert.ok(
      failClosedNegative.violations.some((v: any) => v.path === source && v.rule === 'out_of_scope'),
      `fail-closed violation should name ${source}`,
    );
    assertScopeRow(failClosedNegative, `B-997b CHK-004 fail-closed row ${source}`, {
      id: `scope.out_of_scope:${source}`,
      source,
      status: 'fail',
      blocking: true,
      action: /scope_contract_acknowledge|Declare the path|fixture/i,
    });
  }

  write(root, 'src/protected.ts', 'export const protectedValue = 2;\n');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'fail', 'protected files fail even when other paths are acknowledged');
  assert.ok(checked.violations.some((v: any) => v.path === 'src/protected.ts' && v.rule === 'protected'), 'protected rule should be visible');

  run(root, 'scope_contract_set', {
    storyId,
    mode: 'shadow',
    allowedModify: ['src/allowed.ts'],
  });
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'warn', 'shadow mode warns instead of blocking out-of-scope paths');
  assert.match(run(root, 'scope_contract_check', { storyId }), /Scope gate: warn/, 'text output should include warning transcript');

  // B-6bfd F-003 regression: a single-digest acknowledgement must persist only
  // the singular `hunkDigest` field (not the redundant plural `hunkDigests`),
  // while a multi-digest acknowledgement persists only the plural `hunkDigests`.
  run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Single hunk digest acknowledgement for F-003 regression coverage.',
    hunkDigest: 'abc12345',
  });
  const afterSingle = store.readScopeContract(storyId);
  assert.ok(afterSingle, 'contract should exist after single-digest acknowledgement');
  const singleAck = afterSingle!.acknowledgements[afterSingle!.acknowledgements.length - 1];
  assert.equal(singleAck.hunkDigest, 'abc12345', 'single digest persists singular hunkDigest');
  assert.ok(!('hunkDigests' in singleAck), 'single digest must NOT redundantly persist plural hunkDigests (F-003)');

  run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Multiple hunk digests acknowledgement for F-003 regression coverage.',
    hunkDigests: ['abc12345', 'def67890'],
  });
  const afterMulti = store.readScopeContract(storyId);
  assert.ok(afterMulti, 'contract should exist after multi-digest acknowledgement');
  const multiAck = afterMulti!.acknowledgements[afterMulti!.acknowledgements.length - 1];
  assert.deepEqual(multiAck.hunkDigests, ['abc12345', 'def67890'], 'multiple digests persist plural hunkDigests');
  assert.ok(!('hunkDigest' in multiAck), 'multiple digests must NOT persist singular hunkDigest (F-003)');

  const localResult = checkScopeContract({
    storyId,
    mode: 'local',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, ['src/allowed.ts']);
  assert.equal(localResult.status, 'pass', 'local mode with no violations should pass');

  // CHK-004 B-a30e: runScopeTransitionGate advisory copy for warn status.
  // Shadow mode with an out-of-scope file is warn (not fail); the transition gate
  // must render advisory/not blocking text and name the recovery path.
  run(root, 'scope_contract_set', { storyId, mode: 'shadow', allowedModify: ['src/allowed.ts'] });
  // src/other.ts (out-of-scope) and src/protected.ts are both modified in the worktree;
  // shadow mode renders them as warn, not fail.
  const minimalCtx = { store, root } as HandlerContext;

  // DEV phase warn: advisory, acknowledge, then proceed.
  const warnOutputDev = runScopeTransitionGate(minimalCtx, storyId, 'DEV');
  assert.match(warnOutputDev, /advisory, not blocking/, 'CHK-004: DEV phase warn output must say advisory, not blocking');
  assert.match(warnOutputDev, /scope_contract_acknowledge/, 'CHK-004: DEV phase warn output must name scope_contract_acknowledge recovery');

  // TEST phase warn: advisory, roll back to DEV recovery.
  const warnOutputTest = runScopeTransitionGate(minimalCtx, storyId, 'TEST');
  assert.match(warnOutputTest, /advisory, not blocking/, 'CHK-004: TEST phase warn output must say advisory, not blocking');
  assert.match(warnOutputTest, /roll back to DEV/, 'CHK-004: TEST phase warn output must name roll back to DEV recovery');

  // CHK-004: blocking scope failures still throw and name the hard recovery.
  run(root, 'scope_contract_set', { storyId, mode: 'enforce', allowedModify: ['src/allowed.ts'] });
  assert.throws(
    () => runScopeTransitionGate(minimalCtx, storyId, 'DEV'),
    /scope_contract_acknowledge|Cannot enter DEV/,
    'CHK-004: enforce mode out-of-scope diff must throw and name scope_contract_acknowledge',
  );

  // CHK-004: scope_contract_set phase limits unchanged — scope contract can be updated in any phase.
  run(root, 'scope_contract_set', { storyId, mode: 'shadow', allowedModify: ['src/allowed.ts'] });
  const resetShow = run(root, 'scope_contract_show', { storyId });
  assert.match(resetShow, /Mode: shadow/, 'CHK-004: scope_contract_set always updates the contract regardless of phase');

  // B-08be CHK-001 regression: direct and lifecycle scope gates must read git
  // diffs from the authoritative story worktree, not unrelated metadataRoot
  // dirt. This fixture intentionally calls the handler with root=metadataRoot
  // while the story metadata points at a linked story worktree.
  const authorityRoot = mkdtempSync(join(tmpdir(), 'lattice-scope-authority-'));
  try {
    git(authorityRoot, ['init', '-b', 'main']);
    git(authorityRoot, ['config', 'user.email', 'scope-authority@example.test']);
    git(authorityRoot, ['config', 'user.name', 'Scope Authority Smoke']);
    write(authorityRoot, '.gitignore', '.worktrees/\n');
    write(authorityRoot, 'lattice.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
      worktreeDir: '.worktrees',
    }, null, 2));
    write(authorityRoot, 'src/allowed.ts', 'export const allowed = 1;\n');
    git(authorityRoot, ['add', '.']);
    git(authorityRoot, ['commit', '-m', 'init']);

    const authorityStoryId = 'B-authority';
    const authorityStore = new StoryStore(authorityRoot);
    const authorityWorktreeRel = `.worktrees/${authorityStoryId}`;
    const authorityWorktreePath = join(authorityRoot, authorityWorktreeRel);
    const authorityStory: StoryInfo = {
      storyId: authorityStoryId,
      name: 'scope-authority-smoke',
      title: 'Scope authority smoke',
      description: 'Verify scope gates read the authoritative story worktree diff.',
      type: 'feature',
      phase: 'DEV',
      priority: 'high',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      events: [],
      worktree: {
        path: authorityWorktreeRel,
        branch: `story/${authorityStoryId}`,
        createdAt: new Date().toISOString(),
      },
    };
    authorityStore.writeStory(authorityStoryId, authorityStory);
    authorityStore.writeChecklist(authorityStoryId, {
      items: [{
        id: 'CHK-001',
        title: 'Allowed source change',
        status: 'in_progress',
        startTime: null,
        endTime: null,
        files: { modify: ['src/allowed.ts'], create: [], test: [] },
      }],
    });
    authorityStore.writeScopeContract(authorityStoryId, {
      storyId: authorityStoryId,
      mode: 'enforce',
      allowedModify: ['src/allowed.ts'],
      allowedCreate: [],
      allowedTest: [],
      protectedFiles: [],
      explicitExcludes: [],
      acknowledgements: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    git(authorityRoot, ['add', '.lattice']);
    git(authorityRoot, ['commit', '-m', 'story metadata']);
    git(authorityRoot, ['branch', `story/${authorityStoryId}`]);
    git(authorityRoot, ['worktree', 'add', authorityWorktreePath, `story/${authorityStoryId}`]);

    write(authorityRoot, 'src/root-dirt.ts', 'export const rootDirt = true;\n');
    write(authorityWorktreePath, 'src/allowed.ts', 'export const allowed = 2;\n');

    const authorityCtx = { store: authorityStore, root: authorityRoot } as HandlerContext;
    const directResult = JSON.parse(createScopeContractHandlers(authorityCtx).scope_contract_check({
      storyId: authorityStoryId,
      json: true,
    }));
    assert.equal(directResult.status, 'pass', 'B-08be: direct scope_contract_check uses story worktree diff');
    assert.deepEqual(directResult.changedFiles, ['src/allowed.ts'], 'B-08be: direct scope check ignores metadataRoot dirt');
    assert.ok(
      !directResult.changedFiles.includes('src/root-dirt.ts'),
      'B-08be: metadataRoot dirty file must not appear in direct scope changedFiles',
    );

    const lifecycleOutput = runScopeTransitionGate(authorityCtx, authorityStoryId, 'REVIEW');
    assert.match(lifecycleOutput, /Scope gate: pass/, 'B-08be: lifecycle scope transition gate passes from story worktree diff');
    assert.doesNotMatch(lifecycleOutput, /root-dirt/, 'B-08be: lifecycle scope rows must not report metadataRoot dirt');
  } finally {
    rmSync(authorityRoot, { recursive: true, force: true });
  }

  console.log('scope contract smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
