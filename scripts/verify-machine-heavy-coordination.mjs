import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const base=mkdtempSync(join(tmpdir(),'machine-heavy-')), children=[], release=join(base,'release');
const runner=resolve('packages/main/dist/tasks/full-suite-runner.js');
const worker=join(base,'worker.mjs');
writeFileSync(worker,`import{runEntry,FULL_SUITE_ENTRIES,createFullSuiteRunState}from ${JSON.stringify(runner)};const entry=FULL_SUITE_ENTRIES.find(e=>e.name==='test:flow-stability-smoke');if(!entry)throw Error('missing real heavy policy');const r=await runEntry({...entry,timeoutMs:15000},process.argv[2],'npm',undefined,createFullSuiteRunState());console.log(JSON.stringify(r));process.exitCode=r.status==='PASS'?0:1;`);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function start(root){const p=spawn(process.execPath,[worker,root],{stdio:['ignore','pipe','pipe']});children.push(p);let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);const done=new Promise((r,j)=>{p.once('error',j);p.once('close',code=>r({code,output}));});return{p,done};}
try{
 const roots=['a','b'].map(n=>join(base,n));const markers=roots.map((_,i)=>join(base,`started-${i}`));
 for(const [i,root]of roots.entries()){
  mkdirSync(root);execFileSync('git',['init','-q',root]);
  writeFileSync(join(root,'heavy.cjs'),`const fs=require('fs');fs.writeFileSync(${JSON.stringify(markers[i])},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('HEAVY_DONE');}},10);setTimeout(()=>{clearInterval(timer);process.exitCode=1},12000).unref();`);
  writeFileSync(join(root,'package.json'),JSON.stringify({scripts:{'test:flow-stability-smoke':'node heavy.cjs'}}));
 }
 const a=start(roots[0]);for(let i=0;i<300&&!existsSync(markers[0])&&a.p.exitCode===null;i++)await delay(10);
 assert.ok(existsSync(markers[0]),'positive control: first heavy child is executing');
 const b=start(roots[1]);await delay(800);
 const overlapped=existsSync(markers[1]);writeFileSync(release,'release');
 const results=await Promise.all([a.done,b.done]);assert.ok(results.every(r=>r.code===0),JSON.stringify(results));
 assert.equal(overlapped,false,'U08 heavy CPU and process fanout must coordinate across repositories');
 assert.ok(markers.every(existsSync),'both heavy tasks eventually execute');
 console.log('PASS U08 actual heavy members coordinate across repositories');
}finally{
 writeFileSync(release,'release');
 for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill('SIGTERM');
 await Promise.all(children.filter(p=>p.exitCode===null&&p.signalCode===null).map(p=>new Promise(r=>p.once('close',r))));
 rmSync(base,{recursive:true,force:true});
}
