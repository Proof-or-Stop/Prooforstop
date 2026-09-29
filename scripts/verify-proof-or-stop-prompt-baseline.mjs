#!/usr/bin/env node
import { runPromptBaselineCli } from './prompt-baseline/cli.mjs';

// Full: node scripts/verify-proof-or-stop-prompt-baseline.mjs
// List: append --list-capabilities
// Focus: append --capability=direct-story-policy (repeat for more capabilities).
await runPromptBaselineCli(process.argv.slice(2));
