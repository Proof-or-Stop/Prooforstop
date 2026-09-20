#!/usr/bin/env node
import { runVerificationCli } from './verification-run-and-guard/cli.js';

// Full: node packages/main/dist/tasks/verification-run-and-guard-smoke.js
// List: append --list-capabilities
// Focus: append --capability=foundation (repeat for more capabilities).
await runVerificationCli(process.argv.slice(2));
