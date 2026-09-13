import {spawnSync} from 'node:child_process';
let failed=false;
for(const test of ['scripts/ensure-dist.mjs','scripts/verify-memory-learning-scope.mjs','packages/main/dist/tasks/experience-layer-finding-signals-smoke.js','scripts/lab/verify-intake-round-two.mjs']){const r=spawnSync(process.execPath,[test],{stdio:'inherit',timeout:600000});console.log('ROUND_THREE_RESULT '+JSON.stringify({test,status:r.status,signal:r.signal}));if(r.status!==0){failed=true;break;}}
if(failed){console.error('INTAKE_ROUND_THREE_RED');process.exitCode=1;}else console.log('INTAKE_ROUND_THREE_GREEN');
