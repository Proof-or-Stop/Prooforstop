#!/usr/bin/env node
/**
 * RED artifact (B-49d4, CHK-001) — the registration guard asserts a FIXED
 * allowlist instead of DERIVING its population, so it is structurally blind to
 * anything nobody put on the list, and `proof-or-stop validate` never runs 15 of the
 * red harnesses that are committed next to it.
 *
 * ── THE DEFECT'S UNUSUAL FAILURE MODE ───────────────────────────────────────
 *
 * The failure IS a confident success line, not an error.
 * `red-w2c-validate-registration.mjs` compares `proof-or-stop.config.json`
 * `validate.commands` against a hardcoded `REQUIRED_VALIDATE_COMMANDS` array of
 * three entries and then prints:
 *
 *   red-w2c-validate-registration: OK (... registers all 3 required
 *   red-evidence smokes ...)
 *
 * That "3" is `REQUIRED_VALIDATE_COMMANDS.length`. It is the size of the
 * EXPECTATION, never the size of the POPULATION. Add a fourth genuine member of
 * `packages/main/dist/tasks/red-evidence-*.js` and the number stays 3, the exit
 * code stays 0, and the guard reports complete coverage of a population it never
 * looked at. A check whose report cannot change when its subject changes cannot
 * ever reveal a gap.
 *
 * ── THIS FILE IS REPRO-FIRST: IT MUST FAIL ON THE PRE-FIX TREE ──────────────
 *
 * It exits NON-ZERO today. A RED artifact that passes before the fix proves
 * nothing. Every row below is printed as `[RED]` or `[GREEN]` from a MEASURED
 * observation — no row is a claim — and the process exits 1 while any row is
 * RED. On a correctly fixed tree every row goes GREEN and this file exits 0,
 * which is what makes it worth registering in `validate.commands`.
 *
 * ── THREE DEMONSTRATIONS, THREE ASSERTION SHAPES ────────────────────────────
 *
 *   A. BLINDNESS   A genuine member of the guard's OWN population is planted on
 *                  disk — `packages/main/dist/tasks/red-evidence-*.js` together
 *                  with its `packages/main/src/tasks/*.ts` counterpart, so it is
 *                  indistinguishable from a real member and cannot be dismissed
 *                  as stale build output. That indistinguishability is MEASURED
 *                  against the real members rather than asserted about the probe
 *                  this file just wrote (see `PLANTED_MEMBER_MATCHES_THE_SHAPE_OF
 *                  _REAL_MEMBERS`). It is registered NOWHERE and it exits
 *                  NON-ZERO, so `proof-or-stop validate` would fail if it ran. The
 *                  REAL guard is then spawned. Two independent assertions:
 *                  (A1) it must not exit 0, and (A2) a confident success line
 *                  must never report fewer members than exist on disk. A1 is the
 *                  gap; A2 is WHY the gap can never be seen.
 *
 *   B. CONTROL     Blindness only means something if the guard is capable of
 *                  failing at all. A COPY of `proof-or-stop.config.json` with one
 *                  currently-listed command removed must make the guard exit
 *                  non-zero. The REAL config is never written to; its sha256 is
 *                  taken before anything happens and re-checked at the end, and
 *                  `git status --porcelain` on it must be empty. The sandbox is a
 *                  symlink mirror of the repository root with ONLY that one file
 *                  replaced, run through `--preserve-symlinks-main` so the
 *                  ACTUAL shipped guard file executes and resolves its root to
 *                  the sandbox. Two extra runs prove the sandbox itself:
 *                  an unmutated copy must still pass (faithful), and an
 *                  empty-commands copy must fail (the redirect really happened,
 *                  so a non-biting control can never be mistaken for a fine one).
 *
 *   C. POPULATION  How many `packages/main/tests/red/*.mjs` are ACCOUNTED FOR?
 *                  DERIVED, never hardcoded: enumerate the directory UNFILTERED,
 *                  subtract what `validate.commands` registers, and require every
 *                  remainder to be a RECORDED DECISION — an entry in the audited
 *                  exclusion record of the registered guard
 *                  `red-b49d4-harness-registration.mjs`, which is spawned here and
 *                  must exit 0. Whatever is neither is coverage nobody has and
 *                  nobody chose. A number in a test goes stale; a derivation
 *                  cannot.
 *
 * ── WHY BLOCK C NO LONGER CLAIMS "REACHABLE" (F-006) ────────────────────────
 *
 * BLOCK C used to subtract a third set: members "transitively REACHABLE from a
 * registered command". Reachability was followed by TEXTUAL INCLUSION — if a
 * registered file's source contained a member's filename, the member was reported
 * as `spawned by a registered command`. That is not an execution edge, and the
 * header used to call the over-approximation "conservative". It is the opposite
 * of conservative for the claim actually being made. Measured on this tree:
 * `red-b49d4-chk001-receipt.mjs` appears in `red-b49d4-harness-registration.mjs`
 * only as a KEY in its exclusion bookkeeping map — that guard contains no
 * `child_process` import at all — and `red-b2aa7-chk007-receipt.mjs` spawns only
 * the keys of its OWN map, filtered by `/^red-b2aa7-.*\.mjs$/`, which cannot name
 * a `b49d4` file. So NOTHING executes it, yet the row printed
 * `0 are NEVER RUN: none` and went GREEN. A file nothing runs was reported as
 * covered: a SILENT FALSE GREEN, reproducing inside this guard the exact
 * false-confidence defect class B-49d4 exists to remove.
 *
 * The fix does not special-case that filename and does not swap one textual
 * guess for another. It separates two DIFFERENT properties that the old row
 * conflated:
 *
 *   DECIDED   — the member's non-registration is a recorded, audited decision.
 *               Mechanically checkable, and it is what the verdict now rests on.
 *   EXECUTED  — something actually runs the member. NOT claimed here at all:
 *               proving it needs measurement (tracing a real run), not a scan,
 *               and this block does not measure it. Saying nothing is the honest
 *               option; saying "0 are NEVER RUN" was not.
 *
 * Both failure directions are now LOUD: a member that is neither registered nor
 * in the decision record lands in `unaccounted` and the row goes RED, and a
 * decision record this file cannot read yields an EMPTY decided set, which lands
 * every unregistered member in `unaccounted` and also goes RED.
 *
 * ── THE TRAP THIS FILE EXISTS TO CLOSE (BLOCK D) ────────────────────────────
 *
 * The obvious fix is to copy `red-b2aa7-chk007-receipt.mjs`, which DOES derive
 * its population from disk — but through `/^red-b2aa7-.*\.mjs$/`. Mirroring that
 * filter would leave a future differently-prefixed harness outside the
 * population and reproduce this very defect one prefix over. So BLOCK D plants a
 * newcomer named WITHOUT the `red-` prefix at all: its only qualifying property
 * is that it is an `*.mjs` file in `packages/main/tests/red/`, which is exactly
 * the population an unfiltered enumeration sees and exactly what any name
 * pattern narrows away.
 *
 * Crucially the newcomer is judged by SPAWNING REAL SHIPPED GUARDS — this file
 * contains no imitation of anybody's enumeration. A simulation written here
 * would let a narrowed implementation pass this test, which would defeat the
 * whole purpose. The targets are derived: the guard this story names, plus every
 * `*.mjs` in the red directory that reads `proof-or-stop.config.json` AND enumerates a
 * directory (i.e. anything that decides registration by looking). Today that set
 * also contains `red-b2aa7-chk007-receipt.mjs`, so its narrowed regex is
 * measured rather than argued about: it is a real shipped derived guard that
 * looks straight past this newcomer.
 *
 * ── WHICH GUARDS JUDGE THE NEWCOMER IS ASSERTED COMPLETE, NOT JUST NON-EMPTY ─
 *
 * A file that spawns this one has to be skipped or BLOCK D recurses forever, and
 * that skip used to be a bare `text.includes(SELF)` continue with a
 * `targetRuns.length > 0` assertion behind it. Non-empty is not complete: writing
 * this artifact's filename into a target — a "see also" comment is enough —
 * removed it from the check while the artifact still reported GREEN on whatever
 * remained, so a guard's newcomer detection could stop being verified without
 * anything saying so. The skip is now audited DATA (`TARGET_CYCLE_BREAKS`, empty
 * today) and the derived target set must EQUAL the set of files that genuinely
 * qualify, must contain both guards this story ships, and fails NAMING any file
 * that drops out — whether because it mentions this artifact or because it
 * quietly stopped qualifying. `TARGET_SET_COMPLETENESS_CHECK_BITES` re-runs the
 * same derivation over six synthetic mutations covering every one of those ways
 * to shrink, so a clean verdict is not a vacuous one.
 *
 * ── NO PROBE IS EVER WRITTEN INTO THE REPOSITORY ────────────────────────────
 *
 * Probes used to be planted in the WORKING TREE and removed in `try/finally`
 * after a startup sweep. Both are best effort, and the population a probe lands
 * in is one that `red-b49d4-harness-registration.mjs` enumerates TOTALLY:
 *
 *   - `finally` does not run through SIGKILL or a watchdog kill, so a killed run
 *     stranded `b49d4-newcomer-probe-unprefixed.mjs` in the red directory, and
 *     the guard then FAILED naming it — the artifact created the debris and the
 *     guard tripped on it, breaking `proof-or-stop validate` for a registration gap
 *     that did not exist. The file was not gitignored either, so it could be
 *     committed by accident.
 *   - the startup sweep does not save it: it is itself racy. Two concurrent runs
 *     interleave plant and sweep, so one run's sweep deletes the other's live
 *     probe, or one run's assertion sees the other's. Shared mutable state in a
 *     policed directory cannot be made safe by tidying it more carefully.
 *
 * So probes are now planted ONLY inside a private `mkdtemp` mirror of the
 * repository (`makeMirror`), and the guards are spawned against that mirror
 * through `--preserve-symlinks-main`, running bytes asserted sha256-identical to
 * the committed files. Concurrent runs no longer share any path, and a SIGKILL
 * can strand nothing except a temporary directory that is outside every guarded
 * population — debris that cannot make any guard fail, rather than debris that is
 * merely less likely. `REPO_TREE_NEVER_WRITTEN_TO` measures this: the guarded
 * directories must hold exactly the same entries after the run as before it.
 * `sweepLegacyProbeDebris` remains only to clear marker-carrying debris a pre-fix
 * run may already have stranded in somebody's tree.
 *
 * ── A MIRROR THE TARGETS CANNOT TELL FROM THE REPOSITORY ────────────────────
 *
 * A mirror that is faithful to the guard this file was written around is not
 * automatically faithful to a guard derived into the target set later. The mirror
 * is mostly symlinks, and a real directory holding symlinks reads as EMPTY to
 * `readdirSync(…, { withFileTypes: true })`, which classifies a symlink as neither
 * a file nor a directory. `red-1734-desktop-asset-manifest.mjs` derives the desktop
 * asset manifest through exactly that call, so it saw no files under
 * `packages/main/dist` — a directory forced to be real because BLOCK D materializes
 * `packages/main/dist/tasks` — and failed here for a reason the mirror invented.
 * Two things answer that: `hydrateDirs` reproduces such a tree as real directories
 * of byte copies, and the pre-plant baseline now runs EVERY target rather than the
 * two required ones, so `NEWCOMER_MIRROR_IS_FAITHFUL` fails when the mirror is what
 * broke instead of leaving it to be read out of a clipped excerpt downstream.
 *
 * ── SELF-INCLUSION ──────────────────────────────────────────────────────────
 *
 * The BLOCK C population is enumerated unfiltered, so THIS file and its receipt
 * are inside it with no self-exception: this file is registered, and its receipt
 * is decided by an exclusion entry that states why — neither is carved out of the
 * population to make the row pass. The only thing excluded anywhere is a spawn
 * cycle: BLOCK D does not spawn a file that spawns this one, which is a recursion
 * break, not a coverage carve-out — and it is now audited rather than silent.
 *
 * Run from anywhere:
 *   node packages/main/tests/red/red-b49d4-registration-derivation.mjs
 */
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');            // packages/main
const repoRoot = join(pkgRoot, '..', '..');        // repository root
const SELF = basename(fileURLToPath(import.meta.url));

