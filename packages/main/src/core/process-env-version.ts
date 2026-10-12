/**
 * Lab framework-perf: the git observation key and the git read cache key the
 * whole process environment. Rebuilding the sorted entries (with ICU
 * localeCompare in the observation key) for every git probe cost ~1.2 s of
 * CPU per harness scenario. A value derived from process.env is now rebuilt
 * only when the environment's serialization changed (one JSON.stringify per
 * call: exact, no write tracking, no change to process.env itself).
 */
export function envDerived<T>(derive: () => T): () => T {
  let memo: { snapshot: string; value: T } | undefined;
  return () => {
    const snapshot = JSON.stringify(process.env);
    if (memo && memo.snapshot === snapshot) return memo.value;
    memo = { snapshot, value: derive() };
    return memo.value;
  };
}
