/**
 * `proof-or-stop next --storyId=<id> --untilAgent`: the framework drives the
 * owner (old-PoS owner-driver lab, bench-staging/oldpos/structural-cost-analysis.md
 * and lifecycle-state-machine.md "Framework owner driver").
 *
 * Old-PoS runs 40/54/56: 36-51% of the owner's model requests (43-59% of its
 * input tokens) only drove the framework: `next --run`, the 30 s Codex return
 * and its `write_stdin` poll, the rerun after `paused: wait budget ... used`,
 * status reads. None of it needs a model. This driver loops over `next --run`
 * calls in child processes with no owner in between and returns exactly one
 * step: the first agent or human step, a refusal (`stopped`), DONE, or its own
 * budget. It never executes a step itself: every step it runs is one that
 * `next --run` already runs (framework kind, every gate in its own process), so
 * a judgment step is never auto-performed.
 *
 * Watchdog (old-PoS run 55: a `next --run` process sat 25.8 min after a
 * completed wait with no child process and no output until the owner killed
 * it; the CLI idle watchdog is a timer, which a synchronously blocked process
 * never runs). Each `next --run` call runs in its own process group. A call
 * that prints nothing for `stallMs` while no step process runs below it (only
 * `next` processes in its tree), or for `stepStallMs` while one does (a hung
 * wait, import or git hook), is killed as a group and the same call is made
 * again: `next` re-decides from the real state, which is how run 55's owner
 * recovered. More than `maxConsecutiveKills` kills in a row end the drive with
 * outcome `watchdog`.
 *
 * Leaf module: node built-ins and brand-env only (no lifecycle imports), so
 * next-driver.ts can import it without a new cycle.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readBrandEnv } from '../core/brand-env.js';

export const NEXT_DRIVE_SCHEMA = 'proof-or-stop.next_drive.v1';

/** No output and no step process below the call for this long = a stalled `next` (run 55 shape). */
export const DEFAULT_DRIVE_STALL_MS = 180_000;
/** No output for this long while a step process runs below the call = a hung step (wait/import/git hook). */
export const DEFAULT_DRIVE_STEP_STALL_MS = 1_200_000;
/** How often the watchdog looks at the call. */
export const DEFAULT_DRIVE_POLL_MS = 5_000;
/** Kills in a row after which the drive stops (outcome `watchdog`). */
export const DRIVE_MAX_CONSECUTIVE_KILLS = 2;
/** Unparseable `next --run` results in a row after which the drive stops (outcome `error`). */
export const DRIVE_MAX_CONSECUTIVE_ERRORS = 2;

function envMs(name: string, fallback: number, min: number): number {
  const raw = Number(readBrandEnv(name));
  return Number.isInteger(raw) && raw >= min ? raw : fallback;
}

/** Watchdog thresholds; PROOF_OR_STOP_DRIVE_STALL_MS / _DRIVE_STEP_STALL_MS / _DRIVE_POLL_MS override them. */
export function driveWatchdogConfig(): { stallMs: number; stepStallMs: number; pollMs: number } {
  return {
    stallMs: envMs('DRIVE_STALL_MS', DEFAULT_DRIVE_STALL_MS, 1_000),
    stepStallMs: envMs('DRIVE_STEP_STALL_MS', DEFAULT_DRIVE_STEP_STALL_MS, 1_000),
    pollMs: envMs('DRIVE_POLL_MS', DEFAULT_DRIVE_POLL_MS, 100),
  };
}

/** The part of a next step the drive loop reads (handlers/next-driver.ts NextStep). */
export interface DriveStep {
  kind: 'agent' | 'framework' | 'human';
  reason: string;
  phase: string;
  done?: boolean;
  cli?: { command: string; payload: Record<string, unknown> } | null;
}

export interface DriveRunRecord { command: string; reason: string; exit: number; ms: number; tail: string }

/** One `next --run` call as the child process ended. */
export interface DriveCallOutcome {
  exit: number | null;
  stdout: string;
  ms: number;
  /** Set when the watchdog killed the call's process group. */
  killed?: { reason: 'stall' | 'step_stall'; silentMs: number; tree: string[] };
}

export type DriveOutcome = 'agent' | 'human' | 'done' | 'stopped' | 'framework_blocked' | 'budget' | 'watchdog' | 'error';

