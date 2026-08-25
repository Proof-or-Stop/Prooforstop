#!/usr/bin/env node
/**
 * Proof-or-Stop bin entry (main standalone mode)
 *
 * This script only loads tools bundled with main (process category). If you also want to enable @proof-or-stop/utils
 * helper tools, use the generated bin/proof-or-stop.js bootstrap script.
 * (B-cc10 F-010: bin/lattice.js was deleted by CHK-006; the generated entrypoint is bin/proof-or-stop.js.)
 *
 * When a dynamic import carries a ?t= cache buster, import.meta.url contains a query string, so skip runCli.
 */

import { runCli } from './cli-engine.js';
import { loadCanonicalLabEntrypoint } from './cli/lab-entrypoint.js';

const _isDirectRun = !import.meta.url.includes('?');
if (_isDirectRun) {
  loadCanonicalLabEntrypoint()
    .then(lab => runCli(lab ?? undefined))
    .catch(e => { console.error(e); process.exit(1); });
}
