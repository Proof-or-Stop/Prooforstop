import {nestedReservationLifecycleProgram} from './support/nested-reservation-lifecycle.mjs';
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import ts from 'typescript';
registerHooks({load(url,context,next){if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,context);}});
const {runSingleAllowlistedCommand}=await import('../packages/main/src/core/validation-executor.ts');
const started=performance.now();
const scratch=mkdtempSync(join(tmpdir(),'nested-verification-owner-'));
const loader=join(scratch,'source-loader.mjs');
writeFileSync(loader,`import ${JSON.stringify(new URL('./lab-source-loader.mjs',import.meta.url).href)};import {registerHooks,createRequire} from 'node:module';import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';const loadCompiler=createRequire(import.meta.url);let compiler;const ts=()=>compiler??=(loadCompiler(fileURLToPath(${JSON.stringify(import.meta.resolve('typescript'))})));registerHooks({load(url,context,next){if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts().transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts().ScriptTarget.ES2022,module:ts().ModuleKind.ESNext}}).outputText};return next(url,context);}});`);
const executor=new URL('../packages/main/src/core/validation-executor.ts',import.meta.url).href;
const isolation=new URL('../packages/main/src/tasks/isolated-finding-fixture.ts',import.meta.url).href;
const originalNodeOptions=process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS=(originalNodeOptions??'')+' --import='+JSON.stringify(loader);
try {
  writeFileSync(join(scratch,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(scratch,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'.'}));
  const direct=await runSingleAllowlistedCommand('node -e "console.log(12345)"',scratch,{timeoutMs:1500});
  assert.equal(direct.code,0,'DIRECT_EXECUTOR_POSITIVE_REQUIRED');
  assert.match(direct.output,/12345/);
  const entry=join(scratch,'finding-material-reattestation-smoke.js');
  writeFileSync(entry,`import ${JSON.stringify(loader)};
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {openSync,closeSync,unlinkSync,writeFileSync,fstatSync,readSync} from 'node:fs';
const {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});
const {runSingleAllowlistedCommand}=await import(${JSON.stringify(executor)});
const {withMachineValidationResources:machine}=await import(${JSON.stringify(new URL('../packages/main/src/core/validation-execution-lock.ts',import.meta.url).href)});
const {currentValidationReservationAbortSignal,prepareValidationReservationChild}=await import(${JSON.stringify(new URL('../packages/main/src/core/validation-reservation-delegation.ts',import.meta.url).href)});
if(await runIsolatedFindingFixture(import.meta.url))process.exit(0);
const root=${JSON.stringify(scratch)}, wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const options=(resources)=>({root,workspaceRoot:root,command:'nested-source-control',deadlineAt:Date.now()+10000,...(resources?{resources}:{})});
const group=process.argv.find(arg=>arg.startsWith('--owner-group='))?.split('=')[1]??'leaf';
if(group==='leaf'){
const requireLeaf=result=>{assert.equal(result.code,0,'NESTED_VERIFICATION_MACHINE_OWNER_REQUIRED');assert.match(result.output,/12345/,'NESTED_LEAF_OUTPUT_REQUIRED');};
const result=await runSingleAllowlistedCommand('node -e "console.log(12345)"',root,{timeoutMs:1500});
console.log('NESTED_NATIVE_EXECUTOR_RESULT '+JSON.stringify(result));requireLeaf(result);
const empty=await runSingleAllowlistedCommand('node -e "process.exit(0)"',root,{timeoutMs:1500});
assert.equal(empty.code,0);assert.throws(()=>requireLeaf(empty),/NESTED_LEAF_OUTPUT_REQUIRED/);
console.log('NESTED_EMPTY_LEAF_REFUSED');
}
if(group==='lineage'){
await machine(options(),async()=>{
 let active=0,maximum=0;
 await Promise.all([1,2].map(()=>machine(options(),async()=>{active++;maximum=Math.max(maximum,active);await wait(30);await machine(options(),()=>assert.equal(active,1));active--;})));
 assert.equal(maximum,1,'conflicting sibling grants must serialize');
});
console.log('NESTED_SIBLING_AND_ANCESTOR PASS');
let late;
await machine(options(),()=>{late=new Promise(resolve=>setTimeout(async()=>{try{await machine(options(),()=>{});resolve('unexpected-pass');}catch(error){resolve(error.message);}},30));});
assert.match(await late,/no longer active|revocation/,'abandoned invocation may not reenter');
console.log('NESTED_ABANDONED_CONTEXT_REFUSED');
let descendant, childStarted, stopped=false, revoked=false;
const childReady=new Promise(resolve=>{childStarted=resolve;});
await machine(options(),async()=>{
 descendant=machine(options(),async()=>{
  const signal=currentValidationReservationAbortSignal();assert.ok(signal);
  childStarted();
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('lineage revocation unavailable')),1500);const finish=()=>{clearTimeout(timer);revoked=true;resolve();};if(signal.aborted)finish();else signal.addEventListener('abort',finish,{once:true});});
  await assert.rejects(()=>machine(options(),()=>{throw Error('revoked callback entered');}),/revocation/);
  await wait(30);stopped=true;
 });
 await childReady;
});
await machine(options(),()=>assert.equal(stopped,true,'sibling entered before revoked descendant finished'));
await descendant;assert.equal(revoked,true);
await assert.rejects(()=>prepareValidationReservationChild({deadlineAt:Date.now()-1}),/expired/);
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(()=>prepareValidationReservationChild({signal:cancelled.signal}),/expired|revoked/);
console.log('NESTED_LINEAGE_REVOKED_WITH_CLAIMS_HELD PASS');
}
if(group==='resources'){
await machine(options([{class:'machine-cpu',key:'heavy',access:'exclusive'}]),async()=>{
 // Under this undeclared owner every claim is borrowable, so an unclassified request or a declared claim outside a borrowed frame is an expansion of that frame, never queued behind the owner's own ticket.
 await assert.rejects(()=>machine(options(),()=>{}),/expansion/);
 await assert.rejects(()=>machine(options([{class:'machine-process',key:'fanout',access:'exclusive'}]),()=>{}),/expansion/);
});
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
try {await assert.rejects(()=>machine(options([{class:'fixed-port',key:String(port),access:'exclusive'}]),()=>{throw Error('occupied port callback entered');}),/fixed-port .* unavailable/);
 // A port the owner never declared is acquired independently (its own ticket); widening it to exclusive inside the same process is refused by the in-process rule.
 await machine(options([{class:'fixed-port',key:String(port),access:'shared'}]),async()=>{await assert.rejects(()=>machine(options([{class:'fixed-port',key:String(port),access:'exclusive'}]),()=>{}),/expansion|cannot expand/);});
}finally{await new Promise(resolve=>server.close(resolve));}
await machine(options([{class:'fixed-port',key:String(port),access:'exclusive'}]),async()=>{const owned=createServer();await new Promise(resolve=>owned.listen(port,'127.0.0.1',resolve));try{await machine(options([{class:'fixed-port',key:String(port),access:'exclusive'}]),()=>{});}finally{await new Promise(resolve=>owned.close(resolve));}});
console.log('NESTED_RESOURCE_SUBSET_AND_PORT_REFUSAL PASS');
}
if(group==='descriptor'){
const probe=root+'/descriptor-probe.mjs';
writeFileSync(probe,${JSON.stringify("import "+JSON.stringify(loader)+";const {withMachineValidationResources:machine}=await import("+JSON.stringify(new URL('../packages/main/src/core/validation-execution-lock.ts',import.meta.url).href)+");try{await machine({root:"+JSON.stringify(scratch)+",workspaceRoot:"+JSON.stringify(scratch)+",command:'descriptor-refusal-control',deadlineAt:Date.now()+1500},()=>{throw Error('UNEXPECTED_CALLBACK');});process.exitCode=2;}catch(error){if(error.message.includes('VALIDATION_DELEGATION_REFUSED'))console.log('DESCRIPTOR_REFUSED '+error.message);else if(error.message.includes('capacity wait deadline exceeded'))console.log('DESCRIPTOR_DROPPED_DEGRADED '+error.message);else throw error;}")});
const bytes=Buffer.alloc(Number(fstatSync(4).size));readSync(4,bytes,0,bytes.length,0);
const fakePath=root+'/copied-bootstrap';writeFileSync(fakePath,bytes,{mode:0o600});const fake=openSync(fakePath,'r');unlinkSync(fakePath);
const junkPath=root+'/junk-bootstrap';writeFileSync(junkPath,'not a bootstrap envelope',{mode:0o600});const junk=openSync(junkPath,'r');unlinkSync(junkPath);
// A dropped descriptor (every plain Node wrapper on Darwin) degrades to the ordinary
// queue, which the live outer reservation still blocks, and is diagnosed once; a copied
// bootstrap at the reserved slot is refused outright, and an unlinked non-JSON descriptor there
// is refused as a typed envelope failure, never a raw parse error.
try {for(const [name,slot,expected] of [['dropped','ignore',/DESCRIPTOR_DROPPED_DEGRADED/],['copied-key',fake,/DESCRIPTOR_REFUSED/],['non-json',junk,/DESCRIPTOR_REFUSED .*bootstrap is not a bounded JSON envelope/]]){const child=spawnSync(process.execPath,[probe],{env:{...process.env,PROOF_OR_STOP_DELEGATION_DIAGNOSTICS:'1'},stdio:['ignore','pipe','pipe','ignore',slot],encoding:'utf8',timeout:5000});assert.equal(child.status,0,name+': '+child.stdout+child.stderr);assert.match(child.stdout,expected,name);if(name==='dropped')assert.match(child.stderr,/VALIDATION_DELEGATION_UNAVAILABLE/,'dropped descriptor must be diagnosed');else assert.doesNotMatch(child.stderr,/VALIDATION_DELEGATION_UNAVAILABLE/,'copied key is a refusal, not a dropped transport');}}
finally{closeSync(fake);closeSync(junk);}
console.log('NESTED_DESCRIPTOR_DROP_DEGRADED_AND_COPIED_KEY_REFUSED');
}
if(group==='lifetime'){
${nestedReservationLifecycleProgram({loader,delegation:new URL('../packages/main/src/core/validation-reservation-delegation.ts',import.meta.url).href,lock:new URL('../packages/main/src/core/validation-execution-lock.ts',import.meta.url).href})}
}
`);
  for(const [group,selector] of [['leaf','NESTED_NATIVE_EXECUTOR_RESULT'],['lineage','NESTED_LINEAGE_REVOKED_WITH_CLAIMS_HELD PASS'],['resources','NESTED_RESOURCE_SUBSET_AND_PORT_REFUSAL PASS'],['descriptor','NESTED_DESCRIPTOR_DROP_DEGRADED_AND_COPIED_KEY_REFUSED'],['lifetime','NESTED_TRANSITIVE_EXPIRY_AND_IMMUTABLE_ENROLLMENT PASS']]) {
    const stage=performance.now();
    const result=await runSingleAllowlistedCommand('node '+JSON.stringify(entry)+' --owner-group='+group,scratch,{timeoutMs:15000});
    console.log(result.output);
    console.log('NESTED_CONTROL_STAGE '+JSON.stringify({group,seconds:(performance.now()-stage)/1000,code:result.code}));
    assert.match(result.output,new RegExp(selector),'NESTED_FIXTURE_STARTED_REQUIRED');
    assert.equal(result.code,0,'NESTED_VERIFICATION_MACHINE_OWNER_REQUIRED');
  }
  console.log('NESTED_VERIFICATION_MACHINE_OWNER PASS '+JSON.stringify({seconds:(performance.now()-started)/1000}));
}finally{if(originalNodeOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=originalNodeOptions;rmSync(scratch,{recursive:true,force:true});console.log('NESTED_VERIFICATION_DIAGNOSTIC_SECONDS '+((performance.now()-started)/1000));}
