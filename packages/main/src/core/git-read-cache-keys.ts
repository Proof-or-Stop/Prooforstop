import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isObjectAddressedGitRead } from './git-object-read-memo.js';
import { currentRefStateWitness, isRefStateGitRead } from './git-ref-witness-memo.js';

/**
 * Lab framework-perf: which git reads the cross-process read cache
 * (git-read-cache.ts) may answer, and the exact witness each answer is keyed
 * by. Every witness is read from the filesystem with no child process and is
 * recomputed on every lookup, so an answer is reused only while everything
 * its bytes depend on is unchanged.
 *
 * Kinds, narrowest first:
 *   - object: bytes that are a function of full object ids (and config, which
 *     can reshape how an object prints). Namespace = common dir + objects/pack
 *     identity (gc/repack is the only way objects disappear) + config file
 *     identities; unusable with replace refs, grafts or a shallow boundary.
 *   - named: revision reads whose revisions are full ids or exact `HEAD` /
 *     `refs/...` names (no short-name lookup, no ref enumeration, no
 *     decoration). Witness = the object namespace + each named ref's resolved
 *     chain (loose file bytes, else its packed-refs line); an unresolvable name
 *     (where git would fall back to other lookups) is not cached.
 *   - symref: `symbolic-ref [-q] <ref>`; witness = that ref's loose bytes and
 *     packed-refs line. The quiet "not a symbolic ref" exit 1 is replayed.
 *   - prefix: `for-each-ref` over literal `refs/...` prefixes printing only
 *     refname/objectname/objecttype; witness = every loose ref under each
 *     prefix and the matching packed-refs lines.
 *   - setup: where the repository is (rev-parse --git-dir, --show-toplevel,
 *     ...), `git var` of config/attribute file locations, and `config --list`
 *     (not with include directives); witness = the .git file or directory,
 *     commondir, config file identities (and the env, as for every kind).
 *   - diff: `git diff` between two revisions (full ids or exact refs) with
 *     rename/copy detection or patch text, which isRefStateGitRead refuses
 *     because git consults the checkout's attributes (diff driver / binary)
 *     for the paths involved. Witness = the named/object witness of the
 *     revisions, and, checked against the answer's own output paths (every
 *     rename/copy candidate is in the output), the bytes of every
 *     .gitattributes on those paths, info/attributes, the global and system
 *     attribute files, and an index that holds no .gitattributes entry. Patch
 *     text is reused only when no attribute source exists at all (a diff
 *     driver could run an external textconv program).
 *   - refs: everything else isRefStateGitRead admits; witness = the complete
 *     ref state (git-ref-witness-memo.ts), checked again after the run.
 */

export type ReadKind = 'object' | 'named' | 'symref' | 'prefix' | 'setup' | 'diff' | 'refs';
export interface ReadKey {
  kind: ReadKind;
  /** Store file (git-read-cache.ts) and the witness material folded into the key. */
  file: string;
  witness: string;
  /** Exit 1 with empty output is a cacheable answer (a pure "no"). */
  refusalIsAnswer: boolean;
  /** The ref-state witness to re-check after a producing run (refs kind). */
  recheck?: { cwd: string; value: string };
  /** diff kind: a witness of what else the answer's own output depends on (attributes of its paths); undefined = never reuse. */
  outputWitness?: (stdout: Buffer) => string | undefined;
  commonDir: string;
}

/** Where git reads attributes outside the checkout (`git var GIT_ATTR_SYSTEM` / `GIT_ATTR_GLOBAL`, answered through the cache); undefined = unknown (never reuse). */
export interface AttributeLocations { system: (cwd: string) => string[] | undefined; global: (cwd: string) => string[] | undefined }

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PEELED_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\^\{(?:commit|tree|object|blob|tag)?\})?$/;
const REF_NAME = /^refs\/(?:[A-Za-z0-9_][A-Za-z0-9._+-]*\/)*[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const PER_WORKTREE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;
const REVISION_SUFFIX = /(?:\^\{(?:commit|tree|object|blob|tag)?\}|\^\d*|~\d*)*$/;

/** inode:size:mtime:ctime:mode (git rewrites config and refs through lock + rename), or 'absent'. */
export function statIdentity(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  } catch { return 'absent'; }
}

