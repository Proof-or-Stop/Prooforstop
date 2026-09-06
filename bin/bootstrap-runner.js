#!/usr/bin/env node
/**
 * Shared bootstrap runner for local Proof-or-Stop wrappers.
 *
 * These wrappers are repo-local convenience entrypoints. When their compiled
 * dependencies are missing we want a recovery hint, not an opaque
 * ERR_MODULE_NOT_FOUND stack trace.
 */

import { existsSync, statSync } from 'fs';
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
// of truth — never inline; never via build-lock.mjs, which would pull in proper-lockfile).
export function buildInProgress() {
  const lockDir = `${buildLockTarget(repoRoot)}.lock`;
  let st;
  try { st = statSync(lockDir); } catch { return false; } // no lock dir → no build active
  return (Date.now() - st.mtimeMs) < BUILD_LOCK_STALE_MS;
}
// Absolute wall-clock ceiling for waiting on an in-progress build (B-1734 C4). A concurrent reader must
// keep waiting as long as buildInProgress() reports a FRESH, heartbeating lock — the main build timeout
// is 290s and the builder retry budget is ~10min, so a fixed 60s cap would abandon a legitimately slow
// build after 1 minute. This 20-minute ceiling is comfortably longer than the supported build duration,
// so a live build is waited on for its full realistic length and only a genuinely stuck run gives up.
export const IMPORT_WAIT_MAX_MS = 20 * 60 * 1000;

// Universal entry point resilience (B-1734 F-003). A rebuild promotes dist by an atomic rename while
// holding the build lock. Import the dist ONLY when it is present AND no build is in progress: that
// guarantees a complete, stable tree that cannot be renamed out from under a mid-graph import.
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
    // KNOWN LIMITATION / FOLLOW-UP (B-1734 #1, deferred to a build-concurrency infra story): reader-lease
    // TOCTOU. We check `!buildInProgress()` and THEN import, without holding a read lease. A builder can
    // acquire the lock and promote (rename dist) in the gap between this check and the import(). The
    // atomic single-rename swap makes the window astronomically small (one rename syscall) and the wait
    // loop below covers a build that is already in progress, but it does NOT eliminate the check-then-import
    // race. Fully closing it needs a proper reader/writer lease (or the immutable-versioned-dir + atomic
    // current-pointer redesign tracked for the same follow-up), which is out of scope here.
    if (existsSync(MAIN_DIST) && existsSync(UTILS_DIST) && !buildInProgress()) {
      return await Promise.all([
        import(pathToFileURL(MAIN_DIST).href),
        import(pathToFileURL(UTILS_DIST).href),
      ]);
    }
    // Not importable this instant. Keep waiting while a build heartbeats the lock (dist mid-rebuild) or
    // while dist is present but the lock is momentarily held. Give up ONLY when EITHER
    //   (a) dist is absent AND no build is active — a genuine never-built repo, or a build that crashed
    //       and let its lock go stale; OR
    //   (b) we exceed the absolute IMPORT_WAIT_MAX_MS ceiling (>= the supported build duration).
    // So a live, heartbeating build is waited on for its full realistic duration and is NEVER abandoned
    // at a fixed short cap; only a genuinely never-built repo or a stuck run past the ceiling fails fast.
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
    const [{ runCli }, {
      register,
      utilsAllowedPhases,
      utilsOwnershipClasses,
      utilsToolDefs,
    }] = await importDistModules();
    let labRegister = null;
    let labToolDefs = [];
    if (existsSync(LAB_DIST)) {
      try {
        const labModule = await import(pathToFileURL(LAB_DIST).href);
        labRegister = typeof labModule.register === 'function' ? labModule.register : null;
        if (typeof labModule.createLabToolDefs === 'function') {
          // Lab owns only schema factories and receives the same installed Zod
          // runtime as core. Zod is a package dependency of the main CLI; do not
          // reach into a compiled private core path because clean/atomic builds
          // never produce a packages/main/dist/core/zod.js facade.
          const zodModule = await import('zod');
          labToolDefs = labModule.createLabToolDefs(zodModule.z);
        } else {
          labToolDefs = Array.isArray(labModule.labToolDefs) ? labModule.labToolDefs : [];
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Main dist is already loaded above, so use its compiled shared helper. Keeping this
        // dynamic avoids adding an uncompiled TypeScript or third-party dependency to the
        // bootstrap runner's module-init import graph.
        const { setBrandEnv } = await import(pathToFileURL(BRAND_ENV_DIST).href);
        setBrandEnv(process.env, 'LAB_IMPORT_ERROR', err.message);
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
