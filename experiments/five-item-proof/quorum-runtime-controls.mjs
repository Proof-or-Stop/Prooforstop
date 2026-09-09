import assert from 'node:assert/strict';import {spawn,spawnSync} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {performance} from 'node:perf_hooks';
const runtime=process.env.QUORUM_TEST_RUNTIME??resolve(import.meta.dirname,'../..');const entry=join(runtime,'packages/main/dist/tasks/quorum-submit-smoke.js');
const root=mkdtempSync(join(tmpdir(),'quorum-runtime-controls-'));const failures=[];const log=(name,fn)=>{try{fn();console.log('PASS',name);}catch(e){failures.push({name,error:String(e)});console.log('FAIL',name,String(e));}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
try{
 log('relative result path is refused',()=>{const p=spawnSync(process.execPath,[entry,'--case-ids=Q009,Q010,Q011,Q012','--result-file=relative.json'],{cwd:root,encoding:'utf8',timeout:15000});assert.notEqual(p.status,0);assert.match(p.stderr+p.stdout,/QUORUM_RESULT_PATH_MUST_BE_ABSOLUTE/);});
 log('empty jobs environment retains serial default',()=>{const p=spawnSync(process.execPath,[entry,'--list-cases'],{cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,PROOF_OR_STOP_QUORUM_JOBS:''}});assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/QUORUM_CASE_MANIFEST:/);});
 const fake=join(root,'protocol-fixture.mjs'),events=join(root,'pids.jsonl');const registry=join(runtime,'packages/main/dist/tasks/quorum-case-registry.js');
 writeFileSync(fake,`import {QUORUM_CASES} from ${JSON.stringify(registry)};import {appendFileSync} from 'node:fs';import {spawn} from 'node:child_process';const args=process.argv.slice(2);if(args.includes('--list-cases')){console.log('QUORUM_CASE_MANIFEST:'+JSON.stringify(QUORUM_CASES.map(c=>({...c,bodyDigest:'fixture'}))));}else{const ids=args.find(a=>a.startsWith('--case-ids=')).slice(11).split(',');appendFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,event:'worker'})+'\\n');if(process.env.FIXTURE_CANCEL_MODE==='failure'&&ids.includes('Q001'))setTimeout(()=>process.exit(42),150);else{const child=spawn(process.execPath,['-e',\"setInterval(()=>{},1000)\"],{stdio:'ignore'});appendFileSync(${JSON.stringify(events)},JSON.stringify({pid:child.pid,event:'descendant'})+'\\n');setTimeout(()=>process.exit(1),5000);}}\n`);
 const driver=join(root,'driver.mjs');writeFileSync(driver,`import {runParallelQuorum} from ${JSON.stringify(join(runtime,'packages/main/dist/tasks/quorum-case-parallel.js'))};await runParallelQuorum(${JSON.stringify(fake)},4);`);
 const started=performance.now();const p=spawnSync(process.execPath,[driver],{cwd:root,encoding:'utf8',timeout:12000,env:{...process.env,FIXTURE_CANCEL_MODE:'failure'}});const elapsed=performance.now()-started;
 // This fixture tests process supervision only, not execution of the real73 assertions.
 const seen=existsSync(events)?readFileSync(events,'utf8').trim().split('\n').map(JSON.parse):[];
 log('non-first failure cancels siblings promptly',()=>{assert.notEqual(p.status,0);assert.match(p.stderr,/QUORUM_SHARD_FAILED 1/);assert.ok(elapsed<3000,'failed shard waited '+elapsed+'ms');});
 for(const row of seen)log('owned process reaped '+row.event,()=>assert.equal(alive(row.pid),false,'owned pid '+row.pid+' survived parent failure'));
 // Clean only positively identified private fixture processes after failed RED.
 for(const row of seen)if(alive(row.pid))try{process.kill(row.pid,'SIGKILL');}catch{}

 const signalResults=[];
 for(const signal of ['SIGINT','SIGTERM']){
  writeFileSync(events,'');let output='';const proc=spawn(process.execPath,[driver],{cwd:root,env:{...process.env,FIXTURE_CANCEL_MODE:'signal'},stdio:['ignore','pipe','pipe']});proc.stdout.on('data',b=>output+=b);proc.stderr.on('data',b=>output+=b);
  let closed=false;const completion=new Promise(resolve=>proc.once('close',(code,sig)=>{closed=true;resolve({code,signal:sig});}));
  const startedAt=performance.now();let owned=[];
  while(performance.now()-startedAt<5000){owned=readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);if(owned.length>=8||closed)break;await new Promise(r=>setTimeout(r,25));}
  const sent=performance.now();proc.kill(signal);const done=await Promise.race([completion,new Promise(r=>setTimeout(()=>r(null),3000))]);
  log(signal+' cancels and reaps all descendants',()=>{assert.equal(owned.length,8,'All four workers and descendants must start before signal');assert.ok(done,'Signal cancellation did not finish within3s');assert.match(output,new RegExp('QUORUM_INTERRUPTED '+signal));assert.notEqual(done.code,0);for(const row of owned)assert.equal(alive(row.pid),false,'owned pid survives signal '+row.pid);});
  signalResults.push({signal,elapsedMs:performance.now()-sent,owned,done,output});if(!closed)proc.kill('SIGKILL');for(const row of owned)if(alive(row.pid))try{process.kill(row.pid,'SIGKILL');}catch{}
 }
 const report={fixture:'process protocol only; genuine full73 runs have separate evidence',elapsedMs:elapsed,pids:seen,signalResults,failures};const out=process.env.FIVE_ITEM_PROOF_OUTPUT;if(out){const {mkdirSync}=await import('node:fs');mkdirSync(out,{recursive:true});writeFileSync(join(out,'quorum-runtime-controls.json'),JSON.stringify(report,null,2)+'\n');}
 assert.equal(failures.length,0,'QUORUM_SUPERVISION_GAPS: cancellation and diagnostic execution contract');console.log('QUORUM_RUNTIME_CONTROLS_GREEN');
}finally{rmSync(root,{recursive:true,force:true});}
