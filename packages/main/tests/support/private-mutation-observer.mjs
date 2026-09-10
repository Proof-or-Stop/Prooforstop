import assert from 'node:assert/strict';

// A private, synchronous mutation harness: every rejected operation must leave
// the same complete protected state. This helper never runs on a live Story.
export function createPrivateMutationObserver({ snapshot, root }) {
  const stats = { snapshots: 0, snapshotMs: 0, operations: 0, root };
  const capture = () => {
    const start = performance.now();
    try { return snapshot(); }
    finally { stats.snapshots++; stats.snapshotMs += performance.now() - start; }
  };
  return {
    before(_injectedPath) { return capture(); },
    after(before, message) {
      assert.deepEqual(capture(), before, message);
      stats.operations++;
    },
    stats,
  };
}