function configIdentities(commonDir: string, gitDir: string): string[] {
  const home = process.env.HOME ?? '';
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return [join(commonDir, 'config'), join(gitDir, 'config.worktree'), join(home, '.gitconfig'), join(xdg, 'git', 'config'),
    '/etc/gitconfig', '/usr/local/etc/gitconfig', '/opt/homebrew/etc/gitconfig'].map(path => `${path}=${statIdentity(path)}`);
}

interface State { witness: string; gitDir: string; commonDir: string; dotGit: string }

/** Objects can be redirected (replace refs, grafts, shallow) -> undefined. */
function objectNamespace(state: State): string | undefined {
  const { commonDir, gitDir } = state;
  try {
    if (existsSync(join(commonDir, 'shallow')) || existsSync(join(commonDir, 'info', 'grafts'))) return undefined;
    const replaceDir = join(commonDir, 'refs', 'replace');
    if (existsSync(replaceDir) && readdirSync(replaceDir).length > 0) return undefined;
    if (packedRefs(commonDir).some(line => line.name.startsWith('refs/replace/'))) return undefined;
    return sha([commonDir, statIdentity(join(commonDir, 'objects', 'pack')), ...configIdentities(commonDir, gitDir)].join('\0')).slice(0, 32);
  } catch {
    return undefined;
  }
}

/** Where git finds the repository from cwd: the .git directory (its inode; its mtime moves with every commit) or .git file bytes, commondir, config. */
function setupWitness(state: State): string {
  let dotGit: string;
  try {
    const stat = statSync(state.dotGit, { bigint: true });
    dotGit = stat.isDirectory() ? `dir:${stat.ino}` : stat.isFile() ? `file:${readFileSync(state.dotGit, 'utf8')}` : 'other';
  } catch { dotGit = 'unreadable'; }
  return sha([state.gitDir, state.commonDir, state.dotGit, dotGit, statIdentity(join(state.gitDir, 'commondir')), ...configIdentities(state.commonDir, state.gitDir)].join('\0'));
}

const packedCache = new Map<string, { identity: string; lines: Array<{ oid: string; name: string }> }>();
function packedRefs(commonDir: string): Array<{ oid: string; name: string }> {
  const path = join(commonDir, 'packed-refs');
  const identity = statIdentity(path);
  const known = packedCache.get(path);
  if (known && known.identity === identity) return known.lines;
  const lines: Array<{ oid: string; name: string }> = [];
  if (identity !== 'absent') {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/);
      if (match) lines.push({ oid: match[1]!, name: match[2]! });
    }
  }
  packedCache.set(path, { identity, lines });
  return lines;
}

/** The loose bytes or packed line of one ref name (no resolution), or undefined when it is not a plain file/absent. */
function refRecord(state: State, name: string): string | undefined {
  const path = name === 'HEAD' || PER_WORKTREE_REF.test(name) ? join(state.gitDir, name) : join(state.commonDir, name);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    stat = undefined;
  }
  if (stat && !stat.isFile()) return undefined;
  const loose = stat ? readFileSync(path, 'utf8') : null;
  const packed = name === 'HEAD' || PER_WORKTREE_REF.test(name) ? null : packedRefs(state.commonDir).find(line => line.name === name)?.oid ?? null;
  return JSON.stringify([name, loose, packed]);
}

/** The resolved chain of an exact ref name, or undefined when git would have to look further. */
function resolvedRef(state: State, name: string, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = refRecord(state, name);
  if (record === undefined) return undefined;
  const [, loose, packed] = JSON.parse(record) as [string, string | null, string | null];
  if (loose !== null) {
    const text = loose.trim();
    if (FULL_OID.test(text)) return record;
    const target = text.match(/^ref: (\S+)$/)?.[1];
    if (!target || !REF_NAME.test(target)) return undefined;
    const next = resolvedRef(state, target, depth + 1);
    return next === undefined ? undefined : `${record}\0${next}`;
  }
  return packed !== null ? record : undefined;
}

