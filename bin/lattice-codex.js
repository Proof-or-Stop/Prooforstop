#!/usr/bin/env node
/**
 * DEPRECATED bin alias — canonical entrypoint is `bin/proof-or-stop-codex.js`.
 *
 * B-cdf6 renamed the brand additively: this wrapper is retained (never deleted)
 * so in-flight stories, teammate branches authored before the rename, and the
 * codex-adapter gate paths that name `bin/lattice-codex.js` keep working. It
 * holds no behaviour of its own — everything lives in the canonical file, so
 * the two entrypoints cannot drift.
 */
import './proof-or-stop-codex.js';
