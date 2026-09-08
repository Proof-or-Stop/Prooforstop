#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {withWorkspaceValidationCapacity} from '../../packages/main/dist/core/validation-execution-lock.js';
const script=fileURLToPath(import.meta.url);
const run=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const write=(r,p,s)=>{mkdirSync(dirname(join(r,p)),{recursive:true});writeFileSync(join(r,p),s);};
const implementations={left:'export const add=(a,b)=>a+b;\n',right:'export const multiply=(a,b)=>a*b;\n'};
if(process.argv[2]==='--child'){
 const [root,kind,resource]=process.argv.slice(3);
 if(process.send)await new Promise(resolve=>{process.once('message',resolve);process.send('ready');});
 const start=Date.now();
 if(kind==='capacity')await withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'isolated-real-tests',pollMs:5,maxConcurrent:2,...(resource==='unknown'?{}:{resources:[{class:resource==='conflict'?'fixed-port':'fixed-path',key:resource==='conflict'?'65429':root,access:'exclusive'}]})},async()=>{
  console.log(JSON.stringify({event:'enter',at:Date.now(),queueMs:Date.now()-start,pid:process.pid}));
  execFileSync(process.execPath,['--test','tests/acceptance.mjs'],{cwd:root,stdio:'pipe'});
  console.log(JSON.stringify({event:'exit',at:Date.now(),pid:process.pid}));
 });
 else {write(root,kind+'.mjs',implementations[kind]);run(root,['add',kind+'.mjs']);run(root,['commit','-qm','implement '+kind]);execFileSync(process.execPath,['--test','tests/'+kind+'.mjs'],{cwd:root,stdio:'pipe'});console.log(JSON.stringify({event:'implemented',kind,head:run(root,['rev-parse','HEAD']),at:Date.now()}));}
 process.exit(0);
}
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'five-delivery-'+Date.now());mkdirSync(output,{recursive:true});const rows=[];
async function pairChildren(specs){let ready=0;const children=[];return Promise.all(specs.map(args=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[script,'--child',...args],{stdio:['ignore','pipe','pipe','ipc']});children.push(p);const timer=setTimeout(()=>p.kill(),30000);let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('message',()=>{if(++ready===specs.length)children.forEach(c=>c.send('start'));});p.on('error',reject);p.on('exit',code=>{clearTimeout(timer);code===0?resolve(stdout.trim().split('\n').filter(Boolean).map(JSON.parse)):reject(Error(stderr||'child exit '+code));});})));}
for(let trial=1;trial<=5;trial++){
 for(const mode of trial%2?['RED','GREEN']:['GREEN','RED']){
  const root=mkdtempSync(join(tmpdir(),'five-worktrees-'));const a=join(root,'a'),b=join(root,'b'),repo=join(root,'repo');mkdirSync(repo);
  try{
   write(repo,'tests/acceptance.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';test('same fixed hash workload and oracle',()=>{assert.equal(createHash('sha256').update('abc').digest('hex'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');for(let i=0;i<70000;i++)assert.equal(createHash('sha256').update(String(i)).digest().length,32);});\n");
   run(repo,['init','-q','-b','trunk']);run(repo,['config','user.name','Lab fixture']);run(repo,['config','user.email','lab@example.test']);run(repo,['add','.']);run(repo,['commit','-qm','fixed workload']);
   for(const [p,branch]of [[a,'left'],[b,'right']])run(repo,['worktree','add','-q','-b',branch,p]);
   const begin=performance.now();const events=await pairChildren([[a,'capacity',mode==='RED'?'unknown':'declared'],[b,'capacity',mode==='RED'?'unknown':'declared']]);const elapsedMs=performance.now()-begin;
   const overlapMs=Math.min(events[0][1].at,events[1][1].at)-Math.max(events[0][0].at,events[1][0].at);assert.equal(overlapMs>0,mode==='GREEN','resource admission overlap contract');rows.push({kind:'capacity',trial,mode,elapsedMs,events,overlapMs});
   if(trial===1&&mode==='GREEN'){const conflict=await pairChildren([[a,'capacity','conflict'],[b,'capacity','conflict']]);assert.ok(Math.min(conflict[0][1].at,conflict[1][1].at)<=Math.max(conflict[0][0].at,conflict[1][0].at));rows.push({kind:'conflict-control',events:conflict,status:'PASS'});}
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 for(const mode of trial%2?['RED','GREEN']:['GREEN','RED']){
  const root=mkdtempSync(join(tmpdir(),'five-delivery-'));const repo=join(root,'repo');mkdirSync(repo);
  try{
   write(repo,'left.mjs','export const add=()=>undefined;\n');write(repo,'right.mjs','export const multiply=()=>undefined;\n');
   for(const [name,fn,op] of [['left','add','+'],['right','multiply','*']])write(repo,'tests/'+name+'.mjs',`import test from 'node:test';import assert from 'node:assert/strict';import {${fn}} from '../${name}.mjs';test('${name} full fixed acceptance',()=>{for(let a=-30;a<=30;a++)for(let b=-30;b<=30;b++)assert.equal(${fn}(a,b),a${op}b);});\n`);
   run(repo,['init','-q','-b','trunk']);run(repo,['config','user.name','Lab fixture']);run(repo,['config','user.email','lab@example.test']);run(repo,['add','.']);run(repo,['commit','-qm','same requested delivery']);
   let failed=false;try{execFileSync(process.execPath,['--test','tests/left.mjs','tests/right.mjs'],{cwd:repo,stdio:'pipe'});}catch{failed=true;}assert.ok(failed,'initial feature defect must be real');
   const begin=performance.now();let events=[];
   if(mode==='RED'){for(const name of ['left','right'])write(repo,name+'.mjs',implementations[name]);run(repo,['add','left.mjs','right.mjs']);run(repo,['commit','-qm','deliver complete scope']);}
   else {const a=join(root,'a'),b=join(root,'b');run(repo,['worktree','add','-q','-b','left',a]);run(repo,['worktree','add','-q','-b','right',b]);events=await pairChildren([[a,'left',''],[b,'right','']]);run(repo,['merge','--no-edit','left','right']);}
   const transcript=execFileSync(process.execPath,['--test','--test-concurrency=2','tests/left.mjs','tests/right.mjs'],{cwd:repo,encoding:'utf8'});assert.match(transcript,/# fail 0/);const elapsedMs=performance.now()-begin;
   const bytes={left:readFileSync(join(repo,'left.mjs'),'utf8'),right:readFileSync(join(repo,'right.mjs'),'utf8')};assert.deepEqual(bytes,implementations);rows.push({kind:'decomposition',trial,mode,elapsedMs,events,acceptanceCases:7442,finalBytes:bytes,transcript});
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 console.log('Capacity and equal-scope delivery pair '+trial+' complete');
}
writeFileSync(join(output,'delivery-results.json'),JSON.stringify({rows,limitations:['resource benchmark uses a fixed hash test workload in actual temporary git worktrees','decomposition is automated patch/test/integration replay, not LLM development time','both plans reach byte-identical final scope and pass all 7442 cases; split setup, extra tests and integration included','root 134-command resource declarations were not relabeled independent']},null,2));console.log('DELIVERY_EXPERIMENT_COMPLETE');
