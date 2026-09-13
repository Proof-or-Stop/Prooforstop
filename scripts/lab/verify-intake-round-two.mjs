import {spawnSync} from 'node:child_process';
const tests=['scripts/ensure-dist.mjs','packages/main/dist/tasks/single-owner-extraction-smoke.js','scripts/verify-memory-preindex-hit.mjs','scripts/verify-intake-discovery.mjs','packages/main/dist/tasks/playbook-runtime-memory-m3-m6-smoke.js','scripts/lab/verify-intake-history.mjs'];
let failed=false;
for(const test of tests){const r=spawnSync(process.execPath,[test],{stdio:'inherit',timeout:240000});console.log('ROUND_TWO_RESULT '+JSON.stringify({test,status:r.status,signal:r.signal}));if(r.status!==0)failed=true;if(test===tests[0]&&failed)break;}
if(failed){console.error('INTAKE_ROUND_TWO_RED');process.exitCode=1;}else console.log('INTAKE_ROUND_TWO_GREEN');
