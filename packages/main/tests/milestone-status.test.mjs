import { runMilestoneStatusCli } from './milestone-status/cli.mjs';

// Full: node packages/main/tests/milestone-status.test.mjs
// List: append --list-capabilities
// Focus: append --capability=freshness (repeat to combine capabilities).
await runMilestoneStatusCli(process.argv.slice(2));
