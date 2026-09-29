#!/usr/bin/env node
import { runCanonicalCli } from './canonical-new-story-artifacts/cli.mjs';

// Full: no arguments / --all. List: --list-capabilities.
// Focus: --capability=identity-cache (repeat to combine); legacy --group=ID remains.
// Historical migration campaigns require explicit identity-migration-archive selection.
await runCanonicalCli(process.argv.slice(2));
