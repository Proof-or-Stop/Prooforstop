import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/ensure-dist.mjs'], { cwd: root, stdio: 'inherit', timeout: 300_000 });
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '--noEmit', '-p', 'packages/main/tsconfig.json'],
  { cwd: root, stdio: 'inherit', timeout: 300_000 });
console.log('BENCHMARK_BUILD_AND_TYPECHECK_GREEN');
// Keep source evidence and every repaired entry boundary in the official Lab replay.
const scripts = [
  'scripts/verify-benchmark-registration.mjs',
  'scripts/verify-static-ast-reuse.mjs',
  'scripts/verify-benchmark-behavior.mjs',
  'packages/main/dist/tasks/full-suite-runner-smoke.js',
  'packages/main/dist/tasks/budget-meter-smoke.js',
  'packages/main/dist/tasks/host-run-usage-smoke.js',
  'scripts/verify-benchmark-contracts.mjs',
];
for (const script of scripts) {
  execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit', timeout: 780_000 });
}
console.log(`BENCHMARK_RELEASE_GREEN build, typecheck and ${scripts.length} regression commands; known contract failures explicitly checked`);
