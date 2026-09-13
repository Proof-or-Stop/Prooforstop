import {runIntakeChecks} from './intake-verification-runner.mjs';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
process.exitCode=runIntakeChecks([
  "scripts/ensure-dist.mjs",
  "scripts/verify-memory-bottom-up.mjs",
  "packages/main/dist/tasks/playbook-runtime-memory-index-smoke.js",
  "scripts/lab/verify-intake-round-three.mjs"
], 'INTAKE_ROUND_FOUR', {cwd});
