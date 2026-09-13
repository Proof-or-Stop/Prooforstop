import {runIntakeChecks} from './intake-verification-runner.mjs';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
process.exitCode=runIntakeChecks([
  "scripts/ensure-dist.mjs",
  "scripts/verify-memory-learning-scope.mjs",
  "packages/main/dist/tasks/experience-layer-finding-signals-smoke.js",
  "scripts/lab/verify-intake-round-two.mjs"
], 'INTAKE_ROUND_THREE', {cwd});
