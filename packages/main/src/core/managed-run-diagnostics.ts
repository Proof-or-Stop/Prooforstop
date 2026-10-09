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
 *     CPU count, live managed runs, and where readable (old-PoS runs 28/29,
 *     run28-29-analysis.md §1: the container's CPU quota throttled the lane
 *     bursts, and IO could not be ruled out because nothing measured it):
 *       - the container's cgroup v2 PSI (/sys/fs/cgroup/{cpu,io,memory}.pressure:
 *         some avg10 + some/full total usec), else the host PSI (/proc/pressure/*);
 *         pressureSource says which; hostCpuPressureSome10 keeps the host CPU value;
 *       - the full cgroup cpu.stat (nr_periods, nr_throttled, throttled_usec,
 *         usage_usec) and the cgroup CPU quota in CPUs (cpu.max);
 *       - /proc/stat iowait and total CPU ticks (an IO-wait signal without PSI).
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
export interface LoadRow {
  type: 'load'; at: string; load1: number; load5: number; load15: number; cpus: number; freeMemMb: number; liveRuns: number | null;
  /** Where the *Pressure* fields come from: the container's cgroup (preferred) or the host /proc/pressure. */
  pressureSource?: 'cgroup' | 'proc';
  cpuPressureSome10?: number; cpuPressureSomeTotalUs?: number; cpuPressureFullTotalUs?: number;
  ioPressureSome10?: number; ioPressureSomeTotalUs?: number; ioPressureFullTotalUs?: number;
  memoryPressureSome10?: number; memoryPressureSomeTotalUs?: number; memoryPressureFullTotalUs?: number;
  /** Host /proc/pressure/cpu some avg10 (also when the cgroup PSI is the source). */
  hostCpuPressureSome10?: number;
  cgroupNrPeriods?: number; cgroupNrThrottled?: number; cgroupThrottledUsec?: number; cgroupUsageUsec?: number;
  /** cgroup cpu.max quota / period in CPUs (absent when unlimited or unreadable). */
  cgroupCpuQuota?: number;
  /** /proc/stat aggregate `cpu` line: iowait ticks and the sum of all ticks. */
  procIowaitTicks?: number; procTotalTicks?: number;
}

type Pressure = { some10?: number; someTotal?: number; fullTotal?: number };

function readText(probeRoot: string, path: string): string | null {
  try { return readFileSync(join(probeRoot, path), 'utf8'); } catch { return null; }
}

/** A PSI file (`some avg10=.. total=..` / `full ...`), or null when absent or unreadable (PSI disabled). */
function readPressure(probeRoot: string, path: string): Pressure | null {
  const text = readText(probeRoot, path);
  if (text === null) return null;
  const some = text.match(/^some avg10=([\d.]+)[^\n]*total=(\d+)/m);
  const full = text.match(/^full avg10=[\d.]+[^\n]*total=(\d+)/m);
  if (!some) return null;
  return { some10: Number(some[1]), someTotal: Number(some[2]), ...(full ? { fullTotal: Number(full[1]) } : {}) };
}

function pressureFields(prefix: 'cpu' | 'io' | 'memory', value: Pressure | null): Partial<LoadRow> {
  if (!value) return {};
  return {
    ...(value.some10 !== undefined ? { [`${prefix}PressureSome10`]: value.some10 } : {}),
    ...(value.someTotal !== undefined ? { [`${prefix}PressureSomeTotalUs`]: value.someTotal } : {}),
    ...(value.fullTotal !== undefined ? { [`${prefix}PressureFullTotalUs`]: value.fullTotal } : {}),
  } as Partial<LoadRow>;
}

/** PSI, cgroup cpu.stat / cpu.max and /proc/stat iowait, each only where readable. */
export function readHostPressureProbe(probeRoot = '/'): Partial<LoadRow> {
  const row: Partial<LoadRow> = {};
  const cgroup = { cpu: readPressure(probeRoot, 'sys/fs/cgroup/cpu.pressure'), io: readPressure(probeRoot, 'sys/fs/cgroup/io.pressure'),
    memory: readPressure(probeRoot, 'sys/fs/cgroup/memory.pressure') };
  const host = { cpu: readPressure(probeRoot, 'proc/pressure/cpu'), io: readPressure(probeRoot, 'proc/pressure/io'),
    memory: readPressure(probeRoot, 'proc/pressure/memory') };
  const source = cgroup.cpu || cgroup.io || cgroup.memory ? 'cgroup' : host.cpu || host.io || host.memory ? 'proc' : null;
  if (source) {
    const chosen = source === 'cgroup' ? cgroup : host;
    Object.assign(row, { pressureSource: source }, pressureFields('cpu', chosen.cpu), pressureFields('io', chosen.io), pressureFields('memory', chosen.memory));
  }
  if (host.cpu?.some10 !== undefined) row.hostCpuPressureSome10 = host.cpu.some10;
  const stat = readText(probeRoot, 'sys/fs/cgroup/cpu.stat');
  if (stat !== null) {
    for (const [key, field] of [['nr_periods', 'cgroupNrPeriods'], ['nr_throttled', 'cgroupNrThrottled'], ['throttled_usec', 'cgroupThrottledUsec'], ['usage_usec', 'cgroupUsageUsec']] as const) {
      const match = stat.match(new RegExp(`^${key} (\\d+)`, 'm'));
      if (match) row[field] = Number(match[1]);
    }
  }
  const max = readText(probeRoot, 'sys/fs/cgroup/cpu.max')?.trim().split(/\s+/);
  if (max && max.length === 2 && /^\d+$/.test(max[0]!) && /^\d+$/.test(max[1]!) && Number(max[1]) > 0) {
    row.cgroupCpuQuota = Number((Number(max[0]) / Number(max[1])).toFixed(3));
  }
  const cpuLine = readText(probeRoot, 'proc/stat')?.split('\n').find(line => /^cpu\s/.test(line));
  if (cpuLine) {
    const ticks = cpuLine.trim().split(/\s+/).slice(1).map(Number);
    if (ticks.length >= 5 && ticks.every(Number.isFinite)) {
      row.procIowaitTicks = ticks[4]!;
      // user nice system idle iowait irq softirq steal (guest time is already inside user/nice).
      row.procTotalTicks = ticks.slice(0, 8).reduce((sum, value) => sum + value, 0);
    }
  }
  return row;
}