/** Leading global options: `-C <path>` folds into cwd, `-c key=value` stays in the argv; undefined for other global options. */
export function normalizeGitArgv(cwd: string, argv: readonly string[]): { cwd: string; argv: string[]; bare: string[] } | undefined {
  let dir = cwd;
  const config: string[] = [];
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const arg = argv[i]!;
    if (arg === '-C' && typeof argv[i + 1] === 'string') { dir = resolve(dir, argv[i + 1]!); i += 2; continue; }
    if (arg === '-c' && typeof argv[i + 1] === 'string') { config.push('-c', argv[i + 1]!); i += 2; continue; }
    return undefined;
  }
  const bare = argv.slice(i);
  return { cwd: dir, argv: [...config, ...bare], bare };
}

/** Reads beyond isObjectAddressedGitRead whose bytes depend only on full object ids. */
export function isObjectOnlyGitRead(bare: readonly string[]): boolean {
  const [sub, ...rest] = bare;
  const positionals = rest.filter(arg => !arg.startsWith('-'));
  const options = rest.filter(arg => arg.startsWith('-'));
  switch (sub) {
    case 'rev-parse':
      return positionals.length > 0 && positionals.every(arg => PEELED_OID.test(arg))
        && options.every(arg => ['--verify', '--quiet', '-q', '--revs-only', '--end-of-options', '--no-flags'].includes(arg));
    case 'merge-base':
      return positionals.length === 2 && positionals.every(arg => FULL_OID.test(arg))
        && options.every(arg => ['--is-ancestor', '--all', '--end-of-options'].includes(arg));
    case 'ls-tree': {
      const dashes = rest.indexOf('--');
      const head = dashes >= 0 ? rest.slice(0, dashes) : rest;
      const revs = head.filter(arg => !arg.startsWith('-'));
      return revs.length === 1 && PEELED_OID.test(revs[0]!) && (dashes >= 0 || positionals.length === 1)
        && head.filter(arg => arg.startsWith('-')).every(arg => LS_TREE_OPTIONS.has(arg));
    }
    case 'cat-file':
      return positionals.length >= 1 && positionals.length <= 2 && PEELED_OID.test(positionals.at(-1)!)
        && (positionals.length === 1 || ['blob', 'tree', 'commit', 'tag'].includes(positionals[0]!))
        && options.every(arg => ['-t', '-s', '-p', '-e'].includes(arg));
    case 'rev-list':
      return positionals.length === 1 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(positionals[0]!)
        && options.every(arg => ['--reverse', '--first-parent', '--count', '--topo-order', '--no-merges'].includes(arg));
    default:
      return false;
  }
}
const LS_TREE_OPTIONS = new Set(['-r', '-z', '-t', '-d', '-l', '--long', '--name-only', '--name-status', '--object-only', '--full-tree', '--full-name']);

/** Options that make a revision read depend on refs other than the ones it names. */
const ENUMERATES_REFS = /^--(?:all|branches|tags|remotes|glob|exclude|decorate|source|abbrev-ref|short|disambiguate|symbolic$|reflog|walk-reflogs|alternate-refs|indexed-objects|bisect|not$)/;
const NAMED_SUBCOMMANDS = new Set(['rev-parse', 'merge-base', 'ls-tree', 'show', 'cat-file', 'rev-list', 'diff-tree']);

