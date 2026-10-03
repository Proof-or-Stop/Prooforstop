import { observedGit, readObservedGitTree } from './git-tree-observation.js';
/** Process-local memo of immutable Git bytes, never filtered Story evidence. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, existsSync, readFileSync, statSync, lstatSync, readdirSync, accessSync, constants } from 'node:fs';
import { join, dirname, basename, isAbsolute, resolve, sep, delimiter } from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024;
/**
 * Interactive/identity variables that cannot change what `git ls-tree` or a
 * two-commit `git diff --name-status` prints (the same set git-ref-witness-memo
 * and git-object-read-memo treat as inert). Agent hosts set GIT_EDITOR on every
 * process, which disabled this memo for every gate: story_advance REVIEW reran
 * the same Story diff once per pinned receipt (run 17).
 */
const INERT_GIT_ENV = new Set([
  'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
]);
const MAX_ENTRIES = 128;
interface MemoEntry { raw: string; bytes: number; }
const treeMemo = new Map<string, MemoEntry>();
const diffMemo = new Map<string, MemoEntry>();
let memoBytes = 0;
function git(cwd: string, args: string[], input?: string): string {
  const run = () => execFileSync('git', args, {
    cwd, input, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
  // Only input-free read-only probes share a synchronous observation.
  return input === undefined ? observedGit(cwd, args, run) : run();
}
function clear(): void { treeMemo.clear(); diffMemo.clear(); memoBytes = 0; }
function forget(map: Map<string, MemoEntry>, key: string): void {
  const entry = map.get(key);
  if (entry) { memoBytes -= entry.bytes; map.delete(key); }
}
function remember(map: Map<string, MemoEntry>, key: string, raw: string): void {
  forget(map, key);
  const bytes = Buffer.byteLength(raw);
  if (bytes > MAX_BYTES) return;
  while (memoBytes + bytes > MAX_BYTES || treeMemo.size + diffMemo.size >= MAX_ENTRIES) {
    const victim = treeMemo.size ? treeMemo : diffMemo;
    const oldest = victim.keys().next().value;
    if (oldest === undefined) break;
    forget(victim, oldest);
  }
  map.set(key, { raw, bytes }); memoBytes += bytes;
}

// Unknown configuration is deliberately uncacheable. Includes, diff drivers,
// attributes files, alternate object handling, and platform extensions require
// a separate bounded proof before joining this allowlist.
const SAFE_CONFIG_KEYS = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare',
  'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode',
  'user.name', 'user.email', 'init.defaultbranch', 'core.hookspath',
  'pull.rebase',
]);
function isSafeConfigKey(key: string): boolean {
  // These namespaces are not consulted by built-in tree/diff reads. Filters
  // require an effective attribute, which the live attribute probe rejects.
  return SAFE_CONFIG_KEYS.has(key) || /^(?:alias|credential|filter|remote|branch)\./.test(key);
}
interface AuthorityContext {
  environment: string;
  root: string;
  gitDir: string;
  commonDir: string;
  marker: string;
  configPaths: string[];
  attributePaths: string[];
  indexPath: string;
  configIdentity?: string;
  configValue?: string;
  attributesIdentity?: string;
  attributesSafe?: boolean;
}
const authorities = new Map<string, AuthorityContext>();
const MAX_AUTHORITY_BYTES = 64 * 1024 * 1024;

