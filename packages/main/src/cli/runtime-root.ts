import { createHash, randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { hasProjectConfigFile, isManagedGlobalThinRoot, loadConfig, pickProjectConfigPath } from '../core/config.js';
import { gitProbe } from '../core/git-probe.js';
import { readBrandEnv } from '../core/brand-env.js';
import { StoryStore } from '../core/store.js';
import { attestControllerConfigProjection } from '../core/controller-config-projection.js';
import { attestControllerRuntimeProjection, existingControllerRuntimeAssetPaths, hasRepositoryOwnedControllerAssets } from '../core/controller-runtime-projection.js';

export function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  const envRoot = readBrandEnv('PROJECT_ROOT');
  if (envRoot) return envRoot;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(dir)) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  const commonDir = gitProbe('git rev-parse --git-common-dir');
  if (commonDir.ok) {
    const cd = commonDir.output;
    if (cd !== '.git' && !cd.endsWith('/.git') && !cd.endsWith('\\.git')) {
      const wtList = gitProbe('git worktree list --porcelain');
      if (wtList.ok) {
        return wtList.output.split('\n')[0]?.replace('worktree ', '').trim() || process.cwd();
      }
    }
  }
  return process.cwd();
}

export function resolveMainRootFromWorktreeRoot(root: string): string | null {
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return null;
    const content = readFileSync(dotGit, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+)$/i);
    if (!m) return null;
    const gitdir = m[1].trim();
    const absGitdir = gitdir.startsWith('/') ? gitdir : join(root, gitdir);
    const marker = `${join('.git', 'worktrees')}`;
    const normalized = absGitdir.replace(/\\/g, '/');
    const markerNormalized = marker.replace(/\\/g, '/');
    const idx = normalized.indexOf(`/${markerNormalized}/`);
    if (idx === -1) return null;
    return normalized.slice(0, idx);
  } catch {
    return null;
  }
}

export function resolveRootForCommand(cmd: string | undefined, explicit?: string): string {
  const root = resolveRoot(explicit);
  if (cmd !== 'story_discard') return root;
  return resolveMainRootFromWorktreeRoot(root) || root;
}

const MAX_PROJECTED_STORY_FILES = 2_048;
const MAX_PROJECTED_STORY_BYTES = 32 * 1024 * 1024;

function canonical(path: string): string {
  return realpathSync(path);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function assertNoSymlinkPath(root: string, candidate: string, allowMissingTail: boolean): void {
  const absolute = resolve(candidate);
  if (!inside(root, absolute)) throw new Error(`controller projection refused escaping path: ${candidate}`);
  let cursor = root;
  for (const segment of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) {
      if (allowMissingTail) return;
      throw new Error(`controller projection refused missing source path: ${cursor}`);
    }
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`controller projection refused symlink path component: ${cursor}`);
  }
}

function readRegularNoFollow(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`controller projection refused unsafe symlink or non-file: ${path}`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return readFileSync(fd); } finally { closeSync(fd); }
}

