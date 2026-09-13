import {runIntakeChecks} from './intake-verification-runner.mjs';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
process.exitCode=runIntakeChecks([
  "scripts/ensure-dist.mjs",
  "scripts/verify-intake-discovery.mjs",
  "packages/main/tests/validation-git-tree-safety.mjs",
  "scripts/verify-local-main-baseline.mjs",
  "scripts/lab/verify-intake-workspace-health.mjs",
  "scripts/verify-story-hash-memo.mjs",
  "packages/main/tests/validation-git-tree-batch.mjs",
  "packages/main/tests/validation-git-tree-head-drift.mjs",
  "scripts/lab/verify-intake-consolidation.mjs"
], 'INTAKE_HISTORY', {cwd});
