import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Routine behavioral coverage: private fixtures, no build or contract recursion.
const root = fileURLToPath(new URL('../', import.meta.url));
for (const script of [
  'scripts/verify-benchmark-audit-paths.mjs',
  'scripts/verify-benchmark-real-entry.mjs',
  'scripts/verify-benchmark-shared-budget.mjs',
  'scripts/verify-benchmark-budget-adversarial.mjs',
  'scripts/verify-benchmark-managed-entry.mjs',
  'scripts/verify-benchmark-exception-usage.mjs',
]) execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit', timeout: 30_000 });
console.log('BENCHMARK_BEHAVIOR_GREEN six behavioral regressions; paid provider calls=0');
