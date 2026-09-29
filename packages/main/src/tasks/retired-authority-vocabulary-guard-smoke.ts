#!/usr/bin/env node
import { runRetiredCli } from './retired-authority/cli.js';

// Full: no arguments / --all. List: --list-capabilities.
// Focus: --capability=loader-provenance (repeat to combine).
// Existing --lab-graph-loader-proof remains a scoped maintenance proof.
runRetiredCli(process.argv.slice(2));