/** The exact ref names (HEAD, refs/...) a named read depends on, or undefined when it is not one. */
function namedRevisionRefs(bare: readonly string[]): string[] | undefined {
  const [sub, ...rest] = bare;
  if (!sub || !NAMED_SUBCOMMANDS.has(sub)) return undefined;
  if (rest.some(arg => ENUMERATES_REFS.test(arg) || /%[dD]|%\((?:decorate|describe|HEAD|upstream|push|symref|worktreepath)/.test(arg))) return undefined;
  if (sub === 'rev-parse' && rest.some(arg => arg.startsWith('-') && !['--verify', '--quiet', '-q', '--revs-only', '--end-of-options', '--no-flags', '--symbolic-full-name'].includes(arg))) return undefined;
  const dashes = rest.indexOf('--');
  const revisions = (dashes >= 0 ? rest.slice(0, dashes) : rest).filter(arg => !arg.startsWith('-') || arg === '--end-of-options').filter(arg => arg !== '--end-of-options');
  if (sub === 'ls-tree' && dashes < 0 && revisions.length !== 1) return undefined;
  const names = new Set<string>();
  for (const revision of revisions) {
    const sides = revision.replace(/^\^/, '').split(/\.\.\.?/);
    if (sides.length > 2) return undefined;
    for (const raw of sides) {
      const side = raw === '' ? 'HEAD' : raw;
      const base = side.split(':')[0]!.replace(REVISION_SUFFIX, '');
      if (FULL_OID.test(base)) continue;
      if (base !== 'HEAD' && !REF_NAME.test(base)) return undefined;
      names.add(base);
    }
  }
  return names.size ? [...names].sort() : undefined;
}

function symrefName(bare: readonly string[]): string | undefined {
  const [sub, ...rest] = bare;
  if (sub !== 'symbolic-ref') return undefined;
  const positionals = rest.filter(arg => !arg.startsWith('-'));
  if (positionals.length !== 1 || !rest.filter(arg => arg.startsWith('-')).every(arg => arg === '-q' || arg === '--quiet')) return undefined;
  const name = positionals[0]!;
  return name === 'HEAD' || REF_NAME.test(name) ? name : undefined;
}

function forEachRefPrefixes(bare: readonly string[]): string[] | undefined {
  const [sub, ...rest] = bare;
  if (sub !== 'for-each-ref') return undefined;
  const options = rest.filter(arg => arg.startsWith('-'));
  // A literal pattern matches the ref itself or everything below it up to a slash ("refs/replace/" = "refs/replace").
  const patterns = rest.filter(arg => !arg.startsWith('-')).map(pattern => pattern.replace(/\/$/, ''));
  if (!patterns.length || !patterns.every(pattern => REF_NAME.test(pattern) && !PER_WORKTREE_REF.test(`${pattern}/`))) return undefined;
  for (const option of options) {
    const format = option.match(/^--format=(.*)$/s)?.[1];
    if (format === undefined) return undefined;
    const atoms = [...format.matchAll(/%\(([^)]*)\)/g)].map(match => match[1]);
    if (!atoms.every(atom => atom === 'refname' || atom === 'objectname' || atom === 'objecttype')) return undefined;
    if (/%[^(%]/.test(format.replace(/%\([^)]*\)/g, ''))) return undefined;
  }
  return [...patterns].sort();
}

/** Every loose ref under a prefix (bytes) and the matching packed lines; undefined when too large or not plain files. */
function prefixWitness(state: State, prefix: string): string | undefined {
  const rows: string[] = [];
  const walk = (path: string, name: string): boolean => {
    let stat;
    try { stat = lstatSync(path); } catch { return true; }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (rows.length > 4096 || !walk(join(path, entry), `${name}/${entry}`)) return false;
      }
      return true;
    }
    if (!stat.isFile()) return false;
    rows.push(`${name}\0${readFileSync(path, 'utf8')}`);
    return true;
  };
  if (!walk(join(state.commonDir, prefix), prefix)) return undefined;
  for (const line of packedRefs(state.commonDir)) if (line.name === prefix || line.name.startsWith(`${prefix}/`)) rows.push(`packed\0${line.name}\0${line.oid}`);
  return rows.length > 4096 ? undefined : rows.join('\n');
}

const SETUP_FLAGS = new Set(['--git-dir', '--git-common-dir', '--absolute-git-dir', '--show-toplevel', '--is-inside-work-tree',
  '--is-inside-git-dir', '--is-bare-repository', '--show-prefix', '--show-cdup', '--path-format=absolute', '--path-format=relative']);
const LOCATION_VARS = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_ATTR_GLOBAL', 'GIT_ATTR_SYSTEM']);
/** Repository location, config/attribute file locations and the config listing (env and config files only). */
export function isSetupGitRead(bare: readonly string[]): boolean {
  const [sub, ...rest] = bare;
  if (sub === 'rev-parse') return rest.length > 0 && rest.every(arg => SETUP_FLAGS.has(arg));
  if (sub === 'var') return rest.length === 1 && LOCATION_VARS.has(rest[0]!);
  if (sub === 'config') return rest.length >= 1 && rest.every(arg => ['--list', '-l', '--null', '-z'].includes(arg)) && rest.some(arg => arg === '--list' || arg === '-l');
  return false;
}

