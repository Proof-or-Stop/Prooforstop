#!/usr/bin/env node
import { runHostUsageCli } from './host-run-usage/cli.js';

// Full: no arguments / --all; legacy: --canonical-core.
// List: --list-capabilities. Focus: --capability=usage-parsing (repeat to combine).
await runHostUsageCli(process.argv.slice(2));
