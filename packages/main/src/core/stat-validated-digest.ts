import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

/**
 * Process-local SHA-256 of a file's bytes, reused only while the file's full
 * stat identity (device, inode, size, mtime and ctime in nanoseconds) is
 * unchanged. Any write, replacement or metadata change moves ctime, so the
 * next call re-reads the bytes; unchanged files are not hashed again.
 */
const digests = new Map<string, { identity: string; digest: string }>();

function statIdentity(path: string): string {
  const st = statSync(path, { bigint: true });
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

export function statValidatedFileDigest(path: string): string {
  const identity = statIdentity(path);
  const known = digests.get(path);
  if (known && known.identity === identity) return known.digest;
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  // Cache only if nothing changed while the bytes were read.
  if (statIdentity(path) === identity) digests.set(path, { identity, digest });
  else digests.delete(path);
  return digest;
}