/** A `config --list` answer is reusable only when it pulled in no other file. */
export function setupAnswerReusable(bare: readonly string[], stdout: Buffer): boolean {
  if (bare[0] !== 'config') return true;
  return !/(?:^|[\n\0])include(?:if\.[^\n\0]*)?\.path[\n=]/i.test(stdout.toString('utf8'));
}


type DiffFormat = 'z-status' | 'z-names' | 'status' | 'names' | 'patch';
const DIFF_OPTIONS = /^(?:--name-status|--name-only|-z|-M\d*%?|--find-renames(?:=\d+%?)?|-C\d*%?|--find-copies(?:=\d+%?)?|--unified=\d+|-U\d+|--no-color|--no-ext-diff|--no-textconv|--end-of-options|--full-index|--binary)$/;

/** A revision-to-revision `git diff` this cache can witness, or undefined. */
function revisionDiff(bare: readonly string[]): { format: DiffFormat; revisions: string[] } | undefined {
  const [sub, ...rest] = bare;
  if (sub !== 'diff') return undefined;
  const dashes = rest.indexOf('--');
  const head = dashes >= 0 ? rest.slice(0, dashes) : rest;
  const options = head.filter(arg => arg.startsWith('-'));
  if (!options.every(arg => DIFF_OPTIONS.test(arg))) return undefined;
  const positionals = head.filter(arg => !arg.startsWith('-'));
  let revisions: string[];
  if (positionals.length === 1 && /^[^.]+\.\.\.?[^.]+$/.test(positionals[0]!)) revisions = positionals[0]!.split(/\.\.\.?/);
  else if (positionals.length === 2) revisions = positionals;
  else return undefined;
  const z = options.includes('-z');
  const format: DiffFormat = options.includes('--name-status') ? (z ? 'z-status' : 'status')
    : options.includes('--name-only') ? (z ? 'z-names' : 'names')
    : z ? 'z-status' /* refused below */ : 'patch';
  if (format === 'z-status' && !options.includes('--name-status')) return undefined;
  return { format, revisions };
}

/** Paths an answer names (rename/copy candidates included), or undefined when they cannot be read back exactly. */
function diffOutputPaths(format: DiffFormat, stdout: Buffer): string[] | undefined {
  const text = stdout.toString('utf8');
  const paths: string[] = [];
  if (format === 'z-names') return text.split('\0').filter(Boolean);
  if (format === 'z-status') {
    const tokens = text.split('\0');
    if (tokens.at(-1) === '') tokens.pop();
    for (let i = 0; i < tokens.length;) {
      const status = tokens[i++]!;
      const count = /^[RC]\d*$/.test(status) ? 2 : /^[ADMTUX]$/.test(status) ? 1 : -1;
      if (count < 0 || i + count > tokens.length) return undefined;
      paths.push(...tokens.slice(i, i + count));
      i += count;
    }
    return paths;
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.some(line => line.includes('"'))) return undefined; // quoted (unusual) paths: not parsed
  if (format === 'names') return lines;
  if (format === 'status') {
    for (const line of lines) {
      const fields = line.split('\t');
      if (fields.length < 2 || fields.length > 3) return undefined;
      paths.push(...fields.slice(1));
    }
    return paths;
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const body = line.slice('diff --git '.length);
      const halves = body.split(' b/');
      if (halves.length !== 2 || !halves[0]!.startsWith('a/')) return undefined;
      paths.push(halves[0]!.slice(2), halves[1]!);
    }
  }
  return paths;
}

/**
 * Attribute file locations for a git older than 2.42 (no `git var
 * GIT_ATTR_GLOBAL`): the global file is $XDG_CONFIG_HOME/git/attributes or
 * ~/.config/git/attributes unless a config file names core.attributesFile
 * (then unknown); the system file is one of the install-prefix candidates
 * (all are witnessed).
 */
