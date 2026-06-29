#!/usr/bin/env node
/**
 * Legacy quarantine wrapper.
 *
 * The old retired server semantics smoke name is retained only so historical
 * npm scripts and smoke selectors do not fail with a missing file. The active
 * guard is retired-authority-vocabulary-guard-smoke.ts.
 */
await import('./retired-authority-vocabulary-guard-smoke.js');

