/**
 * One wait contract for every blocking owner-facing PoS command.
 *
 * Run 14 (abs-stepped-slices) cost analysis: the owner polled a blocking
 * `host_run_status --untilTerminal` with a 30 s tool yield 161 times (59.1M
 * input tokens re-read) because the long-yield hint was printed only once by
 * `host_run`, never by the wait itself. A blocking command now prints this
 * exact instruction as its FIRST output line (stderr, before any work), and
 * blocks server-side for at most OWNER_WAIT_BLOCK_MS, which ends inside one
 * OWNER_WAIT_YIELD_MS tool yield including CLI start-up and stays below the
 * CLI's 5-minute idle watchdog. One owner turn then covers up to ~5 minutes.
 *
 * Leaf module: no imports, so the CLI engine, handlers and the next driver
 * share it without new dependency edges.
 */

/** Tool yield / shell timeout the owner should give one blocking call. */
export const OWNER_WAIT_YIELD_MS = 300_000;

/** Default server-side block of one wait call; ends inside one OWNER_WAIT_YIELD_MS yield. */
export const OWNER_WAIT_BLOCK_MS = 285_000;

/** The exact first-line instruction for a blocking command or a wait step. */
export function ownerWaitInstruction(blocks = `blocks up to ${OWNER_WAIT_BLOCK_MS / 1000} s`): string {
  return `Wait: this call ${blocks}; give it a tool yield/shell timeout of ${OWNER_WAIT_YIELD_MS} ms `
    + `(Codex: yield_time_ms=${OWNER_WAIT_YIELD_MS}; if it is still running, write_stdin yield_time_ms=${OWNER_WAIT_YIELD_MS} on the same session). `
    + 'Do not poll more often; if it returns non-terminal, run the same command again.';
}

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Whether `host_run_status` with these parsed arguments waits until terminal.
 * An explicit untilTerminal wins. Otherwise text output defaults to it (an
 * owner reading status is waiting for the worker), while machine JSON and an
 * explicit waitMs/afterGeneration cursor keep the 30 s progress long-poll.
 */
export function hostRunStatusBlocksUntilTerminal(args: Record<string, unknown>): boolean {
  if (args.targets !== undefined) return false;
  if (args.untilTerminal !== undefined) return flag(args.untilTerminal);
  if (args.afterGeneration !== undefined || args.waitMs !== undefined) return false;
  return !(flag(args.json) || args.format === 'json' || flag(args.full));
}

/**
 * The wait instruction for one CLI invocation, or null when the command does
 * not block on a worker: an until-terminal host_run_status, a foreground
 * (attached) host_run, and `next --run` (which may run wait steps).
 */
export function ownerWaitInstructionFor(command: string, args: Record<string, unknown>): string | null {
  if (command === 'host_run_status') {
    const snapshot = args.waitMs === 0 || args.waitMs === '0';
    return hostRunStatusBlocksUntilTerminal(args) && !snapshot ? ownerWaitInstruction() : null;
  }
  if (command === 'host_run') return flag(args.detach) ? null : ownerWaitInstruction('stays attached until the worker is terminal');
  if (command === 'next') return flag(args.run) ? ownerWaitInstruction(`runs framework steps, launches fully bound managed runs and blocks up to ${OWNER_WAIT_BLOCK_MS / 1000} s on their waits`) : null;
  return null;
}
