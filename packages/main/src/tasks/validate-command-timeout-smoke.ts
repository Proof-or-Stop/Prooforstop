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
 *     stdio open is reaped, so the result settles instead of hanging forever;
 *   - resolvePinnedCommandTimeoutMs (checklist.ts, B-16df) matching against a project's
 *     configured validate.commands[]: honors an explicit override, falls through to undefined
 *     for an unmatched command, disambiguates same-executable commands by full args equality,
 *     never fabricates a timeoutMs out of a bare-string config entry, never false-positive-matches
 *     a shell-style config entry against a plain allowlisted pinned command, and returns a
 *     configured 0/negative timeoutMs verbatim (relying on the separate resolveCommandTimeoutMs
 *     safety net downstream, not on resolvePinnedCommandTimeoutMs itself, to sanitize it);
 *   - B-16df F-004: checklist.ts's own source text invokes the shared
 *     resolvePinnedCommandTimeoutMs(root, command) helper at exactly 4 call sites (declared
 *     exactly once — no duplicated matching logic outside it); and a very large configured
 *     timeoutMs is clamped end-to-end via resolveCommandTimeoutMs to MAX_NODE_TIMER_DELAY_MS
 *     (not an unbounded-timeout vector). B-16df's companion H-003 assertion — that
 *     validation-executor.ts and verifier.ts are byte-for-byte unmodified from main — is no
 *     longer made here; see section 12 and BUG-B16DF-BYTEPIN for why a standing registered
 *     suite command cannot carry a per-story scope claim;
 *   - B-16df F-008: tokenizeCommandString (validation-executor.ts) and splitShellWords
 *     (verifier.ts) normalize equivalently for allowlist-legal, whitespace/quoting-varied
 *     input on BOTH the config side and the pinned-command side (parsing parity + evasion
 *     resistance), and a pinned command whose args are a strict PREFIX of a longer configured
 *     args array never partial-matches (returns undefined, CHK-003:edge:1);
 *   - B-3434 F-044: the exact membership of VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST
 *     (validation-executor.ts) -- the executable allowlist parseAllowlistedCommand enforces for
 *     pinned verification-evidence commands -- is pinned against a literal expected set, and
 *     parseAllowlistedCommand rejects a representative non-member leading token (`bash`). Adding
 *     to or removing from that allowlist fails section 17 by name. This covers that one constant
 *     and that one rejection path only; it is not a general substitute for the removed byte-pin.
 *
 * Hermetic: all sub-plans run with projectRoot = os.tmpdir() so no real config/git-status
 * side effects leak in. Sections 12-13 are the sole exception: they read this repo's own
 * source state (REPO_ROOT, resolved from this file's own compiled location) rather than
 * a temp dir, since H-002 is a claim ABOUT this repo's actual source, not a synthesized
 * fixture. Every other section's mkdtempSync tmp dir is removed via rmSync in a per-section
 * try/finally (B-16df F-001) so repeated `lattice validate` runs don't leak stray tmpdirs.
 * Registered in proof-or-stop.config.json validate.commands for ongoing regression protection.
 *
 * Run: node packages/main/dist/tasks/validate-command-timeout-smoke.js
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
  resolveEvidenceCommandTimeoutMs,
  MAX_NODE_TIMER_DELAY_MS,
  resolveCommandTimeoutMs,
  runSingleAllowlistedCommand,
  runValidationCommand,
  executeValidationPlan,
  parseAllowlistedCommand,
  VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST,
} from '../core/validation-executor.js';
import { resetConfigCache } from '../core/config.js';
import type { ValidationCommand, ValidationPlan } from '../core/validation-types.js';

/**
 * B-16df F-004: resolved repo root, computed from this compiled file's own location
 * (packages/main/dist/tasks/<this file> → up 4 directories to the repo root) — mirrors
 * the existing `deprecated-gc-smoke.ts` `realRoot` pattern. Sections 12-13 below use this
 * (NOT process.cwd(), which a caller could invoke this smoke from anywhere) to locate the
 * repo-root marker file and read checklist.ts's own source text. Section 12 no longer runs
 * `git diff` (see BUG-B16DF-BYTEPIN in section 12); the only two reads through REPO_ROOT are
 * now existsSync on proof-or-stop.config.json (with legacy lattice.config.json fallback;
 * section 12) and readFileSync on
 * packages/main/src/handlers/checklist.ts (section 13).
 */
