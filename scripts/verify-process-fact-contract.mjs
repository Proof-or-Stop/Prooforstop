#!/usr/bin/env node
import { runProcessContractCli } from './process-fact-contract/cli.mjs';

// Full: node scripts/verify-process-fact-contract.mjs --quiet
// List: append --list-capabilities
// Focus: append --capability=story3 (repeat to combine; never grants full-suite evidence).
await runProcessContractCli(process.argv.slice(2));
