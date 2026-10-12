import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isObjectAddressedGitRead } from './git-object-read-memo.js';
import { currentRefStateWitness, isRefStateGitRead } from './git-ref-witness-memo.js';

/**
 * Lab framework-perf: which git reads the cross-process read cache
 * (git-read-cache.ts) may answer, and the exact witness each answer is keyed
 * by. Every witness is read from the filesystem with no child process and is
 * recomputed on every lookup and again after a producing run (an answer is
 * kept only when both agree), so an answer is reused only while everything
 * its bytes depend on is unchanged.
 *
 * Common to every kind: the git executable's identity (resolved from PATH),
 * the config files git reads (repository, worktree, global, XDG and the
 * binary's own system file, by content; any include directive refuses the
 * cache), no output that depends on the clock, on abbreviation (object count
 * / ambiguity), on notes, decoration or signatures, and no revision token
 * that is also a path. Every full object id an argv names must exist (loose
 * file or pack index; alternates and promisor packs refuse the cache).
 *
 * Kinds, narrowest first:
 *   - object: bytes that are a function of full object ids. Namespace =
 *     common dir + objects/pack identity + config; never with replace refs,
 *     grafts or a shallow boundary.
 *   - binary: `git var GIT_CONFIG_SYSTEM|GIT_ATTR_SYSTEM` (a function of the
 *     git executable and the environment).
 *   - setup: where the repository is (rev-parse --git-dir, --show-toplevel,
 *     ...), `git var` of global config/attribute file locations, and
 *     `config --list` (not with include directives); witness = the .git file
 *     or directory, commondir, config.
 *   - named: revision reads whose revisions are full ids or exact `HEAD` /
 *     `refs/...` names, with a per-subcommand option allowlist (no ref
 *     enumeration). Witness = the object namespace + each named ref's resolved
 *     chain (loose bytes, else its packed-refs line); an unresolvable name
 *     (where git would fall back to other lookups) is not cached.
 *   - symref: `symbolic-ref [-q] <ref>`; witness = that ref's loose bytes and
 *     packed-refs line. The quiet "not a symbolic ref" exit 1 is replayed.
 *   - prefix: `for-each-ref` over literal `refs/...` prefixes printing only
 *     refname/objectname/objecttype; witness = every loose ref under each
 *     prefix and the matching packed-refs lines; a symbolic ref under the
 *     prefix refuses the cache.
 *   - diff: `git diff --name-status` / `--full-index` patch between two
 *     revisions (full ids or exact refs) with rename/copy detection, which
 *     isRefStateGitRead refuses because git consults the checkout's attributes
 *     (diff driver / binary) for the paths involved. Witness = the named/object
 *     witness of the revisions, and, checked against the answer's own output
 *     paths (with --name-status every rename/copy candidate is in the output),
 *     the bytes of every .gitattributes on those paths, info/attributes, the
 *     global and system attribute files, and an index that holds no
 *     .gitattributes entry. Patch text is reused only when no attribute source
 *     exists at all (a diff driver could run an external textconv program).
 *   - refs: everything else isRefStateGitRead admits; witness = the complete
 *     ref state (git-ref-witness-memo.ts).
 */

export type ReadKind = 'object' | 'binary' | 'named' | 'symref' | 'prefix' | 'setup' | 'diff' | 'refs';
export interface ReadKey {
  kind: ReadKind;
  /** Store file (git-read-cache.ts) and the witness material folded into the key. */
  file: string;
  witness: string;
  /** Exit 1 with empty output is a cacheable answer (a pure "no"). */
  refusalIsAnswer: boolean;
  /** diff kind: a witness of what else the answer's own output depends on (attributes of its paths); undefined = never reuse. */
  outputWitness?: (stdout: Buffer) => string | undefined;
  commonDir: string;
}

/**
 * Files git reads outside the repository, as git itself reports them (`git
 * var`, answered through the cache); undefined = unknown (never reuse).
 */
