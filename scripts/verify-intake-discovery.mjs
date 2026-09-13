import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const { resolveStoryWorkspace } = await import('../packages/main/dist/core/story-workspace.js');
const { resolveRepositoryBaseline } = await import('../packages/main/dist/core/git-baseline.js');
const original = cp.execFileSync;
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'intake-discovery-')));
const git = (...args) => original('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const story = { storyId: 'B-discovery', name: 'In-memory discovery fixture', phase: 'INIT' };
const ctx = { root, store: { readStory: () => story, storyDirPath: () => join(root, 'unused-metadata') } };
const failures = [];
function observe(fn, n = 1) {
  const commands = []; const outputs = []; const start = performance.now();
  cp.execFileSync = function(command, args, opts) { if (command === 'git') commands.push(args); return original.call(this, command, args, opts); };
  syncBuiltinESMExports();
  try { for (let i = 0; i < n; i++) outputs.push(fn()); }
  finally { cp.execFileSync = original; syncBuiltinESMExports(); }
  return { ms: performance.now() - start, commands, outputs };
}
function workspace(config = {}) { const r = resolveStoryWorkspace(ctx, story.storyId, { config }); return { gitCwd: r.gitCwd, worktreePath: r.worktreePath, source: r.source, rootReason: r.rootReason }; }
try {
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lab'); git('config', 'user.email', 'lab@example.invalid'); git('commit', '--allow-empty', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  const w = observe(() => workspace(), 20); const b = observe(() => resolveRepositoryBaseline(root), 20);
  for (const out of w.outputs) assert.deepEqual(out, { gitCwd: root, worktreePath: null, source: 'invocation-root', rootReason: 'same-tree' });
  for (const out of b.outputs) assert.deepEqual(out, { ref: 'refs/heads/main', mergeBase: head });
  const scans = w.commands.filter(args => args[0] === 'worktree').length;
  console.log('INTAKE_DISCOVERY_MEASURE ' + JSON.stringify({ workspace: { ms: w.ms, scans, gitCalls: w.commands.length }, baseline: { ms: b.ms, gitCalls: b.commands.length }, outputsEqual: true }));
  if (scans !== 20) failures.push(`workspace inventory budget expected 20, got ${scans}`);
  if (b.commands.length > 80) failures.push(`baseline Git budget expected <=80, got ${b.commands.length}`);
  const linked = join(root, 'linked'); git('worktree', 'add', '-qb', 'story/B-discovery', linked);
  assert.equal(workspace().worktreePath, linked);
  story.worktree = { path: linked, branch: 'story/B-discovery' }; assert.equal(workspace().gitCwd, linked);
  story.phase = 'DONE'; const terminal = observe(() => workspace()); assert.equal(terminal.commands.length, 0); assert.equal(terminal.outputs[0].worktreePath, null);
  story.phase = 'INIT'; delete story.worktree; git('worktree', 'remove', linked); assert.equal(workspace().worktreePath, null);
  const wrapper = join(root, 'wrapper'); fs.mkdirSync(wrapper); const nested = join(wrapper, 'repo'); fs.mkdirSync(nested); original('git', ['init', '-q', '-b', 'main'], { cwd: nested }); ctx.root = wrapper; assert.equal(workspace({ gitRoot: nested }).gitCwd, nested); ctx.root = root;
  git('commit', '--allow-empty', '-qm', 'advance'); assert.notEqual(resolveRepositoryBaseline(root).mergeBase, head);
  assert.equal(resolveRepositoryBaseline(root, 'missing-ref'), undefined);
  assert.equal(resolveRepositoryBaseline(root, 'HEAD', { deadlineMs: performance.now() - 1 }), undefined);
  // A malformed conventional ref pointing to a blob must remain ineligible.
  const blob = git('hash-object', '-w', '--stdin'); git('update-ref', 'refs/remotes/origin/main', blob); git('branch', '-m', 'integration');
  assert.equal(resolveRepositoryBaseline(root).ref, 'refs/heads/integration');
  console.log('INTAKE_DISCOVERY_BOUNDARIES_GREEN add/remove persisted terminal wrapper ref-movement invalid-ref deadline blob-ref');
  assert.equal(failures.length, 0, 'INTAKE_DISCOVERY_RED: ' + failures.join('; '));
  console.log('INTAKE_DISCOVERY_GREEN');
} finally { cp.execFileSync = original; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
