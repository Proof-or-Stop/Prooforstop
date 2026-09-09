import assert from 'node:assert/strict';import{spawn,execFileSync}from'node:child_process';import{mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
const repo=process.argv[2]??process.cwd(),base=mkdtempSync(join(tmpdir(),'u08-unknown-')),a=join(base,'a'),b=join(base,'b');for(const r of[a,b]){mkdirSync(r);execFileSync('git',['init','-q',r]);}
const {runValidationCommand}=await import(repo+'/packages/main/dist/core/validation-executor.js');const{runEntry,createFullSuiteRunState}=await import(repo+'/packages/main/dist/tasks/full-suite-runner.js');
const heavy=[{class:'machine-cpu',key:'heavy',access:'exclusive'}],sleep=ms=>new Promise(r=>setTimeout(r,ms));let child;
try{
 const ready=join(base,'ready'),end=join(base,'end'),marker=join(base,'contender');
 const worker=join(base,'worker.mjs');writeFileSync(worker,`import{runEntry,createFullSuiteRunState}from ${JSON.stringify(repo+'/packages/main/dist/tasks/full-suite-runner.js')};const r=await runEntry({name:'hold',resources:${JSON.stringify(heavy)},timeoutMs:5000,tempOwnership:'runner-owned-unique'},${JSON.stringify(a)},'npm',undefined,createFullSuiteRunState());if(r.status!=='PASS')throw Error(JSON.stringify(r));`);
 const leaf=join(base,'leaf.cjs');writeFileSync(leaf,`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>fs.writeFileSync(${JSON.stringify(end)},'end'),1500);`);writeFileSync(join(a,'package.json'),JSON.stringify({scripts:{hold:JSON.stringify(process.execPath)+' '+JSON.stringify(leaf)}}));
 child=spawn(process.execPath,[worker],{stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',x=>output+=x);const done=new Promise(r=>child.once('close',r));
 for(let i=0;i<300&&!existsSync(ready);i++)await sleep(10);assert.ok(existsSync(ready),output);
 const result=await runValidationCommand({label:'undeclared',command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'spawn')`],resources:[],timeoutMs:3000},b);
 const overlapped=!existsSync(end);console.log(JSON.stringify({code:result.code,contenderSpawned:existsSync(marker),heavyStillRunning:overlapped}));await done;
 assert.equal(overlapped,false,'RED unknown validation must wait behind machine heavy resource in another repo');
}finally{if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(base,{recursive:true,force:true});}
