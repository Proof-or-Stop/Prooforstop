import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitEnvironmentRedirected } from './git-inert-environment.js';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Process-local memo for read-only git probes issued OUTSIDE a synchronous
 * observation (git-tree-observation.ts). One CLI command evaluates the same
 * gates several times (runtime preflight, transition guard, CLI preflight,
 * actor guard, next steps), and every evaluation used to ask git again for the
 * same HEAD, baseline, refs and trees: about two thirds of a gate command's
 * child processes were identical repeats.
 *
 * A remembered answer is returned only while the repository's complete ref
 * state is byte-for-byte what it was when the answer was produced. The
 * "witness" is read from the filesystem with no child process:
 *  - every HEAD-like file of the worktree's git dir and of the common dir,
 *    every loose ref (common and per-worktree refs/), packed-refs;
 *  - the linked-worktree registry (worktrees/<id>/HEAD, gitdir, locked and
 *    whether each checkout still exists), the discovered `.git` file;
 *  - grafts, shallow, repository and worktree config, and the user's global
 *    and the usual system config files;
 * each as inode, size, mtime/ctime in nanoseconds and the content digest
 * (reused while the stat identity is unchanged on a nanosecond-timestamp
 * filesystem; see fileSignature).
 * Objects are immutable, so a read whose output depends only on refs, objects
 * and config is a function of (cwd, argv, environment, witness). The witness
 * is taken before and after the producing git run; the answer is kept only if
 * both agree, so a ref that moved and came back during the run is never
 * remembered. Any difference at lookup time is a miss and git runs again.
 *
 * Not memoized here: anything that reads the index or the working tree
 * (status, diff without two revisions, ls-files, hash-object, `:path`), patch
 * text, line counts, rename/copy detection, textconv/filters and mailmap
 * output (they consult the checkout's .gitattributes/.mailmap even for
 * committed content), log without an explicit format, reflog
 * syntax, stdin-driven reads, explicit -C/--git-dir/--work-tree, any non-inert
 * GIT_* environment variable, a reftable repository, and a repository whose
 * ref state is too large to witness cheaply. Failures are kept only for
 * probes that name no object id (a missing ref is a ref-state fact; a missing
 * object can appear without any ref moving). Known limits, same as inside an
 * observation: config files reached through include.path and a system config
 * at a non-standard prefix are not witnessed.
 *
 * This is never a verdict cache: every gate is evaluated afresh on every call.
 */

const MAX_WITNESS_ENTRIES = 2048;
const MAX_WITNESS_FILE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_MEMO_BYTES = 64 * 1024 * 1024;

const FULL_OID = /(?:^|[^0-9a-f])[0-9a-f]{40}(?:[0-9a-f]{24})?(?:$|[^0-9a-f])/;
const FULL_OID_ONLY = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REVISION_RANGE = /^[^-][^\0]*\.\.\.?[^\0]*$|^\.\.\.?[^\0]+$/;

/** Strip leading `-c key=value` pairs and inert global switches; undefined when the argv redirects the repository. */
function subcommandArgs(argv: readonly string[]): string[] | undefined {
  const args = argv.filter(arg => !arg.startsWith('\0'));
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === '-c') { i += 2; continue; }
    if (arg === '--no-optional-locks' || arg === '--no-pager' || arg === '--literal-pathspecs' || arg === '--no-replace-objects') { i += 1; continue; }
    if (arg.startsWith('-')) return undefined; // -C, --git-dir, --work-tree, --namespace, ...
    break;
  }
  return args.slice(i);
}

function revisionPositionals(args: readonly string[]): string[] {
  const before: string[] = [];
  for (const arg of args) {
    if (arg === '--') break;
    if (!arg.startsWith('-')) before.push(arg);
  }
  return before;
}

/**
 * Exact read shapes whose output depends only on refs, objects, config, cwd
 * and environment. Everything else runs git every time.
 */
/**
 * Output that comes from the working tree even for committed content: patch
 * text and line counts use .gitattributes diff drivers from the checkout,
 * textconv/filters run configured programs, and the mailmap is a worktree file.
 */