export interface GitLocations {
  attributesSystem: (cwd: string) => string[] | undefined;
  attributesGlobal: (cwd: string) => string[] | undefined;
  configSystem: (cwd: string) => string[] | undefined;
}

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PEELED_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})(?:\^\{(?:commit|tree|object|blob|tag)?\})?$/;
const REF_NAME = /^refs\/(?:[A-Za-z0-9_][A-Za-z0-9._+-]*\/)*[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
const PER_WORKTREE_REF = /^refs\/(?:bisect|worktree|rewritten)\//;
const REVISION_SUFFIX = /(?:\^\{(?:commit|tree|object|blob|tag)?\}|\^\d*|~\d*)*$/;

/**
 * Output that depends on something no witness here covers: abbreviated ids
 * (object count / ambiguity), the clock, notes, decorations (all refs),
 * signatures, upstream tracking. Checked on every argv element.
 */
const VOLATILE_FORMAT = /%[htpNdDG]|%[ac][hr]|%\((?:describe|decorate|HEAD|upstream|push|symref|worktreepath|notes|ahead-behind|is-base|signature|contents:signature)|:(?:short|human|relative|track|trackshort)\b|:short=/;
const VOLATILE_OPTION = /^--(?:abbrev|short|relative-date|simplify-by-decoration|notes|show-notes|decorate|source|merge$|oneline|graph|left-right|cherry|boundary|show-signature|resolve-git-dir|show-superproject-working-tree|local-env-vars|shared-index-path|date=(?:human|relative|auto))/;

export function hasVolatileOutput(bare: readonly string[]): boolean {
  if (bare[0] === 'describe') return true;
  return bare.some(arg => VOLATILE_FORMAT.test(arg) || VOLATILE_OPTION.test(arg));
}

/** inode:size:mtime:ctime:mode, or 'absent'. */
export function statIdentity(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  } catch { return 'absent'; }
}

/**
 * A memo of a file-derived value reused only while the file's stat identity is
 * unchanged on a nanosecond-timestamp filesystem (with whole-second stamps a
 * same-second, same-size rewrite could keep the identity: always reread).
 */
function statMemo<T>(): (path: string, derive: (path: string) => T) => T {
  const memo = new Map<string, { identity: string; value: T }>();
  return (path, derive) => {
    let identity = 'absent';
    let fine = true;
    try {
      const stat = statSync(path, { bigint: true });
      identity = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
      fine = stat.mtimeNs % 1_000_000_000n !== 0n && stat.ctimeNs % 1_000_000_000n !== 0n;
    } catch { /* absent */ }
    const known = memo.get(path);
    if (known && known.identity === identity && fine) return known.value;
    const value = derive(path);
    memo.set(path, { identity, value });
    return value;
  };
}

const fileContent = statMemo<string | null | undefined>();
/** The bytes of a regular file, null when absent, undefined when not a plain file / unreadable. */
function readPlain(path: string): string | null | undefined {
  return fileContent(path, p => {
    try {
      const stat = lstatSync(p);
      return stat.isFile() ? readFileSync(p, 'utf8') : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined;
    }
  });
}

/** The git executable git(1) runs from this PATH, by identity (a different or upgraded git is a different key). */
export function gitBinaryIdentity(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'git');
    try {
      const stat = statSync(candidate);
      if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
      const real = realpathSync(candidate);
      // The macOS /usr/bin/git shim runs the selected developer directory's git.
      const selected = real === '/usr/bin/git' ? `\0${statIdentity('/var/db/xcode_select_link')}` : '';
      return `${real}\0${statIdentity(real)}${selected}`;
    } catch { /* next PATH entry */ }
  }
  return undefined;
}

interface State { witness: string; gitDir: string; commonDir: string; dotGit: string }

