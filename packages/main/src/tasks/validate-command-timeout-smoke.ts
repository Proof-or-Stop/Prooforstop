/**
 * Smoke: validate per-command timeout (B-5d18).
 *
 * Proves the validate runner kills a hung command via the per-command timer (exit 124,
 * timedOut=true) instead of letting it run until the cli-engine ~300s global idle
 * watchdog silently force-exits the WHOLE validate (which never re-stamps
 * test-evidence.materialHash → silently blocks DONE for every story). Specifically proves:
 *   - resolveCommandTimeoutMs selection (explicit positive wins; 0/neg/unset → default),
 *     including the injectable default seam;
 *   - a hung command is killed and attributed (124, timedOut) while a fast command passes;
 *   - the DEFAULT-arming path actually fires (no explicit timeoutMs) via the injected seam;
 *   - the timeout kills the whole PROCESS GROUP — a SIGTERM-ignoring grandchild that holds
 *     stdio open is reaped, so the result settles instead of hanging forever.
 *
 * Hermetic: all sub-plans run with projectRoot = os.tmpdir() so no real config/git-status
 * side effects leak in. Registered in lattice.config.json validate.commands for ongoing
 * regression protection.
 *
 * Run: node packages/main/dist/tasks/validate-command-timeout-smoke.js
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  resolveCommandTimeoutMs,
  runValidationCommand,
  executeValidationPlan,
  runSingleAllowlistedCommand,
} from '../core/validation-executor.js';
import type { ValidationCommand, ValidationPlan } from '../core/validation-types.js';

const TMP = tmpdir();
const NODE = process.execPath;

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}

const base = (over: Partial<ValidationCommand>): ValidationCommand => ({
  label: 't',
  command: NODE,
  args: [],
  ...over,
});

void (async () => {
  try {
    // 1. The default ceiling sits below the cli-engine ~300s global idle watchdog so a
    //    per-command kill fires (and attributes) first, and above the observed
    //    full-validation incident envelope (~171s) with margin.
    check('DEFAULT below the 300s global idle watchdog', DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS < 300_000);
    check('DEFAULT raised above the incident timeout margin', DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS >= 270_000);

    // 2. resolveCommandTimeoutMs: explicit positive timeoutMs wins; unset/invalid → default.
    check('no timeoutMs -> module default', resolveCommandTimeoutMs(base({})) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    check('explicit timeoutMs honored', resolveCommandTimeoutMs(base({ timeoutMs: 5_000 })) === 5_000);
    check('zero timeoutMs -> default', resolveCommandTimeoutMs(base({ timeoutMs: 0 })) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    check('negative timeoutMs -> default', resolveCommandTimeoutMs(base({ timeoutMs: -1 })) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    // injectable default seam (lets the integration default-path test below use a tiny default):
    check('injected default used when timeoutMs unset', resolveCommandTimeoutMs(base({}), 999) === 999);
    check('explicit timeoutMs still wins over injected default', resolveCommandTimeoutMs(base({ timeoutMs: 5_000 }), 999) === 5_000);
    check('injected default used when timeoutMs is zero', resolveCommandTimeoutMs(base({ timeoutMs: 0 }), 999) === 999);

    // 3. Integration: a hung command is killed by the per-command timer (exit 124,
    //    timedOut) while a fast command in the same plan completes normally.
    const plan: ValidationPlan = {
      provider: 'validate-command-timeout-smoke',
      commands: [
        { label: 'fast', command: NODE, args: ['-e', 'process.exit(0)'] },
        { label: 'hung', command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 1_500 },
      ],
    };
    const result = await executeValidationPlan(plan, TMP);
    const fast = result.commands.find((c) => c.label === 'fast');
    const hung = result.commands.find((c) => c.label === 'hung');
    check('fast command completed cleanly (code 0, not timed out)', !!fast && fast.code === 0 && !fast.timedOut);
    check('hung command was killed by the per-command timer (timedOut=true)', !!hung && hung.timedOut === true);
    check('hung command is attributed with exit code 124', !!hung && hung.code === 124);
    check('overall validate result fails (loud) due to the hung command', result.allPass === false);

    // 4. The DEFAULT-arming path fires even with NO explicit timeoutMs. A regression that
    //    armed the timer only when command.timeoutMs is set would NOT be caught by case 3
    //    (which sets timeoutMs explicitly); inject a tiny default to prove the unset path.
    const defaultPath = await runValidationCommand(
      { label: 'default-armed', command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] },
      TMP,
      300,
    );
    check('default-path hung command timed out via injected default', defaultPath.timedOut === true);
    check('default-path hung command attributed 124', defaultPath.code === 124);

    // 5. The timeout reaps the whole PROCESS GROUP. The command spawns a grandchild that
    //    IGNORES SIGTERM and holds the inherited stdio pipe open. A direct child.kill()
    //    would leave the grandchild alive → the 'close' event (and thus this await) would
    //    never fire. Group-kill SIGKILLs the grandchild, so this resolves.
    const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const treeParent =
      `const { spawn } = require('child_process'); ` +
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); ` +
      `setInterval(() => {}, 1000);`;
    const tree = await runValidationCommand(
      { label: 'tree', command: NODE, args: ['-e', treeParent], timeoutMs: 1_000 },
      TMP,
    );
    check('process-group kill reaped the SIGTERM-ignoring grandchild (timedOut=true)', tree.timedOut === true);
    check('process-group kill attributed 124', tree.code === 124);
    // Settled well under "hang forever": timeoutMs(1000) + SIGKILL escalation(1000) + slop.
    check('process-group kill settled promptly (did not wait on the grandchild)', tree.durationMs < 6_000);

    // 6. B-16df: the receipt path used by verification_evidence_add / _batch_add /
    //    verification_run (checklist.ts's 4 runSingleAllowlistedCommand call sites) MUST
    //    honor a project's configured validate.commands[].timeoutMs override, exactly like
    //    resolveCommandTimeoutMs does for the lattice-validate path exercised above. A temp
    //    project root pins a ~1.5s command at a 700ms override via lattice.config.json.
    const pinnedRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-'));
    const pinnedCommand = 'node -e "setTimeout(() => {}, 1500)"';
    writeFileSync(
      join(pinnedRoot, 'lattice.config.json'),
      JSON.stringify({
        validate: {
          commands: [
            { command: 'node', args: ['-e', 'setTimeout(() => {}, 1500)'], timeoutMs: 700 },
          ],
        },
      }, null, 2),
      'utf-8',
    );

    // 6a. PERMANENT characterization (stays true before AND after CHK-002): calling
    //     runSingleAllowlistedCommand directly, bypassing checklist.ts's resolver, is
    //     documented/by-design to keep using the 270s default -- this is not the bug being
    //     fixed and must NOT be asserted as timedOut === true.
    const direct = await runSingleAllowlistedCommand(pinnedCommand, pinnedRoot);
    check('direct runSingleAllowlistedCommand call (no options.timeoutMs) keeps the 270s default (timedOut=false)', direct.timedOut === false);

    // 6b. The real red->green assertion: exercises the actual fixed surface --
    //     checklist.ts's resolvePinnedCommandTimeoutMs combined with
    //     runSingleAllowlistedCommand, mirroring exactly what the 4 real call sites do.
    //     Dynamic import (not a static top-level import) so this file still compiles even
    //     before CHK-002 adds the export. Currently RED before CHK-002: the export does not
    //     exist yet, so runSingleAllowlistedCommand is never given the configured override and
    //     the ~1.5s command completes normally.
    const checklistMod: any = await import('../handlers/checklist.js');
    check('checklist.ts exports resolvePinnedCommandTimeoutMs', typeof checklistMod.resolvePinnedCommandTimeoutMs === 'function');
    const resolved = checklistMod.resolvePinnedCommandTimeoutMs(pinnedRoot, pinnedCommand);
    const pinned = await runSingleAllowlistedCommand(pinnedCommand, pinnedRoot, { timeoutMs: resolved });
    check('configured validate.commands[].timeoutMs override honored via resolvePinnedCommandTimeoutMs (timedOut=true)', pinned.timedOut === true);
    check('configured validate.commands[].timeoutMs override attributed 124', pinned.code === 124);

    console.log(`validate-command-timeout smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
