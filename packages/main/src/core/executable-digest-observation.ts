import { realpathSync } from 'node:fs';
import { statValidatedFileDigest } from './stat-validated-digest.js';

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
  const digest = statValidatedFileDigest(canonical);
  observation?.set(canonical, digest);
  return digest;
}
