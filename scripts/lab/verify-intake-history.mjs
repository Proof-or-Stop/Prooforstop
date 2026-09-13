import { spawnSync } from 'node:child_process';
const commands = [
  'scripts/ensure-dist.mjs',
  'scripts/verify-intake-discovery.mjs',
  'packages/main/tests/validation-git-tree-safety.mjs',
  'scripts/verify-local-main-baseline.mjs',
  'scripts/verify-story-hash-memo.mjs',
  'packages/main/tests/validation-git-tree-batch.mjs',
  'packages/main/tests/validation-git-tree-head-drift.mjs',
  'scripts/lab/verify-intake-consolidation.mjs',
];
const failures = [];
for (const command of commands) {
  const r = spawnSync(process.execPath, [command], { stdio: 'inherit', timeout: 180_000 });
  console.log('INTAKE_COMMAND_RESULT ' + JSON.stringify({ command, exitCode: r.status, signal: r.signal, error: r.error?.message }));
  if (r.status !== 0) failures.push(command);
  if (command === commands[0] && r.status !== 0) break;
}
if (failures.length) { console.error('INTAKE_HISTORY_RED ' + JSON.stringify(failures)); process.exitCode = 1; }
else console.log('INTAKE_HISTORY_GREEN');
