// Task-adaptive injection (option A): corrupt the arm's own output at the fixed point.
// Maps the §6 "break-architecture / garbage" failure mode onto ANY task by appending a
// syntax-breaking marker to task.outputFile; a recovering loop must repair it.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'corrupt-output',
  faultKind: 'break',
  appliesToAllArms: true,
  description: 'Append broken code to the task output file after the injection point; a recovering loop must repair it.',
  inject(ws, task) {
    appendFileSync(join(ws, task.outputFile), '\n\n// INJECTED-CORRUPTION\nthis is not valid javascript $$$ ((( \n');
    return { faultKind: this.faultKind, target: task.outputFile, detail: 'appended syntax-breaking corruption' };
  },
};
