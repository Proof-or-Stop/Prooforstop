import assert from 'node:assert/strict';
import {writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const repo=process.cwd();
const runtime=nestedSourceRuntime(repo);
const {base,delegation,lock,executor,env}=runtime;
const worker=join(base,'worker.mjs'),owner=join(base,'owner.mjs'),marker=join(base,'stopped'),leaf=join(base,'leaf-launched');
// The --fault-leaf hook stalls the actual prepare boundary of the delegation module until the
// control resumes the stopped owner. It is composed through the shared source-runtime helper,
// so the TypeScript compiler is resolved from packages/main through Node's own resolution
// (hoisted or nested) instead of a hardcoded node_modules path.
const anchor='export async function prepareValidationReservationChild(options: ValidationReservationHandshakeOptions = {}): Promise<string | undefined> {';
const stall="\n process.send({stallOwner:true}); const faultUntil=Date.now()+1000; while(!existsSync("+JSON.stringify(marker)+")){if(Date.now()>faultUntil)throw Error('fault stop unavailable');await new Promise(r=>setTimeout(r,5));}\n";
runtime.writeLoader(`function patch(url,source){if(url!==${JSON.stringify(delegation)}||!process.argv.includes('--fault-leaf'))return source;const anchor=${JSON.stringify(anchor)};if(source.split(anchor).length!==2)throw Error('fault anchor mismatch');return source.replace(anchor,anchor+${JSON.stringify(stall)});}`);
writeFileSync(worker,`import {writeFileSync} from 'node:fs';const api=await import(${JSON.stringify(delegation)});const {runSingleAllowlistedCommand}=await import(${JSON.stringify(executor)});await new Promise(r=>process.once('message',r));await api.confirmValidationReservationRegistration();const start=performance.now();try{const result=await runSingleAllowlistedCommand('node -e '+JSON.stringify('require("node:fs").writeFileSync('+JSON.stringify(${JSON.stringify(leaf)})+',"launched")'),${JSON.stringify(base)},{timeoutMs:1500,...(process.argv.includes('--short-outer')?{deadlineAt:Date.now()+900}:{})});console.log('FAULT_RESULT '+JSON.stringify({result,ms:performance.now()-start}));}catch(error){console.log('FAULT_REFUSED '+JSON.stringify({message:error.message,ms:performance.now()-start}));}process.disconnect();`);
writeFileSync(owner,`import {spawn} from 'node:child_process';const api=await import(${JSON.stringify(delegation)});const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});await machine({root:${JSON.stringify(base)},workspaceRoot:${JSON.stringify(base)},command:'own stalled issuer diagnostic',deadlineAt:Date.now()+10000},async()=>{const token=await api.prepareValidationReservationChild();await api.attemptValidationReservationSpawn(token);const child=spawn(process.execPath,[${JSON.stringify(worker)},'--fault-leaf',...process.argv.slice(2)],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});child.on('message',message=>{if(message.stallOwner){process.send({stalled:true,workerPid:child.pid});process.kill(process.pid,'SIGSTOP');}});await api.registerValidationReservationChild(child.pid,token);child.send({go:true});await new Promise(r=>child.once('close',r));});process.disconnect();`);
try {
 for(const mode of ['timeout-only','short-outer']) {
  rmSync(marker,{force:true});let output='',resume,child,workerPid,workerStart;const startOf=pid=>{try{return execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:1000}).trim()||null;}catch{return null;}};
  const start=performance.now();
  try {
   child=spawn(process.execPath,[owner,...(mode==='short-outer'?['--short-outer']:[])],{env,stdio:['ignore','pipe','pipe','ipc'],detached:true});
   child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
   child.on('message',message=>{if(message.workerPid&&workerPid===undefined){workerPid=message.workerPid;workerStart=startOf(workerPid);}if(message.stalled){let state=execFileSync('ps',['-p',String(child.pid),'-o','stat='],{encoding:'utf8'});assert.match(state,/T/);writeFileSync(marker,'stopped');resume=setTimeout(()=>child.kill('SIGCONT'),2300);}});
   const closed=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('diagnostic transport deadline')),12000);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
   // A typed delegation refusal before launch is folded into the command result
   // contract as a non-success infrastructure result; it must not surface as an
   // exception, must carry the refusal diagnostic, and must never launch the leaf.
   assert.doesNotMatch(output,/FAULT_REFUSED /,output);const match=output.match(/FAULT_RESULT (\{[^\n]+\})/);assert.ok(match,output);const observed=JSON.parse(match[1]);const result=observed.result;console.log('OBSERVED '+JSON.stringify({mode,observed,closed,seconds:(performance.now()-start)/1000}));assert.notEqual(result.code,0,JSON.stringify(result));assert.match(result.output,/deadline|expired|live reservation revoked/);assert.ok(observed.ms< (mode==='short-outer'?1300:1900),JSON.stringify(observed));assert.equal(existsSync(leaf),false);

  }finally{clearTimeout(resume);if(child?.exitCode===null){child.kill('SIGCONT');child.kill('SIGTERM');}
   // The detached worker is signalled by recorded identity on every path, so a failing assertion leaves no worker behind.
   if(workerPid&&workerStart&&startOf(workerPid)===workerStart){try{process.kill(-workerPid,'SIGTERM');}catch{/* already gone */}} }
 }
 console.log('STALLED_ISSUER_ORIGINAL_DEADLINE PASS');
}finally{rmSync(base,{recursive:true,force:true});}
