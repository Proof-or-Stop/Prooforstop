import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const driver=fileURLToPath(new URL('./verify-native-lock-prerequisites.mjs',import.meta.url));
const driverSource=readFileSync(driver,'utf8');
const driverAst=ts.createSourceFile(driver,driverSource,ts.ScriptTarget.Latest,true);
const cleanup=driverAst.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='cleanupFixtureRuntime');
assert.equal(cleanup.length,1,'execute the actual native driver cleanup implementation');
for(const stage of ['observation','dispose','assertion']) {
 const primary=new Error('original verification failure');
 const cleanupError=new Error('controlled cleanup failure: '+stage);
 const warnings=[];
 const context={completeCapacity:true,stopping:false,
  fixtureRuntime:{dispose(){if(stage==='dispose')throw cleanupError;}},
  observeFixtureCoordination(){if(stage==='observation')throw cleanupError;return [];},
  assertFixtureCoordinationRemoved(){if(stage==='assertion')throw cleanupError;},
  console:{error:message=>warnings.push(message)}};
 const invoke=failed=>runInNewContext(cleanup[0].getText(driverAst)+'\ncleanupFixtureRuntime('+failed+');',context);
 assert.throws(()=>{try{throw primary;}finally{invoke(true);}},error=>error===primary,
  'NATIVE_CLEANUP_MASKS_PRIMARY_FAILURE: '+stage);
 assert.match(warnings[0],/NATIVE_DRIVER_CLEANUP_WARNING/);
 assert.throws(()=>invoke(false),error=>error===cleanupError,'cleanup failure must reject an otherwise successful run');
 context.stopping=true;
 assert.doesNotThrow(()=>invoke(false),'cleanup failure must preserve requested signal termination');
}
const scratch=mkdtempSync(join(tmpdir(),'native-driver-signal-proof-'));
try {
 const preload=join(scratch,'deny-first-signal.mjs');
 writeFileSync(preload,"const kill=process.kill;let denied=false;process.kill=function(pid,signal){if(pid<0&&signal==='SIGTERM'&&!denied){denied=true;throw Object.assign(new Error('controlled signal denial'),{code:'EPERM'});}return kill.call(this,pid,signal);};");
 for(const [signal,deny] of [['SIGTERM',false],['SIGINT',false],['SIGTERM',true]]) {
  const started=performance.now();let output='',sent=false;
  const child=spawn(process.execPath,[...(deny?['--import',preload]:[]),driver,'--signal-contract-child'],{stdio:['ignore','pipe','pipe']});
  let timedOut=false;
  const timer=setTimeout(()=>{
   timedOut=true;child.kill('SIGKILL');
   const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);
   if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error(String(error));}
  },15000);
  const collect=chunk=>{output+=chunk.toString();if(!sent&&/NATIVE_DRIVER_CHILD \d+/.test(output)){sent=true;child.kill(signal);}};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  child.once('exit',code=>{
   if(code===(signal==='SIGTERM'?143:130))return;
   const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);
   if(pid)try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error(String(error));}
  });
  let result;
  try {
  try {result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}
  finally {clearTimeout(timer);}
  assert.equal(timedOut,false,'signal witness transport deadline: '+output);assert.equal(result.signal,null,output);assert.equal(result.code,signal==='SIGTERM'?143:130,output);
  const root=output.match(/NATIVE_DRIVER_RUNTIME (.+)/)?.[1];assert(root,output);assert.equal(existsSync(root),false,'reaped driver must dispose its runtime');
  const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);assert(pid>0,output);
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','driver must observe child exit before deleting runtime');
  if(deny)assert.match(output,/NATIVE_DRIVER_SIGNAL_WARNING/);
  console.log('NATIVE_DRIVER_SIGNAL_TIMING '+JSON.stringify({requestedSignal:signal,deny,elapsedMs:performance.now()-started,...result}));
  } finally {
   // Also clean the controlled old-code failure witness; do not orphan its child.
   const pid=Number(output.match(/NATIVE_DRIVER_CHILD (\d+)/)?.[1]);
   let gone=!pid;
   if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}}
   for(let i=0;!gone&&i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}}
   const root=output.match(/NATIVE_DRIVER_RUNTIME (.+)/)?.[1];
   if(gone&&root)rmSync(root,{recursive:true,force:true});
  }
 }
 console.log('NATIVE_DRIVER_SIGNALS_PASS real TERM INT and denied-signal escalation cleanup');
} finally {rmSync(scratch,{recursive:true,force:true});}