export function fallbackGlobalAttributes(state: { commonDir: string; gitDir: string }): string[] | undefined {
  const home = process.env.HOME ?? '';
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const configs = [join(state.commonDir, 'config'), join(state.gitDir, 'config.worktree'), join(home, '.gitconfig'), join(xdg, 'git', 'config'),
    '/etc/gitconfig', '/usr/local/etc/gitconfig', '/opt/homebrew/etc/gitconfig'];
  for (const config of configs) {
    const bytes = fileBytes(config);
    if (bytes === undefined || /attributesfile|\[include/i.test(bytes)) return undefined;
  }
  return [join(xdg, 'git', 'attributes')];
}

export function fallbackSystemAttributes(): string[] {
  const candidates = new Set(['/etc/gitattributes', '/usr/etc/gitattributes', '/usr/local/etc/gitattributes', '/opt/homebrew/etc/gitattributes']);
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    try {
      const git = realpathSync(join(dir, 'git'));
      candidates.add(join(dirname(dirname(git)), 'etc', 'gitattributes'));
      break;
    } catch { /* next PATH entry */ }
  }
  return [...candidates].sort();
}

/** The common/git dirs of the repository holding cwd (for the fallback locations). */
export function repositoryDirs(cwd: string): { commonDir: string; gitDir: string } | undefined {
  const state = currentRefStateWitness(cwd);
  return state ? { commonDir: state.commonDir, gitDir: state.gitDir } : undefined;
}

const indexScans = new Map<string, { identity: string; clean: boolean }>();
/** The index holds no .gitattributes entry (v2/v3, no split or sparse index): attributes then come only from the checkout. */
function indexHasNoAttributes(gitDir: string): boolean {
  const path = join(gitDir, 'index');
  const identity = statIdentity(path);
  const known = indexScans.get(path);
  if (known && known.identity === identity) return known.clean;
  let clean = false;
  try {
    if (identity === 'absent') clean = true;
    else {
      const bytes = readFileSync(path);
      const version = bytes.length >= 8 && bytes.subarray(0, 4).toString('latin1') === 'DIRC' ? bytes.readUInt32BE(4) : 0;
      clean = (version === 2 || version === 3) && !bytes.includes('gitattributes') && !bytes.includes('link') && !bytes.includes('sdir');
    }
  } catch { clean = false; }
  indexScans.set(path, { identity, clean });
  return clean;
}

const fileBytes = (path: string): string | undefined => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? `file:${readFileSync(path, 'utf8')}` : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : undefined;
  }
};

