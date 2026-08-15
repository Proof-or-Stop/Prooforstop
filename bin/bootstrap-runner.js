#!/usr/bin/env node
/**
 * Shared bootstrap runner for local Lattice wrappers.
 *
 * These wrappers are repo-local convenience entrypoints. When their compiled
 * dependencies are missing we want a recovery hint, not an opaque
 * ERR_MODULE_NOT_FOUND stack trace.
 */

import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { BUILD_LOCK_OPTIONS, buildLockTarget } from '../scripts/build-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const binDir = dirname(__filename);
const repoRoot = dirname(binDir);

const MAIN_DIST = join(repoRoot, 'packages', 'main', 'dist', 'cli-engine.js');
const UTILS_DIST = join(repoRoot, 'packages', 'utils', 'dist', 'index.js');
const LAB_DIST = join(repoRoot, 'packages', 'lab', 'dist', 'index.js');

function printBootstrapFailure(error) {
  const missing = [];
  if (!existsSync(MAIN_DIST)) missing.push(MAIN_DIST);
  if (!existsSync(UTILS_DIST)) missing.push(UTILS_DIST);

  console.error('lattice local bootstrap is not ready.');

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
  console.error('    Use this for current-worktree gate/status/validate checks while developing Lattice.');
  console.error('  - Global CLI (heartbeat-only, not current-worktree gate/status evidence):');
  console.error('    LATTICE_ACTIVITY_SOURCE=codex LATTICE_ACTIVITY_RECORD_READONLY=1 LATTICE_CODEX_ENTRYPOINT=global-fallback lattice session_brief');
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
// orphan must NOT block readers — otherwise every bin/lattice.js call would wait 60s then fail until the
// next build reclaims it. A live holder heartbeats the mtime every `update` (10s); proper-lockfile
// treats it stale past `stale` (30s), so an orphan ages out within `stale` and we ignore it. The
// threshold and lock target are imported from build-lock.mjs (single source of truth — never inline).
export function buildInProgress() {
  const lockDir = `${buildLockTarget(repoRoot)}.lock`;
  let st;
  try { st = statSync(lockDir); } catch { return false; } // no lock dir → no build active
  return (Date.now() - st.mtimeMs) < BUILD_LOCK_OPTIONS.stale;
}
const IMPORT_WAIT_CAP = 240; // × 250ms = 60s ceiling

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
  for (let i = 0; ; i++) {
    if (existsSync(MAIN_DIST) && existsSync(UTILS_DIST) && !buildInProgress()) {
      return await Promise.all([
        import(pathToFileURL(MAIN_DIST).href),
        import(pathToFileURL(UTILS_DIST).href),
      ]);
    }
    // Not importable this instant. Wait+retry while a build holds the lock (dist mid-rebuild), or while
    // dist is present but a build lock is momentarily held; give up only when NO build is active AND
    // dist is still absent (a genuine never-built repo, or a build that crashed mid-swap).
    if (i < IMPORT_WAIT_CAP && (buildInProgress() || (existsSync(MAIN_DIST) && existsSync(UTILS_DIST)))) { await sleep(250); continue; }
    printBootstrapFailure(); process.exit(1);
  }
}

export async function runLocalBootstrap() {
  try {
    const [{ runCli }, { register, utilsToolDefs }] = await importDistModules();
    let labRegister = null;
    let labToolDefs = [];
    if (existsSync(LAB_DIST)) {
      try {
        const labModule = await import(pathToFileURL(LAB_DIST).href);
        labRegister = typeof labModule.register === 'function' ? labModule.register : null;
        if (typeof labModule.createLabToolDefs === 'function') {
          const zodModule = await import(pathToFileURL(join(repoRoot, 'packages', 'main', 'dist', 'core', 'zod.js')).href);
          labToolDefs = labModule.createLabToolDefs(zodModule.z);
        } else {
          labToolDefs = Array.isArray(labModule.labToolDefs) ? labModule.labToolDefs : [];
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        process.env.LATTICE_LAB_IMPORT_ERROR = err.message;
      }
    }

    await runCli({
      extraTools: [...utilsToolDefs, ...labToolDefs],
      extraRegister: (registry, ctx) => {
        register(registry, ctx);
        if (typeof labRegister === 'function') labRegister(registry, ctx);
      },
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    printBootstrapFailure(err);
    process.exit(1);
  }
}
