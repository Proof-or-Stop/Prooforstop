/**
 * Old-PoS run 27 (§2.2, cost driver row 1): with 4 review lanes live, trivial
 * lane shell commands (cat, sed) took ~5.7 s instead of 0.1-0.25 s, and the
 * cause (in-container CPU starvation from the parallel lane launch vs host/VM
 * load from another bench) could not be isolated afterwards: nothing recorded
 * per-command time or load. Every managed run now records, diagnostic only
 * (never gate evidence, never read by a gate):
 *
 *   - one `command` row per provider shell command: the wall time between the
 *     Codex `item.started` and `item.completed` events of a `command_execution`
 *     item as the worker observed them, the commands in flight in this session
 *     when it started, and the live managed runs of the project;
 *   - one `load` row at provider spawn and every sample interval: os loadavg,
 *     CPU count, live managed runs, and where readable the Linux CPU pressure
 *     (/proc/pressure/cpu some avg10) and cgroup CPU throttling
 *     (/sys/fs/cgroup/cpu.stat nr_throttled, throttled_usec).
 *
 * Rows go to <run dir>/diagnostics.jsonl (bounded); `host_run_status --full`
 * returns summarizeManagedRunDiagnostics. Writing never fails the run.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg } from 'node:os';
import { join } from 'node:path';

export const MANAGED_RUN_DIAGNOSTICS_FILE = 'diagnostics.jsonl';
const MAX_BYTES = 512 * 1024;
const DEFAULT_SAMPLE_MS = 15_000;

/** Load sample interval (ms); PROOF_OR_STOP_HOST_LOAD_SAMPLE_MS overrides (>= 1000). */
export function managedRunLoadSampleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PROOF_OR_STOP_HOST_LOAD_SAMPLE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_SAMPLE_MS;
}

export interface CommandRow { type: 'command'; at: string; ms: number | null; startObserved: boolean; exit: number | null; inSession: number; liveRuns: number | null; command: string }
export interface LoadRow { type: 'load'; at: string; load1: number; load5: number; load15: number; cpus: number; freeMemMb: number; liveRuns: number | null; cpuPressureSome10?: number; cgroupNrThrottled?: number; cgroupThrottledUsec?: number }

function readCpuPressure(): number | undefined {
  try {
    const match = readFileSync('/proc/pressure/cpu', 'utf8').match(/^some avg10=([\d.]+)/m);
    return match ? Number(match[1]) : undefined;
  } catch { return undefined; }
}

function readCgroupThrottle(): { nr?: number; usec?: number } {
  try {
    const text = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
    const nr = text.match(/^nr_throttled (\d+)/m);
    const usec = text.match(/^throttled_usec (\d+)/m);
    return { ...(nr ? { nr: Number(nr[1]) } : {}), ...(usec ? { usec: Number(usec[1]) } : {}) };
  } catch { return {}; }
}

/** Live (non-terminal) managed runs under the project's host-runs root, or null when unreadable. */
function countLiveRuns(hostRunsRoot: string): number | null {
  try {
    return readdirSync(hostRunsRoot).filter(runId => existsSync(join(hostRunsRoot, runId, 'spec.json')) && !existsSync(join(hostRunsRoot, runId, 'terminal.json'))).length;
  } catch { return null; }
}