/** The config files git reads, by content; undefined when any of them includes another file or cannot be read. */
function configWitness(state: State, locations: GitLocations | undefined, cwd: string): string | undefined {
  const home = process.env.HOME ?? '';
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const system = locations?.configSystem(cwd);
  if (!system) return undefined;
  const rows: string[] = [];
  for (const path of [join(state.commonDir, 'config'), join(state.gitDir, 'config.worktree'), join(home, '.gitconfig'), join(xdg, 'git', 'config'), ...system]) {
    const bytes = readPlain(path);
    if (bytes === undefined || (bytes !== null && /^\s*\[\s*include(?:if)?\b/im.test(bytes))) return undefined;
    rows.push(`${path}\0${bytes === null ? 'absent' : sha(bytes)}`);
  }
  return sha(rows.join('\n'));
}

/** Objects can be redirected or fetched lazily (replace refs, grafts, shallow, alternates, promisor packs) -> undefined. */
function objectNamespace(state: State, config: string): string | undefined {
  const { commonDir } = state;
  try {
    if (existsSync(join(commonDir, 'shallow')) || existsSync(join(commonDir, 'info', 'grafts'))) return undefined;
    if (existsSync(join(commonDir, 'objects', 'info', 'alternates'))) return undefined;
    const replaceDir = join(commonDir, 'refs', 'replace');
    if (existsSync(replaceDir) && readdirSync(replaceDir).length > 0) return undefined;
    if (packedRefs(commonDir).some(line => line.name.startsWith('refs/replace/'))) return undefined;
    if (packFiles(commonDir).some(name => name.endsWith('.promisor'))) return undefined;
    return sha([commonDir, statIdentity(join(commonDir, 'objects', 'pack')), config].join('\0')).slice(0, 32);
  } catch {
    return undefined;
  }
}

const packListings = statMemo<string[]>();
function packFiles(commonDir: string): string[] {
  return packListings(join(commonDir, 'objects', 'pack'), path => { try { return readdirSync(path).sort(); } catch { return []; } });
}

const packIndexes = statMemo<Buffer | null>();
/** Whether a pack index (v2) lists the object. */
function indexHasObject(index: Buffer, oid: Buffer): boolean {
  if (index.length < 8 + 1024 || index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2) return false;
  const first = oid[0]!;
  let low = first === 0 ? 0 : index.readUInt32BE(8 + (first - 1) * 4);
  let high = index.readUInt32BE(8 + first * 4);
  const count = index.readUInt32BE(8 + 255 * 4);
  const width = oid.length;
  if (8 + 1024 + count * width > index.length) return false;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const start = 8 + 1024 + mid * width;
    const order = index.compare(oid, 0, width, start, start + width);
    if (order === 0) return true;
    if (order < 0) low = mid + 1; else high = mid;
  }
  return false;
}

/** Every full object id the argv names exists in this repository's object store (loose or packed). */
function objectsPresent(state: State, oids: readonly string[]): boolean {
  for (const oid of oids) {
    const loose = join(state.commonDir, 'objects', oid.slice(0, 2), oid.slice(2));
    try { if (statSync(loose).isFile()) continue; } catch { /* not loose */ }
    const wanted = Buffer.from(oid, 'hex');
    const found = packFiles(state.commonDir).filter(name => name.endsWith('.idx')).some(name => {
      const index = packIndexes(join(state.commonDir, 'objects', 'pack', name), path => {
        let fd: number | undefined;
        try {
          fd = openSync(path, 'r');
          const size = statSync(path).size;
          const bytes = Buffer.alloc(size);
          readSync(fd, bytes, 0, size, 0);
          return bytes;
        } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
      });
      return index !== null && indexHasObject(index, wanted);
    });
    if (!found) return false;
  }
  return true;
}

/** The full object ids an argv names (ranges, peels, `:path` and negations stripped). */
function namedObjectIds(bare: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const arg of bare.slice(1)) {
    if (arg.startsWith('-')) continue;
    for (const side of arg.replace(/^\^/, '').split(/\.\.\.?/)) {
      const base = side.split(':')[0]!.replace(REVISION_SUFFIX, '');
      if (FULL_OID.test(base)) ids.add(base);
    }
  }
  return [...ids].sort();
}

/** Where git finds the repository from cwd: the .git directory (its inode; its mtime moves with every commit) or .git file bytes, commondir. */
function layoutWitness(state: State): string {
  let dotGit: string;
  try {
    const stat = statSync(state.dotGit, { bigint: true });
    dotGit = stat.isDirectory() ? `dir:${stat.ino}` : stat.isFile() ? `file:${readFileSync(state.dotGit, 'utf8')}` : 'other';
  } catch { dotGit = 'unreadable'; }
  return sha([state.gitDir, state.commonDir, state.dotGit, dotGit, String(readPlain(join(state.gitDir, 'commondir')))].join('\0'));
}

const packedRefsFiles = statMemo<Array<{ oid: string; name: string }>>();
function packedRefs(commonDir: string): Array<{ oid: string; name: string }> {
  return packedRefsFiles(join(commonDir, 'packed-refs'), path => {
    const lines: Array<{ oid: string; name: string }> = [];
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return lines; }
    for (const line of text.split('\n')) {
      const match = line.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/);
      if (match) lines.push({ oid: match[1]!, name: match[2]! });
    }
    return lines;
  });
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

const LS_TREE_OPTIONS = new Set(['-r', '-z', '-t', '-d', '-l', '--long', '--name-only', '--name-status', '--object-only', '--full-tree', '--full-name']);

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