const PATCH_OR_TRANSFORM = /^(?:-p|-u|--patch|--patch-with-raw|--patch-with-stat|--stat|--stat=.*|--numstat|--shortstat|--dirstat.*|--summary|--compact-summary|-U\d*|--unified(?:=.*)?|-W|--function-context|--word-diff.*|--color-words.*|--check|--cc|-c|--combined-all-paths|--binary|--full-index|--ext-diff|--textconv|--filters|--use-mailmap|--mailmap|--follow)$/;
const MAILMAP_ATOM = /%[ac][NEL]|%\(?:authorname|authoremail|committername|committeremail|mailmap/;
/** Rename/copy/break detection classifies binary files through the checkout's diff attributes. */
const RENAME_DETECTION = /^(?:-M.*|-C.*|-B.*|--find-renames.*|--find-copies.*|--find-copies-harder|--break-rewrites.*|--follow)$/;
const NAMES_ONLY = (arg: string) => arg === '--name-only' || arg === '--name-status' || arg === '-s' || arg === '--no-patch' || arg === '--raw';
const EXPLICIT_FORMAT = (arg: string) => /^--(?:format|pretty)=/.test(arg) && !/^--pretty=(?:oneline|short|medium|full|fuller|reference|email|raw|mboxrd)$/.test(arg) && !MAILMAP_ATOM.test(arg);

export function isRefStateGitRead(argv: readonly string[]): boolean {
  const args = subcommandArgs(argv);
  if (!args || args.length === 0) return false;
  const [sub, ...rest] = args;
  // Reflog selectors, index paths and stdin-driven forms are not ref state.
  if (rest.some(arg => arg.includes('@{') || /^:[^/]/.test(arg) || arg === '--stdin' || arg.startsWith('--batch'))) return false;
  // Abbreviated object names can become ambiguous as objects are added, and
  // relative dates or age limits depend on the clock.
  if (rest.some(arg => /^[0-9a-f]{4,39}(?:$|[\^~:])/.test(arg) || /%[ac]r|relative|^--(?:since|until|after|before|max-age|min-age)\b/.test(arg))) return false;
  if (rest.some(arg => PATCH_OR_TRANSFORM.test(arg) || MAILMAP_ATOM.test(arg))) return false;
  const before = revisionPositionals(rest);
  switch (sub) {
    case 'rev-parse':
      return !rest.some(arg => arg === '--shared-index-path' || arg === '--disambiguate' || arg.startsWith('--disambiguate=') || arg === '--local-env-vars');
    case 'symbolic-ref':
      return before.length <= 1 && !rest.some(arg => arg === '-d' || arg === '--delete' || arg === '-m');
    case 'for-each-ref':
    case 'ls-tree':
    case 'name-rev':
      return true;
    case 'show-ref':
      return !rest.some(arg => arg === '--exclude-existing' || arg.startsWith('--exclude-existing='));
    case 'merge-base':
      return !rest.includes('--fork-point');
    case 'rev-list':
      return !rest.some(arg => arg === '-g' || arg === '--walk-reflogs' || arg === '--reflog' || arg === '--indexed-objects' || arg === '--alternate-refs' || arg === '--disk-usage' || arg.startsWith('--disk-usage=') || arg.startsWith('--format') || arg.startsWith('--pretty'));
    case 'log':
      // Only an explicit, mailmap-free format with no diff output at all.
      return rest.some(EXPLICIT_FORMAT) && !rest.some(arg => NAMES_ONLY(arg) || arg === '-g' || arg === '--walk-reflogs' || arg === '--reflog');
    case 'diff-tree':
      // Plumbing: no rename detection unless asked for.
      return rest.some(NAMES_ONLY) && !rest.some(arg => RENAME_DETECTION.test(arg));
    case 'show':
      // A committed blob (`<rev>:<path>`) or a commit header in an explicit format.
      if (before.length === 1 && before[0]!.includes(':') && rest.length === 1) return true;
      return rest.some(arg => arg === '-s' || arg === '--no-patch') && rest.some(EXPLICIT_FORMAT);
    case 'cat-file':
      return rest.length > 0;
    case 'describe':
      return !rest.some(arg => arg === '--dirty' || arg.startsWith('--dirty=') || arg === '--broken' || arg.startsWith('--broken='));
    case 'worktree':
      return rest[0] === 'list';
    case 'diff':
      // Only revision-to-revision path lists: a single range, or exactly two
      // full object ids. One revision alone compares against the working tree.
      // Porcelain diff detects renames by default (diff.renames), which reads
      // the checkout's diff attributes: only an explicit --no-renames qualifies.
      if (!rest.some(NAMES_ONLY) || !rest.includes('--no-renames') || rest.some(arg => RENAME_DETECTION.test(arg))) return false;
      if (rest.some(arg => arg === '--cached' || arg === '--staged' || arg === '--no-index' || arg === '--merge-base')) return false;
      if (before.length === 1) return REVISION_RANGE.test(before[0]!);
      return before.length === 2 && before.every(arg => FULL_OID_ONLY.test(arg));
    default:
      return false;
  }
}

interface Layout { gitDir: string; commonDir: string; dotGit: string }

/** Git's own discovery for an ordinary or linked checkout, by filesystem only. */
function discoverLayout(cwd: string): Layout | undefined {
  let dir: string;
  try { dir = realpathSync(cwd); } catch { return undefined; }
  for (;;) {
    const dotGit = join(dir, '.git');
    let gitDir: string | undefined;
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) gitDir = dotGit;
      else if (stat.isFile()) {
        const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir: (.+)$/m);
        if (!pointer) return undefined;
        gitDir = resolve(dir, pointer[1]!.trim());
      }
    } catch { /* keep walking up */ }
    if (gitDir !== undefined) {
      try {
        gitDir = realpathSync(gitDir);
        if (!statSync(join(gitDir, 'HEAD')).isFile()) return undefined;
        let commonDir = gitDir;
        const commonFile = join(gitDir, 'commondir');
        if (existsSync(commonFile)) commonDir = realpathSync(resolve(gitDir, readFileSync(commonFile, 'utf8').trim()));
        if (existsSync(join(commonDir, 'reftable'))) return undefined;
        return { gitDir, commonDir, dotGit };
      } catch { return undefined; }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

class WitnessTooLarge extends Error {}

/**
 * Git replaces every ref, HEAD, packed-refs and config file through a lock
 * file and rename, so a changed file has a new inode and ctime, and its
 * directory a new mtime. With nanosecond timestamps the stat identity alone
 * proves a file or directory unchanged, and its content digest / listing is
 * reused from the previous witness. A whole-second timestamp (a coarse
 * filesystem, where an inode could be recycled within the same second) never
 * reuses: the content is read and the directory listed again.
 */
type BigStat = ReturnType<typeof statSync> & { ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint };
const fineGrained = (stat: BigStat) => stat.mtimeNs % 1_000_000_000n !== 0n && stat.ctimeNs % 1_000_000_000n !== 0n;
const statIdentity = (stat: BigStat) => `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
const fileDigests = new Map<string, { identity: string; signature: string }>();
const directoryListings = new Map<string, { identity: string; entries: Array<{ name: string; directory: boolean }> }>();

function bigStat(path: string): BigStat | undefined {
  try { return statSync(path, { bigint: true }) as BigStat; } catch { return undefined; }
}

function fileSignature(path: string): string {
  const stat = bigStat(path);
  if (!stat) return 'absent';
  if (!stat.isFile()) return `nonfile:${statIdentity(stat)}`;
  if (stat.size > BigInt(MAX_WITNESS_FILE_BYTES)) throw new WitnessTooLarge();
  const identity = statIdentity(stat);
  const known = fileDigests.get(path);
  if (known && known.identity === identity && fineGrained(stat)) return known.signature;
  const signature = `${identity}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  fileDigests.set(path, { identity, signature });
  return signature;
}

