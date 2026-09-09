import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const base=mkdtempSync(join(tmpdir(),'machine-port-witness-')),children=[];
const executor=resolve('packages/main/dist/core/validation-executor.js');
const lock=resolve('packages/main/dist/core/validation-execution-lock.js');
const worker=join(base,'worker.mjs');
writeFileSync(worker,`import {runValidationCommand} from ${JSON.stringify(executor)};
import {withWorkspaceValidationCapacity} from ${JSON.stringify(lock)};
const [root,port,hold,marker]=process.argv.slice(2);
const resources=[{class:'fixed-port',key:port,access:'exclusive'}];
const code="const net=require('node:net'),fs=require('node:fs');const s=net.createServer();s.on('error',e=>{console.log(e.code);process.exitCode=1;});s.listen("+port+",'127.0.0.1',()=>{fs.writeFileSync("+JSON.stringify(marker)+",'bound');console.log('BOUND');setTimeout(()=>s.close(),"+hold+");});";
const result=await withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'port-witness',resources,maxConcurrent:2,deadlineAt:Date.now()+15000},()=>runValidationCommand({label:'real-port',command:process.execPath,args:['-e',code],resources,timeoutMs:10000},root));
console.log(result.output);process.exitCode=result.code;
`);
function start(root,port,hold,marker){
 const child=spawn(process.execPath,[worker,root,String(port),String(hold),marker],{stdio:['ignore','pipe','pipe']});children.push(child);let output='';
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,output}));});return {child,done};
}
async function pair(a,b,port,label){
 const marker=join(base,label+'.ready');const first=start(a,port,700,marker);
 const deadline=Date.now()+10000;while(!existsSync(marker)&&first.child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.ok(existsSync(marker),'control: first real listener must bind before competitor starts');
 const second=start(b,port,30,join(base,label+'.second'));return await Promise.all([first.done,second.done]);
}
try {
 const a=join(base,'a'),b=join(base,'b');for(const root of [a,b]){mkdirSync(root);execFileSync('git',['init','-q',root]);}
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const same=await pair(a,a,port,'same');assert.deepEqual(same.map(x=>x.code),[0,0],JSON.stringify(same));
 const cross=await pair(a,b,port,'cross');assert.deepEqual(cross.map(x=>x.code),[0,0],`U08 actual validation children must coordinate fixed ports across repositories: ${JSON.stringify(cross)}`);
 assert.ok(cross.every(x=>x.output.includes('BOUND')),'both real providers execute successfully');
 console.log('PASS U08 real cross-process cross-repository fixed-port coordination');
} finally {
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 await Promise.all(children.filter(child=>child.exitCode===null&&child.signalCode===null).map(child=>new Promise(r=>child.once('close',r))));
 rmSync(base,{recursive:true,force:true});
}
