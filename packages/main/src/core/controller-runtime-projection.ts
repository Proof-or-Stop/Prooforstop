import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { CONTROLLER_RUNTIME_PROJECTION_ARTIFACT } from './managed-artifact-descriptors.js';
import { CONFIG_FILENAMES } from './brand-paths.js';

export const CONTROLLER_RUNTIME_ASSET_PATHS = [
  '.codex/hooks.json',
  '.codex/hooks/proof-or-stop-evidence-pretool.cjs',
  '.codex/hooks/proof-or-stop-scope-pretool.cjs',
] as const;

const SCHEMA = 'proof-or-stop.controller-runtime-projection.v1' as const;
const COMMON_RECEIPT_DIR = 'proof-or-stop-controller-runtime-projections';
export const CONTROLLER_RUNTIME_PROJECTION_STORY_RECEIPT = CONTROLLER_RUNTIME_PROJECTION_ARTIFACT.path;

interface Claims {
  schemaVersion: typeof SCHEMA;
  storyId: string;
  controllerRoot: string;
  worktreeRoot: string;
  assets: Array<{ path: string; digest: string }>;
}

export function existingControllerRuntimeAssetPaths(controllerRoot: string): string[] {
  return CONTROLLER_RUNTIME_ASSET_PATHS.filter(path => {
    try {
      lstatSync(join(controllerRoot, path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Repository-owned files remain material; this never grants a projection exemption. */
export function hasRepositoryOwnedControllerAssets(args: {
  controllerRoot: string; worktreeRoot: string; configPath: string;
}): boolean {
  if (!CONFIG_FILENAMES.includes(args.configPath)) return false;
  try {
    for (const root of [args.controllerRoot, args.worktreeRoot]) {
      for (const path of [args.configPath, ...CONTROLLER_RUNTIME_ASSET_PATHS]) {
        const head = git(root, ['ls-tree', 'HEAD', '--', path]);
        const index = git(root, ['ls-files', '--stage', '--', path]);
        // Both committed ownership and the current index must agree on regular-file
        // ownership. Staging a projected file or deleting it cannot bypass receipts.
        if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(head)
          || !/^100(?:644|755) [a-f0-9]+ 0\t/.test(index)
          || head.split('\n').length !== 1 || index.split('\n').length !== 1) return false;
        if (!lstatSync(join(root, path)).isFile()) return false;
        safeRegularFile(root, join(root, path));
      }
    }
    return true;
  } catch { return false; }
}

function commonRoot(cwd: string): string {
  const raw = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

function safeRegularFile(root: string, path: string): Buffer {
  const canonicalRoot = realpathSync(root);
  const absolute = resolve(path);
  const rel = relative(canonicalRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('controller runtime projection escaped its root');
  let cursor = canonicalRoot;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`controller runtime projection refused symlink: ${cursor}`);
  }
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

function buildClaims(args: { storyId: string; controllerRoot: string; worktreeRoot: string }): Claims {
  const controllerRoot = realpathSync(args.controllerRoot);
  const worktreeRoot = realpathSync(args.worktreeRoot);
  return {
    schemaVersion: SCHEMA,
    storyId: args.storyId,
    controllerRoot,
    worktreeRoot,
    assets: existingControllerRuntimeAssetPaths(controllerRoot).map(path => ({
      path,
      digest: `sha256:${createHash('sha256').update(safeRegularFile(controllerRoot, join(controllerRoot, path))).digest('hex')}`,
    })),
  };
}

function matches(path: string, expected: Claims, root: string, gitCwd: string): boolean {
  try {
    const raw = safeRegularFile(root, path).toString('utf8');
    const parsed = JSON.parse(raw) as Claims & { signature?: unknown };
    const { signature, ...stored } = parsed;
    return JSON.stringify(stored) === JSON.stringify(expected) && verifyValidationArtifact(stored, signature, gitCwd);
  } catch { return false; }
}

function assertSafeReceiptPath(root: string, target: string, finalKind: 'file' | 'directory' = 'file'): void {
  const canonicalRoot = realpathSync(root);
  const absolute = resolve(target);
  const rel = relative(canonicalRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('controller runtime projection receipt escaped its authority root');
  let cursor = canonicalRoot;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) return;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`controller runtime projection refused symlink receipt path: ${cursor}`);
    if (cursor !== absolute && !stat.isDirectory()) throw new Error(`controller runtime projection refused non-directory receipt ancestor: ${cursor}`);
    if (cursor === absolute && finalKind === 'file' && !stat.isFile()) throw new Error(`controller runtime projection refused non-regular receipt: ${cursor}`);
    if (cursor === absolute && finalKind === 'directory' && !stat.isDirectory()) throw new Error(`controller runtime projection refused non-directory receipt path: ${cursor}`);
  }
}

function writeExclusive(root: string, path: string, record: unknown): void {
  assertSafeReceiptPath(root, path);
  mkdirSync(dirname(path), { recursive: true });
  assertSafeReceiptPath(root, dirname(path), 'directory');
  const temporary = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    linkSync(temporary, path);
    assertSafeReceiptPath(root, path);
  } finally {
    try { unlinkSync(temporary); } catch { rmSync(temporary, { force: true }); }
  }
}

export function attestControllerRuntimeProjection(args: { gitCwd: string; storyId: string; controllerRoot: string; worktreeRoot: string; storyRoot: string }): void {
  const expected = buildClaims(args);
  if (expected.assets.length === 0) return;
  const common = commonRoot(args.gitCwd);
  const commonReceipt = join(common, COMMON_RECEIPT_DIR, `${args.storyId}.json`);
  const storyReceipt = join(realpathSync(args.storyRoot), CONTROLLER_RUNTIME_PROJECTION_STORY_RECEIPT);
  const record = { ...expected, signature: signValidationArtifact(expected, args.gitCwd) };
  if (existsSync(commonReceipt)) {
    if (!matches(commonReceipt, expected, common, args.gitCwd)) throw new Error('controller runtime projection refused controller asset drift');
  } else writeExclusive(common, commonReceipt, record);
  if (existsSync(storyReceipt)) {
    if (!matches(storyReceipt, expected, args.storyRoot, args.gitCwd)) throw new Error('controller runtime projection refused Story receipt drift');
  } else writeExclusive(args.storyRoot, storyReceipt, record);
}

export function hasValidControllerRuntimeProjection(args: { gitCwd: string; storyId: string; controllerRoot: string; worktreeRoot: string; storyRoot: string }): boolean {
  try {
    const expected = buildClaims(args);
    if (expected.assets.length === 0) return false;
    const common = commonRoot(args.gitCwd);
    if (!matches(join(common, COMMON_RECEIPT_DIR, `${args.storyId}.json`), expected, common, args.gitCwd)) return false;
    if (!matches(join(realpathSync(args.storyRoot), CONTROLLER_RUNTIME_PROJECTION_STORY_RECEIPT), expected, args.storyRoot, args.gitCwd)) return false;
    return expected.assets.every(({ path }) =>
      safeRegularFile(args.controllerRoot, join(args.controllerRoot, path)).equals(safeRegularFile(args.worktreeRoot, join(args.worktreeRoot, path))),
    );
  } catch { return false; }
}

export interface ControllerRuntimeProjectionInspection {
  valid: boolean;
  reason: 'valid' | 'no-controller-assets' | 'common-receipt-invalid' | 'story-receipt-invalid' | 'asset-bytes-differ' | 'workspace-invalid';
}

/** Explain the same strict proof used by hook classification without weakening it. */
export function inspectControllerRuntimeProjection(args: { gitCwd: string; storyId: string; controllerRoot: string; worktreeRoot: string; storyRoot: string }): ControllerRuntimeProjectionInspection {
  try {
    const expected = buildClaims(args);
    if (expected.assets.length === 0) return { valid: false, reason: 'no-controller-assets' };
    const common = commonRoot(args.gitCwd);
    if (!matches(join(common, COMMON_RECEIPT_DIR, `${args.storyId}.json`), expected, common, args.gitCwd)) {
      return { valid: false, reason: 'common-receipt-invalid' };
    }
    if (!matches(join(realpathSync(args.storyRoot), CONTROLLER_RUNTIME_PROJECTION_STORY_RECEIPT), expected, args.storyRoot, args.gitCwd)) {
      return { valid: false, reason: 'story-receipt-invalid' };
    }
    const identical = expected.assets.every(({ path }) =>
      safeRegularFile(args.controllerRoot, join(args.controllerRoot, path)).equals(safeRegularFile(args.worktreeRoot, join(args.worktreeRoot, path))),
    );
    return identical ? { valid: true, reason: 'valid' } : { valid: false, reason: 'asset-bytes-differ' };
  } catch {
    return { valid: false, reason: 'workspace-invalid' };
  }
}
