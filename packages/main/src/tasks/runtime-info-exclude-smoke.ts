#!/usr/bin/env node
/**
 * Run 11 (2026-09-30): the task repo's tracked .gitignore has no Proof-or-Stop
 * runtime block and the benchmark freezes .gitignore, so `proof-or-stop init`'s
 * merge stays an uncommitted main-checkout edit and every Story branch lacks it.
 * PoS's own runtime files (.proof-or-stop/activity.jsonl, runtime/, evidence/,
 * locks/, usage/, autopilot verdicts, .worktrees/) then showed in git status and
 * the quorum clean-baseline gate refused on them; the owner hand-wrote excludes
 * and skip-worktree flags, and a failed metadata commit left process-events
 * staged.
 *
 * Real CLI (init, story_create, checklist_update) in a temp Go-shaped repo:
 *   runtime-hidden        registry runtime files are absent from git status in the
 *                         linked Story worktree and the main checkout (.git/info/exclude)
 *   exclude-scoped        the managed block holds exactly the registry patterns plus the
 *                         worktree dir; tracked Story metadata, process-events.jsonl and
 *                         the projected controller hooks/receipt are NOT ignored
 *   exclude-idempotent    rerunning keeps user lines and one block
 *   autocommit-works      Story metadata auto-commit still commits in the worktree
 *   projection-verifies   the controller runtime projection receipt still verifies
 *   quorum-gate           the quorum clean-baseline predicate passes with only PoS files,
 *                         while an untracked or modified product file still blocks
 *   no-leftover-staged    a failed metadata auto-commit leaves nothing staged
 *   no-skip-worktree      nothing uses skip-worktree / assume-unchanged
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { listRuntimeArtifactIgnorePatterns, inspectExpectedControllerRuntimeProjection } from '../core/runtime-artifact-registry.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const failures: string[] = [];
const check = (id: string, ok: boolean, detail: string): void => {
  if (!ok) failures.push(`FAIL ${id}: ${detail}`);
  else console.log(`  ok ${id}`);
};
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitRaw = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const isIgnored = (cwd: string, path: string): boolean =>
  spawnSync('git', ['check-ignore', '-q', '--no-index', '--', path], { cwd }).status === 0;
const write = (root: string, rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const statusPaths = (cwd: string): string[] =>
  gitRaw(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean).map(line => line.slice(3));

const BACKGROUND = [
  '## Trigger Event',
  '2026-09-30 run 11 showed PoS runtime files visible in git status of a task repo whose tracked gitignore lacks the runtime block.',
  '## Key Insights',
  'The framework must hide its own runtime artifacts through the shared git info exclude file instead of the tracked gitignore.',
  '## Option Tradeoffs',
  'Editing the tracked gitignore is forbidden for frozen control files, so the local exclude is the only framework-owned choice.',
  '## Conversation Texture',
  'An owner reaching DONE must not hand write excludes or skip-worktree flags to satisfy the clean status gates.',
].join('\n\n');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-info-exclude-')));
const home = join(root, '..', `${root.split('/').pop()}-home`);
mkdirSync(home, { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  PROOF_OR_STOP_AGENT: 'main',
  PROOF_OR_STOP_SESSION_ID: 'runtime-exclude-owner',
  PROOF_OR_STOP_USAGE_LEDGER: '0',
};
const cli = (cwd: string, args: string[]): { status: number; out: string } => {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
};
const mustCli = (cwd: string, args: string[]): string => {
  const run = cli(cwd, args);
  if (run.status !== 0) throw new Error(`${args[0]} failed (exit ${run.status}):\n${run.out.slice(-3000)}`);
  return run.out;
};

let keep = false;
try {
  // --- Task repo: its own .gitignore without the PoS runtime block; bench-prepared config.
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Bench Owner']);
  git(root, ['config', 'user.email', 'owner@bench.invalid']);
  write(root, '.gitignore', 'bin/\n');
  write(root, 'go.mod', 'module example.com/strs\n\ngo 1.21\n');
  write(root, 'strs/strs.go', 'package strs\n\nfunc Upper(s string) string { return s }\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'task baseline']);
  write(root, 'proof-or-stop.config.json', `${JSON.stringify({
    artifactContract: 'none',
    validate: { commands: [{ id: 'benchmark-go-strs', command: 'go', args: ['test', './strs'], focus: ['fast'], timeoutMs: 270000 }] },
  }, null, 2)}\n`);
  git(root, ['add', 'proof-or-stop.config.json']);
  git(root, ['commit', '-qm', 'benchmark: configure PoS Go validation before Story']);
  // A user line that must survive every PoS write.
  const excludePath = join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info', 'exclude');
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, '# user exclude\nscratch-notes.txt\n');

  // --- Bench adapter setup, then the owner creates the Story (real CLI).
  mustCli(root, ['init', '--profile', 'codex', '--asset-mode', 'global-thin', '.']);
  const created = mustCli(root, ['story_create', JSON.stringify({
    name: 'runtime-exclude-probe', title: 'Runtime exclude probe',
    description: 'Probe story for the runtime info exclude smoke.', type: 'chore', priority: 'medium',
    background: BACKGROUND,
    checklist: [{ title: 'probe item', context: 'probe context for the runtime exclude smoke' }],
  })]);
  const storyId = created.match(/\b(B-[0-9a-f]{4,6})\b/)?.[1];
  if (!storyId) throw new Error(`story_create printed no story id:\n${created.slice(-2000)}`);
  const storyRel = `.proof-or-stop/story/actives/${storyId}`;

  // --- Story workspace as INIT_CHECK leaves it: story/<id> worktree under .worktrees/.
  const worktree = join(root, '.worktrees', storyId);
  const store = new StoryStore(root);
  const story = store.readStory(storyId);
  const now = new Date().toISOString();
  store.writeStory(storyId, { ...story, phase: 'DEV', worktree: { path: worktree, branch: `story/${storyId}`, createdAt: now },
    events: [...(story.events ?? []), { phase: 'DEV', action: 'advance', timestamp: now }] });
  git(root, ['add', '--', storyRel]);
  git(root, ['commit', '-qm', `proof-or-stop: INIT_CHECK metadata ${storyId}`]);
  git(root, ['branch', `story/${storyId}`]);
  mkdirSync(join(root, '.worktrees'), { recursive: true });
  git(root, ['worktree', 'add', '-q', worktree, `story/${storyId}`]);

  // A Story-scoped mutation from the worktree: projects the controller hooks and commits metadata.
  const updated = cli(worktree, ['checklist_update', `--storyId=${storyId}`, '--itemId=CHK-001', '--status=in_progress']);
  check('autocommit-works', updated.status === 0 && /metadata auto-committed/.test(updated.out),
    `checklist_update in the Story worktree did not auto-commit metadata (exit ${updated.status}):\n${updated.out.slice(-1500)}`);
  resetConfigCache();
  const projection = inspectExpectedControllerRuntimeProjection({ projectRoot: worktree, gitCwd: worktree, storyId });
  check('projection-verifies', projection.expected === true && projection.valid === true, `controller runtime projection does not verify: ${JSON.stringify(projection)}`);

  // --- Runtime artifacts PoS writes during a Story (registry-owned, never committed).
  mustCli(worktree, ['session_brief']);
  const runtimeFiles = [
    '.proof-or-stop/activity.jsonl',
    '.proof-or-stop/evidence/ledger/observed.jsonl',
    '.proof-or-stop/locks/main-write.lock/holder.json',
    '.proof-or-stop/runtime/host-runs/run-1/state.json',
    `.proof-or-stop/autopilot-verdicts/${storyId}/verdict-0000000000000000.json`,
    '.proof-or-stop/usage/ledger.jsonl',
    `${storyRel}/owner-lease.json`,
    `${storyRel}/activity.jsonl`,
  ];
  for (const rel of runtimeFiles) if (!existsSync(join(worktree, rel))) write(worktree, rel, '{}\n');
  write(root, '.proof-or-stop/activity.jsonl', '{}\n');
  const worktreeVisible = statusPaths(worktree).filter(path => path.startsWith('.proof-or-stop/') && !path.includes('/evidence/controller-'));
  check('runtime-hidden', worktreeVisible.length === 0, `PoS runtime artifacts visible in the Story worktree git status: ${JSON.stringify(worktreeVisible)}`);
  const mainVisible = statusPaths(root).filter(path => path.startsWith('.proof-or-stop/') || path.startsWith('.worktrees'));
  check('runtime-hidden-main', mainVisible.length === 0, `PoS runtime artifacts / Story worktrees visible in the main checkout git status: ${JSON.stringify(mainVisible)}`);

  // --- The block is scoped: registry patterns + worktree dir, nothing PoS stages or verifies by presence.
  const excludeText = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const block = excludeText.match(/^# proof-or-stop runtime artifacts[^\n]*\n([\s\S]*?)^# \/proof-or-stop runtime artifacts[^\n]*$/m)?.[1]
    .split('\n').filter(Boolean) ?? [];
  const expected = [...new Set([...listRuntimeArtifactIgnorePatterns(), '/.worktrees/'])];
  check('exclude-scoped', JSON.stringify(block) === JSON.stringify(expected),
    `managed info/exclude block differs from registry patterns + /.worktrees/: ${JSON.stringify(block)}`);
  check('exclude-user-lines', excludeText.startsWith('# user exclude\nscratch-notes.txt\n'), `user info/exclude lines were not preserved:\n${excludeText.slice(0, 300)}`);
  const mustStayVisible = [
    `${storyRel}/index.json`, `${storyRel}/checklist.json`, `${storyRel}/process-events.jsonl`,
    `${storyRel}/evidence/controller-runtime-projection.json`, `${storyRel}/evidence/controller-config-projection.json`,
    '.codex/hooks.json', '.codex/hooks/proof-or-stop-scope-pretool.cjs', 'strs/new.go', 'AGENTS.md',
  ];
  const wronglyIgnored = mustStayVisible.filter(path => isIgnored(worktree, path));
  check('exclude-not-metadata', wronglyIgnored.length === 0, `info/exclude hides paths PoS stages or verifies by presence: ${JSON.stringify(wronglyIgnored)}`);
  mustCli(root, ['story_create', JSON.stringify({
    name: 'runtime-exclude-probe-2', title: 'Runtime exclude probe two',
    description: 'Second probe story for the runtime info exclude smoke.', type: 'chore', priority: 'medium',
    background: BACKGROUND.replace('run 11 showed', 'run 11 again showed'),
    checklist: [{ title: 'second probe item', context: 'second probe context for the runtime exclude smoke' }],
  })]);
  const rerun = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  check('exclude-idempotent', rerun === excludeText && (rerun.match(/^# proof-or-stop runtime artifacts/gm) ?? []).length === 1,
    'a second story_create changed info/exclude or duplicated the block');

  // --- Quorum clean-baseline gate (the atomic verdict batch precondition).
  const quorum = await import('../handlers/quorum-submit.js') as Record<string, unknown>;
  const blockingRows = quorum.quorumBaselineBlockingRows as ((gitCwd: string, storyId: string) => string[]) | undefined;
  if (typeof blockingRows !== 'function') {
    check('quorum-gate', false, 'handlers/quorum-submit.ts exports no quorumBaselineBlockingRows predicate');
  } else {
    const onlyPoS = blockingRows(worktree, storyId);
    check('quorum-gate', onlyPoS.length === 0, `quorum baseline refuses with only PoS-owned files present: ${JSON.stringify(onlyPoS)}`);
    // The old raw gate refused on these: projected controller hooks + receipts stay visible by design.
    const projectedVisible = statusPaths(worktree);
    check('quorum-gate-exercised', projectedVisible.includes('.codex/hooks.json') && projectedVisible.includes(`${storyRel}/evidence/controller-runtime-projection.json`),
      `expected the verified controller projection to be visible untracked in the Story worktree: ${JSON.stringify(projectedVisible)}`);
    write(worktree, 'strs/new.go', 'package strs\n');
    const product = blockingRows(worktree, storyId);
    check('quorum-gate-product', product.some(row => row === '?? strs/new.go'), `an untracked product file does not block: ${JSON.stringify(product)}`);
    unlinkSync(join(worktree, 'strs/new.go'));
    write(worktree, 'strs/strs.go', 'package strs\n\n// edited\n');
    const tracked = blockingRows(worktree, storyId);
    check('quorum-gate-tracked', tracked.some(row => row.endsWith(' strs/strs.go')), `a modified product file does not block: ${JSON.stringify(tracked)}`);
    git(worktree, ['checkout', '--', 'strs/strs.go']);
  }

  // --- A failed metadata commit must not leave canonical Story metadata staged.
  const hooksDir = join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "pre-commit refuses (smoke)" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const eventsPath = join(worktree, storyRel, 'process-events.jsonl');
  writeFileSync(eventsPath, `${existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : ''}{"type":"smoke_probe"}\n`);
  resetConfigCache();
  const failed = autoCommitStoryMetadata(worktree, storyId, 'runtime_exclude_smoke', { exactStoryArtifactNames: ['process-events.jsonl'] });
  const staged = git(worktree, ['diff', '--cached', '--name-only']);
  check('no-leftover-staged', /auto-commit failed/.test(failed) && staged === '',
    `failed metadata auto-commit left staged paths: ${JSON.stringify(staged)} (result: ${failed.trim().slice(0, 300)})`);
  check('no-leftover-worktree-bytes', readFileSync(eventsPath, 'utf8').includes('"smoke_probe"'), 'rollback must restore only the index, never discard the written bytes');
  unlinkSync(hook);
  const retried = autoCommitStoryMetadata(worktree, storyId, 'runtime_exclude_smoke', { exactStoryArtifactNames: ['process-events.jsonl'] });
  check('autocommit-after-failure', /auto-committed/.test(retried) && git(worktree, ['status', '--porcelain', '--', `${storyRel}/process-events.jsonl`]) === '',
    `metadata auto-commit does not recover after the failing hook is removed: ${retried.trim().slice(0, 300)}`);

  const flagged = gitRaw(worktree, ['ls-files', '-v']).split('\n').filter(line => /^[Shs] /.test(line));
  check('no-skip-worktree', flagged.length === 0, `skip-worktree/assume-unchanged entries present: ${JSON.stringify(flagged)}`);
} catch (error) {
  keep = true;
  failures.push(`FAIL fixture: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (failures.length || keep) console.log(`fixture retained: ${root}`);
  else { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}

if (failures.length) {
  for (const failure of failures) console.log(failure);
  console.log(`runtime-info-exclude-smoke: FAIL (${failures.length})`);
  process.exit(1);
}
console.log('runtime-info-exclude-smoke: PASS');
