/**
 * Smoke: validate per-command timeout (B-5d18).
 *
 * Proves the validate runner kills a hung command via the per-command timer (exit 124,
 * timedOut=true) instead of letting it run until the cli-engine ~300s global idle
 * watchdog silently force-exits the WHOLE validate (which never re-stamps
 * test-evidence.materialHash → silently blocks DONE for every story). Also proves a fast
 * command is unaffected, and that the default ceiling is selected when no explicit
 * timeoutMs is set and stays below the global idle watchdog.
 *
 * Run: node packages/main/dist/tasks/validate-command-timeout-smoke.js
 */

import {
  DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  resolveCommandTimeoutMs,
  executeValidationPlan,
} from '../core/validation-executor.js';
import type { ValidationCommand, ValidationPlan } from '../core/validation-types.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

const base = (over: Partial<ValidationCommand>): ValidationCommand => ({
  label: 't',
  command: 'node',
  args: [],
  ...over,
});

void (async () => {
  try {
    // 1. The default ceiling sits below the cli-engine ~300s global idle watchdog so a
    //    per-command kill fires (and attributes) first, and above the slowest legit
    //    command (the ~160s tsc build) with margin.
    check('DEFAULT below the 300s global idle watchdog', DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS < 300_000);
    check('DEFAULT above the slowest legit command with margin', DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS >= 200_000);

    // 2. resolveCommandTimeoutMs: explicit positive timeoutMs wins; unset/invalid → default.
    check('no timeoutMs -> default', resolveCommandTimeoutMs(base({})) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    check('explicit timeoutMs honored', resolveCommandTimeoutMs(base({ timeoutMs: 5_000 })) === 5_000);
    check('zero timeoutMs -> default', resolveCommandTimeoutMs(base({ timeoutMs: 0 })) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    check('negative timeoutMs -> default', resolveCommandTimeoutMs(base({ timeoutMs: -1 })) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);

    // 3. Integration: a hung command is killed by the per-command timer (exit 124,
    //    timedOut) while a fast command in the same plan completes normally.
    const plan: ValidationPlan = {
      provider: 'validate-command-timeout-smoke',
      commands: [
        { label: 'fast', command: process.execPath, args: ['-e', 'process.exit(0)'] },
        { label: 'hung', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 400 },
      ],
    };
    const result = await executeValidationPlan(plan, process.cwd());
    const fast = result.commands.find((c) => c.label === 'fast');
    const hung = result.commands.find((c) => c.label === 'hung');
    check('fast command completed cleanly (code 0, not timed out)', !!fast && fast.code === 0 && !fast.timedOut);
    check('hung command was killed by the per-command timer (timedOut=true)', !!hung && hung.timedOut === true);
    check('hung command is attributed with exit code 124', !!hung && hung.code === 124);
    check('overall validate result fails (loud) due to the hung command', result.allPass === false);

    console.log(`validate-command-timeout smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
