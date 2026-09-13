import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nestedSourceRuntime} from './support/nested-reservation-source-runtime.mjs';
const {base,env}=nestedSourceRuntime(process.cwd());
const entry=join(base,'finding-material-reattestation-smoke.js'),record=join(base,'worker.pid');
const normal=process.argv.includes('--normal');
const isolation=pathToFileURL(join(process.cwd(),'packages/main/src/tasks/isolated-finding-fixture.ts')).href;
writeFileSync(join(base,'package.json'),JSON.stringify({type:'module'}));
writeFileSync(entry,`import {writeFileSync} from 'node:fs';const {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});if(!process.argv.includes('--isolated-finding-fixture-worker')){try{await runIsolatedFindingFixture(import.meta.url);console.log('NORMAL_OUTCOME_ACCEPTED');}catch(error){console.error(error.message);process.exitCode=1;}}else{writeFileSync(${JSON.stringify(record)},String(process.pid));console.log('ACTUAL_WORKER_ENTERED');if(!${normal})process.exit(7);}`);
let child,output='',timedOut=false;
const absent=pid=>{try{process.kill(-pid,0);return false;}catch(error){return error.code==='ESRCH';}};
try {
 child=spawn(process.execPath,[entry],{env:{...env,TMPDIR:base},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},6000);child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 console.log(output);assert.ok(existsSync(record),'actual worker must enter');
 assert.ok(absent(Number(readFileSync(record,'utf8'))),'actual entire worker group must be absent');
 assert.equal(timedOut,false,'WORKER_EXIT_WITHOUT_OUTCOME_MUST_NOT_WAIT_FIXTURE_DEADLINE');
 assert.equal(result.signal,null);assert.match(output,/ACTUAL_WORKER_ENTERED/);
 if(normal){assert.equal(result.code,0);assert.match(output,/NORMAL_OUTCOME_ACCEPTED/);}else{assert.equal(result.code,1);assert.match(output,/isolated Finding fixture worker exited without outcome/);assert.doesNotMatch(output,/NORMAL_OUTCOME_ACCEPTED/);}
 console.log(normal?'ISOLATED_NORMAL_OUTCOME PASS':'ISOLATED_WORKER_EXIT_WITHOUT_OUTCOME PASS');
}finally{
 if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGTERM');
 if(existsSync(record))assert.ok(absent(Number(readFileSync(record,'utf8'))),'own worker group cleanup unproven; retain scratch');
 rmSync(base,{recursive:true,force:true});
}
