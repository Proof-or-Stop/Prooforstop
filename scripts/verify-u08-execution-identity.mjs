import assert from 'node:assert/strict';import{existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,chmodSync,rmSync,symlinkSync}from'node:fs';import{join,resolve}from'node:path';import{tmpdir}from'node:os';import{pathToFileURL}from'node:url';
const repo=resolve(process.argv[2]||process.cwd()),url=p=>pathToFileURL(join(repo,'packages/main/dist/core',p+'.js')).href;
assert.ok(existsSync(join(repo,'packages/main/dist/core/managed-execution-input-identity.js')),'U08_KEYED_EXECUTION_IDENTITY_REQUIRED');
const {captureManagedProviderState,materializeManagedProviderState}=await import(url('managed-review-provider-state'));
const {loadManagedExecutionIdentityKey}=await import(url('managed-execution-identity-key'));
const {identifyManagedExecutionInputs}=await import(url('managed-execution-input-identity'));
const root=mkdtempSync(join(tmpdir(),'u08-input-id-'));
try{
 const source=join(root,'source'),keys=join(root,'keys');mkdirSync(source);mkdirSync(keys,{mode:0o700});const auth=join(source,'auth.json');writeFileSync(auth,JSON.stringify({OPENAI_API_KEY:'fixture-secret-A'}));
 const binary=join(root,'binary');copyFileSync('/bin/echo',binary);chmodSync(binary,0o700);
 const key=loadManagedExecutionIdentityKey(keys),state=captureManagedProviderState('codex',{CODEX_HOME:source});
 const args={key,host:'codex',providerState:state,executablePath:binary,cwd:root,environment:{PATH:'/usr/bin',SECRET:'fixture-env-secret'},reviewProfile:'managed_reviewer',reviewArgv:['exec','--json','-']};
 const id=x=>identifyManagedExecutionInputs({...args,...x}).digest;const first=id({});assert.equal(id({}),first);assert.equal(id({key:loadManagedExecutionIdentityKey(keys)}),first);
 assert.notEqual(id({environment:{...args.environment,OPTION:''}}),first);assert.notEqual(id({environment:{...args.environment,SECRET:'changed'}}),first);
 writeFileSync(auth,JSON.stringify({OPENAI_API_KEY:'fixture-secret-B'}));const changed=captureManagedProviderState('codex',{CODEX_HOME:source});assert.notEqual(id({providerState:changed}),first);assert.equal(id({}),first);
 const lane=join(root,'lane');mkdirSync(lane);const material=materializeManagedProviderState(lane,state);assert.ok(readFileSync(join(material.directory,'auth.json'),'utf8').includes('fixture-secret-A'));
 chmodSync(binary,0o500);assert.notEqual(id({}),first);chmodSync(binary,0o700);assert.equal(id({}),first);
 const original=readFileSync(binary);writeFileSync(binary,Buffer.concat([original,Buffer.from('changed')]));assert.notEqual(id({}),first);writeFileSync(binary,original);
 const alias=join(root,'alias');symlinkSync(binary,alias);const aliasFirst=id({executablePath:alias});const binary2=join(root,'binary2');copyFileSync(binary,binary2);chmodSync(binary2,0o700);rmSync(alias);symlinkSync(binary2,alias);assert.notEqual(id({executablePath:alias}),aliasFirst);
 assert.notEqual(id({reviewProfile:'cross_host_review_codex'}),first);assert.notEqual(id({reviewArgv:['exec','changed']}),first);
 const serialized=JSON.stringify({key,state,identity:identifyManagedExecutionInputs(args)});assert.equal(serialized.includes('fixture-'),false);assert.equal(serialized.includes(readFileSync(join(keys,'execution-identity.key')).toString('hex')),false);
 assert.throws(()=>id({key:JSON.parse(JSON.stringify(key))}),/key capability/);assert.throws(()=>id({providerState:JSON.parse(JSON.stringify(state))}),/snapshot capability/);
 console.log('PASS U08 keyed execution identity stable/auth/env/executable/mode/realpath/profile and opaque serialization');
}finally{rmSync(root,{recursive:true,force:true});}

await import('./verify-u08-execution-identity-io.mjs');
