import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// A synchronous observation owns these bytes. No entry survives the outer
// callback, a thrown error, or an await. This is not an execution/PASS cache.
let observation: Map<string, string> | undefined;
export function withGitTreeObservation<T>(read: () => T): T {
  if (observation) return read();
  observation = new Map();
  try { return read(); } finally { observation = undefined; }
}

/** Only the identical standard NUL-framed tree command shares an observation.
 * Other formats and caller-specific limits keep their existing separate readers.
 * Full object names include annotated tags; symbolic refs are never memoized.
 * Git replacement objects are observed afresh on the next outer observation.
 */
export function readObservedGitTree(gitCwd: string, ref: string): string {
  const argv = ['ls-tree', '-r', '-z', ref];
  // Git also observes PATH, HOME and config-related non-GIT variables. Keep
  // the complete inherited environment in this in-memory-only key.
  const key = observation && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)
    ? JSON.stringify([resolve(gitCwd), argv, Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))])
    : undefined;
  if (key !== undefined && observation!.has(key)) return observation!.get(key)!;
  const raw = execFileSync('git', argv, {
    cwd: gitCwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    // Preserve both existing readers' limit. Do not widen a bounded caller.
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (key !== undefined) observation!.set(key, raw);
  return raw;
}
