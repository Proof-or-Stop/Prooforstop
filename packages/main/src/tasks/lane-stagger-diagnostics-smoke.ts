#!/usr/bin/env node
/**
 * Old-PoS runs 28/29 (bench-staging/oldpos/run28-29-analysis.md §1): with the
 * lanes launched at once (review.laneLaunchStaggerMs 0, then the default),
 * light lane commands took 4.46 s mean (run 29) against 0.20 s with an 8 s
 * stagger (run 28). The cause was the 2-CPU container quota: synchronized
 * lane bursts were CFS-throttled (>= 1 s throttled per wall second), not host
 * load. And the runs could not separate CPU from IO: /proc/pressure was not
 * readable in the container and no cgroup PSI or iowait was recorded.
 *
 *   1. review.laneLaunchStaggerMs defaults to 8000 ms; 0 is still accepted (the
 *      parallel rollback); out-of-range values are refused.
 *   2. Every diagnostics `load` row carries, where readable, the cgroup v2 PSI
 *      of the container (cpu/io/memory.pressure some/full avg10 + total), the
 *      host PSI fallback (/proc/pressure), the full cgroup cpu.stat (periods,
 *      throttled periods, throttled usec, usage usec), the cgroup CPU quota
 *      (cpu.max) and /proc/stat iowait ticks; the --full summary turns them
 *      into rates (throttled s per s, share of throttled periods, pressure and
 *      iowait shares).
 *
 * Usage: node packages/main/dist/tasks/lane-stagger-diagnostics-smoke.js
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { laneLaunchStaggerMs } from '../handlers/next-driver.js';
import { createManagedRunDiagnostics, summarizeManagedRunDiagnostics } from '../core/managed-run-diagnostics.js';

const MARKER = 'lane stagger + diagnostics (old-PoS runs 28/29)';

function project(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'lane-stagger-'));
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives', ...config }));
  return root;
}

function staggerDefault(): void {
  const roots: string[] = [];
  try {
    const plain = project({}); roots.push(plain);
    assert.equal(laneLaunchStaggerMs(plain), 8000, `${MARKER}: review.laneLaunchStaggerMs defaults to 8000 ms (run 28 vs 29)`);
    const rollback = project({ review: { laneLaunchStaggerMs: 0 } }); roots.push(rollback);
    assert.equal(laneLaunchStaggerMs(rollback), 0, `${MARKER}: 0 stays the parallel rollback`);
    const custom = project({ review: { laneLaunchStaggerMs: 3000 } }); roots.push(custom);
    assert.equal(laneLaunchStaggerMs(custom), 3000, `${MARKER}: an explicit value wins`);
    const invalid = project({ review: { laneLaunchStaggerMs: 70_000 } }); roots.push(invalid);
    assert.throws(() => laneLaunchStaggerMs(invalid), /laneLaunchStaggerMs must be an integer 0\.\.60000/, `${MARKER}: out-of-range is refused`);
    console.log('stagger ok: default 8000, rollback 0, explicit 3000, 70000 refused');
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

interface Probe { cpuStat: string; cpuPressure: string; ioPressure: string; memPressure: string; procCpu: string; procStat: string }

function writeProbe(root: string, probe: Probe): void {
  mkdirSync(join(root, 'sys', 'fs', 'cgroup'), { recursive: true });
  mkdirSync(join(root, 'proc', 'pressure'), { recursive: true });
  writeFileSync(join(root, 'sys', 'fs', 'cgroup', 'cpu.stat'), probe.cpuStat);
  writeFileSync(join(root, 'sys', 'fs', 'cgroup', 'cpu.pressure'), probe.cpuPressure);
  writeFileSync(join(root, 'sys', 'fs', 'cgroup', 'io.pressure'), probe.ioPressure);
  writeFileSync(join(root, 'sys', 'fs', 'cgroup', 'memory.pressure'), probe.memPressure);
  writeFileSync(join(root, 'sys', 'fs', 'cgroup', 'cpu.max'), '200000 100000\n');
  writeFileSync(join(root, 'proc', 'pressure', 'cpu'), probe.procCpu);
  writeFileSync(join(root, 'proc', 'stat'), probe.procStat);
}

const pressure = (someAvg10: number, someTotal: number, fullTotal: number) =>
  `some avg10=${someAvg10.toFixed(2)} avg60=1.00 avg300=0.50 total=${someTotal}\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=${fullTotal}\n`;

function loadRows(): void {
  const dir = mkdtempSync(join(tmpdir(), 'lane-diagnostics-'));
  try {
    const probeRoot = join(dir, 'probe');
    const runDir = join(dir, 'run');
    mkdirSync(join(dir, 'host-runs'), { recursive: true });
    mkdirSync(runDir, { recursive: true });
    let clock = Date.parse('2026-10-08T21:15:11.000Z');
    writeProbe(probeRoot, {
      cpuStat: 'usage_usec 1000000\nuser_usec 800000\nsystem_usec 200000\nnr_periods 100\nnr_throttled 10\nthrottled_usec 500000\n',
      cpuPressure: pressure(12.5, 1_000_000, 400_000), ioPressure: pressure(0.5, 20_000, 10_000), memPressure: pressure(0, 0, 0),
      procCpu: pressure(30, 9_000_000, 0),
      procStat: 'cpu  100 0 50 800 10 0 0 0 0 0\ncpu0 50 0 25 400 5 0 0 0 0 0\n',
    });
    // probeRoot: the filesystem root the /proc and /sys/fs/cgroup probes read (default '/').
    const options: Record<string, unknown> = { runDir, hostRunsRoot: join(dir, 'host-runs'), now: () => clock, sampleMs: 3_600_000, probeRoot };
    const diagnostics = createManagedRunDiagnostics(options as unknown as Parameters<typeof createManagedRunDiagnostics>[0]);
    diagnostics.start();
    diagnostics.stop();
    clock += 10_000;
    writeProbe(probeRoot, {
      cpuStat: 'usage_usec 21000000\nuser_usec 16800000\nsystem_usec 4200000\nnr_periods 200\nnr_throttled 50\nthrottled_usec 12500000\n',
      cpuPressure: pressure(60, 7_000_000, 3_400_000), ioPressure: pressure(1, 520_000, 10_000), memPressure: pressure(0, 0, 0),
      procCpu: pressure(40, 12_000_000, 0),
      procStat: 'cpu  600 0 150 1160 50 0 0 0 0 0\ncpu0 300 0 75 580 25 0 0 0 0 0\n',
    });
    diagnostics.start();
    diagnostics.stop();
    const rows = readFileSync(join(runDir, 'diagnostics.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const first = rows[0]!;
    assert.equal(first.type, 'load', `${MARKER}: a load row`);
    for (const [key, value] of Object.entries({
      cgroupNrPeriods: 100, cgroupNrThrottled: 10, cgroupThrottledUsec: 500000, cgroupUsageUsec: 1000000, cgroupCpuQuota: 2,
      cpuPressureSome10: 12.5, cpuPressureSomeTotalUs: 1_000_000, cpuPressureFullTotalUs: 400_000,
      ioPressureSome10: 0.5, ioPressureSomeTotalUs: 20_000, ioPressureFullTotalUs: 10_000, memoryPressureSomeTotalUs: 0,
      pressureSource: 'cgroup', hostCpuPressureSome10: 30, procIowaitTicks: 10, procTotalTicks: 960,
    })) assert.deepEqual(first[key], value, `${MARKER}: load row ${key} (row: ${JSON.stringify(first)})`);
    const summary = summarizeManagedRunDiagnostics(runDir)!.load as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      samples: 2, cgroupThrottledUsecDelta: 12_000_000, cgroupThrottledSecPerSec: 1.2, cgroupThrottledPeriodShare: 0.4,
      cgroupUsageCpusMean: 2, cpuPressureSomeShare: 0.6, cpuPressureFullShare: 0.3, ioPressureSomeShare: 0.05, memoryPressureSomeShare: 0,
      procIowaitShare: 0.04, cgroupCpuQuota: 2,
    })) assert.deepEqual(summary[key], value, `${MARKER}: --full summary ${key} (summary: ${JSON.stringify(summary)})`);
    console.log(`diagnostics ok: ${JSON.stringify(summary).slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

staggerDefault();
loadRows();
console.log('lane-stagger-diagnostics-smoke: PASS');
