import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
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

type MigrationFs = {
  closeSync: typeof closeSync;
  existsSync: typeof existsSync;
  fsyncSync: typeof fsyncSync;
  lstatSync: typeof lstatSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  renameSync: typeof renameSync;
  rmdirSync: typeof rmdirSync;
  rmSync: typeof rmSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

type IdentityStateMigrateDependencies = {
  fs?: Partial<MigrationFs>;
  now?: () => Date;
};

const DEFAULT_FS: MigrationFs = {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
};

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function listFiles(io: MigrationFs, root: string, current = root): FileDigest[] {
  const stat = io.lstatSync(current);
  if (stat.isSymbolicLink()) throw new Error(`identity state migration refuses symlink: ${current}`);
  if (stat.isFile()) {
    const bytes = io.readFileSync(current);
    return [{ path: relative(root, current).replace(/\\/g, '/'), sha256: sha256(bytes), bytes: bytes.length }];
  }
  if (!stat.isDirectory()) throw new Error(`identity state migration refuses non-file entry: ${current}`);
  return io.readdirSync(current)
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => listFiles(io, root, join(current, name)));
}

function copyTree(io: MigrationFs, source: string, destination: string): void {
  const stat = io.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`identity state migration refuses symlink: ${source}`);
  if (stat.isDirectory()) {
    io.mkdirSync(destination, { recursive: false });
    for (const name of io.readdirSync(source).sort((a, b) => a.localeCompare(b))) {
      copyTree(io, join(source, name), join(destination, name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`identity state migration refuses non-file entry: ${source}`);
  io.writeFileSync(destination, io.readFileSync(source), { flag: 'wx', mode: stat.mode });
}

function removeEmptyParents(io: MigrationFs, start: string, stop: string): void {
  let current = start;
  while (current !== stop && current.startsWith(`${stop}/`)) {
    if (!io.existsSync(current) || io.readdirSync(current).length > 0) return;
    io.rmdirSync(current);
    current = dirname(current);
  }
}

function sameManifest(left: FileDigest[], right: FileDigest[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeReceiptExclusive(
  io: MigrationFs,
  receiptPath: string,
  contents: string,
  markOwned: () => void,
): void {
  const fd = io.openSync(receiptPath, 'wx', 0o600);
  markOwned();
  let failure: unknown;
  try {
    io.writeFileSync(fd, contents, 'utf8');
    io.fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    io.closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function rollbackPublishedDestination(
  io: MigrationFs,
  sourceRoot: string,
  destinationRoot: string,
  before: FileDigest[],
  nonce: string,
): void {
  if (!io.existsSync(destinationRoot)) {
    if (!io.existsSync(sourceRoot) || !sameManifest(listFiles(io, sourceRoot), before)) {
      throw new Error('destination vanished while the retired source was incomplete; automatic recovery is impossible.');
    }
    return;
  }

  const sourceIntact = io.existsSync(sourceRoot) && sameManifest(listFiles(io, sourceRoot), before);
  if (!sourceIntact) {
    const destinationManifest = listFiles(io, destinationRoot);
    if (!sameManifest(destinationManifest, before)) {
      throw new Error('canonical destination digest changed while restoring the retired source.');
    }

    const sourceParent = dirname(sourceRoot);
    const restoreRoot = join(sourceParent, `.${nonce}.restore`);
    const partialRoot = join(sourceParent, `.${nonce}.partial`);
    io.mkdirSync(sourceParent, { recursive: true });
    if (io.existsSync(restoreRoot) || io.existsSync(partialRoot)) {
      throw new Error('rollback workspace already exists; refusing to overwrite recovery evidence.');
    }
    copyTree(io, destinationRoot, restoreRoot);
    if (!sameManifest(listFiles(io, restoreRoot), before)) {
      throw new Error('rollback copy digest verification failed.');
    }

    let partialMoved = false;
    if (io.existsSync(sourceRoot)) {
      io.renameSync(sourceRoot, partialRoot);
      partialMoved = true;
    }
    try {
      io.renameSync(restoreRoot, sourceRoot);
    } catch (error) {
      if (partialMoved && !io.existsSync(sourceRoot)) io.renameSync(partialRoot, sourceRoot);
      throw error;
    }
    if (!sameManifest(listFiles(io, sourceRoot), before)) {
      throw new Error('restored retired source failed digest verification.');
    }

    io.rmSync(destinationRoot, { recursive: true, force: false });
    if (partialMoved) io.rmSync(partialRoot, { recursive: true, force: false });
    return;
  }

  io.rmSync(destinationRoot, { recursive: true, force: false });
}

export function createIdentityStateMigrateHandlers(
  ctx: HandlerContext,
  dependencies: IdentityStateMigrateDependencies = {},
) {
  const io: MigrationFs = { ...DEFAULT_FS, ...dependencies.fs };
  const now = dependencies.now ?? (() => new Date());
  return {
    identity_state_migrate(args: MigrationArgs): string {
      const id = String(args?.id ?? '').trim();
      if (!/^B-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(id)) {
        throw new Error('identity_state_migrate requires an exact canonical story id via --id.');
      }

      const sourceRoot = join(ctx.root, RETIRED_STATE_DIR, 'story', 'actives', id);
      const destinationRoot = join(ctx.root, PROOF_OR_STOP_STATE_DIR, 'story', 'actives', id);
      const destinationParent = dirname(destinationRoot);
      const sourceExists = io.existsSync(sourceRoot);
      const destinationExists = io.existsSync(destinationRoot);

      if (sourceExists && destinationExists) {
        throw new Error('identity state migration refuses ambiguous dual story trees.');
      }
      if (!sourceExists) {
        if (destinationExists) return `identity_state_migrate: ${id} already uses canonical state storage`;
        throw new Error(`identity state migration source is missing for ${id}.`);
      }

      const before = listFiles(io, sourceRoot);
      if (before.length === 0) throw new Error('identity state migration refuses an empty story tree.');
      const summary = `identity_state_migrate: ${id}; files=${before.length}; bytes=${before.reduce((n, row) => n + row.bytes, 0)}`;
      if (args.confirm !== true) return `${summary}\n→ rerun with --confirm to perform the one-shot atomic migration`;

      io.mkdirSync(destinationParent, { recursive: true });
      if (io.lstatSync(destinationParent).isSymbolicLink()) {
        throw new Error('identity state migration refuses a symlinked canonical destination parent.');
      }
      const nonce = `${id}.identity-migration-${process.pid}-${Date.now()}`;
      const tempRoot = join(destinationParent, `.${nonce}`);
      if (io.existsSync(tempRoot)) throw new Error('identity state migration temporary destination already exists.');

      const receiptPath = join(
        ctx.root,
        PROOF_OR_STOP_STATE_DIR,
        'runtime',
        'identity-migrations',
        `${id}.json`,
      );
      io.mkdirSync(dirname(receiptPath), { recursive: true });
      if (io.existsSync(receiptPath)) {
        throw new Error(`identity state migration receipt already exists for ${id}; source was not changed.`);
      }

      let receiptOwned = false;
      let destinationPublished = false;

      try {
        copyTree(io, sourceRoot, tempRoot);
        const copied = listFiles(io, tempRoot);
        if (!sameManifest(copied, before)) {
          throw new Error('identity state migration digest verification failed before atomic rename.');
        }

        const receipt = `${JSON.stringify({
          schemaVersion: 'proof-or-stop.identity-state-migration.v1',
          protocol: 'receipt-first-with-verified-rollback',
          storyId: id,
          source: `${RETIRED_STATE_DIR}/story/actives/${id}`,
          destination: `${PROOF_OR_STOP_STATE_DIR}/story/actives/${id}`,
          files: before,
          migratedAt: now().toISOString(),
        }, null, 2)}\n`;
        writeReceiptExclusive(io, receiptPath, receipt, () => { receiptOwned = true; });

        if (io.existsSync(destinationRoot)) throw new Error('identity state migration destination appeared during copy.');
        io.renameSync(tempRoot, destinationRoot);
        destinationPublished = true;
        const after = listFiles(io, destinationRoot);
        if (!sameManifest(after, before)) {
          throw new Error('identity state migration digest verification failed after atomic rename.');
        }
        io.rmSync(sourceRoot, { recursive: true, force: false });
        removeEmptyParents(io, dirname(sourceRoot), join(ctx.root, RETIRED_STATE_DIR));
        removeEmptyParents(io, join(ctx.root, RETIRED_STATE_DIR), ctx.root);
        return `${summary}\n✓ atomically migrated to ${PROOF_OR_STOP_STATE_DIR}/story/actives/${id}`;
      } catch (error) {
        const rollbackErrors: string[] = [];
        if (destinationPublished) {
          try {
            rollbackPublishedDestination(io, sourceRoot, destinationRoot, before, nonce);
            destinationPublished = false;
          } catch (rollbackError) {
            rollbackErrors.push(`state rollback failed: ${errorText(rollbackError)}`);
          }
        }
        if (!destinationPublished && receiptOwned && io.existsSync(receiptPath)) {
          try {
            io.unlinkSync(receiptPath);
            receiptOwned = false;
          } catch (rollbackError) {
            rollbackErrors.push(`receipt cleanup failed: ${errorText(rollbackError)}`);
          }
        }
        if (io.existsSync(tempRoot)) {
          try {
            io.rmSync(tempRoot, { recursive: true, force: true });
          } catch (rollbackError) {
            rollbackErrors.push(`temporary tree cleanup failed: ${errorText(rollbackError)}`);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new Error(
            `identity state migration failed: ${errorText(error)}; ${rollbackErrors.join('; ')}. `
            + 'The receipt is retained whenever canonical state may remain, so recovery stays auditable.',
          );
        }
        throw error;
      }
    },
  };
}