export function createManagedRunDiagnostics(args: { runDir: string; hostRunsRoot: string; now: () => number; sampleMs?: number }) {
  const path = join(args.runDir, MANAGED_RUN_DIAGNOSTICS_FILE);
  let partial = '';
  let timer: NodeJS.Timeout | null = null;
  const started = new Map<string, number>();
  let liveCache: { at: number; value: number | null } | null = null;
  const liveRuns = (): number | null => {
    const at = args.now();
    if (!liveCache || at - liveCache.at > 2_000) liveCache = { at, value: countLiveRuns(args.hostRunsRoot) };
    return liveCache.value;
  };
  const write = (row: CommandRow | LoadRow): void => {
    try {
      if (existsSync(path) && statSync(path).size > MAX_BYTES) return;
      appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { /* diagnostic only */ }
  };
  const sample = (): void => {
    const [load1, load5, load15] = loadavg();
    const throttle = readCgroupThrottle();
    const pressure = readCpuPressure();
    write({ type: 'load', at: new Date(args.now()).toISOString(), load1: load1!, load5: load5!, load15: load15!, cpus: cpus().length,
      freeMemMb: Math.round(freemem() / 1048576), liveRuns: liveRuns(),
      ...(pressure !== undefined ? { cpuPressureSome10: pressure } : {}),
      ...(throttle.nr !== undefined ? { cgroupNrThrottled: throttle.nr } : {}),
      ...(throttle.usec !== undefined ? { cgroupThrottledUsec: throttle.usec } : {}) });
  };
  const onLine = (line: string): void => {
    if (!line.includes('command_execution')) return;
    let event: { type?: unknown; item?: { id?: unknown; type?: unknown; command?: unknown; exit_code?: unknown } };
    try { event = JSON.parse(line); } catch { return; }
    if (event.item?.type !== 'command_execution') return;
    const id = typeof event.item.id === 'string' ? event.item.id : '';
    if (event.type === 'item.started') {
      if (id) started.set(id, args.now());
      return;
    }
    if (event.type !== 'item.completed') return;
    const at = id ? started.get(id) : undefined;
    if (id) started.delete(id);
    const ms = at === undefined ? null : args.now() - at;
    write({ type: 'command', at: new Date(at ?? args.now()).toISOString(), ms, startObserved: at !== undefined,
      exit: typeof event.item.exit_code === 'number' ? event.item.exit_code : null, inSession: started.size + 1, liveRuns: liveRuns(),
      command: String(event.item.command ?? '').replace(/\s+/g, ' ').slice(0, 120) });
  };
  return {
    /** A provider stdout chunk (may hold partial lines). */
    noteStdout(text: string): void {
      const lines = `${partial}${text}`.split('\n');
      partial = (lines.pop() ?? '').slice(-256 * 1024);
      for (const line of lines) onLine(line);
    },
    /** Provider spawned: one sample now, then every sample interval until stop. */
    start(): void {
      partial = '';
      started.clear();
      sample();
      if (!timer) {
        timer = setInterval(sample, args.sampleMs ?? managedRunLoadSampleMs());
        timer.unref?.();
      }
    },
    stop(): void {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

export interface ManagedRunDiagnosticsSummary {
  commands: { count: number; timed: number; meanMs: number | null; medianMs: number | null; p90Ms: number | null; maxMs: number | null;
    /** Median command wall time by live managed runs at command start (the run-27 dose-response). */
    medianMsByLiveRuns: Record<string, number>;
    slowest: Array<{ command: string; ms: number; at: string; liveRuns: number | null }> };
  load: { samples: number; load1Mean: number | null; load1Max: number | null; liveRunsMax: number | null; cpus: number | null;
    cpuPressureSome10Max: number | null; cgroupThrottledUsecDelta: number | null };
}

const quantile = (sorted: number[], q: number): number | null => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : null;

/** The --full summary of a run's diagnostics.jsonl, or null when the run recorded none. */
export function summarizeManagedRunDiagnostics(runDir: string): ManagedRunDiagnosticsSummary | null {
  let text = '';
  try { text = readFileSync(join(runDir, MANAGED_RUN_DIAGNOSTICS_FILE), 'utf8'); } catch { return null; }
  const rows = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as CommandRow | LoadRow]; } catch { return []; } });
  const commands = rows.filter((row): row is CommandRow => row.type === 'command');
  const loads = rows.filter((row): row is LoadRow => row.type === 'load');
  const timed = commands.filter(row => typeof row.ms === 'number');
  const ms = timed.map(row => row.ms!).sort((a, b) => a - b);
  const byLive = new Map<string, number[]>();
  for (const row of timed) {
    const key = row.liveRuns === null ? 'unknown' : String(row.liveRuns);
    byLive.set(key, [...(byLive.get(key) ?? []), row.ms!]);
  }
  const throttled = loads.map(row => row.cgroupThrottledUsec).filter((value): value is number => typeof value === 'number');
  const pressure = loads.map(row => row.cpuPressureSome10).filter((value): value is number => typeof value === 'number');
  const live = loads.map(row => row.liveRuns).filter((value): value is number => typeof value === 'number');
  return {
    commands: {
      count: commands.length, timed: timed.length,
      meanMs: ms.length ? Math.round(ms.reduce((sum, value) => sum + value, 0) / ms.length) : null,
      medianMs: quantile(ms, 0.5), p90Ms: quantile(ms, 0.9), maxMs: ms.at(-1) ?? null,
      medianMsByLiveRuns: Object.fromEntries([...byLive].map(([key, values]) => [key, quantile(values.sort((a, b) => a - b), 0.5)!])),
      slowest: [...timed].sort((a, b) => b.ms! - a.ms!).slice(0, 5).map(row => ({ command: row.command, ms: row.ms!, at: row.at, liveRuns: row.liveRuns })),
    },
    load: {
      samples: loads.length,
      load1Mean: loads.length ? Number((loads.reduce((sum, row) => sum + row.load1, 0) / loads.length).toFixed(2)) : null,
      load1Max: loads.length ? Math.max(...loads.map(row => row.load1)) : null,
      liveRunsMax: live.length ? Math.max(...live) : null,
      cpus: loads[0]?.cpus ?? null,
      cpuPressureSome10Max: pressure.length ? Math.max(...pressure) : null,
      cgroupThrottledUsecDelta: throttled.length > 1 ? throttled.at(-1)! - throttled[0]! : null,
    },
  };
}