/** Live (non-terminal) managed runs under the project's host-runs root, or null when unreadable. */
function countLiveRuns(hostRunsRoot: string): number | null {
  try {
    return readdirSync(hostRunsRoot).filter(runId => existsSync(join(hostRunsRoot, runId, 'spec.json')) && !existsSync(join(hostRunsRoot, runId, 'terminal.json'))).length;
  } catch { return null; }
}

export function createManagedRunDiagnostics(args: { runDir: string; hostRunsRoot: string; now: () => number; sampleMs?: number;
  /** Filesystem root of the /proc and /sys/fs/cgroup probes (default '/'). */
  probeRoot?: string }) {
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
    write({ type: 'load', at: new Date(args.now()).toISOString(), load1: load1!, load5: load5!, load15: load15!, cpus: cpus().length,
      freeMemMb: Math.round(freemem() / 1048576), liveRuns: liveRuns(), ...readHostPressureProbe(args.probeRoot ?? '/') });
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
    cpuPressureSome10Max: number | null; cgroupThrottledUsecDelta: number | null;
    /** Old-PoS runs 28/29 rates over the first..last sample (null when not measurable). */
    cgroupCpuQuota: number | null;
    /** Seconds the container was CFS-throttled per wall second (run 29 slow rounds: >= 1). */
    cgroupThrottledSecPerSec: number | null;
    /** Throttled share of CFS periods. */
    cgroupThrottledPeriodShare: number | null;
    /** Mean CPUs the container used. */
    cgroupUsageCpusMean: number | null;
    /** PSI stall shares of wall time (some = at least one task stalled; full = all stalled). */
    cpuPressureSomeShare: number | null; cpuPressureFullShare: number | null;
    ioPressureSomeShare: number | null; ioPressureFullShare: number | null;
    memoryPressureSomeShare: number | null;
    pressureSource: 'cgroup' | 'proc' | null;
    /** iowait share of all CPU ticks (/proc/stat). */
    procIowaitShare: number | null };
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
      ...loadRates(loads),
    },
  };
}

/** Rates between the first and the last load sample that carry a field (rounded to 4 decimals). */
function loadRates(loads: LoadRow[]): Pick<ManagedRunDiagnosticsSummary['load'], 'cgroupCpuQuota' | 'cgroupThrottledSecPerSec' | 'cgroupThrottledPeriodShare'
  | 'cgroupUsageCpusMean' | 'cpuPressureSomeShare' | 'cpuPressureFullShare' | 'ioPressureSomeShare' | 'ioPressureFullShare' | 'memoryPressureSomeShare'
  | 'pressureSource' | 'procIowaitShare'> {
  const round = (value: number): number => Number(value.toFixed(4));
  const span = (field: keyof LoadRow): { delta: number; seconds: number } | null => {
    const rows = loads.filter(row => typeof row[field] === 'number');
    if (rows.length < 2) return null;
    const seconds = (Date.parse(rows.at(-1)!.at) - Date.parse(rows[0]!.at)) / 1000;
    if (!(seconds > 0)) return null;
    return { delta: (rows.at(-1)![field] as number) - (rows[0]![field] as number), seconds };
  };
  const perSecond = (field: keyof LoadRow, unit: number): number | null => {
    const value = span(field);
    return value ? round(value.delta / unit / value.seconds) : null;
  };
  const ratio = (numerator: keyof LoadRow, denominator: keyof LoadRow): number | null => {
    const top = span(numerator);
    const bottom = span(denominator);
    return top && bottom && bottom.delta > 0 ? round(top.delta / bottom.delta) : null;
  };
  return {
    cgroupCpuQuota: loads.find(row => typeof row.cgroupCpuQuota === 'number')?.cgroupCpuQuota ?? null,
    cgroupThrottledSecPerSec: perSecond('cgroupThrottledUsec', 1e6),
    cgroupThrottledPeriodShare: ratio('cgroupNrThrottled', 'cgroupNrPeriods'),
    cgroupUsageCpusMean: perSecond('cgroupUsageUsec', 1e6),
    cpuPressureSomeShare: perSecond('cpuPressureSomeTotalUs', 1e6),
    cpuPressureFullShare: perSecond('cpuPressureFullTotalUs', 1e6),
    ioPressureSomeShare: perSecond('ioPressureSomeTotalUs', 1e6),
    ioPressureFullShare: perSecond('ioPressureFullTotalUs', 1e6),
    memoryPressureSomeShare: perSecond('memoryPressureSomeTotalUs', 1e6),
    pressureSource: loads.find(row => row.pressureSource)?.pressureSource ?? null,
    procIowaitShare: ratio('procIowaitTicks', 'procTotalTicks'),
  };
}
