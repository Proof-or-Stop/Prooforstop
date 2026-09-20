import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep source evidence and every repaired entry boundary in the official Lab replay.
const scripts = [
  'scripts/verify-benchmark-audit-paths.mjs',
  'scripts/verify-static-ast-reuse.mjs',
  'scripts/verify-benchmark-real-entry.mjs',
  'scripts/verify-benchmark-shared-budget.mjs',
  'scripts/verify-benchmark-budget-adversarial.mjs',
  'scripts/verify-benchmark-managed-entry.mjs',
  'scripts/verify-benchmark-exception-usage.mjs',
  'packages/main/dist/tasks/budget-meter-smoke.js',
  'packages/main/dist/tasks/host-run-usage-smoke.js',
];
for (const script of scripts) {
  execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit', timeout: 300_000 });
}
console.log(`BENCHMARK_RELEASE_GREEN ${scripts.length} regression commands; paid provider transport intercepted`);