function attributeWitness(state: State, locations: AttributeLocations, cwd: string, paths: readonly string[], requireNone: boolean): string | undefined {
  if (basename(state.dotGit) !== '.git') return undefined;
  const root = dirname(state.dotGit);
  let here: string;
  try { here = realpathSync(cwd); } catch { return undefined; }
  if (here !== root) return undefined; // output paths are relative to the top level only from there
  if (!indexHasNoAttributes(state.gitDir)) return undefined;
  const system = locations.system(cwd);
  const global = locations.global(cwd);
  if (system === undefined || global === undefined) return undefined;
  const rows: string[] = [];
  const sources = [join(state.commonDir, 'info', 'attributes'), ...system, ...global];
  const dirs = new Set<string>(['']);
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').includes('..')) return undefined;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const dir of [...dirs].sort()) sources.push(join(root, dir, '.gitattributes'));
  for (const source of sources) {
    const bytes = fileBytes(source);
    if (bytes === undefined || (requireNone && bytes !== 'absent')) return undefined;
    rows.push(`${source}\0${bytes}`);
  }
  for (const config of [join(state.commonDir, 'config'), join(state.gitDir, 'config.worktree')]) {
    const bytes = fileBytes(config);
    if (bytes === undefined || /\[attr\]|\battr\.tree\b/i.test(bytes) || (requireNone && /\bexternal\b|\btextconv\b|\[diff\s+"/i.test(bytes))) return undefined;
  }
  return sha(rows.join('\n'));
}

/**
 * The key for a git read in cwd, or undefined when the cache must not answer
 * it. `freshRead` / environment redirection are checked by the caller.
 */
export function gitReadKey(cwd: string, argv: readonly string[], locations?: AttributeLocations): (ReadKey & { cwd: string; argv: string[]; bare: string[] }) | undefined {
  if (argv.some(arg => arg.includes('%G'))) return undefined;
  const normalized = normalizeGitArgv(cwd, argv);
  if (!normalized) return undefined;
  const { bare } = normalized;
  const dir = isAbsolute(normalized.cwd) ? normalized.cwd : resolve(normalized.cwd);
  const objectRead = isObjectAddressedGitRead(bare) || isObjectOnlyGitRead(bare);
  const refRead = isRefStateGitRead(normalized.argv);
  const setupRead = !objectRead && isSetupGitRead(bare);
  const named = !objectRead && refRead ? namedRevisionRefs(bare) : undefined;
  const symref = symrefName(bare);
  const prefixes = forEachRefPrefixes(bare);
  const diff = !objectRead && !refRead && locations ? revisionDiff(bare) : undefined;
  if (!objectRead && !refRead && !setupRead && !symref && !diff) return undefined;
  const state = currentRefStateWitness(dir);
  if (!state) return undefined;
  const base = { cwd: dir, argv: normalized.argv, bare, commonDir: state.commonDir };
  if (objectRead) {
    const namespace = objectNamespace(state);
    if (namespace) return { ...base, kind: 'object', file: `objects-${namespace}.jsonl`, witness: namespace, refusalIsAnswer: bare[0] === 'merge-base' && bare.includes('--is-ancestor') };
  }
  if (setupRead) return { ...base, kind: 'setup', file: 'setup.jsonl', witness: setupWitness(state), refusalIsAnswer: false };
  if (named) {
    const namespace = objectNamespace(state);
    const chains = namespace ? named.map(name => resolvedRef(state, name)) : [];
    if (namespace && chains.every(chain => chain !== undefined)) {
      return { ...base, kind: 'named', file: `objects-${namespace}.jsonl`, witness: sha([namespace, setupWitness(state), ...chains].join('\0')), refusalIsAnswer: bare[0] === 'merge-base' && bare.includes('--is-ancestor') };
    }
  }
  if (symref) {
    const record = refRecord(state, symref);
    if (record !== undefined) return { ...base, kind: 'symref', file: 'setup.jsonl', witness: sha([setupWitness(state), record].join('\0')), refusalIsAnswer: true };
  }
  if (prefixes) {
    const namespace = objectNamespace(state);
    const rows = namespace ? prefixes.map(prefix => prefixWitness(state, prefix)) : [];
    if (namespace && rows.every(row => row !== undefined)) {
      return { ...base, kind: 'prefix', file: `objects-${namespace}.jsonl`, witness: sha([namespace, setupWitness(state), ...rows].join('\0')), refusalIsAnswer: false };
    }
  }
  if (diff && locations) {
    const namespace = objectNamespace(state);
    const names: string[] = [];
    for (const revision of diff.revisions) {
      const revisionBase = revision.replace(REVISION_SUFFIX, '');
      if (FULL_OID.test(revisionBase)) continue;
      if (revisionBase !== 'HEAD' && !REF_NAME.test(revisionBase)) return undefined;
      names.push(revisionBase);
    }
    const chains = namespace ? [...new Set(names)].sort().map(name => resolvedRef(state, name)) : [];
    if (!namespace || !chains.every(chain => chain !== undefined)) return undefined;
    const requireNone = diff.format === 'patch';
    return { ...base, kind: 'diff', file: `objects-${namespace}.jsonl`, witness: sha([namespace, setupWitness(state), ...chains].join('\0')), refusalIsAnswer: false,
      outputWitness: stdout => {
        const paths = diffOutputPaths(diff.format, stdout);
        return paths === undefined ? undefined : attributeWitness(state, locations, dir, paths, requireNone);
      } };
  }
  if (!refRead) return undefined;
  return { ...base, kind: 'refs', file: `refs-${state.witness.slice(0, 40)}.jsonl`, witness: state.witness, refusalIsAnswer: false, recheck: { cwd: dir, value: state.witness } };
}