const RED_DIR_REL = 'packages/main/tests/red';
const MAIN_DIST_REL = 'packages/main/dist';
const DIST_TASKS_REL = `${MAIN_DIST_REL}/tasks`;
const SRC_TASKS_REL = 'packages/main/src/tasks';
// B-cc10: resolve whichever config filename exists. The canonical name is now
// proof-or-stop.config.json, so a hardcoded deprecated name threw ENOENT here.
const CONFIG_REL = (['proof-or-stop.config.json', 'proof-or-stop.config.json'].find((n) => existsSync(join(repoRoot, n))) ?? 'proof-or-stop.config.json');
const CONFIG_PATH = join(repoRoot, CONFIG_REL);

/** The guard this story names. It is spawned as a REAL child process, never imitated. */
const GUARD_REL = `${RED_DIR_REL}/red-w2c-validate-registration.mjs`;
const GUARD_ABS = join(repoRoot, GUARD_REL);

/**
 * THE DECISION AUTHORITY for `packages/main/tests/red`, used by BLOCK C.
 *
 * It is REGISTERED in `validate.commands`, it enumerates this directory TOTALLY
 * (no name pattern, no extension filter), and it exits non-zero NAMING any entry
 * that is neither registered nor carried by an exclusion entry whose reason is
 * length-checked at runtime. BLOCK C SPAWNS it and uses its live verdict; it does
 * not re-implement it, because a re-implementation here could pass while the
 * shipped one is blind.
 */
const DECIDER_REL = `${RED_DIR_REL}/red-b49d4-harness-registration.mjs`;
const DECIDER_ABS = join(repoRoot, DECIDER_REL);

/** The population the named guard governs: dist red-evidence tasks. */
const DIST_MEMBER_RE = /^red-evidence-.*\.js$/;

// ── probes ──────────────────────────────────────────────────────────────────
// Every probe is planted inside a PRIVATE TEMPORARY MIRROR of the repository
// (see makeMirror below), never inside the repository itself. The paths below
// are therefore mirror-relative: `packages/main/...` under a `mkdtemp` root.
const BLIND_BASE = 'red-evidence-b49d4-blindness-probe';
const BLIND_DIST_REL = `${DIST_TASKS_REL}/${BLIND_BASE}.js`;
const BLIND_SRC_REL = `${SRC_TASKS_REL}/${BLIND_BASE}.ts`;
/**
 * DELIBERATELY NOT `red-*`. The declared population is `*.mjs` in the red
 * directory; a `red-b49d4-*` name would still pass a derivation narrowed to
 * `/^red-.*\.mjs$/`, which is the same defect one prefix over.
 */
const NEWCOMER_BASE = 'b49d4-newcomer-probe-unprefixed.mjs';
const NEWCOMER_REL = `${RED_DIR_REL}/${NEWCOMER_BASE}`;

/** Directories whose contents are policed by the guards this artifact spawns. */
const GUARDED_DIRS = [RED_DIR_REL, DIST_TASKS_REL, SRC_TASKS_REL];

/**
 * PRE-FIX DEBRIS ONLY.
 *
 * An earlier version of this artifact planted these three paths in the WORKING
 * TREE and removed them in `try/finally` after a startup sweep. Both are best
 * effort: `finally` does not run through SIGKILL or a watchdog kill, and the
 * startup sweep is itself racy — two concurrent runs interleave plant and sweep,
 * so one run's sweep can delete the other's live probe or its assertion can see
 * the other's. Either way `${NEWCOMER_REL}` survives inside a population that
 * `red-b49d4-harness-registration.mjs` enumerates TOTALLY, and that guard then
 * fails naming it: the artifact stranded the debris and the guard tripped on it.
 *
 * Nothing writes these paths any more, so the sweep below exists purely to clear
 * debris a pre-fix run may already have stranded in somebody's tree. It is gated
 * on the planted-by marker, so it can never delete a file that this artifact did
 * not write.
 */
const LEGACY_PROBE_RELS = [BLIND_DIST_REL, BLIND_SRC_REL, NEWCOMER_REL];
const PLANTED_BY_MARKER = `PLANTED BY ${RED_DIR_REL}/${SELF}`;

const sweepLegacyProbeDebris = () => {
  const swept = [];
  for (const rel of LEGACY_PROBE_RELS) {
    const abs = join(repoRoot, rel);
    let text = null;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(PLANTED_BY_MARKER)) continue;   // not ours: never touch it
    rmSync(abs, { force: true });
    swept.push(rel);
  }
  return swept;
};

/**
 * A PRIVATE MIRROR of the repository root, mostly built from symlinks so it is
 * byte-faithful. Git administration is never linked: each mirror owns its refs,
 * HEAD and index, with read-only object lookup through an alternates file.
 * No source Git config, credentials or hooks are copied. `writableFiles` are the only paths the
 * caller may write: each is left absent (the caller creates it) and every
 * ancestor directory is materialized as a REAL directory whose other entries are
 * symlinks to the real ones. `materializeDirs` does the same for a directory the
 * caller does not write but wants REAL, so that a spawned child which plants its
 * own probe there lands in this mirror instead of in the repository.
 *
 * `copyDirs` goes one step further: that directory's files are BYTE COPIES
 * rather than symlinks. A symlink is a mode change (100644 → 120000) to git, so a
 * guard that asserts its own working-tree cleanliness — `red-b2aa7-chk007-receipt
 * .mjs` runs `git diff --name-only HEAD --` over a file in the red directory —
 * fails inside a symlinked mirror for a reason that has nothing to do with what
 * is being tested. Copies are indistinguishable from the real entries to git, and
 * unlike a hard link a write to a copy cannot reach the repository. Byte identity
 * with the committed file is ASSERTED per target in BLOCK D rather than assumed.
 * Sub-directories inside a copied directory are symlinked, not copied.
 *
 * `hydrateDirs` reproduces a whole sub-tree as REAL directories holding BYTE
 * COPIES, because materializing a directory makes its PARENT real too, and a real
 * directory full of symlinks is not faithful to every reader. `readdirSync(…,
 * { withFileTypes: true })` classifies a symlink entry as neither `isFile()` nor
 * `isDirectory()`, so a guard that enumerates that way sees an EMPTY directory
 * where the repository has files. That is not hypothetical: materializing
 * `packages/main/dist/tasks` forced `packages/main/dist` to be a real directory of
 * symlinks, and `red-1734-desktop-asset-manifest.mjs` — which derives the desktop
 * asset manifest by evaluating `listFiles()` out of `scripts/package-desktop.mjs`,
 * and that function filters on exactly those two Dirent predicates — derived an
 * EMPTY file list for `packages/main/dist` instead of the compiled tree the
 * checkout holds, and failed inside the mirror for a reason that has nothing to do
 * with the newcomer.
 * Hydration is opt-in per directory rather than automatic, because "make every
 * entry under every materialized ancestor real" reaches the repository root and
 * would copy `node_modules` and every sibling worktree.
 *
 * Guards are then executed through `--preserve-symlinks-main`: the main module
 * keeps its mirror path, so the guard resolves its repository root to the mirror
 * while running bytes that are identical to the committed file. A kill at any
 * moment can therefore strand nothing except a directory under `os.tmpdir()`,
 * which is outside every guarded population and cannot make any guard fail.
 */
