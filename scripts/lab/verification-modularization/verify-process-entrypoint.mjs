import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
assert.ok(readFileSync('scripts/process-fact-contract/complete.mjs', 'utf8').includes("await import('../prompt-projection-contract.mjs')"), 'PROCESS_RELOCATED_IMPORT: extracted complete driver must resolve the original prompt projection module');
await import('./verify-process-structure.mjs');
await import('./verify-process-complete.mjs');