function copyTreeNoFollow(sourceRoot: string, targetRoot: string): void {
  let files = 0;
  let bytes = 0;
  const visit = (source: string, target: string): void => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`controller projection refused symlink: ${source}`);
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(source).sort()) visit(join(source, entry), join(target, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`controller projection refused non-regular Story artifact: ${source}`);
    files += 1;
    bytes += stat.size;
    if (files > MAX_PROJECTED_STORY_FILES || bytes > MAX_PROJECTED_STORY_BYTES) {
      throw new Error('controller projection refused oversized Story snapshot');
    }
    writeFileSync(target, readRegularNoFollow(source), { flag: 'wx', mode: stat.mode & 0o777 });
  };
  visit(sourceRoot, targetRoot);
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function pathExistsAtHead(cwd: string, repositoryRelativePath: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${repositoryRelativePath.replaceAll('\\', '/')}`], {
      cwd, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function pathIsTracked(cwd: string, repositoryRelativePath: string): boolean {
  return gitText(cwd, ['ls-files', '--', repositoryRelativePath.replaceAll('\\', '/')]).length > 0;
}

function installConfigNoClobber(worktreeRoot: string, targetConfig: string, configBytes: Buffer): Buffer {
  assertNoSymlinkPath(worktreeRoot, targetConfig, true);
  if (existsSync(targetConfig)) {
    const existing = readRegularNoFollow(targetConfig);
    if (!existing.equals(configBytes)) throw new Error('controller projection refused mismatched worktree configuration');
    return existing;
  }
  const targetRelative = relative(worktreeRoot, targetConfig);
  if (pathIsTracked(worktreeRoot, targetRelative) || pathExistsAtHead(worktreeRoot, targetRelative)) {
    throw new Error('controller projection refused missing tracked worktree configuration; restore the branch-local file from Git');
  }
  const tempConfig = `${targetConfig}.projection-${randomBytes(6).toString('hex')}`;
  try {
    mkdirSync(dirname(targetConfig), { recursive: true });
    writeFileSync(tempConfig, configBytes, { flag: 'wx' });
    linkSync(tempConfig, targetConfig);
    unlinkSync(tempConfig);
    return configBytes;
  } catch (error) {
    rmSync(tempConfig, { force: true });
    throw error;
  }
}

function projectGlobalThinRuntimeAssets(controllerRoot: string, worktreeRoot: string, storyId: string, storyRoot: string): void {
  if (!isManagedGlobalThinRoot(controllerRoot)) return;
  const assetPaths = existingControllerRuntimeAssetPaths(controllerRoot);
  for (const relativePath of assetPaths) {
    const source = join(controllerRoot, relativePath);
    installConfigNoClobber(worktreeRoot, join(worktreeRoot, relativePath), readRegularNoFollow(source));
  }
  if (assetPaths.length > 0) {
    attestControllerRuntimeProjection({ gitCwd: worktreeRoot, storyId, controllerRoot, worktreeRoot, storyRoot });
  }
}

/**
 * Bootstrap controller-only assets into the explicitly registered Story worktree.
 * The controller copy is read once; the projected worktree becomes the only writer.
 */
export function projectControllerAssetsIntoStoryWorktree(input: {
  controllerRoot: string;
  worktreeRoot: string;
  storyId: string;
}): { storyRoot: string; configDigest: string } {
  if (!/^B-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.storyId)) throw new Error('controller projection refused malformed Story id');
  const controllerRoot = canonical(input.controllerRoot);
  const worktreeRoot = canonical(input.worktreeRoot);
  if (controllerRoot === worktreeRoot) throw new Error('controller projection requires a distinct linked worktree');
  const expectedBranch = `refs/heads/story/${input.storyId}`;
  const entries = gitText(controllerRoot, ['worktree', 'list', '--porcelain']).split(/\n\n+/).map(block => {
    const lines = block.split('\n');
    return { path: lines.find(line => line.startsWith('worktree '))?.slice(9), branch: lines.find(line => line.startsWith('branch '))?.slice(7) };
  });
  const registered = entries.find(entry => entry.branch === expectedBranch);
  if (!registered?.path || canonical(registered.path) !== worktreeRoot || gitText(worktreeRoot, ['rev-parse', '--show-toplevel']) !== worktreeRoot) {
    throw new Error(`controller projection refused unsigned or unregistered linked worktree for ${input.storyId}`);
  }
  const controllerCommon = canonical(resolve(controllerRoot, gitText(controllerRoot, ['rev-parse', '--git-common-dir'])));
  const worktreeCommon = canonical(resolve(worktreeRoot, gitText(worktreeRoot, ['rev-parse', '--git-common-dir'])));
  if (controllerCommon !== worktreeCommon || gitText(worktreeRoot, ['symbolic-ref', '-q', 'HEAD']) !== expectedBranch) {
    throw new Error(`controller projection refused linked worktree authority mismatch for ${input.storyId}`);
  }

  const configRef = pickProjectConfigPath(controllerRoot);
  if (!configRef) throw new Error('controller projection requires an explicit controller configuration');
  const configPath = canonical(configRef.path);
  if (!inside(controllerRoot, configPath) || dirname(configPath) !== controllerRoot) throw new Error('controller projection refused escaping configuration source');
  const configBytes = readRegularNoFollow(configRef.path);
  const config = loadConfig(controllerRoot);
  const unresolvedSourceStoryRoot = new StoryStore(controllerRoot, { trustedStoryDir: config.storyDir }).storyDirPath(input.storyId);
  assertNoSymlinkPath(controllerRoot, unresolvedSourceStoryRoot, false);
  const sourceStoryRoot = canonical(unresolvedSourceStoryRoot);
  const storyRelative = relative(controllerRoot, sourceStoryRoot);
  const targetStoryRoot = resolve(worktreeRoot, storyRelative);
  if (!inside(worktreeRoot, targetStoryRoot)) throw new Error('controller projection refused escaping Story destination');
  assertNoSymlinkPath(worktreeRoot, targetStoryRoot, true);
  const targetConfig = join(worktreeRoot, configRef.filename);
  const repositoryOwnedAssets = pickProjectConfigPath(worktreeRoot)?.filename === configRef.filename
    && hasRepositoryOwnedControllerAssets({ controllerRoot, worktreeRoot, configPath: configRef.filename });
  if (repositoryOwnedAssets && loadConfig(worktreeRoot).storyDir !== config.storyDir) {
    throw new Error('controller projection refused differing repository-owned Story directories');
  }

  const attestUntrackedConfig = (): void => {
    if (pathIsTracked(controllerRoot, configRef.filename) || pathIsTracked(worktreeRoot, configRef.filename)) return;
    attestControllerConfigProjection({
      gitCwd: worktreeRoot,
      storyId: input.storyId,
      configPath: configRef.filename,
      controllerRoot,
      worktreeRoot,
      storyRoot: targetStoryRoot,
      configBytes,
    });
  };

  const prepareAssets = (): Buffer => {
    // A harness may create its Story only after creating the linked branch.
    // Copy that missing Story without replacing repository-owned material.
    if (repositoryOwnedAssets) return readRegularNoFollow(targetConfig);
    attestUntrackedConfig();
    const installed = installConfigNoClobber(worktreeRoot, targetConfig, configBytes);
    projectGlobalThinRuntimeAssets(controllerRoot, worktreeRoot, input.storyId, targetStoryRoot);
    return installed;
  };

  if (existsSync(targetStoryRoot)) {
    if (!lstatSync(targetStoryRoot).isDirectory() || lstatSync(targetStoryRoot).isSymbolicLink()) throw new Error('controller projection refused unsafe existing Story destination');
    const existingConfig = prepareAssets();
    return { storyRoot: targetStoryRoot, configDigest: createHash('sha256').update(existingConfig).digest('hex') };
  }
  if (pathExistsAtHead(worktreeRoot, storyRelative)) {
    throw new Error('controller projection refused missing branch-local authoritative Story; restore it from the Story branch instead of the stale controller copy');
  }
  const tempStoryRoot = `${targetStoryRoot}.projection-${randomBytes(6).toString('hex')}`;
  try {
    mkdirSync(dirname(targetStoryRoot), { recursive: true });
    copyTreeNoFollow(sourceStoryRoot, tempStoryRoot);
    renameSync(tempStoryRoot, targetStoryRoot);
    const installedConfig = prepareAssets();
    return { storyRoot: targetStoryRoot, configDigest: createHash('sha256').update(installedConfig).digest('hex') };
  } catch (error) {
    rmSync(tempStoryRoot, { recursive: true, force: true });
    rmSync(targetStoryRoot, { recursive: true, force: true });
    throw error;
  }
}
