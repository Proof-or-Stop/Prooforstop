import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync, oldExit=process.exitCode, oldLog=console.log, oldError=console.error;
const lines=[];
try {
 cp.spawnSync=()=>({status:null,signal:'SIGTERM',error:Object.assign(new Error('fixture deadline exhausted'),{code:'ETIMEDOUT'})});syncBuiltinESMExports();
 console.log=(...v)=>lines.push(v.join(' '));console.error=console.log;
 await import('./lab/verify-intake-round-four.mjs?timeout-control');
 assert.equal(process.exitCode,124,'INTAKE_TIMEOUT_MISCLASSIFIED: a deadline must propagate as timeout, not ordinary RED');
 assert(lines.some(x=>x.includes('INTAKE_VERIFICATION_TIMEOUT')));
 assert(!lines.some(x=>/INTAKE_ROUND_FOUR_(RED|GREEN)/.test(x)));
} finally {cp.spawnSync=original;syncBuiltinESMExports();console.log=oldLog;console.error=oldError;process.exitCode=oldExit;}
console.log('INTAKE_TIMEOUT_CLASSIFICATION_GREEN real wrapper reports timeout without RED/GREEN');
const {runIntakeChecks}=await import('./lab/intake-verification-runner.mjs');
const {mkdtempSync,writeFileSync,rmSync,existsSync}=await import('node:fs');
const {tmpdir}=await import('node:os');const {join}=await import('node:path');
let clock=1000;const budgets=[];
assert.equal(runIntakeChecks(['first','second'],'BUDGET',{budgetMs:10000,env:{},now:()=>clock,log:()=>{},spawn:(cmd,args,opts)=>{
 budgets.push(opts.timeout);
 let innerBudget;
 assert.equal(runIntakeChecks(['inner'],'NESTED',{budgetMs:10000,env:opts.env,now:()=>clock,log:()=>{},spawn:(c,a,o)=>{innerBudget=o.timeout;return {status:0};}}),0);
 assert(innerBudget<opts.timeout,'child harness deadline must be inside parent timeout');
 clock+=3000;return {status:0};
}}),0);
assert(budgets[1]<budgets[0],'siblings must spend one cumulative budget');
for(const [result,code,marker] of [[{status:124},124,'TIMEOUT'],[{status:null,signal:'SIGINT'},125,'INTERRUPTED'],[{status:1},1,'ORDINARY_RED']]){
 const output=[];assert.equal(runIntakeChecks(['fixture'],'ORDINARY',{env:{},spawn:()=>result,log:x=>output.push(x)}),code);
 assert(output.some(x=>x.includes(marker)));
 if(code!==1)assert(!output.some(x=>x.includes('ORDINARY_RED')));
}
let launched=false;
assert.equal(runIntakeChecks(['expired'],'EXPIRED',{env:{PROOF_OR_STOP_INTAKE_VERIFICATION_DEADLINE_MS:'1'},spawn:()=>{launched=true;},log:()=>{}}),124);assert(!launched);
const tmp=mkdtempSync(join(tmpdir(),'intake-timeout-'));
try {
 const marker=join(tmp,'late-write');const script=join(tmp,'hang.mjs');
 writeFileSync(script,`import {writeFileSync} from 'node:fs';setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'too late'),2000);`);
 const output=[];
 assert.equal(runIntakeChecks([script],'REAL_TIMEOUT',{budgetMs:250,env:{...process.env},log:x=>output.push(x)}),124);
 assert(!existsSync(marker));assert(output.some(x=>x.includes('INTAKE_VERIFICATION_TIMEOUT')));
} finally {rmSync(tmp,{recursive:true,force:true});}
console.log('INTAKE_SHARED_DEADLINE_GREEN cumulative sibling budget, nested headroom, real timeout, interruption and failure classification');
