#!/usr/bin/env node
import { runPlannerCli } from './validation-tier-planner/cli.js';

// Full: no arguments / --all. List: --list-capabilities.
// Focus: --capability=selection-widening (repeat to combine).
// acceptance-guards requires all other sections to verify actual coverage.
runPlannerCli(process.argv.slice(2));
