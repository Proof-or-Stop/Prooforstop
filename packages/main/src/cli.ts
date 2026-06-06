#!/usr/bin/env node
/**
 * koala bin entry (main standalone mode)
 *
 * This script only loads tools bundled with main (process category). If you also want to enable @koala-agent/utils
 * helper tools, use the packages/koala/bin/koala.js bootstrap script.
 *
 * When a dynamic import carries a ?t= cache buster, import.meta.url contains a query string, so skip runCli.
 */

import { runCli } from './cli-engine.js';

const _isDirectRun = !import.meta.url.includes('?');
if (_isDirectRun) {
  runCli().catch(e => { console.error(e); process.exit(1); });
}
