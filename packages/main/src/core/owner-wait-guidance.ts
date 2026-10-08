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

/** Tool yield / shell timeout the owner should give one blocking call (default block). */
export const OWNER_WAIT_YIELD_MS = 300_000;

/** Default server-side block of one wait call; ends inside one OWNER_WAIT_YIELD_MS yield. */
export const OWNER_WAIT_BLOCK_MS = 285_000;

/**
 * N5 (v4.1 cost plan, runs 22-24): Codex 0.154 returns EVERY `exec_command`
 * after 30.0 s while the command still runs, whatever `yield_time_ms` asks
 * (34 of 34 owner `next --run` calls that blocked longer returned at exactly
 * 30.0 s with yield_time_ms=300000; output or none made no difference). Only
 * the `write_stdin` poll on the same session honours a long yield, bounded by
 * Codex's `background_terminal_max_timeout` (default 300000 ms). So a blocking
 * call longer than 30 s always costs exactly two owner tool turns on Codex
 * (exec, then one poll), and the lever is how much each pair covers: a host
 * that raises background_terminal_max_timeout may raise the server-side block
 * with this variable (30 s to 585 s; the until-terminal status wait caps at
 * 600 s). Unset or invalid keeps the default 285 s.
 */
export const OWNER_WAIT_BLOCK_ENV = 'PROOF_OR_STOP_OWNER_WAIT_BLOCK_MS';
export const OWNER_WAIT_BLOCK_MAX_MS = 585_000;

/** Server-side block of one owner wait call (default OWNER_WAIT_BLOCK_MS). */
export function ownerWaitBlockMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[OWNER_WAIT_BLOCK_ENV]);
  if (!Number.isInteger(raw) || raw < 30_000 || raw > OWNER_WAIT_BLOCK_MAX_MS) return OWNER_WAIT_BLOCK_MS;
  return raw;
}

/** The tool yield / shell timeout that covers one block, CLI start-up included. */
export function ownerWaitYieldMs(env: NodeJS.ProcessEnv = process.env): number {
  const block = ownerWaitBlockMs(env);
  return block === OWNER_WAIT_BLOCK_MS ? OWNER_WAIT_YIELD_MS : block + 15_000;
}

/** The exact first-line instruction for a blocking command or a wait step. */
export function ownerWaitInstruction(blocks = `blocks up to ${ownerWaitBlockMs() / 1000} s`): string {
  const yieldMs = ownerWaitYieldMs();
  return `Wait: this call ${blocks}; give it a tool yield/shell timeout of ${yieldMs} ms `
    + `(Codex: yield_time_ms=${yieldMs}; Codex returns exec_command after 30 s while it still runs, whatever the yield: then call write_stdin yield_time_ms=${yieldMs} on the same session once, with empty input). `
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
  if (command === 'next') return flag(args.run) ? ownerWaitInstruction(`runs framework steps, launches fully bound managed runs and blocks up to ${ownerWaitBlockMs() / 1000} s on their waits`) : null;
  return null;
}