function listDirectory(path: string): Array<{ name: string; directory: boolean }> | undefined {
  const stat = bigStat(path);
  if (!stat || !stat.isDirectory()) return undefined;
  const identity = statIdentity(stat);
  const known = directoryListings.get(path);
  if (known && known.identity === identity && fineGrained(stat)) return known.entries;
  const entries = readdirSync(path, { withFileTypes: true })
    .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  directoryListings.set(path, { identity, entries });
  return entries;
}

function addTree(rows: string[], root: string, label: string): void {
  const entries = listDirectory(root);
  if (!entries) { rows.push(`${label}\0absent`); return; }
  rows.push(`${label}/\0${entries.map(entry => entry.name).join('\0')}`);
  for (const entry of entries) {
    if (rows.length > MAX_WITNESS_ENTRIES) throw new WitnessTooLarge();
    const path = join(root, entry.name);
    if (entry.directory) addTree(rows, path, `${label}/${entry.name}`);
    else rows.push(`${label}/${entry.name}\0${fileSignature(path)}`);
  }
}

function addHeadFiles(rows: string[], dir: string, label: string): void {
  const names = (listDirectory(dir) ?? []).filter(entry => !entry.directory && entry.name.endsWith('HEAD')).map(entry => entry.name);
  if (!names.includes('HEAD')) names.unshift('HEAD');
  for (const name of names) rows.push(`${label}/${name}\0${fileSignature(join(dir, name))}`);
}

