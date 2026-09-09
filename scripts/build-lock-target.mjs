// Dependency-free build-lock target + staleness threshold (B-1734 C3).
//
// This module imports ONLY Node built-ins (node:crypto, node:os, node:path), so it
// can be loaded in a FRESH checkout WITHOUT node_modules. bin/bootstrap-runner.js —
// the universal local wrapper entrypoint, imported on EVERY bin/proof-or-stop.js call —
// imports buildLockTarget / BUILD_LOCK_STALE_MS from HERE (not from build-lock.mjs)
// so its STATIC import graph never pulls in the third-party lockfile library.
//
// SCOPE OF THAT PROPERTY — static reachability only (B-bcae F-049). It is the
// MODULE-INIT graph that must stay dependency-free: a third-party import anywhere in
// it throws ERR_MODULE_NOT_FOUND before runLocalBootstrap's try/catch exists, and the
// recovery hint can never print. Once bootstrap has confirmed dist is PRESENT it DOES
// dynamically import scripts/build-lock.mjs — and therefore that library — for reader
// admission. That is deliberate, is outside this module's guarantee, and is handled
// rather than fatal: an unresolvable dependency there is reported through
// printBootstrapFailure with actionable recovery, which the depfree:4 case in
// packages/main/tests/red/red-1734-bootstrap-depfree.mjs executes. A genuinely
// never-built checkout never reaches that import at all, because dist is absent and
// control takes the give-up branch.
//
// (This module names the library nowhere, not even in prose: a regression guard greps
// this file for the literal name, so the phrasing above is deliberate, not coy.)
//
// Keep this module free of any third-party import (a regression guard asserts node:-only here).
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

const repoDigest = repoKey => createHash('sha256').update(String(repoKey)).digest('hex');

// A stable per-repo lock target under os.tmpdir(). The lock library locks the
// sibling `<target>.lock`; we only need the target to exist so realpath resolves.
export function buildLockTarget(repoKey) {
  return join(tmpdir(), `proof-or-stop-build-lock-${repoDigest(repoKey)}`);
}

// The READER-ADMISSION target, distinct from buildLockTarget on purpose (B-bcae).
//
// bin/bootstrap-runner.js's initial dist import must be mutually exclusive with
// promotion, but a reader is NOT a build. Every canonical build-in-progress OBSERVER
// reads buildLockTarget() and must keep meaning "a real build is running":
// buildLockInProgress() and the `--proof-or-stop-check` entrypoint in build-lock.mjs,
// canonicalBuildLockInProgress() in packages/main/src/handlers/finding-ledger.ts, and
// buildInProgress() in bin/bootstrap-runner.js. If readers held buildLockTarget, an
// ordinary concurrent CLI startup would be reported as a build — finding_runtime_evidence_run
// would refuse with build_in_progress while nothing was building, and `--proof-or-stop-check`
// would exit 75.
//
// So reader admission gets its own target and a strict acquisition ORDER:
//   builders (withBuildLock): buildLockTarget FIRST, then distImportLockTarget
//   readers  (withDistImportLock): distImportLockTarget ONLY
// Nothing ever acquires them in the opposite order, so the pair cannot deadlock. Readers
// still cannot overlap promotion (the builder holds this target for its whole critical
// section), builders still serialize against each other on buildLockTarget, and a nested
// CLI launched INSIDE a canonical build critical section (which holds only buildLockTarget —
// e.g. finding_runtime_evidence_run's broker) never blocks on a mutex its own parent holds.
//
// UNLIKE buildLockTarget, this path names NO file that is ever created (B-bcae F-060).
// buildLockTarget is materialised as a real (empty) file because its build-in-progress
// observers realpath it; reader admission is taken with `realpath: false` and no
// pre-created target, so an ordinary CLI startup leaves nothing behind under os.tmpdir()
// — only the `<target>.lock` DIRECTORY, which the lock library removes on release. See
// DIST_IMPORT_LOCK_OPTIONS in build-lock.mjs.
export function distImportLockTarget(repoKey) {
  return join(tmpdir(), `proof-or-stop-dist-import-lock-${repoDigest(repoKey)}`);
}
