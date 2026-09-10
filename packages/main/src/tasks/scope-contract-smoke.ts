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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, ScopeContractData, StoryInfo } from '../core/types.js';
import {
  checkScopeContract,
  readChangedFiles,
  readRetiredRepoRootDiffPaths,
  validatePaths,
} from '../core/scope-contract.js';
import {
  canonicalizeScopePath,
  isMalformedScopeGlob,
  pathMatchesScopePattern,
  scopeGlobRegex,
  SCOPE_PATH_CANONICALIZER_VERSION,
} from '../core/scope-path-classifier.js';
import { createScopeContractHandlers, runScopeGate } from '../handlers/scope-contract.js';
import { runScopeTransitionGate } from '../handlers/phase-gates.js';
import type { HandlerContext } from '../handlers/context.js';
import { buildFullTaskContext } from '../core/prompt-envelope.js';
import { projectScopeInventory, SCOPE_INVENTORY_LIMITS } from '../core/scope-inventory-budget.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const sessionEnv = { ...process.env, PROOF_OR_STOP_SESSION_ID: 'scope-contract-smoke', PROOF_OR_STOP_AGENT: 'scope-contract-smoke' };

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

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-contract-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'scope@example.test']);
  git(root, ['config', 'user.name', 'Scope Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'src/allowed.ts', 'export const allowed = 1;\n');
  write(root, 'src/protected.ts', 'export const protectedValue = 1;\n');
  write(root, 'packages/main/src/core/foo.ts', 'export const foo = 1;\n');
  write(root, 'README.md', 'scope contract smoke\n');
  write(root, 'retired-root.md', 'retired root fixture\n');
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
  git(root, ['add', '.proof-or-stop']);
  git(root, ['commit', '-m', 'story metadata']);
  git(root, ['checkout', '-b', `story/${storyId}`]);

  const canonicalArgs = { projectRoot: root, scanRoot: 'packages/main', sourceRoot: 'src' };
  const canonicalSource = canonicalizeScopePath({ ...canonicalArgs, input: 'core/foo.ts' });
  assert.equal(canonicalSource.canonicalPath, 'packages/main/src/core/foo.ts');
  assert.equal(canonicalSource.base, 'source-root');
  assert.equal(canonicalSource.version, SCOPE_PATH_CANONICALIZER_VERSION);
  assert.equal(
    canonicalizeScopePath({ ...canonicalArgs, input: '.\\core\\..\\core\\foo.ts' }).canonicalPath,
    canonicalSource.canonicalPath,
    'Windows separators and dot segments converge',
  );
  assert.equal(
    canonicalizeScopePath({ ...canonicalArgs, input: 'packages/main/src/core/foo.ts' }).canonicalPath,
    canonicalSource.canonicalPath,
    'repo-root-relative input is idempotent',
  );
  assert.throws(() => canonicalizeScopePath({ ...canonicalArgs, input: '/etc/passwd' }), /absolute/);
  assert.throws(() => canonicalizeScopePath({ ...canonicalArgs, input: 'C:\\Windows\\system.ini' }), /absolute/);
  assert.throws(() => canonicalizeScopePath({ ...canonicalArgs, input: '../secret' }), /traversal/);
  assert.throws(() => canonicalizeScopePath({ ...canonicalArgs, input: '%2e%2e/secret' }), /encoded/);
  const retiredFixtureRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-retired-scope-path-'));
  try {
    git(retiredFixtureRoot, ['init', '-b', 'main']);
    git(retiredFixtureRoot, ['config', 'user.email', 'retired-scope@example.test']);
    git(retiredFixtureRoot, ['config', 'user.name', 'Retired Scope Smoke']);
    write(retiredFixtureRoot, 'packages/main/src/.keep', 'source root\n');
    write(retiredFixtureRoot, 'retired-root.md', 'retired identity content\n');
    git(retiredFixtureRoot, ['add', '.']);
    git(retiredFixtureRoot, ['commit', '-m', 'retired baseline']);
    git(retiredFixtureRoot, ['checkout', '-b', 'story/B-retired-scope']);
    git(retiredFixtureRoot, ['mv', 'retired-root.md', 'canonical-root.md']);
    const retiredRepoRootPaths = readRetiredRepoRootDiffPaths(retiredFixtureRoot);
    assert.deepEqual(
      retiredRepoRootPaths,
      ['retired-root.md'],
      'rename provenance exposes only the exact removed repo-root identity',
    );
    const retiredRoot = canonicalizeScopePath({
      projectRoot: retiredFixtureRoot,
      scanRoot: 'packages/main',
      sourceRoot: 'src',
      input: 'retired-root.md',
      exactRepoRootPaths: retiredRepoRootPaths,
    });
    assert.equal(retiredRoot.canonicalPath, 'retired-root.md', 'an exact renamed-away path keeps its repo-root identity');
    assert.equal(retiredRoot.base, 'repo-root', 'the exact retired path is never remapped below source-root');
    write(retiredFixtureRoot, 'shared/.keep', 'repo ancestor\n');
    write(retiredFixtureRoot, 'packages/main/src/shared/.keep', 'source ancestor\n');
    assert.throws(
      () => canonicalizeScopePath({
        projectRoot: retiredFixtureRoot,
        scanRoot: 'packages/main',
        sourceRoot: 'src',
        input: 'shared/missing.ts',
        exactRepoRootPaths: retiredRepoRootPaths,
      }),
      /ambiguous/,
      'an arbitrary missing ambiguous path is not covered by an unrelated exact retired-path classification',
    );
  } finally {
    rmSync(retiredFixtureRoot, { recursive: true, force: true });
  }
  assert.equal(pathMatchesScopePattern('src/core/a.ts', 'src/**/*.ts'), true, '** matches nested files');
  assert.equal(pathMatchesScopePattern('src/a.ts', 'src/**/*.ts'), true, '** matches zero directory segments');
  assert.equal(pathMatchesScopePattern('src/a1.ts', 'src/a?.ts'), true, '? matches exactly one character');
  assert.equal(pathMatchesScopePattern('src/a.ts', 'src/[ab].ts'), true, 'character classes are supported');
  assert.equal(pathMatchesScopePattern('src/c.ts', 'src/[!ab].ts'), true, 'negated character classes are supported');
  assert.equal(pathMatchesScopePattern('src/a.ts', 'src/{a,b}.ts'), true, 'brace alternatives are supported');
  assert.equal(pathMatchesScopePattern('src/c.ts', 'src/{a,b}.ts'), false, 'brace alternatives do not overmatch');
  assert.equal(pathMatchesScopePattern('src/a.ts', 'src/[ab.ts'), false, 'invalid glob grammar fails closed');
  const malformedGlobs = [
    'src/[broken',
    'src/[]',
    'src/broken]',
    'src/[!]',
    'src/[z-a]',
    'src/{broken',
    'src/{}',
    'src/{one}',
    'src/{one,}',
    'src/broken}',
    'src/a**b',
    'src/***',
    'src/{one,{two,three}}',
    'src/[a/b]',
  ];
  for (const pattern of malformedGlobs) {
    assert.equal(scopeGlobRegex(pattern), null, `${pattern}: malformed glob has no matcher`);
    assert.equal(isMalformedScopeGlob(pattern), true, `${pattern}: malformed glob is classified`);
    assert.throws(
      () => canonicalizeScopePath({ ...canonicalArgs, input: pattern }),
      /malformed glob/,
      `${pattern}: canonical write boundary rejects malformed glob`,
    );
  }
  const globContract = {
    storyId,
    mode: 'enforce' as const,
    allowedModify: ['src/**/*.{ts,tsx}'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: ['src/**/protected?.[tj]s'],
    explicitExcludes: ['src/**/{excluded,blocked}.ts'],
    acknowledgements: [],
    pathCanonicalizationMode: 'off' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assert.equal(checkScopeContract(globContract, ['src/deep/ok.ts']).status, 'pass');
  assert.equal(checkScopeContract(globContract, ['src/deep/protected1.ts']).violations[0]?.rule, 'protected');
  assert.equal(checkScopeContract(globContract, ['src/deep/excluded.ts']).violations[0]?.rule, 'excluded');
  for (const field of ['protectedFiles', 'explicitExcludes'] as const) {
    const malformedLegacy = {
      ...globContract,
      allowedModify: ['src/**'],
      protectedFiles: field === 'protectedFiles' ? ['src/[broken'] : [],
      explicitExcludes: field === 'explicitExcludes' ? ['src/{broken'] : [],
    };
    const result = checkScopeContract(malformedLegacy, ['src/anything.ts']);
    assert.equal(result.status, 'fail', `${field}: malformed legacy deny fails closed under broad allow`);
    assert.equal(result.violations[0]?.rule, field === 'protectedFiles' ? 'protected' : 'excluded');
  }
  write(root, 'shared/x.ts', 'repo\n');
  write(root, 'packages/main/src/shared/x.ts', 'source\n');
  assert.throws(
    () => canonicalizeScopePath({ ...canonicalArgs, input: 'shared/x.ts' }),
    /ambiguous/,
    'a spelling valid under both bases is rejected',
  );
  rmSync(join(root, 'shared'), { recursive: true, force: true });
  rmSync(join(root, 'packages/main/src/shared'), { recursive: true, force: true });
  const outside = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-outside-'));
  try {
    symlinkSync(outside, join(root, 'escape'));
    assert.throws(
      () => canonicalizeScopePath({ ...canonicalArgs, input: 'escape/file.ts' }),
      /symlink/,
      'symlink escape is rejected',
    );
  } finally {
    rmSync(join(root, 'escape'), { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
  symlinkSync(join(root, 'packages/main/src/core'), join(root, 'core-alias'));
  try {
    assert.equal(
      canonicalizeScopePath({ ...canonicalArgs, input: 'core-alias/foo.ts' }).canonicalPath,
      'packages/main/src/core/foo.ts',
      'an in-repository symlink converges to the physical repository identity',
    );
  } finally {
    rmSync(join(root, 'core-alias'), { force: true });
  }

  const noContract = run(root, 'scope_contract_check', { storyId, json: true });
  assert.equal(JSON.parse(noContract).status, 'skip', 'no contract should be backward-compatible skip');
  assert.match(run(root, 'scope_contract_show', { storyId }), /Scope contract: not configured/, 'show should degrade without contract');

  const invalid = run(root, 'scope_contract_set', { storyId, mode: 'strict' }, true);
  assert.match(invalid, /Invalid option|mode|strict/, 'invalid mode should be rejected');
  assert.throws(() => validatePaths(['../secret'], 'allowedModify'), /unsafe relative path/, 'unsafe paths are rejected by core validation');
  for (const field of ['allowedModify', 'allowedCreate', 'allowedTest', 'protectedFiles', 'explicitExcludes'] as const) {
    const rejected = run(root, 'scope_contract_set', {
      storyId,
      mode: 'enforce',
      [field]: ['src/[broken'],
    }, true);
    assert.match(rejected, /malformed glob/, `${field}: handler write boundary rejects malformed glob syntax`);
  }
  const legacyContract: ScopeContractData = {
    storyId: 'B-legacy',
    mode: 'enforce',
    allowedModify: ['src/allowed.ts'],
    allowedCreate: [],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const legacyBytes = JSON.stringify(legacyContract);
  assert.equal(
    checkScopeContract({ ...legacyContract, pathCanonicalizationMode: 'off' }, ['src/allowed.ts']).status,
    'pass',
    'path rollout off preserves legacy interpretation',
  );
  assert.equal(
    checkScopeContract({ ...legacyContract, pathCanonicalizationMode: 'warn' }, ['src/allowed.ts']).status,
    'warn',
    'path rollout warn reads legacy artifacts with a migration advisory',
  );
  assert.equal(
    checkScopeContract({ ...legacyContract, pathCanonicalizationMode: 'enforce' }, ['src/allowed.ts']).status,
    'fail',
    'path rollout enforce rejects a missing canonicalizer version',
  );
  assert.equal(JSON.stringify(legacyContract), legacyBytes, 'versioned readers never rewrite signed legacy bytes in place');

  // Configure fixture acceptance in PLAN; later DEV writes exercise the freeze.
  store.writeStory(storyId, { ...story, phase: 'PLAN' });
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

  run(root, 'scope_contract_set', { storyId, mode: 'enforce', allowedModify: ['src/allowed.ts', 'retired-root.md'], allowedCreate: ['src/new.ts', 'packages/main/src/core/future.ts'] });
  store.writeStory(storyId, story);
  git(root, ['mv', 'retired-root.md', 'canonical-root.md']);
  const retiredAck = run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['retired-root.md'],
    actor: 'scope-contract-smoke',
    reason: 'Acknowledge the exact repo-root identity removed by the one-shot rename.',
  });
  assert.match(retiredAck, /addedPaths: \[retired-root\.md\]/, 'handler preserves exact removed repo-root identity');
  assert.deepEqual(
    store.readScopeContract(storyId)?.acknowledgements.at(-1)?.paths,
    ['retired-root.md'],
    'handler does not remap a proven retired repo-root path below source-root',
  );
  write(root, 'shared/.keep', 'repo ancestor\n');
  write(root, 'packages/main/src/shared/.keep', 'source ancestor\n');
  assert.match(
    run(root, 'scope_contract_acknowledge', {
      storyId,
      paths: ['shared/missing.ts'],
      actor: 'scope-contract-smoke',
      reason: 'An arbitrary ambiguous missing path must remain blocked.',
    }, true),
    /ambiguous/,
    'handler rejects an arbitrary ambiguous missing path outside the exact retired set',
  );
  rmSync(join(root, 'shared'), { recursive: true, force: true });
  rmSync(join(root, 'packages/main/src/shared'), { recursive: true, force: true });
  git(root, ['mv', 'canonical-root.md', 'retired-root.md']);

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
    action: /acceptance_amendment_propose|Declare the path/i,
  });

  const beforeRejectedAck = JSON.stringify(store.readScopeContract(storyId));
  const ack = run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/other.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Required for smoke coverage of explicit scope expansion.',
  }, true);
  assert.match(ack, /acceptance_amendment_propose/, 'DEV expansion requires independent amendment approval');
  assert.equal(JSON.stringify(store.readScopeContract(storyId)), beforeRejectedAck, 'refusal preserves contract bytes');
  // Historical read fixture: retain legacy acknowledgement diagnostics without granting new expansion authority.
  const historical = store.readScopeContract(storyId)!;
  historical.acknowledgements.push({ actor: 'legacy-fixture', reason: 'Historical explicit scope expansion acknowledgement.', timestamp: story.createdAt, paths: ['src/other.ts'] });
  store.writeScopeContract(storyId, historical);
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
  run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['core/future.ts'],
    actor: 'scope-contract-smoke',
    reason: 'Verify acknowledgement paths use the same canonical source-root mapping.',
  });
  const ackContract = store.readScopeContract(storyId)!;
  assert.deepEqual(
    ackContract.acknowledgements.at(-1)?.paths,
    ['packages/main/src/core/future.ts'],
    'acknowledgement paths cannot bypass canonicalization with source-relative spelling',
  );
  assert.match(
    run(root, 'scope_contract_acknowledge', {
      storyId,
      paths: ['../escape.ts'],
      actor: 'scope-contract-smoke',
      reason: 'Traversal must remain rejected at acknowledgement boundary.',
    }, true),
    /unsafe|traversal/,
    'acknowledgement rejects traversal instead of recording a bypass',
  );

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
    '.proof-or-stop/story/actives/B-scope/summary.json',
    '.proof-or-stop/story/actives/B-scope/evidence/live-smoke-transcript.json',
    '.proof-or-stop/activity.jsonl',
  ]);
  assert.equal(lifecycleRuntimePositive.status, 'pass', 'registered lifecycle/runtime artifacts should pass scope');
  assertScopeRow(lifecycleRuntimePositive, 'B-997b CHK-004 lifecycle row', {
    id: 'scope.lifecycle_artifact:B-scope:summary.json',
    source: '.proof-or-stop/story/actives/B-scope/summary.json',
    status: 'pass',
    blocking: false,
    action: /provenance|artifact|not.*gate/i,
  });
  assertScopeRow(lifecycleRuntimePositive, 'B-d669 live-smoke transcript lifecycle row', {
    id: 'scope.lifecycle_artifact:B-scope:live-smoke-transcript.json',
    source: '.proof-or-stop/story/actives/B-scope/evidence/live-smoke-transcript.json',
    status: 'pass',
    blocking: false,
    action: /provenance|artifact|not.*gate/i,
  });
  const runtimeRow = findScopeRow(
    lifecycleRuntimePositive,
    'B-997b CHK-004 runtime row',
    row => typeof row.id === 'string'
      && row.id.startsWith('scope.runtime_artifact:')
      && row.source === '.proof-or-stop/activity.jsonl'
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
    proofStoryArtifacts.map(name => `.proof-or-stop/story/actives/B-scope/${name}`),
  );
  // Per-row assertions run first so a regression names the exact artifact
  // (B-12a1:F-001); the overall-status check still guards warn-masking.
  for (const name of proofStoryArtifacts) {
    assertScopeRow(proofStoryPositive, `B-12a1 ProofStory lifecycle row ${name}`, {
      id: `scope.lifecycle_artifact:B-scope:${name}`,
      source: `.proof-or-stop/story/actives/B-scope/${name}`,
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
    commandFamilyArtifacts.map(name => `.proof-or-stop/story/actives/B-scope/${name}`),
  );
  for (const name of commandFamilyArtifacts) {
    assertScopeRow(commandFamilyPositive, `B-3ed9 command-family lifecycle row ${name}`, {
      id: `scope.lifecycle_artifact:B-scope:${name}`,
      source: `.proof-or-stop/story/actives/B-scope/${name}`,
      status: 'pass',
      blocking: false,
      action: /provenance|artifact|not.*gate/i,
    });
  }
  assert.equal(commandFamilyPositive.status, 'pass', 'command-family story metadata should pass scope as lifecycle artifacts');

  // B-3ed9: the singular cluster.json registry entry was stale — no command
  // ever wrote that filename. Now unregistered, it fails closed.
  const staleClusterNegative = checkScopeContract(waveContract, [
    '.proof-or-stop/story/actives/B-scope/cluster.json',
  ]);
  assert.equal(staleClusterNegative.status, 'fail', 'unregistered singular cluster.json must fail closed as out_of_scope');
  assertScopeRow(staleClusterNegative, 'B-3ed9 stale cluster.json fail-closed row', {
    id: 'scope.out_of_scope:.proof-or-stop/story/actives/B-scope/cluster.json',
    source: '.proof-or-stop/story/actives/B-scope/cluster.json',
    status: 'fail',
    blocking: true,
    action: /acceptance_amendment_propose|Declare the path/i,
  });

  const failClosedNegative = checkScopeContract(waveContract, [
    '.proof-or-stop/story/actives/B-scope/evidence/notes.md',
    '.proof-or-stop/story/actives/B-scope/unknown-metadata.json',
    'packages/main/src/handlers/unowned-source.ts',
    'packages/main/tests/fixtures/direct-edit.json',
  ]);
  assert.equal(failClosedNegative.status, 'fail', 'unknown metadata/source/fixture paths should fail closed');
  for (const source of [
    '.proof-or-stop/story/actives/B-scope/evidence/notes.md',
    '.proof-or-stop/story/actives/B-scope/unknown-metadata.json',
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
      action: /acceptance_amendment_propose|Declare the path|fixture/i,
    });
  }

  write(root, 'src/protected.ts', 'export const protectedValue = 2;\n');
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'fail', 'protected files fail even when other paths are acknowledged');
  assert.ok(checked.violations.some((v: any) => v.path === 'src/protected.ts' && v.rule === 'protected'), 'protected rule should be visible');

  store.writeStory(storyId, { ...story, phase: 'PLAN' });
  run(root, 'scope_contract_set', {
    storyId,
    mode: 'shadow',
    allowedModify: ['src/allowed.ts'],
  });
  store.writeStory(storyId, story);
  checked = JSON.parse(run(root, 'scope_contract_check', { storyId, json: true }));
  assert.equal(checked.status, 'warn', 'shadow mode warns instead of blocking out-of-scope paths');
  assert.match(run(root, 'scope_contract_check', { storyId }), /Scope gate: warn/, 'text output should include warning transcript');

  // B-6bfd F-003 regression: a single-digest acknowledgement must persist only
  // the singular `hunkDigest` field (not the redundant plural `hunkDigests`),
  // while a multi-digest acknowledgement persists only the plural `hunkDigests`.
  run(root, 'scope_contract_acknowledge', {
    storyId,
    paths: ['src/allowed.ts'],
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
    paths: ['src/allowed.ts'],
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
  store.writeStory(storyId, { ...story, phase: 'PLAN' });
  run(root, 'scope_contract_set', { storyId, mode: 'shadow', allowedModify: ['src/allowed.ts'] });
  store.writeStory(storyId, story);
  // src/other.ts (out-of-scope) and src/protected.ts are both modified in the worktree;
  // shadow mode renders them as warn, not fail.
  const minimalCtx = { store, root } as HandlerContext;

  // DEV phase warn: advisory, acknowledge, then proceed.
  const warnOutputDev = runScopeTransitionGate(minimalCtx, storyId, 'DEV');
  assert.match(warnOutputDev, /advisory, not blocking/, 'CHK-004: DEV phase warn output must say advisory, not blocking');
  assert.match(warnOutputDev, /acceptance_amendment_propose/, 'CHK-004: DEV phase warn output must name acceptance_amendment_propose recovery');

  // TEST phase warn: advisory, roll back to DEV recovery.
  const warnOutputTest = runScopeTransitionGate(minimalCtx, storyId, 'TEST');
  assert.match(warnOutputTest, /advisory, not blocking/, 'CHK-004: TEST phase warn output must say advisory, not blocking');
  assert.match(warnOutputTest, /roll back to DEV/, 'CHK-004: TEST phase warn output must name roll back to DEV recovery');

  // CHK-004: blocking scope failures still throw and name the hard recovery.
  store.writeStory(storyId, { ...story, phase: 'PLAN' });
  run(root, 'scope_contract_set', { storyId, mode: 'enforce', allowedModify: ['src/allowed.ts'] });
  store.writeStory(storyId, story);
  assert.throws(
    () => runScopeTransitionGate(minimalCtx, storyId, 'DEV'),
    /acceptance_amendment_propose|Cannot enter DEV/,
    'CHK-004: enforce mode out-of-scope diff must throw and name acceptance_amendment_propose',
  );

  // DEV cannot downgrade the configured enforcement mode.
  const beforeDowngrade = JSON.stringify(store.readScopeContract(storyId));
  assert.match(run(root, 'scope_contract_set', { storyId, mode: 'shadow', allowedModify: ['src/allowed.ts'] }, true), /acceptance_amendment|mode/);
  assert.equal(JSON.stringify(store.readScopeContract(storyId)), beforeDowngrade);

  // B-08be CHK-001 regression: direct and lifecycle scope gates must read git
  // diffs from the authoritative story worktree, not unrelated metadataRoot
  // dirt. This fixture intentionally calls the handler with root=metadataRoot
  // while the story metadata points at a linked story worktree.
  const authorityRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-authority-'));
  try {
    git(authorityRoot, ['init', '-b', 'main']);
    git(authorityRoot, ['config', 'user.email', 'scope-authority@example.test']);
    git(authorityRoot, ['config', 'user.name', 'Scope Authority Smoke']);
    write(authorityRoot, '.gitignore', '.worktrees/\n');
    write(authorityRoot, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
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
      pathCanonicalizerVersion: SCOPE_PATH_CANONICALIZER_VERSION,
      pathCanonicalizationMode: 'enforce',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    git(authorityRoot, ['add', '.proof-or-stop']);
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

  // B-0784 F-022: name-status rename identity retains both old and new paths
  // so old-path deny rules and target boundary changes remain enforceable.
  const renameRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-rename-paths-'));
  try {
    write(renameRoot, 'src/old.ts', 'export function stable() { return 1; }\n');
    git(renameRoot, ['init', '-b', 'main']);
    git(renameRoot, ['config', 'user.email', 'rename-path@example.test']);
    git(renameRoot, ['config', 'user.name', 'Rename Path Smoke']);
    git(renameRoot, ['add', '.']);
    git(renameRoot, ['commit', '-m', 'base']);
    git(renameRoot, ['mv', 'src/old.ts', 'src/new.ts']);
    const changed = readChangedFiles(renameRoot);
    assert.deepEqual(changed, ['src/new.ts', 'src/old.ts'], 'pure staged rename retains both path identities');

    const renameContract = (overrides: Partial<ScopeContractData>): ScopeContractData => ({
      storyId: 'B-rename-path',
      mode: 'enforce',
      allowedModify: ['src/old.ts', 'src/new.ts'],
      allowedCreate: [],
      allowedTest: [],
      protectedFiles: [],
      explicitExcludes: [],
      acknowledgements: [],
      pathCanonicalizationMode: 'off',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    });
    assert.equal(checkScopeContract(renameContract({}), changed).status, 'pass', 'ordinary allowed rename passes');
    const protectedOld = checkScopeContract(renameContract({ protectedFiles: ['src/old.ts'] }), changed);
    assert.equal(protectedOld.status, 'fail');
    assert.equal(protectedOld.violations[0]?.path, 'src/old.ts');
    assert.equal(protectedOld.violations[0]?.rule, 'protected');
    const excludedOld = checkScopeContract(renameContract({ explicitExcludes: ['src/old.ts'] }), changed);
    assert.equal(excludedOld.status, 'fail');
    assert.equal(excludedOld.violations[0]?.path, 'src/old.ts');
    assert.equal(excludedOld.violations[0]?.rule, 'excluded');
    const excludedTarget = checkScopeContract(renameContract({ explicitExcludes: ['src/new.ts'] }), changed);
    assert.equal(excludedTarget.status, 'fail', 'allowed-to-excluded rename blocks at the target');
    const unknownTarget = checkScopeContract(renameContract({ allowedModify: ['src/old.ts'] }), changed);
    assert.equal(unknownTarget.status, 'fail', 'allowed-to-unknown rename blocks at the target');
    assert.equal(unknownTarget.violations[0]?.path, 'src/new.ts');
  } finally {
    rmSync(renameRoot, { recursive: true, force: true });
  }

  // B-0784 F-023/F-024/F-026: scope_diff_pack keeps wrapper config authority
  // separate from the story worktree Git authority.
  const wrapperRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-scope-wrapper-pack-'));
  try {
    const innerRepo = join(wrapperRoot, 'repo');
    const storyWorktree = join(wrapperRoot, '.worktrees', 'B-wrap');
    write(wrapperRoot, 'proof-or-stop.config.json', JSON.stringify({
      gitRoot: 'repo',
      scanRoot: 'src',
      rootDir: '.',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      scopeProtection: { pathCanonicalization: 'off', astAnchors: 'off' },
    }));
    write(innerRepo, 'src/allowed.ts', 'export function allowed() { return 1; }\n');
    git(innerRepo, ['init', '-b', 'main']);
    git(innerRepo, ['config', 'user.email', 'wrapper-scope@example.test']);
    git(innerRepo, ['config', 'user.name', 'Wrapper Scope Smoke']);
    git(innerRepo, ['add', '.']);
    git(innerRepo, ['commit', '-m', 'base']);
    mkdirSync(dirname(storyWorktree), { recursive: true });
    git(innerRepo, ['worktree', 'add', '-b', 'story/B-wrap', storyWorktree]);

    const wrapperStore = new StoryStore(wrapperRoot);
    wrapperStore.writeStory('B-wrap', {
      storyId: 'B-wrap',
      name: 'wrapper-pack',
      title: 'Wrapper scope diff pack',
      description: 'Verify metadata config and story Git authority stay separate.',
      type: 'feature',
      phase: 'DEV',
      priority: 'high',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      events: [],
      worktree: {
        path: '.worktrees/B-wrap',
        branch: 'story/B-wrap',
        createdAt: new Date().toISOString(),
      },
    });
    wrapperStore.writeScopeContract('B-wrap', {
      storyId: 'B-wrap',
      mode: 'enforce',
      allowedModify: ['src/allowed.ts'],
      allowedCreate: [],
      allowedTest: [],
      protectedFiles: [],
      explicitExcludes: [],
      acknowledgements: [],
      pathCanonicalizationMode: 'off',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    write(storyWorktree, 'src/allowed.ts', 'export function allowed() { return 2; }\n');
    write(innerRepo, 'src/root-dirt.ts', 'export const rootDirt = true;\n');

    const wrapperHandlers = createScopeContractHandlers({
      store: wrapperStore,
      root: wrapperRoot,
    } as HandlerContext);
    const wrapperPack = JSON.parse(wrapperHandlers.scope_diff_pack({ storyId: 'B-wrap', json: true }));
    assert.deepEqual(wrapperPack.changedFiles, ['src/allowed.ts'], 'scope_diff_pack reads only the bound story worktree');
    assert.equal(wrapperPack.astAnchorMode, 'off', 'wrapper metadata config controls AST rollout');
    assert.equal(wrapperPack.hunks[0]?.anchor, undefined);
    assert.equal(wrapperPack.hunks[0]?.parseFallback, 'ast_anchor_rollout_off_legacy_history_preserved');
    assert.equal(
      runScopeGate('B-wrap', wrapperStore, wrapperRoot, (cwd) => {
        assert.equal(cwd, storyWorktree, 'injected reader receives the resolved story worktree');
        assert.notEqual(cwd, wrapperRoot, 'injected reader never receives the metadata wrapper root');
        assert.notEqual(cwd, innerRepo, 'injected reader never receives the main inner repo');
        return ['src/allowed.ts'];
      }, storyWorktree)?.status,
      'pass',
      'injected-reader runScopeGate honors wrapper pathCanonicalization=off instead of inner-repo defaults',
    );
    assert.throws(
      () => wrapperHandlers.scope_diff_pack({ storyId: 'B-NONEXISTENT', json: true }),
      /does not exist/,
      'nonexistent storyId fails closed instead of falling back to another workspace',
    );
    assert.throws(
      () => wrapperHandlers.scope_diff_pack({ json: true }),
      /storyId is required/,
      'missing storyId fails closed',
    );
  } finally {
    rmSync(wrapperRoot, { recursive: true, force: true });
  }

  // B-adc3: accepted scope must remain representable by the downstream reviewer.
  const budgetId = 'B-scope-budget';
  store.writeStory(budgetId, { ...story, storyId: budgetId, phase: 'PLAN' });
  store.writeChecklist(budgetId, checklist);
  const budgetHandlers = createScopeContractHandlers({ root, scanRoot: root, store } as HandlerContext);
  const paths = (count: number) => Array.from({ length: count }, (_, i) => `packages/main/src/inventory/f${String(i).padStart(5, '0')}.ts`);
  const budgetFile = join(root, '.proof-or-stop/story/actives', budgetId, 'scope-contract.json');
  for (const count of [513, 799, SCOPE_INVENTORY_LIMITS.pathsPerList]) {
    budgetHandlers.scope_contract_set({ storyId: budgetId, mode: 'enforce', allowedCreate: paths(count) });
    const contract = store.readScopeContract(budgetId)!;
    const context = buildFullTaskContext({ story: { ...story, storyId: budgetId }, checklist, headHash: 'a'.repeat(40), scopeContract: contract });
    assert.equal(context.scope?.allowedCreate.length, count);
    assert.deepEqual(context.scope?.allowedCreate, paths(count), 'writer-to-review seam preserves every exact path');
  }
  const beforeOverflow = readFileSync(budgetFile, 'utf8');
  assert.throws(() => budgetHandlers.scope_contract_set({ storyId: budgetId, mode: 'enforce', allowedCreate: paths(4097) }), /4096|scope.*budget/i);
  assert.equal(readFileSync(budgetFile, 'utf8'), beforeOverflow, 'count overflow leaves persisted contract byte-identical');

  // Init-from-plan uses the same boundary and must not partially replace authority.
  store.writeChecklist(budgetId, { items: [{ ...checklist.items[0], files: { modify: [], create: paths(4097), test: [] } }] });
  assert.throws(() => budgetHandlers.scope_contract_init_from_plan({ storyId: budgetId }), /4096|scope.*budget/i);
  assert.equal(readFileSync(budgetFile, 'utf8'), beforeOverflow);
  store.writeChecklist(budgetId, checklist);

  // UTF-8 aggregate accounting spans multiple lists; each individual string remains bounded.
  const hugePaths = Array.from({ length: 32 }, (_, i) => `inventory/${i}/${'界'.repeat(12000)}.ts`);
  assert.throws(() => budgetHandlers.scope_contract_set({ storyId: budgetId, mode: 'enforce', allowedCreate: hugePaths }), /bytes|budget/i);
  assert.equal(readFileSync(budgetFile, 'utf8'), beforeOverflow, 'byte overflow cannot partially persist');
  assert.ok(Buffer.byteLength(JSON.stringify(projectScopeInventory(store.readScopeContract(budgetId)!)), 'utf8') < SCOPE_INVENTORY_LIMITS.serializedBytes);

  const atByteLimit = Array.from({ length: 32 }, (_, i) => `packages/main/src/inventory/${String(i).padStart(2, '0')}/${'界'.repeat(9000)}.ts`);
  const candidate = { ...store.readScopeContract(budgetId)!, allowedCreate: atByteLimit };
  const bytePadding = SCOPE_INVENTORY_LIMITS.serializedBytes - Buffer.byteLength(JSON.stringify(projectScopeInventory(candidate)), 'utf8');
  assert.ok(bytePadding > 0);
  for (let i = 0; i < bytePadding; i++) atByteLimit[i % atByteLimit.length] += 'x';
  budgetHandlers.scope_contract_set({ storyId: budgetId, mode: 'enforce', allowedCreate: atByteLimit });
  const exactContract = store.readScopeContract(budgetId)!;
  assert.equal(Buffer.byteLength(JSON.stringify(projectScopeInventory(exactContract)), 'utf8'), SCOPE_INVENTORY_LIMITS.serializedBytes);
  buildFullTaskContext({ story, checklist, headHash: 'a'.repeat(40), scopeContract: exactContract });
  const beforeByteOverflow = readFileSync(budgetFile, 'utf8');
  atByteLimit[0] += 'x';
  assert.throws(() => budgetHandlers.scope_contract_set({ storyId: budgetId, mode: 'enforce', allowedCreate: atByteLimit }), /bytes|budget/i);
  assert.equal(readFileSync(budgetFile, 'utf8'), beforeByteOverflow);

  // An omitted field is inherited by buildScopeContract: validate the merged contract.
  store.writeScopeContract(budgetId, { ...exactContract, allowedCreate: paths(4097) });
  const inheritedOverflow = readFileSync(budgetFile, 'utf8');
  assert.throws(() => budgetHandlers.scope_contract_set({ storyId: budgetId, mode: 'shadow', allowedModify: ['README.md'] }), /4096/);
  assert.equal(readFileSync(budgetFile, 'utf8'), inheritedOverflow);

  console.log('scope contract smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
