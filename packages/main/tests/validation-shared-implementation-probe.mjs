#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=process.cwd();const implementation=process.env.LAB_IMPLEMENTATION_ROOT;if(!implementation)throw new Error('Disposable implementation required');

const {runValidationCommand}=await import(resolve(implementation,'packages/main/dist/core/validation-executor.js'));
const shared=await import(resolve(implementation,'packages/main/dist/core/shared-validation-execution.js'));
const {StoryStore}=await import(resolve(implementation,'packages/main/dist/core/store.js'));
const {acquireOwnerLease}=await import(resolve(implementation,'packages/main/dist/core/story-owner-lease.js'));
const {probeValidationCausalPreflightFacts}=await import(resolve(implementation,'packages/main/dist/handlers/verifier.js'));
const root=mkdtempSync(join(tmpdir(),'pos-reuse-proof-'));
const originalCwd=process.cwd();
const git=argv=>execFileSync('git',argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const evidence=[];
const check=(name,actual)=>{evidence.push({name,...actual});console.log('PROOF '+JSON.stringify({name,...actual}));};
try{
 git(['init','-q','-b','main']);git(['config','user.name','Reuse proof']);git(['config','user.email','proof@example.invalid']);
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/\n');
 mkdirSync(join(root,'packages/main'),{recursive:true});writeFileSync(join(root,'packages/main/package.json'),readFileSync(join(repo,'packages/main/package.json')));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'proof-fixture',version:'1.0.0'}));
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'witness.mjs'),"import {randomUUID} from 'node:crypto';await new Promise(r=>setTimeout(r,150));console.log('WITNESS '+randomUUID());\n");
 git(['add','.']);git(['commit','-qm','fixed witness inputs']);git(['status','--porcelain']);
 process.chdir(root);
 const store=new StoryStore(root),storyId='B-reuse-proof';
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 const ctx={root,store,scanRoot:root};
 const context={storyId,receiptStore:store,probe:input=>probeValidationCausalPreflightFacts(ctx,storyId,input)};
 const spec={label:'validate',command:process.execPath,args:['witness.mjs'],executionReuse:'exact-inputs',executionInputs:[]};
 const run=(extra={},options={})=>runValidationCommand({...spec,...extra},root,10000,{sharedExecution:context,...options});

 const extra={executionInputs:['witness.mjs']};const first=await run(extra),warm=await run(extra);assert.equal(warm.executionReceipt.disposition,'reused');
 const implementationFile=join(implementation,'packages/main/dist/core/mkdir-lock.js');
 writeFileSync(implementationFile,readFileSync(implementationFile,'utf8')+'\n// controlled same-version implementation byte change\n');
 const changed=await run(extra);assert.equal(changed.executionReceipt.disposition,'executed');assert.notEqual(changed.executionReceipt.executionKey,first.executionReceipt.executionKey);assert.notEqual(changed.output,first.output);
 let injected=false;const timer=setTimeout(()=>{writeFileSync(implementationFile,readFileSync(implementationFile,'utf8')+'\n// in-flight implementation byte change\n');injected=true;},150);
 try{await assert.rejects(run({...extra,args:['-e',"setTimeout(()=>console.log('LONG_PASS'),700)"]}),/inputs changed|preflight|publication/);}finally{clearTimeout(timer);}
 assert.equal(injected,true);console.log('IMPLEMENTATION_BINDING_PRESERVED_GREEN '+JSON.stringify({first:first.executionReceipt,changed:changed.executionReceipt,inFlightRefused:true}));
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
