#!/usr/bin/env node
import { runManagedCli } from './managed-review-evidence/cli.js';

// Full: no arguments / --all. List: --list-capabilities.
// Focus: --capability=evidence-binding; its preceding transport phases also run.
// Existing worker, descriptor, supersession and Grok diagnostic modes remain.
await runManagedCli(process.argv.slice(2));
