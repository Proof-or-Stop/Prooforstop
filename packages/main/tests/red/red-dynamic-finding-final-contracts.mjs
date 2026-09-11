/** Same pinned command before and after the three bounded acceptance repairs. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cases = [
  ['historical-e2e', 'packages/main/dist/tasks/finding-pre-existing-e2e-smoke.js', []],
  ['prerequisite-proof', 'packages/main/dist/tasks/dynamic-finding-runtime-integration-smoke.js', ['--prerequisite-proof']],
  ['cohort-proof', 'packages/main/dist/tasks/finding-qualification-events-smoke.js', ['--cohort-proof']],
];
let failures = 0;
for (const [name, entry, args] of cases) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  if (r.error || r.signal) throw new Error(`${name}: infrastructure refusal: ${r.error ?? r.signal}`);
  if (r.status !== 0) failures++;
  console.log(`FINAL_CONTRACT ${name} exit=${r.status}`);
}
console.log(`DYNAMIC_FINDING_FINAL_CONTRACTS ${failures ? 'FAIL' : 'PASS'} ${cases.length - failures} passed ${failures} failed`);
process.exitCode = failures ? 1 : 0;
