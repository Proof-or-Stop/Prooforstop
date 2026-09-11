/** Bounded qualification characterization and native evidence-only drift RED/GREEN.
 * Simulated calculator input is not operational rollout evidence. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cases = [
  ['qualification-characterization', 'packages/main/dist/tasks/dynamic-finding-evidence-closure-smoke.js', []],
  ['head-continuity', 'packages/main/dist/tasks/finding-material-reattestation-smoke.js', ['--head-continuity']],
  ['material-regression', 'packages/main/dist/tasks/finding-material-reattestation-smoke.js', []],
];
let failed = 0;
for (const [name, entry, args] of cases) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  if (r.error || r.signal) throw new Error(`${name}: infrastructure refusal: ${r.error ?? r.signal}`);
  if (r.status !== 0) failed++;
  console.log(`HEAD_CONTINUITY_CASE ${name} exit=${r.status}`);
}
console.log(`DYNAMIC_FINDING_HEAD_CONTINUITY ${failed ? 'FAIL' : 'PASS'} ${cases.length - failed} passed ${failed} failed`);
process.exitCode = failed ? 1 : 0;
