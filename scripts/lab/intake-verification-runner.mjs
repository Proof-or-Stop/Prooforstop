import {spawnSync} from 'node:child_process';
// Every nested harness spends the same wall-clock budget. A child harness
// reserves cleanup time inside its parent's deadline; leaf processes are reaped
// by spawnSync before their parent can report a result.
const deadlineKey='PROOF_OR_STOP_INTAKE_VERIFICATION_DEADLINE_MS';
export function runIntakeChecks(tests,label,{cwd=process.cwd(),budgetMs=850000,env=process.env,now=Date.now,spawn=spawnSync,log=console.log}={}) {
 const inherited=env[deadlineKey]===undefined?Infinity:Number(env[deadlineKey]);
 if(!(inherited>0)||!Number.isFinite(budgetMs)||budgetMs<=0)throw new Error('Invalid intake verification deadline');
 const end=Math.min(now()+budgetMs,inherited-2000);
 const timeout=(test,reason)=>{log('INTAKE_VERIFICATION_TIMEOUT '+JSON.stringify({label,test,reason}));return 124;};
 for(const test of tests){
  const remaining=Math.floor(end-now());
  if(remaining<=0)return timeout(test,'shared deadline exhausted before launch');
  let r;
  try {r=spawn(process.execPath,[test],{cwd,stdio:'inherit',timeout:remaining,env:{...env,[deadlineKey]:String(end)}});}
  catch(error){log('INTAKE_VERIFICATION_ERROR '+JSON.stringify({label,test,error:String(error)}));return 125;}
  log(label+'_RESULT '+JSON.stringify({test,status:r.status,signal:r.signal,error:r.error?.code}));
  if(r.error?.code==='ETIMEDOUT'||r.status===124||now()>=end)return timeout(test,r.error?.code||'child deadline exhausted');
  if(r.signal||r.error||r.status===125){log('INTAKE_VERIFICATION_INTERRUPTED '+JSON.stringify({label,test,signal:r.signal,error:r.error?.message}));return 125;}
  if(r.status!==0){log(label+'_RED '+JSON.stringify({test,status:r.status}));return 1;}
 }
 log(label+'_GREEN');return 0;
}
