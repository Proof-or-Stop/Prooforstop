import {runIntakeChecks} from './intake-verification-runner.mjs';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
process.exitCode=runIntakeChecks([
  "scripts/verify-memory-query-timing.mjs",
  "scripts/verify-static-ast-reuse.mjs",
  "scripts/verify-static-ast-reuse-boundaries.mjs"
], 'INTAKE_LAB', {cwd});