// Read bytes rather than only mtime/size: same-size edits with restored timestamps
// must invalidate the probe. Missing candidates are identities too. Resolving
// the nearest existing parent detects symlink-parent changes for missing paths.
function fileIdentity(path: string, budget?: { bytes: number }): string {
  let ancestor = path;
  const missing: string[] = [];
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('unresolvable authority path');
      missing.unshift(basename(ancestor)); ancestor = parent;
    }
  }
  const resolved = realpathSync(ancestor);
  if (missing.length) return JSON.stringify([path, resolved, 'missing', missing]);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_AUTHORITY_BYTES) throw new Error('unbounded authority file');
  if (budget) {
    budget.bytes += stat.size;
    if (budget.bytes > MAX_AUTHORITY_BYTES) throw new Error('authority snapshot exceeds its byte budget');
  }
  const bytes = readFileSync(path);
  if (bytes.length > MAX_AUTHORITY_BYTES) throw new Error('unbounded authority file');
  return JSON.stringify([path, resolved, stat.dev, stat.ino, createHash('sha256').update(bytes).digest('hex')]);
}
function identities(paths: string[]): string {
  const budget = { bytes: 0 };
  return createHash('sha256').update([...new Set(paths)].sort().map(path => fileIdentity(path, budget)).join('\0')).digest('hex');
}
function markerIdentity(path: string): string {
  const stat = lstatSync(path);
  return stat.isDirectory() ? JSON.stringify([realpathSync(path), stat.dev, stat.ino, 'directory']) : fileIdentity(path);
}
function executableIdentity(cwd: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = resolve(cwd, directory || '.', 'git');
    try {
      accessSync(candidate, constants.X_OK);
      const stat = statSync(candidate, { bigint: true });
      if (stat.isFile()) return JSON.stringify([realpathSync(candidate), String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
    } catch { /* Continue the actual PATH search. */ }
  }
  throw new Error('Git executable cannot be identified');
}
function authorityContext(cwd: string): AuthorityContext | undefined {
  if (Object.keys(process.env).some(key => key.startsWith('GIT_') && !INERT_GIT_ENV.has(key) && process.env[key] !== undefined)) return undefined;
  // Discovery commands return newline-delimited paths. Do not mistake an
  // embedded newline in a routing input for two independent authority files.
  if ([cwd, process.env.PATH, process.env.HOME, process.env.XDG_CONFIG_HOME].some(value => value && /[\r\n\0]/.test(value))) return undefined;
  // Relative PATH entries are resolved in the Git child cwd.
  try {
    const environment = JSON.stringify([executableIdentity(cwd), process.env.PATH, process.env.HOME, process.env.XDG_CONFIG_HOME, process.cwd()]);
    const previous = authorities.get(cwd);
    if (previous?.environment === environment && JSON.stringify([markerIdentity(join(previous.root, '.git')), fileIdentity(join(previous.gitDir, 'commondir'))]) === previous.marker) return previous;
    // A new executable/discovery context can change Git interpretation even
    // when its configuration bytes and object IDs happen to match.
    clear();
    const roots = git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']).replace(/\n$/, '').split('\n');
    if (roots.length !== 3 || roots.some(path => !isAbsolute(path))) return undefined;
    const [root, gitDir, commonDir] = roots;
    // Non-root cwd can acquire a nearer nested .git between calls. Keep that
    // less common path authoritative rather than caching Git discovery.
    if (realpathSync(root) !== cwd) return undefined;
    const paths = (name: string): string[] => {
      const values = git(cwd, ['var', name]).replace(/\n$/, '').split('\n');
      if (!values.length || values.some(path => !isAbsolute(path))) throw new Error('unbounded Git authority paths');
      return values;
    };
    const value: AuthorityContext = {
      environment, root, gitDir, commonDir, marker: JSON.stringify([markerIdentity(join(root, '.git')), fileIdentity(join(gitDir, 'commondir'))]),
      configPaths: [...paths('GIT_CONFIG_SYSTEM'), ...paths('GIT_CONFIG_GLOBAL'), join(gitDir, 'config'), join(commonDir, 'config'), join(gitDir, 'config.worktree'), join(commonDir, 'config.worktree')],
      attributePaths: [...paths('GIT_ATTR_SYSTEM'), ...paths('GIT_ATTR_GLOBAL'), join(gitDir, 'info/attributes'), join(commonDir, 'info/attributes')],
      indexPath: join(gitDir, 'index'),
    };
    if (authorities.size >= 128) authorities.delete(authorities.keys().next().value!);
    authorities.set(cwd, value); return value;
  } catch { authorities.delete(cwd); return undefined; }
}
function hasReplacementFiles(root: string, budget = { entries: 0 }): boolean {
  let stat;
  try { stat = lstatSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  const children = readdirSync(root, { withFileTypes: true });
  budget.entries += children.length;
  if (budget.entries > 128) return true;
  return children.some(child => child.isDirectory() ? hasReplacementFiles(join(root, child.name), budget) : true);
}
function safeContext(cwd: string): string | undefined {
  const authority = authorityContext(cwd);
  if (!authority) return undefined;
  try {
    for (const dir of new Set([authority.gitDir, authority.commonDir])) {
      // Split indexes and alternate object stores have additional authority
      // outside the ordinary index/config snapshot. Keep them authoritative
      // until their complete dependency graph is modeled.
      if (readdirSync(dir).some(name => name.startsWith('sharedindex.'))) return undefined;
      for (const name of ['alternates', 'http-alternates']) {
        try { lstatSync(join(dir, 'objects/info', name)); return undefined; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined; }
      }
      if (hasReplacementFiles(join(dir, 'refs/replace'))) return undefined;
      const packed = join(dir, 'packed-refs');
      if (existsSync(packed)) {
        if (statSync(packed).size > MAX_AUTHORITY_BYTES) return undefined;
        if (/^[0-9a-f]+ refs\/replace\//m.test(readFileSync(packed, 'utf8'))) return undefined;
      }
    }
    const identity = identities(authority.configPaths);
    if (authority.configIdentity === identity) return authority.configValue;
    const config = git(cwd, ['config', '--null', '--list']);
    let safe = true;
    for (const record of config.split('\0')) {
      if (!record) continue;
      const separator = record.indexOf('\n');
      const key = (separator < 0 ? record : record.slice(0, separator)).toLowerCase();
      if (!isSafeConfigKey(key)) safe = false;
    }
    // A concurrent authority edit must not associate a probe with other bytes.
    if (identities(authority.configPaths) !== identity) return undefined;
    authority.configIdentity = identity;
    authority.configValue = safe ? createHash('sha256').update(config).digest('hex') : undefined;
    return authority.configValue;
  } catch { return undefined; }
}
function safeAttributes(cwd: string, input: string): boolean {
  const authority = authorityContext(cwd);
  if (!authority) return false;
  try {
    const candidates = [...authority.attributePaths, authority.indexPath];
    for (const path of input.split('\0').filter(Boolean)) {
      let directory = dirname(resolve(authority.root, path));
      while (true) {
        if (directory !== authority.root && !directory.startsWith(authority.root + sep)) return false;
        candidates.push(join(directory, '.gitattributes'));
        if (directory === authority.root) break;
        directory = dirname(directory);
      }
    }
    const identity = createHash('sha256').update(identities(candidates)).update('\0').update(input).update('\0').update(authority.configIdentity ?? '').digest('hex');
    if (authority.attributesIdentity === identity) return authority.attributesSafe === true;
    const safe = git(cwd, ['check-attr', '--all', '-z', '--stdin'], input) === '';
    const after = createHash('sha256').update(identities(candidates)).update('\0').update(input).update('\0').update(authority.configIdentity ?? '').digest('hex');
    if (after !== identity) return false;
    authority.attributesIdentity = identity; authority.attributesSafe = safe;
    return safe;
  } catch { return false; }
}

/** Include deleted/rename-source paths as well as the whole target tree. */
function attributeInput(tree: string, diff: string): string | undefined {
  const paths = new Set<string>();
  for (const row of tree.split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t');
    if (tab < 0 || !row.slice(tab + 1)) return undefined;
    paths.add(row.slice(tab + 1));
  }
  const fields = diff.split('\0');
  if (fields.at(-1) === '') fields.pop();
  let cursor = 0;
  while (cursor < fields.length) {
    const status = fields[cursor++];
    if (!status || !/^(?:[ADMTUXB]|[RC][0-9]+)$/.test(status)) return undefined;
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let index = 0; index < count; index++) {
      const path = fields[cursor++];
      if (!path) return undefined;
      paths.add(path);
    }
  }
  const input = [...paths].join('\0') + (paths.size ? '\0' : '');
  return Buffer.byteLength(input) <= MAX_BYTES ? input : undefined;
}

/** Resolve moving refs on every call. Preserve Git's exact raw -M diff output. */
export function readStoryGitBytes(gitCwd: string, base: string, ref: string): { tree: string; diff: string } {
  const cwd = realpathSync(gitCwd);
  const resolved = git(cwd, ['rev-parse', '--revs-only', '--end-of-options', `${ref}^{object}`, `${base}^{object}`]).trim().split('\n');
  if (resolved.length !== 2 || resolved.some(value => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) throw new Error('Git references did not resolve to two immutable objects');
  const [headSha, baseSha] = resolved;
  const context = safeContext(cwd);
  const readTree = () => readObservedGitTree(cwd, headSha);
  const readDiff = () => git(cwd, ['diff', '--name-status', '-z', '-M', `${baseSha}..${headSha}`]);
  if (context === undefined) { clear(); return { tree: readTree(), diff: readDiff() }; }
  const treeKey = `${cwd}\0${headSha}\0${context}`;
  const diffKey = `${cwd}\0${baseSha}\0${headSha}\0${context}`;
  const tree = treeMemo.get(treeKey)?.raw ?? readTree();
  const cached = diffMemo.get(diffKey);
  const candidate = cached?.raw ?? readDiff();
  const input = attributeInput(tree, candidate);
  let attributesSafe = false;
  if (input !== undefined) {
    try { attributesSafe = safeAttributes(cwd, input); }
    catch { /* Unbounded or unavailable attribute context is never reusable. */ }
  }
  if (!attributesSafe) {
    clear();
    return { tree, diff: cached ? readDiff() : candidate };
  }
  remember(treeMemo, treeKey, tree);
  remember(diffMemo, diffKey, candidate);
  return { tree, diff: candidate };
}
