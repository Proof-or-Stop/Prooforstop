/**
 * Lab framework-perf: the git observation key and the git read cache key the
 * whole process environment. Serializing process.env (an accessor-backed
 * object: one native getter per variable) for every git probe cost ~1.5 s of
 * CPU per harness scenario. With write tracking on (CLI start), a version
 * number changes on every set/delete/define through process.env, so callers
 * rebuild their environment key only after a write. Without it (tests, other
 * entries, or process.env replaced by someone else) processEnvVersion()
 * returns undefined and callers compare a full snapshot as before.
 */
let version = 0;
let tracked: NodeJS.ProcessEnv | undefined;

export function trackProcessEnvWrites(): void {
  if (tracked && process.env === tracked) return;
  const target = process.env;
  tracked = new Proxy(target, {
    set(object, key, value) { version++; return Reflect.set(object, key, value); },
    deleteProperty(object, key) { version++; return Reflect.deleteProperty(object, key); },
    defineProperty(object, key, descriptor) { version++; return Reflect.defineProperty(object, key, descriptor); },
  });
  process.env = tracked;
}

/** Changes whenever process.env may have changed; undefined when writes are not tracked. */
export function processEnvVersion(): number | undefined {
  return tracked !== undefined && process.env === tracked ? version : undefined;
}

/** A memo of a value derived from process.env, rebuilt only when the environment may have changed. */
export function envDerived<T>(derive: () => T): () => T {
  let memo: { version: number | undefined; snapshot: string | undefined; value: T } | undefined;
  return () => {
    const current = processEnvVersion();
    if (current !== undefined) {
      if (memo && memo.version === current) return memo.value;
      memo = { version: current, snapshot: undefined, value: derive() };
      return memo.value;
    }
    const snapshot = JSON.stringify(process.env);
    if (memo && memo.version === undefined && memo.snapshot === snapshot) return memo.value;
    memo = { version: undefined, snapshot, value: derive() };
    return memo.value;
  };
}
