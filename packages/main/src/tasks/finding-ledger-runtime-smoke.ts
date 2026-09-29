import { runFindingLedgerCli } from './finding-ledger-runtime/cli.js';

// Full: node packages/main/dist/tasks/finding-ledger-runtime-smoke.js
// List: append --list-capabilities
// Focus: append --capability=transactions (repeat to combine capabilities).
await runFindingLedgerCli(process.argv.slice(2));
