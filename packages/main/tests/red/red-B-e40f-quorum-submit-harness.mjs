#!/usr/bin/env node
import { runHarnessCli } from './quorum-submit-harness/cli.mjs';

// List: --list-capabilities. Select: --capability=inventory-bijection.
// Existing --case=<selector> is unchanged; no implicit all/performance run.
// Exactly one capability per invocation preserves case-specific isolation authority.
await runHarnessCli(process.argv.slice(2));
