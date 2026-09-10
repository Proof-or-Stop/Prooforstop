import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// A private, synchronous mutation harness: every rejected operation must leave
// the same complete protected state. This helper never runs on a live Story.
export function createPrivateMutationObserver({ snapshot, root }) {
  const stats = { snapshots: 0, snapshotMs: 0, operations: 0, root };
  const tracked = new Set(execFileSync('git', ['ls-files', '--cached', '-z'], {cwd:root,encoding:'utf8',maxBuffer:64*1024*1024}).split('\0'));
  const runtimePrefix = 'packages/main/dist/';
  let baseline;
  const unobservedInjection = path => {
    const absolute=resolve(path), rel=relative(root,absolute);
    // Only the harness's copied, ignored compiled consumer is eligible. Project
    // config, Story/runtime state, tracked files, symlinks and external targets
    // retain an independent before snapshot. Recheck ignore policy each time.
    if(!rel.startsWith(runtimePrefix) || tracked.has(rel)) return false;
    try { if(realpathSync(absolute)!==join(realpathSync(root),rel)) return false; }
    catch { return false; }
    return spawnSync('git',['check-ignore','--quiet','--',rel],{cwd:root}).status===0;
  };
  const capture = () => {
    const start = performance.now();
    try { return snapshot(); }
    finally { stats.snapshots++; stats.snapshotMs += performance.now() - start; }
  };
  return {
    before(injectedPath) {
      if(!unobservedInjection(injectedPath)) return capture();
      // There are no untrusted operations between cases except those whose
      // complete after-state is checked below. A persistent baseline also
      // detects between-case drift that two fresh snapshots could both accept.
      return baseline ??= capture();
    },
    after(before, message) {
      assert.deepEqual(capture(), before, message);
      stats.operations++;
    },
    stats,
  };
}
