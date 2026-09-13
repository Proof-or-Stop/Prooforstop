import {spawnSync} from 'node:child_process';
for(const test of ['scripts/verify-intake-timeout-classification.mjs','scripts/verify-material-tree-memo.mjs','scripts/verify-lab-audit-prompt-budget.mjs','scripts/verify-lab-worktree.mjs','scripts/lab/verify-intake-round-four.mjs']){
 const r=spawnSync(process.execPath,[test],{stdio:'inherit',timeout:600000});
 console.log('INTAKE_FINISH_RESULT '+JSON.stringify({test,status:r.status,signal:r.signal}));
 if(r.status!==0){process.exitCode=1;break;}
}
if(!process.exitCode)console.log('INTAKE_FINISH_GREEN');