export interface DriveCallSummary { call: number; ms: number; executed: number; paused: boolean; stopped: string | null; killed?: DriveCallOutcome['killed'] }

export interface DriveResult<S extends DriveStep = DriveStep> {
  outcome: DriveOutcome;
  /** Every framework step the `next --run` calls executed, in order. */
  executed: DriveRunRecord[];
  calls: DriveCallSummary[];
  /** The watchdog kills of this drive. */
  watchdog: Array<{ call: number; reason: string; silentMs: number; tree: string[] }>;
  /** The refusal / stop reason when outcome is stopped, watchdog, error or budget. */
  stopped: string | null;
  /** The step handed to the agent (or the last one seen). */
  next: S | null;
  /** The Story worktree the calls ran in, when it exists. */
  worktree?: string;
}

function parseCallJson(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)) as Record<string, unknown>; } catch { return null; }
}

/**
 * The drive loop, separated from process spawning so its rules are testable:
 * call `next --run` until it returns a step that is not framework work.
 *   paused (wait budget used)            -> call again (no owner turn)
 *   framework step left (maxSteps)        -> call again
 *   agent / human / DONE                  -> return it
 *   stopped (a refused step, a launch decided twice) -> return it with the reason (the owner's judgment)
 *   framework step with no runnable command -> return it (framework_blocked; `next` prints why)
 *   watchdog kill                         -> call again; more than DRIVE_MAX_CONSECUTIVE_KILLS in a row -> watchdog
 */
export async function driveUntilAgent<S extends DriveStep>(args: {
  call: (index: number) => Promise<DriveCallOutcome>;
  now?: () => number;
  /** Total drive budget (ms); unset = until a non-framework step. */
  budgetMs?: number;
  maxConsecutiveKills?: number;
  log?: (line: string) => void;
}): Promise<DriveResult<S>> {
  const now = args.now ?? Date.now;
  const started = now();
  const maxKills = args.maxConsecutiveKills ?? DRIVE_MAX_CONSECUTIVE_KILLS;
  const executed: DriveRunRecord[] = [];
  const calls: DriveCallSummary[] = [];
  const watchdog: DriveResult['watchdog'] = [];
  let next: S | null = null;
  let worktree: string | undefined;
  let kills = 0;
  let errors = 0;
  const done = (outcome: DriveOutcome, stopped: string | null = null): DriveResult<S> => ({ outcome, executed, calls, watchdog, stopped, next, ...(worktree ? { worktree } : {}) });
  for (let index = 1; ; index += 1) {
    if (args.budgetMs !== undefined && now() - started >= args.budgetMs) {
      return done('budget', `drive budget of ${Math.round(args.budgetMs / 1000)} s used; run the same command again (nothing is lost: every managed run keeps going)`);
    }
    const outcome = await args.call(index);
    if (outcome.killed) {
      kills += 1;
      watchdog.push({ call: index, reason: outcome.killed.reason, silentMs: outcome.killed.silentMs, tree: outcome.killed.tree });
      calls.push({ call: index, ms: outcome.ms, executed: 0, paused: false, stopped: null, killed: outcome.killed });
      args.log?.(`watchdog: next --run call ${index} printed nothing for ${Math.round(outcome.killed.silentMs / 1000)} s `
        + `(${outcome.killed.reason === 'stall' ? 'no step process running' : 'a step process hung'}); killed its process group, deciding again`);
      if (kills > maxKills) {
        return done('watchdog', `next --run stalled ${kills} times in a row (last: ${outcome.killed.reason}, ${Math.round(outcome.killed.silentMs / 1000)} s silent; processes: ${outcome.killed.tree.join(' | ') || 'none'})`);
      }
      continue;
    }
    kills = 0;
    const parsed = parseCallJson(outcome.stdout);
    const step = parsed?.next as S | undefined;
    if (!parsed || !step || typeof step.kind !== 'string') {
      errors += 1;
      calls.push({ call: index, ms: outcome.ms, executed: 0, paused: false, stopped: `unparseable next --run result (exit ${outcome.exit})` });
      if (errors >= DRIVE_MAX_CONSECUTIVE_ERRORS) return done('error', `next --run returned no step ${errors} times (exit ${outcome.exit}): ${outcome.stdout.slice(-600)}`);
      continue;
    }
    errors = 0;
    next = step;
    if (typeof parsed.worktree === 'string') worktree = parsed.worktree;
    const rows = Array.isArray(parsed.executed) ? parsed.executed as DriveRunRecord[] : [];
    executed.push(...rows);
    const stopped = typeof parsed.stopped === 'string' ? parsed.stopped : null;
    const paused = typeof parsed.paused === 'string';
    calls.push({ call: index, ms: outcome.ms, executed: rows.length, paused, stopped });
    if (stopped && !/^maxSteps=\d+ reached$/.test(stopped)) return done('stopped', stopped);
    if (step.done) return done('done');
    if (step.kind === 'agent') return done('agent');
    if (step.kind === 'human') return done('human');
    if (paused) continue;
    if (!step.cli) return done('framework_blocked', `framework step ${step.reason} has no runnable command (see its Why)`);
    if (rows.length === 0) return done('framework_blocked', `next --run made no progress on framework step ${step.reason}`);
  }
}

