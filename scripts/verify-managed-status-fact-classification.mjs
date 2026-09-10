import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PROCESS_FACT_LEVELS } from '../packages/main/dist/core/process-fact-levels.js';
import { COMMAND_POLICIES } from '../packages/main/dist/core/command-policy.js';

assert.equal(COMMAND_POLICIES.host_run_status.ownershipClass,'readOnly');
const fact=PROCESS_FACT_LEVELS.find(row=>row.name==='host_run_status');
assert.equal(fact?.level,'L0','U02 status process-fact classification must agree with its read-only runtime authority');
process.stdout.write(execFileSync(process.execPath,['scripts/verify-managed-status-readonly.mjs'],{encoding:'utf8',timeout:15000}));
console.log('PASS U02 status fact classification and actual read-only behavior agree');