/** Per-subcommand options a named read may carry (anything else: not a named read). */
const NAMED_OPTIONS: Record<string, (arg: string) => boolean> = {
  'rev-parse': arg => ['--verify', '--quiet', '-q', '--revs-only', '--end-of-options', '--no-flags', '--symbolic-full-name'].includes(arg),
  'merge-base': arg => ['--end-of-options', '--is-ancestor', '--all', '--octopus', '--independent'].includes(arg),
  'ls-tree': arg => arg === '--end-of-options' || LS_TREE_OPTIONS.has(arg),
  show: arg => ['-s', '--no-patch', '--quiet', '--no-color', '--no-notes', '--end-of-options'].includes(arg) || /^--(?:format|pretty)=/.test(arg),
  'cat-file': arg => ['-t', '-s', '-p', '-e'].includes(arg),
  'rev-list': arg => ['--reverse', '--first-parent', '--count', '--topo-order', '--no-merges', '--ancestry-path', '--parents', '--end-of-options'].includes(arg) || /^--max-count=\d+$/.test(arg),
  'diff-tree': arg => ['--no-commit-id', '--name-only', '--name-status', '-r', '-z', '--root', '--end-of-options'].includes(arg),
};

/** The exact ref names (HEAD, refs/...) a named read depends on, or undefined when it is not one. */
function namedRevisionRefs(bare: readonly string[]): string[] | undefined {
  const [sub, ...rest] = bare;
  const allowed = sub ? NAMED_OPTIONS[sub] : undefined;
  if (!allowed) return undefined;
  const dashes = rest.indexOf('--');
  const head = dashes >= 0 ? rest.slice(0, dashes) : rest;
  if (!head.filter(arg => arg.startsWith('-')).every(allowed)) return undefined;
  const revisions = head.filter(arg => !arg.startsWith('-'));
  if (sub === 'ls-tree' && revisions.length !== 1) return undefined;
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

/** Every loose ref under a prefix (bytes) and the matching packed lines; undefined when too large, not plain files, or a symbolic ref (its target is outside the witness). */
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
    const bytes = readFileSync(path, 'utf8');
    if (!FULL_OID.test(bytes.trim())) return false;
    rows.push(`${name}\0${bytes}`);
    return true;
  };
  if (!walk(join(state.commonDir, prefix), prefix)) return undefined;
  for (const line of packedRefs(state.commonDir)) if (line.name === prefix || line.name.startsWith(`${prefix}/`)) rows.push(`packed\0${line.name}\0${line.oid}`);
  return rows.length > 4096 ? undefined : rows.join('\n');
}

const SETUP_FLAGS = new Set(['--git-dir', '--git-common-dir', '--absolute-git-dir', '--show-toplevel', '--is-inside-work-tree',
  '--is-inside-git-dir', '--is-bare-repository', '--show-prefix', '--show-cdup', '--path-format=absolute', '--path-format=relative']);
const LOCATION_VARS = new Set(['GIT_CONFIG_GLOBAL', 'GIT_ATTR_GLOBAL']);
const BINARY_VARS = new Set(['GIT_CONFIG_SYSTEM', 'GIT_ATTR_SYSTEM']);
/** Repository location, global config/attribute file locations and the config listing (env, layout and config files only). */
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

type DiffFormat = 'z-status' | 'status' | 'patch';
const DIFF_OPTIONS = /^(?:--name-status|-z|-M\d*%?|--find-renames(?:=\d+%?)?|-C\d*%?|--find-copies(?:=\d+%?)?|--unified=\d+|-U\d+|--no-color|--no-ext-diff|--no-textconv|--end-of-options|--full-index|--binary)$/;

/**
 * A revision-to-revision `git diff` this cache can witness, or undefined.
 * `--name-only` is not: a rename prints only its destination, while the
 * source path's attributes also shaped the pairing.
 */
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
  if (options.includes('--name-status')) return { format: z ? 'z-status' : 'status', revisions };
  // Patch text: an abbreviated `index` line depends on the object count, so only --full-index.
  if (z || !options.includes('--full-index')) return undefined;
  return { format: 'patch', revisions };
}

