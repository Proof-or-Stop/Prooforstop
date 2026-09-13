import {runIntakeChecks} from './intake-verification-runner.mjs';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));
process.exitCode=runIntakeChecks([
  "scripts/verify-intake-timeout-classification.mjs",
  "scripts/verify-material-tree-memo.mjs",
  "scripts/verify-lab-audit-prompt-budget.mjs",
  "scripts/verify-lab-worktree.mjs",
  "scripts/lab/verify-intake-round-four.mjs"
], 'INTAKE_FINISH', {cwd});
