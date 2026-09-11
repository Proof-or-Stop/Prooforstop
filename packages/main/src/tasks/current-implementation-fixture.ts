import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Generated test input, not an archived commit or a claim of historical execution. */
export function createFixtureImplementationCommit(root: string): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const path = 'packages/main/src/fixture-implementation.ts';
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  appendFileSync(join(root, path), '// Test-owned implementation provenance input.\n');
  git(['add', '--', path]);
  git(['commit', '--author=proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>', '-m', 'test: create current implementation provenance input']);
  const head = git(['rev-parse', 'HEAD']);
  assert.equal(git(['show', '-s', '--format=%an <%ae>', head]), 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>');
  assert.ok(git(['diff-tree', '--no-commit-id', '--name-only', '-r', head]).split('\n').includes(path));
  return head;
}