const checkoutTargets = new Map<string, { signature: string; target: string | undefined }>();
function worktreeCheckout(gitdirFile: string): string | undefined {
  const signature = fileSignature(gitdirFile);
  const known = checkoutTargets.get(gitdirFile);
  if (known && known.signature === signature) return known.target;
  let target: string | undefined;
  try { target = readFileSync(gitdirFile, 'utf8').trim(); } catch { target = undefined; }
  checkoutTargets.set(gitdirFile, { signature, target });
  return target;
}

function globalConfigPaths(): string[] {
  const home = process.env.HOME || homedir();
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  return [join(home, '.gitconfig'), join(xdg, 'git', 'config'), '/etc/gitconfig', '/usr/local/etc/gitconfig', '/opt/homebrew/etc/gitconfig'];
}

/** The complete ref/config state of the repository holding cwd, or undefined when it cannot be witnessed cheaply. */
function refStateWitness(layout: Layout): string | undefined {
  try {
    const rows: string[] = [];
    const { gitDir, commonDir, dotGit } = layout;
    rows.push(`dotgit\0${fileSignature(dotGit)}`);
    addHeadFiles(rows, gitDir, 'gitdir');
    rows.push(`gitdir/config.worktree\0${fileSignature(join(gitDir, 'config.worktree'))}`);
    if (gitDir !== commonDir) {
      addTree(rows, join(gitDir, 'refs'), 'gitdir/refs');
      addHeadFiles(rows, commonDir, 'common');
    }
    for (const name of ['packed-refs', 'config', 'shallow', join('info', 'grafts')]) {
      rows.push(`common/${name}\0${fileSignature(join(commonDir, name))}`);
    }
    if (existsSync(join(commonDir, 'reftable'))) return undefined;
    addTree(rows, join(commonDir, 'refs'), 'common/refs');
    const worktrees = (listDirectory(join(commonDir, 'worktrees')) ?? []).map(entry => entry.name);
    rows.push(`worktrees/\0${worktrees.join('\0')}`);
    for (const id of worktrees) {
      const admin = join(commonDir, 'worktrees', id);
      addHeadFiles(rows, admin, `worktrees/${id}`);
      for (const name of ['gitdir', 'locked', 'config.worktree']) rows.push(`worktrees/${id}/${name}\0${fileSignature(join(admin, name))}`);
      // `worktree list` reports a checkout whose .git file vanished as prunable.
      const target = worktreeCheckout(join(admin, 'gitdir'));
      rows.push(`worktrees/${id}/checkout\0${target === undefined ? 'unreadable' : isAbsolute(target) && existsSync(target) ? 'present' : 'missing'}`);
      if (rows.length > MAX_WITNESS_ENTRIES) return undefined;
    }
    for (const path of globalConfigPaths()) rows.push(`config:${path}\0${fileSignature(path)}`);
    return createHash('sha256').update(rows.join('\n')).digest('hex');
  } catch {
    return undefined;
  }
}

interface Entry { witness: string; value?: string; failure?: unknown; bytes: number }
const memo = new Map<string, Entry>();
let memoBytes = 0;
const layouts = new Map<string, Layout | null>();
let freshDepth = 0;

function remember(key: string, entry: Entry): void {
  if (entry.bytes > MAX_ENTRY_BYTES) return;
  const previous = memo.get(key);
  if (previous) { memo.delete(key); memoBytes -= previous.bytes; }
  while (memo.size && memoBytes + entry.bytes > MAX_MEMO_BYTES) {
    const oldest = memo.keys().next().value!;
    memoBytes -= memo.get(oldest)!.bytes;
    memo.delete(oldest);
  }
  memo.set(key, entry);
  memoBytes += entry.bytes;
}

function layoutFor(cwd: string): Layout | undefined {
  const absolute = resolve(cwd);
  if (!layouts.has(absolute)) layouts.set(absolute, discoverLayout(absolute) ?? null);
  const layout = layouts.get(absolute) ?? undefined;
  // A removed checkout or git dir is rediscovered (and git then reports it).
  if (!existsSync(absolute) || (layout && !existsSync(layout.gitDir))) { layouts.delete(absolute); return undefined; }
  return layout;
}