/** Paths an answer names (rename/copy candidates included), or undefined when they cannot be read back exactly. */
function diffOutputPaths(format: DiffFormat, stdout: Buffer): string[] | undefined {
  const text = stdout.toString('utf8');
  if (text.includes('�')) return undefined; // not UTF-8: paths cannot be read back exactly
  const paths: string[] = [];
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
export function fallbackGlobalAttributes(state: { commonDir: string; gitDir: string }, systemConfig: readonly string[]): string[] | undefined {
  const home = process.env.HOME ?? '';
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  for (const config of [join(state.commonDir, 'config'), join(state.gitDir, 'config.worktree'), join(home, '.gitconfig'), join(xdg, 'git', 'config'), ...systemConfig]) {
    const bytes = readPlain(config);
    if (bytes === undefined || (bytes !== null && /attributesfile|\[\s*include/i.test(bytes))) return undefined;
  }
  return [join(xdg, 'git', 'attributes')];
}

/** Install-prefix candidates of a system file for a git without the `git var` (all are witnessed). */
export function fallbackSystemFiles(name: 'gitattributes' | 'gitconfig'): string[] {
  const candidates = new Set([`/etc/${name}`, `/usr/etc/${name}`, `/usr/local/etc/${name}`, `/opt/homebrew/etc/${name}`]);
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    try {
      const git = realpathSync(join(dir, 'git'));
      candidates.add(join(dirname(dirname(git)), 'etc', name));
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

const indexScans = statMemo<boolean>();
/** The index holds no .gitattributes entry (v2/v3, no split or sparse index): attributes then come only from the checkout. */
function indexHasNoAttributes(gitDir: string): boolean {
  return indexScans(join(gitDir, 'index'), path => {
    try {
      if (!existsSync(path)) return true;
      const bytes = readFileSync(path);
      const version = bytes.length >= 8 && bytes.subarray(0, 4).toString('latin1') === 'DIRC' ? bytes.readUInt32BE(4) : 0;
      return (version === 2 || version === 3) && !bytes.includes('gitattributes') && !bytes.includes('link') && !bytes.includes('sdir');
    } catch { return false; }
  });
}

function attributeWitness(state: State, locations: GitLocations, cwd: string, paths: readonly string[], requireNone: boolean): string | undefined {
  if (basename(state.dotGit) !== '.git') return undefined;
  const root = dirname(state.dotGit);
  let here: string;
  try { here = realpathSync(cwd); } catch { return undefined; }
  if (here !== root) return undefined; // output paths are relative to the top level only from there
  if (!indexHasNoAttributes(state.gitDir)) return undefined;
  const system = locations.attributesSystem(cwd);
  const global = locations.attributesGlobal(cwd);
  const configSystem = locations.configSystem(cwd);
  if (system === undefined || global === undefined || configSystem === undefined) return undefined;
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
    const bytes = readPlain(source);
    if (bytes === undefined || (requireNone && bytes !== null)) return undefined;
    rows.push(`${source}\0${bytes === null ? 'absent' : sha(bytes)}`);
  }
  const home = process.env.HOME ?? '';
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  for (const config of [join(state.commonDir, 'config'), join(state.gitDir, 'config.worktree'), join(home, '.gitconfig'), join(xdg, 'git', 'config'), ...configSystem]) {
    const bytes = readPlain(config);
    if (bytes === undefined) return undefined;
    if (bytes !== null && (/\[\s*attr\s*\]|\battr\.tree\b/i.test(bytes) || (requireNone && /\bexternal\b|\btextconv\b|\[\s*diff\s+"/i.test(bytes)))) return undefined;
  }
  return sha(rows.join('\n'));
}

/**
 * Without `--` (and outside `rev-parse --verify`), git refuses an argument
 * that names both a revision and an existing path ("ambiguous argument"): a
 * revision token that is also a path from cwd is never answered from the cache.
 */
function revisionTokensArePaths(cwd: string, bare: readonly string[]): boolean {
  const [sub, ...rest] = bare;
  if (rest.includes('--') || (sub === 'rev-parse' && rest.includes('--verify'))) return false;
  if (!['rev-parse', 'rev-list', 'diff', 'log', 'show', 'diff-tree', 'merge-base', 'ls-tree', 'cat-file', 'name-rev', 'describe'].includes(sub ?? '')) return false;
  return rest.filter(arg => !arg.startsWith('-')).some(arg => {
    try { lstatSync(resolve(cwd, arg)); return true; } catch { return false; }
  });
}

/**
 * The key for a git read in cwd, or undefined when the cache must not answer
 * it. Fresh-read scopes and environment redirection are checked by the caller.
 */
export function gitReadKey(cwd: string, argv: readonly string[], locations?: GitLocations): (ReadKey & { cwd: string; argv: string[]; bare: string[] }) | undefined {
  const normalized = normalizeGitArgv(cwd, argv);
  if (!normalized) return undefined;
  const { bare } = normalized;
  if (hasVolatileOutput(bare)) return undefined;
  const dir = isAbsolute(normalized.cwd) ? normalized.cwd : resolve(normalized.cwd);
  if (revisionTokensArePaths(dir, bare)) return undefined;
  const binary = gitBinaryIdentity();
  if (!binary) return undefined;
  const binaryRead = bare[0] === 'var' && bare.length === 2 && BINARY_VARS.has(bare[1]!);
  const objectRead = !binaryRead && (isObjectAddressedGitRead(bare) || isObjectOnlyGitRead(bare));
  const refRead = !binaryRead && isRefStateGitRead(normalized.argv);
  const setupRead = !objectRead && isSetupGitRead(bare);
  const named = !objectRead && refRead ? namedRevisionRefs(bare) : undefined;
  const symref = symrefName(bare);
  const prefixes = forEachRefPrefixes(bare);
  const diff = !objectRead && !refRead && locations && !normalized.argv.includes('-c') ? revisionDiff(bare) : undefined;
  if (!binaryRead && !objectRead && !refRead && !setupRead && !symref && !diff) return undefined;
  const state = currentRefStateWitness(dir);
  if (!state) return undefined;
  const base = { cwd: dir, argv: normalized.argv, bare, commonDir: state.commonDir };
  // `git var GIT_CONFIG_SYSTEM` / `GIT_ATTR_SYSTEM` are a function of the executable (and the environment, in every key).
  if (binaryRead) return { ...base, kind: 'binary', file: 'setup.jsonl', witness: sha(binary), refusalIsAnswer: false };
  const config = configWitness(state, locations, dir);
  if (!config) return undefined;
  if (!objectsPresent(state, namedObjectIds(bare))) return undefined;
  const common = sha([binary, config, layoutWitness(state)].join('\0'));
  if (objectRead) {
    const namespace = objectNamespace(state, config);
    if (namespace) return { ...base, kind: 'object', file: `objects-${namespace}.jsonl`, witness: sha([namespace, common].join('\0')), refusalIsAnswer: bare[0] === 'merge-base' && bare.includes('--is-ancestor') };
  }
  if (setupRead) return { ...base, kind: 'setup', file: 'setup.jsonl', witness: common, refusalIsAnswer: false };
  if (named) {
    const namespace = objectNamespace(state, config);
    const chains = namespace ? named.map(name => resolvedRef(state, name)) : [];
    if (namespace && chains.every(chain => chain !== undefined)) {
      return { ...base, kind: 'named', file: `objects-${namespace}.jsonl`, witness: sha([namespace, common, ...chains].join('\0')), refusalIsAnswer: bare[0] === 'merge-base' && bare.includes('--is-ancestor') };
    }
  }
  if (symref) {
    const record = refRecord(state, symref);
    if (record !== undefined) return { ...base, kind: 'symref', file: 'setup.jsonl', witness: sha([common, record].join('\0')), refusalIsAnswer: true };
  }
  if (prefixes) {
    const namespace = objectNamespace(state, config);
    const rows = namespace ? prefixes.map(prefix => prefixWitness(state, prefix)) : [];
    if (namespace && rows.every(row => row !== undefined)) {
      return { ...base, kind: 'prefix', file: `objects-${namespace}.jsonl`, witness: sha([namespace, common, ...rows].join('\0')), refusalIsAnswer: false };
    }
  }
  if (diff && locations) {
    const namespace = objectNamespace(state, config);
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
    return { ...base, kind: 'diff', file: `objects-${namespace}.jsonl`, witness: sha([namespace, common, ...chains].join('\0')), refusalIsAnswer: false,
      outputWitness: stdout => {
        const paths = diffOutputPaths(diff.format, stdout);
        return paths === undefined ? undefined : attributeWitness(state, locations, dir, paths, requireNone);
      } };
  }
  if (!refRead) return undefined;
  return { ...base, kind: 'refs', file: `refs-${state.witness.slice(0, 40)}.jsonl`, witness: sha([state.witness, common].join('\0')), refusalIsAnswer: false };
}
