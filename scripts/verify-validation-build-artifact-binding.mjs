#!/usr/bin/env node
import { runBuildBindingCli } from './validation-build-binding/cli.mjs';

// Full: node scripts/verify-validation-build-artifact-binding.mjs
// List: append --list-capabilities (includes prerequisite capabilities).
// Focus: append --capability=done-required (repeat to combine capabilities).
await runBuildBindingCli(process.argv.slice(2));
