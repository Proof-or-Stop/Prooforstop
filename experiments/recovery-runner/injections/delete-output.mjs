// Task-adaptive injection (option A): delete the arm's own output file at the fixed point.
// Maps the §6 "delete-critical" failure mode onto ANY task by targeting task.outputFile.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'delete-output',
  faultKind: 'delete-critical',
  appliesToAllArms: true,
  description: 'Delete the task output file after the injection point; a recovering loop must re-create it correctly.',
  // ws = the arm's working dir; task = parsed task.json
  inject(ws, task) {
    rmSync(join(ws, task.outputFile), { force: true });
    return { faultKind: this.faultKind, target: task.outputFile, detail: `deleted ${task.outputFile}` };
  },
};
