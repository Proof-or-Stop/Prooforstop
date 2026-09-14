#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactEnvironment } from '../core/causal-evidence.js';
import { acceptanceDiscoveryProfile } from '../core/acceptance-discovery-adapters.js';
import { isManagedGlobalThinRoot } from '../core/config.js';
import { renderEvidenceStaleHint } from '../core/evidence-stale-hint.js';
import { StoryStore } from '../core/store.js';
import { evaluatePreReviewCheckForContext } from '../handlers/proofstory.js';
import { assertMainWorktreeReadyForMerge } from '../handlers/done-effects.js';
import { createPlaybookRuntimeMemoryHandlers } from '../handlers/playbook-runtime-memory.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';
import type { HandlerContext } from '../handlers/context.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../../..');
const failures: string[] = [];

function check(name: string, run: () => void): void {
  try { run(); }
  catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

function initRepo(root: string, branch: string): void {
  git(root, ['init', '-q', '-b', branch]);
  git(root, ['config', 'user.email', 'lab@example.invalid']);
  git(root, ['config', 'user.name', 'Lab']);
  write(root, 'README.md', 'fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
}

check('proxy credentials are absent from causal identity and output-redaction inputs', () => {
  const sentinel = 'http://user:PROXY_SENTINEL@proxy.invalid:8080';
  const environment = redactEnvironment({ HTTPS_PROXY: sentinel, API_TOKEN: 'TOKEN_SENTINEL', LANG: 'en_US.UTF-8' });
  assert.equal(JSON.stringify(environment).includes('PROXY_SENTINEL'), false);
  assert.match(environment.HTTPS_PROXY ?? '', /^<redacted>:sha256:[a-f0-9]{64}$/);
  assert.equal(environment.LANG, 'en_US.UTF-8');
});

check('INIT reviewer uses a host-neutral instruction source', () => {
  const prompt = readFileSync(join(repositoryRoot, 'packages/main/templates/agents/proof-or-stop-review-story-init.md'), 'utf8');
  assert.equal(prompt.includes('`CLAUDE.md` (root directory)'), false);
  assert.match(prompt, /AGENTS\.md|host-neutral project instructions/i);
});

check('master-only repository is a valid integration worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-master-integration-'));
  try {
    initRepo(root, 'master');
    assert.equal(assertMainWorktreeReadyForMerge('B-master', root), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('linked worktree inherits global-thin identity from the common repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-global-thin-'));
  const worktree = join(root, '.worktrees', 'B-global-thin');
  try {
    initRepo(root, 'main');
    write(root, '.proof-or-stop/proof-or-stop.json', JSON.stringify({ assetMode: 'global-thin' }));
    git(root, ['branch', 'story/B-global-thin']);
    mkdirSync(dirname(worktree), { recursive: true });
    git(root, ['worktree', 'add', '-q', worktree, 'story/B-global-thin']);
    assert.equal(isManagedGlobalThinRoot(worktree), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('Go profile describes command evidence instead of unsupported topology adapters', () => {
  const profile = acceptanceDiscoveryProfile('go-command') as { methods: readonly string[] };
  assert.deepEqual(profile.methods, ['registered_command_receipts']);
});

check('stale evidence hint names every stale intent', () => {
  const hint = renderEvidenceStaleHint('B-stale', [
    { intentRef: 'CHK-001:happy:0', itemId: 'CHK-001', reason: 'material drift' },
    { intentRef: 'CHK-002:edge:0', itemId: 'CHK-002', reason: 'story drift' },
  ], { currentHead: 'abcdef012345' });
  assert.match(hint, /CHK-001:happy:0/);
  assert.match(hint, /CHK-002:edge:0/);
  assert.match(hint, /verification_evidence_refresh_stale --storyId=B-stale/);
});

check('observe pre-review reports a missing PLAN basis without throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-missing-basis-'));
  try {
    initRepo(root, 'main');
    write(root, 'proof-or-stop.config.json', JSON.stringify({
      storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures',
      proofStory: { acceptanceTopologyGateMode: 'observe' },
    }));
    const store = new StoryStore(root);
    store.writeStory('B-missing-basis', {
      storyId: 'B-missing-basis', name: 'missing-basis', title: 'Missing basis', description: 'Missing basis observe regression',
      type: 'bug', phase: 'DEV', priority: 'high', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
    });
    store.writeChecklist('B-missing-basis', { items: [] });
    const ctx: HandlerContext = { root, scanRoot: root, store };
    const report = evaluatePreReviewCheckForContext(ctx, 'B-missing-basis');
    assert.equal(report.blocking, false);
    assert.ok((report.codes as readonly string[]).includes('PR_COVERAGE_BASIS_MISSING'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('final response check exposes nonterminal lifecycle state to adapters', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-finalizer-'));
  try {
    initRepo(root, 'main');
    write(root, 'proof-or-stop.config.json', JSON.stringify({ storyDir: '.proof-or-stop/story/actives', scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures' }));
    const store = new StoryStore(root);
    store.writeStory('B-finalizer', {
      storyId: 'B-finalizer', name: 'finalizer', title: 'Finalizer', description: 'Finalizer regression', type: 'bug', phase: 'DEV', priority: 'high',
      createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
    });
    const ctx: HandlerContext = { root, scanRoot: root, store };
    const result = createPlaybookRuntimeMemoryHandlers(ctx).final_response_check({ storyId: 'B-finalizer', json: true });
    assert.equal(result.storyPhase, 'DEV');
    assert.equal(result.lifecycleComplete, false);
    assert.equal(result.completionStatus, 'continuation_required');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

check('story_advance exposes a structured JSON result option', () => {
  const definition = MAIN_TOOLS.find(tool => tool.name === 'story_advance');
  assert.ok(definition);
  assert.ok(definition && 'json' in definition.schema);
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`BENCHMARK_FRAMEWORK_HARDENING_RED ${failure}`);
  process.exit(1);
}

console.log('benchmark-framework-hardening-smoke: PASS');
