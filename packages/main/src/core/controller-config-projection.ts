import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { CONTROLLER_CONFIG_PROJECTION_ARTIFACT } from './managed-artifact-descriptors.js';

const SCHEMA = 'proof-or-stop.controller-config-projection.v1' as const;
const RECEIPT_DIR = 'proof-or-stop-controller-config-projections';
const STORY_RECEIPT_RELATIVE = CONTROLLER_CONFIG_PROJECTION_ARTIFACT.path;

interface ProjectionClaims {
  schemaVersion: typeof SCHEMA;
  storyId: string;
  configPath: string;
  controllerRoot: string;
  worktreeRoot: string;
  configDigest: string;
}

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!raw) throw new Error('controller configuration projection requires a Git common directory');
  return realpathSync(isAbsolute(raw) ? raw : resolve(gitCwd, raw));
}

function receiptPath(gitCwd: string, storyId: string): string {
  if (!/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(storyId)) throw new Error('controller configuration projection receipt refused malformed Story id');
  return join(gitCommonDir(gitCwd), RECEIPT_DIR, `${storyId}.json`);
}

export function controllerConfigDigest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function claims(args: {
  gitCwd: string;
  storyId: string;
  configPath: string;
  controllerRoot: string;
  worktreeRoot: string;
  storyRoot: string;
  configBytes: Buffer;
}): ProjectionClaims {
  return {
    schemaVersion: SCHEMA,
    storyId: args.storyId,
    configPath: args.configPath,
    controllerRoot: realpathSync(args.controllerRoot),
    worktreeRoot: realpathSync(args.worktreeRoot),
    configDigest: controllerConfigDigest(args.configBytes),
  };
}

function existsAtHead(gitCwd: string, path: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${relative(gitCwd, path).replaceAll('\\', '/')}`], {
      cwd: gitCwd, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function assertSafeReceiptPath(root: string, target: string, finalKind: 'file' | 'directory' = 'file'): void {
  const canonicalRoot = realpathSync(root);
  const absolute = resolve(target);
  const rel = relative(canonicalRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('controller projection receipt escaped its authority root');
  let cursor = canonicalRoot;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) return;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`controller projection refused symlink receipt path: ${cursor}`);
    if (cursor !== absolute && !stat.isDirectory()) throw new Error(`controller projection refused non-directory receipt ancestor: ${cursor}`);
    if (cursor === absolute && finalKind === 'file' && !stat.isFile()) throw new Error(`controller projection refused non-regular receipt: ${cursor}`);
    if (cursor === absolute && finalKind === 'directory' && !stat.isDirectory()) throw new Error(`controller projection refused non-directory receipt path: ${cursor}`);
  }
}

function writeNoClobber(root: string, target: string, record: unknown): void {
  assertSafeReceiptPath(root, target);
  mkdirSync(dirname(target), { recursive: true });
  assertSafeReceiptPath(root, dirname(target), 'directory');
  const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    linkSync(temporary, target);
    assertSafeReceiptPath(root, target);
  } finally {
    try { unlinkSync(temporary); } catch { rmSync(temporary, { force: true }); }
  }
}

function matchesStored(root: string, path: string, expected: ProjectionClaims, gitCwd: string): boolean {
  try {
    assertSafeReceiptPath(root, path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: string;
    try { raw = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
    const parsed = JSON.parse(raw) as ProjectionClaims & { signature?: unknown };
    const { signature, ...stored } = parsed;
    return JSON.stringify(stored) === JSON.stringify(expected)
      && verifyValidationArtifact(stored, signature, gitCwd);
  } catch {
    return false;
  }
}

/** Pin the first authorized controller bytes. An existing receipt is immutable. */
export function attestControllerConfigProjection(args: Parameters<typeof claims>[0]): void {
  const expected = claims(args);
  const commonRoot = gitCommonDir(args.gitCwd);
  const storyRoot = realpathSync(args.storyRoot);
  const target = join(commonRoot, RECEIPT_DIR, `${args.storyId}.json`);
  const storyTarget = join(storyRoot, STORY_RECEIPT_RELATIVE);
  if (existsSync(target)) {
    if (!matchesStored(commonRoot, target, expected, args.gitCwd)) throw new Error('controller projection refused configuration drift from the signed initial projection');
    if (existsSync(storyTarget)) {
      if (!matchesStored(storyRoot, storyTarget, expected, args.gitCwd)) throw new Error('controller projection refused invalid Story-bound configuration receipt');
      return;
    }
    if (existsAtHead(args.gitCwd, storyTarget)) throw new Error('controller projection refused deleted Story-bound configuration receipt');
    const record = { ...expected, signature: signValidationArtifact(expected, args.gitCwd) };
    writeNoClobber(storyRoot, storyTarget, record);
    return;
  }
  if (existsSync(storyTarget) || existsAtHead(args.gitCwd, storyTarget)) {
    throw new Error('controller projection refused missing initial configuration receipt; ordinary bootstrap cannot reissue it');
  }
  const record = { ...expected, signature: signValidationArtifact(expected, args.gitCwd) };
  try {
    writeNoClobber(commonRoot, target, record);
  } catch (error) {
    if (!existsSync(target) || !matchesStored(commonRoot, target, expected, args.gitCwd)) throw error;
  }
  writeNoClobber(storyRoot, storyTarget, record);
}

/** Verify current bytes against the immutable first-projection receipt. */
export function hasValidControllerConfigProjection(args: Parameters<typeof claims>[0]): boolean {
  try {
    const expected = claims(args);
    const commonRoot = gitCommonDir(args.gitCwd);
    const storyRoot = realpathSync(args.storyRoot);
    return matchesStored(commonRoot, receiptPath(args.gitCwd, args.storyId), expected, args.gitCwd)
      && matchesStored(storyRoot, join(storyRoot, STORY_RECEIPT_RELATIVE), expected, args.gitCwd);
  } catch {
    return false;
  }
}
