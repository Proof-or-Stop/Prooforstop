import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { join, resolve } from 'node:path';

/** Availability limits, not authorization to omit part of a declared tree. */
export const VALIDATION_INPUT_LIMITS = Object.freeze({ entries: 4096, depth: 64, bytes: 64 * 1024 * 1024 });
export interface ValidationInputSnapshot { path: string; target: string; mode: number; digest: string }
const stamp = (s: BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode].join(':');

/** Every call rereads bytes. Any incomplete traversal refuses the whole snapshot. */
export function snapshotValidationExecutionInputs(cwd: string, inputs: string[]): ValidationInputSnapshot[] {
  let entries = 0;
  let bytes = 0;
  // Only duplicate regular-file reads within this one snapshot may be shared.
  const files = new Map<string, { stamp: string; digest: string }>();
  const visit = (path: string, ancestors: Set<string>, depth: number): ValidationInputSnapshot => {
    if (++entries > VALIDATION_INPUT_LIMITS.entries || depth > VALIDATION_INPUT_LIMITS.depth) throw new Error('execution input traversal limit');
    const requested = resolve(path);
    const linkBefore = lstatSync(requested, { bigint: true });
    const actual = realpathSync(requested);
    const before = statSync(actual, { bigint: true });
    const expected = stamp(before);
    const stable = (): void => {
      if (realpathSync(requested) !== actual || stamp(lstatSync(requested, { bigint: true })) !== stamp(linkBefore)
        || stamp(statSync(actual, { bigint: true })) !== expected) throw new Error('execution input changed during snapshot');
    };
    let digest: string;
    if (before.isFile()) {
      const memo = files.get(actual);
      if (memo?.stamp === expected) {
        digest = memo.digest;
      } else {
        if (before.size > BigInt(VALIDATION_INPUT_LIMITS.bytes - bytes)) throw new Error('execution input byte limit');
        // NONBLOCK prevents a file-to-FIFO swap from hanging open; NOFOLLOW
        // rejects a replaced leaf link. The descriptor must still be regular.
        const fd = openSync(actual, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd, { bigint: true });
          if (!opened.isFile() || stamp(opened) !== expected) throw new Error('execution input replaced before read');
          const hash = createHash('sha256');
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            const count = readSync(fd, buffer, 0, Math.min(buffer.length, VALIDATION_INPUT_LIMITS.bytes - bytes + 1), null);
            if (count === 0) break;
            bytes += count;
            if (bytes > VALIDATION_INPUT_LIMITS.bytes) throw new Error('execution input byte limit');
            hash.update(buffer.subarray(0, count));
          }
          if (stamp(fstatSync(fd, { bigint: true })) !== expected) throw new Error('execution input changed during read');
          digest = hash.digest('hex');
          files.set(actual, { stamp: expected, digest });
        } finally { closeSync(fd); }
      }
    } else if (before.isDirectory()) {
      if (ancestors.has(actual)) throw new Error('execution input ancestor cycle');
      const next = new Set(ancestors); next.add(actual);
      const names: string[] = [];
      const dir = opendirSync(actual);
      try {
        for (;;) {
          const entry = dir.readSync();
          if (!entry) break;
          if (entries + names.length + 1 > VALIDATION_INPUT_LIMITS.entries) throw new Error('execution input traversal limit');
          names.push(entry.name);
        }
      } finally { dir.closeSync(); }
      const children = names.sort().map(name => ({ name, input: visit(join(actual, name), next, depth + 1) }));
      digest = createHash('sha256').update(JSON.stringify(children)).digest('hex');
    } else {
      throw new Error('unsupported execution input node');
    }
    stable();
    return { path: requested, target: actual, mode: Number(before.mode), digest };
  };
  return inputs.map(path => visit(resolve(cwd, path), new Set(), 0));
}
