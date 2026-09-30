/**
 * The "loaded core is inside the target worktree" test compared
 * path.relative()'s result against `..${delimiter}` (':' on POSIX) instead
 * of `..${sep}`, so a runtime loaded from any directory OUTSIDE the target
 * (relative path '../elsewhere/...') counted as inside it. For a self-project
 * target, a Story write from such a foreign runtime then passed the
 * foreign_self_project_runtime_for_story_write boundary it must be refused by.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRuntimeEntrypointAuthority } from '../core/runtime-environment-checks.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'authority-sep-')));
const project = join(base, 'project');
mkdirSync(join(project, 'packages', 'main'), { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'proof-or-stop' }));
writeFileSync(join(project, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@proof-or-stop/core' }));
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
git('init', '-q'); git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

// A runtime package root outside the target and outside any git repository.
const foreignRuntime = join(base, 'elsewhere', 'packages', 'main');
mkdirSync(foreignRuntime, { recursive: true });

const decision = classifyRuntimeEntrypointAuthority({
  command: 'checklist_update',
  commandArgs: [],
  projectRoot: project,
  loadedCorePackageRoot: foreignRuntime,
  env: {},
  requiresAuthoritativeRuntime: true,
});
assert.equal(decision.status, 'blocked', `a Story write from a runtime outside the target must be refused, got ${decision.status}: ${decision.detail}`);
assert.equal(decision.reasonCode, 'foreign_self_project_runtime_for_story_write');

// A runtime genuinely inside the target is still admitted (no over-blocking).
const inside = classifyRuntimeEntrypointAuthority({
  command: 'checklist_update',
  commandArgs: [],
  projectRoot: project,
  loadedCorePackageRoot: join(project, 'packages', 'main'),
  env: {},
  requiresAuthoritativeRuntime: true,
});
assert.equal(inside.status, 'pass', `a runtime inside the target checkout stays admitted, got ${inside.status}: ${inside.detail}`);
console.log('authority-path-sep-smoke: PASS');
