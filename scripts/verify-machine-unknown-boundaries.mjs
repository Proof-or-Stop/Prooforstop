import assert from 'node:assert/strict';import{spawn,execFileSync}from'node:child_process';import{mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
const repo=process.argv[2]??process.cwd(),base=mkdtempSync(join(tmpdir(),'u08-unknown-suite-'));const{runValidationCommand}=await import(repo+'/packages/main/dist/core/validation-executor.js');const{runEntry,createFullSuiteRunState}=await import(repo+'/packages/main/dist/tasks/full-suite-runner.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),heavy=[{class:'machine-cpu',key:'heavy',access:'exclusive'}],failures=[];let serial=0;const live=[];
async function scenario(label,holderKind,holderResources,contenderKind,contenderResources,mode='serialize'){
 const dir=join(base,String(serial++));mkdirSync(dir);const a=join(dir,'a'),b=join(dir,'b');for(const r of[a,b]){mkdirSync(r);execFileSync('git',['init','-q',r]);}
 const ready=join(dir,'ready'),end=join(dir,'end'),mark=join(dir,'mark'),leaf=join(dir,'leaf.cjs');writeFileSync(leaf,`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},'1');setTimeout(()=>fs.writeFileSync(${JSON.stringify(end)},'1'),900);`);
 writeFileSync(join(a,'package.json'),JSON.stringify({scripts:{hold:JSON.stringify(process.execPath)+' '+JSON.stringify(leaf)}}));writeFileSync(join(b,'package.json'),JSON.stringify({scripts:{run:JSON.stringify(process.execPath)+' -e '+JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(mark)},'1')`)}}));
 const command={label:'hold',command:process.execPath,args:[leaf],timeoutMs:5000,...(holderResources===undefined?{}:{resources:holderResources})};
 const worker=join(dir,'worker.mjs');writeFileSync(worker,`import{runValidationCommand}from ${JSON.stringify(repo+'/packages/main/dist/core/validation-executor.js')};import{runEntry,createFullSuiteRunState}from ${JSON.stringify(repo+'/packages/main/dist/tasks/full-suite-runner.js')};const r=await ${holderKind==='entry'?`runEntry({name:'hold',resources:${JSON.stringify(holderResources)},timeoutMs:5000,tempOwnership:'runner-owned-unique'},${JSON.stringify(a)},'npm',undefined,createFullSuiteRunState())`:`runValidationCommand(${JSON.stringify(command)},${JSON.stringify(a)})`};if((r.code??(r.status==='PASS'?0:1))!==0)throw Error(JSON.stringify(r));`);
 const child=spawn(process.execPath,[worker],{stdio:['ignore','pipe','pipe']});live.push(child);let output='';child.stderr.on('data',d=>output+=d);const done=new Promise(r=>child.once('close',r));
 for(let i=0;i<300&&!existsSync(ready)&&child.exitCode===null;i++)await sleep(10);assert.ok(existsSync(ready),label+output);
 const controller=new AbortController();let timer;if(mode==='cancel')timer=setTimeout(()=>controller.abort(new Error('unknown cancel witness')),80);
 let error,result;try{result=contenderKind==='entry'?await runEntry({name:'run',resources:contenderResources,timeoutMs:3000,tempOwnership:'runner-owned-unique'},b,'npm',undefined,createFullSuiteRunState()):await runValidationCommand({label:'contender',command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(mark)},'1')`],timeoutMs:mode==='deadline'?80:3000,...(contenderResources===undefined?{}:{resources:contenderResources})},b,3000,{abortSignal:controller.signal});}catch(e){error=e;}finally{clearTimeout(timer);}
 const overlap=existsSync(mark)&&!existsSync(end),spawned=existsSync(mark);assert.equal(await done,0,output);
 const pass=mode==='parallel'?overlap:mode==='serialize'?!overlap&&!error&&spawned:!spawned&&!error&&result?.code===124&&result?.timedOut===true&&result?.effectiveTimeoutMs===0;
 console.log(JSON.stringify({label,pass,mode,overlap,spawned,error:error?.message}));if(!pass)failures.push(label);
 // Queue cleanup must permit a later ordinary command using the same declaration.
 const again=await runValidationCommand({label:'reacquire',command:process.execPath,args:['-e','process.exit(0)'],resources:contenderResources,timeoutMs:2000},b);assert.equal(again.code,0,label+' reacquire');
}
try{
 await scenario('heavy -> unknown empty','entry',heavy,'validation',[]);
 await scenario('unknown missing -> heavy','validation',undefined,'entry',heavy);
 await scenario('unknown -> unknown','validation',[],'validation',undefined);
 await scenario('queued unknown cancel','entry',heavy,'validation',[],'cancel');
 await scenario('queued unknown deadline','entry',heavy,'validation',undefined,'deadline');
 await scenario('explicit independent file claims','validation',[{class:'fixed-path',key:'a.txt',access:'exclusive'}],'validation',[{class:'fixed-path',key:'b.txt',access:'exclusive'}],'parallel');
 await scenario('fullsuite isolated empty is explicit','entry',[],'entry',heavy,'parallel');
 assert.deepEqual(failures,[],'unknown machine barrier boundary failures');
}finally{for(const child of live)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(base,{recursive:true,force:true});}
