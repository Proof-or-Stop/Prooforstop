import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve, dirname, join} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Each child has 180s; the managed Lab command has a 900s total budget.
for(const test of ['verify-memory-query-timing.mjs','verify-static-ast-reuse.mjs','verify-static-ast-reuse-boundaries.mjs']) {
  execFileSync(process.execPath,[join(root,'scripts',test)],{cwd:root,stdio:'inherit',timeout:180_000});
}
console.log('INTAKE_LAB_GREEN memory timing, scanner parse reuse, invocation boundaries');
