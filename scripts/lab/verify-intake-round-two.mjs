import {runIntakeChecks} from './intake-verification-runner.mjs';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
process.exitCode=runIntakeChecks([
  "scripts/ensure-dist.mjs",
  "packages/main/dist/tasks/single-owner-extraction-smoke.js",
  "scripts/verify-memory-preindex-hit.mjs",
  "scripts/verify-intake-discovery.mjs",
  "packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js",
  "scripts/lab/verify-intake-history.mjs"
], 'INTAKE_ROUND_TWO', {cwd});
