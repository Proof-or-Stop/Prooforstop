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

class ObservedGitFailure { constructor(readonly error: unknown) {} }

/** Identical read-only git probes (same cwd, argv and inherited environment) inside
 * one synchronous observation run once; a failing command is observed as failed for
 * the rest of that segment and fails the same way. Outside an observation every call
 * runs git, and mutating commands must never pass here. */
export function observedGit(gitCwd: string, argv: readonly string[], run: () => string): string {
  if (!observation) return run();
  const key = 'git\0' + gitObservationKey([resolve(gitCwd), argv]);
  if (observation.has(key)) {
    const known = observation.get(key);
    if (known instanceof ObservedGitFailure) throw known.error;
    return known as string;
  }
  try {
    const value = run();
    observation.set(key, value);
    return value;
  } catch (error) {
    observation.set(key, new ObservedGitFailure(error));
    throw error;
  }
}

/** Run a launch outside any observation: whatever it reads is never a memoized snapshot. */
export function withoutGitObservation<T>(launch: () => T): T {
  const previous = observation;
  observation = undefined;
  try { return launch(); } finally { observation = previous; }
}

/** A git mutation issued by this process ends what the current observation knows:
 * every later probe in the same segment reads afresh. */
export function forgetGitObservation(): void {
  observation?.clear();
}

/** Fail closed when a launch-time reread finds an observation still active. */
export function assertGitObservationInactive(label: string): true {
  if (observation) throw new Error(label + ' must reread outside a synchronous git observation [git_observation_active]');
  return true;
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
