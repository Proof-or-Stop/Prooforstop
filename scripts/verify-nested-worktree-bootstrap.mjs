#!/usr/bin/env node

// B-1a12 CHK-001: regression smoke proving INIT_CHECK bootstrap resolves the
// MAIN repo root (not the current worktree) so a bootstrap whose metadata
// project-root resolves to a LINKED WORKTREE never creates a nested
// `<worktree>/.worktrees/B-new`.
//
// Faithful reproduction of the B-a4e3 incident: lattice was driven from inside
// an existing story worktree, so cwd-upward project-root discovery made the
// handler's `root` the linked worktree. The old resolver used
// `git rev-parse --show-toplevel` (cwd=root) which, from a linked worktree,
// returns the WORKTREE -> nested worktree creation. We model that by running the
// INIT_CHECK bootstrap with `--root <linked-worktree>` (so the handler's `root`
// IS the worktree) and the target story's INIT-phase metadata reachable there.
//
// Modeled on scripts/verify-init-check-bootstrap.mjs (same run()/createTempProject
// helpers and INIT_CHECK gate setup).

import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');
const sessionEnv = {
  ...process.env,
  LATTICE_SESSION_ID: 'nested-worktree-bootstrap-smoke',
};
delete sessionEnv.LATTICE_AGENT;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// projectRoot=null omits --root (cwd-upward discovery); otherwise pins the
// handler's metadata `root` to the given dir.
function run(projectRoot, command, payload, cwd = root) {
  const args = [cli];
  if (projectRoot) args.push('--root', projectRoot);
  args.push(command);
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd,
    env: sessionEnv,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-nested-worktree-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# temp project\n');
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.name', 'Lattice Test'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'lattice@example.com'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  return dir;
}

function makeBackground(label) {
  return [
    '## Trigger Event',
    `2026-06-18 B-0000 ${label} verifier needs a realistic story_create input before it can exercise INIT_CHECK bootstrap behavior.`,
    '## Key Insights',
    'The nested-worktree smoke owns from-worktree bootstrap behavior, so its synthetic stories must satisfy the current background truth-source contract first.',
    '## Solution Tradeoffs',
    'Use one reusable four-section background helper instead of weakening story_create or duplicating long literals in every regression case.',
    '## Conversational Texture',
    'The visible outcome remains the same for a maintainer: the verifier should fail only when bootstrap root resolution regresses to the current worktree.',
  ].join('\n\n');
}

function extractStoryId(text) {
  const storyId = text.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`failed to parse story id from: ${text}`);
  return storyId;
}

// INIT_CHECK requires confirmed scope/execution boundaries + a scope-freeze
// check before the worktree is created. Mirror the existing bootstrap smoke.
function setupInitCheckGates(projectRoot, storyId) {
  run(projectRoot, 'scope_boundary_set', {
    storyId,
    mode: 'feature',
    allowedScope: ['Create the story worktree for nested-worktree regression coverage'],
    excludedScope: ['Unrelated source changes'],
    userConfirmed: true,
    confirmation: 'nested-worktree bootstrap smoke fixture',
  });
  run(projectRoot, 'execution_boundary_set', {
    storyId,
    allowedPaths: ['docs/story'],
    notes: 'nested-worktree bootstrap smoke fixture',
  });
  run(projectRoot, 'scope_freeze_check', { storyId });
}

// Satisfy the INIT_CHECK init-check gate the same controlled way the existing
// smoke does (two required reviewer agents + scope/execution boundaries).
function recordInitCheck(projectRoot, storyId) {
  run(projectRoot, 'init_check_set', { storyId, issues: [], agentId: 'lattice-review-story-init' });
  run(projectRoot, 'init_check_set', { storyId, issues: [], agentId: 'product-reviewer' });
  setupInitCheckGates(projectRoot, storyId);
}

function createInitCheckedStory(projectRoot, name) {
  const storyId = extractStoryId(run(projectRoot, 'story_create', {
    name,
    title: `Nested worktree ${name}`,
    description: 'Verify INIT_CHECK bootstrap resolves the main repo root, not the current worktree.',
    background: makeBackground(name),
    type: 'feature',
    priority: 'high',
    checklist: [{ title: 'bootstrap worktree', context: 'nested-worktree regression case' }],
  }));
  recordInitCheck(projectRoot, storyId);
  return storyId;
}

function bootstrap(projectRoot, storyId, cwd) {
  return run(projectRoot, 'story_advance', { storyId, phase: 'INIT_CHECK', confirm: true }, cwd);
}

function verifyNestedWorktreeBootstrap() {
  const main = createTempProject();
  try {
    // 1. Build B-old on main and bootstrap it so <main>/.worktrees/B-old exists.
    const oldStory = createInitCheckedStory(main, 'old-worktree');
    bootstrap(main, oldStory, main);
    const oldWorktree = join(main, '.worktrees', oldStory);
    assert(existsSync(oldWorktree), `precondition failed: ${oldStory} worktree missing at ${oldWorktree}`);

    // 2. Build B-new on main (INIT phase, init-check satisfied) but DON'T bootstrap it.
    const newStory = createInitCheckedStory(main, 'new-from-worktree');

    // 3. Make B-new's metadata reachable when the handler's `root` IS the B-old
    //    worktree (the real incident: cwd-upward discovery resolved root to the
    //    linked worktree). Bootstrapping with --root=<oldWorktree> pins the
    //    handler's metadata root to the linked worktree exactly as the incident.
    cpSync(
      join(main, 'docs', 'story', 'actives', newStory),
      join(oldWorktree, 'docs', 'story', 'actives', newStory),
      { recursive: true },
    );

    bootstrap(oldWorktree, newStory, oldWorktree);

    const correctPath = join(main, '.worktrees', newStory);
    const nestedPath = join(oldWorktree, '.worktrees', newStory);

    // 4. ASSERT non-nested: lands under the MAIN repo, never under B-old. On the
    //    pre-fix --show-toplevel resolver, root=<oldWorktree> => show-toplevel
    //    returns the worktree => the new worktree is created at `nestedPath`.
    assert(
      existsSync(correctPath),
      `from-worktree-root bootstrap must create the new worktree under the MAIN repo at ${correctPath} (nested at ${nestedPath}? ${existsSync(nestedPath)})`,
    );
    assert(
      !existsSync(nestedPath),
      `from-worktree-root bootstrap must NOT nest the new worktree under the current worktree at ${nestedPath}`,
    );

    // 5. Byte-identical-from-main: a third story bootstrapped from <main> (root
    //    pinned to main) must still land at <main>/.worktrees/B-<id>.
    const mainStory = createInitCheckedStory(main, 'from-main');
    bootstrap(main, mainStory, main);
    const fromMainPath = join(main, '.worktrees', mainStory);
    assert(
      existsSync(fromMainPath),
      `from-main bootstrap must land at ${fromMainPath} (byte-identical-from-main)`,
    );

    console.log(`nested-worktree bootstrap verified: from-worktree-root -> ${correctPath} (not ${nestedPath}); from-main -> ${fromMainPath}`);
  } finally {
    rmSync(main, { recursive: true, force: true });
  }
}

verifyNestedWorktreeBootstrap();