function makeMirror(prefix, { writableFiles = [], materializeDirs = [], copyDirs = [], hydrateDirs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const mustBeReal = new Set();
  const copied = new Set(copyDirs);
  const hydrated = new Set(hydrateDirs);
  const addAncestors = (rel) => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) mustBeReal.add(parts.slice(0, i).join('/'));
  };
  for (const rel of writableFiles) addAncestors(rel);
  for (const rel of [...materializeDirs, ...copyDirs, ...hydrateDirs]) {
    addAncestors(rel);
    mustBeReal.add(rel);
  }
  const skip = new Set(writableFiles);
  const walk = (relDir, hydrating) => {
    const inCopiedDir = copied.has(relDir);
    for (const entry of readdirSync(relDir === '' ? repoRoot : join(repoRoot, relDir))) {
      const childRel = relDir === '' ? entry : `${relDir}/${entry}`;
      if (childRel === '.git' || skip.has(childRel)) continue;
      const src = join(repoRoot, childRel);
      const dest = join(root, childRel);
      const childHydrating = hydrating || hydrated.has(childRel);
      // Inside a hydrated sub-tree every directory is real and every file is a
      // copy, so `withFileTypes` classification matches the repository exactly.
      if (mustBeReal.has(childRel) || (childHydrating && statSync(src).isDirectory())) {
        mkdirSync(dest);
        walk(childRel, childHydrating);
        continue;
      }
      if ((inCopiedDir || hydrating) && !statSync(src).isDirectory()) {
        copyFileSync(src, dest);
        continue;
      }
      symlinkSync(src, dest);
    }
  };
  walk('', false);
  initializePrivateGit(root, repoRoot);
  return root;
}

