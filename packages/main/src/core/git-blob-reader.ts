import { execFileSync } from 'node:child_process';

export const BOUNDED_GIT_BLOB_MAX_BYTES = 16 * 1024 * 1024;

export type GitBlobReadResult =
  | { status: 'ok'; content: Buffer; mode: string; objectId: string }
  | { status: 'missing' }
  | { status: 'error'; reason: string };

const READ_ONLY_GIT_HARDENING = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
] as const;

function errorText(error: unknown): string {
  const candidate = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  return String(candidate?.stderr || candidate?.stdout || candidate?.message || error).trim();
}

/**
 * Read one exact path from a Git tree without conflating absence with an I/O or
 * size failure. Tree lookup resolves the blob identity first; the bounded
 * cat-file read then consumes only that immutable object. Callers must handle
 * `error` conservatively. Only `missing` is authoritative absence.
 */
export function readGitBlobAt(
  gitCwd: string,
  ref: string,
  path: string,
  maxBytes = BOUNDED_GIT_BLOB_MAX_BYTES,
): GitBlobReadResult {
  let record: Buffer;
  try {
    record = execFileSync('git', [...READ_ONLY_GIT_HARDENING, 'ls-tree', '-z', ref, '--', path], {
      cwd: gitCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    return { status: 'error', reason: `git tree lookup failed for ${ref}:${path}: ${errorText(error)}` };
  }
  if (record.length === 0) return { status: 'missing' };
  const nul = record.indexOf(0);
  const row = record.subarray(0, nul >= 0 ? nul : record.length);
  const tab = row.indexOf(0x09);
  if (tab < 0) return { status: 'error', reason: `git tree lookup returned malformed metadata for ${ref}:${path}` };
  const [mode, type, objectId] = row.subarray(0, tab).toString('utf8').split(' ');
  if (!mode || type !== 'blob' || !/^[a-f0-9]{40,64}$/.test(objectId ?? '')) {
    return { status: 'error', reason: `git tree lookup did not resolve a blob for ${ref}:${path}` };
  }
  try {
    const content = execFileSync('git', [...READ_ONLY_GIT_HARDENING, 'cat-file', 'blob', objectId], {
      cwd: gitCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: maxBytes,
    });
    return { status: 'ok', content, mode, objectId };
  } catch (error) {
    return { status: 'error', reason: `git blob read failed for ${ref}:${path}: ${errorText(error)}` };
  }
}
