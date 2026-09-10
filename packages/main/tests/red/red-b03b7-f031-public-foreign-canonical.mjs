import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const build = spawnSync(process.execPath, [join(root, 'scripts/ensure-dist.mjs')], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 24 * 1024 * 1024,
});
if (build.status !== 0) {
  process.stdout.write(build.stdout || '');
  process.stderr.write(build.stderr || '');
  process.exit(build.status ?? 2);
}

const result = spawnSync(process.execPath, [
  join(root, 'packages/main/dist/tasks/finding-identity-lineage-smoke.js'),
  '--section=worktrees',
], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 24 * 1024 * 1024,
  timeout: 180_000,
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) process.exit(result.status ?? 2);
if (!result.stdout.includes('PUBLIC_FOREIGN_ACTIVE_CANONICAL PASS')) {
  console.error('F031_PUBLIC_FOREIGN_CANONICAL_MISSING: public history and scorecard did not exercise a valid signed canonical row that exists only in another active Story worktree');
  process.exit(1);
}
console.log('F031_PUBLIC_FOREIGN_CANONICAL_GREEN PASS');
