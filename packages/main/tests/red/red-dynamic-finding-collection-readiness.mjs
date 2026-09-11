/** Native signed fixtures are engineering evidence, never operational samples. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const cases = [
  ['collection-readiness', 'packages/main/dist/tasks/dynamic-finding-runtime-integration-smoke.js', ['--collection-proof']],
  ['historical-diagnostics', 'packages/main/dist/tasks/dynamic-finding-runtime-integration-smoke.js', ['--qualification-history-proof']],
  ['head-continuity-regression', 'packages/main/tests/red/red-dynamic-finding-head-continuity.mjs', []],
];
let failed = 0;
for (const [name, entry, args] of cases) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', timeout: 240000, maxBuffer: 6 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
  if (r.error || r.signal) throw new Error(`${name}: infrastructure refusal: ${r.error ?? r.signal}`);
  if (r.status !== 0) failed++;
  console.log(`COLLECTION_CASE ${name} exit=${r.status}`);
}
console.log(`DYNAMIC_FINDING_COLLECTION ${failed ? 'FAIL' : 'PASS'} ${cases.length - failed} passed ${failed} failed`);
process.exitCode = failed ? 1 : 0;
