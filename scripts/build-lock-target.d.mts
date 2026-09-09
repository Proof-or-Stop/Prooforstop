/**
 * Types for the dependency-free lock-target module.
 *
 * `build-lock-target.mjs` is plain JS on purpose — it is the ONE module that must import
 * nothing but `node:` built-ins, because `bin/bootstrap-runner.js` imports it statically
 * before any dist or `node_modules` is known to exist. That rules out compiling it as part
 * of `packages/main` (whose `tsconfig.json` sets `rootDir: "src"`), so its consumers inside
 * `src/` need this declaration to import it statically under `strict`.
 *
 * It exists so those consumers can CONSUME the production derivations rather than
 * transcribe them. Re-implementing `proof-or-stop-build-lock-` / `proof-or-stop-dist-import-
 * lock-` or the sha256 in a test would let a change to the production prefix or hashing turn
 * assertions into claims about paths nothing ever created — green while checking nothing.
 *
 * Keep these signatures in step with the exports in `build-lock-target.mjs`.
 */

/** Staleness threshold the lock library folds into its options, in milliseconds. */
export declare const BUILD_LOCK_STALE_MS: number;

/** Stable per-repo target for the canonical build mutex, under `os.tmpdir()`. */
export declare function buildLockTarget(repoKey: string): string;

/** Reader-admission target, distinct from `buildLockTarget` on purpose (B-bcae). */
export declare function distImportLockTarget(repoKey: string): string;