/**
 * Run `run` (the caller's own read-only git invocation for argv in cwd) or
 * return its earlier answer when the ref-state witness is unchanged. `key`
 * must identify cwd, argv and the inherited environment. `refused` tells a
 * failure git itself reported (memoizable for ref-only probes) from an
 * incomplete run (never memoized).
 */
export function witnessedGitRead(cwd: string, argv: readonly string[], key: string, run: () => string, refused: (error: unknown) => boolean): string {
  if (freshDepth > 0 || !isRefStateGitRead(argv) || gitEnvironmentRedirected()) return run();
  const layout = layoutFor(cwd);
  if (!layout) return run();
  const before = refStateWitness(layout);
  if (before === undefined) return run();
  const known = memo.get(key);
  if (known && known.witness === before) {
    if (known.failure !== undefined) throw known.failure;
    return known.value!;
  }
  try {
    const value = run();
    if (typeof value === 'string' && refStateWitness(layout) === before) remember(key, { witness: before, value, bytes: Buffer.byteLength(value) + key.length });
    return value;
  } catch (error) {
    if (error !== undefined && refused(error) && !argv.some(arg => FULL_OID.test(arg)) && refStateWitness(layout) === before) {
      remember(key, { witness: before, failure: error, bytes: key.length + 256 });
    }
    throw error;
  }
}

/**
 * N9 (lab owner-init-and-worker-prompt): a witness of everything a worktree
 * diff of the checkout holding cwd can print (`git diff [--cached] [base...HEAD]`,
 * `ls-files --others --exclude-standard`, their name-status forms): the ref
 * state above, the index file, one `git status --porcelain -z
 * --untracked-files=all` run, and the bytes of every path it lists. A tracked
 * path status does not list equals the index (and HEAD), so it contributes
 * nothing to those outputs. Undefined (no memo) wherever the ref-state memo
 * is off. One status run instead of the whole diff set: story_advance TEST
 * and DONE built the scope diff pack 4-5 times on an unchanged checkout.
 */
export function worktreeChangeWitness(cwd: string): string | undefined {
  if (freshDepth > 0 || gitEnvironmentRedirected()) return undefined;
  const layout = layoutFor(cwd);
  if (!layout) return undefined;
  const refs = refStateWitness(layout);
  if (refs === undefined) return undefined;
  try {
    const root = dirname(layout.dotGit);
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = [`refs\0${refs}`, `index\0${fileSignature(join(layout.gitDir, 'index'))}`, `status\0${status}`];
    const entries = status.split('\0').filter(Boolean);
    if (entries.length > MAX_WITNESS_ENTRIES) return undefined;
    for (const entry of entries) {
      const path = entry.slice(3);
      rows.push(`${path}\0${fileSignature(join(root, path))}`);
    }
    return createHash('sha256').update(rows.join('\n')).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Lab framework-perf (git-read-cache.ts): the ref-state witness of the
 * repository holding cwd and its git directories, or undefined wherever the
 * memo above is off (fresh-read scope, redirected environment, reftable, a
 * ref state too large to witness, no repository).
 */
export function currentRefStateWitness(cwd: string): { witness: string; gitDir: string; commonDir: string; dotGit: string } | undefined {
  if (freshDepth > 0 || gitEnvironmentRedirected()) return undefined;
  const layout = layoutFor(cwd);
  if (!layout) return undefined;
  const witness = refStateWitness(layout);
  return witness === undefined ? undefined : { witness, gitDir: layout.gitDir, commonDir: layout.commonDir, dotGit: layout.dotGit };
}

/** True inside withFreshGitReads (every git read must run git). */
export function gitFreshReadsActive(): boolean {
  return freshDepth > 0;
}

/** Reads inside `read` always run git (launch-time rereads keep their exact semantics). */
export function withFreshGitReads<T>(read: () => T): T {
  freshDepth++;
  try { return read(); } finally { freshDepth--; }
}

/** Test hook: forget every remembered answer and layout. */
export function resetGitRefWitnessMemo(): void {
  memo.clear();
  memoBytes = 0;
  layouts.clear();
  fileDigests.clear();
  directoryListings.clear();
  checkoutTargets.clear();
}
