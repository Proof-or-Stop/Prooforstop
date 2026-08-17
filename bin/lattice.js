#!/usr/bin/env node
/**
 * DEPRECATED bin alias — canonical entrypoint is `bin/proof-or-stop.js`.
 *
 * B-cdf6 renamed the brand additively: this wrapper is retained (never deleted)
 * so in-flight stories, teammate branches authored before the rename, the
 * `.githooks` / codex-adapter paths that name `bin/lattice.js`, and operator
 * muscle memory keep working. Both wrappers share one bootstrap, so they cannot
 * drift.
 */
import { runLocalBootstrap } from './bootstrap-runner.js';

runLocalBootstrap();
