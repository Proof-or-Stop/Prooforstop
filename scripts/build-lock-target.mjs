// Dependency-free build-lock target + staleness threshold (B-1734 C3).
//
// This module imports ONLY Node built-ins (node:crypto, node:os, node:path), so it
// can be loaded in a FRESH checkout WITHOUT node_modules. bin/bootstrap-runner.js —
// the universal local wrapper entrypoint, imported on EVERY bin/proofOrStop.js call —
// imports buildLockTarget / BUILD_LOCK_STALE_MS from HERE (not from build-lock.mjs)
// so it never transitively pulls in the third-party lockfile library. If bootstrap
// imported that library transitively, a fresh checkout would throw
// ERR_MODULE_NOT_FOUND at ESM module-init — BEFORE runLocalBootstrap's try/catch
// could print the recovery hint — defeating the wrapper's entire purpose. Keep this
// module free of any third-party import (a regression guard asserts node:-only here).
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A LIVE holder heartbeats `<target>.lock`'s mtime every `update` (10s); the lock
// library treats the lock STALE past this threshold (30s). This constant is the
// SINGLE SOURCE OF TRUTH for that threshold: build-lock.mjs folds it into
// BUILD_LOCK_OPTIONS.stale, and bin/bootstrap-runner.js uses it directly for its
// buildInProgress() freshness gate — so the mutex and the reader's liveness check
// can never drift.
export const BUILD_LOCK_STALE_MS = 30000;

// A stable per-repo lock target under os.tmpdir(). The lock library locks the
// sibling `<target>.lock`; we only need the target to exist so realpath resolves.
export function buildLockTarget(repoKey) {
  const digest = createHash('sha256').update(String(repoKey)).digest('hex');
  return join(tmpdir(), `proof-or-stop-build-lock-${digest}`);
}
