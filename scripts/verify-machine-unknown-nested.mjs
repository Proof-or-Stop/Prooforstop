import assert from'node:assert/strict';import{spawn}from'node:child_process';import{mkdtempSync,writeFileSync,existsSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
const repo=process.argv[2]??process.cwd(),root=mkdtempSync(join(tmpdir(),'unknown-nested-'));const{withMachineValidationResources:lock}=await import(repo+'/packages/main/dist/core/validation-execution-lock.js');const{runValidationCommand}=await import(repo+'/packages/main/dist/core/validation-executor.js');
const heavy=[{class:'machine-cpu',key:'heavy',access:'exclusive'}];let launches=0;const opt=resources=>({root,workspaceRoot:root,command:'nested',resources,deadlineAt:Date.now()+4000});
try{
 await lock(opt(undefined),()=>lock(opt(heavy),()=>launches++));assert.equal(launches,1,'unknown owner includes explicit nested resources');
 await lock(opt([]),()=>assert.rejects(lock(opt(undefined),()=>launches++),/expand/));assert.equal(launches,1);
 await lock(opt(heavy),()=>lock(opt(heavy),()=>launches++));assert.equal(launches,2);
 for(const [parent,child]of [[undefined,heavy],[heavy,undefined],[undefined,undefined]]){
  const marker=join(root,'marker'),file=join(root,'child.mjs');writeFileSync(file,`import{runValidationCommand}from ${JSON.stringify(repo+'/packages/main/dist/core/validation-executor.js')};try{await runValidationCommand({label:'child',command:process.execPath,args:['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},'spawn')`)}],resources:${JSON.stringify(child)},timeoutMs:3000},${JSON.stringify(root)});process.exitCode=2;}catch(e){console.log(e.message);process.exitCode=/ancestor/.test(e.message)?0:3;}`);
  await lock(opt(parent),async()=>{const start=Date.now();const p=spawn(process.execPath,[file],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);const code=await new Promise(r=>p.once('close',r));assert.equal(code,0,out);assert.ok(Date.now()-start<2500,out);assert.ok(!existsSync(marker));});
 }
 console.log('PASS same-process subset/no expansion and all unknown ancestor conflicts zero spawn');
}finally{rmSync(root,{recursive:true,force:true});}
