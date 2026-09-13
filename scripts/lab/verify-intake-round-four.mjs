import {spawnSync} from 'node:child_process';
for(const test of ['scripts/ensure-dist.mjs','scripts/verify-memory-bottom-up.mjs','packages/main/dist/tasks/playbook-runtime-memory-index-smoke.js','scripts/lab/verify-intake-round-three.mjs']){const r=spawnSync(process.execPath,[test],{stdio:'inherit',timeout:600000});console.log('ROUND_FOUR_RESULT '+JSON.stringify({test,status:r.status,signal:r.signal}));if(r.status!==0){process.exitCode=1;break;}}
if(!process.exitCode)console.log('INTAKE_ROUND_FOUR_GREEN');