const REPO_ROOT = join(new URL(import.meta.url).pathname, '../../../../..');

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
    // Populated by sections 6 and 9 respectively; declared here (not `const` inline) so
    // later sections can reuse the already-imported module without re-importing, even
    // though each section's own temp dir is scoped to a per-section try/finally (F-001).
    let checklistMod: any = null;
    let verifierMod: any = null;

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

    // Evidence-only timeout overrides bind to the parsed executable plus the
    // complete ordered argv vector. They do not register another routine
    // validate command and cannot be selected by prefix/near matching.
    const aggregateIdentity = {
      executable: 'node',
      args: ['packages/main/dist/tasks/managed-cross-provider-suite-smoke.js'],
    };
    const aggregateOverride = [{
      command: 'node',
      args: ['packages/main/dist/tasks/managed-cross-provider-suite-smoke.js'],
      timeoutMs: 360_000,
    }];
    check('evidence exact executable+argv identity selects bounded override',
      resolveEvidenceCommandTimeoutMs(aggregateIdentity, aggregateOverride) === 360_000);
    check('evidence argv near miss stays on the 270s default',
      resolveEvidenceCommandTimeoutMs({ ...aggregateIdentity, args: [...aggregateIdentity.args, '--near'] }, aggregateOverride)
        === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    check('evidence executable near miss stays on the 270s default',
      resolveEvidenceCommandTimeoutMs({ ...aggregateIdentity, executable: 'npx' }, aggregateOverride)
        === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    for (const invalidTimeoutMs of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
      check(`malformed evidence timeout ${String(invalidTimeoutMs)} fails closed to default`,
        resolveEvidenceCommandTimeoutMs(aggregateIdentity, [{ ...aggregateOverride[0], timeoutMs: invalidTimeoutMs }])
          === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    }
    check('conflicting duplicate evidence identities fail closed to default',
      resolveEvidenceCommandTimeoutMs(aggregateIdentity, [
        aggregateOverride[0],
        { ...aggregateOverride[0], timeoutMs: 300_000 },
      ]) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);
    check('malformed evidence override collection fails closed to default',
      resolveEvidenceCommandTimeoutMs(aggregateIdentity, { command: 'node' }) === DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS);

    // The production evidence runner consumes the same exact-identity config,
    // while its outer structured deadline remains the tighter authority.
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'lattice-evidence-timeout-'));
    const fastScript = "process.stdout.write('EVIDENCE_OVERRIDE_OK')";
    const hangScript = 'setInterval(() => {}, 1000)';
    writeFileSync(join(evidenceRoot, 'proof-or-stop.config.json'), JSON.stringify({
      validate: {
        evidenceCommandTimeoutOverrides: [
          { command: 'node', args: ['-e', fastScript], timeoutMs: 1_200 },
          { command: 'node', args: ['-e', hangScript], timeoutMs: 5_000 },
        ],
      },
    }), 'utf8');
    try {
      const fastProgress: number[] = [];
      const fastEvidence = await runSingleAllowlistedCommand(
        `node -e ${JSON.stringify(fastScript)}`,
        evidenceRoot,
        { progress: event => { if (event.type === 'command_start') fastProgress.push(event.timeoutMs); } },
      );
      check('production evidence runner consumes exact configured timeout',
        fastEvidence.code === 0 && fastProgress[0] === 1_200);

      const deadlineProgress: number[] = [];
      let outerDeadlineWon = false;
      const deadlineAt = Date.now() + 300;
      try {
        await runSingleAllowlistedCommand(
          `node -e ${JSON.stringify(hangScript)}`,
          evidenceRoot,
          {
            deadlineAt,
            deadlineError: () => new Error('OUTER_DEADLINE_WON'),
            progress: event => { if (event.type === 'command_start') deadlineProgress.push(event.timeoutMs); },
          },
        );
      } catch (error) {
        outerDeadlineWon = error instanceof Error && error.message === 'OUTER_DEADLINE_WON';
      }
      check('outer structured deadline remains tighter than evidence override', outerDeadlineWon);
      check('spawned evidence command receives remaining outer deadline, not 5s override',
        deadlineProgress.length === 1 && deadlineProgress[0] > 0 && deadlineProgress[0] <= 300);
    } finally {
      resetConfigCache();
      rmSync(evidenceRoot, { recursive: true, force: true });
    }

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
    //    resolveCommandTimeoutMs does for the proof-or-stop-validate path exercised above. A temp
    //    project root pins a ~1.5s command at a 700ms override via proof-or-stop.config.json.
    const pinnedRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-'));
    try {
      const pinnedCommand = 'node -e "setTimeout(() => {}, 1500)"';
      writeFileSync(
        join(pinnedRoot, 'proof-or-stop.config.json'),
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
      checklistMod = await import('../handlers/checklist.js');
      check('checklist.ts exports resolvePinnedCommandTimeoutMs', typeof checklistMod.resolvePinnedCommandTimeoutMs === 'function');
      const resolved = checklistMod.resolvePinnedCommandTimeoutMs(pinnedRoot, pinnedCommand);
      const pinned = await runSingleAllowlistedCommand(pinnedCommand, pinnedRoot, { timeoutMs: resolved });
      check('configured validate.commands[].timeoutMs override honored via resolvePinnedCommandTimeoutMs (timedOut=true)', pinned.timedOut === true);
      check('configured validate.commands[].timeoutMs override attributed 124', pinned.code === 124);
    } finally {
      rmSync(pinnedRoot, { recursive: true, force: true });
    }

    // 7. B-16df CHK-003 (unmatched default): a pinned command with NO matching entry in
    //    validate.commands[] must resolve to undefined (so the caller falls through to the
    //    270s default), not a wrong non-matching entry's timeoutMs. Direct unit test of
    //    resolvePinnedCommandTimeoutMs -- no real timed wait needed.
    const unmatchedRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-unmatched-'));
    try {
      writeFileSync(
        join(unmatchedRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 700 },
            ],
          },
        }, null, 2),
        'utf-8',
      );
      const unmatchedCommand = 'node -e "process.exit(2)"';
      const unmatchedResolved = checklistMod.resolvePinnedCommandTimeoutMs(unmatchedRoot, unmatchedCommand);
      check('unmatched pinned command resolves to undefined (falls through to the default)', unmatchedResolved === undefined);
    } finally {
      rmSync(unmatchedRoot, { recursive: true, force: true });
    }

    // 8. B-16df CHK-003 (args-based disambiguation): two configured commands sharing the same
    //    executable ("node") but different args must NOT cross-match each other's timeoutMs --
    //    matching must compare the full parsed args array, not just the executable.
    const disambigRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-disambig-'));
    try {
      writeFileSync(
        join(disambigRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 700 },
              { command: 'node', args: ['-e', 'process.exit(1)'], timeoutMs: 5_000 },
            ],
          },
        }, null, 2),
        'utf-8',
      );
      const commandA = 'node -e "process.exit(0)"';
      const commandB = 'node -e "process.exit(1)"';
      const resolvedA = checklistMod.resolvePinnedCommandTimeoutMs(disambigRoot, commandA);
      const resolvedB = checklistMod.resolvePinnedCommandTimeoutMs(disambigRoot, commandB);
      check('args-disambiguated command A resolves to its own timeoutMs (700)', resolvedA === 700);
      check('args-disambiguated command B resolves to its own timeoutMs (5000)', resolvedB === 5_000);
      check('command A does NOT cross-match command B\'s timeoutMs', resolvedA !== 5_000);
      check('command B does NOT cross-match command A\'s timeoutMs', resolvedB !== 700);
    } finally {
      rmSync(disambigRoot, { recursive: true, force: true });
    }

    // 9. B-16df F-003 (E-001, bare-string config entries): a validate.commands[] entry that is
    //    a bare STRING (not an object) can never carry a timeoutMs field -- configuredValidationCommands
    //    / commandFromString only ever build {label, command, args[, shell]} out of a raw string,
    //    so a timeoutMs field is structurally absent. Direct unit test of
    //    resolvePinnedCommandTimeoutMs against a temp proof-or-stop.config.json whose only
    //    validate.commands[] entry is a bare string, plus a structural check on the parsed
    //    entry itself proving the absence of the field (not merely a missed match).
    //    B-16df F-008: the fixture MUST contain none of verifier.ts's SHELL_META_RE
    //    characters (`;&|<>$()``) or commandFromString takes the shell-style branch instead
    //    -- the SAME code path section 10 (E-003) exercises. 'node -e "process.exit(0)"'
    //    contains parentheses and does NOT genuinely reach the plain bare-string
    //    (splitShellWords) branch this section claims to cover, so use a paren-free command.
    const bareStringRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-barestring-'));
    try {
      const bareStringCommand = 'node --version';
      writeFileSync(
        join(bareStringRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [bareStringCommand],
          },
        }, null, 2),
        'utf-8',
      );
      verifierMod = await import('../handlers/verifier.js');
      const bareStringEntries = verifierMod.configuredValidationCommands(bareStringRoot);
      check(
        'bare-string config entry is parsed but structurally carries no timeoutMs field',
        bareStringEntries.length === 1 && !('timeoutMs' in bareStringEntries[0]),
      );
      check(
        'bare-string config entry genuinely took the plain (non-shell) splitShellWords branch, distinct from section 10\'s shell-style entry (non-empty args, shell !== true)',
        bareStringEntries[0].shell !== true && bareStringEntries[0].args.length > 0,
      );
      const bareStringResolved = checklistMod.resolvePinnedCommandTimeoutMs(bareStringRoot, bareStringCommand);
      check('bare-string config entry never yields a timeoutMs (resolves to undefined)', bareStringResolved === undefined);
    } finally {
      rmSync(bareStringRoot, { recursive: true, force: true });
    }

    // 10. B-16df F-003 (E-003, shell-style config entries never match): verified against the
    //     actual source (verifier.ts SHELL_META_RE / commandFromString / configuredValidationCommands)
    //     that the auto-detecting SHELL_META_RE flip (; & | < > $ ( ) `) only fires for STRING
    //     validate.commands[] entries via commandFromString; an OBJECT entry only gets
    //     `shell: true` when the config author sets it explicitly -- configuredValidationCommands's
    //     object branch does not re-run SHELL_META_RE. Either way, a shell:true entry is stored
    //     as {command: <raw string>, args: [], shell: true}: its args array is empty, so it can
    //     NEVER structurally equal a plain allowlisted pinned command's parsed {executable, args}.
    //     Construct an object entry that genuinely triggers the real matcher's shell path (explicit
    //     shell: true, command text also containing a shell metacharacter for realism), confirm it
    //     took that path, then confirm its configured timeoutMs (700) does not leak onto an
    //     unrelated plain allowlisted pinned command that merely shares a text prefix.
    const shellStyleRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-shellstyle-'));
    try {
      writeFileSync(
        join(shellStyleRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node -e "process.exit(0)" && echo done', shell: true, timeoutMs: 700 },
            ],
          },
        }, null, 2),
        'utf-8',
      );
      const shellStyleEntries = verifierMod.configuredValidationCommands(shellStyleRoot);
      check(
        'shell-metacharacter config entry is marked shell:true with an empty args array',
        shellStyleEntries.length === 1 && shellStyleEntries[0].shell === true && shellStyleEntries[0].args.length === 0,
      );
      const shellStyleResolved = checklistMod.resolvePinnedCommandTimeoutMs(shellStyleRoot, 'node -e "process.exit(0)"');
      check(
        'shell-style config entry never false-positive-matches a plain allowlisted pinned command (resolves to undefined)',
        shellStyleResolved === undefined,
      );
    } finally {
      rmSync(shellStyleRoot, { recursive: true, force: true });
    }

    // 11. B-16df F-003 (E-004, zero/negative timeoutMs config values): resolvePinnedCommandTimeoutMs
    //     itself does NOT sanitize -- it returns match?.timeoutMs verbatim, including a
    //     configured 0. The actual safety net lives downstream in resolveCommandTimeoutMs
    //     (already covered by section 2 above), which treats a non-positive timeoutMs as "use
    //     the default". Prove both halves here: the raw resolver returns 0 verbatim (not
    //     sanitized to undefined/the default), and feeding that resolved 0 into
    //     runSingleAllowlistedCommand -- mirroring exactly what a real call site does -- still
    //     completes normally rather than e.g. misinterpreting 0 as "no timeout".
    const zeroTimeoutRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-zerotimeout-'));
    try {
      writeFileSync(
        join(zeroTimeoutRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 0 },
            ],
          },
        }, null, 2),
        'utf-8',
      );
      const zeroTimeoutCommand = 'node -e "process.exit(0)"';
      const zeroTimeoutResolved = checklistMod.resolvePinnedCommandTimeoutMs(zeroTimeoutRoot, zeroTimeoutCommand);
      check('resolvePinnedCommandTimeoutMs returns a configured 0 verbatim (no sanitization)', zeroTimeoutResolved === 0);
      const zeroTimeoutRun = await runSingleAllowlistedCommand(zeroTimeoutCommand, zeroTimeoutRoot, { timeoutMs: zeroTimeoutResolved });
      check(
        'downstream resolveCommandTimeoutMs safety net treats the resolved 0 as "use the default" (code 0, not timed out)',
        zeroTimeoutRun.code === 0 && zeroTimeoutRun.timedOut === false,
      );
    } finally {
      rmSync(zeroTimeoutRoot, { recursive: true, force: true });
    }

    // 12. REPO_ROOT sanity check. Section 13 below reads this repo's OWN checklist.ts source
    //     through REPO_ROOT (not process.cwd(), since a caller can invoke this smoke from
    //     anywhere), so a broken path computation must fail loudly here rather than silently
    //     reading the wrong file or nothing at all.
    //
    //     WHAT WAS REMOVED HERE, AND WHY (BUG-B16DF-BYTEPIN).
    //     This section also used to assert, as B-16df's F-004 / H-003, that
    //     packages/main/src/core/validation-executor.ts and packages/main/src/handlers/verifier.ts
    //     were byte-for-byte unmodified from main. It ran
    //       git diff main -- packages/main/src/core/validation-executor.ts packages/main/src/handlers/verifier.ts
    //     via execSync inside a try/catch that soft-skipped (console.warn) only if execSync
    //     itself threw (B-16df F-006 kept the content assertion outside that catch), then
    //     asserted the diff output was empty. B-16df's own fix was confined to checklist.ts's
    //     new resolvePinnedCommandTimeoutMs helper and its call sites, and this assertion was
    //     how that story evidenced it had not edited either shared primitive.
    //
    //     A standing registered validate.commands entry cannot express a per-story scope
    //     claim. On main the diff is trivially empty, so the assertion proves nothing where it
    //     actually runs; off main it is a blanket prohibition on ever editing two actively
    //     developed core files, no matter how correct or well reviewed that edit is. It
    //     therefore deterministically failed for B-3434, whose entire purpose is to change both
    //     of those files: B-3434 added boundPersistedValidationEvidence to validation-executor.ts
    //     and calls it from verifier.ts's evidence write path. (The read ceiling those thresholds
    //     are fractions of, METADATA_BLOB_READ_MAX_BUFFER_BYTES, is declared in
    //     core/done-prepare-generated-metadata.ts -- which is where the execFileSync maxBuffer
    //     calls are. validation-executor.ts contains no execFileSync call of its own.) So the
    //     byte-pin was an unconditional red for that story
    //     regardless of its correctness, and the same for every future story that touches
    //     either file.
    //
    //     "This story did not modify file X" is a statement about ONE story's diff. It belongs
    //     to that story's own scope contract (allowedModify / protectedFiles) and to its diff
    //     review, both of which are evaluated per story against that story's declared
    //     boundary -- not to a suite command every later story is forced to satisfy.
    check(
      'REPO_ROOT resolved to the actual repo root (proof-or-stop.config.json or legacy lattice.config.json present there)',
      existsSync(join(REPO_ROOT, 'proof-or-stop.config.json')) || existsSync(join(REPO_ROOT, 'lattice.config.json')),
    );

    // 13. B-16df F-004 (H-002): all 4 real runSingleAllowlistedCommand call sites in
    //     checklist.ts must route through the ONE shared resolvePinnedCommandTimeoutMs
    //     helper — no duplicated matching logic living outside it. Structural check on
    //     checklist.ts's own SOURCE text: count occurrences of the call-site invocation
    //     shape `resolvePinnedCommandTimeoutMs(root, command)`. This is distinct from the
    //     function's own declaration line (which carries type annotations —
    //     `(root: string, command: string)` — and so never matches the call-site pattern),
    //     so the two checks below independently confirm exactly one declaration and exactly
    //     four call sites.
    //     B-16df F-007: match via a regex tolerant of whitespace/formatting variance around
    //     the call (e.g. reflowed args, extra spacing) rather than a rigid literal substring
    //     -- a purely cosmetic future edit (reformatting, wrapping the call across lines)
    //     would break an exact-literal check for a non-regression it did not actually cause,
    //     while a coincidental comment containing the exact literal substring could mask a
    //     real duplication regression; requiring the same two identifiers (root, command) in
    //     the same order keeps the check meaningful either way.
    const checklistSource = readFileSync(join(REPO_ROOT, 'packages/main/src/handlers/checklist.ts'), 'utf-8');
    const CALL_SITE_RE = /resolvePinnedCommandTimeoutMs\s*\(\s*root\s*,\s*command\s*\)/g;
    const callSiteCount = (checklistSource.match(CALL_SITE_RE) || []).length;
    check(
      'checklist.ts invokes the shared resolvePinnedCommandTimeoutMs(root, command) helper at exactly 4 call sites (all 4 runSingleAllowlistedCommand sites route through it, no accidental 5th)',
      callSiteCount === 4,
    );
    const DECLARATION_SNIPPET = 'export function resolvePinnedCommandTimeoutMs(root: string, command: string): number | undefined {';
    const declarationCount = checklistSource.split(DECLARATION_SNIPPET).length - 1;
    check(
      'resolvePinnedCommandTimeoutMs is declared exactly once (a single shared helper, not duplicated matching logic)',
      declarationCount === 1,
    );

    // 14. B-16df F-004 (A-003): a very large configured timeoutMs must be CLAMPED, not an
    //     unbounded-timeout vector, end-to-end from a project's proof-or-stop.config.json through
    //     to the value actually armed on setTimeout. resolvePinnedCommandTimeoutMs itself
    //     does NOT clamp (it returns match?.timeoutMs verbatim, mirrored by section 11's
    //     verbatim-0 check above) — the existing safety net lives downstream in
    //     resolveCommandTimeoutMs (unmodified by this story, per section 12 above), which
    //     Math.min()s against MAX_NODE_TIMER_DELAY_MS (Node's setTimeout ceiling). Prove
    //     both halves: the raw resolver hands back the huge configured value unclamped
    //     (and that value genuinely exceeds the ceiling, so the clamp below is doing real
    //     work), then feeding it through resolveCommandTimeoutMs — exactly as every real
    //     call site does — clamps it to MAX_NODE_TIMER_DELAY_MS.
    const hugeTimeoutRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-hugetimeout-'));
    try {
      const HUGE_TIMEOUT_MS = 1e15;
      writeFileSync(
        join(hugeTimeoutRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: HUGE_TIMEOUT_MS },
            ],
          },
        }, null, 2),
        'utf-8',
      );
      const hugeTimeoutCommand = 'node -e "process.exit(0)"';
      const hugeTimeoutResolved = checklistMod.resolvePinnedCommandTimeoutMs(hugeTimeoutRoot, hugeTimeoutCommand);
      check('resolvePinnedCommandTimeoutMs returns a huge configured timeoutMs verbatim (no clamping in the helper itself)', hugeTimeoutResolved === HUGE_TIMEOUT_MS);
      check('the raw configured huge timeoutMs exceeds MAX_NODE_TIMER_DELAY_MS (proving the downstream clamp below is doing real work)', hugeTimeoutResolved > MAX_NODE_TIMER_DELAY_MS);
      const hugeTimeoutClamped = resolveCommandTimeoutMs(base({ timeoutMs: hugeTimeoutResolved }));
      check(
        'downstream resolveCommandTimeoutMs clamps a config-sourced huge timeoutMs to MAX_NODE_TIMER_DELAY_MS end-to-end (not passed through unbounded)',
        hugeTimeoutClamped === MAX_NODE_TIMER_DELAY_MS,
      );
    } finally {
      rmSync(hugeTimeoutRoot, { recursive: true, force: true });
    }

    // 15. B-16df F-008 (E-002 parsing parity + A-001 whitespace/quoting evasion resistance):
    //     no assertion anywhere else in this file exercises parity between the two independent
    //     tokenizers a pinned command must survive round-tripping through: splitShellWords
    //     (verifier.ts, used by commandFromString for a bare-string, non-shell
    //     validate.commands[] config entry) and tokenizeCommandString (validation-executor.ts,
    //     used by parseAllowlistedCommand for the pinned command string passed into
    //     resolvePinnedCommandTimeoutMs). A bare-string config entry structurally cannot carry
    //     a timeoutMs (section 9 / E-001), so 15a proves parity directly by comparing both
    //     tokenizers' parsed {executable/command, args} shapes for the SAME logical command
    //     written with different whitespace/quoting; 15b/15c then prove the END-TO-END
    //     resolvePinnedCommandTimeoutMs match still returns the real configured timeoutMs when
    //     the CALLER's pinned command string itself uses irregular whitespace/quoting --
    //     whitespace/quoting tricks do not evade the match (A-001).
    const parityRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-parity-'));
    try {
      // 15a. Bare-string config entry with irregular spacing + single-quoting (no
      //      SHELL_META_RE characters), parsed via splitShellWords; plus a clean object-form
      //      entry with the SAME canonical args and a real timeoutMs (used by 15c). The
      //      object-form entry is listed FIRST: resolvePinnedCommandTimeoutMs's `.find()`
      //      returns the first structural match, and both entries deliberately parse to the
      //      identical {command:"node", args:["-e","hello world"]} shape (that equality IS
      //      the parity proof) -- ordering the timeoutMs-bearing entry first keeps 15c's
      //      end-to-end resolution deterministic rather than incidentally picking the
      //      timeoutMs-less bare-string entry.
      const parityBareStringEntry = "node   -e  'hello world'";
      writeFileSync(
        join(parityRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node', args: ['-e', 'hello world'], timeoutMs: 700 },
              parityBareStringEntry,
            ],
          },
        }, null, 2),
        'utf-8',
      );
      const parityConfigured = verifierMod.configuredValidationCommands(parityRoot);
      const parityBareEntry = parityConfigured.find((c: any) => !('timeoutMs' in c));
      check(
        'irregularly-spaced/quoted bare-string config entry parses via splitShellWords to {command:"node", args:["-e","hello world"]}',
        !!parityBareEntry && parityBareEntry.command === 'node' && parityBareEntry.args.length === 2 &&
          parityBareEntry.args[0] === '-e' && parityBareEntry.args[1] === 'hello world',
      );

      // Canonical, differently-formatted pinned command string a real call site might pass
      // (double-quoting, normal single-space separation) -- parsed via tokenizeCommandString.
      const parityPinnedCommand = 'node -e "hello world"';
      const parityPinnedParsed = parseAllowlistedCommand(parityPinnedCommand);
      check(
        'tokenizeCommandString (pinned-command side) and splitShellWords (config side) normalize the same logical command to an IDENTICAL {executable, args} shape -- real E-002 parsing-parity proof',
        parityPinnedParsed.executable === parityBareEntry.command &&
          JSON.stringify(parityPinnedParsed.args) === JSON.stringify(parityBareEntry.args),
      );

      // 15c. A-001 evasion-resistance proof: an irregularly whitespaced/quoted PINNED command
      //      string (the caller side this time) still resolves the real configured timeoutMs
      //      (700, from 15a's object-form entry) via resolvePinnedCommandTimeoutMs --
      //      whitespace/quoting variation on the pinned-command side does not evade the match.
      const evasivePinnedCommand = "node    -e   'hello world'";
      const evasiveResolved = checklistMod.resolvePinnedCommandTimeoutMs(parityRoot, evasivePinnedCommand);
      check(
        'irregularly-spaced/quoted pinned command still resolves the configured timeoutMs (700) via resolvePinnedCommandTimeoutMs -- whitespace/quoting evasion does not defeat the match',
        evasiveResolved === 700,
      );
    } finally {
      rmSync(parityRoot, { recursive: true, force: true });
    }

    // 16. B-16df F-008 (CHK-003:edge:1, args-length strict-prefix mismatch): a configured
    //     command with args [a, b] must NOT match a pinned command whose args are only [a] --
    //     a strict PREFIX of the configured args -- and must return undefined, not a partial
    //     match. Section 8's disambiguation fixtures both use EQUAL-length, differing-content
    //     args (edge:2's scenario); this is the distinct edge:1 scenario (unequal length).
    const argsLengthRoot = mkdtempSync(join(tmpdir(), 'validate-command-timeout-smoke-argslength-'));
    try {
      writeFileSync(
        join(argsLengthRoot, 'proof-or-stop.config.json'),
        JSON.stringify({
          validate: {
            commands: [
              { command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 700 },
            ],
          },
        }, null, 2),
        'utf-8',
      );
      // Strict prefix of the configured args: only the FIRST of the two configured args.
      const argsLengthPrefixCommand = 'node -e';
      const argsLengthResolved = checklistMod.resolvePinnedCommandTimeoutMs(argsLengthRoot, argsLengthPrefixCommand);
      check(
        'a pinned command whose args are a strict PREFIX of a configured entry\'s (longer) args array resolves to undefined, not a partial match (CHK-003:edge:1)',
        argsLengthResolved === undefined,
      );
    } finally {
      rmSync(argsLengthRoot, { recursive: true, force: true });
    }

    // 17. B-3434 F-044 (allowlist membership + rejection). Every section above that touches
    //     parseAllowlistedCommand / resolvePinnedCommandTimeoutMs passes a command whose leading
    //     token is `node`, so all of them stay green no matter what else
    //     VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST (validation-executor.ts) contains. That was
    //     measured, not assumed: with `bash` added to the allowlist in a disposable copy of this
    //     tree, this file passed 44/44 with exit 0 -- a security-relevant widening (a pinned
    //     verification-evidence command could then launch an arbitrary shell) that nothing in the
    //     repository failed on. So pin the set itself.
    //
    //     17a states the expected membership as a literal and reports the actual membership in the
    //     assertion name, so an addition or a removal fails here and says which token moved.
    //     17b is the paired behavioural half: pinning the set only matters if a non-member is
    //     actually refused, so assert parseAllowlistedCommand throws the not-allowlisted error for
    //     a representative non-member leading token. The two halves fail independently -- 17a on a
    //     set edit alone, 17b if the set is edited AND this file's literal is edited to agree, or
    //     if the enforcement in parseAllowlistedCommand is weakened while the set stays intact.
    //
    //     SCOPE: this pins ONE constant and ONE rejection path. It is not, and does not restore,
    //     the removed byte-pin's incidental whole-file coverage of validation-executor.ts and
    //     verifier.ts (see section 12).
    const EXPECTED_ALLOWLIST = ['bun', 'node', 'npm', 'npx', 'pnpm', 'tsx', 'yarn'];
    const actualAllowlist = [...VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST].sort();
    check(
      `VERIFICATION_COMMAND_EXECUTABLE_ALLOWLIST membership is exactly [${EXPECTED_ALLOWLIST.join(', ')}] ` +
        `(actual: [${actualAllowlist.join(', ')}]) -- any addition or removal must be a reviewed, deliberate change`,
      JSON.stringify(actualAllowlist) === JSON.stringify(EXPECTED_ALLOWLIST),
    );

    const NON_MEMBER_COMMAND = 'bash -c "echo hi"';
    let nonMemberError: unknown = null;
    try {
      parseAllowlistedCommand(NON_MEMBER_COMMAND);
    } catch (e) {
      nonMemberError = e;
    }
    check(
      'parseAllowlistedCommand rejects a pinned command whose leading token is not in the allowlist (`bash -c "echo hi"` throws verification command executable "bash" is not allowlisted)',
      nonMemberError instanceof Error &&
        nonMemberError.message.includes('verification command executable "bash" is not allowlisted'),
    );

    console.log(`validate-command-timeout smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
})();
