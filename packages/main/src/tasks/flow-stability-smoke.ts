#!/usr/bin/env node
import { runFlowStabilityCli } from './flow-stability/cli.js';

// Full: node packages/main/dist/tasks/flow-stability-smoke.js
// List: append --list-capabilities
// Focus: append --capability=review-evidence (repeat to combine capabilities).
await runFlowStabilityCli(process.argv.slice(2));
