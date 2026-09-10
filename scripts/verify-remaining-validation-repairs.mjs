import assert from 'node:assert/strict';
import fs from 'node:fs';
import {configuredValidationCommands} from '../packages/main/dist/handlers/validation-identity.js';
import {runValidationCommand} from '../packages/main/dist/core/validation-executor.js';
const targets=[
  "packages/main/tests/milestone-status.test.mjs",
  "packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js",
  "packages/main/dist/tasks/verification-run-and-guard-smoke.js",
  "packages/main/dist/tasks/validate-progress-heartbeat-smoke.js",
  "packages/main/dist/tasks/done-required-head-drift-proof.js",
  "packages/main/dist/tasks/quorum-submit-smoke.js",
  "packages/main/dist/tasks/withdrawn-disposition-smoke.js",
  "packages/main/tests/red/red-done-prepare-done-parity.mjs",
  "packages/main/dist/tasks/post-done-closure-snapshot-smoke.js",
  "packages/main/tests/red/red-b49d4-registration-derivation.mjs",
  "packages/main/tests/red/red-global-cli-exec-bit.mjs",
  "packages/main/tests/red/red-w2b-wiring-contract.mjs",
  "packages/main/tests/red/red-w2c-wiring-detectability.mjs",
  "packages/main/dist/tasks/frozen-claim-snapshot-hook-smoke.js",
  "packages/main/dist/tasks/proofstory-acceptance-rollout-smoke.js",
  "packages/main/dist/tasks/proofstory-acceptance-basis-smoke.js",
  "packages/main/dist/tasks/dev-memory-lifecycle-gates-smoke.js",
  "packages/main/tests/red/red-w2d-command-readonly.mjs",
  "packages/main/dist/tasks/cli-surface-smoke.js",
  "packages/main/dist/tasks/command-ownership-contract.js",
  "scripts/verify-orphan-surface.mjs",
  "packages/main/dist/tasks/validation-tier-planner-smoke.js",
  "packages/main/dist/tasks/single-owner-extraction-smoke.js",
  "packages/main/dist/tasks/narrowing-repin-smoke.js",
  "packages/main/dist/tasks/validation-protocol-smoke.js",
  "packages/main/dist/tasks/managed-review-evidence-smoke.js",
  "packages/main/dist/tasks/proof-admissibility-registry-smoke.js",
  "packages/main/dist/tasks/provider-process-registry-smoke.js",
  "packages/main/dist/tasks/semantic-scope-guard-smoke.js",
  "packages/main/dist/tasks/flow-stability-smoke.js"
];
const configured=configuredValidationCommands(process.cwd());
const rows=[];
for(const target of targets){
 const matches=configured.filter(c=>c.args.includes(target));assert.equal(matches.length,1,'unique configured target '+target);
 const result=await runValidationCommand(matches[0],process.cwd());rows.push({target,...result});
 if(process.env.REMAINING_VALIDATION_REPORT_PATH)fs.writeFileSync(process.env.REMAINING_VALIDATION_REPORT_PATH,JSON.stringify(rows,null,2));
 console.log(JSON.stringify({target,code:result.code,durationMs:result.durationMs}));
 assert.equal(result.code,0,'REMAINING_VALIDATION_FAILURE: '+target+'\n'+result.output);
}
console.log('ALL_30_ORIGINAL_VALIDATION_FAILURES_REPAIRED');
