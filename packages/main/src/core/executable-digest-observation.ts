import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';

// Only a synchronous identity calculation owns these bytes. Never retain them
// across a launch, publication, promise continuation, or separate observation.
let observation: Map<string, string> | undefined;
export function withExecutableDigestObservation<T>(read: () => T): T {
  const previous = observation;
  observation = new Map();
  try { return read(); } finally { observation = previous; }
}

export function readObservedExecutableDigest(file: string): string {
  const canonical = realpathSync(file);
  const known = observation?.get(canonical);
  if (known !== undefined) return known;
  const digest = createHash('sha256').update(readFileSync(canonical)).digest('hex');
  observation?.set(canonical, digest);
  return digest;
}
