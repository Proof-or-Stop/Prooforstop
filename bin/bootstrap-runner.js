#!/usr/bin/env node
/**
 * Shared bootstrap runner for local Proof-or-Stop wrappers.
 *
 * These wrappers are repo-local convenience entrypoints. When their compiled
 * dependencies are missing we want a recovery hint, not an opaque
 * ERR_MODULE_NOT_FOUND stack trace.
 */

import { existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
// Import the lock target + stale threshold from the DEPENDENCY-FREE module (only
// node: built-ins), NOT build-lock.mjs — build-lock.mjs imports proper-lockfile,
// which is absent in a fresh checkout without node_modules and would throw
// ERR_MODULE_NOT_FOUND at module-init here, before we could print the recovery hint.
import { BUILD_LOCK_STALE_MS, buildLockTarget } from '../scripts/build-lock-target.mjs';

const __filename = fileURLToPath(import.meta.url);
const binDir = dirname(__filename);
const repoRoot = dirname(binDir);

const MAIN_DIST = join(repoRoot, 'packages', 'main', 'dist', 'cli-engine.js');
const BRAND_ENV_DIST = join(repoRoot, 'packages', 'main', 'dist', 'core', 'brand-env.js');
const UTILS_DIST = join(repoRoot, 'packages', 'utils', 'dist', 'index.js');
const LAB_DIST = join(repoRoot, 'packages', 'lab', 'dist', 'index.js');

function printBootstrapFailure(error) {
  if (/^(?:Error:[ \t]*)?CLI_RUNTIME_VERSION_(?:MISMATCH|METADATA_INVALID):/m.test(String(error?.message ?? ''))) {
    // Both entry shapes would reject the same installation. Do not advertise
    // the generic fallback as recovery from a runtime package mismatch.
    console.error(error.message);
    return;
  }
  const missing = [];
  if (!existsSync(MAIN_DIST)) missing.push(MAIN_DIST);
  if (!existsSync(UTILS_DIST)) missing.push(UTILS_DIST);

  console.error('proof-or-stop local bootstrap is not ready.');

  if (missing.length > 0) {
    console.error('');
    console.error('Missing build artifacts:');
    for (const file of missing) console.error(`  - ${file}`);
  }

  console.error('');
  console.error('Recovery:');
  console.error('  1. npm --prefix packages/main run build');
  console.error('  2. npm --prefix packages/utils run build');
  console.error('  3. Retry the same command');
  console.error('');
  console.error('Fallbacks:');
  console.error('  - Core-only local CLI: node packages/main/dist/cli.js <command>');
  console.error('    Use this for current-worktree gate/status/validate checks while developing ProofOrStop.');
  console.error('  - Global CLI (heartbeat-only, not current-worktree gate/status evidence):');
  console.error('    PROOF_OR_STOP_ACTIVITY_SOURCE=codex PROOF_OR_STOP_ACTIVITY_RECORD_READONLY=1 PROOF_OR_STOP_CODEX_ENTRYPOINT=global-fallback proof-or-stop session_brief');
  console.error('    The global-fallback exemption is only for session_brief heartbeat; it is never worktree gate/status evidence.');

  // A BARE package that Node could not resolve means node_modules is missing or incomplete —
  // "run the build" is not the fix for that, so name the real one. Node phrases an unresolved
  // bare specifier as "Cannot find package '<name>'" and an unresolved relative/absolute
  // specifier as "Cannot find module '<path>'"; only the former is a dependency problem, so a
  // broken compiled dist keeps the plain build/recovery guidance above. This path is reachable
  // once dist is present but dependencies are not (B-bcae F-035): the initial dist import loads
  // scripts/build-lock.mjs, whose proper-lockfile import needs node_modules.
  const missingPackage = error && /Cannot find package '([^']+)'/.exec(String(error.message));
  if (missingPackage) {
    console.error('');
    console.error(`Missing runtime dependency: ${missingPackage[1]}`);
    console.error('  - Install dependencies first: npm install');
    console.error('    (a compiled dist without node_modules cannot start)');
  }

  // Reader admission is an atomic mkdir under os.tmpdir() (B-bcae F-060), so an unwritable or full temp
  // directory now stops a startup that would otherwise have worked — and BOTH dist entries are present
  // in that case, so nothing above names a cause. "Run the build" is the wrong instruction here, so name
  // the real subsystem. Matched on the errno code AND on the temp path, so an identically-coded failure
  // somewhere else keeps the generic guidance.
  const tempDir = tmpdir();
  const lockCode = error && typeof error.code === 'string' ? error.code : '';
  if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(lockCode) && String(error.message ?? '').includes(tempDir)) {
    console.error('');
    console.error(`Temporary directory is not usable: ${tempDir} (${lockCode})`);
    console.error('  - Startup coordinates its dist import with a lock created there.');
    console.error('  - Make it writable, free space on it, or point TMPDIR at a writable directory.');
  }

  if (error) {
    console.error('');
    console.error(`Original error: ${error.message}`);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// A build is "in progress" only when a LIVE holder is heartbeating `<target>.lock`. Gate on lock
// FRESHNESS, not mere existence: a build interrupted by Ctrl-C/SIGKILL/crash skips its finally-release
// and leaves the `.lock` dir ORPHANED. The atomic swap already left dist complete in that case, so the
// orphan must NOT block readers — otherwise every bin/proof-or-stop.js call would wait then fail until the
// next build reclaims it. A live holder heartbeats the mtime every `update` (10s); proper-lockfile
// treats it stale past `stale` (30s), so an orphan ages out within `stale` and we ignore it. The
// threshold and lock target are imported from the dependency-free build-lock-target.mjs (single source
// of truth — never inline, and never STATICALLY from build-lock.mjs, which would put proper-lockfile in
// this file's module-init graph; the dist-present branch below does reach build-lock.mjs dynamically,
// which is deliberate and handled — B-bcae F-049).
//
// WHERE THIS PREDICATE IS STILL CONSULTED (B-bcae F-040). Only on the dist-ABSENT branch of
// importDistModules. The dist-PRESENT branch delegates exclusion entirely to reader admission on
// distImportLockTarget, so a FRESH holder of buildLockTarget alone no longer delays a reader — see the
// residual paragraph on importDistModules for what that does and does not cover.
export function buildInProgress() {
  const lockDir = `${buildLockTarget(repoRoot)}.lock`;
  let st;
  try { st = statSync(lockDir); } catch { return false; } // no lock dir → no build active
  return (Date.now() - st.mtimeMs) < BUILD_LOCK_STALE_MS;
}
// Absolute wall-clock ceiling for the dist-ABSENT polling loop in importDistModules (B-1734 C4).
// SCOPE (B-bcae F-015/F-024): this bounds ONLY the branch that waits for a tree that is not there yet.
// While that branch keeps waiting — buildInProgress() reports a FRESH, heartbeating lock, or a fresh
// presence recheck shows the tree completed — the main build timeout is 290s and the builder retry
// budget is ~10min, so a fixed 60s cap would abandon a legitimately slow build after 1 minute; this
// 20-minute ceiling is comfortably longer than the supported build duration, so a live build waited on
// through THAT branch is never abandoned early and only a genuinely stuck run gives up.
//
// It is NOT the bound on the dominant contention shape. When a build compiles into staging while dist
// is still PRESENT, importDistModules takes the present branch immediately and waits INSIDE reader
// admission instead. That wait is bounded by the production BUILD_LOCK_OPTIONS retry budget in
// scripts/build-lock.mjs (600 retries, minTimeout 200ms, maxTimeout 1000ms, factor 2 — ~598,400ms,
// about 10 minutes), after which proper-lockfile throws ELOCKED, it propagates out of
// importDistModules, and runLocalBootstrap's catch prints the bootstrap diagnostic and exits 1.
// That ~10-minute effective bound is INTENTIONAL, not an oversight: it is the exact budget a BUILDER
// already waits for another builder. A reader is NOT queued on that mutex — reader admission takes
// distImportLockTarget while builder-versus-builder contention is on buildLockTarget (B-bcae F-052).
// The two bounds coincide because both targets are acquired through the SAME frozen options object:
// scripts/build-lock.mjs passes BUILD_LOCK_OPTIONS to every target, and DIST_IMPORT_LOCK_OPTIONS is
// that object with only `realpath` changed. TWO TARGETS, ONE OPTIONS OBJECT, ONE BOUND — so a reader
// inherits the contract the build mutex already publishes instead of inventing a second, longer one,
// and a build that outlives it has outlived what every other waiter will tolerate too. Changing that
// wait means changing BUILD_LOCK_OPTIONS, not this constant. (Collapsing the two targets into one
// mutex is NOT what makes the bounds agree, and would reintroduce B-bcae F-033: an ordinary CLI
// startup reported as a live build, finding_runtime_evidence_run refusing with build_in_progress, and
// `build-lock.mjs --proof-or-stop-check` exiting 75 while nothing is building.)
export const IMPORT_WAIT_MAX_MS = 20 * 60 * 1000;

// Optional lab tools, resolved INSIDE reader admission (B-bcae F-034). Returns null when the lab dist
// is absent — the ordinary shape for a repository or packaged runtime that never built it.
//
// BRAND_ENV_DIST is resolved here, eagerly, rather than lazily on the failure path below: it lives at
// packages/main/dist/core/brand-env.js, INSIDE the exact directory scripts/build-main-with-binding.mjs
// evicts and replaces through promoteDist. Resolving it after admission is released reopened the same
// check-then-import window this helper exists to close. Eager resolution adds no new failure mode: the
// MAIN_DIST import above already pulled this module in transitively, so this is a module-cache hit —
// a tree where it could not resolve is a tree whose entry import already failed.
async function importLabModule() {
  if (!existsSync(LAB_DIST)) return null;
  const { setBrandEnv } = await import(pathToFileURL(BRAND_ENV_DIST).href);
  try {
    return { module: await import(pathToFileURL(LAB_DIST).href), setBrandEnv };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    setBrandEnv(process.env, 'LAB_IMPORT_ERROR', err.message);
    return { module: null, setBrandEnv };
  }
}

// Universal entry point resilience (B-1734 F-003, B-bcae). A rebuild promotes dist by an atomic
// rename while holding the build lock. Wait for an initially absent tree while a live builder is
// active, then take READER ADMISSION on scripts/build-lock-target.mjs's distImportLockTarget before
// rechecking and importing dist. A builder (withBuildLock) holds that same target for its whole
// critical section, so everything imported inside this admission — and everything it pulls in
// transitively — is mutually exclusive with promotion.
//
// EXACTLY what is inside (B-bcae F-034 — this list is the claim; do not widen it in prose):
//   * MAIN_DIST and UTILS_DIST, the two entry modules;
//   * when packages/lab/dist is present, LAB_DIST and BRAND_ENV_DIST, via importLabModule().
// That is every module resolution this bootstrap performs against a packages/*/dist tree. Before this
// helper owned the last two, runLocalBootstrap resolved them AFTER the release, and BRAND_ENV_DIST is
// inside packages/main/dist — the very directory promotion renames — so a builder winning the mutex in
// the instant after the release could evict it mid-resolution and reproduce the same
// ERR_MODULE_NOT_FOUND class, which the lab catch then swallowed into a silently smaller tool set.
//
// Deliberately NOT inside: runLocalBootstrap's `import('zod')`. It resolves from node_modules, which no
// promotion renames, so admitting it would widen the critical section — and pull a third-party package
// into it — for no coherence gained. Residual, stated rather than implied: packages/lab is built by a
// plain `tsc` that writes in place and takes NO lock, so admission does not serialise this reader
// against a concurrent LAB rebuild; what it guarantees is that lab's resolution cannot straddle a
// main/utils promotion.
//
// The admission target is deliberately NOT buildLockTarget: that target is what every build-in-progress
// observer reads, and an ordinary CLI startup is not a build (B-bcae F-033). Holding it here would
// make finding_runtime_evidence_run refuse with build_in_progress while nothing was building, and
// would deadlock a nested CLI launched inside a canonical build critical section.
//
// WHAT ADMISSION EXCLUDES, AND WHAT IT NARROWED (B-bcae F-040 — state this rather than imply coverage).
// It excludes holders of distImportLockTarget, i.e. withBuildLock builders (scripts/build-lock.mjs
// nests that target inside buildLockTarget for the whole staging build, atomic swap and binding write).
// It does NOT exclude a dist-mutating critical section that holds buildLockTarget ALONE — notably
// withCanonicalBuildLock in packages/main/src/handlers/finding-ledger.ts, which really executes a
// caller-supplied build command inside its section. Before this Story the dist-present guard also
// required !buildInProgress(), so a reader deferred for the whole of that section too; it no longer
// does. That narrowing is DELIBERATE and cannot be undone here: the caller-supplied command may itself
// be a nested bin/proof-or-stop.js, which would then block on a mutex its own parent holds and could
// only exhaust the retry budget and die with ELOCKED — the case
// packages/main/src/tasks/finding-ledger-runtime-smoke.ts now asserts must be admitted immediately.
// The residual is therefore a buildCommand that rewrites packages/main/dist WITHOUT routing through
// withBuildLock (a bare `tsc -p packages/main/tsconfig.json`, the shape scripts/package-desktop.mjs
// uses). readerrace:1 in packages/main/tests/red/red-1734-reader-race.mjs executes this branch: a live
// reader with a FRESH buildLockTarget-only lock present must still import immediately.
//
// TEMP-DIRECTORY FOOTPRINT (B-bcae F-060). Admission is taken with proper-lockfile's realpath:false and
// no pre-created target file, so a successful startup leaves NOTHING behind under os.tmpdir(): only the
// `<target>.lock` directory exists while the lock is held, and release removes it. Startup does still
// need os.tmpdir() to be writable — the mutex is an atomic mkdir there — so printBootstrapFailure names
// that subsystem explicitly rather than pointing at a rebuild.
//
// Why not "import immediately and retry on failure"? In-process recovery from a mid-import swap is
// impossible: if the rename fires while Node is still resolving a TRANSITIVE dependency, that module
// fails with ERR_MODULE_NOT_FOUND and Node CACHES the failed URL for the life of the process. A retry —
// even one that cache-busts the entry module's URL with a query — re-traverses to the poisoned
// transitive URL (static imports don't inherit the query) and fails again. red-1734-reader-race
// live-reproduced exactly this (e.g. registry.js → summary.js vanishing mid-import). So instead of
// racing the swap we simply do not import during a build: while the lock is held we WAIT for the build
// to finish, then import the fresh, complete dist. The common case (no build in progress) imports
// immediately with zero wait; a genuine "never built" (dist absent, no build active) still fails fast
// with the recovery hint — no wait.
async function importDistModules() {
  const startedAt = Date.now();
  for (;;) {
    if (existsSync(MAIN_DIST) && existsSync(UTILS_DIST)) {
      // Deliberately load the third-party-backed helper only after first-party dist is known to exist.
      // A fresh checkout with neither dist nor node_modules must reach the actionable recovery message
      // without failing module initialization on proper-lockfile.
      const { withDistImportLock } = await import(pathToFileURL(join(repoRoot, 'scripts', 'build-lock.mjs')).href);
      return await withDistImportLock(repoRoot, async () => {
        // B-bcae protected import:start
        // The builder may have won the mutex after the outer presence observation and promoted dist
        // before this reader acquired it. Recheck inside the mutex and fail closed if either entry is
        // genuinely absent. Throw (rather than process.exit) so the lock's finally releases first.
        if (!existsSync(MAIN_DIST) || !existsSync(UTILS_DIST)) {
          throw new Error('Required build artifacts disappeared before protected bootstrap import');
        }
        const [main, utils] = await Promise.all([
          import(pathToFileURL(MAIN_DIST).href),
          import(pathToFileURL(UTILS_DIST).href),
        ]);
        // B-bcae protected lab:start
        const lab = await importLabModule();
        // B-bcae protected lab:end
        // B-bcae protected import:end
        return [main, utils, lab];
      });
    }
    // At least one entry was absent AT THE OBSERVATION ABOVE. Keep waiting while a build heartbeats
    // the lock (dist mid-rebuild) — and also when a FRESH presence pair now shows both entries, because
    // the give-up decision must never rest on the stale observation at the top of this iteration. A
    // legitimate builder can complete its promotion and RELEASE the mutex in the gap between that
    // observation and the buildInProgress() sample below; then the lock is already gone while dist is
    // complete, and giving up here would print missing-build recovery for a tree that is fully built —
    // the completion-window false failure this Story exists to close (B-bcae F-009/F-018). Re-observing
    // presence loops back to the branch above, i.e. into the existing protected reader-admission import
    // path; it does not import here and does not widen what that admission covers. Give up ONLY when EITHER
    //   (a) dist is absent ON A FRESH OBSERVATION AND no build is active — a genuine never-built repo, or a
    //       build that crashed and let its lock go stale; OR
    //   (b) we exceed the absolute IMPORT_WAIT_MAX_MS ceiling (>= the supported build duration).
    // So a live, heartbeating build is waited on for its full realistic duration and is NEVER abandoned
    // at a fixed short cap; only a genuinely never-built repo or a stuck run past the ceiling fails fast.
    // The ceiling still bounds this branch, so even a tree whose entries flap in and out of existence
    // terminates rather than spinning forever.
    const distPresent = existsSync(MAIN_DIST) && existsSync(UTILS_DIST);
    const keepWaiting = buildInProgress() || distPresent;
    if (keepWaiting && Date.now() - startedAt < IMPORT_WAIT_MAX_MS) { await sleep(250); continue; }
    // Give up: dist is absent AND no build is active (a genuine never-built repo, or a build that crashed
    // and let its lock go stale), or we exceeded the wait ceiling. A promotion that crashed BETWEEN
    // promote-dist's two renames leaves dist absent here; it is NOT cross-process self-healed (that
    // recovery ran without the build lock and could delete a live builder's staging — reverted, B-1734).
    // The next build rebuilds dist from source (its fast-path verify fails on absent dist → full rebuild).
    printBootstrapFailure(); process.exit(1);
  }
}

export async function runLocalBootstrap() {
  try {
    // The third element is the lab resolution importDistModules performed under reader admission.
    // `= null` is the contract for a spliced helper that returns only the two entries — the archived
    // pre-B-bcae helper the causal matrix in red-bcae-bootstrap-reader-lock.mjs mutates in has that
    // shape, and it simply registers no lab tools. Production always supplies the third element.
    const [{ runCli }, {
      register,
      utilsAllowedPhases,
      utilsOwnershipClasses,
      utilsToolDefs,
    }, labResolution = null] = await importDistModules();
    let labRegister = null;
    let labToolDefs = [];
    if (labResolution && labResolution.module) {
      const labModule = labResolution.module;
      labRegister = typeof labModule.register === 'function' ? labModule.register : null;
      try {
        if (typeof labModule.createLabToolDefs === 'function') {
          // Lab owns only schema factories and receives the same installed Zod
          // runtime as core. Zod is a package dependency of the main CLI; do not
          // reach into a compiled private core path because clean/atomic builds
          // never produce a packages/main/dist/core/zod.js facade. This resolves from
          // node_modules, which promotion never renames, so it stays OUTSIDE admission.
          const zodModule = await import('zod');
          labToolDefs = labModule.createLabToolDefs(zodModule.z);
        } else {
          labToolDefs = Array.isArray(labModule.labToolDefs) ? labModule.labToolDefs : [];
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Same degradation the lab import failure already takes, using the helper importLabModule
        // resolved under admission — so this path needs no dist resolution of its own.
        labResolution.setBrandEnv(process.env, 'LAB_IMPORT_ERROR', err.message);
      }
    }

    await runCli({
      extraTools: [...utilsToolDefs, ...labToolDefs],
      extraRegister: (registry, ctx) => {
        register(registry, ctx);
        if (typeof labRegister === 'function') labRegister(registry, ctx);
      },
      extraOwnershipClasses: {
        ...utilsOwnershipClasses,
        ...(typeof labRegister === 'function' ? {
          lab_help: 'readOnly',
          lab_create: 'mainSharedMutating',
          lab_run: 'mainSharedMutating',
          lab_eval: 'readOnly',
          lab_compare: 'readOnly',
          lab_promote: 'readOnly',
        } : {}),
      },
      extraAllowedPhases: {
        ...utilsAllowedPhases,
        ...(typeof labRegister === 'function' ? {
          lab_help: 'all',
          lab_create: ['DEV'],
          lab_run: ['DEV'],
          lab_eval: ['DEV'],
          lab_compare: 'all',
          lab_promote: 'all',
        } : {}),
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    printBootstrapFailure(err);
    process.exit(1);
  }
}