// ---------------------------------------------------------------------------
// Process tree (watchdog)

export interface TreeProcess { pid: number; ppid: number; args: string }

/** Every process of the machine with its parent and command line (/proc on Linux, else ps). */
export function listProcesses(): TreeProcess[] {
  if (existsSync('/proc/self/stat')) {
    const out: TreeProcess[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        out.push({ pid: Number(name), ppid, args });
      } catch { /* exited meanwhile */ }
    }
    return out;
  }
  const text = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return text.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => m !== null)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3]! }));
}

/** The descendants of `root` (not root itself). */
export function descendantsOf(root: number, processes: readonly TreeProcess[]): TreeProcess[] {
  const children = new Map<number, TreeProcess[]>();
  for (const row of processes) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const out: TreeProcess[] = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child.pid === root || out.some(row => row.pid === child.pid)) continue;
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** A `next` CLI process (`node <cli> next {...}`): the driver's own layer, not step work. */
export function isNextProcess(args: string): boolean {
  return /\snext\s+\{/.test(` ${args}`);
}

// ---------------------------------------------------------------------------
// One `next --run` call in its own process group, under the watchdog

export function runWatchedCall(args: {
  argv: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stallMs: number;
  stepStallMs: number;
  pollMs: number;
  /** Each stderr line of the call (the `ran:` lines), as it arrives. */
  onLine?: (line: string) => void;
  /** Process listing (default listProcesses); a failure counts as "a step process runs". */
  processes?: () => TreeProcess[];
}): Promise<DriveCallOutcome> {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(args.argv[0]!, args.argv.slice(1), { cwd: args.cwd, env: args.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrRest = '';
    let lastOutput = Date.now();
    let killed: DriveCallOutcome['killed'];
    const killGroup = (): void => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const onExit = (): void => killGroup();
    process.once('exit', onExit);
    child.stdout!.on('data', chunk => { stdout += String(chunk); lastOutput = Date.now(); });
    child.stderr!.on('data', chunk => {
      lastOutput = Date.now();
      const lines = (stderrRest + String(chunk)).split('\n');
      stderrRest = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) args.onLine?.(line);
    });
    const timer = setInterval(() => {
      if (killed || child.pid === undefined) return;
      const silentMs = Date.now() - lastOutput;
      if (silentMs < Math.min(args.stallMs, args.stepStallMs)) return;
      let tree: TreeProcess[] | null;
      try { tree = descendantsOf(child.pid, (args.processes ?? listProcesses)()); } catch { tree = null; }
      const stepRunning = tree === null || tree.some(row => !isNextProcess(row.args));
      const limit = stepRunning ? args.stepStallMs : args.stallMs;
      if (silentMs < limit) return;
      killed = { reason: stepRunning ? 'step_stall' : 'stall', silentMs, tree: (tree ?? []).map(row => `${row.pid} ${row.args.slice(0, 160)}`) };
      killGroup();
    }, args.pollMs);
    child.on('close', code => {
      clearInterval(timer);
      process.removeListener('exit', onExit);
      if (stderrRest.trim()) args.onLine?.(stderrRest);
      resolve({ exit: code, stdout, ms: Date.now() - started, ...(killed ? { killed } : {}) });
    });
    child.on('error', error => {
      clearInterval(timer);
      process.removeListener('exit', onExit);
      resolve({ exit: -1, stdout: `${stdout}\n${String(error)}`, ms: Date.now() - started, ...(killed ? { killed } : {}) });
    });
  });
}