function initializePrivateGit(root, sourceRoot) {
  const source = gitIdentity(sourceRoot);
  const format = gitText(sourceRoot, ['rev-parse', '--show-object-format']);
  gitRead(root, ['init', '--quiet', '--template=', `--object-format=${format}`]);
  const admin = join(root, '.git');
  const objects = realpathSync(gitText(sourceRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']));
  writeFileSync(join(admin, 'objects', 'info', 'alternates'), `${objects}\n`);
  // for-each-ref includes packed refs without linking either refs or packed-refs.
  const refs = gitText(sourceRoot, ['for-each-ref', '--format=%(objectname) %(refname)']);
  if (refs) gitRead(root, ['update-ref', '--stdin'], refs.split('\n').map(line => {
    const [object, ref] = line.split(' ');
    return `update ${ref} ${object}\n`;
  }).join(''));
  copyFileSync(join(source.admin, 'HEAD'), join(admin, 'HEAD'));
  copyFileSync(source.index, join(admin, 'index'));
  // A split index refers to a sharedindex.<hash> companion, which must also be
  // PRIVATE. Its bytes are copied, never shared or converted via the real index.
  const shared = gitText(sourceRoot, ['rev-parse', '--path-format=absolute', '--shared-index-path']);
  if (shared) copyFileSync(resolve(sourceRoot, shared), join(admin, basename(shared)));
}

// ── row reporting ───────────────────────────────────────────────────────────
const rows = [];
/** Measured side-notes that are not pass/fail rows of their own. */
const observations = [];
const row = (id, block, green, observed, required) => {
  rows.push({ id, block, green: green === true, observed, required });
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Local Git discovery must follow each fixture's own .git, never an inherited
// repository/index override that also leaks into fixtures created by children.
const localGitEnvironment = (inherited = process.env) => {
  const env = { ...inherited, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  return env;
};
const gitRead = (root, args, input) => execFileSync('git', ['--no-optional-locks', ...args], {
  cwd: root, env: localGitEnvironment(), maxBuffer: 64 * 1024 * 1024,
  ...(input !== undefined ? { input } : {}),
});
const gitText = (root, args) => gitRead(root, args).toString('utf8').trim();
function gitIdentity(root) {
  return {
    admin: realpathSync(gitText(root, ['rev-parse', '--absolute-git-dir'])),
    common: realpathSync(gitText(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    index: realpathSync(gitText(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])),
  };
}
function gitSnapshot(root) {
  const identity = gitIdentity(root);
  return { ...identity, head: gitText(root, ['rev-parse', 'HEAD']),
    indexDigest: sha256(readFileSync(identity.index)),
    stagesDigest: sha256(gitRead(root, ['ls-files', '--stage', '-z'])),
  };
}
function requirePrivateGit(mirror, source) {
  const actual = gitIdentity(mirror);
  assert.notEqual(actual.admin, source.admin, 'mirror must have private Git admin, not the real repository .git');
  assert.notEqual(actual.common, source.common, 'mirror must have private Git refs/config, not a shared common directory');
  assert.notEqual(actual.index, source.index, 'mirror must have a private Git index');
  for (const path of Object.values(actual)) assert.ok(path.startsWith(`${realpathSync(mirror)}/`), 'Git administration must stay inside the private mirror');
  return actual;
}

const REAL_GIT_BEFORE = gitSnapshot(repoRoot);
let isolationMirror = null;
let sharedAdminControl = null;
let splitMirror = null;
try {
  // Deterministic RED on the old symlink mirror, before ANY index-write probe.
  isolationMirror = makeMirror('red-b49d4-index-isolation-', { copyDirs: [RED_DIR_REL] });
  const identity = requirePrivateGit(isolationMirror, REAL_GIT_BEFORE);
  const before = gitSnapshot(isolationMirror);
  assert.equal(before.head, REAL_GIT_BEFORE.head, 'private mirror preserves the real committed HEAD');
  assert.equal(before.stagesDigest, REAL_GIT_BEFORE.stagesDigest, 'private mirror preserves the complete staged index');

  sharedAdminControl = mkdtempSync(join(tmpdir(), 'red-b49d4-shared-admin-control-'));
  symlinkSync(join(repoRoot, '.git'), join(sharedAdminControl, '.git'));
  assert.throws(() => requirePrivateGit(sharedAdminControl, REAL_GIT_BEFORE), /private Git admin/,
    'the same isolation check must reject the original shared-admin layout without writing to it');

  // Only after proving private identity, alter the disposable index and observe
  // real Git behavior. This never corrupts or refreshes the real index.
  const savedIndex = readFileSync(identity.index);
  gitRead(isolationMirror, ['update-index', '--force-remove', '--', CONFIG_REL]);
  assert.equal(gitText(isolationMirror, ['ls-files', '--', CONFIG_REL]), '', 'private index mutation actually bites');
  assert.notEqual(gitSnapshot(isolationMirror).stagesDigest, before.stagesDigest);
  assert.deepEqual(gitSnapshot(repoRoot), REAL_GIT_BEFORE, 'private index mutation cannot affect real Git state');
  writeFileSync(identity.index, savedIndex);
  assert.deepEqual(gitSnapshot(isolationMirror), before, 'private index restoration is exact');

  // Exercise packed refs and split-index companions using ONLY disposable Git
  // administration. Ordinary nested fixtures must discover their own index even
  // if an outer caller supplied repository/index overrides.
  gitRead(isolationMirror, ['pack-refs', '--all']);
  gitRead(isolationMirror, ['update-index', '--split-index']);
  const sharedIndex = gitText(isolationMirror, ['rev-parse', '--path-format=absolute', '--shared-index-path']);
  assert.ok(sharedIndex, 'split-index control actually creates a companion');
  splitMirror = mkdtempSync(join(tmpdir(), 'red-b49d4-split-index-'));
  initializePrivateGit(splitMirror, isolationMirror);
  const splitIdentity = requirePrivateGit(splitMirror, gitIdentity(isolationMirror));
  assert.equal(gitSnapshot(splitMirror).stagesDigest, before.stagesDigest, 'split-index snapshot preserves stages');
  assert.equal(gitText(splitMirror, ['rev-parse', 'HEAD']), before.head, 'split-index snapshot preserves HEAD');
  assert.equal(gitText(splitMirror, ['for-each-ref', '--format=%(objectname) %(refname)']),
    gitText(isolationMirror, ['for-each-ref', '--format=%(objectname) %(refname)']), 'packed refs remain readable and exact');
  const copiedShared = gitText(splitMirror, ['rev-parse', '--path-format=absolute', '--shared-index-path']);
  assert.notEqual(realpathSync(copiedShared), realpathSync(sharedIndex), 'split-index companion is private');
  assert.equal(sha256(readFileSync(copiedShared)), sha256(readFileSync(sharedIndex)), 'split-index companion bytes are faithful');
  const nestedEnv = localGitEnvironment({ ...process.env, GIT_INDEX_FILE: identity.index,
    GIT_DIR: identity.admin, GIT_COMMON_DIR: identity.common, GIT_WORK_TREE: isolationMirror });
  assert.equal(nestedEnv.GIT_INDEX_FILE, undefined, 'never export a parent index into nested fixtures');
  const nestedIndex = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    { cwd: splitMirror, env: nestedEnv, encoding: 'utf8' }).trim();
  assert.equal(realpathSync(nestedIndex), splitIdentity.index, 'nested Git resolves its own index despite caller overrides');
  console.log('GREEN private Git index isolation');
} finally {
  if (splitMirror !== null) rmSync(splitMirror, { recursive: true, force: true });
  if (isolationMirror !== null) rmSync(isolationMirror, { recursive: true, force: true });
  if (sharedAdminControl !== null) rmSync(sharedAdminControl, { recursive: true, force: true });
}
const clip = (s, n = 300) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Integers that stand alone, so identifiers such as `b49d4` or `v1` cannot be
 * mistaken for a reported count.
 */
const standaloneIntegers = (text) => [...String(text).matchAll(/(?<![\w.-])(\d+)(?![\w.-])/g)]
  .map((m) => Number(m[1]));
const largestCount = (text) => {
  const ns = standaloneIntegers(text);
  return ns.length === 0 ? null : Math.max(...ns);
};

/**
 * BOUNDED CHILD EXECUTION (B-bcae F-054).
 *
 * BLOCK D spawns every derived target TWICE — the pre-plant baseline and the
 * post-plant run — and several of those targets carry their own registered
 * budgets, one of them equal to this file's. Nothing inside this guard used to
 * bound a child: `spawnSync` was called with no timeout, so the only thing that
 * could stop an over-budget aggregate was the OUTER validation killing this
 * process mid-run. That surfaces as "the registration-derivation guard failed",
 * not as budget exhaustion — precisely the misattribution the widened baseline
 * exists to prevent, arriving through the mechanism the widening introduced.
 *
 * So spend a budget derived from THIS file's own registered row and fail with an
 * attributable message when it runs out. Each child is capped by whichever is
 * smaller: the budget still remaining, or that target's OWN registered timeout
 * (so a target is never given less than it declares it needs while the aggregate
 * still holds). A spawn attempted with nothing left returns a synthetic non-zero
 * result naming the exhaustion rather than starting a process that cannot finish.
 * With no registered row to read, the budget is unbounded and behaviour is
 * unchanged — running this guard by hand is not budgeted by anything.
 */
const SPAWN_BUDGET_RESERVE_MS = 45_000;      // config parsing, mirror construction, digests, the report
const UNREGISTERED_TARGET_TIMEOUT_MS = 120_000;
let spawnBudgetRemainingMs = Infinity;
let registeredTimeoutForRel = () => null;
const spawnBudgetIncidents = [];

let spawnMs = 0;
function runNode(args, cwd = repoRoot, rel = null) {
  if (spawnBudgetRemainingMs <= 0) {
    const note = `SPAWN_BUDGET_EXHAUSTED: this guard's aggregate child-process budget ran out before `
      + `${rel ?? args[args.length - 1]} could be spawned. The row below is a BUDGET result, not a `
      + `verdict about that target`;
    spawnBudgetIncidents.push(note);
    return { status: 124, stdout: '', stderr: note, out: note, ms: 0 };
  }
  const timeout = Math.min(
    spawnBudgetRemainingMs,
    (rel === null ? null : registeredTimeoutForRel(rel)) ?? UNREGISTERED_TARGET_TIMEOUT_MS,
  );
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: localGitEnvironment(), timeout });
  const ms = Date.now() - started;
  spawnMs += ms;
  spawnBudgetRemainingMs -= ms;
  const timedOut = Boolean(r.error) && (r.error.code === 'ETIMEDOUT' || r.signal !== null);
  const note = timedOut
    ? `\nSPAWN_TIMEOUT: ${rel ?? args[args.length - 1]} was killed after ${ms}ms (cap ${timeout}ms). The row `
      + `below is a BUDGET result, not a verdict about that target`
    : '';
  if (timedOut) spawnBudgetIncidents.push(note.trim());
  return {
    status: timedOut ? 124 : r.status,
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${note}`,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}${note}`,
    ms,
  };
}

// ── proof-or-stop.config.json is READ-ONLY here ───────────────────────────────────
const configBytes = readFileSync(CONFIG_PATH);
const CONFIG_DIGEST_BEFORE = sha256(configBytes);
const configRaw = configBytes.toString('utf8');
const config = JSON.parse(configRaw);

/** Normalize a validate.commands entry (bare string OR {command,args}) to its argv. */
function entryArgv(entry) {
  if (typeof entry === 'string') return entry.trim().split(/\s+/);
  if (entry && typeof entry === 'object') return [entry.command, ...(entry.args ?? [])].map(String);
  return [];
}
function registeredTokens(cfg) {
  const tokens = new Set();
  for (const entry of cfg?.validate?.commands ?? []) {
    for (const token of entryArgv(entry)) tokens.add(token);
  }
  return tokens;
}

// Arm the spawn budget from the live registered rows (see the runNode block above).
const registeredRowFor = (rel) => (config?.validate?.commands ?? [])
  .find((entry) => entryArgv(entry).includes(rel));
registeredTimeoutForRel = (rel) => {
  const row = registeredRowFor(rel);
  return row && typeof row.timeoutMs === 'number' && row.timeoutMs > 0 ? row.timeoutMs : null;
};
const SELF_REGISTERED_TIMEOUT_MS = registeredTimeoutForRel(`${RED_DIR_REL}/${SELF}`);
spawnBudgetRemainingMs = SELF_REGISTERED_TIMEOUT_MS === null
  ? Infinity
  : Math.max(30_000, SELF_REGISTERED_TIMEOUT_MS - SPAWN_BUDGET_RESERVE_MS);

/** Enumerate the dist red-evidence family under ANY root (the repo, or a mirror). */
const distMembersIn = (root) => readdirSync(join(root, DIST_TASKS_REL))
  .filter((n) => DIST_MEMBER_RE.test(n)).sort();

/** Run a REAL committed guard whose repository root resolves to `mirrorRoot`. */
const runInMirror = (mirrorRoot, rel) => runNode(['--preserve-symlinks-main', join(mirrorRoot, rel)], mirrorRoot, rel);

const gitStatusFor = (paths) => {
  try {
    return gitText(repoRoot, ['status', '--porcelain', '--', ...paths]);
  } catch {
    return null;
  }
};
/** A digest of the guarded directories' listings, so ANY appearing file is caught. */
const guardedListingDigest = () => sha256(GUARDED_DIRS.map((dir) => {
  let names = [];
  try {
    names = readdirSync(join(repoRoot, dir)).sort();
  } catch {
    names = ['<unreadable>'];
  }
  return `${dir}\n${names.join('\n')}`;
}).join('\n---\n'));

// Clear debris a PRE-FIX run may have stranded, then snapshot the guarded
// directories. Everything below writes only into private temporary mirrors, so
// this snapshot must still hold at the end of the run (BLOCK E).
const sweptLegacy = sweepLegacyProbeDebris();
const LISTING_DIGEST_BEFORE = guardedListingDigest();
const GIT_STATUS_BEFORE = gitStatusFor(GUARDED_DIRS);

try {
  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK 0 — the experiment's floor: the guard passes on the untouched tree.
  //           Without this, a RED result below could just be a broken tree.
  // ══════════════════════════════════════════════════════════════════════════
  const cleanDistPop = distMembersIn(repoRoot);
  const baseline = runNode([GUARD_ABS]);
  const baselineCount = largestCount(baseline.stdout);
  row(
    'GUARD_PASSES_ON_UNTOUCHED_TREE', '0',
    baseline.status === 0,
    `exit=${baseline.status} out="${clip(baseline.out, 200)}"`,
    'the guard must pass on the unmodified tree, or every RED row below is about a broken tree instead of about the guard',
  );
  row(
    'CLEAN_SUCCESS_LINE_COVERS_THE_POPULATION', '0',
    baseline.status !== 0 || baselineCount === null || baselineCount >= cleanDistPop.length,
    `largest count reported=${baselineCount} vs ${cleanDistPop.length} ${DIST_TASKS_REL}/red-evidence-*.js on disk`,
    'a success line must never claim fewer members than exist on disk',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK A — BLINDNESS. A genuine, unregistered, non-zero-exiting member of
  //           the guard's OWN population leaves it at exit 0. The member is
  //           planted in a PRIVATE MIRROR, never in the repository.
  // ══════════════════════════════════════════════════════════════════════════
  const probeBody = [
    '#!/usr/bin/env node',
    `// ${PLANTED_BY_MARKER} (B-49d4 CHK-001).`,
    '// A genuine member of the packages/main/dist/tasks/red-evidence-*.js population that is',
    '// registered NOWHERE in proof-or-stop.config.json validate.commands. It exits NON-ZERO, so if',
    '// `proof-or-stop validate` ran it, validate would fail. Nothing runs it, and nothing notices.',
    '// It lives in a private temporary mirror of the repository and is never written to the',
    '// repository, so a kill at any moment can strand nothing that any guard enumerates.',
    "process.stderr.write('red-evidence-b49d4-blindness-probe: FAIL (unregistered member, deliberately non-zero)\\n');",
    'process.exit(3);',
    '',
  ].join('\n');

  let blindMirror = null;
  let blinded = null;
  let withProbePop = [];
  try {
    blindMirror = makeMirror('red-b49d4-blindness-', { writableFiles: [BLIND_DIST_REL, BLIND_SRC_REL] });

    // A1 — the mirror is faithful: the guard still passes before anything is
    //      planted, so the blindness result below is attributable to the probe.
    const mirrorClean = runInMirror(blindMirror, GUARD_REL);
    row(
      'BLINDNESS_MIRROR_IS_FAITHFUL', 'A',
      mirrorClean.status === 0,
      `guard run against the untouched mirror exit=${mirrorClean.status} out="${clip(mirrorClean.out, 160)}"`,
      'the guard must still pass inside the mirror before the probe is planted, or the mirror — not the probe — is '
      + 'what failed it',
    );

    writeFileSync(join(blindMirror, BLIND_DIST_REL), probeBody, 'utf8');
    writeFileSync(join(blindMirror, BLIND_SRC_REL), probeBody, 'utf8');

    const probeRun = runNode([join(blindMirror, BLIND_DIST_REL)], blindMirror);
    // F-007. This row used to assert three things this very block had just
    // GUARANTEED: that a script whose body is the literal `process.exit(3)` this
    // file wrote exits non-zero, that a file this file wrote two lines earlier
    // exists, and that paths nothing ever writes into the repository are absent.
    // None of those can fail for a reason outside this block's own construction,
    // so the row was a setup note counted as a guard-behavior proof point. The
    // DISCRIMINATING question is whether the probe is shaped like the members it
    // is standing in for, and that is a property of the REPOSITORY: if the real
    // `red-evidence-*.js` family did not carry `src/tasks/*.ts` counterparts, a
    // probe that carries one would be distinguishable from a real member and
    // BLOCK A would be testing a straw member. So the verdict is now measured
    // over the REAL members, and the construction facts are REPORTED rather than
    // asserted. The mirror-only conjuncts are dropped outright: BLOCK E's
    // `REPO_TREE_NEVER_WRITTEN_TO` measures the guarded directories' listing
    // digest before and after, which is a real observation of the same thing.
    const realSrcCounterparts = cleanDistPop.map((n) => n.replace(/\.js$/, '.ts'));
    const missingSrcCounterparts = realSrcCounterparts
      .filter((n) => !existsSync(join(repoRoot, SRC_TASKS_REL, n)));
    row(
      'PLANTED_MEMBER_MATCHES_THE_SHAPE_OF_REAL_MEMBERS', 'A',
      cleanDistPop.length > 0 && missingSrcCounterparts.length === 0
      && existsSync(join(blindMirror, BLIND_SRC_REL)) && existsSync(join(blindMirror, BLIND_DIST_REL)),
      `MEASURED on the repository (this is the conjunct that can fail): all ${cleanDistPop.length} real `
      + `${DIST_TASKS_REL}/red-evidence-*.js members carry a ${SRC_TASKS_REL} counterpart — missing: `
      + `${missingSrcCounterparts.join(', ') || 'none'} — so a dist+src pair is exactly the shape of a real member. `
      + `REPORTED, not asserted (guaranteed by the body this block just wrote): the probe exits ${probeRun.status}`,
      `the planted member must match the shape real members have ON DISK. If the ${DIST_TASKS_REL} family did not `
      + `carry ${SRC_TASKS_REL} counterparts, this probe would be distinguishable from a real member and the blindness `
      + 'result below would be about a straw member instead of a genuine one',
    );

    const probeTokens = registeredTokens(config);
    row(
      'PLANTED_MEMBER_IS_REGISTERED_NOWHERE', 'A',
      !probeTokens.has(BLIND_DIST_REL),
      `${BLIND_DIST_REL} present in validate.commands=${probeTokens.has(BLIND_DIST_REL)}`,
      'the planted member must be absent from validate.commands, or the blindness question is not being asked',
    );

    blinded = runInMirror(blindMirror, GUARD_REL);
    withProbePop = distMembersIn(blindMirror);
  } finally {
    if (blindMirror !== null) rmSync(blindMirror, { recursive: true, force: true });
  }

  const reportedCount = largestCount(blinded.stdout);
  const successLine = blinded.stdout.split('\n').find((l) => l.trim() !== '') ?? '';

  row(
    'GUARD_DETECTS_UNREGISTERED_MEMBER', 'A',
    blinded.status !== 0 && blinded.out.includes(BLIND_BASE),
    `exit=${blinded.status}; names the probe=${blinded.out.includes(BLIND_BASE)}; `
    + `population on disk=${withProbePop.length} (${withProbePop.join(', ')})`,
    `the guard must fail and name ${BLIND_DIST_REL}: it is a member of the very population the guard reports on, `
    + 'it is registered nowhere, and it exits non-zero',
  );
  row(
    'SUCCESS_LINE_COUNTS_THE_POPULATION_NOT_THE_EXPECTATION', 'A',
    !(blinded.status === 0 && reportedCount !== null && reportedCount < withProbePop.length),
    `exit=${blinded.status}; largest count in the success line=${reportedCount} while ${withProbePop.length} members `
    + `exist on disk; line="${clip(successLine, 220)}"`,
    'a confident success line must never report fewer members than exist on disk — a count that cannot move when the '
    + 'population moves is the size of the expectation, which is why this guard can never reveal a gap',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK B — CONTROL. De-register a currently-listed command against a COPY of
  //           the config and require the guard to bite. The real config is never
  //           written to (BLOCK E re-checks its digest).
  // ══════════════════════════════════════════════════════════════════════════
  const realTokens = registeredTokens(config);
  const victim = [...realTokens]
    .filter((t) => DIST_MEMBER_RE.test(basename(t)) && t.startsWith(`${DIST_TASKS_REL}/`))
    .sort()[0] ?? null;

  let sandboxRoot = null;
  try {
    // A faithful mirror: every repository-root entry symlinked, EXCEPT the one
    // file under test, which is a writable copy.
    sandboxRoot = makeMirror('red-b49d4-control-', { writableFiles: [CONFIG_REL] });
    const sandboxConfig = join(sandboxRoot, CONFIG_REL);
    // `--preserve-symlinks-main` keeps the main module's symlinked path, so the
    // REAL guard file executes yet resolves its repository root to the sandbox.
    const runSandbox = () => runInMirror(sandboxRoot, GUARD_REL);

    // B1 — the sandbox is faithful: an unmutated copy still passes.
    writeFileSync(sandboxConfig, configRaw, 'utf8');
    const faithful = runSandbox();
    row(
      'SANDBOX_IS_FAITHFUL', 'B',
      faithful.status === 0,
      `exit=${faithful.status} out="${clip(faithful.out, 200)}"`,
      'with an UNMUTATED copy of the config the guard must still pass, or the sandbox — not the mutation — is what failed it',
    );

    // B2 — the redirect really happened: an empty command list must fail. This is
    //      what stops a non-biting control from being mistaken for a healthy one.
    const emptied = JSON.parse(configRaw);
    emptied.validate.commands = [];
    writeFileSync(sandboxConfig, `${JSON.stringify(emptied, null, 2)}\n`, 'utf8');
    const redirected = runSandbox();
    row(
      'SANDBOX_REDIRECTS_THE_CONFIG_READ', 'B',
      redirected.status !== 0,
      `with validate.commands=[] the guard exited ${redirected.status}: "${clip(redirected.out, 200)}"`,
      'the guard must fail when the copy it reads registers nothing; if it passes, it read the REAL config and the '
      + 'control below would prove nothing either way',
    );

    // B3 — the control proper: one currently-listed command removed.
    if (victim === null) {
      row('CONTROL_DEREGISTRATION_BITES', 'B', false,
        'no packages/main/dist/tasks/red-evidence-*.js entry found in validate.commands to de-register',
        'a currently-listed command must exist to serve as the control');
    } else {
      const mutated = JSON.parse(configRaw);
      const before = mutated.validate.commands.length;
      mutated.validate.commands = mutated.validate.commands
        .filter((entry) => !entryArgv(entry).includes(victim));
      writeFileSync(sandboxConfig, `${JSON.stringify(mutated, null, 2)}\n`, 'utf8');
      const control = runSandbox();
      row(
        'CONTROL_DEREGISTRATION_BITES', 'B',
        before > mutated.validate.commands.length
        && control.status !== 0 && control.out.includes(victim),
        `removed ${victim} (${before} → ${mutated.validate.commands.length} commands); exit=${control.status}; `
        + `names the victim=${control.out.includes(victim)}`,
        'de-registering a currently-listed command must make the guard exit non-zero AND name it, so the blindness '
        + 'result above cannot be a broken experiment',
      );
      row(
        'CONTROL_USED_A_COPY_NOT_THE_REAL_CONFIG', 'B',
        readFileSync(sandboxConfig, 'utf8') !== configRaw && sha256(readFileSync(CONFIG_PATH)) === CONFIG_DIGEST_BEFORE,
        `sandbox copy differs from the real file=${readFileSync(sandboxConfig, 'utf8') !== configRaw}; `
        + `real ${CONFIG_REL} sha256 still ${CONFIG_DIGEST_BEFORE.slice(0, 16)}…`,
        'the mutation must live in the copy while the real config stays byte-identical',
      );
    }
  } finally {
    if (sandboxRoot !== null) rmSync(sandboxRoot, { recursive: true, force: true });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK C — POPULATION. Derived, never hardcoded.
  // ══════════════════════════════════════════════════════════════════════════
  // The derivation below counts what is on disk, so a stranded probe from a
  // PRE-FIX run would corrupt it. Nothing plants these paths any more and the
  // startup sweep clears marked debris, so this is a reported row rather than a
  // throw: a RED row naming the file beats an uncaught error with no report.
  const strandedDebris = LEGACY_PROBE_RELS.filter((rel) => existsSync(join(repoRoot, rel)));
  row(
    'NO_PRE_FIX_PROBE_DEBRIS_IN_THE_REPOSITORY', 'C',
    strandedDebris.length === 0,
    `probe paths present in the working tree: ${strandedDebris.join(', ') || 'none'}`
    + `${sweptLegacy.length > 0 ? ` (startup sweep removed marked pre-fix debris: ${sweptLegacy.join(', ')})` : ''}`,
    'no probe path may exist in the repository while the population is derived from disk; probes are planted only in '
    + 'private temporary mirrors, so anything here is unmarked debris a pre-fix run stranded — delete it',
  );

  /**
   * THE DERIVATION (run over the real config AND over mutated inputs below, so a
   * clean bill of health cannot be vacuous).
   *
   * Population: every `*.mjs` in the red directory, enumerated UNFILTERED — no
   * name pattern, because a pattern is what leaves a differently-prefixed
   * newcomer invisible.
   *
   * `decided` is a FIRST-CLASS INPUT, not something inferred from the population's
   * own text. A member is decided when its non-registration is a recorded,
   * audited choice. That is a DIFFERENT property from being executed, and the two
   * are deliberately not conflated: this function reports what is accounted for,
   * and reports nothing at all about what runs.
   */
  function derive(tokens, decided) {
    const population = readdirSync(here).filter((n) => n.endsWith('.mjs')).sort();
    const registered = population.filter((n) => tokens.has(`${RED_DIR_REL}/${n}`));
    const registeredSet = new Set(registered);
    const unregistered = population.filter((n) => !registeredSet.has(n));
    return {
      population,
      registered,
      unregistered,
      decided: unregistered.filter((n) => decided.has(n)),
      unaccounted: unregistered.filter((n) => !decided.has(n)),
    };
  }

  /**
   * WHERE `decided` COMES FROM — measured first, then named.
   *
   * The VERDICT is measured: the decision authority is spawned as a real child
   * process against the untouched tree. It enumerates this directory TOTALLY and
   * exits non-zero naming any entry that is neither registered nor carried by an
   * exclusion entry whose reason it length-checks. Its exit-0 therefore MEANS
   * "every entry here is registered or decided", and its population is asserted
   * to be at least this block's (an inequality, so it cannot go stale the way a
   * quoted count does).
   *
   * The NAMES are then read from that guard's exclusion record as DATA — the
   * literal keys of its declared map, scoped to the map body so that an unrelated
   * path constant elsewhere in the file cannot masquerade as a decision. This is
   * reading a decision somebody recorded, NOT inferring behaviour from a mention,
   * and it cannot produce a false GREEN in either direction: a name this parse
   * misses leaves its member in `unaccounted` (RED), and a name it over-reads
   * cannot make an undecided member pass, because the spawned guard would have
   * exited non-zero first.
   */
  const deciderRun = runNode([DECIDER_ABS]);
  const deciderCounts = new RegExp(
    'all (\\d+) entries of (\\S+) found ON DISK are accounted for: (\\d+) registered in '
    + 'proof-or-stop\\.config\\.json validate\\.commands and (\\d+) excluded with a stated reason',
  ).exec(deciderRun.out);
  let deciderRecordBlock = '';
  try {
    deciderRecordBlock = /REGISTRATION_EXCLUSIONS\s*=\s*new Map\(\[([\s\S]*?)^\]\);/m
      .exec(readFileSync(DECIDER_ABS, 'utf8'))?.[1] ?? '';
  } catch {
    deciderRecordBlock = '';
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decidedNames = new Set(
    readdirSync(here).filter((n) => n.endsWith('.mjs'))
      .filter((n) => new RegExp('`\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}/' + escapeRe(n) + '`').test(deciderRecordBlock)),
  );

  const derived = derive(realTokens, decidedNames);
  const deciderCoversPopulation = deciderCounts !== null
    && deciderCounts[2] === RED_DIR_REL
    && Number(deciderCounts[1]) >= derived.population.length;

  row(
    'DECISION_RECORD_IS_LIVE_AND_AUDITED', 'C',
    deciderRun.status === 0 && deciderCoversPopulation
    && (derived.unregistered.length === 0 || decidedNames.size > 0),
    `${DECIDER_REL} spawned against the untouched tree: exit=${deciderRun.status}; it reports a TOTAL enumeration of `
    + `${deciderCounts === null ? '<success line unparsed>' : `${deciderCounts[1]} entries of ${deciderCounts[2]}`}, `
    + `covering at least the ${derived.population.length} *.mjs this block enumerates=${deciderCoversPopulation}; `
    + `${decidedNames.size} key(s) read from its declared exclusion record: ${[...decidedNames].join(', ') || 'none'}`,
    'the decision authority must be a REGISTERED guard that ran and PASSED here, its total enumeration must cover this '
    + "block's population, and its exclusion record must be readable — an unreadable record would leave every "
    + 'unregistered member unaccounted (the loud direction), but it would not be measuring the decision it claims to',
  );
  row(
    'EVERY_RED_HARNESS_IS_REGISTERED_OR_DECIDED', 'C',
    derived.unaccounted.length === 0 && deciderRun.status === 0 && deciderCoversPopulation,
    `${derived.population.length} *.mjs on disk (unfiltered): ${derived.registered.length} registered in `
    + `validate.commands, ${derived.unregistered.length} unregistered — of which ${derived.decided.length} are DECIDED `
    + `by the audited exclusion record of ${basename(DECIDER_REL)} `
    + `(${derived.decided.join(', ') || 'none'}) and ${derived.unaccounted.length} are UNACCOUNTED: `
    + `${derived.unaccounted.join(', ') || 'none'}. EXECUTION IS A DIFFERENT PROPERTY AND IS NOT CLAIMED HERE: `
    + `proof-or-stop validate does not run those ${derived.unregistered.length} directly, and whether anything else executes `
    + 'them is not measured by this block — a filename appearing in a registered file is a mention, not a spawn',
    'every member of packages/main/tests/red/*.mjs must be registered in validate.commands, or its non-registration '
    + 'must be a recorded decision the shipped guard audits; a member that is silently neither is coverage nobody has '
    + 'and nobody chose',
  );
  row(
    'SELF_IS_INSIDE_THE_POPULATION', 'C',
    derived.population.includes(SELF),
    `${SELF} present in the derived population=${derived.population.includes(SELF)}`,
    'this file must be inside its own population with no self-exception; a carve-out is the exemption being removed',
  );

  // NON-VACUITY of the DECISION arm: it must classify something, and a member
  // must fall into `unaccounted` the moment its record entry goes away —
  // otherwise `decided` is just `unregistered` wearing a different name.
  let decisionProof = null;
  for (const candidate of derived.decided) {
    const stripped = new Set(decidedNames);
    stripped.delete(candidate);
    if (derive(realTokens, stripped).unaccounted.includes(candidate)) {
      decisionProof = candidate;
      break;
    }
  }
  row(
    'DECISION_ARM_IS_LIVE', 'C',
    derived.decided.length > 0 && decisionProof !== null,
    `unregistered but carried by the audited decision record: ${derived.decided.join(', ') || 'none'}; dropping `
    + `${decisionProof ?? '<no candidate>'} from that record moves it into unaccounted=${decisionProof !== null}`,
    'the decision arm must actually classify something AND a member must land in `unaccounted` the moment its record '
    + 'entry disappears, or "decided" is just "unregistered" wearing a different name',
  );

  // NON-VACUITY of the REGISTRATION arm: de-register a registered harness and
  // require the SAME derivation to move it into `unaccounted`. The candidate is
  // searched for rather than named, so this survives any registration change.
  let stripProof = null;
  for (const candidate of derived.registered) {
    const stripped = new Set(realTokens);
    stripped.delete(`${RED_DIR_REL}/${candidate}`);
    const mutatedDerivation = derive(stripped, decidedNames);
    if (mutatedDerivation.unaccounted.includes(candidate)) {
      stripProof = { candidate, after: mutatedDerivation.unaccounted.length };
      break;
    }
  }
  row(
    'DERIVATION_IS_NON_VACUOUS', 'C',
    stripProof !== null,
    stripProof === null
      ? `de-registering any of the ${derived.registered.length} registered harnesses left the unaccounted set unchanged`
      : `de-registering ${stripProof.candidate} moves it into unaccounted (${derived.unaccounted.length} → ${stripProof.after})`,
    'the same derivation must detect a de-registered harness, or a clean result would mean nothing',
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK D — THE TRAP. A differently-prefixed newcomer, judged by REAL SHIPPED
  //           GUARDS spawned as child processes. No enumeration is imitated here.
  // ══════════════════════════════════════════════════════════════════════════
  const newcomerBody = [
    '#!/usr/bin/env node',
    `// ${PLANTED_BY_MARKER} (B-49d4 CHK-001).`,
    '// A newly added red harness that nobody has registered and nobody has excluded. Its name',
    '// deliberately lacks the `red-` prefix: the declared population is *.mjs in this directory,',
    '// so only an UNFILTERED enumeration sees it. Any guard that narrows by name pattern will',
    '// report complete coverage while this file sits here undecided.',
    '// It lives in a private temporary mirror of the repository and is never written to the',
    '// repository, so a kill at any moment can strand nothing that any guard enumerates.',
    "console.log('b49d4-newcomer-probe-unprefixed: OK');",
    '',
  ].join('\n');

  /**
   * WHICH GUARDS JUDGE THE NEWCOMER — DERIVED, AND ASSERTED COMPLETE.
   *
   * A target is any `*.mjs` here that reads `proof-or-stop.config.json` AND enumerates
   * a directory: anything that decides registration by LOOKING rather than by
   * remembering. A file that spawns THIS one has to be skipped or the run
   * recurses forever — but that skip used to be a bare `text.includes(SELF)`
   * continue, so writing this artifact's filename into a target (a "see also"
   * comment is enough) silently removed it from the check while the artifact
   * still reported GREEN on whatever remained. The set could only shrink, and
   * nothing measured the shrink.
   *
   * So the skip is now DATA, audited on every run:
   *   - a qualifying file that mentions this artifact and is NOT in
   *     TARGET_CYCLE_BREAKS is a SILENT DROP and FAILS, naming the file;
   *   - an entry in TARGET_CYCLE_BREAKS that no longer mentions this artifact is
   *     stale and FAILS (a carve-out that widened itself);
   *   - an entry without a real reason FAILS.
   * The map is empty today: nothing that qualifies spawns this file (the one
   * file that does — `red-b49d4-chk001-receipt.mjs` — never enumerates, so the
   * qualification predicate excludes it and the cycle skip is not what drops it).
   *
   * REQUIRED_NEWCOMER_TARGETS is a FLOOR, not the population. The population
   * stays derived; the floor only forbids the derived set from silently losing
   * either guard this story ships — including by a target quietly ceasing to
   * qualify, which set equality alone would not catch. A floor can hide no
   * member: it can only make the check stricter, and it is itself audited (a
   * required target that vanishes or stops qualifying FAILS naming itself).
   */
  const REQUIRED_NEWCOMER_TARGETS = [GUARD_REL, `${RED_DIR_REL}/red-b49d4-harness-registration.mjs`];
  const TARGET_CYCLE_BREAKS = new Map([]);
  const MIN_CYCLE_BREAK_REASON_CHARS = 40;

  const redModuleNames = readdirSync(here).filter((n) => n.endsWith('.mjs')).sort();
  const readRedText = (name) => {
    try {
      return readFileSync(join(here, name), 'utf8');
    } catch {
      return null;
    }
  };

  /** PURE, so the audit below can be re-run against synthetic trees and maps. */
  function deriveTargets(names, readText, cycleBreaks) {
    const qualified = [];
    const mentionsSelf = [];
    for (const name of names) {
      if (name === SELF || name === NEWCOMER_BASE) continue;
      const text = readText(name);
      if (text === null) continue;
      if (!text.includes(CONFIG_REL)) continue;                                // not a registration decider
      if (!/readdirSync|opendirSync|globSync|readdir\(/.test(text)) continue;   // does not enumerate
      const rel = `${RED_DIR_REL}/${name}`;
      qualified.push(rel);
      if (text.includes(SELF)) mentionsSelf.push(rel);
    }
    // Anything that mentions this file is UNSPAWNABLE — spawning it may recurse
    // forever — so it leaves the target set either way. The difference is that a
    // mention without an audited cycle break now shrinks the set LOUDLY: it lands
    // in droppedSilently, which fails the completeness row naming the file.
    const targets = qualified.filter((rel) => !mentionsSelf.includes(rel));
    return {
      qualified,
      mentionsSelf,
      droppedSilently: mentionsSelf.filter((rel) => !cycleBreaks.has(rel)),
      targets,
      staleCycleBreaks: [...cycleBreaks.keys()].filter((rel) => !mentionsSelf.includes(rel)),
      unreasonedCycleBreaks: [...cycleBreaks.entries()]
        .filter(([, why]) => typeof why !== 'string' || why.trim().length < MIN_CYCLE_BREAK_REASON_CHARS)
        .map(([rel]) => rel),
      missingRequired: REQUIRED_NEWCOMER_TARGETS.filter((rel) => !targets.includes(rel)),
    };
  }
  const targetsAreComplete = (d) => d.droppedSilently.length === 0 && d.staleCycleBreaks.length === 0
    && d.unreasonedCycleBreaks.length === 0 && d.missingRequired.length === 0;

  const targetSet = deriveTargets(redModuleNames, readRedText, TARGET_CYCLE_BREAKS);
  const targetRels = targetSet.targets;

  // NON-VACUITY of the completeness check itself: every way the target set could
  // shrink must flip the verdict to failure. Measured, not argued.
  const overlay = (name, transform) => (n) => {
    const text = readRedText(n);
    return n === name && text !== null ? transform(text) : text;
  };
  const biteFailures = [];
  for (const rel of REQUIRED_NEWCOMER_TARGETS) {
    const name = basename(rel);
    // (a) the target gains a mention of this artifact — the F-003 shrink.
    const mentioned = deriveTargets(
      redModuleNames, overlay(name, (t) => `${t}\n// see also: ${SELF}\n`), TARGET_CYCLE_BREAKS,
    );
    if (targetsAreComplete(mentioned) || !mentioned.droppedSilently.includes(rel) || mentioned.targets.includes(rel)) {
      biteFailures.push(`a "see also: <this artifact>" comment added to ${name} did not FAIL the completeness check`);
    }
    // (b) the target quietly stops qualifying — set equality alone misses this.
    const unqualified = deriveTargets(
      redModuleNames, overlay(name, (t) => t.split(CONFIG_REL).join('<removed>')), TARGET_CYCLE_BREAKS,
    );
    if (targetsAreComplete(unqualified) || !unqualified.missingRequired.includes(rel)) {
      biteFailures.push(`${name} ceasing to qualify did not FAIL the completeness check`);
    }
  }
  // (c) both arms of the cycle-break audit, exercised even though the real map is
  //     empty, so the machinery cannot rot while unused.
  const SYNTHETIC_STALE_BREAK = `${RED_DIR_REL}/red-b49d4-deleted-last-week.mjs`;
  const staleAudit = deriveTargets(redModuleNames, readRedText, new Map([
    [SYNTHETIC_STALE_BREAK, 'a reason comfortably longer than the minimum length this auditor requires'],
  ]));
  if (targetsAreComplete(staleAudit) || !staleAudit.staleCycleBreaks.includes(SYNTHETIC_STALE_BREAK)) {
    biteFailures.push('a cycle break naming a file that does not mention this artifact was not flagged as stale');
  }
  const reasonName = basename(REQUIRED_NEWCOMER_TARGETS[0]);
  const reasonAudit = deriveTargets(
    redModuleNames, overlay(reasonName, (t) => `${t}\n// ${SELF}\n`),
    new Map([[REQUIRED_NEWCOMER_TARGETS[0], 'too short']]),
  );
  if (targetsAreComplete(reasonAudit) || !reasonAudit.unreasonedCycleBreaks.includes(REQUIRED_NEWCOMER_TARGETS[0])) {
    biteFailures.push('a cycle break carrying no real reason was not flagged as unreasoned');
  }

  row(
    'NEWCOMER_TARGET_SET_IS_COMPLETE', 'D',
    targetsAreComplete(targetSet),
    `${targetSet.qualified.length} *.mjs qualify (read ${CONFIG_REL} AND enumerate): `
    + `${targetSet.qualified.map((r) => basename(r)).join(', ')}; dropped for mentioning ${SELF} without an audited `
    + `cycle break: ${targetSet.droppedSilently.map((r) => basename(r)).join(', ') || 'none'}; audited cycle breaks: `
    + `${[...TARGET_CYCLE_BREAKS.keys()].map((r) => basename(r)).join(', ') || 'none'} `
    + `(stale: ${targetSet.staleCycleBreaks.join(', ') || 'none'}; unreasoned: `
    + `${targetSet.unreasonedCycleBreaks.join(', ') || 'none'}); required targets missing from the derived set: `
    + `${targetSet.missingRequired.join(', ') || 'none'}`,
    'the spawned target set must EQUAL the set of files that genuinely qualify, and must contain both guards this '
    + `story ships. A file that drops out because it mentions ${SELF} — or because it quietly stopped qualifying — `
    + 'must FAIL here naming itself, never shrink the set silently while the remaining targets keep the row GREEN',
  );
  row(
    'TARGET_SET_COMPLETENESS_CHECK_BITES', 'D',
    biteFailures.length === 0,
    biteFailures.length === 0
      ? `the same derivation was re-run over ${REQUIRED_NEWCOMER_TARGETS.length * 2 + 2} synthetic mutations and `
      + `rejected every one: each required target (${REQUIRED_NEWCOMER_TARGETS.map((r) => basename(r)).join(', ')}) `
      + `gaining a mention of ${SELF}, each ceasing to qualify, a stale cycle break and an unreasoned one`
      : biteFailures.join(' | '),
    'the completeness check must reject every way the target set could shrink, or a clean result above would mean '
    + 'nothing',
  );

  // The newcomer is planted in a PRIVATE MIRROR, and the guards are spawned
  // against that mirror. The red directory is copied byte for byte so a guard's
  // own git-cleanliness check still passes; the dist task directory is
  // materialized so a target that plants its own probe there lands in the mirror
  // rather than in the repository. Materializing it also makes packages/main/dist
  // real, so that whole tree is HYDRATED — a real directory of symlinks reads as
  // empty to a `withFileTypes` enumeration, which is how a target came to fail in
  // here for a reason of the mirror's own making. Nothing here can strand a file
  // in a guarded directory of the working tree.
  let newcomerMirror = null;
  let targetRuns = [];
  let faithful = [];
  let byteMismatches = [];
  try {
    newcomerMirror = makeMirror('red-b49d4-newcomer-', {
      writableFiles: [NEWCOMER_REL],
      copyDirs: [RED_DIR_REL],
      materializeDirs: [DIST_TASKS_REL],
      hydrateDirs: [MAIN_DIST_REL],
    });

    // The mirror is faithful: EVERY guard that will be spawned passes BEFORE the
    // newcomer is planted, so a catch below is attributable to the newcomer alone.
    // This baseline used to cover only the two REQUIRED targets, which is why an
    // unfaithful mirror could fail one of the other eight and be visible only as an
    // unattributable verdict — a failure a reader had to diagnose by hand from a
    // clipped 120-character excerpt. It is now the whole spawned set, so the mirror
    // is what fails when the mirror is what broke.
    faithful = targetRels.map((rel) => ({ rel, ...runInMirror(newcomerMirror, rel) }));

    writeFileSync(join(newcomerMirror, NEWCOMER_REL), newcomerBody, 'utf8');

    byteMismatches = targetRels.filter((rel) => {
      try {
        return sha256(readFileSync(join(newcomerMirror, rel))) !== sha256(readFileSync(join(repoRoot, rel)));
      } catch {
        return true;
      }
    });
    targetRuns = targetRels.map((rel) => {
      const r = runInMirror(newcomerMirror, rel);
      return { rel, status: r.status, names: r.out.includes(NEWCOMER_BASE), ms: r.ms, out: r.out };
    });
  } finally {
    if (newcomerMirror !== null) rmSync(newcomerMirror, { recursive: true, force: true });
  }

  const catchers = targetRuns.filter((t) => t.status !== 0 && t.names);
  const blindTargets = targetRuns.filter((t) => t.status === 0);

  const unfaithful = faithful.filter((f) => f.status !== 0);
  row(
    'NEWCOMER_MIRROR_IS_FAITHFUL', 'D',
    faithful.length === targetRels.length && targetRels.length > 0 && unfaithful.length === 0,
    `all ${faithful.length} spawned target(s) run before the newcomer was planted: `
    + `${faithful.map((f) => `${basename(f.rel)}(exit=${f.status})`).join(', ') || 'none run'}`
    + `${unfaithful.length > 0 ? `; FAILED IN THE UNTOUCHED MIRROR: ${unfaithful.map((f) => `${basename(f.rel)} "${clip(f.out, 300)}"`).join(' | ')}` : ''}`,
    'EVERY guard that will be spawned must pass inside the mirror before the newcomer is planted, or the mirror — '
    + 'not the newcomer — is what failed it. A baseline narrower than the spawned set leaves the difference '
    + 'diagnosable only by hand',
  );
  row(
    'NEWCOMER_TARGETS_ARE_REAL_SHIPPED_GUARDS', 'D',
    targetRuns.length > 0 && byteMismatches.length === 0
    && targetRels.every((rel) => existsSync(join(repoRoot, rel))),
    `spawned ${targetRuns.length} committed guard(s) as child processes: `
    + `${targetRuns.map((t) => `${basename(t.rel)}(exit=${t.status}, ${t.ms}ms)`).join(', ')}`
    + `; every spawned file is sha256-identical to its committed counterpart=${byteMismatches.length === 0}`
    + `${byteMismatches.length > 0 ? ` (differs: ${byteMismatches.join(', ')})` : ''}`,
    'the newcomer must be judged by the enumeration that actually ships, not by a copy of it written in this file: '
    + 'the bytes executed for each target must be sha256-identical to the committed guard they stand for',
  );
  const unattributable = targetRuns.filter((t) => t.status !== 0 && !t.names);
  // The pre-plant exit of the same target, so a mirror artefact is separated from a
  // newcomer-driven failure in the row itself rather than by a later reader.
  const preplantOf = (rel) => faithful.find((f) => f.rel === rel);
  row(
    'EVERY_TARGET_VERDICT_IS_ATTRIBUTABLE', 'D',
    unattributable.length === 0,
    `targets that failed WITHOUT naming the newcomer: `
    + `${unattributable.map((t) => `${basename(t.rel)}(exit=${t.status}, pre-plant exit=`
      + `${preplantOf(t.rel)?.status ?? 'not run'}, "${clip(t.out, 300)}")`).join(' | ') || 'none'}`,
    'a target may fail only because it saw the newcomer. A target failing for any other reason is an artefact of the '
    + 'mirror, and it would silently downgrade this block from "a derived guard is blind to the newcomer" to "a '
    + 'derived guard errored" while the rows above stayed GREEN',
  );
  row(
    'DIFFERENTLY_PREFIXED_NEWCOMER_IS_INSIDE_THE_POPULATION', 'D',
    catchers.length > 0,
    `${NEWCOMER_REL} planted, registered nowhere and excluded nowhere; guards that caught it: `
    + `${catchers.map((t) => basename(t.rel)).join(', ') || 'NONE'}; guards that reported success anyway: `
    + `${blindTargets.map((t) => `${basename(t.rel)}("${clip(t.out, 90)}")`).join(' | ') || 'none'}`,
    'some shipped guard must fail and name a newcomer that is registered nowhere and excluded nowhere — with the '
    + '`red-` prefix absent, only an unfiltered enumeration can see it, which is exactly what a name-pattern '
    + 'derivation would narrow away',
  );

  const narrowed = targetRuns.filter((t) => t.rel !== GUARD_REL && t.status === 0);
  if (narrowed.length > 0) {
    observations.push(
      `NARROWED_ENUMERATION_MISSES_NEWCOMER — ${narrowed.map((t) => basename(t.rel)).join(', ')} derive their `
      + 'population from disk yet reported success with the newcomer sitting undecided in the same directory, because '
      + 'their enumeration is narrowed — by name, or to a population that is not this directory at all. Measured on '
      + 'real shipped guards rather than argued: coverage of the whole population can only come from an UNFILTERED '
      + 'enumeration of it.',
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCK E — the real config was never written to.
  // ══════════════════════════════════════════════════════════════════════════
  const digestAfter = sha256(readFileSync(CONFIG_PATH));
  let gitStatus = null;
  try {
    gitStatus = gitText(repoRoot, ['status', '--porcelain', '--', CONFIG_REL]);
  } catch {
    gitStatus = null;
  }
  row(
    'REAL_CONFIG_BYTE_UNMODIFIED', 'E',
    digestAfter === CONFIG_DIGEST_BEFORE && (gitStatus === null || gitStatus === ''),
    `sha256 before=${CONFIG_DIGEST_BEFORE.slice(0, 16)}… after=${digestAfter.slice(0, 16)}…; `
    + `git status --porcelain -- ${CONFIG_REL} => ${gitStatus === null ? 'unavailable' : JSON.stringify(gitStatus)}`,
    'every mutation must have happened on a copy: the real config must be byte-identical and clean afterwards',
  );
  row(
    'PROBES_CLEANED_UP', 'E',
    LEGACY_PROBE_RELS.every((rel) => !existsSync(join(repoRoot, rel))),
    LEGACY_PROBE_RELS.map((rel) => `${rel}=${existsSync(join(repoRoot, rel)) ? 'LEFT BEHIND' : 'absent'}`).join(', '),
    'no probe may survive the run — probes are planted only in private temporary mirrors, so these repository paths '
    + 'must be absent by construction rather than by cleanup',
  );
  const listingAfter = guardedListingDigest();
  const gitAfter = gitStatusFor(GUARDED_DIRS);
  row(
    'REPO_TREE_NEVER_WRITTEN_TO', 'E',
    listingAfter === LISTING_DIGEST_BEFORE && gitAfter === GIT_STATUS_BEFORE,
    `listing digest of ${GUARDED_DIRS.join(', ')} before=${LISTING_DIGEST_BEFORE.slice(0, 16)}… `
    + `after=${listingAfter.slice(0, 16)}…; git status --porcelain over those paths unchanged=`
    + `${gitAfter === GIT_STATUS_BEFORE}`,
    'the guarded directories must contain exactly the same entries after the run as before it: a probe planted in the '
    + 'population a guard polices is a false failure waiting for the next kill, so no probe may be written here at all',
  );
} finally {
  // Nothing to sweep: every probe lived in a private temporary mirror that its
  // own block removes. A kill can strand only a directory of symlinks under
  // os.tmpdir(), which no guard enumerates.
}

// ── report ──────────────────────────────────────────────────────────────────
const realGitAfter = gitSnapshot(repoRoot);
assert.deepEqual(realGitAfter, REAL_GIT_BEFORE, 'the complete registration harness must preserve real raw index, stages and HEAD');
console.log(`GREEN unchanged real repository index: ${JSON.stringify(realGitAfter)}`);
const red = rows.filter((r) => !r.green);
for (const r of rows) {
  console.log(`  [${r.green ? 'GREEN' : 'RED  '}] ${r.id} (BLOCK ${r.block})`);
  console.log(`      observed: ${r.observed}`);
  if (!r.green) console.log(`      required: ${r.required}`);
}
for (const note of observations) console.log(`  [OBS  ] ${note}`);
// Report the budget every run, not only when it bites: a run that finished comfortably and a run that
// finished by a hair read identically otherwise, and the second is the one about to become a false RED
// attributed to a target (B-bcae F-054).
console.log(
  `  [BUDGET] registered row timeoutMs=${SELF_REGISTERED_TIMEOUT_MS ?? 'unregistered'}; `
  + `child-process budget spent=${spawnMs}ms remaining=`
  + `${spawnBudgetRemainingMs === Infinity ? 'unbounded' : `${Math.max(0, Math.round(spawnBudgetRemainingMs))}ms`}`
  + `${spawnBudgetIncidents.length > 0 ? `; INCIDENTS: ${spawnBudgetIncidents.join(' | ')}` : ''}`,
);
console.log(`\n${red.length} RED / ${rows.length - red.length} GREEN of ${rows.length} rows (${spawnMs}ms in child processes)`);

if (red.length > 0) {
  console.error(
    `\nred-b49d4-registration-derivation: ${red.length} row(s) still exhibit the pre-fix defect — `
    + `${red.map((r) => r.id).join(', ')}. `
    + 'The registration guard asserts a fixed allowlist instead of deriving its population, so it reports the size of '
    + 'its own expectation and cannot see a member nobody listed.',
  );
  process.exit(1);
}

console.log(
  'red-b49d4-registration-derivation: OK (registration is DERIVED from disk: an unregistered member of '
  + `${DIST_TASKS_REL}/red-evidence-*.js is caught, every ${RED_DIR_REL}/*.mjs is either registered in `
  + 'validate.commands or carried by the audited exclusion record of a registered guard that was spawned here and '
  + 'passed — accounted for, which is a DIFFERENT and weaker claim than executed, and no claim about execution is '
  + 'made — a differently-prefixed newcomer is caught by the shipped guards themselves, and the control bites on a '
  + 'config COPY while the real proof-or-stop.config.json stays byte-identical)',
);
process.exit(0);
