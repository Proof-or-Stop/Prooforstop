import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// A synchronous observation owns these bytes and probe results. No entry
// survives the outer callback, a thrown error, or an await. This is not an
// execution/PASS cache.
let observation: Map<string, unknown> | undefined;
export function withGitTreeObservation<T>(read: () => T): T {
  if (observation) return read();
  observation = new Map();
  try { return read(); } finally { observation = undefined; }
}

/** The same probe arguments under the same inherited Git environment share one key. */
export function gitObservationKey(parts: readonly unknown[]): string {
  // Git also observes PATH, HOME and config-related non-GIT variables. Keep
  // the complete inherited environment in this in-memory-only key.
  return JSON.stringify([...parts, Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))]);
}

/** One synchronous observation resolves each current-state probe once. Nothing
 * in this process can move the repository inside a synchronous scope, and a
 * concurrent external move is then observed coherently by the whole scope
 * instead of by some of its rows. Outside an observation every call probes
 * Git, and a throwing probe is never memoized.
 */
export function readObservedGitState<T>(key: string, probe: () => T): T {
  if (!observation) return probe();
  const scoped = 'state\0' + key;
  if (observation.has(scoped)) return observation.get(scoped) as T;
  const value = probe();
  observation.set(scoped, value);
  return value;
}

/** Only the identical standard NUL-framed tree command shares an observation.
 * Other formats and caller-specific limits keep their existing separate readers.
 * Full object names include annotated tags; the tree memo never keys on a
 * symbolic ref, which readObservedGitState resolves once per scope instead.
 * Git replacement objects are observed afresh on the next outer observation.
 */
export function readObservedGitTree(gitCwd: string, ref: string): string {
  const argv = ['ls-tree', '-r', '-z', ref];
  const key = observation && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)
    ? gitObservationKey([resolve(gitCwd), argv])
    : undefined;
  if (key !== undefined && observation!.has(key)) return observation!.get(key) as string;
  const raw = execFileSync('git', argv, {
    cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    // Preserve both existing readers' limit. Do not widen a bounded caller.
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (key !== undefined) observation!.set(key, raw);
  return raw;
}
