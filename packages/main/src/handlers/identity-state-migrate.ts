import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import type { HandlerContext } from './context.js';

const RETIRED_STATE_DIR = ['.', 'lat', 'tice'].join('');

type MigrationArgs = {
  id: string;
  confirm?: boolean;
};

type FileDigest = { path: string; sha256: string; bytes: number };

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function listFiles(root: string, current = root): FileDigest[] {
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`identity state migration refuses symlink: ${current}`);
  if (stat.isFile()) {
    const bytes = readFileSync(current);
    return [{ path: relative(root, current).replace(/\\/g, '/'), sha256: sha256(bytes), bytes: bytes.length }];
  }
  if (!stat.isDirectory()) throw new Error(`identity state migration refuses non-file entry: ${current}`);
  return readdirSync(current)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => listFiles(root, join(current, name)));
}

function copyTree(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`identity state migration refuses symlink: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: false });
    for (const name of readdirSync(source).sort((a, b) => a.localeCompare(b))) {
      copyTree(join(source, name), join(destination, name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`identity state migration refuses non-file entry: ${source}`);
  writeFileSync(destination, readFileSync(source), { flag: 'wx', mode: stat.mode });
}

function removeEmptyParents(start: string, stop: string): void {
  let current = start;
  while (current !== stop && current.startsWith(`${stop}/`)) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

export function createIdentityStateMigrateHandlers(ctx: HandlerContext) {
  return {
    identity_state_migrate(args: MigrationArgs): string {
      const id = String(args?.id ?? '').trim();
      if (!/^B-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(id)) {
        throw new Error('identity_state_migrate requires an exact canonical story id via --id.');
      }

      const sourceRoot = join(ctx.root, RETIRED_STATE_DIR, 'story', 'actives', id);
      const destinationRoot = join(ctx.root, PROOF_OR_STOP_STATE_DIR, 'story', 'actives', id);
      const destinationParent = dirname(destinationRoot);
      const sourceExists = existsSync(sourceRoot);
      const destinationExists = existsSync(destinationRoot);

      if (sourceExists && destinationExists) {
        throw new Error('identity state migration refuses ambiguous dual story trees.');
      }
      if (!sourceExists) {
        if (destinationExists) return `identity_state_migrate: ${id} already uses canonical state storage`;
        throw new Error(`identity state migration source is missing for ${id}.`);
      }

      const before = listFiles(sourceRoot);
      if (before.length === 0) throw new Error('identity state migration refuses an empty story tree.');
      const summary = `identity_state_migrate: ${id}; files=${before.length}; bytes=${before.reduce((n, row) => n + row.bytes, 0)}`;
      if (args.confirm !== true) return `${summary}\n→ rerun with --confirm to perform the one-shot atomic migration`;

      mkdirSync(destinationParent, { recursive: true });
      if (lstatSync(destinationParent).isSymbolicLink()) {
        throw new Error('identity state migration refuses a symlinked canonical destination parent.');
      }
      const tempRoot = join(destinationParent, `.${id}.identity-migration-${process.pid}-${Date.now()}`);
      if (existsSync(tempRoot)) throw new Error('identity state migration temporary destination already exists.');

      try {
        copyTree(sourceRoot, tempRoot);
        const copied = listFiles(tempRoot);
        if (JSON.stringify(copied) !== JSON.stringify(before)) {
          throw new Error('identity state migration digest verification failed before atomic rename.');
        }
        if (existsSync(destinationRoot)) throw new Error('identity state migration destination appeared during copy.');
        renameSync(tempRoot, destinationRoot);
        const after = listFiles(destinationRoot);
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          throw new Error('identity state migration digest verification failed after atomic rename.');
        }
        rmSync(sourceRoot, { recursive: true, force: false });
        removeEmptyParents(dirname(sourceRoot), join(ctx.root, RETIRED_STATE_DIR));
        removeEmptyParents(join(ctx.root, RETIRED_STATE_DIR), ctx.root);

        const receiptPath = join(
          ctx.root,
          PROOF_OR_STOP_STATE_DIR,
          'runtime',
          'identity-migrations',
          `${id}.json`,
        );
        mkdirSync(dirname(receiptPath), { recursive: true });
        writeFileSync(receiptPath, `${JSON.stringify({
          schemaVersion: 'proof-or-stop.identity-state-migration.v1',
          storyId: id,
          source: `${RETIRED_STATE_DIR}/story/actives/${id}`,
          destination: `${PROOF_OR_STOP_STATE_DIR}/story/actives/${id}`,
          files: before,
          migratedAt: new Date().toISOString(),
        }, null, 2)}\n`, { flag: 'wx' });
        return `${summary}\n✓ atomically migrated to ${PROOF_OR_STOP_STATE_DIR}/story/actives/${id}`;
      } catch (error) {
        if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
